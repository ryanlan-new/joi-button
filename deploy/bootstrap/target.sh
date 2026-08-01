# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Detect what the target host can run, and let the operator pick a deployment
# target — installing one if nothing suitable is there yet.
#
#   1. probe the host for k3s / a generic kubectl, and for docker + compose;
#   2. report what was found;
#   3. if both are usable, ask which to use; if one, default to it; if neither,
#      ask which to INSTALL, and install it (k3s and docker on Linux via their
#      official scripts, confirmed; Docker Desktop on macOS is guided, not auto).
#
# Sets, for the steps that follow:
#   DEPLOY_TARGET   k3s | docker
#   KUBECTL         how to reach the cluster (k3s: "sudo k3s kubectl")
#
# The probe runs ON THE TARGET: over ssh when REMOTE is set (the k3s node, or a
# remote docker host), locally otherwise (docker on this machine).

# Run a command string on the target — ssh when REMOTE is set, local sh else.
run_on() {
  if [[ -n "${REMOTE:-}" ]]; then ssh -n -o ConnectTimeout=10 "$REMOTE" "$1"; else sh -c "$1"; fi
}

# Fill the HAS_* flags. Each probe answers 1/0 so the logic below is arithmetic,
# not string-matching an ssh transcript.
detect_env() {
  HAS_K3S=$(run_on 'command -v k3s >/dev/null 2>&1 && echo 1 || echo 0' 2>/dev/null || echo 0)
  HAS_KUBECTL=$(run_on 'command -v kubectl >/dev/null 2>&1 && echo 1 || echo 0' 2>/dev/null || echo 0)
  HAS_DOCKER=$(run_on 'command -v docker >/dev/null 2>&1 && echo 1 || echo 0' 2>/dev/null || echo 0)
  HAS_COMPOSE=$(run_on 'docker compose version >/dev/null 2>&1 && echo 1 || echo 0' 2>/dev/null || echo 0)
  TARGET_OS=$(run_on '. /etc/os-release 2>/dev/null; printf %s "${ID:-}"; [ -z "${ID:-}" ] && uname -s' 2>/dev/null || echo unknown)

  # Cluster reachability and the pieces the manifests rely on.
  K3S_READY=0; HAS_TRAEFIK=0; HAS_LOCALPATH=0
  if [[ "$HAS_K3S" == 1 ]]; then
    KUBECTL='sudo k3s kubectl'
  elif [[ "$HAS_KUBECTL" == 1 ]]; then
    KUBECTL='kubectl'
  else
    KUBECTL=''
  fi
  if [[ -n "$KUBECTL" ]]; then
    run_on "$KUBECTL get nodes 2>/dev/null | grep -qw Ready" && K3S_READY=1 || true
    run_on "$KUBECTL get storageclass local-path >/dev/null 2>&1" && HAS_LOCALPATH=1 || true
    run_on "$KUBECTL -n kube-system get deploy traefik >/dev/null 2>&1" && HAS_TRAEFIK=1 || true
  fi
}

report_env() {
  local where; where="$([[ -n "${REMOTE:-}" ]] && echo "$REMOTE (ssh)" || echo 'this machine')"
  section "Detected on $where"
  note "k3s:            $([[ $HAS_K3S == 1 ]] && echo present || echo absent)$([[ $HAS_K3S == 1 && $K3S_READY == 1 ]] && echo ', node Ready')"
  [[ $HAS_K3S == 0 && $HAS_KUBECTL == 1 ]] && note "kubectl:        present (a non-k3s cluster)"
  [[ -n "$KUBECTL" ]] && note "  traefik:      $([[ $HAS_TRAEFIK == 1 ]] && echo present || echo 'ABSENT — the Ingress needs it')"
  [[ -n "$KUBECTL" ]] && note "  local-path:   $([[ $HAS_LOCALPATH == 1 ]] && echo present || echo 'ABSENT — the PVCs need a StorageClass')"
  note "docker:         $([[ $HAS_DOCKER == 1 ]] && echo present || echo absent)$([[ $HAS_DOCKER == 1 && $HAS_COMPOSE == 0 ]] && echo ' (but no compose v2)')"
  note "compose:        $([[ $HAS_COMPOSE == 1 ]] && echo present || echo absent)"
}

cluster_usable() { [[ -n "$KUBECTL" && "$K3S_READY" == 1 ]]; }
docker_usable()  { [[ "$HAS_DOCKER" == 1 && "$HAS_COMPOSE" == 1 ]]; }

