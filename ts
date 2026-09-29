#!/bin/zsh
# ts — proxied login shell through tailscaled's userspace SOCKS5/HTTP proxy
# (127.0.0.1:1055), egressing via the selected exit node (Mullvad or your own
# relay). Also a quick exit-node picker: `ts finland` selects + cycles.
#
# MagicDNS: under userspace networking, 100.100.100.100 is NOT reachable from
# the host — do NOT point system DNS there. MagicDNS names resolve only when
# the client uses the HTTP proxy or SOCKS with remote DNS (socks5h), or via
# `tailscale ssh`/`tailscale nc`/`tailscale ping <node>` (they talk to the
# daemon directly). SOCKS scheme support depends on the client.

set -eu

TS_SOCKS_HOST="${TS_SOCKS_HOST:-127.0.0.1}"
TS_SOCKS_HOST="${TS_SOCKS_HOST#\[}"
TS_SOCKS_HOST="${TS_SOCKS_HOST%\]}"
TS_SOCKS_PORT="${TS_SOCKS_PORT:-1055}"
TS_HTTP_PORT="${TS_HTTP_PORT:-1055}"
# HTTP is dependency-free for clients that eagerly initialize ALL_PROXY (HTTPX).
# An explicit legacy TS_SOCKS_SCHEME still opts into SOCKS.
TS_ALL_PROXY_SCHEME="${TS_ALL_PROXY_SCHEME:-${TS_SOCKS_SCHEME:-http}}"
TS_STATE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ts"
TS_STATE_FILE="$TS_STATE_DIR/exit-node-cycle"
TS_SCRIPT_DIR="${0:A:h}"

preflight() {
  local port failed=0
  local -a ports
  ports=("$TS_SOCKS_PORT" "$TS_HTTP_PORT")
  typeset -U ports
  for port in "${ports[@]}"; do
    if ! nc -z -w 2 "$TS_SOCKS_HOST" "$port" 2>/dev/null; then
      echo "ts: proxy endpoint unavailable: ${TS_SOCKS_HOST}:${port}" >&2
      failed=1
    fi
  done
  if (( failed )); then
    echo "  check tailscaled's userspace SOCKS5 and HTTP listeners." >&2
    echo "  (install: https://github.com/monotykamary/tailscale-shell#install)" >&2
  fi
  return "$failed"
}

proxy_url() {
  local host="$TS_SOCKS_HOST"
  [[ "$host" == *:* && "$host" != \[*\] ]] && host="[$host]"
  printf '%s://%s:%s\n' "$1" "$host" "$2"
}

