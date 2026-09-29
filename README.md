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
ts: env mode — http://127.0.0.1:1055  (HTTP_PROXY=http://127.0.0.1:1055)
  exit node: us-atl-wg-001.mullvad.ts.net · USA Atlanta, GA
  ssh/scp/sftp/ping: tailnet hosts via daemon (ssh nas · ping nas)
```

## Why

Tailscale's [userspace-networking](https://tailscale.com/kb/1282/userspace-networking) mode runs `tailscaled` without a system VPN extension — it exposes a local SOCKS5/HTTP proxy (`127.0.0.1:1055`) instead of a TUN interface. That sidesteps macOS SIP / VPN-extension limits and lets proxy-aware applications egress through your tailnet (and any Mullvad exit node) by setting proxy env vars. This is opt-in application routing, not a transparent or fail-closed VPN. But two things are missing out of the box:

1. **No shell integration** — you hand-set `ALL_PROXY` / `HTTPS_PROXY` every time.
2. **No quick exit-node picker** — `tailscale set --exit-node=<host>` means typing full hostnames like `us-atl-wg-001.mullvad.ts.net`.

`ts` fixes both: one command drops you into a proxied shell, and `ts <country|city|code>` selects + cycles exit nodes by a friendly name.

## Install

**One line** — clones the repo, symlinks `ts` onto `~/.local/bin`, and checks deps + the proxy:

```bash
curl -fsSL https://raw.githubusercontent.com/monotykamary/tailscale-shell/main/install.sh | bash
```

This installs `ts` but does **not** build tailscale or set up the daemon — that needs Go + `sudo`, so the installer detects whether the userspace proxy is up and prints the exact next command if not. (Overrides: `TS_INSTALL_DIR` / `TS_BIN_DIR`.) The steps below are what it automates, and how to do them by hand.

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

(Or add the repo to your `PATH`.) Requires `zsh`, `awk`, and an OpenBSD-compatible `nc` (macOS built-in or Linux `netcat-openbsd`). `jq` is optional for richer status output; `curl` is needed for `ts doctor`. SSH wrappers require OpenSSH with `Match final` support.

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
| `ts status` | Proxy listeners + current exit node health check |
| `ts doctor` | Verify HTTP CONNECT, SOCKS5, proxy DNS, and observed public egress |
| `ts doctor --local` | Listener checks only; no external requests |
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
| `TS_ALL_PROXY_SCHEME` | `http` | Scheme for `ALL_PROXY`: `http`, `socks5`, or `socks5h` (remote DNS) |
| `TS_SOCKS_SCHEME` | unset | Legacy scheme override, honored unless `TS_ALL_PROXY_SCHEME` is explicitly set |
| `TS_SOCKS_HOST` / `TS_SOCKS_PORT` | `127.0.0.1` / `1055` | The tailscale SOCKS5 proxy |
| `TS_HTTP_PORT` | `1055` | The tailscale HTTP proxy |
| `NO_PROXY` / `no_proxy` | Loopback hosts | Existing entries from both forms are merged and deduplicated, not discarded |
| `TS_DOCTOR_URL` | `https://api.ipify.org` | HTTPS endpoint returning the caller's IP; contacted only by `ts doctor` |

## How it works

