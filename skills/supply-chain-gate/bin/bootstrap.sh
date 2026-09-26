#!/bin/sh
# bootstrap.sh — make sure node + npm exist in the sandbox (SPEC §10). Run as: sh bin/bootstrap.sh
# The TrueForge sandbox image (python:3.13-slim-bookworm, root) has no Node. Methods, in order:
#   1. pip install nodejs-wheel==22.*          (default; confirmed 25 Sep: Node 22.20.0, npm 10.9.3, ~13 s)
#   2. node-linux-<arch> + npm tarballs from registry.npmjs.org
#   3. apt-get install nodejs npm               (Debian bookworm: Node 18)
# Prints exactly one JSON object on stdout: {"node", "npm", "method", "node_path"}; logs go to stderr.
# Exit 0 when node and npm both work, 1 otherwise (the agent then treats the run as INCONCLUSIVE).
# POSIX sh only (Debian's sh is dash).

set -u

LINK_DIR=/usr/local/bin      # on PATH for every later `exec` call; each exec starts a fresh shell
NODE_VERSION=22.23.3         # node-linux-* tarball on npm (checked 25 Sep)
NPM_VERSION=10.9.2

log() { printf '[bootstrap] %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

emit() {
  node_v=$(node --version 2>/dev/null || true)
  npm_v=$(npm --version 2>/dev/null || true)
  node_p=$(command -v node 2>/dev/null || true)
  printf '{"node":%s,"npm":%s,"method":"%s","node_path":%s}\n' \
    "$(json_str "$node_v")" "$(json_str "$npm_v")" "$1" "$(json_str "$node_p")"
  if [ -n "$node_v" ] && [ -n "$npm_v" ]; then exit 0; fi
  exit 1
}

json_str() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }

# Later exec calls only see the default PATH, so expose the binaries where it already looks.
link_into_path() {
  for b in node npm npx; do
    p=$(command -v "$b" 2>/dev/null || true)
    [ -n "$p" ] || continue
    [ "$p" = "$LINK_DIR/$b" ] && continue
    ln -sf "$p" "$LINK_DIR/$b" 2>/dev/null || log "could not link $b into $LINK_DIR"
  done
}

if have node && have npm; then
  log "node $(node --version) and npm $(npm --version) already present"
  emit present
fi

# ---- 1. nodejs-wheel from PyPI ----------------------------------------------
PY=""
for c in python3 python; do
  if have "$c" && "$c" -m pip --version >/dev/null 2>&1; then PY=$c; break; fi
done
if [ -n "$PY" ]; then
  log "method 1: $PY -m pip install nodejs-wheel==22.*"
  if PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 \
     "$PY" -m pip install -q "nodejs-wheel==22.*" >&2 2>&1; then
    scripts=$("$PY" -c 'import sysconfig; print(sysconfig.get_path("scripts"))' 2>/dev/null || true)
    if [ -n "$scripts" ] && [ -d "$scripts" ]; then PATH="$scripts:$PATH"; export PATH; fi
    if have node && have npm; then
      link_into_path
      emit nodejs-wheel
    fi
    log "method 1: installed, but node/npm not found in $scripts"
  else
    log "method 1: pip install failed"
  fi
else
  log "method 1: no python with pip"
fi

# ---- 2. tarballs from the npm registry --------------------------------------
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) ARCH="" ;;
esac
if [ -n "$ARCH" ] && have curl && have tar; then
  log "method 2: node-linux-$ARCH@$NODE_VERSION tarball"
  mkdir -p /opt/node /opt/npm
  if curl -fsSL "https://registry.npmjs.org/node-linux-$ARCH/-/node-linux-$ARCH-$NODE_VERSION.tgz" \
     | tar -xz -C /opt/node --strip-components=1 2>/dev/null && [ -x /opt/node/bin/node ]; then
    PATH="/opt/node/bin:$PATH"; export PATH
    # This package ships only the node binary; npm comes from its own tarball (confirmed 25 Sep).
    if ! have npm; then
      log "method 2: npm@$NPM_VERSION tarball"
      if curl -fsSL "https://registry.npmjs.org/npm/-/npm-$NPM_VERSION.tgz" \
         | tar -xz -C /opt/npm --strip-components=1 2>/dev/null && [ -f /opt/npm/bin/npm-cli.js ]; then
        printf '#!/bin/sh\nexec /opt/node/bin/node /opt/npm/bin/npm-cli.js "$@"\n' > /opt/node/bin/npm
        printf '#!/bin/sh\nexec /opt/node/bin/node /opt/npm/bin/npx-cli.js "$@"\n' > /opt/node/bin/npx
        chmod 755 /opt/node/bin/npm /opt/node/bin/npx
      fi
    fi
    if have node && have npm; then
      link_into_path
      emit node-tarball
    fi
    log "method 2: incomplete"
  else
    log "method 2: download or extract failed"
  fi
elif [ -z "$ARCH" ]; then
  log "method 2: unsupported arch '$(uname -m)'"
else
  log "method 2: curl or tar not available"
fi

# ---- 3. Debian packages (Node 18) -------------------------------------------
if have apt-get; then
  log "method 3: apt-get install nodejs npm"
  if DEBIAN_FRONTEND=noninteractive apt-get update -qq >&2 2>&1 &&
     DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm >&2 2>&1 &&
     have node && have npm; then
    emit apt
  fi
  log "method 3: failed"
else
  log "method 3: no apt-get"
fi

log "no method produced node + npm"
emit none
