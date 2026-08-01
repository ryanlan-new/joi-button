# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Step 4 of the deploy bootstrap: which TLS, and its inputs. The WIRING differs
# by target and happens at apply time — on k3s a cert-manager Issuer + the
# Ingress tls block, or a kubectl TLS secret; with Docker the compose override —
# but the CHOICE and its parameters are the same either way and are collected
# here into deploy/deploy.env:
#
#   TLS_MODE=letsencrypt   ACME_EMAIL=...
#   TLS_MODE=own-cert      CERT_FILE=... KEY_FILE=...
#
# The site is served over HTTPS in every real deployment — its session cookie is
# Secure and is dropped over plain http, so http is a login that silently never
# completes. That is why there is no "no TLS" option here for production; a dev
# machine that genuinely wants http runs the app directly, not through this.

# Uses the io helpers (section/note/ask/ask_secret/confirm_yes) and fd 3 from
# collect-env.sh, and `die` from bootstrap.sh.

choose_tls() {
  local deploy_env="${DEPLOY_ENV:-$REPO_ROOT/deploy/deploy.env}"
  open_tty
  trap close_tty RETURN

  section 'TLS — how this site gets its certificate'
  note '[1] Let'\''s Encrypt  — free, auto-issued and auto-renewed. Needs the'
  note '    hostname to be PUBLIC, resolve to this host, and be reachable on :80'
  note '    (that is how Let'\''s Encrypt proves you control it).'
  note '[2] Your own certificate — you supply the cert and key files. No'
  note '    auto-renewal; the self-check warns when it nears expiry.'

  local choice
  while true; do
    read -r -u 3 -p '  Choose [1] Let'\''s Encrypt  [2] own cert : ' choice || true
    case "$choice" in
      1) TLS_MODE=letsencrypt; break ;;
      2) TLS_MODE=own-cert;    break ;;
    esac
  done

  if [[ "$TLS_MODE" == letsencrypt ]]; then
    note 'Let'\''s Encrypt emails expiry notices and account alerts to this address.'
    ask ACME_EMAIL 'Email for Let'\''s Encrypt' "${ACME_EMAIL:-}"
    [[ "$ACME_EMAIL" == *@*.* ]] || die 'a valid email is required for Let'\''s Encrypt'
    CERT_FILE=''; KEY_FILE=''
  else
    ask CERT_FILE 'Path to the certificate (fullchain PEM)' "${CERT_FILE:-}"
    ask KEY_FILE  'Path to the private key (PEM)' "${KEY_FILE:-}"
    validate_own_cert
    ACME_EMAIL=''
  fi

  persist_tls_env "$deploy_env"
  close_tty; trap - RETURN
  section "TLS mode: $TLS_MODE"
}

# The certificate must exist, cover APP_HOST, be unexpired, and match its key —
# each checked here, where the operator can fix it, rather than at apply time
# where the failure is Traefik quietly serving the wrong thing.
validate_own_cert() {
  command -v openssl >/dev/null 2>&1 || { note 'openssl not found — skipping cert checks (they are advisory).'; return 0; }
  [[ -r "$CERT_FILE" ]] || die "certificate not readable: $CERT_FILE"
  [[ -r "$KEY_FILE"  ]] || die "key not readable: $KEY_FILE"

  openssl x509 -in "$CERT_FILE" -noout >/dev/null 2>&1 || die "$CERT_FILE is not a PEM certificate"

  # Expiry — hard, but overridable (an operator may be staging a not-yet-valid one).
  if ! openssl x509 -in "$CERT_FILE" -noout -checkend 0 >/dev/null 2>&1; then
    note 'WARNING: this certificate is already expired.'
    confirm_yes 'Use it anyway?' || die 'aborted — supply a current certificate'
  fi

  # Host coverage — SAN, honouring a wildcard parent.
  if [[ -n "${APP_HOST:-}" ]] && ! cert_covers_host "$CERT_FILE" "$APP_HOST"; then
    note "WARNING: the certificate does not appear to cover $APP_HOST."
    note 'Its names:'; cert_names "$CERT_FILE" | while IFS= read -r n; do [[ -n "$n" ]] && printf '        %s\n' "$n" >&2; done
    confirm_yes 'Use it anyway?' || die "aborted — the cert must cover $APP_HOST"
  fi

  # Key ↔ cert — compare public keys, which works for RSA and EC alike. A
  # mismatch is a hard stop: Traefik would fail to load the pair.
  local cpk kpk
  cpk="$(openssl x509 -in "$CERT_FILE" -noout -pubkey 2>/dev/null | openssl md5 2>/dev/null || true)"
  kpk="$(openssl pkey -in "$KEY_FILE" -pubout 2>/dev/null | openssl md5 2>/dev/null || true)"
  if [[ -z "$cpk" || -z "$kpk" || "$cpk" != "$kpk" ]]; then
    die 'the private key does not match the certificate (their public keys differ)'
  fi
  note 'Certificate checks passed: covers the host, unexpired, matches its key.'
}

# The DNS names a certificate carries: SANs preferred, CN as a fallback.
cert_names() {
  local san
  san="$(openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null \
        | tr ',' '\n' | sed -n 's/.*DNS://p' | tr -d ' ')"
  if [[ -n "$san" ]]; then
    printf '%s\n' "$san"
  else
    openssl x509 -in "$1" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p'
  fi
}

# Does a cert's names cover `host`, exact or via a one-level wildcard?
cert_covers_host() {
  local file="$1" host="$2" name parent
  parent="${host#*.}"
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    [[ "$name" == "$host" ]] && return 0
    [[ "$name" == "*.$parent" ]] && return 0
  done < <(cert_names "$file")
  return 1
}

persist_tls_env() {
  local file="$1"
  ( umask 077; touch "$file" )
  local tmp="$file.tmp.$$"
  ( umask 077; : >"$tmp" )
  grep -vE '^(TLS_MODE|ACME_EMAIL|CERT_FILE|KEY_FILE)=' "$file" >>"$tmp" 2>/dev/null || true
  printf 'TLS_MODE=%s\n' "$TLS_MODE" >>"$tmp"
  printf 'ACME_EMAIL=%s\n' "${ACME_EMAIL:-}" >>"$tmp"
  printf 'CERT_FILE=%s\n' "${CERT_FILE:-}" >>"$tmp"
  printf 'KEY_FILE=%s\n' "${KEY_FILE:-}" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}
