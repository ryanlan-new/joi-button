#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# joi-button operator entrypoint for the single-node k3s cluster on tcrn-platform-dev.
# Chain story JOI-BUTTON-STORY-009.
#
#   Usage:  deploy/deploy-k3s.sh [import|apply|all]
#
#     import   build the web image for linux/amd64, stream it into the cluster's
#              containerd WITHOUT a registry, then ask the cluster whether it arrived
#     apply    render deploy/k8s (replacing the literal 'replace-me' image tag on
#              stdout only) and apply it through the remote's kubectl, then wait for
#              the rollout
#     all      import, then apply  (this is also the default when no argument is given)
#
#   Environment (all optional):
#     IMAGE_REPO             default ghcr.io/ryanlan-new/joi-button/web
#     TAG                    default dev-<short git sha of HEAD>
#     REMOTE                 default tcrn-platform-dev            (an ssh host alias)
#     NAMESPACE              default joi-button
#     KUBECTL                default "sudo k3s kubectl"           (see the note below)
#     MANIFEST_DIR           default deploy/k8s
#     ROLLOUT_TIMEOUT        default 120s
#     RESTART_IF_UNCHANGED   default 1                            (see the note below)
#     SMOKE                  default 1     run deploy/smoke-image.sh before shipping
#     ALLOW_REGISTRY_PULL    default 0     permit applying a tag absent from the node
#
#   TAGS: this script builds and deploys `dev-<short7-sha>` (plus `-dirty` when the
#   working tree is not clean). CI publishes bare `<short7-sha>` to GHCR. The two
#   namespaces are separate on purpose — see the comment at the TAG default — so
#   deploying a CI image means naming it:
#     ALLOW_REGISTRY_PULL=1 TAG=<short7-sha> deploy/deploy-k3s.sh apply
#
#   ASSUMPTION, stated so it can be checked rather than believed: tcrn-platform-dev has
#   no standalone kubectl binary -- kubectl is reached as a k3s subcommand, and reading
#   /etc/rancher/k3s/k3s.yaml needs root. Hence the KUBECTL default is "sudo k3s kubectl".
#   If that host ever grows a real kubectl with a readable kubeconfig, override it:
#     KUBECTL=kubectl deploy/deploy-k3s.sh apply
#   Import also needs passwordless sudo on the remote, because the image tar arrives on
#   stdin and a sudo password prompt has nowhere to read from. That is preflighted.
#
#   The repository must stay clean: the manifests keep their 'replace-me' placeholder and
#   are never edited in place. Substitution happens on a pipe.
#
#   RESTART_IF_UNCHANGED: with imagePullPolicy IfNotPresent, re-importing new bytes under
#   an already-deployed tag leaves the Deployment spec byte-identical, so the apply is a
#   no-op, no pods restart, and "rollout status" would happily report success while the
#   old bytes keep serving. When the Deployment's generation does not move, this script
#   therefore issues an explicit "rollout restart". Set RESTART_IF_UNCHANGED=0 to opt out.

set -euo pipefail

DEFAULT_IMAGE_REPO="ghcr.io/ryanlan-new/joi-button/web"
DEFAULT_NAMESPACE="joi-button"
PLACEHOLDER_IMAGE="${DEFAULT_IMAGE_REPO}:replace-me"

DEPLOYMENT_NAME="joi-button-web"
APP_HOST="joi.tcrn.lan"
LB_ADDRESS="192.168.51.249"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_REPO="${IMAGE_REPO:-${DEFAULT_IMAGE_REPO}}"
REMOTE="${REMOTE:-tcrn-platform-dev}"
NAMESPACE="${NAMESPACE:-${DEFAULT_NAMESPACE}}"
KUBECTL="${KUBECTL:-sudo k3s kubectl}"
MANIFEST_DIR="${MANIFEST_DIR:-deploy/k8s}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-120s}"
RESTART_IF_UNCHANGED="${RESTART_IF_UNCHANGED:-1}"

MODE="${1:-all}"

log() { printf '[deploy-k3s] %s\n' "$*"; }
warn() { printf '[deploy-k3s] WARNING: %s\n' "$*" >&2; }
fail() {
  printf '[deploy-k3s] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  # Print this file's header comment block, minus the leading '#'. Anchored on the
  # comment run itself rather than fixed line numbers, so editing the header cannot
  # silently truncate the help text.
  awk 'NR > 2 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "${cmd}" >/dev/null 2>&1 || fail "required command not found locally: ${cmd}"
  done
}

