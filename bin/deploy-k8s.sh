#!/usr/bin/env bash
# Deploy an application into a local Kubernetes cluster provisioned by Floci.
#
# One script, shared by every product. Each repository supplies a `deploy.env`
# alongside its manifest and calls this; nothing product-specific lives here.
#
#   deploy/k8s/deploy.sh              # create cluster if needed, build, deploy
#   CLUSTER=mydev deploy/k8s/deploy.sh
#
# Idempotent: safe to re-run. Re-running rebuilds the image and rolls the pods.
#
# This began as two 188-line scripts differing in 42 lines, all of them values.
# Keeping them apart meant every fix to the Windows path handling, the socat bridge,
# or the kubeconfig merge had to be made twice — and the one thing that was NOT
# parameterised, the proxy container name, was identical in both, so deploying the
# second product silently removed the first product's ingress proxy.
set -euo pipefail

# ------------------------------------------------------------------ parameters
# Everything below is overridable; `deploy.env` in the calling repo sets what differs.
PRODUCT="${PRODUCT:-app}"
IMAGE_NAME="${IMAGE_NAME:-$PRODUCT-api}"
CLUSTER="${CLUSTER:-aadyon}"
NAMESPACE="${NAMESPACE:-$PRODUCT}"
WEB_PORT="${WEB_PORT:-8000}"
NODE_PORT="${NODE_PORT:-30080}"
#: Deployments to annotate and wait on, space separated. The image tag never changes,
#: so the annotation is what forces pods onto freshly pushed layers.
ROLLOUTS="${ROLLOUTS:-api}"
MANIFEST="${MANIFEST:-aadyon.yaml}"
DOCKERFILE="${DOCKERFILE:-code/api/Dockerfile}"
BUILD_CONTEXT="${BUILD_CONTEXT:-code}"
SECRET_NAME="${SECRET_NAME:-aadyon-secrets}"
CONFIGMAP_NAME="${CONFIGMAP_NAME:-aadyon-env}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
READY_HINT="${READY_HINT:-}"

FLOCI_ENDPOINT="${FLOCI_ENDPOINT:-http://localhost:4566}"
REGISTRY_HOST="${REGISTRY_HOST:-localhost:5100}"
# The registry name k3s resolves through Floci's injected mirror (see registries.yaml
# inside the k3s container). Pushing to REGISTRY_HOST lands in the same store.
IMAGE_REPO="${IMAGE_REPO:-000000000000.dkr.ecr.us-east-1.localhost:5100/$IMAGE_NAME}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE="$IMAGE_REPO:$IMAGE_TAG"

# Derived from the namespace, never a fixed string. Both products previously hardcoded
# "aadyon-web" and each removed it by name before creating its own, so deploying one
# tore down the other's ingress — while both scripts' comments claimed they ran side
# by side. Everything else had been separated; this had not.
PROXY_NAME="${PROXY_NAME:-$NAMESPACE-web}"

# REPO_ROOT is the calling repository, passed by the shim. Falling back to this
# script's own location would build floci-lab instead of the product.
REPO_ROOT="${REPO_ROOT:?REPO_ROOT must be set by the calling deploy.sh shim}"
MANIFEST_DIR="${MANIFEST_DIR:-$REPO_ROOT/deploy/k8s}"

step() { printf '\n\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# Docker on Windows/Git-Bash mangles container paths; disable that for exec/cp.
export MSYS_NO_PATHCONV=1

# kubectl is a native binary on Windows even under Git-Bash, so KUBECONFIG needs
# Windows-style paths joined by ';' rather than POSIX paths joined by ':'.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) KPATH_SEP=';'; to_native() { cygpath -w "$1"; } ;;
  *)                    KPATH_SEP=':'; to_native() { printf '%s' "$1"; } ;;
esac

# --------------------------------------------------------------- prerequisites
step "Deploying $PRODUCT — checking prerequisites"
for bin in docker kubectl aws; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is required but not on PATH"
done
docker info >/dev/null 2>&1 || die "Docker is not running"
curl -sf "$FLOCI_ENDPOINT" >/dev/null 2>&1 \
  || die "Floci is not reachable at $FLOCI_ENDPOINT — start it first (see floci-lab README)"
[ -f "$MANIFEST_DIR/$MANIFEST" ] || die "manifest not found: $MANIFEST_DIR/$MANIFEST"
echo "ok: docker, kubectl, aws, floci"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# ------------------------------------------------------------------- cluster
step "Ensuring EKS cluster '$CLUSTER' exists"
if aws --endpoint-url "$FLOCI_ENDPOINT" eks describe-cluster --name "$CLUSTER" >/dev/null 2>&1; then
  echo "cluster already exists"
else
  aws --endpoint-url "$FLOCI_ENDPOINT" eks create-cluster \
    --name "$CLUSTER" \
    --role-arn arn:aws:iam::000000000000:role/eks \
    --resources-vpc-config subnetIds=subnet-default-c >/dev/null
  echo "created — waiting for ACTIVE..."
