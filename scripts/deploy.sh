#!/usr/bin/env bash
# Build and deploy Splitdummy.
#   scripts/deploy.sh staging|production [--init-secrets]
# --init-secrets: first deploy of an environment. Reads the Turnstile widget secret via the
# `cf` CLI into a private temp file, uploads it with the version, and deletes the file.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_NAME="${1:-}"
SITEKEY="0x4AAAAAAFNyE7Ukj_gERhnU"
case "$ENV_NAME" in
  staging) export CLOUDFLARE_ENV=staging ;;
  production) unset CLOUDFLARE_ENV ;;
  *) echo "usage: $0 staging|production [--init-secrets]" >&2; exit 1 ;;
esac

npm run cf-typegen >/dev/null
npx tsc -b
npx vite build
# The Vite plugin copies local .dev.vars into the build output for `vite preview`; never ship it.
rm -f dist/*/.dev.vars

args=()
if [[ "${2:-}" == "--init-secrets" ]]; then
  umask 077
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  cf turnstile widgets get "$SITEKEY" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.result??j;process.stdout.write("TURNSTILE_SECRET="+r.secret+"\n")})' >"$tmp"
  args+=(--secrets-file "$tmp")
fi

npx wrangler d1 migrations apply DB --remote ${CLOUDFLARE_ENV:+--env "$CLOUDFLARE_ENV"}
npx wrangler deploy ${args[@]+"${args[@]}"}