- **Proxied shell:** `ts` defaults upper/lowercase `ALL_PROXY` and `HTTP(S)_PROXY` to the HTTP listener (HTTP CONNECT also carries HTTPS), merges existing upper/lowercase `NO_PROXY` with `localhost,127.0.0.1,::1`, and sets `NODE_USE_ENV_PROXY=1`, then `exec`s a login shell. Proxy-aware clients inherit these settings. Client configuration, custom transports, or shell startup files can override them; a successful request alone does not prove proxy use. `NO_PROXY=*` is preserved with a warning because it permits direct connections.
- **Exit-node picker:** parses `tailscale exit-node list`, dedupes Mullvad's "Any" + named-city duplicate rows (the same node listed twice), matches your query, and calls `tailscale set --exit-node=<host>`. The status label parses columns by 2+ spaces so a multi-word status like `selected but offline, last seen 14h ago` stays one field — and is shown when a node isn't healthy, so you know to cycle again.
- **MagicDNS caveat:** under userspace networking, `100.100.100.100` is NOT reachable from the host, so do not point system DNS there. The HTTP proxy resolves target names remotely. For explicit SOCKS mode, use `TS_ALL_PROXY_SCHEME=socks5h` when the client supports it; `socks5` DNS behavior varies by client. `HTTP(S)_PROXY` generally takes precedence over `ALL_PROXY`, so changing the SOCKS scheme does not change HTTP proxy routing. `tailscale ssh` / `tailscale nc` / `tailscale ping` resolve through the daemon directly.
- **SSH family:** `ssh`, `scp`, and `sftp` wrappers explicitly pass the generated SSH config, even when file-transfer tools launch `/usr/bin/ssh` directly. User and system SSH settings are loaded first; a `Match final` pass recognizes tailnet targets after `HostName` aliases resolve and supplies `tailscale nc` defaults. Explicit user `ProxyCommand`/`ProxyJump` settings take precedence. Public-host SSH retains its normal routing; it is **not automatically sent through the exit node**. A later `-F` deliberately overrides the generated config.
- **Nested shells and upgrades:** executable discovery skips current and older wrapper directories. New shells atomically generate `ssh_config.v2`; they never overwrite the legacy `ssh_config` still used by older shells. Existing sessions keep their environment and current SSH connections.
- **Ping:** tailnet targets use `tailscale ping` (daemon-specific flags); public targets use the real `ping`. SOCKS/HTTP proxies do not route ICMP.

## CLI compatibility

The offline suite checks **actual proxy traffic**, not just successful responses. Scope is the client's standard transport, not every program written in that language.

| Client / transport | Coverage or required action |
| --- | --- |
| curl | HTTP, HTTPS CONNECT, SOCKS5 remote DNS |
| Git over HTTP(S) | Environment proxy support; tested HTTP proxy adoption (not a complete clone) |
| Node native `fetch`, `http`, WebSocket | Tested on modern Node; use Node ≥24.5 or ≥22.21 in the 22.x line for native fetch environment support |
| Bun `fetch` | Tested HTTP proxy adoption |
| Python `urllib`, Requests, HTTPX | Tested HTTP / HTTPS proxy adoption; explicit client settings can override environment |
| Python `aiohttp` | Opt in with `aiohttp.ClientSession(trust_env=True)`; tested |
| Go `net/http` default transport | Tested HTTP proxy adoption; custom dialers/transports may ignore the environment |
| JVM HTTP clients | Use JVM proxy properties or library-specific configuration; tested with explicit properties |
| SSH / SCP / SFTP | Tailnet routing and aliases covered; explicit config overrides remain available |
| Node `http2.connect`, Python `http.client`, raw sockets | Do not automatically adopt this environment; use a proxy-capable transport or explicit tunnel |
| UDP / QUIC / arbitrary applications | Require a different routing mechanism, usually OS/TUN networking |

HTTP is the default `ALL_PROXY` fallback because clients such as HTTPX eagerly initialize SOCKS support even when `HTTPS_PROXY` takes precedence. This avoids requiring HTTPX's optional `socksio` dependency for ordinary HTTPS. To opt back into the older SOCKS fallback, use `TS_ALL_PROXY_SCHEME=socks5 ts` (or `socks5h`); an explicit legacy `TS_SOCKS_SCHEME` is still honored. HTTPX then needs `pip install 'httpx[socks]'`, and other clients may also require SOCKS extras.

Pi and Claude have worked in normal use, but their custom transports and future versions are not guaranteed by these runtime tests. npm, pip, brew, cloud CLIs, gRPC, and third-party WebSocket libraries also need testing with their actual configuration. Older Node applications need a supported proxy agent or a runtime upgrade; `NODE_USE_ENV_PROXY` cannot retrofit every client.

