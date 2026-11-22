#!/usr/bin/env bash
# Stamp the current build id into packs-config.js so the app requests THIS
# build's chunk and pack paths.
#
#   ./tools/deploy/stamp-build-id.sh             # use images/build-id.json
#   ./tools/deploy/stamp-build-id.sh <build-id>  # or an explicit id (rollback)
#
# Why a separate step: packs-config.js is a static file with no build system.
# The id must come from the built artifacts, not be hand-maintained, or the app
# and the uploaded chunks drift apart. Keeping it out of the source also means
# local dev runs with GL_BUILD_ID = "" and flat paths.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
CONFIG="$ROOT/packs-config.js"
ID_FILE="$ROOT/images/build-id.json"

ID="${1:-}"
if [ -z "$ID" ]; then
  [ -f "$ID_FILE" ] || { echo "missing $ID_FILE — run tools/image/build.sh first" >&2; exit 1; }
  ID="$(node -e 'process.stdout.write(require(process.argv[1]).buildId)' "$ID_FILE")"
fi

case "$ID" in
  ""|*[!0-9a-f]*) echo "invalid build id: '$ID' (expected lowercase hex)" >&2; exit 1 ;;
esac

BEFORE="$(grep -c '^const GL_BUILD_ID = ' "$CONFIG" || true)"
[ "$BEFORE" -eq 1 ] || { echo "expected exactly one GL_BUILD_ID in $CONFIG, found $BEFORE" >&2; exit 1; }

# sed -i differs between GNU and BSD; write via a temp file instead.
python3 - "$CONFIG" "$ID" <<'PY'
import re, sys
path, build_id = sys.argv[1], sys.argv[2]
src = open(path).read()
new, n = re.subn(r'^const GL_BUILD_ID = "[^"]*";',
                 f'const GL_BUILD_ID = "{build_id}";', src, flags=re.M)
if n != 1:
    sys.exit(f"failed to stamp GL_BUILD_ID (matched {n} times)")
open(path, "w").write(new)
PY

echo "stamped GL_BUILD_ID = $ID"
grep -n '^const GL_BUILD_ID = ' "$CONFIG"

if [ -n "${1:-}" ]; then
  echo
  echo "NOTE: you stamped a build id by hand (rollback?). Remember to"
  echo "      re-run without arguments before the next normal deploy."
fi
