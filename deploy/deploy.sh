#!/usr/bin/env bash
# Deploy the already-prepared rollback build to the Gun Mayhem VPS.
#
# Usage:
#   ./deploy/deploy.sh              # automatic release name
#   ./deploy/deploy.sh v18.1          # -> YYYYMMDD-v18.1
#   ./deploy/deploy.sh 20260912-v18.1 # exact release name
#
# Optional environment variables:
#   GUNMAYHEM_SSH=root@game-server.example.com  (required)
#   GUNMAYHEM_PUBLIC_HEALTH=https://game.example.com/health
#   GUNMAYHEM_NODE_DIR=/usr/bin
#   SKIP_TESTS=1
#
# This script deliberately does NOT modify Caddy.

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

SSH_TARGET="${GUNMAYHEM_SSH:?Set GUNMAYHEM_SSH to the deployment SSH target}"
REMOTE_BASE="/opt/gunmayhem"
SERVICE="gunmayhem"
NODE_DIR="${GUNMAYHEM_NODE_DIR:-/usr/bin}"
PUBLIC_HEALTH_URL="${GUNMAYHEM_PUBLIC_HEALTH:-}"
BUILD_DIR="$PROJECT_ROOT/rollback-research/build"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

for cmd in ssh scp tar node; do
  command -v "$cmd" >/dev/null 2>&1 || die "Required command not found: $cmd"
done

say "Preparing a clean runtime build"
node rollback-research/prepare.cjs

[[ -f "$BUILD_DIR/server.js" ]] || die "Missing rollback build: $BUILD_DIR/server.js"
[[ -f "$BUILD_DIR/package.json" ]] || die "Missing rollback build package.json"
[[ -f "$BUILD_DIR/public/runtime.js" ]] || die "Missing build/public/runtime.js"
[[ -f "$BUILD_DIR/public/gunmayhem-net.swf" ]] || die "Missing build/public/gunmayhem-net.swf"
[[ -f "$BUILD_DIR/ruffle/826bb0938097485a2c9d.wasm" ]] || die "Missing packaged Ruffle WASM"
[[ -f "$BUILD_DIR/ruffle/core.ruffle.f000070ea72f8ae4fe3a.js" ]] || die "Missing Safari-compatible Ruffle core"
[[ -f "$BUILD_DIR/ruffle/72a20ef1c0b8ceb37720.wasm" ]] || die "Missing Safari-compatible Ruffle WASM"

# Catch the most common mistake: editing source but forgetting to update build/.
SYNC_PAIRS=(
  "rollback-research/runtime.js|rollback-research/build/public/runtime.js"
  "rollback-research/pages-direct.js|rollback-research/build/public/pages-direct.js"
  "rollback-research/effects/audio.js|rollback-research/build/public/audio.js"
  "rollback-research/effects/webgl-compact.js|rollback-research/build/public/webgl-compact.js"
  "rollback-research/netcode/rollback-inputs.js|rollback-research/build/public/rollback-inputs.js"
)
for pair in "${SYNC_PAIRS[@]}"; do
  src="${pair%%|*}"
  dst="${pair#*|}"
  if [[ -f "$src" && -f "$dst" ]] && ! cmp -s "$src" "$dst"; then
    die "Production build is stale: $src differs from $dst. Run the project prepare/build step first."
  fi
done

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  say "Running rollback/network tests"
  node --test \
    rollback-research/netcode/server.test.cjs \
    rollback-research/netcode/rollback-inputs.test.cjs

  say "Running memory/audio/WebGL rollback tests"
  node --test \
    rollback-research/pages.test.cjs \
    rollback-research/effects/audio.test.cjs \
    rollback-research/effects/webgl-compact.test.cjs
else
  say "Skipping tests because SKIP_TESTS=1"
fi

arg="${1:-}"
if [[ -z "$arg" ]]; then
  short_sha="nogit"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    short_sha="$(git rev-parse --short HEAD)"
    if [[ -n "$(git status --porcelain)" ]]; then
      short_sha="${short_sha}-dirty"
    fi
  fi
  RELEASE_NAME="$(date +%Y%m%d-%H%M%S)-${short_sha}"
elif [[ "$arg" =~ ^v[0-9][A-Za-z0-9._-]*$ ]]; then
  RELEASE_NAME="$(date +%Y%m%d)-${arg}"
else
  RELEASE_NAME="$arg"
fi

