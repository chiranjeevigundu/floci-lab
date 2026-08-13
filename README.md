# floci-lab

My local cloud: an AWS API emulator, a Kubernetes cluster, a container registry, and
self-hosted tracing — plus the one deploy script every product uses.

```bash
git clone https://github.com/chiranjeevigundu/floci-lab
./floci-lab/bin/up.sh          # Floci on :4566
./floci-lab/bin/up.sh all      # + LangFuse on :3010
```

Then, from any product repository checked out beside this one:

```bash
./deploy/k8s/deploy.sh
```

---

## What this is, and what it is not

**[Floci](https://floci.io) is third-party.** It is a Quarkus AWS-API emulator, in the
LocalStack mould, and none of it is mine. This repository is the configuration for
running it and the tooling built on top — nothing here reimplements a cloud.

Where it goes beyond emulation is worth knowing: for EKS it does not fake the
Kubernetes API, it starts a real `rancher/k3s` container and an ECR registry mirror
beside it. That is why the compose file mounts the Docker socket, and why the deploy
script talks to `kubectl` rather than to a stub.

## The deploy script

`bin/deploy-k8s.sh` deploys any of the products into the local cluster: creates the
EKS cluster if absent, merges a kubeconfig, builds and pushes the image to the mirrored
ECR registry, applies the manifest, rolls the pods, and bridges the NodePort to a host
port with a socat container.

It began as **two 188-line scripts with a 42-line diff**, one per product. Every one of
those 42 lines was a value. The cost of that was not the duplication itself but what it
concealed: each fix to the Windows path handling, the kubeconfig merge, or the socat
bridge had to be found and applied twice.

And the one thing that was *not* different between them was a bug. Both hardcoded
`PROXY_NAME="aadyon-web"`, and both ran `docker rm -f "$PROXY_NAME"` before creating
their own — so deploying the second product silently removed the first product's
ingress proxy and made it unreachable, while `aadyon-server`'s header comment claimed
the two ran side by side with "separate namespace, separate NodePort, separate host
port." Everything had been separated except the name they collided on. The proxy name
now derives from the namespace, so it cannot.

Each product keeps three things in `deploy/k8s/`:

| File | Size | Contents |
|---|---|---|
| `aadyon.yaml` | unchanged | the manifest — genuinely different per product, not templated |
| `deploy.env` | ~9 lines | the six values that differ |
| `deploy.sh` | 26 lines | a shim, byte-identical across repos |

The manifests are deliberately **not** unified. They are 211 and 283 lines with a
187-line diff — that is two different applications, not duplication, and a chart
abstracting them would be fought every time a container is added.

## Three bugs the consolidation surfaced

All three were latent in both copies, and all three are fixed once here rather than
twice. Every one was found by running the script, not by reading it.

**The ingress proxy name collided.** Both scripts hardcoded `PROXY_NAME="aadyon-web"`
and both ran `docker rm -f "$PROXY_NAME"` before creating their own, so deploying the
second product removed the first product's proxy. It now derives from the namespace.

**The kubeconfig merge preferred the stale entry.** `kubectl config view --flatten`
resolves conflicts in favour of the *earliest* file in `KUBECONFIG`, and the existing
config was listed first. Since the context name derives from the cluster name, every
re-deploy conflicted — and because Floci publishes the k3s API on a different host port
each time it recreates a cluster, the context kept pointing at the previous port. The
symptom is a connection refused against an address that looks correct, which re-running
cannot fix because the stale entry keeps winning.

**The API port was read before the container was ready.** Floci reporting a cluster
`ACTIVE` means its own record says so, not that k3s is serving. When a cluster of the
same name existed, `docker port` answered with the *previous* container's mapping for a
few seconds. The script now waits for the container to be running, re-reads the port,
and confirms something answers on it.

## The compose project name is load-bearing

`compose/docker-compose.yml` pins `name: floci`. Compose otherwise derives the project
name from the directory, which names the network. Floci spawns its siblings — the k3s
cluster, the ECR registry mirror — onto its own network, so a rename strands
previously-created containers on a different one. They still share the default `bridge`,
which provides **no DNS resolution by container name**, so image pulls fail with
`lookup floci-ecr-registry: no such host`: a DNS error that reads as a Floci bug and is
actually a compose project rename.

If you hit it after changing directories or project names, remove the stale network and
let Floci recreate its siblings:

```bash
docker rm -f floci-ecr-registry aadyon-web aadyon-zk-web
docker network rm floci_default
./bin/up.sh
```

## Why a sibling checkout rather than a submodule

The shim looks for `../floci-lab`, overridable with `FLOCI_LAB`. Submodules were
considered and rejected: the products build with `code/` as the Docker build context,
so a repo-root submodule is not even visible to the build, and submodules break
`pip install -r` besides. A sibling clone is one command and has no failure modes.

## Contents

```
bin/deploy-k8s.sh    the shared deployer, parameterised by deploy.env
bin/up.sh            start Floci (and optionally LangFuse)
compose/             Floci emulator + self-hosted LangFuse
```

## LangFuse

Traces every model call made through [llmkit](https://github.com/chiranjeevigundu/llmkit),
across every app that uses it. Self-hosted rather than the cloud offering because the
prompts and completions being traced include personal finance data.

```bash
./bin/up.sh all
# create a project at http://localhost:3010, then:
export LANGFUSE_PUBLIC_KEY=pk-... LANGFUSE_SECRET_KEY=sk-... LANGFUSE_HOST=http://localhost:3010
```

Tracing stays off until both keys are set, so nothing is emitted by default.

## Consumers

- [aadyon-assist](https://github.com/chiranjeevigundu/aadyon-assist) — namespace `aadyon`, :8000
- [aadyon-server](https://github.com/chiranjeevigundu/aadyon-server) — namespace `aadyon-zk`, :8200

Both can run at once; that is the point of keeping every value distinct.

## License

MIT.
