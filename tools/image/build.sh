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
KERNEL_CACHE="$WORK/kernel-cache"
CONTAINER_NAME=alpine-cli-build
DISK_SIZE="${DISK_SIZE:-1G}"
NEXTGEN_SQUASHFS="${NEXTGEN_SQUASHFS:-0}"
CHUNK_SIZE_KB="${CHUNK_SIZE_KB:-128}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.21.3}"
TINYCC_COMMIT="${TINYCC_COMMIT:-48d1d42e0c0d397571284b587b16a468b5a147b0}"
LINUX_VER="${LINUX_VER:-6.12.11}"

mkdir -p "$IMAGES" "$WORK" "$KERNEL_CACHE"

if [ "$NEXTGEN_SQUASHFS" = "1" ]; then
  KCFG_HASH="$( (shasum -a 256 "$DIR/kernel.config" 2>/dev/null || sha256sum "$DIR/kernel.config") | awk '{print substr($1,1,16)}' )"
  K_BZ="$KERNEL_CACHE/bzImage-${LINUX_VER}-${KCFG_HASH}"
  if [ ! -f "$K_BZ" ]; then
    echo "== Stage 0: Cross-compiling minimal Linux ${LINUX_VER} x86_32 kernel natively on arm64 (hash ${KCFG_HASH}) =="
    docker run --rm --init --platform linux/arm64 \
      -v "$DIR/kernel.config:/kernel.config:ro" \
      -v "$KERNEL_CACHE:/kout" \
      debian:bookworm-slim \
      sh -c '
        set -eu
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
          gcc make flex bison bc perl libelf-dev libssl-dev curl xz-utils ca-certificates \
          gcc-i686-linux-gnu binutils-i686-linux-gnu cpio kmod >/dev/null
        mkdir -p /tmp/k && cd /tmp/k
        curl -fsSL "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-'"$LINUX_VER"'.tar.xz" | tar -xJ --strip-components=1
        make ARCH=x86 CROSS_COMPILE=i686-linux-gnu- tinyconfig
        ARCH=x86 CROSS_COMPILE=i686-linux-gnu- ./scripts/kconfig/merge_config.sh -m .config /kernel.config
        make ARCH=x86 CROSS_COMPILE=i686-linux-gnu- olddefconfig
        for req in CONFIG_SQUASHFS=y CONFIG_OVERLAY_FS=y CONFIG_ATA_PIIX=y CONFIG_BLK_DEV_SD=y \
                   CONFIG_VIRTIO_PCI=y CONFIG_VIRTIO_PCI_LEGACY=y \
                   CONFIG_VIRTIO_CONSOLE=y CONFIG_VIRTIO_NET=y CONFIG_9P_FS=y CONFIG_NET_9P_VIRTIO=y \
                   CONFIG_SERIAL_8250_CONSOLE=y CONFIG_PROC_SYSCTL=y CONFIG_EXT4_FS=y CONFIG_TMPFS=y; do
          grep -qx "$req" .config || { echo "ERROR: required kernel option missing: $req" >&2; exit 1; }
        done
        for ban in CONFIG_SMP=y CONFIG_MODULES=y; do
          ! grep -qx "$ban" .config || { echo "ERROR: forbidden kernel option enabled: $ban" >&2; exit 1; }
        done
        make -j"$(nproc)" ARCH=x86 CROSS_COMPILE=i686-linux-gnu- bzImage
        cp arch/x86/boot/bzImage "/kout/bzImage-'"$LINUX_VER"'-'"$KCFG_HASH"'"
      '
  else
    echo "== Stage 0: Reusing cached minimal kernel $K_BZ =="
  fi
  cp "$K_BZ" "$IMAGES/debian-bzImage"
  rm -f "$IMAGES/debian-initrd"
fi

echo "== Stage 1: Building TinyCC (tcc) for Alpine x86 musl =="
rm -rf "$TCC_OUT"
mkdir -p "$TCC_OUT"
docker run --rm --init --platform linux/386 \
  -v "$TCC_OUT:/tcc-out" \
  "$ALPINE_IMAGE" \
  sh -c '
    set -eu
    apk add -q --no-cache gcc musl-dev make git linux-headers binutils
    git clone --depth 1 https://repo.or.cz/tinycc.git /tmp/tcc \
      || git clone --depth 1 https://github.com/TinyCC/tinycc.git /tmp/tcc
    cd /tmp/tcc
    echo "TinyCC commit: $(git rev-parse HEAD)"
    ./configure --prefix=/usr/local --config-musl
    make -j4 >/dev/null
    make install >/dev/null
    strip --strip-unneeded /usr/local/bin/tcc 2>/dev/null || true
    mkdir -p /tcc-out/bin /tcc-out/lib/tcc
    cp -a /usr/local/bin/tcc /tcc-out/bin/tcc
    cp -a /usr/local/lib/tcc/. /tcc-out/lib/tcc/
    /tcc-out/bin/tcc -v
  '

