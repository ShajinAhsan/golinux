#!/usr/bin/env bash
# Export GoLinux's pinned VM runtime shell into a sibling Academy repository.
#
# Usage:
#   ./tools/academy/export-shell.sh [target-repo-dir]
#   (default target: ../golinux-academy)
#
# Copies ONLY the read-only Alpine VM runtime, snapshot, manifests, and core
# JS modules so academy.golinux.app inherits GoLinux's central base OS with
# zero image duplication. Writes UPSTREAM.md with pinned commit + buildId.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
TARGET="${1:-$(cd "$ROOT/.." && pwd)/golinux-academy}"
OUT="$TARGET/src"

if [ ! -f "$ROOT/images/build-id.json" ]; then
  echo "ERROR: $ROOT/images/build-id.json is missing." >&2
  exit 1
fi

BUILD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).buildId || "")' "$ROOT/images/build-id.json")"
CHUNK_COUNT="$(node -e 'process.stdout.write(String(require(process.argv[1]).chunkCount || 0))' "$ROOT/images/build-id.json")"
COMMIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
FULL_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

if [ -z "$BUILD_ID" ]; then
  echo "ERROR: buildId in images/build-id.json is empty." >&2
  exit 1
fi

mkdir -p \
  "$OUT/assets/v86" \
  "$OUT/assets/xterm" \
  "$OUT/assets/bios" \
  "$OUT/icons" \
  "$OUT/images" \
  "$OUT/js"

# Core VM runtime & terminal assets
cp "$ROOT/assets/v86/libv86.js" "$OUT/assets/v86/"
cp "$ROOT/assets/v86/v86.wasm" "$OUT/assets/v86/"
cp "$ROOT/assets/xterm/xterm.js" "$OUT/assets/xterm/"
cp "$ROOT/assets/xterm/xterm.css" "$OUT/assets/xterm/"
cp "$ROOT/assets/bios/seabios.bin" "$OUT/assets/bios/"
cp "$ROOT/assets/bios/vgabios.bin" "$OUT/assets/bios/"
cp "$ROOT/assets/empty-chunk.zst" "$OUT/assets/"

# Icons & base styles
cp "$ROOT/icons/favicon.svg" "$ROOT/icons/icon-192.png" "$ROOT/icons/icon-512.png" "$OUT/icons/"
[ -f "$ROOT/favicon.ico" ] && cp "$ROOT/favicon.ico" "$OUT/"
cp "$ROOT/styles.css" "$OUT/"

# Snapshot + chunk/bundle manifests (chunks & packs stream from assets.golinux.app)
cp "$ROOT/images/debian-state.bin.zst" "$OUT/images/"
cp "$ROOT/images/build-id.json" "$OUT/images/"
cp "$ROOT/bundles.json" "$OUT/"
cp "$ROOT/chunks-precache.json" "$OUT/"

# Vendored persistence, SW, and VM boot modules
cp "$ROOT/persist.js" "$ROOT/persist-9p.js" "$ROOT/sw.js" "$OUT/"
for mod in boot.js terminal.js keybar.js status.js chunk-fallback.js persist-ui.js net-adapter.js net-ui.js; do
  cp "$ROOT/js/$mod" "$OUT/js/"
done

# Stamp SW cache-busting token with pinned upstream buildId
node -e '
const fs = require("fs");
const [swPath, buildId] = process.argv.slice(1);
let s = fs.readFileSync(swPath, "utf8");
s = s.replace(/const GL_SW_STAMP = "[^"]*";/, `const GL_SW_STAMP = "academy-${buildId}";`);
fs.writeFileSync(swPath, s);
' "$OUT/sw.js" "$BUILD_ID"

# If target already has an Academy packs-config.js, stamp GL_BUILD_ID into it
if [ -f "$OUT/packs-config.js" ]; then
  node -e '
const fs = require("fs");
const [cfgPath, buildId] = process.argv.slice(1);
let s = fs.readFileSync(cfgPath, "utf8");
s = s.replace(/const GL_BUILD_ID = "[^"]*";/, `const GL_BUILD_ID = "${buildId}";`);
fs.writeFileSync(cfgPath, s);
' "$OUT/packs-config.js" "$BUILD_ID"
fi

cat > "$TARGET/UPSTREAM.md" <<EOF
# Upstream GoLinux Runtime Pin

This repository inherits GoLinux's central Alpine Linux 3.21 VM runtime.
Re-run \`../GoLinux/tools/academy/export-shell.sh\` to update these vendored files.

| Field | Value |
| :--- | :--- |
| Upstream Commit | \`$COMMIT_SHA\` (\`$FULL_SHA\`) |
| Image Build ID | \`$BUILD_ID\` |
| Real Disk Chunks | \`$CHUNK_COUNT\` |
| Exported At (UTC) | \`$(date -u +"%Y-%m-%dT%H:%M:%SZ")\` |
EOF

echo "Exported GoLinux shell ($COMMIT_SHA / build $BUILD_ID) -> $OUT"
