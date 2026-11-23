#!/bin/bash
# Build the Debian bookworm i386 CLI root filesystem.
#
# This is the content of copy/v86's tools/docker/debian/Dockerfile, reduced to
# the CLI toolset we need. It runs as a script rather than a Dockerfile because
# `docker build` deadlocks under qemu-user on Apple Silicon (qemu fails to reap
# the exited apt-get, so the build container never terminates). Running the same
# steps with `docker run --init` gives us a real reaper and completes.
set -euo pipefail

# 1. Debian's slim images exclude man pages at the dpkg layer:
#      path-exclude /usr/share/man/*
#    Remove that line BEFORE installing anything, or apt silently skips every
#    man page. Other size exclusions (docs, locales) are left in place.
sed -i '/^path-exclude \/usr\/share\/man\/\*$/d' /etc/dpkg/dpkg.cfg.d/docker

# 2. sysvinit-core's postinst restarts init via the /run/initctl FIFO. With no
#    init running it blocks forever. The postinst itself skips this when
#    /run/systemd/system exists, which is the supported "not booted" signal.
mkdir -p /run/systemd/system

export DEBIAN_FRONTEND=noninteractive
apt-get update

apt-get install -y --no-install-recommends \
  bash \
  coreutils \
  util-linux \
  util-linux-extra \
  procps \
  git \
  man-db \
  manpages \
  manpages-dev \
  less \
  nano \
  curl \
  ca-certificates \
  gcc \
  g++ \
  libc6-dev \
  make \
  e2fsprogs \
  sysvinit-core \
  initscripts \
  linux-image-686

# 3. coreutils and util-linux ship in the base image, so they were unpacked
#    while path-exclude was still active. Force them to be extracted again now
#    that the exclusion is gone, otherwise man ls / man lsblk stay missing.
apt-get install -y --reinstall --no-install-recommends coreutils util-linux util-linux-extra
apt-get install -y --reinstall --no-install-recommends man-db manpages manpages-dev

rm -rf /var/lib/apt/lists/*

# init: sysinit + autologin root on both serial (fallback) and virtio-console (primary, supports SIGWINCH resize)
cat > /etc/inittab <<'EOF'
id:2:initdefault:
si::sysinit:/etc/init.d/rcS
T0:23:respawn:/sbin/getty -L ttyS0 115200 xterm-256color --autologin root
H0:23:respawn:/sbin/getty -L hvc0 115200 xterm-256color --autologin root
EOF

# Full-screen programs (nano, vim, less) need an alternate screen so they do not
# paint over the scrollback. getty already sets TERM for the console; this also
# covers shells started from elsewhere (su, second sessions).
cat > /etc/profile.d/term.sh <<'EOF'
# Choose a terminal with smcup/rmcup when the image provides one.
if [ -z "$TERM" ] || [ "$TERM" = "vt102" ] || [ "$TERM" = "vt100" ] || [ "$TERM" = "dumb" ]; then
  command -v infocmp >/dev/null 2>&1 && infocmp xterm-256color >/dev/null 2>&1 && export TERM=xterm-256color
fi
EOF
chmod 644 /etc/profile.d/term.sh

cat > /etc/fstab <<'EOF'
/dev/sda / ext4 rw,relatime 0 1
proc /proc proc defaults 0 0
sysfs /sys sysfs defaults 0 0
EOF

printf '%s\n' \
  'export HOME=/root' \
  'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  'export LANG=C.UTF-8' \
  'cd /root 2>/dev/null || cd /' \
  > /root/.bash_profile

printf '%s\n' \
  'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  > /root/.bashrc

echo 'root:root' | chpasswd

# Trim things that are useless inside the emulator
rm -rf /var/cache/apt/* /var/lib/apt/lists/* /tmp/* /var/tmp/*

echo "ROOTFS_BUILD_OK"
