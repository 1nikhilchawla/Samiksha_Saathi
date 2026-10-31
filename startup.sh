#!/bin/sh
# Bring the preview up on 0.0.0.0:8080.
#
# Idempotent and non-blocking: if the app is already answering, nothing is
# started; otherwise the dev server is launched in the background and this
# script returns straight away. The path is the script's own directory, so the
# same file works on the sandbox (/workspace) and on a checkout anywhere else.
set -e
cd "$(dirname "$0")"

port=8080
url="http://127.0.0.1:${port}/"

up() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null --max-time 1 "$url" && return 0
  fi
  node -e "fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0
  return 1
}

if up; then
  exit 0
fi

log="${TMPDIR:-/tmp}/samiksha-dev.log"
mkdir -p "$(dirname "$log")" 2>/dev/null || log="samiksha-dev.log"

# Always through the npm script: it is the only path that puts
# .grok/app-env.json (VITE_AUTH_ENABLED) into the environment.
#
# The npm shell shim is not runnable in every shell (a Windows checkout under
# Git's sh cannot exec the .cmd-free shim), so the npm CLI next to node is
# used when the shim is missing.
node_bin="$(command -v node 2>/dev/null || true)"
npm_js=""
if [ -n "$node_bin" ]; then
  node_dir="$(dirname "$node_bin")"
  for candidate in \
    "$node_dir/node_modules/npm/bin/npm-cli.js" \
    "$node_dir/../node_modules/npm/bin/npm-cli.js" \
    "$node_dir/../lib/node_modules/npm/bin/npm-cli.js"; do
    if [ -f "$candidate" ]; then
      npm_js="$candidate"
      break
    fi
  done
fi

if [ -n "$npm_js" ]; then
  node "$npm_js" run dev >"$log" 2>&1 &
else
  npm run dev >"$log" 2>&1 &
fi
exit 0
