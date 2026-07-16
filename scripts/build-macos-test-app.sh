#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)"
fi

if [[ -z "$identity" ]]; then
  echo "未找到本机 Apple Development 签名证书，无法生成不会反复授权的 .app 测试包。" >&2
  exit 1
fi

echo "使用稳定的本机开发签名生成 ABCDeploy.app：$identity"
CI=true APPLE_SIGNING_IDENTITY="$identity" \
  pnpm --filter @abcdeploy/desktop tauri build --bundles app --ci

app_path="$root_dir/target/release/bundle/macos/ABCDeploy.app"
xattr -cr "$app_path"
codesign --force --deep --options runtime --sign "$identity" "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign -d -r- "$app_path" 2>&1
