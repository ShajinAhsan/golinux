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
  vim-tiny \
  tree \
  htop \
  jq \
  tmux \
  file \
  bc \
  zip \
  unzip \
  python3 \
  neofetch \
  cowsay \
  figlet \
  sl \
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

# Expose /usr/games tools (cowsay, cowthink, sl) and vim on default PATH
for bin in cowsay cowthink sl; do
  [ -x "/usr/games/$bin" ] && ln -sf "/usr/games/$bin" "/usr/local/bin/$bin"
done
[ -x /usr/bin/vim.tiny ] && [ ! -e /usr/local/bin/vim ] && ln -sf /usr/bin/vim.tiny /usr/local/bin/vim

# Lightweight instant fastfetch (Debian 12 bookworm has no native fastfetch pkg;
# this runs in <50ms inside v86 with zero external dependencies).
cat > /usr/local/bin/fastfetch <<'FFEOF'
#!/bin/bash
R='\033[0m'; B='\033[1m'; G='\033[1;32m'; C='\033[1;36m'; BL='\033[1;34m'; D='\033[2m'
HOST=$(hostname 2>/dev/null || echo golinux)
KERN=$(uname -r)
ARCH=$(uname -m)
UP_SEC=$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || echo 0)
UP_H=$((UP_SEC / 3600)); UP_M=$(((UP_SEC % 3600) / 60)); UP_S=$((UP_SEC % 60))
[ "$UP_H" -gt 0 ] && UP="${UP_H}h ${UP_M}m" || UP="${UP_M}m ${UP_S}s"
MEM_TOT=$(awk '/MemTotal:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 256)
MEM_AVAIL=$(awk '/MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 180)
MEM_USED=$((MEM_TOT - MEM_AVAIL))
DISK=$(df -h / 2>/dev/null | awk 'NR==2{print $3 " / " $2 " (" $5 ")"}')
PKGS=$(dpkg-query -f '.\n' -W 2>/dev/null | wc -l)
SHELL_VER="bash ${BASH_VERSION%%(*}"
TERM_NAME="${TERM:-xterm-256color}"

printf "\n"
printf "   ${G}   _____        __    _                 ${R}   ${G}${USER:-root}${R}@${G}${HOST}${R}\n"
printf "   ${G}  / ____|      / /   (_)                ${R}   ${D}--------------------------${R}\n"
printf "   ${G} | |  __  ___ / /     _ _ __  _   ___  _${R}   ${BL}OS${R}: Debian GNU/Linux 12 (bookworm) ${ARCH}\n"
printf "   ${G} | | |_ |/ _ \\\\ \\\\    | | '_ \\\\| | | \\\\ \\\\/ /${R}   ${BL}Host${R}: v86 WebAssembly VM (Browser)\n"
printf "   ${G} | |__| | (_) | |___| | | | | |_| |>  < ${R}   ${BL}Kernel${R}: Linux ${KERN}\n"
printf "   ${G}  \\\\_____|\\\\___/|_____|_|_| |_|\\\\__,_/_/\\\\_\\\\${R}   ${BL}Uptime${R}: ${UP}\n"
printf "   ${C}                                        ${R}   ${BL}Packages${R}: ${PKGS} (dpkg)\n"
printf "   ${C}   100%% Local · Zero Server · Offline   ${R}   ${BL}Shell${R}: ${SHELL_VER}\n"
printf "   ${D}         terminal.golinux.app           ${R}   ${BL}Terminal${R}: ${TERM_NAME}\n"
printf "                                              ${BL}Memory${R}: ${MEM_USED} MiB / ${MEM_TOT} MiB\n"
printf "                                              ${BL}Disk (/)${R}: ${DISK}\n"
printf "                                              \033[40m   \033[41m   \033[42m   \033[43m   \033[44m   \033[45m   \033[46m   \033[47m   ${R}\n\n"
FFEOF
chmod +x /usr/local/bin/fastfetch

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
  'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games' \
  'export LANG=C.UTF-8' \
  '[ -f /root/.bashrc ] && . /root/.bashrc' \
  'cd /root 2>/dev/null || cd /' \
  > /root/.bash_profile

cat > /root/.bashrc <<'EOF'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games
export CLICOLOR=1
export LS_COLORS='di=1;34:ln=1;36:ex=1;32:so=1;35:pi=33:bd=1;33:cd=1;33:*.tar=1;31:*.tgz=1;31:*.gz=1;31:*.zip=1;31:*.zst=1;31:*.c=38;5;114:*.h=38;5;110:*.cpp=38;5;114:*.py=38;5;221:*.sh=1;32:*.md=38;5;183:*.json=38;5;215'
alias ls='ls --color=auto'
alias ll='ls -alF --color=auto'
alias la='ls -A --color=auto'
alias grep='grep --color=auto'
PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
EOF

echo 'root:root' | chpasswd

# Trim things that are useless inside the emulator
rm -rf /var/cache/apt/* /var/lib/apt/lists/* /tmp/* /var/tmp/*

echo "ROOTFS_BUILD_OK"
