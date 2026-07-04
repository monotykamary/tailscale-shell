#!/bin/zsh
# Install the userspace-networking tailscaled as a system LaunchDaemon.
# Run as YOUR user (it will sudo for the privileged steps), from the
# tailscale-shell repo:
#   zsh install-tailscaled-userspace.sh
#
# What it does:
#   1. symlinks ~/go/bin/tailscale{,d} -> /usr/local/bin
#   2. copies the plist to /Library/LaunchDaemons
#   3. bootstraps + kicks the LaunchDaemon (com.tailscale.tailscaled-userspace)
#
# Result: tailscaled runs as root at boot with --tun=userspace-networking,
# a SOCKS5+HTTP proxy on 127.0.0.1:1055, the control socket at the
# macOS default /var/run/tailscaled.socket, and node state at
# /Library/Tailscale/tailscaled.state (reused across reboots).
#
# Prerequisite: build tailscale from source (the App Store / Homebrew build
# uses a system VPN extension, NOT userspace networking). See
# https://github.com/tailscale/tailscale — binaries are expected at
# ~/go/bin/ (override with TAILSCALE_SRC_DIR=...).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="${TAILSCALE_SRC_DIR:-$HOME/go/bin}"
TAILSCALED_BIN="$SRC_DIR/tailscaled"
TAILSCALE_CLI_BIN="$SRC_DIR/tailscale"
PLIST_SRC="$SCRIPT_DIR/com.tailscale.tailscaled-userspace.plist"
PLIST_DST="/Library/LaunchDaemons/com.tailscale.tailscaled-userspace.plist"
LABEL="com.tailscale.tailscaled-userspace"

[ -x "$TAILSCALED_BIN" ] || { echo "tailscaled not found at $TAILSCALED_BIN (build it from source, or set TAILSCALE_SRC_DIR=...)" >&2; exit 1; }
[ -f "$PLIST_SRC"      ] || { echo "plist not found at $PLIST_SRC" >&2; exit 1; }

echo "==> installing $LABEL (one sudo prompt for the privileged steps)"

sudo bash -euc '
  set -x
  LABEL="com.tailscale.tailscaled-userspace"
  PLIST_DST="/Library/LaunchDaemons/com.tailscale.tailscaled-userspace.plist"
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_DST"
  mkdir -p /usr/local/bin
  ln -sf "'"$TAILSCALED_BIN"'"    /usr/local/bin/tailscaled
  ln -sf "'"$TAILSCALE_CLI_BIN"'" /usr/local/bin/tailscale
  mkdir -p /Library/Tailscale
  chmod 700 /Library/Tailscale
  cp "'"$PLIST_SRC"'" "$PLIST_DST"
  chmod 644 "$PLIST_DST"
  launchctl bootstrap system "$PLIST_DST"
  launchctl enable "system/$LABEL" 2>/dev/null || true
  launchctl kickstart -k "system/$LABEL"
'

echo
echo "Installed. Checking status..."
sleep 2
if launchctl print "system/$LABEL" >/dev/null 2>&1; then
  echo "  daemon loaded: $LABEL"
else
  echo "  WARNING: daemon not loaded; check /Library/Tailscale/tailscaled-userspace.stderr.log"
fi

cat <<'EOF'

Next steps:
  1. Authenticate + bring the node up (one time):
       sudo tailscale up
     (If `tailscale up` already works as yourself without sudo, use that; macOS
      tailscaled typically grants the console user access to the default socket.)
  2. Grant YOUR user passwordless control of the daemon (only needed if step 1
     gave a permission error as yourself; --operator is on set/login, not up):
       sudo tailscale set --operator="$USER"
     After this `tailscale ...` works as yourself, including after reboot.
  3. As yourself, confirm:
       tailscale status
       tailscale ip
       curl --socks5-hostname 127.0.0.1:1055 -s https://tailscale.com/health
  4. Route a shell through Tailscale:
       ts              # env-proxy mode (curl/git/npm/pip/go/brew ...)
       ts finland      # pick a Mullvad exit node by country
       ts status       # current exit node + proxy health

Logs:       /Library/Tailscale/tailscaled-userspace.std{out,err}.log
Uninstall:  zsh uninstall-tailscaled-userspace.sh [--purge]
EOF
