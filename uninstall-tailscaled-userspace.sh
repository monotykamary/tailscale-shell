#!/bin/zsh
# Uninstall the userspace-networking tailscaled LaunchDaemon.
# Run as your user (it will sudo for the privileged steps), from the
# tailscale-shell repo:
#   zsh uninstall-tailscaled-userspace.sh [--purge]
#
# This only removes the userspace daemon. It leaves node state
# (/Library/Tailscale/tailscaled.state) and the symlinks in place so you
# can reinstall without re-authenticating. Pass --purge to remove those too.

set -euo pipefail
LABEL="com.tailscale.tailscaled-userspace"
PLIST_DST="/Library/LaunchDaemons/com.tailscale.tailscaled-userspace.plist"

sudo bash -euc '
  set -x
  LABEL="com.tailscale.tailscaled-userspace"
  PLIST_DST="/Library/LaunchDaemons/com.tailscale.tailscaled-userspace.plist"
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_DST"
'

if [ "${1:-}" = "--purge" ]; then
  sudo bash -euc '
    rm -f /usr/local/bin/tailscaled /usr/local/bin/tailscale
    rm -f /Library/Tailscale/tailscaled.state
    rm -f /Library/Tailscale/tailscaled-userspace.stdout.log /Library/Tailscale/tailscaled-userspace.stderr.log
    rmdir /Library/Tailscale 2>/dev/null || true
  '
  echo "Purged symlink, state, and logs."
fi

echo "Uninstalled $LABEL."
