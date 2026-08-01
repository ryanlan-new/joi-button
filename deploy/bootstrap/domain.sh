# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Step 2 of the deploy bootstrap: the hostname the site is served on, and the
# DNS record that points at it.
#
# ===========================================================================
# THE SITE IS HOST-SCOPED, AND THAT IS THE WHOLE POINT
# ===========================================================================
# joi-button is reached through a k3s Ingress whose `host:` is exactly the name
# collected here. Traefik — the one shared ingress controller — routes ONLY that
# Host to this service; every other host on the node (grafana, api-docs, whatever
# else) keeps going to its own Ingress. joi-button's two Services are ClusterIP,
# so they bind no host port and never touch the loopback; the only listener on
# the node's :80/:443 is the shared traefik, and it dispatches by Host header
# (by SNI for TLS). So:
#
#   * Use a SUBDOMAIN — joi-button.example.com — not the apex. Nothing here wants
#     or takes the apex, and a subdomain is what keeps this one service in its
#     lane.
#   * Deploying this cannot shadow or capture another service on the cluster. It
#     adds one host rule; it removes nothing.
#
# This step writes APP_HOST (and the address DNS should point at) into
# deploy/deploy.env, the file deploy-k3s.sh and the later steps read.

# Reuses the io helpers from collect-env.sh (section/note/ask/confirm_yes and the
# fd-3 tty), which bootstrap.sh sources first.

# A very small FQDN sanity check: at least two labels, letters/digits/hyphen/dot.
looks_like_fqdn() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]
}

# "example.com" (apex) has one dot between two labels; "a.example.com" has two.
# Not a hard block — an operator may know what they are doing — but a warning,
# because the apex is exactly what this deploy was built NOT to take.
looks_like_apex() {
  [[ "$(grep -o '\.' <<<"$1" | wc -l | tr -d ' ')" == "1" ]]
}

# Resolve a name to its A/AAAA answers, portably. Prints one address per line.
resolve_host() {
  local host="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short "$host" A "$host" AAAA 2>/dev/null | grep -E '^[0-9a-fA-F:.]+$' || true
  elif command -v getent >/dev/null 2>&1; then
    getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u || true
  else
    # macOS without dig: nslookup, stripping its noise.
    nslookup "$host" 2>/dev/null | awk '/^Address: /{print $2}' || true
  fi
}

collect_domain() {
  local deploy_env="${DEPLOY_ENV:-$REPO_ROOT/deploy/deploy.env}"
  open_tty
  trap close_tty RETURN

  section 'Domain — the hostname this site answers on'
  note 'joi-button is routed by Host: only requests for THIS name reach it, and'
  note 'nothing else on the cluster is affected. Use a subdomain, not the apex.'
  echo >&2

  ask APP_HOST 'Hostname (e.g. joi-button.example.com)' "${APP_HOST:-}"
  [[ -n "$APP_HOST" ]] || die 'a hostname is required'
  if ! looks_like_fqdn "$APP_HOST"; then
    die "'$APP_HOST' does not look like a hostname"
  fi
  if looks_like_apex "$APP_HOST"; then
    note "WARNING: '$APP_HOST' looks like an apex domain. A subdomain keeps this"
    note 'service in its own lane; the apex is usually your main site. Continue only'
    note 'if you really mean to serve joi-button at the apex.'
    confirm_yes "Use '$APP_HOST' anyway?" || die 'aborted — re-run and give a subdomain'
  fi

  # The address DNS should point at. Default to the node's own outward address if
  # we can see it over ssh; the operator overrides for a public deployment where
  # the record must point at a public IP / load balancer rather than the node.
  local detected=''
  if [[ -n "${REMOTE:-}" ]]; then
    detected="$(ssh -n "$REMOTE" \
      "ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i==\"src\"){print \$(i+1); exit}}'" \
      2>/dev/null || true)"
  fi
  note 'This is the IP the DNS record must resolve to — the node itself on a LAN,'
  note 'or your public IP / load-balancer address for a public deployment.'
  ask TARGET_ADDR 'Address this hostname should point to' "${TARGET_ADDR:-$detected}"
  [[ -n "$TARGET_ADDR" ]] || die 'a target address is required'

  section 'DNS record to create'
  note "Add this at your DNS provider (A for IPv4, AAAA for IPv6):"
  echo >&2
  printf '      %s.\tA\t%s\n' "$APP_HOST" "$TARGET_ADDR" >&2
  echo >&2
  note 'On a LAN with no DNS server, a hosts entry on each client works too:'
  printf '      %s\t%s\n' "$TARGET_ADDR" "$APP_HOST" >&2
  echo >&2

  verify_dns_loop

  persist_site_env "$deploy_env"
  close_tty
  trap - RETURN
  section "Recorded APP_HOST=$APP_HOST in $deploy_env"
}

# Offers to check resolution now, and loops until it matches or the operator
# chooses to go on. Never blocks hard: DNS can lag, and the later steps surface a
# name that resolves nowhere clearly enough on their own.
verify_dns_loop() {
  while true; do
    if ! confirm_yes 'Check that the name resolves now?'; then
      note 'Skipping the check. Make sure the record exists before the TLS step,'
      note 'especially for Let'\''s Encrypt, which proves control over this exact name.'
      return 0
    fi
    local answers
    answers="$(resolve_host "$APP_HOST")"
    if [[ -z "$answers" ]]; then
      note "$APP_HOST does not resolve yet."
    elif grep -qxF "$TARGET_ADDR" <<<"$answers"; then
      note "OK: $APP_HOST resolves to $TARGET_ADDR."
      return 0
    else
      note "$APP_HOST resolves, but not to $TARGET_ADDR:"
      while IFS= read -r a; do [[ -n "$a" ]] && printf '        %s\n' "$a" >&2; done <<<"$answers"
    fi
    confirm_yes 'Wait and check again?' || return 0
    sleep 3
  done
}

# APP_HOST / TARGET_ADDR persisted WITHOUT disturbing REMOTE and other lines the
# operator already put in deploy.env. Rewrites just these two keys.
persist_site_env() {
  local file="$1"
  ( umask 077; touch "$file" )
  local tmp="$file.tmp.$$"
  ( umask 077; : >"$tmp" )
  # keep every line that is not one of the two keys we own
  grep -vE '^(APP_HOST|TARGET_ADDR)=' "$file" >>"$tmp" 2>/dev/null || true
  printf 'APP_HOST=%s\n' "$APP_HOST" >>"$tmp"
  printf 'TARGET_ADDR=%s\n' "$TARGET_ADDR" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}
