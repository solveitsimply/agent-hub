#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
build_root="$project_root/.build/macos"
app="$build_root/Agent Hub.app"
mkdir -p "$build_root"
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" \
  "$project_root/macos/HubOrigin.swift" "$project_root/macos/OriginTests.swift" -o "$build_root/origin-tests"
"$build_root/origin-tests"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$build_root/AgentHub.iconset"
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" \
  -framework AppKit -framework WebKit \
  "$project_root/macos/HubOrigin.swift" "$project_root/macos/AgentHub.swift" -o "$app/Contents/MacOS/AgentHub"
cp "$project_root/macos/Info.plist" "$app/Contents/Info.plist"
cp "$project_root/LICENSE" "$app/Contents/Resources/LICENSE"
xcrun swift "$project_root/macos/MakeIcon.swift" "$build_root/AgentHub.iconset"
iconutil -c icns "$build_root/AgentHub.iconset" -o "$app/Contents/Resources/AgentHub.icns"
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - "$app"
codesign --verify --strict "$app"
printf 'Built: %s\n' "$app"