fi
for _ in $(seq 1 40); do
  status="$(aws --endpoint-url "$FLOCI_ENDPOINT" eks describe-cluster --name "$CLUSTER" \
            --query 'cluster.status' --output text 2>/dev/null || echo PENDING)"
  [ "$status" = "ACTIVE" ] && break
  sleep 3
done
[ "${status:-}" = "ACTIVE" ] || die "cluster did not become ACTIVE (last status: ${status:-unknown})"
echo "cluster ACTIVE"

K3S_CONTAINER="floci-eks-$CLUSTER"
docker inspect "$K3S_CONTAINER" >/dev/null 2>&1 \
  || die "expected k3s container '$K3S_CONTAINER' not found"

# Floci reporting the cluster ACTIVE means its own record says so; it does not mean
# the k3s container is up and serving. When a cluster of the same name existed before,
# Floci removes and recreates the container, and for a few seconds `docker port` still
# answers with the *previous* container's published port. Reading it then yields a port
# nothing is listening on, and the failure surfaces as "connection refused" against a
# plausible-looking address — which reads as a Floci problem rather than a race.
step "Waiting for the k3s container to be running"
for _ in $(seq 1 40); do
  state="$(docker inspect -f '{{.State.Running}}' "$K3S_CONTAINER" 2>/dev/null || echo false)"
  started="$(docker inspect -f '{{.State.StartedAt}}' "$K3S_CONTAINER" 2>/dev/null || echo '')"
  [ "$state" = "true" ] && [ -n "$started" ] && break
  sleep 2
done
[ "${state:-}" = "true" ] || die "k3s container '$K3S_CONTAINER' is not running"

# ---------------------------------------------------------------- kubeconfig
step "Writing kubeconfig (context: floci-$CLUSTER)"
# Re-read the port only now that the container is running, and confirm something is
# actually accepting connections on it before trusting it.
API_PORT=""
for _ in $(seq 1 30); do
  API_PORT="$(docker port "$K3S_CONTAINER" 6443/tcp 2>/dev/null | head -1 | sed 's/.*://')"
  if [ -n "$API_PORT" ] && curl -sk --max-time 3 "https://127.0.0.1:$API_PORT/version" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
[ -n "$API_PORT" ] || die "could not determine the k3s API port"
echo "k3s API on 127.0.0.1:$API_PORT"
KUBE_DIR="${HOME}/.kube"; mkdir -p "$KUBE_DIR"
TMP_KCFG="$(mktemp)"
docker exec "$K3S_CONTAINER" cat /etc/rancher/k3s/k3s.yaml \
  | tr -d '\r' \
  | sed "s#https://127.0.0.1:6443#https://127.0.0.1:${API_PORT}#" \
  | sed "s/\bdefault\b/floci-$CLUSTER/g" > "$TMP_KCFG"
if [ -f "$KUBE_DIR/config" ]; then
  cp "$KUBE_DIR/config" "$KUBE_DIR/config.bak.$(date +%Y%m%d%H%M%S)"
  # The freshly generated config must come FIRST. `kubectl config view --flatten`
  # resolves conflicts in favour of the earliest file in KUBECONFIG, so listing the
  # existing config first makes a stale entry win over the new one — and since the
  # context name is derived from the cluster name, a re-deploy always conflicts.
  #
  # The symptom is nasty: Floci publishes the k3s API on a different host port each
  # time it recreates a cluster, so after a re-deploy the context keeps pointing at
  # the *previous* port. Everything reports success up to the first kubectl call,
  # which then fails with "connection refused" against an address that looks right,
  # and no amount of re-running fixes it because the stale entry keeps winning.
  KUBECONFIG="$(to_native "$TMP_KCFG")$KPATH_SEP$(to_native "$KUBE_DIR/config")" \
    kubectl config view --flatten > "$KUBE_DIR/config.new"
  mv "$KUBE_DIR/config.new" "$KUBE_DIR/config"
else
  cp "$TMP_KCFG" "$KUBE_DIR/config"
fi
rm -f "$TMP_KCFG"
kubectl config use-context "floci-$CLUSTER" >/dev/null
kubectl config set-context "floci-$CLUSTER" --namespace="$NAMESPACE" >/dev/null
# Retry rather than failing on the first attempt: the API server accepts TCP before it
# finishes serving the API group list, so a single call here fails against a cluster
# that is merely a couple of seconds from ready.
for _ in $(seq 1 30); do
  kubectl get nodes >/dev/null 2>&1 && reachable=yes && break
  sleep 2
done
[ "${reachable:-}" = "yes" ] || die "cannot reach the cluster with the generated kubeconfig"
echo "kubeconfig merged into $KUBE_DIR/config (previous config backed up)"

# ------------------------------------------------------------- build + push
step "Building and pushing $IMAGE_NAME"
# host paths must be native for docker (MSYS_NO_PATHCONV above protects container paths)
docker build -q -t "$IMAGE_NAME:latest" \
  -f "$(to_native "$REPO_ROOT/$DOCKERFILE")" \
  "$(to_native "$REPO_ROOT/$BUILD_CONTEXT")" >/dev/null