case "${MODE}" in
  import | apply | all) ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    printf 'Unsupported mode: %s\n\n' "${MODE}" >&2
    usage >&2
    exit 1
    ;;
esac

# Everything below runs from the repository root, so the docker build context and
# MANIFEST_DIR mean the same thing no matter where the operator invoked this from.
cd "${REPO_ROOT}"

require_cmd git ssh

if [[ -z "${TAG:-}" ]]; then
  # --short=7, not bare --short: the bare form honours core.abbrev and can return
  # 8+ characters, which would silently disagree with the 7 that
  # .github/workflows/image.yml publishes.
  GIT_SHA="$(git rev-parse --short=7 HEAD 2>/dev/null || true)"
  [[ -n "${GIT_SHA}" ]] ||
    fail "cannot read the short git sha of HEAD in ${REPO_ROOT}; pass an explicit TAG=... instead."
  # TWO TAG NAMESPACES, ON PURPOSE. CI publishes `<sha>`; this script builds
  # `dev-<sha>`. They must not collide: a locally built image carries the bytes of
  # your working tree, and with `imagePullPolicy: IfNotPresent` a local build
  # tagged `<sha>` would shadow the CI image of that commit on the node forever,
  # with nothing to reveal the substitution. `-dirty` extends the same honesty to
  # uncommitted edits. To deploy a CI-published image, pass its tag explicitly:
  #   ALLOW_REGISTRY_PULL=1 TAG=<sha> deploy/deploy-k3s.sh apply
  TAG="dev-${GIT_SHA}"
  if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
    TAG="${TAG}-dirty"
    warn "working tree is dirty; tagging ${TAG} so the tag cannot claim to be commit ${GIT_SHA}."
  fi
fi

IMAGE_REF="${IMAGE_REPO}:${TAG}"

log "repo root:  ${REPO_ROOT}"
log "mode:       ${MODE}"
log "image:      ${IMAGE_REF}"
log "remote:     ${REMOTE}"
log "namespace:  ${NAMESPACE}"
log "kubectl:    ${KUBECTL}"

# ---------------------------------------------------------------------------
# import: build for the cluster's architecture, stream it in, then ask the cluster
# ---------------------------------------------------------------------------

do_import() {
  require_cmd docker
  docker buildx version >/dev/null 2>&1 || fail "docker buildx is required (docker buildx version failed)."

  [[ -f Dockerfile ]] || fail "Dockerfile not found in ${REPO_ROOT}; nothing to build."

  log "Preflighting ssh and passwordless sudo on ${REMOTE} ..."
  ssh -n "${REMOTE}" 'true' || fail "cannot ssh to ${REMOTE}."
  ssh -n "${REMOTE}" 'sudo -n true' ||
    fail "passwordless sudo is not available on ${REMOTE}; 'sudo k3s ctr images import -' cannot prompt because stdin carries the image tar."

  log "Building ${IMAGE_REF} for linux/amd64 ..."
  # --load is required so that the built image lands in the local docker image store
  # where 'docker save' can find it; with the plain docker driver it is the default,
  # with a docker-container builder it is not.
  # --provenance=false: with provenance on, buildx produces an OCI index carrying
  # an extra unknown/unknown attestation manifest, and the delivery path here is
  # `docker save | k3s ctr images import`, which handles a plain single-platform
  # manifest far more predictably.
  docker buildx build \
    --platform linux/amd64 \
    -t "${IMAGE_REF}" \
    --build-arg PUBLIC_PATH=/ \
    --provenance=false \
    --load \
    .

  # Start it before shipping it. The runtime contract (read-only root filesystem,
  # the two writable mounts, the cache split, honest 404s) is only observable in a
  # running container, and shipping first would make the cluster the place where
  # it is first evaluated. SMOKE=0 opts out; there is no good reason to.
  if [[ "${SMOKE:-1}" == "1" ]]; then
    [[ -x deploy/smoke-image.sh ]] ||
      fail "deploy/smoke-image.sh is missing or not executable; set SMOKE=0 to skip it deliberately."
    log "Smoke-testing ${IMAGE_REF} the way the Deployment runs it ..."
    SMOKE_PLATFORM=linux/amd64 deploy/smoke-image.sh "${IMAGE_REF}" ||
      fail "the image failed its runtime contract; not shipping it to the cluster."
  fi

  # Ask the local authority what was actually built. A silently arm64 image would only
  # fail on the cluster, as an exec format error inside a CrashLoopBackOff.
  local built_arch
  built_arch="$(docker image inspect --format '{{.Architecture}}' "${IMAGE_REF}")"
  [[ "${built_arch}" == "amd64" ]] ||
    fail "built image architecture is '${built_arch}', but the cluster node is amd64."
  log "Built ${IMAGE_REF} (architecture ${built_arch})."

  log "Streaming the image into ${REMOTE}'s containerd (no registry involved) ..."
  # Remote side is single-quoted so nothing here is re-expanded by the remote shell.
  docker save "${IMAGE_REF}" | ssh "${REMOTE}" 'sudo k3s ctr images import -'

  # The pipe's exit status proves the pipe ran, not that the image is in the cluster's
  # image store. Proving arrival means asking the thing it was supposed to arrive at.
  log "Verifying with the cluster that ${IMAGE_REF} is present ..."
  local matched
  if ! matched="$(ssh -n "${REMOTE}" "sudo k3s ctr images ls -q | grep -F -- '${IMAGE_REF}'")"; then
    fail "the cluster does not list ${IMAGE_REF} after import. Do not proceed to apply: with imagePullPolicy IfNotPresent the pods would fail to start."
  fi
  log "Cluster confirms: ${matched}"
}