doctor() {
  local failed=0 label endpoint result
  local url="${TS_DOCTOR_URL:-https://api.ipify.org}"
  preflight || failed=1
  if [[ "${1:-}" == "--local" ]]; then
    echo "ts: listener checks only; no protocol, DNS, or egress verification."
    return "$failed"
  fi
  if [[ -n "${1:-}" ]]; then
    echo "usage: ts doctor [--local]" >&2
    return 2
  fi
  if [[ "$url" != https://* ]]; then
    echo "ts: TS_DOCTOR_URL must be an HTTPS URL returning the client IP." >&2
    return 2
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "ts: doctor needs curl for protocol, DNS, and egress checks." >&2
    return 1
  fi
  echo "ts: checking HTTPS via both proxies (proxy-side DNS): $url"
  for label in HTTP SOCKS5; do
    if [[ "$label" == HTTP ]]; then
      endpoint="$(proxy_url http "$TS_HTTP_PORT")"
    else
      endpoint="$(proxy_url socks5h "$TS_SOCKS_PORT")"
    fi
    if result="$(curl -q --fail --silent --show-error --connect-timeout 5 \
        --max-time 15 --max-filesize 4096 --proxy "$endpoint" --noproxy '' "$url" 2>&1)"; then
      if [[ -n "$result" && "$result" != *[^0-9a-fA-F:.]* && ( "$result" == *.* || "$result" == *:* ) ]]; then
        printf 'PASS %s: HTTPS + proxy DNS; observed egress %s\n' "$label" "$result"
      else
        printf 'FAIL %s: endpoint did not return an IP address\n' "$label" >&2
        failed=1
      fi
    else
      printf 'FAIL %s: %s\n' "$label" "$result" >&2
      failed=1
    fi
  done
  echo "  selected exit node: $(current_exit_node 2>/dev/null || echo unavailable)"
  echo "  SOCKS clients using socks5 may resolve locally; use socks5h when supported."
  echo "  These forced-proxy checks bypass NO_PROXY; they do not certify every app."
  echo "  No direct-egress request was made. ts is not a fail-closed VPN."
  return "$failed"
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
  ts doctor           verify HTTP/SOCKS, proxy DNS, and public egress (uses curl)
  ts doctor --local   check listeners only; no external requests
  ts help             this help

Env knobs:
  TS_ALL_PROXY_SCHEME http (default) | socks5 | socks5h (remote DNS)
  TS_SOCKS_SCHEME     legacy alias; explicit TS_ALL_PROXY_SCHEME wins
  TS_SOCKS_HOST/PORT  defaults 127.0.0.1 / 1055
  TS_HTTP_PORT        default 1055
  NO_PROXY/no_proxy   existing exclusions merged with loopback defaults
  TS_DOCTOR_URL       HTTPS IP echo endpoint (default https://api.ipify.org)

Wrappers (inside the env shell — tailnet MagicDNS without system DNS):
  ssh <node>          tailnet hosts route via `tailscale nc` (MagicDNS resolved
                      by the daemon); public hosts use your ~/.ssh/config as-is.
                      Tailnet ssh is BatchMode by default (no password prompts);
                      override with `ssh -o BatchMode=no <node>`.
  scp / sftp          use the same SSH config (including tailnet aliases)
  ping <node>         tailnet hosts route via `tailscale ping` (ICMP can't reach
                      100.x under userspace networking); public hosts use ping.

Cycle state: ${XDG_CONFIG_HOME:-$HOME/.config}/ts/exit-node-cycle
EOF
}

enter_env_shell() {
  case "$TS_ALL_PROXY_SCHEME" in
    http|socks5|socks5h) ;;
    *) echo "ts: TS_ALL_PROXY_SCHEME must be http, socks5, or socks5h" >&2; return 2 ;;
  esac
  preflight
  if [[ "$TS_ALL_PROXY_SCHEME" == http ]]; then
    export ALL_PROXY="$(proxy_url http "$TS_HTTP_PORT")"
  else
    export ALL_PROXY="$(proxy_url "$TS_ALL_PROXY_SCHEME" "$TS_SOCKS_PORT")"
  fi
  export all_proxy="$ALL_PROXY"
  export HTTP_PROXY="$(proxy_url http "$TS_HTTP_PORT")"
  export HTTPS_PROXY="$HTTP_PROXY"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTPS_PROXY"
  local exclusions="localhost,127.0.0.1,::1,${NO_PROXY:-},${no_proxy:-}" entry
  local -a bypass
  typeset -U bypass
  for entry in "${(@s:,:)exclusions}"; do
    entry="${entry//[[:space:]]/}"
    [[ -n "$entry" ]] && bypass+=("$entry")
  done
  export NO_PROXY="${(j:,:)bypass}"
  export no_proxy="$NO_PROXY"
  export NODE_USE_ENV_PROXY=1
  export TS_ROUTED_VIA="tailscale-proxy:${TS_SOCKS_HOST}:${TS_HTTP_PORT}"
  echo "ts: env mode — $ALL_PROXY  (HTTP_PROXY=$HTTP_PROXY)" >&2
  [ "$TS_ALL_PROXY_SCHEME" = "socks5h" ] && echo "  (socks5h: remote DNS for clients that support this scheme)" >&2
  [[ ",$NO_PROXY," == *,\*,* ]] && echo "  warning: NO_PROXY=* permits direct connections for proxy-aware clients." >&2
  if [[ "${1:-}" != "skip-exit-node" ]]; then
    echo "  exit node: $(current_exit_node)" >&2
  fi
  # Resolve through previous wrapper directories too, so nested shells cannot recurse.
  local script_dir="$TS_SCRIPT_DIR" config_tmp
  export TS_SSH_REAL="$("$script_dir/ts.d/ts-real-command" ssh "${TS_SSH_REAL:-}" 2>/dev/null || true)"
  export TS_SCP_REAL="$("$script_dir/ts.d/ts-real-command" scp "${TS_SCP_REAL:-}" 2>/dev/null || true)"
  export TS_SFTP_REAL="$("$script_dir/ts.d/ts-real-command" sftp "${TS_SFTP_REAL:-}" 2>/dev/null || true)"
  export TS_PING_REAL="$("$script_dir/ts.d/ts-real-command" ping "${TS_PING_REAL:-}" 2>/dev/null || true)"
  mkdir -p "$TS_STATE_DIR"
  config_tmp="$(mktemp "$TS_STATE_DIR/ssh_config.v2.XXXXXXXX")"
  {
    echo '# generated by ts — user settings first, tailnet defaults on the final pass'
    echo 'Host *'
    if [ -f "$HOME/.ssh/config" ]; then printf 'Include "%s"\n' "$HOME/.ssh/config"; fi
    echo 'Host *'
    echo 'Include /etc/ssh/ssh_config'
    echo 'Match final exec "ts-ssh-match %h"'
    echo '    ProxyCommand tailscale nc %h %p'
    echo '    CheckHostIP no'
    echo '    BatchMode yes'
    echo '    ConnectTimeout 10'
    echo '    StrictHostKeyChecking accept-new'
    printf '    UserKnownHostsFile "%s"\n' "$TS_STATE_DIR/known_hosts"
    echo 'Match all'
  } > "$config_tmp"
  # Never truncate the legacy config used by already-running shells.
  mv -f "$config_tmp" "$TS_STATE_DIR/ssh_config.v2"
  export TS_SSH_CONFIG="$TS_STATE_DIR/ssh_config.v2"
  export PATH="$script_dir/ts.d:$PATH"
  echo "  ssh/scp/sftp/ping: tailnet hosts via daemon (ssh nas · ping nas)" >&2
  exec "${SHELL:-/bin/zsh}" -l
}

cmd="${1:-env}"
case "$cmd" in
  env|"") enter_env_shell ;;
  doctor) doctor "${2:-}" ;;
  status)
    preflight || exit 1
    echo "SOCKS5 listener ${TS_SOCKS_HOST}:${TS_SOCKS_PORT}; HTTP listener ${TS_SOCKS_HOST}:${TS_HTTP_PORT}"
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