docker tag "$IMAGE_NAME:latest" "$REGISTRY_HOST/$IMAGE_NAME:$IMAGE_TAG"
aws --endpoint-url "$FLOCI_ENDPOINT" ecr create-repository \
  --repository-name "$IMAGE_NAME" >/dev/null 2>&1 || true
docker push -q "$REGISTRY_HOST/$IMAGE_NAME:$IMAGE_TAG" >/dev/null
echo "pushed $REGISTRY_HOST/$IMAGE_NAME:$IMAGE_TAG"

# ------------------------------------------------ namespace, secrets, config
step "Applying namespace, secrets and configuration"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# Secrets are generated once and then left alone — re-running must not rotate the
# DB password out from under an existing volume, or invalidate everyone's sessions.
if kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
  echo "secrets already present — leaving them untouched"
else
  gen() { python -c "import secrets;print(secrets.token_urlsafe($1))"; }
  kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
    --from-literal=db_password="$(gen 18)" \
    --from-literal=jwt_secret="$(gen 48)" \
    --from-literal=s3_access_key="${S3_ACCESS_KEY:-test}" \
    --from-literal=s3_secret_key="${S3_SECRET_KEY:-test}" >/dev/null
  echo "generated $SECRET_NAME"
fi

# Pods cannot resolve Docker container names (k3s runs its own DNS), so the S3
# emulator is addressed by its IP on the shared Docker network. Discover it rather
# than hardcoding: it changes per machine and per `docker compose up`.
FLOCI_CONTAINER="$(docker ps --filter ancestor=floci/floci --format '{{.Names}}' | head -1)"
[ -n "$FLOCI_CONTAINER" ] \
  || FLOCI_CONTAINER="$(docker ps --format '{{.Names}}\t{{.Image}}' | grep -i 'floci/floci' | head -1 | cut -f1)"
[ -n "$FLOCI_CONTAINER" ] || die "could not find the running Floci container"
FLOCI_IP="$(docker inspect "$FLOCI_CONTAINER" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | awk '{print $1}')"
[ -n "$FLOCI_IP" ] || die "could not determine the Floci container IP"
S3_URL="${S3_ENDPOINT_URL:-http://$FLOCI_IP:4566}"
kubectl -n "$NAMESPACE" create configmap "$CONFIGMAP_NAME" \
  --from-literal=S3_ENDPOINT_URL="$S3_URL" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "S3 endpoint for pods: $S3_URL  (from container $FLOCI_CONTAINER)"

# -------------------------------------------------------------- manifests
step "Applying workloads"
# The migrate Job's spec is immutable; replace it so re-runs pick up changes.
kubectl -n "$NAMESPACE" delete job migrate --ignore-not-found >/dev/null
sed "s#__IMAGE__#$IMAGE#g" "$MANIFEST_DIR/$MANIFEST" | kubectl apply -f - >/dev/null
# Same tag every time, so force pods onto the freshly pushed layers.
STAMP="$(date +%s)"
for deploy in $ROLLOUTS; do
  kubectl -n "$NAMESPACE" patch deploy "$deploy" \
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"deployedAt\":\"$STAMP\"}}}}}" >/dev/null
done
for deploy in $ROLLOUTS; do
  kubectl -n "$NAMESPACE" rollout status "deploy/$deploy" --timeout=180s
done

# ------------------------------------------------------------------- ingress
step "Exposing $PRODUCT on http://localhost:$WEB_PORT"
# Floci publishes only the cluster's API port, so the NodePort is not reachable from
# the host. A tiny socat container bridges the two; it restarts with Docker, unlike
# `kubectl port-forward`, which dies with its shell.
docker rm -f "$PROXY_NAME" >/dev/null 2>&1 || true
NETWORK="$(docker inspect "$K3S_CONTAINER" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $NF}')"
docker run -d --name "$PROXY_NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  -p "$WEB_PORT:$WEB_PORT" \
  alpine/socat "tcp-listen:$WEB_PORT,fork,reuseaddr" \
  "tcp-connect:$K3S_CONTAINER:$NODE_PORT" >/dev/null
sleep 3

# -------------------------------------------------------------------- verify
step "Verifying"
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$WEB_PORT$HEALTH_PATH" || true)"
  [ "$code" = "200" ] && break
  sleep 3
done
[ "${code:-}" = "200" ] || die "$PRODUCT did not become reachable on http://localhost:$WEB_PORT (last status: ${code:-none})"

kubectl -n "$NAMESPACE" get pods
printf '\n\033[32mReady:\033[0m http://localhost:%s' "$WEB_PORT"
[ -n "$READY_HINT" ] && printf '  — %s' "$READY_HINT"
printf '\n'
printf 'kubectl is set to context floci-%s (namespace %s). Ingress proxy: %s\n' \
  "$CLUSTER" "$NAMESPACE" "$PROXY_NAME"