For a JVM client using standard HTTP proxy properties (adapt ports if configured differently):

```sh
java -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1055 \
     -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1055 \
     '-Dhttp.nonProxyHosts=localhost|127.*|[::1]' -jar app.jar
```

For public-host SSH through the exit node, opt in explicitly (OpenBSD netcat syntax; adjust the endpoint as needed):

```sh
ssh -o 'ProxyCommand=nc -X connect -x 127.0.0.1:1055 %h %p' user@public-host
```

`NO_PROXY` syntax is not standardized across clients (especially IPv6, CIDR, and wildcard handling). The defaults use unbracketed `::1`; bracketed `[::1]` entries break some HTTPX versions. Prefer `localhost` for portable local-service URLs and verify any custom bypass rules with the actual client.

There is no universal environment-only fix for clients that ignore proxies. Containers, `sudo`, and already-running daemons may not inherit this environment; a container also cannot reach the host proxy at its own `127.0.0.1`. Configure these explicitly rather than exposing the unauthenticated proxy on a public listener. For all-application or fail-closed routing, use OS/TUN networking and appropriate firewall policy.

## Diagnostics

`ts doctor` checks both configured listeners, then makes one HTTPS request through each proxy to `https://api.ipify.org`. The service sees the proxy's egress IP; no direct-egress comparison is sent. Override `TS_DOCTOR_URL` with your own HTTPS IP-echo service if preferred. TLS verification remains enabled.

The HTTP check exercises CONNECT and proxy-side DNS; the SOCKS check explicitly uses `socks5h`. Both ignore `NO_PROXY` **for these checks only**. Doctor prints each observed IP and the selected exit-node label, returns nonzero on failure, and does not change the exit node or daemon. It does not prove a specific CLI used the proxy or that the public IP belongs to the intended exit node. Use `ts doctor --local` for listener-only checks without external requests.

## Tests and safe updates

Run `sh tests/run.sh` with Python 3.9+, OpenSSL, curl, Git, OpenSSH, and zsh. ShellCheck is used when installed. Node, Bun, Go, Java (JDK 11+), and Python Requests/HTTPX/aiohttp probes run when available; missing optional clients are reported as skips. CI installs those clients and runs on macOS/Linux with Node 22/24. Tests use temporary homes, generated test certificates, recording loopback proxies, and a mocked Tailscale daemon. No credentials, public IP service, or exit-node changes are needed.

Updating the shell does not require restarting `tailscaled` or closing terminals. The installer replaces the `ts` link atomically. Existing processes keep their environment; open a fresh `ts` shell (or nest `ts` when convenient) to pick up the new exclusions and generated config. Do not delete an old checkout while active shells still have its `ts.d` directory on `PATH`.

## Caveats

- Exit-node selection is daemon-wide, not per terminal: `ts <query>` and `ts off` affect every session using that daemon. Updates and `ts doctor` never change it.
- Cycling is in `tailscale exit-node list` order — **not** latency-sorted. If you land on an offline node (the label says `selected but offline`), just run the query again. True "nearest" would need `tailscale ping` per candidate (not implemented).
- The `ts` name shadows moreutils' `ts` (a timestamp-prefixing filter). Fine as long as `~/.local/bin` is early in your `PATH`.
- The launchd installer is macOS-only; `ts` itself is platform-agnostic and works anywhere `tailscaled` runs in userspace mode.
- The in-shell `ssh` wrapper applies `BatchMode yes` to tailnet hosts (avoids auth-method hangs against Tailscale SSH). Override with `ssh -o BatchMode=no <node>` if a tailnet host needs a password. If your tailnet's Tailscale SSH policy requires a browser "check", the first connection prints a `login.tailscale.com/a/…` URL to approve in a browser — that's a tailnet ACL setting (`ssh` `checkPeriod`), not `ts`.

## License

MIT
