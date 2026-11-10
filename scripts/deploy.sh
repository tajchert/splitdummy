#!/usr/bin/env bash
# Test, build and deploy Splitdummy.
#   scripts/deploy.sh staging|production [--init-secrets] [--skip-tests] [--allow-dirty] [--dry-run]
# Steps: preflight, typegen + typecheck, tests, clean build, migrate D1, deploy, check the live site.
# --init-secrets: first deploy of an environment. Reads the Turnstile widget secret via the
#   `cf` CLI into a private temp file, uploads it with the version, and deletes the file.
# --skip-tests:   deploy without running `npm test` (prints a warning).
# --allow-dirty:  production only; deploy although the git working tree has changes.
# --dry-run:      rehearse: no migration, `wrangler deploy --dry-run`, no live check.
set -euo pipefail
cd "$(dirname "$0")/.."

SITEKEY="0x4AAAAAAFNyE7Ukj_gERhnU"

usage() {
  echo "usage: $0 staging|production [--init-secrets] [--skip-tests] [--allow-dirty] [--dry-run]"
}

# Prints the HTTP status of GET $1 ("000" when unreachable); response headers go to file $2.
status_of() { curl -s -o /dev/null -D "$2" -m 10 -w '%{http_code}' "$1" 2>/dev/null || true; }

# The public origin comes from the Worker config the Vite plugin resolved for this environment,
# so self-hosters who edit wrangler.jsonc are covered. Prints nothing when it cannot be read.
resolve_origin() {
  local f
  for f in dist/*/wrangler.json; do
    [[ -f "$f" ]] || continue
    node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).vars?.APP_ORIGIN;if(typeof o==="string"&&o)process.stdout.write(o.replace(/\/+$/,""))' "$f" 2>/dev/null || true
    return 0
  done
}

# The new version needs a moment, so retry. 401 without a cookie proves the Worker itself answers.
check_deployment() {
  local origin="$1" n home="" api="" hdrs
  hdrs="$(mktemp)"
  for n in 1 2 3 4 5; do
    home="$(status_of "$origin/" "$hdrs")"
    api="$(status_of "$origin/api/me" /dev/null)"
    if [[ "$home" == 200 && "$api" == 401 ]]; then break; fi
    if [[ "$n" -lt 5 ]]; then sleep 5; fi
  done
  if [[ "$home" != 200 || "$api" != 401 ]]; then
    rm -f "$hdrs"
    echo "Deployed, but the check of $origin failed: GET / answered $home (want 200), GET /api/me answered $api (want 401)" >&2
    return 1
  fi
  if ! grep -qi '^x-frame-options:' "$hdrs"; then
    echo "warning: $origin/ sends no x-frame-options header" >&2
  fi
  rm -f "$hdrs"
}

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  -h|--help) usage; exit 0 ;;
  staging) export CLOUDFLARE_ENV=staging ;;
  production) unset CLOUDFLARE_ENV ;;
  *) usage >&2; exit 1 ;;
esac

init_secrets=0 skip_tests=0 allow_dirty=0 dry_run=0
shift
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --init-secrets) init_secrets=1 ;;
    --skip-tests) skip_tests=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --dry-run) dry_run=1 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done
if [[ "$dry_run" == 1 && "$init_secrets" == 1 ]]; then
  echo "--dry-run must not be combined with --init-secrets (a rehearsal never reads a secret)" >&2
  usage >&2
  exit 1
fi

# Preflight: fail before the slow steps.
commit="$(git rev-parse --short HEAD)"
note=""
if [[ "$dry_run" == 1 ]]; then note=" (dry run)"; fi
echo "Deploying $ENV_NAME from $(git rev-parse --abbrev-ref HEAD) @ $commit$note"
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$ENV_NAME" == production && "$allow_dirty" == 0 ]]; then
    echo "refusing to deploy production with uncommitted changes (commit them, or pass --allow-dirty)" >&2
    exit 1
  fi
  echo "warning: the git working tree is not clean; this deploy does not match commit $commit" >&2
fi
if [[ "$init_secrets" == 1 ]] && ! command -v cf >/dev/null 2>&1; then
  echo "--init-secrets needs the \`cf\` CLI on the PATH" >&2
  exit 1
fi

npm run cf-typegen >/dev/null
npx tsc -b
if [[ "$skip_tests" == 1 ]]; then
  echo "WARNING: --skip-tests, deploying without running the tests" >&2
else
  npm test
fi

rm -rf dist
npx vite build
# The Vite plugin copies local .dev.vars (and .dev.vars.<env>) into the build output for `vite preview`; never ship them.
find dist \( -name '.dev.vars' -o -name '.dev.vars.*' \) -type f -delete
if [[ -n "$(find dist -name '.dev.vars*')" ]]; then
  echo "a .dev.vars file is still in dist/; aborting" >&2
  exit 1
fi

args=()
if [[ "$init_secrets" == 1 ]]; then
  umask 077
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  cf turnstile widgets get "$SITEKEY" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{const j=JSON.parse(s);r=j.result??j}catch{}const v=r&&r.secret;if(typeof v!=="string"||!v){console.error("no Turnstile secret in the cf output");process.exit(1)}process.stdout.write("TURNSTILE_SECRET="+v+"\n")})' >"$tmp"
  args+=(--secrets-file "$tmp")
fi

if [[ "$dry_run" == 1 ]]; then
  echo "dry run: skipping the D1 migration"
  npx wrangler deploy --dry-run ${args[@]+"${args[@]}"}
  echo "Dry run of $ENV_NAME @ $commit finished; nothing was deployed"
  exit 0
fi

npx wrangler d1 migrations apply DB --remote ${CLOUDFLARE_ENV:+--env "$CLOUDFLARE_ENV"}
npx wrangler deploy ${args[@]+"${args[@]}"}

origin="$(resolve_origin)"
if [[ -z "$origin" ]]; then
  echo "warning: could not read APP_ORIGIN from dist/*/wrangler.json; skipping the check of the live site" >&2
  exit 0
fi
check_deployment "$origin"
echo "Deployed $ENV_NAME @ $commit to $origin"
