<div align="center">

# 🐚 tailscale-shell

**A proxied shell + exit-node picker for [Tailscale](https://tailscale.com/) userspace networking**

_Egress through Mullvad or your own relay — by country, city, or code._

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![shell](https://img.shields.io/badge/shell-zsh-89e051)](https://www.zsh.org/)
[![platform](https://img.shields.io/badge/platform-macOS%20·%20Linux-000000)](https://tailscale.com/kb/1282/userspace-networking)
[![tailscale](https://img.shields.io/badge/tailscale-userspace%20networking-1ABC9C)](https://tailscale.com/kb/1282/userspace-networking)

</div>

---

> `ts finland` — pick a Mullvad exit node by country and connect. Run it again to cycle to the next.

> **Status:** Early release. macOS-focused (ships a launchd daemon for userspace-networking `tailscaled`); `ts` itself is platform-agnostic.

```
$ ts finland
ts: exit node → fi-hel-wg-201.mullvad.ts.net · Finland Helsinki

$ ts finland          # 1 match — idempotent on re-run
ts: exit node → fi-hel-wg-201.mullvad.ts.net · Finland Helsinki

$ ts usa              # first US node; re-run to walk all 21
ts: exit node → us-chi-wg-301.mullvad.ts.net · USA Chicago, IL
  (21 matches for 'usa'; run 'ts usa' again to cycle)

$ ts atl              # city-code token → Atlanta
ts: exit node → us-atl-wg-001.mullvad.ts.net · USA Atlanta, GA

$ ts nas              # your own relay, by hostname token
ts: exit node → nas.example.ts.net

$ ts off              # clear the exit node (direct tailnet egress)
ts: exit node cleared (direct tailnet egress)
  now: none (tailnet direct; set one: ts <country|city|code>)

$ ts                  # proxied shell through the current node
ts: env mode — socks5://127.0.0.1:1055  (HTTP_PROXY=http://127.0.0.1:1055)
  exit node: us-atl-wg-001.mullvad.ts.net · USA Atlanta, GA
  ssh/ping: tailnet hosts via daemon (ssh nas · ping nas)
```

## Why

Tailscale's [userspace-networking](https://tailscale.com/kb/1282/userspace-networking) mode runs `tailscaled` without a system VPN extension — it exposes a local SOCKS5/HTTP proxy (`127.0.0.1:1055`) instead of a TUN interface. That sidesteps macOS SIP / VPN-extension limits and lets any process egress through your tailnet (and any Mullvad exit node) just by setting proxy env vars. But two things are missing out of the box:

1. **No shell integration** — you hand-set `ALL_PROXY` / `HTTPS_PROXY` every time.
2. **No quick exit-node picker** — `tailscale set --exit-node=<host>` means typing full hostnames like `us-atl-wg-001.mullvad.ts.net`.

`ts` fixes both: one command drops you into a proxied shell, and `ts <country|city|code>` selects + cycles exit nodes by a friendly name.

## Install

### 1. `tailscaled` with userspace networking

`ts` needs `tailscaled` running with `--tun=userspace-networking` (the SOCKS5/HTTP proxy on `127.0.0.1:1055`). On macOS, the included launchd installer sets that up:

```bash
git clone https://github.com/monotykamary/tailscale-shell
cd tailscale-shell
zsh install-tailscaled-userspace.sh
```

This requires `tailscale{,d}` **built from source** — the App Store / Homebrew build uses a system VPN extension, not userspace networking. See [Tailscale's build instructions](https://github.com/tailscale/tailscale); the binaries are expected at `~/go/bin/` (override with `TAILSCALE_SRC_DIR=...`).

Then bring the node up once:

```bash
sudo tailscale up
# if `tailscale ...` needs root, grant your user passwordless control:
sudo tailscale set --operator="$USER"
```

On Linux, skip the installer and run it directly:

```bash
tailscaled --tun=userspace-networking \
  --socks5-server=127.0.0.1:1055 \
  --outbound-http-proxy-listen=127.0.0.1:1055 &
```

### 2. The `ts` command

Symlink it onto your `PATH`:

```bash
ln -sf "$PWD/ts" ~/.local/bin/ts
```

(Or add the repo to your `PATH`.) Requires `zsh`, `awk`, and optionally `jq` (for the richer `ts status` output; falls back gracefully without it).

### 3. Authorize exit nodes

Enable Mullvad exit nodes in the [Tailscale admin console](https://login.tailscale.com/admin/exit-nodes) (Exit nodes → Mullvad), and allow internet egress in your [tailnet ACL](https://login.tailscale.com/admin/acls):

```json
{
  "acls": [
    { "action": "accept", "src": ["autogroup:admin"], "dst": ["autogroup:internet:*"] }
  ]
}
```

Your own tagged exit nodes (a home relay, a VPS) appear too — match them by hostname token (`ts nas`, `ts home`). `ts status` lists everything once it syncs.

## Usage

| Command | Description |
| --- | --- |
| `ts` | Proxied login shell (`ALL_PROXY` / `HTTP(S)_PROXY` → the socks5/http proxy) |
| `ts <query>` | Select an exit node by country / city / code / hostname token; re-run to cycle |
| `ts off` | Clear the exit node (direct tailnet egress) |
| `ts status` | Proxy + current exit node health check |
| `ts help` | This help |

### Query matching

Matching is case-insensitive, in priority order:

1. **Hostname token** — `us-atl-wg-001.mullvad.ts.net` splits into `[us, atl, wg, 001, mullvad, ts, net]`. So `ts us`, `ts atl`, `ts mullvad`, and `ts nas` all match by token. Token matching is why `ts us` means USA and not Australia (which contains "us" as a substring).
2. **Country** — exact (`finland`, `usa`) or word (`republic` → Czech Republic).
3. **City** — substring (`helsinki`, `atlanta`, `los angeles`).

### Cycling

Each query remembers its last selection in `~/.config/ts/exit-node-cycle`. Re-running the same query advances to the next matching node and wraps around. One-node countries (like Finland) are idempotent.

### Env knobs

| Var | Default | Purpose |
| --- | --- | --- |
| `TS_SOCKS_SCHEME` | `socks5` | Use `socks5h` for remote DNS (MagicDNS names resolve through the proxy) |
| `TS_SOCKS_HOST` / `TS_SOCKS_PORT` | `127.0.0.1` / `1055` | The tailscale SOCKS5 proxy |
| `TS_HTTP_PORT` | `1055` | The tailscale HTTP proxy |

## How it works

- **Proxied shell:** `ts` exports `ALL_PROXY=socks5://127.0.0.1:1055`, `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:1055`, `NO_PROXY=localhost,127.0.0.1,::1`, and `NODE_USE_ENV_PROXY=1` (Node ≥ 24), then `exec`s a login shell. Every `curl` / `git` / `npm` / `pip` / `go` / `brew` and Node app egresses through the current exit node.
- **Exit-node picker:** parses `tailscale exit-node list`, dedupes Mullvad's "Any" + named-city duplicate rows (the same node listed twice), matches your query, and calls `tailscale set --exit-node=<host>`. The status label parses columns by 2+ spaces so a multi-word status like `selected but offline, last seen 14h ago` stays one field — and is shown when a node isn't healthy, so you know to cycle again.
- **MagicDNS caveat:** under userspace networking, `100.100.100.100` is NOT reachable from the host, so do not point system DNS there. MagicDNS names resolve only when the proxied client does *remote* DNS (`TS_SOCKS_SCHEME=socks5h`), or via `tailscale ssh` / `tailscale nc` / `tailscale ping` (which talk to the daemon directly). Go-built CLIs only grok `socks5`, not `socks5h`.
- **In-shell `ssh` & `ping` (MagicDNS without system DNS):** `ts` also shadows `ssh` and `ping` on `PATH` with small wrappers. Inside the env shell, `ssh <node>` reaches tailnet hosts via `tailscale nc` — the daemon resolves the MagicDNS name, so no system DNS and no hardcoded IP — and your `~/.ssh/config` is `Include`d so your `Host` aliases and `User` settings still apply. Only tailnet hosts (`100.64.0.0/10` IPs, or names `tailscale ip` resolves) are wrapped; public hosts pass through untouched. `ping <node>` routes to `tailscale ping` for tailnet hosts (ICMP can't reach `100.x` under userspace networking) and to the real `ping` otherwise.

## Caveats

- Cycling is in `tailscale exit-node list` order — **not** latency-sorted. If you land on an offline node (the label says `selected but offline`), just run the query again. True "nearest" would need `tailscale ping` per candidate (not implemented).
- The `ts` name shadows moreutils' `ts` (a timestamp-prefixing filter). Fine as long as `~/.local/bin` is early in your `PATH`.
- The launchd installer is macOS-only; `ts` itself is platform-agnostic and works anywhere `tailscaled` runs in userspace mode.
- The in-shell `ssh` wrapper applies `BatchMode yes` to tailnet hosts (avoids auth-method hangs against Tailscale SSH). Override with `ssh -o BatchMode=no <node>` if a tailnet host needs a password. If your tailnet's Tailscale SSH policy requires a browser "check", the first connection prints a `login.tailscale.com/a/…` URL to approve in a browser — that's a tailnet ACL setting (`ssh` `checkPeriod`), not `ts`.

## License

MIT
