#!/bin/bash
# Capture only the given process's own windows (by window ID). Usage: shot.sh <pid> <out-prefix>
set -euo pipefail
exec swift "$(dirname "${BASH_SOURCE[0]}")/shot.swift" "$@"
