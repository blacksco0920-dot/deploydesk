#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_VERSION="$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
VERSION="${1:-$DEFAULT_VERSION}"
ASSET_DIR="${2:-$ROOT_DIR/target/release/bundle}"
RELEASE_HOST="${RELEASE_HOST:-}"
RELEASE_USER="${RELEASE_USER:-ubuntu}"
RELEASE_SSH_KEY="${RELEASE_SSH_KEY:-}"
REMOTE_ROOT="${RELEASE_REMOTE_ROOT:-/opt/infra/releases/abcdeploy}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || {
  echo "版本号格式不正确" >&2
  exit 2
}
[[ -d "$ASSET_DIR" ]] || {
  echo "安装包目录不存在: $ASSET_DIR" >&2
  exit 2
}
[[ "$RELEASE_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || {
  echo "请通过 RELEASE_HOST 提供发布服务器地址" >&2
  exit 2
}
[[ "$RELEASE_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || {
  echo "发布服务器用户格式不正确" >&2
  exit 2
}
[[ "$REMOTE_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "远程发布目录格式不正确" >&2
  exit 2
}

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
UPLOAD_DIR="$TEMP_DIR/assets"
MANIFEST="$TEMP_DIR/latest.json"
mkdir -p "$UPLOAD_DIR"

VERSION_PATTERN="${VERSION//./\\.}"
while IFS= read -r -d '' asset; do
  name="$(basename "$asset")"
  if [[ "$name" =~ $VERSION_PATTERN([^0-9A-Za-z.-]|$) ]]; then
    cp "$asset" "$UPLOAD_DIR/$name"
  fi
done < <(find "$ASSET_DIR" -type f \( \
  -name '*.dmg' -o -name '*.exe' -o -name '*.msi' -o \
  -name '*.AppImage' -o -name '*.deb' \
\) -print0)

node "$ROOT_DIR/scripts/build-release-manifest.mjs" "$UPLOAD_DIR" "$MANIFEST" "$VERSION"
node - "$MANIFEST" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const missing = Object.entries(manifest.assets)
  .filter(([, asset]) => !asset.available)
  .map(([platform]) => platform);
if (missing.length) {
  throw new Error(`安装包不完整，缺少平台：${missing.join(", ")}`);
}
NODE
(
  cd "$UPLOAD_DIR"
  shasum -a 256 ./* > SHA256SUMS
)

SSH_ARGS=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
if [[ -n "$RELEASE_SSH_KEY" ]]; then
  SSH_ARGS+=(-i "$RELEASE_SSH_KEY")
fi
printf -v RSYNC_SSH_ARGS ' %q' "${SSH_ARGS[@]}"
DESTINATION="$RELEASE_USER@$RELEASE_HOST"
REMOTE_VERSION="v$VERSION"

ssh "${SSH_ARGS[@]}" "$DESTINATION" \
  "mkdir -p '$REMOTE_ROOT/$REMOTE_VERSION'"
rsync -av -e "ssh$RSYNC_SSH_ARGS" \
  "$UPLOAD_DIR/" "$DESTINATION:$REMOTE_ROOT/$REMOTE_VERSION/"
rsync -av -e "ssh$RSYNC_SSH_ARGS" "$MANIFEST" "$DESTINATION:$REMOTE_ROOT/latest.json"

echo "安装包已发布到 https://abcdeploy.finagent.cloud/downloads/$REMOTE_VERSION/"
