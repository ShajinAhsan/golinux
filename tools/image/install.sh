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

# Lightweight zero-fork fastfetch (pure bash built-ins reading /proc/* only;
# runs in <40ms even on mobile browsers with zero extra disk reads).
cat > /usr/local/bin/fastfetch <<'FFEOF'
#!/bin/bash
R=$'\e[0m'; G=$'\e[1;32m'; C=$'\e[1;36m'; BL=$'\e[1;34m'; D=$'\e[2m'
read -r HOST < /etc/hostname 2>/dev/null || HOST=golinux
read -r _ _ KERN _ < /proc/version 2>/dev/null || KERN=6.1
read -r UP_RAW _ < /proc/uptime 2>/dev/null || UP_RAW=0
UP_SEC=${UP_RAW%%.*}
UP_H=$((UP_SEC / 3600)); UP_M=$(((UP_SEC % 3600) / 60)); UP_S=$((UP_SEC % 60))
if (( UP_H > 0 )); then UP="${UP_H}h ${UP_M}m"; else UP="${UP_M}m ${UP_S}s"; fi
MEM_TOT=256; MEM_AVAIL=180
while read -r k v _; do
  case "$k" in
    MemTotal:) MEM_TOT=$((v / 1024)) ;;
    MemAvailable:) MEM_AVAIL=$((v / 1024)); break ;;
  esac
done < /proc/meminfo 2>/dev/null
MEM_USED=$((MEM_TOT - MEM_AVAIL))
SHELL_VER="bash ${BASH_VERSION%%(*}"
TERM_NAME="${TERM:-xterm-256color}"
printf '\n'
printf '   %s   _____        __    _                 %s   %s%s%s@%s%s%s\n' "$G" "$R" "$G" "${USER:-root}" "$R" "$G" "$HOST" "$R"
printf '   %s  / ____|      / /   (_)                %s   %s--------------------------%s\n' "$G" "$R" "$D" "$R"
printf '   %s | |  __  ___ / /     _ _ __  _   ___  _%s   %sOS%s: Debian GNU/Linux 12 (bookworm) i686\n' "$G" "$R" "$BL" "$R"
printf '   %s | | |_ |/ _ \\ \\    | | '\''_ \\| | | \\ \\/ /%s   %sHost%s: v86 WebAssembly VM (Browser)\n' "$G" "$R" "$BL" "$R"
printf '   %s | |__| | (_) | |___| | | | | |_| |>  < %s   %sKernel%s: Linux %s\n' "$G" "$R" "$BL" "$R" "$KERN"
printf '   %s  \\_____|\\___/|_____|_|_| |_|\\__,_/_/\\_\\\\%s   %sUptime%s: %s\n' "$G" "$R" "$BL" "$R" "$UP"
printf '   %s   100%% Local · Zero Server · Offline   %s   %sShell%s: %s\n' "$C" "$R" "$BL" "$R" "$SHELL_VER"
printf '   %s         terminal.golinux.app           %s   %sTerminal%s: %s\n' "$D" "$R" "$BL" "$R" "$TERM_NAME"
printf '                                              %sMemory%s: %s MiB / %s MiB\n' "$BL" "$R" "$MEM_USED" "$MEM_TOT"
printf '                                              \e[40m   \e[41m   \e[42m   \e[43m   \e[44m   \e[45m   \e[46m   \e[47m   %s\n\n' "$R"
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
shopt -s checkwinsize
alias ls='ls --color=auto'
alias ll='ls -alF --color=auto'
alias la='ls -A --color=auto'
alias grep='grep --color=auto'
__gl_prompt_sp() { local c=${COLUMNS:-80}; (( c > 1 )) && printf '\e[2;7m%%\e[0m%*s\r\e[K' $((c - 1)) ''; }
PROMPT_COMMAND=__gl_prompt_sp
PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
EOF

echo 'root:root' | chpasswd

# Trim things that are useless inside the emulator
rm -rf /var/cache/apt/* /var/lib/apt/lists/* /tmp/* /var/tmp/*

echo "ROOTFS_BUILD_OK"