choose_target() {
  open_tty
  trap close_tty RETURN
  detect_env
  report_env

  local can_k3s=0 can_docker=0
  cluster_usable && can_k3s=1
  docker_usable && can_docker=1

  if [[ $can_k3s == 1 && $can_docker == 1 ]]; then
    section 'Both a cluster and Docker are ready. Which should serve joi-button?'
    DEPLOY_TARGET="$(pick_target)"
  elif [[ $can_k3s == 1 ]]; then
    DEPLOY_TARGET=k3s
    note 'Using the k3s cluster (the one target that is ready).'
    confirm_yes 'Deploy to the k3s cluster?' || DEPLOY_TARGET="$(pick_and_install)"
  elif [[ $can_docker == 1 ]]; then
    DEPLOY_TARGET=docker
    note 'Using Docker Compose (the one target that is ready).'
    confirm_yes 'Deploy with Docker Compose?' || DEPLOY_TARGET="$(pick_and_install)"
  else
    section 'Nothing runnable was found. Pick what to install.'
    DEPLOY_TARGET="$(pick_and_install)"
  fi

  # A cluster that exists but lacks the bundled pieces is a hard stop for the k3s
  # path — the manifests reference them by name.
  if [[ "$DEPLOY_TARGET" == k3s ]]; then
    detect_env
    [[ $HAS_TRAEFIK == 1 ]] || die 'this cluster has no traefik ingress controller; the Ingress cannot route without it'
    [[ $HAS_LOCALPATH == 1 ]] || die 'this cluster has no local-path StorageClass; the PVCs cannot bind'
  fi

  close_tty; trap - RETURN
  section "Deployment target: $DEPLOY_TARGET"
}

# Choose between two already-usable targets.
pick_target() {
  local a
  while true; do
    read -r -u 3 -p '  [1] k3s cluster   [2] Docker Compose : ' a || true
    case "$a" in
      1) echo k3s; return ;;
      2) echo docker; return ;;
    esac
  done
}

# Choose a target to INSTALL, then install it. Echoes the chosen target.
pick_and_install() {
  local a
  while true; do
    read -r -u 3 -p '  Install [1] k3s   [2] Docker : ' a || true
    case "$a" in
      1) install_k3s;    echo k3s; return ;;
      2) install_docker; echo docker; return ;;
    esac
  done
}

install_k3s() {
  # REMOTE is no longer required: with it, k3s is installed on the node over ssh;
  # without it, on THIS machine (a single-host cluster). run_on already runs local
  # when REMOTE is empty, so the installer line is identical either way. A
  # single-host k3s then serves via the registry image path (no Docker here).
  local where; where="$([[ -n "${REMOTE:-}" ]] && echo "the node ($REMOTE)" || echo 'this machine')"
  note "This runs the official k3s installer on ${where}:"
  note '  curl -sfL https://get.k3s.io | sudo sh -'
  note "It needs sudo${REMOTE:+ on the node} and internet access."
  confirm_yes 'Install k3s now?' || die 'aborted — install k3s yourself, then re-run'
  run_on 'curl -sfL https://get.k3s.io | sudo sh -' >&2 \
    || die 'the k3s installer failed (check sudo and internet access)'
  note 'Waiting for the node to become Ready...'
  local i
  for i in $(seq 1 30); do
    run_on 'sudo k3s kubectl get nodes 2>/dev/null | grep -qw Ready' && { note 'k3s is Ready.'; return; }
    sleep 4
  done
  die 'k3s installed but the node did not become Ready in time; check `sudo k3s kubectl get nodes`'
}

install_docker() {
  case "$TARGET_OS" in
    darwin|Darwin|mac*)
      die 'Docker on macOS is Docker Desktop, a GUI app this script cannot install. Install it from docker.com, start it, then re-run.' ;;
    *)
      note 'This runs the official Docker convenience script on the target:'
      note '  curl -fsSL https://get.docker.com | sudo sh'
      confirm_yes 'Install Docker now?' || die 'aborted — install Docker yourself, then re-run'
      run_on 'curl -fsSL https://get.docker.com | sudo sh' >&2 \
        || die 'the Docker installer failed (check sudo and internet on the target)'
      run_on 'docker compose version >/dev/null 2>&1' \
        || die 'Docker installed but `docker compose` is not available; install the compose v2 plugin'
      note 'Docker is installed. You may need to log out/in for group membership to take effect.'
      ;;
  esac
}