# ---------------------------------------------------------------------------
# apply: render on stdout only, apply through the remote's kubectl, wait for rollout
# ---------------------------------------------------------------------------

MANIFESTS_NS=()
MANIFESTS_REST=()

collect_manifests() {
  [[ -d "${MANIFEST_DIR}" ]] || fail "manifest directory not found: ${MANIFEST_DIR} (relative to ${REPO_ROOT})"

  local file
  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    case "$(basename "${file}")" in
      kustomization.yaml | kustomization.yml)
        fail "found ${file}: this script applies plain manifests with sed substitution on stdout, not kustomize overlays."
        ;;
    esac
    if grep -Eq '^kind:[[:space:]]*Namespace([[:space:]]|$)' "${file}"; then
      MANIFESTS_NS[${#MANIFESTS_NS[@]}]="${file}"
    else
      MANIFESTS_REST[${#MANIFESTS_REST[@]}]="${file}"
    fi
  done <<EOF
$(find "${MANIFEST_DIR}" -type f \( -name '*.yaml' -o -name '*.yml' \) | LC_ALL=C sort)
EOF

  if [[ ${#MANIFESTS_NS[@]} -eq 0 && ${#MANIFESTS_REST[@]} -eq 0 ]]; then
    fail "no .yaml/.yml manifests under ${MANIFEST_DIR} (relative to ${REPO_ROOT})"
  fi
}

SED_ARGS=()

set_sed_args_for() {
  local file="$1"
  SED_ARGS=(-e "s|${PLACEHOLDER_IMAGE}|${IMAGE_REF}|g")
  # Renaming the namespace is only attempted when the operator actually asked for a
  # different one; the default path touches the image tag and nothing else.
  if [[ "${NAMESPACE}" != "${DEFAULT_NAMESPACE}" ]]; then
    SED_ARGS[${#SED_ARGS[@]}]="-e"
    SED_ARGS[${#SED_ARGS[@]}]="s|^\([[:space:]]*\)namespace:[[:space:]]*${DEFAULT_NAMESPACE}[[:space:]]*\$|\1namespace: ${NAMESPACE}|"
    if grep -Eq '^kind:[[:space:]]*Namespace([[:space:]]|$)' "${file}"; then
      SED_ARGS[${#SED_ARGS[@]}]="-e"
      SED_ARGS[${#SED_ARGS[@]}]="s|^\([[:space:]]*\)name:[[:space:]]*${DEFAULT_NAMESPACE}[[:space:]]*\$|\1name: ${NAMESPACE}|"
    fi
  fi
}

# Renders to stdout. The files on disk are never modified.
render_stream() {
  local file
  for file in "$@"; do
    printf '# rendered from %s\n' "${file}"
    set_sed_args_for "${file}"
    sed "${SED_ARGS[@]}" "${file}"
    printf -- '---\n'
  done
}

assert_no_placeholder() {
  local label="$1" stream="$2"
  case "${stream}" in
    *replace-me*)
      fail "rendered ${label} still contains 'replace-me'; refusing to apply an unpinned image reference."
      ;;
  esac
}

remote_generation() {
  ssh -n "${REMOTE}" "${KUBECTL} -n '${NAMESPACE}' get deploy ${DEPLOYMENT_NAME} -o jsonpath='{.metadata.generation}' 2>/dev/null || true"
}

do_apply() {
  collect_manifests

  # If no manifest carries the placeholder, the substitution below would be a no-op and
  # the apply would ship whatever literal is in the files. Refuse instead.
  grep -R -F -q -- "${PLACEHOLDER_IMAGE}" "${MANIFEST_DIR}" ||
    fail "no manifest under ${MANIFEST_DIR} (relative to ${REPO_ROOT}) contains the placeholder '${PLACEHOLDER_IMAGE}'; nothing would be pinned to ${TAG}."

  log "Preflighting ${KUBECTL} on ${REMOTE} ..."
  ssh -n "${REMOTE}" "${KUBECTL} get nodes -o name" >/dev/null ||
    fail "'${KUBECTL}' failed on ${REMOTE}. Check ssh, sudo, and that k3s is running; override the command with KUBECTL=..."

  # imagePullPolicy is IfNotPresent, so a tag that never reached this node is a
  # rollout that will sit in ImagePullBackOff unless the registry happens to be
  # reachable AND the GHCR package is readable without a pull secret (it is
  # private by default, and no imagePullSecret exists in these manifests).
  #
  # This is a STOP, not a note: the apply below replaces a working Deployment
  # spec, so proceeding on a tag that resolves nowhere trades a serving site for
  # ImagePullBackOff. Deploying a registry-hosted image is legitimate — it just
  # has to be said out loud.
  if ! ssh -n "${REMOTE}" "sudo k3s ctr images ls -q | grep -F -- '${IMAGE_REF}'" >/dev/null 2>&1; then
    if [[ "${ALLOW_REGISTRY_PULL:-0}" == "1" ]]; then
      warn "${IMAGE_REF} is not on ${REMOTE}; proceeding because ALLOW_REGISTRY_PULL=1. The kubelet must be able to pull it (public GHCR package or an imagePullSecret)."
    else
      fail "${IMAGE_REF} is not in ${REMOTE}'s image store, and the running Deployment would be replaced by one that cannot start. Either run 'deploy/deploy-k3s.sh import' to build and stream this tag in, or re-run with ALLOW_REGISTRY_PULL=1 if the kubelet is meant to pull it from the registry."
    fi
  fi

  local ns_stream="" rest_stream=""
  if [[ ${#MANIFESTS_NS[@]} -gt 0 ]]; then
    ns_stream="$(render_stream "${MANIFESTS_NS[@]}")"
    assert_no_placeholder "namespace manifests" "${ns_stream}"
  fi
  if [[ ${#MANIFESTS_REST[@]} -gt 0 ]]; then
    rest_stream="$(render_stream "${MANIFESTS_REST[@]}")"
    assert_no_placeholder "manifests" "${rest_stream}"
  fi

  # Read the Deployment's generation before anything is applied. Comparing it afterwards
  # is what tells us whether the apply actually changed the spec.
  local gen_before gen_after
  gen_before="$(remote_generation)"

  if [[ -n "${ns_stream}" ]]; then
    log "Applying namespace manifest(s) ..."
    # KUBECTL and NAMESPACE are deliberately expanded here, on the client: they are local
    # configuration. Their values are single-quoted where they land in the remote command,
    # so the remote shell re-expands nothing.
    # shellcheck disable=SC2029
    printf '%s\n' "${ns_stream}" | ssh "${REMOTE}" "${KUBECTL} apply -f -"
  else
    log "No Namespace manifest found; ensuring namespace ${NAMESPACE} exists ..."
    ssh -n "${REMOTE}" "${KUBECTL} create namespace '${NAMESPACE}' --dry-run=client -o yaml | ${KUBECTL} apply -f -"
  fi

  if [[ -n "${rest_stream}" ]]; then
    log "Applying workload manifests to namespace ${NAMESPACE} ..."
    # shellcheck disable=SC2029
    printf '%s\n' "${rest_stream}" | ssh "${REMOTE}" "${KUBECTL} apply -f -"
  else
    # Legitimate when every object lives in one multi-document file that also carries the
    # Namespace: that file was already applied above. Piping an empty stream to kubectl
    # would fail with "no objects passed to apply", so skip it rather than fake a failure.
    log "No separate workload manifests; all objects came from the Namespace-carrying manifest(s)."
  fi

  gen_after="$(remote_generation)"
  if [[ -z "${gen_after}" ]]; then
    fail "deployment ${DEPLOYMENT_NAME} does not exist in namespace ${NAMESPACE} after the apply; the manifests under ${MANIFEST_DIR} do not define it."
  fi

  if [[ -n "${gen_before}" && "${gen_before}" == "${gen_after}" ]]; then
    if [[ "${RESTART_IF_UNCHANGED}" == "1" ]]; then
      log "Deployment spec unchanged (generation ${gen_after}); restarting the rollout so re-imported bytes for ${TAG} are actually picked up."
      ssh -n "${REMOTE}" "${KUBECTL} -n '${NAMESPACE}' rollout restart deploy/${DEPLOYMENT_NAME}"
    else
      warn "Deployment spec unchanged (generation ${gen_after}) and RESTART_IF_UNCHANGED=0: running pods keep their current image bytes even if you just re-imported tag ${TAG}."
    fi
  fi

  log "Waiting for the rollout (timeout ${ROLLOUT_TIMEOUT}) ..."
  ssh -n "${REMOTE}" "${KUBECTL} -n '${NAMESPACE}' rollout status deploy/${DEPLOYMENT_NAME} --timeout=${ROLLOUT_TIMEOUT}"

  # A green rollout means the probes passed. /healthz is a filesystem-independent
  # `return 200`, so on its own it would also be green over an empty document
  # root. Assert the served bytes and the deployed image reference before calling
  # this a success.
  log "Asserting the deployed pod actually serves the app ..."
  local served
  served="$(ssh -n "${REMOTE}" "${KUBECTL} -n '${NAMESPACE}' exec deploy/${DEPLOYMENT_NAME} -- wget -qO- http://127.0.0.1:8080/" 2>/dev/null || true)"
  case "${served}" in
    *'<div id="app">'*) log "Served document contains the app root element." ;;
    *) fail "the pod is ready but GET / does not contain the app root element; the document root is empty or wrong." ;;
  esac

  local deployed_image
  deployed_image="$(ssh -n "${REMOTE}" "${KUBECTL} -n '${NAMESPACE}' get deploy ${DEPLOYMENT_NAME} -o jsonpath='{.spec.template.spec.containers[0].image}'" 2>/dev/null || true)"
  [[ "${deployed_image}" == "${IMAGE_REF}" ]] ||
    fail "the Deployment now runs '${deployed_image}', not the '${IMAGE_REF}' this run pinned."
  log "Deployment pins ${deployed_image}."
}

# ---------------------------------------------------------------------------

case "${MODE}" in
  import)
    do_import
    ;;
  apply)
    do_apply
    ;;
  all)
    do_import
    do_apply
    ;;
esac

echo
log "Done: ${MODE}"
if [[ "${MODE}" != "import" ]]; then
  cat <<EOF

Check the site (LAN):
  http://${APP_HOST}/

Check the health endpoint:
  curl -sS -i http://${APP_HOST}/healthz

If ${APP_HOST} does not resolve on this machine, address the ingress load balancer directly:
  curl -sS -i --resolve ${APP_HOST}:80:${LB_ADDRESS} http://${APP_HOST}/healthz

See pod status:
  ssh ${REMOTE} "${KUBECTL} -n ${NAMESPACE} get pods -l app.kubernetes.io/name=${DEPLOYMENT_NAME} -o wide"

See pod logs:
  ssh ${REMOTE} "${KUBECTL} -n ${NAMESPACE} logs -l app.kubernetes.io/name=${DEPLOYMENT_NAME} --tail=50"
EOF
fi
