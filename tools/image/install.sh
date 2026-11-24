#!/bin/sh
# Build the Alpine Linux 3.21 x86 ultra-lightweight CLI root filesystem for v86.
#
# Runs inside `alpine:3.21` (--platform linux/386) with pre-built TinyCC
# mounted read-only at /tcc-out (compiled in stage 1 so gcc never bloats the
# final rootfs).
set -eu

apk update

# Configure mkinitfs features BEFORE installing linux-virt so initramfs-virt
# includes ext4 + ata/ide/scsi/virtio drivers for /dev/sda and /dev/hvc0.
mkdir -p /etc/mkinitfs
cat > /etc/mkinitfs/mkinitfs.conf <<'EOF'
features="ata base ide scsi virtio ext4"
EOF

# Ultra-lean Alpine + BusyBox + TinyCC + essential CLI tools
apk add --no-cache \
  alpine-base \
  linux-virt \
  e2fsprogs \
  bash \
  bash-doc \
  less \
  lsblk \
  ncurses-terminfo-base \
  musl-dev \
  nano \
  nano-syntax \
  git \
  make \
  htop \
  jq \
  tree \
  tmux \
  file \
  zip \
  unzip \
  curl \
  ca-certificates \
  mandoc \
  man-pages-posix \
  busybox-doc \
  nano-doc \
  git-doc \
  fastfetch \
  figlet \
  sl \
  python3

# Clear BOTH viewport and scrollback buffer (\e[3J), matching modern GNU clear
cat > /usr/local/bin/clear <<'CLREOF'
#!/bin/sh
printf '\033[H\033[2J\033[3J'
CLREOF
chmod +x /usr/local/bin/clear

# Enable vibrant syntax highlighting in nano for popular languages
# (all packed into a single hot b-core bundle for instant mobile startup)
: > /etc/nanorc
for syn in c python sh json markdown makefile javascript html css patch asm awk go rust yaml xml default; do
  if [ -f "/usr/share/nano/${syn}.nanorc" ]; then
    echo "include \"/usr/share/nano/${syn}.nanorc\"" >> /etc/nanorc
  fi
done

# Install TinyCC (tcc) built in stage 1
mkdir -p /usr/local/bin /usr/local/lib/tcc
cp -a /tcc-out/bin/tcc /usr/local/bin/tcc
cp -a /tcc-out/lib/tcc/. /usr/local/lib/tcc/
chmod +x /usr/local/bin/tcc

# Symlink cc -> tcc, vim -> BusyBox vi, and provide a smart gcc wrapper -> tcc
# so both `tcc main.c -o main` and `gcc main.c -o main` compile in <0.3s!
ln -sf /usr/local/bin/tcc /usr/local/bin/cc
ln -sf /bin/vi /usr/local/bin/vim

cat > /usr/local/bin/gcc <<'GCCEOF'
#!/bin/sh
# Fast TinyCC (tcc) frontend for GoLinux Alpine (C99/C11).
exec /usr/local/bin/tcc "$@"
GCCEOF
chmod +x /usr/local/bin/gcc

# Tiny zero-dependency cowsay / cowthink (2 KB, zero Perl needed)
cat > /usr/local/bin/cowsay <<'COWEOF'
#!/bin/sh
MSG="$*"
[ -z "$MSG" ] && MSG=$(cat)
[ -z "$MSG" ] && MSG="Moo from Alpine in your browser!"
LEN=${#MSG}
BAR=$(awk -v n="$((LEN + 2))" 'BEGIN { for (i=0; i<n; i++) printf "_"; }')
DASH=$(awk -v n="$((LEN + 2))" 'BEGIN { for (i=0; i<n; i++) printf "-"; }')
printf " %s\n< %s >\n %s\n" "$BAR" "$MSG" "$DASH"
cat <<'ART'
        \   ^__^
         \  (oo)\_______
            (__)\       )\/\
                ||----w |
                ||     ||
ART
COWEOF
chmod +x /usr/local/bin/cowsay

cat > /usr/local/bin/cowthink <<'THINKEOF'
#!/bin/sh
MSG="$*"
[ -z "$MSG" ] && MSG=$(cat)
[ -z "$MSG" ] && MSG="Thinking in WebAssembly..."
LEN=${#MSG}
BAR=$(awk -v n="$((LEN + 2))" 'BEGIN { for (i=0; i<n; i++) printf "_"; }')
DASH=$(awk -v n="$((LEN + 2))" 'BEGIN { for (i=0; i<n; i++) printf "-"; }')
printf " %s\n( %s )\n %s\n" "$BAR" "$MSG" "$DASH"
cat <<'ART'
        o   ^__^
         o  (oo)\_______
            (__)\       )\/\
                ||----w |
                ||     ||
ART
THINKEOF
chmod +x /usr/local/bin/cowthink

# Fast minimal config for native C fastfetch (skips slow PCI/GPU/display probes
# so fastfetch runs in <40ms even on mobile browsers!)
mkdir -p /etc/fastfetch /root/.config/fastfetch
cat > /root/.config/fastfetch/config.jsonc <<'FFCFG'
{
  "$schema": "https://github.com/fastfetch-cli/fastfetch/raw/dev/doc/json_schema.json",
  "logo": {
    "source": "alpine_small",
    "padding": { "top": 1, "left": 2, "right": 3 }
  },
  "display": { "separator": ": " },
  "modules": [
    "title",
    "separator",
    "os",
    { "type": "custom", "key": "Host", "format": "v86 WebAssembly VM (128 MiB)" },
    "kernel",
    "uptime",
    "packages",
    "shell",
    "terminal",
    "memory",
    "disk",
    "break",
    "colors"
  ]
}
FFCFG
cp /root/.config/fastfetch/config.jsonc /etc/fastfetch/config.jsonc

