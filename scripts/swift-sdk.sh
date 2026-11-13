# Sourced by the Swift build/test scripts. With only the Command Line Tools installed, newer SDKs
# (macOS 27+) declare SwiftUI's @State as a macro whose plugin (SwiftUIMacros) ships only with
# Xcode, so the app cannot compile against them. The app targets macOS 26, so use the newest
# macOS 26 SDK in that case. Full Xcode (or SETU_SWIFT_SDK) overrides this.
SWIFT_SDK_ARGS=()
if [ -n "${SETU_SWIFT_SDK:-}" ]; then
  SWIFT_SDK_ARGS=(--sdk "$SETU_SWIFT_SDK"); export SDKROOT="$SETU_SWIFT_SDK"
elif [ "$(xcode-select -p 2>/dev/null)" = "/Library/Developer/CommandLineTools" ]; then
  _sdk="$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX26*.sdk 2>/dev/null | sort -V | tail -1)"
  if [ -n "$_sdk" ]; then
    SWIFT_SDK_ARGS=(--sdk "$_sdk"); export SDKROOT="$_sdk"
  fi
  unset _sdk
fi
