#!/usr/bin/env bash
# Fetch third-party runtime assets into app/vendor (not committed; not in the review ZIP).
#   @mediapipe/tasks-vision 1.0.1 (Apache-2.0 per its package.json) and the BlazePose "full" pose model
#   (Apache-2.0 per the BlazePose GHUM model card). After this, the app makes no third-party network requests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/app/vendor"; mkdir -p "$V/tasks-vision/wasm" "$V/models"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm pack @mediapipe/tasks-vision@1.0.1 --silent >/dev/null && tar xzf mediapipe-tasks-vision-1.0.1.tgz )
cp "$TMP/package/vision_bundle.mjs" "$TMP/package/package.json" "$V/tasks-vision/"
cp "$TMP/package/wasm/vision_wasm_internal.js" "$TMP/package/wasm/vision_wasm_internal.wasm" \
   "$TMP/package/wasm/vision_wasm_nosimd_internal.js" "$TMP/package/wasm/vision_wasm_nosimd_internal.wasm" "$V/tasks-vision/wasm/"
MODEL="$V/models/pose_landmarker_full.task"
if [ ! -f "$MODEL" ]; then
  if [ -f "$ROOT/feasibility/models/pose_landmarker_full.task" ]; then cp "$ROOT/feasibility/models/pose_landmarker_full.task" "$MODEL";
  else curl -fsSL -o "$MODEL" https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task; fi
fi
# Note (overnight check 2026-09-27): the pinned model bytes are served ONLY at the 'latest' URL (the versioned
# .../float16/1/ file has different bytes). If Google replaces 'latest', the hash check below fails loudly; the fix is
# to obtain the pinned file (md5 5a9ad889...) from a teammate's copy, not to accept new bytes silently.
# Verify every file against the COMMITTED expected hashes (scripts/vendor.sha256, pinned 2026-09-26 from the npm
# tarball @mediapipe/tasks-vision@1.0.1 and the float16 'latest' pose model). A mismatch aborts: the bytes are not
# the ones the tests and evidence were produced with.
( cd "$V" && shasum -a 256 -c "$ROOT/scripts/vendor.sha256" ) || { echo "VENDOR HASH MISMATCH - refusing to use these files"; exit 1; }
echo "vendor assets verified against scripts/vendor.sha256 in $V"