[[ "$RELEASE_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid release name: $RELEASE_NAME"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gunmayhem-deploy.XXXXXX")"
ARCHIVE="$TMP_DIR/gunmayhem-${RELEASE_NAME}.tar.gz"
STAGE="$TMP_DIR/stage"
mkdir -p "$STAGE"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

say "Packaging rollback-research/build as $RELEASE_NAME"
# COPYFILE_DISABLE prevents macOS from creating new AppleDouble metadata entries.
# Existing Finder metadata in the project is stripped from the deployment stage too.
(
  cd "$BUILD_DIR"
  COPYFILE_DISABLE=1 tar \
    --exclude='./._*' \
    --exclude='*/._*' \
    --exclude='./.DS_Store' \
    --exclude='*/.DS_Store' \
    --exclude='*.bak' \
    -cf - .
) | (cd "$STAGE" && tar -xf -)
find "$STAGE" \( -name '._*' -o -name '.DS_Store' -o -name '*.bak' \) -delete 2>/dev/null || true

commit="unknown"
dirty="unknown"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  commit="$(git rev-parse HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then dirty="yes"; else dirty="no"; fi
fi
cat > "$STAGE/DEPLOY_INFO" <<META
release=$RELEASE_NAME
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git_commit=$commit
git_dirty=$dirty
source_host=$(hostname)
META

COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -C "$STAGE" .
archive_size="$(du -h "$ARCHIVE" | awk '{print $1}')"
printf 'Release: %s\nArchive: %s\nTarget:  %s\n' "$RELEASE_NAME" "$archive_size" "$SSH_TARGET"

REMOTE_ARCHIVE="/tmp/gunmayhem-${RELEASE_NAME}.tar.gz"
say "Uploading release to $SSH_TARGET"
scp -q "$ARCHIVE" "$SSH_TARGET:$REMOTE_ARCHIVE"

say "Activating release on VPS"
ssh -o ServerAliveInterval=15 -o ConnectTimeout=10 "$SSH_TARGET" \
  bash -s -- "$RELEASE_NAME" "$REMOTE_ARCHIVE" "$REMOTE_BASE" "$SERVICE" "$NODE_DIR" <<'REMOTE'
set -Eeuo pipefail
IFS=$'\n\t'

release_name="$1"
archive="$2"
base="$3"
service="$4"
node_dir="$5"
releases="$base/releases"
new_release="$releases/$release_name"
current_link="$base/current"

say_remote() { printf '\n==> %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo 'Remote deployment must run as root.' >&2; exit 1; }
[[ -f "$archive" ]] || { echo "Uploaded archive not found: $archive" >&2; exit 1; }
[[ -x "$node_dir/node" ]] || { echo "Node not found: $node_dir/node" >&2; exit 1; }
systemctl cat "$service" >/dev/null 2>&1 || { echo "systemd service not found: $service" >&2; exit 1; }
mkdir -p "$releases"
[[ ! -e "$new_release" ]] || { echo "Release already exists: $new_release" >&2; exit 1; }

old_release=""
if [[ -L "$current_link" || -e "$current_link" ]]; then
  old_release="$(readlink -f "$current_link" || true)"
fi

say_remote "Extracting $new_release"
mkdir "$new_release"
tar -xzf "$archive" -C "$new_release"
rm -f "$archive"

[[ -f "$new_release/server.js" ]] || { echo 'server.js missing from release' >&2; rm -rf "$new_release"; exit 1; }
[[ -f "$new_release/package.json" ]] || { echo 'package.json missing from release' >&2; rm -rf "$new_release"; exit 1; }
[[ -f "$new_release/public/gunmayhem-net.swf" ]] || { echo 'SWF missing from release' >&2; rm -rf "$new_release"; exit 1; }

say_remote "Preparing Node dependencies"
# Reuse the already-installed production dependencies when package.json is unchanged.
# This makes routine releases fast and avoids depending on npm registry availability.
if [[ -n "$old_release" && -d "$old_release/node_modules" && -f "$old_release/package.json" ]] \
   && cmp -s "$old_release/package.json" "$new_release/package.json"; then
  cp -a "$old_release/node_modules" "$new_release/node_modules"
  echo 'Reused node_modules from current release.'
else
  export PATH="$node_dir:$PATH"
  (
    cd "$new_release"
    npm install --omit=dev --no-audit --no-fund
  )
fi

[[ -d "$new_release/node_modules/ws" ]] || { echo 'ws dependency is missing after install.' >&2; rm -rf "$new_release"; exit 1; }

switched=0
rollback() {
  rc=$?
  trap - ERR
  if [[ "$switched" == 1 ]]; then
    echo >&2
    echo 'Deployment health check failed; rolling back...' >&2
    if [[ -n "$old_release" && -d "$old_release" ]]; then
      tmp_link="$base/.current-rollback-$$"
      rm -f "$tmp_link"
      ln -s "$old_release" "$tmp_link"
      mv -Tf "$tmp_link" "$current_link"
      systemctl restart "$service" || true
      echo "Restored: $old_release" >&2
    else
      systemctl stop "$service" || true
    fi
    journalctl -u "$service" -n 40 --no-pager >&2 || true
  fi
  exit "$rc"
}
trap rollback ERR

say_remote "Switching /opt/gunmayhem/current atomically"
tmp_link="$base/.current-${release_name}-$$"
rm -f "$tmp_link"
ln -s "$new_release" "$tmp_link"
mv -Tf "$tmp_link" "$current_link"
switched=1

systemctl restart "$service"

say_remote "Waiting for local health check"
healthy=0
for _ in $(seq 1 40); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3001/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 0.25
done
[[ "$healthy" == 1 ]]

# A lightweight asset check catches incomplete/torn release packages.
curl --fail --silent --max-time 5 -I http://127.0.0.1:3001/ >/dev/null
curl --fail --silent --max-time 5 -I http://127.0.0.1:3001/gunmayhem-net.swf >/dev/null

trap - ERR
switched=0
say_remote "Deployment successful"
echo "Current:  $(readlink -f "$current_link")"
if [[ -n "$old_release" ]]; then
  echo "Previous: $old_release"
fi
systemctl --no-pager --full status "$service" | sed -n '1,12p'
REMOTE

say "VPS deployment succeeded"
if [[ -n "$PUBLIC_HEALTH_URL" ]]; then
  if command -v curl >/dev/null 2>&1; then
    if curl --fail --silent --max-time 8 "$PUBLIC_HEALTH_URL" >/dev/null; then
      printf 'Public health: OK (%s)\n' "$PUBLIC_HEALTH_URL"
    else
      printf '\033[1;33mPublic health check warning: %s did not return success. Local VPS health already passed.\033[0m\n' "$PUBLIC_HEALTH_URL" >&2
    fi
  fi
fi

printf '\nDeployed release: %s\n' "$RELEASE_NAME"
printf 'Rollback if ever needed:\n  ssh %q "ln -sfn /opt/gunmayhem/releases/<old-release> /opt/gunmayhem/current && systemctl restart gunmayhem"\n' "$SSH_TARGET"