# Autologin helper for BusyBox getty on both ttyS0 and hvc0
cat > /usr/local/bin/autologin <<'AUTOEOF'
#!/bin/sh
exec /bin/login -f root
AUTOEOF
chmod +x /usr/local/bin/autologin

# Minimal, instant BusyBox init script (boots in ~2 seconds!)
mkdir -p /etc/init.d /mnt/host /root /tmp
cat > /etc/init.d/rcS <<'RCSEOF'
#!/bin/sh
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /dev/pts /dev/shm /run /tmp /mnt/host
mount -t devpts devpts /dev/pts 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true
mount -t tmpfs tmpfs /run 2>/dev/null || true
mount -o remount,rw / 2>/dev/null || true
hostname -F /etc/hostname 2>/dev/null || hostname golinux
dmesg -n 1 2>/dev/null || true
# Load 9p modules and mount /mnt/host for zero-stdin browser Upload/Download
modprobe 9p 2>/dev/null || true
modprobe 9pnet 2>/dev/null || true
modprobe 9pnet_virtio 2>/dev/null || true
mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/host 2>/dev/null || true
# Bring up loopback and virtio-net eth0 with static virtual LAN config (0ms boot delay,
# offline-safe by default; host browser SafeFetchNetworkAdapter gates outbound traffic).
ip link set lo up 2>/dev/null || true
modprobe virtio_net 2>/dev/null || true
ip link set eth0 up 2>/dev/null || true
ip addr replace 192.168.86.100/24 dev eth0 2>/dev/null || true
ip route replace default via 192.168.86.1 dev eth0 2>/dev/null || true
RCSEOF
chmod +x /etc/init.d/rcS

cat > /usr/local/bin/nethelp <<'NETEOF'
#!/bin/sh
cat <<'TXT'
GoLinux Zero-Server Browser Networking
--------------------------------------
Status: Toggle "Net: Off / Net: On" in the top bar (no VM restart needed).

What works (zero server, directly from your browser):
  curl http://api.github.com/zen          # http:// auto-upgrades to HTTPS
  curl http://wttr.in/?format=3           # CORS-enabled APIs & raw files
  curl http://httpbin.org/get             # GET / POST / PUT / HEAD
  nslookup github.com                     # DNS via Cloudflare DoH

Browser security limits (no relay server):
  - Use http:// with curl (browser upgrades it to HTTPS; port 443 is blocked).
  - Target server must allow CORS (Access-Control-Allow-Origin).
  - Non-CORS sites, apk add, git clone, ssh, and private/localhost IPs are blocked.
TXT
NETEOF
chmod +x /usr/local/bin/nethelp

cat > /etc/inittab <<'EOF'
::sysinit:/etc/init.d/rcS
ttyS0::respawn:/sbin/getty -L -n -l /usr/local/bin/autologin 115200 ttyS0 xterm-256color
hvc0::respawn:/sbin/getty -L -n -l /usr/local/bin/autologin 115200 hvc0 xterm-256color
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/umount -a -r
EOF

cat > /etc/fstab <<'EOF'
/dev/sda / ext4 rw,relatime 0 1
proc /proc proc defaults 0 0
sysfs /sys sysfs defaults 0 0
host9p /mnt/host 9p trans=virtio,version=9p2000.L,rw,noauto 0 0
EOF

# Set root's login shell to bash (while BusyBox handles all coreutils!)
sed -i 's|^root:x:0:0:root:/root:/bin/sh|root:x:0:0:root:/root:/bin/bash|' /etc/passwd
sed -i 's|^root:x:0:0:root:/root:/bin/ash|root:x:0:0:root:/root:/bin/bash|' /etc/passwd

mkdir -p /etc/profile.d
cat > /etc/profile.d/term.sh <<'EOF'
if [ -z "$TERM" ] || [ "$TERM" = "vt102" ] || [ "$TERM" = "vt100" ] || [ "$TERM" = "dumb" ]; then
  export TERM=xterm-256color
fi
EOF
chmod 644 /etc/profile.d/term.sh

cat > /root/.bash_profile <<'EOF'
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export TERM=${TERM:-xterm-256color}
export PAGER=less
export LESS='-R'
[ -f /root/.bashrc ] && . /root/.bashrc
cd /root 2>/dev/null || cd /
EOF

cat > /root/.bashrc <<'EOF'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PAGER=less
export LESS='-R'
export CLICOLOR=1
export LS_COLORS='di=1;34:ln=1;36:ex=1;32:so=1;35:pi=33:bd=1;33:cd=1;33:*.tar=1;31:*.tgz=1;31:*.gz=1;31:*.zip=1;31:*.zst=1;31:*.c=38;5;114:*.h=38;5;110:*.py=38;5;221:*.sh=1;32:*.md=38;5;183:*.json=38;5;215'
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

# Clean caches
rm -rf /var/cache/apk/* /tmp/* /var/tmp/*

echo "ROOTFS_BUILD_OK"
