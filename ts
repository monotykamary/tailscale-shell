#!/bin/zsh
# ts — proxied login shell through tailscaled's userspace SOCKS5/HTTP proxy
# (127.0.0.1:1055), egressing via the selected exit node (Mullvad or your own
# relay). Also a quick exit-node picker: `ts finland` selects + cycles.
#
# MagicDNS: under userspace networking, 100.100.100.100 is NOT reachable from
# the host — do NOT point system DNS there. MagicDNS names resolve only when
# the proxied client does *remote* DNS (TS_SOCKS_SCHEME=socks5h), or via
# `tailscale ssh`/`tailscale nc`/`tailscale ping <node>` (they talk to the
# daemon directly). Go-built CLIs only grok socks5, not socks5h.

set -eu

TS_SOCKS_HOST="${TS_SOCKS_HOST:-127.0.0.1}"
TS_SOCKS_PORT="${TS_SOCKS_PORT:-1055}"
TS_HTTP_PORT="${TS_HTTP_PORT:-1055}"
TS_SOCKS_SCHEME="${TS_SOCKS_SCHEME:-socks5}"
TS_STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ts"
TS_STATE_FILE="$TS_STATE_DIR/exit-node-cycle"
TS_SCRIPT_DIR="${0:A:h}"

preflight() {
  if ! nc -z -G1 "$TS_SOCKS_HOST" "$TS_SOCKS_PORT" 2>/dev/null; then
    echo "ts: nothing is listening on ${TS_SOCKS_HOST}:${TS_SOCKS_PORT}." >&2
    echo "  start tailscaled, e.g.:" >&2
    echo "    sudo launchctl kickstart -k system/com.tailscale.tailscaled-userspace" >&2
    echo "  (install: https://github.com/monotykamary/tailscale-shell#install)" >&2
    return 1
  fi
}

