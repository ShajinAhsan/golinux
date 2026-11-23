#!/usr/bin/env bash
# Build an ultra-lightweight Alpine Linux 3.21 x86 CLI image for v86.
#
# Multi-stage Docker build:
#   Stage 1: Compile TinyCC (tcc) statically for i386 musl (no gcc in final rootfs).
#   Stage 2: Build clean Alpine 3.21 x86 + BusyBox + tcc rootfs via install.sh.
#   Stage 3: Create sparse 1 GiB ext4 disk image and split into 128 KiB zstd chunks.
#
# Produces, in images/:
#   debian-bzImage      Alpine linux-virt kernel (filename kept for asset path stability)
#   debian-initrd       Alpine initramfs-virt (~7.4 MiB)
#   debian.img          raw ext4 disk (1 GiB sparse)
#   debian-chunks/      zstd chunks for v86 `use_parts` loading
set -veuo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
IMAGES="$ROOT/images"
WORK="$ROOT/.build"
TCC_OUT="$WORK/tcc-out"
CONTAINER_NAME=alpine-cli-build
DISK_SIZE="${DISK_SIZE:-1G}"

mkdir -p "$IMAGES" "$WORK"

echo "== Stage 1: Building TinyCC (tcc) for Alpine x86 musl =="
rm -rf "$TCC_OUT"
mkdir -p "$TCC_OUT"
docker run --rm --init --platform linux/386 \
  -v "$TCC_OUT:/tcc-out" \
  alpine:3.21 \
  sh -c '
    set -eu
    apk add -q --no-cache gcc musl-dev make git linux-headers
    git clone --depth 1 https://repo.or.cz/tinycc.git /tmp/tcc
    cd /tmp/tcc
    ./configure --prefix=/usr/local --config-musl
    make -j4 >/dev/null
    make install >/dev/null
    mkdir -p /tcc-out/bin /tcc-out/lib/tcc
    cp -a /usr/local/bin/tcc /tcc-out/bin/tcc
    cp -a /usr/local/lib/tcc/. /tcc-out/lib/tcc/
    /tcc-out/bin/tcc -v
  '

echo "== Stage 2: Building clean Alpine 3.21 x86 root filesystem =="
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run --name "$CONTAINER_NAME" --init --platform linux/386 \
  -v "$DIR/install.sh:/install.sh:ro" \
  -v "$TCC_OUT:/tcc-out:ro" \
  alpine:3.21 \
  sh /install.sh

echo "== Exporting root filesystem =="
docker export "$CONTAINER_NAME" > "$WORK/alpine-rootfs.tar"
docker rm "$CONTAINER_NAME"
rm -rf "$TCC_OUT"

echo "== Stage 3: Creating ext4 image ($DISK_SIZE) and populating it =="
rm -f "$IMAGES/debian.img"
docker run --rm --privileged \
  -v "$IMAGES:/images" \
  -v "$WORK:/work" \
  --platform linux/arm64 \
  alpine:3.21 \
  sh -c '
    set -eu
    apk add -q --no-cache e2fsprogs tar
    truncate -s '"$DISK_SIZE"' /images/debian.img
    mkfs.ext4 -q -F -L golinux /images/debian.img
    mkdir -p /mnt/root
    mount -o loop /images/debian.img /mnt/root
    tar -xf /work/alpine-rootfs.tar -C /mnt/root
    echo golinux > /mnt/root/etc/hostname
    printf "%s\n" "127.0.0.1 localhost" "127.0.1.1 golinux" > /mnt/root/etc/hosts
    printf "%s\n" "nameserver 10.0.2.3" > /mnt/root/etc/resolv.conf
    sync
    cp /mnt/root/boot/vmlinuz-virt /images/debian-bzImage
    cp /mnt/root/boot/initramfs-virt /images/debian-initrd
    umount /mnt/root
  '

rm -f "$WORK/alpine-rootfs.tar"

echo "== Splitting into 128 KiB zstd chunks (per-build directory) =="
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD_ID_TMP="build-$STAMP"
rm -rf "$IMAGES/debian-chunks/$BUILD_ID_TMP"
mkdir -p "$IMAGES/debian-chunks/$BUILD_ID_TMP"
python3 "$ROOT/tools/split-image.py" --zstd 128k \
  "$IMAGES/debian.img" "$IMAGES/debian-chunks/$BUILD_ID_TMP/chunk-%d-%d"

echo "== Manifest for this build's chunks =="
node "$ROOT/tools/image/build-chunk-manifest.js" --dir "$IMAGES/debian-chunks/$BUILD_ID_TMP"

echo "== Computing content build id =="
node "$ROOT/tools/image/build-id.js" --dir "$IMAGES/debian-chunks/$BUILD_ID_TMP"
BUILD_ID="$(node -e 'process.stdout.write(require("'"$ROOT"'/images/build-id.json").buildId)')"
echo "   build id: $BUILD_ID"

echo "== Naming build directory after its content hash =="
if [ -d "$IMAGES/debian-chunks/$BUILD_ID" ]; then
  echo "   $BUILD_ID already exists; reusing it"
  rm -rf "$IMAGES/debian-chunks/$BUILD_ID_TMP"
else
  mv "$IMAGES/debian-chunks/$BUILD_ID_TMP" "$IMAGES/debian-chunks/$BUILD_ID"
fi

find "$IMAGES/debian-chunks" -maxdepth 1 -name 'chunk-*.zst' -delete
python3 - "$IMAGES/debian-chunks/$BUILD_ID" "$IMAGES/debian-chunks" <<'PYCOPY'
import os, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
n = 0
for f in os.listdir(src):
    if f.startswith("chunk-") and f.endswith(".zst"):
        shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
        n += 1
print(f"   mirrored {n} chunk files for local dev")
PYCOPY

echo "== Regenerating chunk manifest =="
node "$ROOT/tools/image/build-chunk-manifest.js"

echo
echo "== Done =="
du -h "$IMAGES/debian.img" | sed 's/^/  raw disk: /'
du -sh "$IMAGES/debian-chunks" | sed 's/^/  chunks:   /'
ls -lh "$IMAGES/debian-bzImage" "$IMAGES/debian-initrd" | awk '{print "  "$9": "$5}'
