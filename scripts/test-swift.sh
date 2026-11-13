#!/usr/bin/env bash
# Run Setu.app's Swift tests with only the Command Line Tools installed (no Xcode):
# swift-testing ships in CLT but is not on the default search or runtime paths.
set -euo pipefail
FW=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
LIB=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
# shellcheck source=swift-sdk.sh
. "$(dirname "$0")/swift-sdk.sh"
cd "$(dirname "$0")/../apps/setu-swift"
exec swift test ${SWIFT_SDK_ARGS[@]+"${SWIFT_SDK_ARGS[@]}"} -Xswiftc -F -Xswiftc "$FW" -Xlinker -F -Xlinker "$FW" -Xlinker -rpath -Xlinker "$FW" -Xlinker -rpath -Xlinker "$LIB" "$@"
