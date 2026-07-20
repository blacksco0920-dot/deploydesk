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
binary_path="$app_path/Contents/MacOS/abcdeploy-desktop"
entitlements_path="$root_dir/scripts/macos-development-entitlements.plist"
xattr -cr "$app_path"
# Refresh the main executable before sealing the bundle. Re-signing only the
# outer app can leave macOS with a stale local policy record for the executable;
# AppleSystemPolicy then terminates an otherwise valid bundle before startup.
codesign --force --options runtime --entitlements "$entitlements_path" --sign "$identity" "$binary_path"
codesign --force --options runtime --entitlements "$entitlements_path" --sign "$identity" "$app_path"
# Clear ordinary inherited attributes after signing. macOS may keep its own
# protected provenance record, but the refreshed executable signature remains
# launchable and stable across rebuilds.
xattr -cr "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign -d -r- "$app_path" 2>&1