current_exit_node() {
  local json exitip row
  if ! command -v jq >/dev/null 2>&1; then
    row="$(tailscale exit-node list 2>/dev/null | awk '$0 ~ /[Ss]elected/')"
    printf '%s\n' "${row:-none}"
    return
  fi
  json="$(tailscale status --json 2>/dev/null)"
  exitip="$(printf '%s' "$json" | jq -r '.ExitNodeStatus.TailscaleIPs[0] // empty' | sed 's#/32##')"
  if [ -z "$exitip" ]; then
    printf 'none  (tailnet direct; set one: ts <country|city|code>)\n'
    return
  fi
  # Match by IP; Mullvad lists "Any" + named-city rows for the same IP, so keep
  # the named-city row. Parse columns by 2+ spaces so a multi-word status (e.g.
  # "selected but offline, last seen 14h ago") stays one field instead of
  # bleeding into the city.
  row="$(tailscale exit-node list 2>/dev/null | awk -v ip="$exitip" '
    {
      line = $0; sub(/^[ ]+/, "", line)
      if (line == "" || line ~ /^#/ || line ~ /^IP[ ]/) next
      gsub(/[ ]{2,}/, "\t", line)
      n = split(line, f, "\t")
      if (n < 4 || f[1] != ip) next
      rows[++count] = f[2] "\t" f[3] "\t" f[4] "\t" (n >= 5 ? f[5] : "-")
      if (f[4] != "Any" && !named) named = count
    }
    END {
      if (named) print rows[named]
      else if (count > 0) print rows[1]
    }
  ')"
  if [ -z "$row" ]; then
    printf '%s\n' "$exitip"
    return
  fi
  local host country city nodestatus
  IFS=$'\t' read -r host country city nodestatus <<< "$row"
  if [ "$country" = "-" ] || [ "$city" = "-" ]; then
    if [ -n "$nodestatus" ] && [ "$nodestatus" != "selected" ] && [ "$nodestatus" != "-" ]; then
      printf '%s  ·  %s\n' "$host" "$nodestatus"
    else
      printf '%s\n' "$host"
    fi
  elif [ -n "$nodestatus" ] && [ "$nodestatus" != "selected" ] && [ "$nodestatus" != "-" ]; then
    printf '%s  ·  %s %s  ·  %s\n' "$host" "$country" "$city" "$nodestatus"
  else
    printf '%s  ·  %s %s\n' "$host" "$country" "$city"
  fi
}

# Emit available exit nodes as TSV: hostname<TAB>country<TAB>city.
# Dedupes by hostname (Mullvad lists "Any" + named-city rows for the same node;
# we keep the named city) and preserves `tailscale exit-node list` order so
# query cycling is stable.
exit_node_rows() {
  tailscale exit-node list 2>/dev/null | awk '
    {
      line = $0
      sub(/^[ ]+/, "", line)
      if (line == "" || line ~ /^#/ || line ~ /^IP[ ]/) next
      gsub(/[ ]{2,}/, "\t", line)
      n = split(line, f, "\t")
      if (n < 4) next
      host = f[2]; country = f[3]; city = f[4]
      if (!(host in seen)) {
        seen[host] = 1
        order[++nhosts] = host
        ctry[host] = country; cty[host] = city; any[host] = (city == "Any")
      } else if (any[host] && city != "Any") {
        ctry[host] = country; cty[host] = city; any[host] = 0
      }
    }
    END {
      for (i = 1; i <= nhosts; i++) {
        h = order[i]
        printf "%s\t%s\t%s\n", h, ctry[h], cty[h]
      }
    }
  '
}

# Print matching hostnames (one per line) for a query against the given rows.
# Case-insensitive, priority: hostname token > country (exact/word) > city.
match_nodes() {
  local q="${1:l}" rows="$2"
  local host country city tokens lc_country lc_city
  print -r -- "$rows" | while IFS=$'\t' read -r host country city; do
    tokens="${host:l}"
    tokens="${tokens//[-.]/ }"
    tokens=" $tokens "
    lc_country="${country:l}"; lc_city="${city:l}"
    if [[ $tokens == *" $q "* ]] \
       || [[ $lc_country == "$q" ]] \
       || [[ " ${=lc_country} " == *" $q "* ]] \
       || [[ $lc_city == *"$q"* ]]; then
      print -r -- "$host"
    fi
  done
}

select_exit_node() {
  local query="$1" all_rows
  all_rows="$(exit_node_rows)"
  if [[ -z "$all_rows" ]]; then
    echo "ts: tailscale exit-node list returned nothing — is tailscaled running?" >&2
    echo "  start it: sudo launchctl kickstart -k system/com.tailscale.tailscaled-userspace" >&2
    return 1
  fi
  local matched
  matched="$(match_nodes "$query" "$all_rows")"
  if [[ -z "$matched" ]]; then
    echo "ts: no exit node matched '$query'." >&2
    echo "  try: ts status   ·   tailscale exit-node list" >&2
    return 1
  fi
  local -a matches
  matches=("${(@f)matched}")
  local n=${#matches[@]} last="" idx=1 i
  if [[ -f "$TS_STATE_FILE" ]]; then
    last="$(awk -v q="$query" -F'\t' '$1==q {print $2; exit}' "$TS_STATE_FILE" 2>/dev/null)"
  fi
  if [[ -n "$last" ]]; then
    for ((i=1; i<=n; i++)); do
      if [[ "${matches[i]}" == "$last" ]]; then
        idx=$(( (i % n) + 1 ))
        break
      fi
    done
  fi
  local next="${matches[idx]}" err
  if ! err="$(tailscale set --exit-node="$next" 2>&1)"; then
    echo "ts: failed to set exit node '$next':" >&2
    printf '%s\n' "$err" >&2
    return 1
  fi
  mkdir -p "$TS_STATE_DIR"
  if [[ ! -f "$TS_STATE_FILE" ]]; then
    printf '%s\t%s\n' "$query" "$next" > "$TS_STATE_FILE"
  else
    local tmp; tmp="$(mktemp)"
    awk -v q="$query" -v v="$next" -F'\t' -v OFS='\t' '
      $1==q { $2=v; found=1 } { print } END { if (!found) print q, v }
    ' "$TS_STATE_FILE" > "$tmp" && mv "$tmp" "$TS_STATE_FILE"
  fi
  echo "ts: exit node → $(current_exit_node)" >&2
  if (( n > 1 )); then
    echo "  ($n matches for '$query'; run 'ts $query' again to cycle)" >&2
  fi
}

clear_exit_node() {
  local err
  if ! err="$(tailscale set --exit-node= 2>&1)"; then
    echo "ts: failed to clear exit node:" >&2
    printf '%s\n' "$err" >&2
    return 1
  fi
  echo "ts: exit node cleared (direct tailnet egress)" >&2
  echo "  now: $(current_exit_node)" >&2
}

show_help() {
  cat <<'EOF'
ts — proxied shell + exit-node picker

Usage:
  ts                  env-proxy mode (default): proxied login shell via the
                      tailscale socks5/http proxy (127.0.0.1:1055). Egresses
                      through the current exit node.
  ts <query>          select an exit node by country / city / code / hostname
                      token; re-run the same query to cycle to the next match
                      (wraps around). From a normal shell this also drops you
                      into the proxied env shell; from inside a `ts` shell it
                      just cycles the node (no re-exec). Examples:
                        ts finland      # Finland (Helsinki — 1 node, idempotent)
                        ts usa          # USA; repeat to walk all US cities
                        ts atl          # Atlanta (city-code token)
                        ts helsinki     # Helsinki (city name)
                        ts "los angeles"
                        ts nas          # your own relay (hostname token)
                        ts mullvad      # any Mullvad node
  ts off              clear the exit node (direct tailnet egress)
  ts status           proxy + current exit node health check
  ts help             this help

Env knobs:
  TS_SOCKS_SCHEME     socks5 (default) | socks5h (remote DNS for MagicDNS)
  TS_SOCKS_HOST/PORT  defaults 127.0.0.1 / 1055
  TS_HTTP_PORT        default 1055

Wrappers (inside the env shell — tailnet MagicDNS without system DNS):
  ssh <node>          tailnet hosts route via `tailscale nc` (MagicDNS resolved
                      by the daemon); public hosts use your ~/.ssh/config as-is.
                      Tailnet ssh is BatchMode by default (no password prompts);
                      override with `ssh -o BatchMode=no <node>`.
  ping <node>         tailnet hosts route via `tailscale ping` (ICMP can't reach
                      100.x under userspace networking); public hosts use ping.

Cycle state: ${XDG_CONFIG_HOME:-$HOME/.config}/ts/exit-node-cycle
EOF
}

enter_env_shell() {
  preflight
  export ALL_PROXY="${TS_SOCKS_SCHEME}://${TS_SOCKS_HOST}:${TS_SOCKS_PORT}"
  export all_proxy="$ALL_PROXY"
  export HTTP_PROXY="http://${TS_SOCKS_HOST}:${TS_HTTP_PORT}"
  export HTTPS_PROXY="$HTTP_PROXY"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTPS_PROXY"
  export NO_PROXY="localhost,127.0.0.1,::1"
  export no_proxy="$NO_PROXY"
  export NODE_USE_ENV_PROXY=1
  export TS_ROUTED_VIA="tailscale-socks5:${TS_SOCKS_HOST}:${TS_SOCKS_PORT}"
  echo "ts: env mode — $ALL_PROXY  (HTTP_PROXY=$HTTP_PROXY)" >&2
  [ "$TS_SOCKS_SCHEME" = "socks5h" ] && echo "  (socks5h: curl/python/git resolve MagicDNS remotely; Go CLIs may not grok socks5h)" >&2
  if [[ "${1:-}" != "skip-exit-node" ]]; then
    echo "  exit node: $(current_exit_node)" >&2
  fi
  # wrap ssh/ping so tailnet MagicDNS hosts resolve via the daemon (no system DNS)
  local script_dir="$TS_SCRIPT_DIR"
  export TS_SSH_REAL="$(command -v ssh || echo /usr/bin/ssh)"
  export TS_PING_REAL="$(command -v ping || echo /sbin/ping)"
  mkdir -p "$TS_STATE_DIR"
  {
    echo "# generated by ts — proxied ssh for tailnet MagicDNS hosts (no system DNS)"
    echo 'Match exec "ts-ssh-match %h"'
    echo "    ProxyCommand tailscale nc %h %p"
    echo "    CheckHostIP no"
    echo "    BatchMode yes"
    echo "    ConnectTimeout 10"
    echo "    StrictHostKeyChecking accept-new"
    echo "    UserKnownHostsFile $TS_STATE_DIR/known_hosts"
    if [ -f "$HOME/.ssh/config" ]; then echo "Include $HOME/.ssh/config"; fi
  } > "$TS_STATE_DIR/ssh_config"
  export TS_SSH_CONFIG="$TS_STATE_DIR/ssh_config"
  export PATH="$script_dir/ts.d:$PATH"
  echo "  ssh/ping: tailnet hosts via daemon (ssh nas · ping nas)" >&2
  exec "${SHELL:-/bin/zsh}" -l
}

cmd="${1:-env}"
case "$cmd" in
  env|"") enter_env_shell ;;
  status)
    preflight && echo "socks5/http proxy UP on ${TS_SOCKS_HOST}:${TS_SOCKS_PORT}"
    echo "--- exit node (current) ---"; current_exit_node
    echo "--- tailscale status ---"; tailscale status 2>&1 | head -5
    echo "--- exit node suggest ---"; tailscale exit-node suggest 2>&1 | head -5
    ;;
  off) clear_exit_node ;;
  -h|--help|help) show_help ;;
  *)
    select_exit_node "$*" || exit 1
    if [[ -z "${TS_ROUTED_VIA:-}" ]]; then
      enter_env_shell skip-exit-node
    fi
    ;;
esac