echo "== Stage 2: Building clean Alpine 3.21 x86 root filesystem =="
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run --name "$CONTAINER_NAME" --init --platform linux/386 \
  -e "NEXTGEN_SQUASHFS=$NEXTGEN_SQUASHFS" \
  -v "$DIR/install.sh:/install.sh:ro" \
  -v "$TCC_OUT:/tcc-out:ro" \
  "$ALPINE_IMAGE" \
  sh /install.sh

echo "== Exporting root filesystem =="
docker export "$CONTAINER_NAME" > "$WORK/alpine-rootfs.tar"
docker rm "$CONTAINER_NAME"
rm -rf "$TCC_OUT"

echo "== Stage 3: Creating disk image (NEXTGEN_SQUASHFS=$NEXTGEN_SQUASHFS) =="
rm -f "$IMAGES/debian.img"
if [ "$NEXTGEN_SQUASHFS" = "1" ]; then
  cat > "$WORK/sqsh.sort" <<'SORTEOF'
/bin/busybox 1000
/lib/ld-musl-i386.so.1 999
/bin/bash 995
/usr/local/bin/tcc 990
/usr/local/lib/tcc 985
/usr/include 980
/usr/bin/nano 970
/usr/share/nano 965
/usr/bin/htop 960
/usr/bin/jq 955
/usr/bin/tree 950
/usr/bin/fastfetch 945
/usr/bin/make 940
/usr/bin/git 920
/usr/libexec/git-core 915
/usr/bin/tmux 900
/usr/bin/python3 880
/usr/lib/python3.12 875
/usr/bin/mandoc 860
/usr/share/man 855
/usr/bin/curl 840
SORTEOF
  docker run --rm --privileged \
    -v "$IMAGES:/images" \
    -v "$WORK:/work" \
    --platform linux/arm64 \
    "$ALPINE_IMAGE" \
    sh -c '
      set -eu
      apk add -q --no-cache squashfs-tools tar coreutils
      mkdir -p /tmp/rootfs
      tar -xf /work/alpine-rootfs.tar -C /tmp/rootfs
      echo golinux > /tmp/rootfs/etc/hostname
      printf "%s\n" "127.0.0.1 localhost" "127.0.1.1 golinux" > /tmp/rootfs/etc/hosts
      mksquashfs /tmp/rootfs /images/debian.img -noI -noD -noF -noX -no-exports -no-xattrs -b '"$((CHUNK_SIZE_KB * 1024))"' -sort /work/sqsh.sort -nopad
      SZ=$(stat -c%s /images/debian.img)
      CHUNK_B='"$((CHUNK_SIZE_KB * 1024))"'
      ALIGNED=$(( ((SZ + CHUNK_B - 1) / CHUNK_B) * CHUNK_B ))
      # Round up to at least 256 MiB or next 16 MiB boundary so virtual disk has clean headroom
      MIN_B=$((256 * 1024 * 1024))
      [ "$ALIGNED" -lt "$MIN_B" ] && ALIGNED="$MIN_B"
      truncate -s "$ALIGNED" /images/debian.img
    '
else
  docker run --rm --privileged \
    -v "$IMAGES:/images" \
    -v "$WORK:/work" \
    --platform linux/arm64 \
    "$ALPINE_IMAGE" \
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
      printf "%s\n" "nameserver 192.168.86.1" > /mnt/root/etc/resolv.conf
      sync
      cp /mnt/root/boot/vmlinuz-virt /images/debian-bzImage
      cp /mnt/root/boot/initramfs-virt /images/debian-initrd
      umount /mnt/root
    '
fi

rm -f "$WORK/alpine-rootfs.tar"

echo "== Splitting into ${CHUNK_SIZE_KB} KiB zstd chunks (per-build directory) =="
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD_ID_TMP="build-$STAMP"
rm -rf "$IMAGES/debian-chunks/$BUILD_ID_TMP"
mkdir -p "$IMAGES/debian-chunks/$BUILD_ID_TMP"
python3 "$ROOT/tools/split-image.py" --zstd "${CHUNK_SIZE_KB}k" \
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
cp -f "$IMAGES/debian-chunks/$BUILD_ID/empty-chunk.zst" "$IMAGES/debian-chunks/empty-chunk.zst"
cp -f "$IMAGES/debian-chunks/$BUILD_ID/empty-chunk.zst" "$ROOT/assets/empty-chunk.zst"
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
ls -lh "$IMAGES/debian-bzImage" | awk '{print "  "$9": "$5}'
if [ -f "$IMAGES/debian-initrd" ]; then
  ls -lh "$IMAGES/debian-initrd" | awk '{print "  "$9": "$5}'
fi
