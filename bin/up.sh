#!/usr/bin/env bash
# Start the local cloud and print what is now reachable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$HERE/../compose/docker-compose.yml"

# Floci only. LangFuse is opt-in because it is two more containers and a Postgres,
# and most sessions do not need traces.
PROFILE="${1:-floci}"

case "$PROFILE" in
  floci) SERVICES="floci" ;;
  all)   SERVICES="" ;;
  *)     echo "usage: up.sh [floci|all]" >&2; exit 2 ;;
esac

# shellcheck disable=SC2086
docker compose -f "$COMPOSE" up -d --wait $SERVICES

printf '\n\033[32mLocal cloud up\033[0m\n'
printf '  Floci (AWS API)   http://localhost:4566\n'
if [ "$PROFILE" = "all" ]; then
  printf '  LangFuse          http://localhost:3010   (create a project, then export the keys)\n'
fi
printf '\nExport these for the aws CLI:\n'
printf '  export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1\n'
