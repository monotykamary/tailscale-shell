#!/bin/sh
# tailscale-shell installer.
#
#   curl -fsSL https://raw.githubusercontent.com/monotykamary/tailscale-shell/main/install.sh | bash
#
# Clones the repo, symlinks `ts` onto ~/.local/bin, and checks that the
# userspace-networking tailscaled proxy is up. It does NOT build tailscale or
# touch launchd — that's install-tailscaled-userspace.sh (needs Go + sudo);
# the installer prints the exact command to run it when the proxy is down.
#
# Overrides (env):
#   TS_INSTALL_DIR  where to clone            (default ~/.local/share/tailscale-shell)
#   TS_BIN_DIR      where to symlink `ts`      (default ~/.local/bin)
set -eu

REPO="https://github.com/monotykamary/tailscale-shell"
INSTALL_DIR="${TS_INSTALL_DIR:-$HOME/.local/share/tailscale-shell}"
BIN_DIR="${TS_BIN_DIR:-$HOME/.local/bin}"

bold() { printf '\033[1m%s\033[0m' "$*"; }
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

log "installing $(bold tailscale-shell)"

# required: zsh (ts is a zsh script) + git (this installer clones)
if ! have zsh; then
  echo "error: 'zsh' is required (macOS: built-in · Linux: apt install zsh / dnf install zsh)" >&2
  exit 1
fi
if ! have git; then
  echo "error: 'git' is required to clone the repo" >&2
  exit 1
fi

# refuse to clobber a non-clone dir at the install path
if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "error: $INSTALL_DIR exists but is not a tailscale-shell clone." >&2
  echo "       remove it, or set TS_INSTALL_DIR to a fresh path." >&2
  exit 1
fi

# clone, or update an existing clone
if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || {
    warn "update failed; leaving the installed link unchanged. Inspect $INSTALL_DIR before retrying."
    exit 1
  }
else
  log "cloning into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

# sanity: the bits ts needs are present and valid
[ -f "$INSTALL_DIR/ts" ]    || { echo "error: $INSTALL_DIR/ts missing — clone failed?" >&2; exit 1; }
[ -d "$INSTALL_DIR/ts.d" ] || { echo "error: $INSTALL_DIR/ts.d missing — clone incomplete?" >&2; exit 1; }
zsh -n "$INSTALL_DIR/ts"    || { echo "error: $INSTALL_DIR/ts failed its syntax check" >&2; exit 1; }
for wrapper in ssh scp sftp ping ts-ssh-match ts-real-command; do
  sh -n "$INSTALL_DIR/ts.d/$wrapper"
  chmod +x "$INSTALL_DIR/ts.d/$wrapper"
done
chmod +x "$INSTALL_DIR/ts"

# symlink ts onto PATH (ts.d/ stays next to the real ts; ts finds it via its
# own resolved path, so the symlink is safe)
mkdir -p "$BIN_DIR"
link_tmp="$BIN_DIR/.ts-link.$$"
trap 'rm -f "$link_tmp"' EXIT HUP INT TERM
ln -s "$INSTALL_DIR/ts" "$link_tmp"
mv -f "$link_tmp" "$BIN_DIR/ts"
trap - EXIT HUP INT TERM
log "linked $(bold ts) -> $BIN_DIR/ts"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add it to your shell rc, e.g.:
       export PATH=\"$BIN_DIR:\$PATH\"
     then open a new shell." ;;
esac

# soft deps that `ts` itself uses
have awk || warn "'awk' not found — ts needs it to parse exit-node lists (apt install gawk)"
have nc  || warn "'nc' (netcat) not found — ts needs it to probe the proxy (apt install netcat-openbsd)"
have jq  || warn "'jq' not found — 'ts status' works without it but is plainer (brew install jq / apt install jq)"
have curl || warn "'curl' not found — 'ts doctor' needs it for DNS and egress checks"

# is the userspace tailscaled proxy up? (ts preflights this same socket)
echo
if have nc && nc -z -w2 127.0.0.1 1055 2>/dev/null; then
  log "tailscaled userspace proxy is $(bold UP) on 127.0.0.1:1055"
  log "done. run: $(bold ts)"
else
  log "tailscaled userspace proxy is $(bold NOT up) on 127.0.0.1:1055"
  cat <<EOF

  ts needs tailscaled built from source with --tun=userspace-networking
  (the App Store / Homebrew build uses a VPN extension, not userspace).
  Set it up with:

      zsh $INSTALL_DIR/install-tailscaled-userspace.sh

  (builds tailscale into ~/go/bin — needs Go; installs a launchd daemon —
   needs sudo. See the README for details.)
EOF
  log "ts is installed; finish the daemon setup above, then run: $(bold ts)"
fi
