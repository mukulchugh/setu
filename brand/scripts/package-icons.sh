#!/bin/sh
set -eu

brand_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
master="$brand_dir/icon/setu-icon-1024.png"
iconset="$brand_dir/icon/Setu.iconset"

test -f "$master"
mkdir -p "$iconset"
for points in 16 32 128 256 512; do
  sips -s format png -z "$points" "$points" "$master" \
    --out "$iconset/icon_${points}x${points}.png" >/dev/null
  pixels=$((points * 2))
  sips -s format png -z "$pixels" "$pixels" "$master" \
    --out "$iconset/icon_${points}x${points}@2x.png" >/dev/null
done

printf 'Packaged 10 PNG sizes in icon/Setu.iconset\n'
