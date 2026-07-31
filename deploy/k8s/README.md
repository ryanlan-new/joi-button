<!-- SPDX-License-Identifier: MIT -->

# joi-button on k3s — operator notes

Four manifests that publish the built site as a read-only nginx pod on a
single-node k3s cluster reached over ssh.

**This repository is public and states no cluster's identity.** The node, the
hostname the Ingress serves and the load-balancer address are yours, not the
repository's: put them in `deploy/deploy.env` (git-ignored; copy
`deploy/deploy.env.example`). Below, `$REMOTE`, `$APP_HOST` and `$LB_ADDRESS`
refer to those values.

| File                  | Object                                                          |
| --------------------- | --------------------------------------------------------------- |
| `namespace.yaml`      | Namespace `joi-button`                                          |
| `web-service.yaml`    | Service `joi-button-web` — ClusterIP, port 80 → 8080            |
| `web-deployment.yaml` | Deployment `joi-button-web` — 1 replica, nginx, read-only root   |
| `ingress.yaml`        | Ingress `joi-button-public` — traefik, host `replace-me.invalid` |

Two placeholders are substituted on the way in and never edited on disk: the
image tag `replace-me`, and the Ingress host `replace-me.invalid` (RFC 2606's
reserved TLD, so an unsubstituted placeholder fails loudly rather than resolving
somewhere unintended).

These manifests are the whole deployment surface. They do **not** contain the
nginx config, the cache headers or the `/healthz` endpoint — those live in the
container build elsewhere in this repository. What this baseline assumes of the
image: listens on **8080**, runs as **uid/gid 101**, tolerates a **read-only root
filesystem** given writable `/tmp` and `/var/cache/nginx`, serves from
`/usr/share/nginx/html`, and answers `GET /healthz` with a small plain-text body
that is *not* `index.html`.

## Image delivery

Image name: `ghcr.io/ryanlan-new/joi-button/web`, tag placeholder `replace-me`
(one occurrence, in `web-deployment.yaml`). `imagePullPolicy` is `IfNotPresent`.

**`deploy/deploy-k3s.sh` is the supported path and the single tag authority.** It
builds, smoke-tests, streams the image into the node's containerd, applies the
manifests with the tag substituted on a pipe, and then asserts that the pod
serves the app. The manual recipes below this section are the fallback for when
you need to see each step.

```bash
deploy/deploy-k3s.sh          # import + apply
deploy/deploy-k3s.sh import   # build, smoke, stream to the node, verify arrival
deploy/deploy-k3s.sh apply    # render, apply, wait, assert
```

There are **two tag namespaces, deliberately kept apart**:

| Who builds it              | Tag                                | Where it lives                |
| -------------------------- | ---------------------------------- | ----------------------------- |
| `deploy/deploy-k3s.sh`     | `dev-<short7-sha>` (`-dirty` if the working tree is not clean) | that node's containerd only |
| `.github/workflows/image.yml` | `<short7-sha>`, plus `latest` from `main` | GHCR                    |

They must not collide. A locally built image carries the bytes of your working
tree; if it were tagged with the bare sha, `IfNotPresent` would let it shadow the
CI image for that commit on the node indefinitely, with nothing to reveal the
substitution. To deploy a CI-published image, name it explicitly:

```bash
ALLOW_REGISTRY_PULL=1 TAG=<short7-sha> deploy/deploy-k3s.sh apply
```

`ALLOW_REGISTRY_PULL` is required because the script otherwise refuses to apply a
tag that is not already on the node — with `IfNotPresent`, that would replace a
serving Deployment with one stuck in `ImagePullBackOff`.

**GHCR packages are private by default, even for a public repository.** The
`org.opencontainers.image.source` label in the Dockerfile makes the package
auto-link to this repo, which enables "inherit access from source repository" —
but that is a one-time manual toggle in the package settings that nobody has
performed yet. Until it is done (or an `imagePullSecret` is added to the
namespace and referenced in the pod spec), the only working delivery path is the
local import above. **Record here which one was chosen**, so the next operator
does not rediscover it from a 401.

Use a fresh tag per build. Re-importing new content under a tag containerd
already has, with `IfNotPresent`, leaves the old layers serving unless you also
force a restart — a self-inflicted "my fix didn't deploy". `deploy-k3s.sh`
handles this by issuing an explicit `rollout restart` when the Deployment's
generation does not move.

The manual equivalent of the import step:

```bash
TAG="dev-$(git rev-parse --short=7 HEAD)"
docker buildx build --platform linux/amd64 --provenance=false \
  -t "ghcr.io/ryanlan-new/joi-button/web:${TAG}" --build-arg PUBLIC_PATH=/ --load .
deploy/smoke-image.sh "ghcr.io/ryanlan-new/joi-button/web:${TAG}"
docker save "ghcr.io/ryanlan-new/joi-button/web:${TAG}" \
  | ssh "$REMOTE" 'sudo k3s ctr images import -'
```

The result is a **node-local** image: it exists in that node's containerd and in
no registry. Fine on one node; a landmine the day a second node joins.

## Apply by hand

Prefer `deploy/deploy-k3s.sh apply`, which does all of this plus the assertions.
Note that a stock k3s node has no standalone `kubectl`: it is reached as
`sudo k3s kubectl`, so run these over ssh or substitute accordingly.

Substitute the tag on the way in; nothing here is templated by Helm or Kustomize.

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/web-service.yaml
sed "s|/web:replace-me|/web:${TAG}|" deploy/k8s/web-deployment.yaml \
  | kubectl apply -f -
kubectl apply -f deploy/k8s/ingress.yaml

kubectl -n joi-button rollout status deploy/joi-button-web --timeout=90s
```

Order matters in two places: the namespace must exist before anything in it, and
the Service before the Ingress so traefik never resolves a route to a backend
that is not there yet. Service-before-Deployment is habit, not a requirement.

Confirm what you actually applied, rather than what the file says:

```bash
kubectl -n joi-button get deploy joi-button-web \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

## Verify

Resolving the name yourself tests routing without depending on DNS — use it
first, so a resolver problem cannot look like a deployment problem. `$APP_HOST`
and `$LB_ADDRESS` come from `deploy/deploy.env`.

```bash
R="--resolve ${APP_HOST}:80:${LB_ADDRESS}"

curl -sS $R -o /dev/null -w '%{http_code}\n' "http://${APP_HOST}/healthz"
curl -sSI $R "http://${APP_HOST}/"                        # expect Cache-Control: no-cache
curl -sS  $R "http://${APP_HOST}/nope/deep" | head -c 80  # expect the app shell
```

Then the real thing, which additionally proves the client resolves the name:

```bash
curl -sSI "http://${APP_HOST}/"
```

With no DNS record and no hosts entry, forward the Service port instead and
browse it — this bypasses the Ingress, so no Host header is involved:

```bash
ssh -L 8080:127.0.0.1:18080 "$REMOTE" \
  "sudo k3s kubectl -n joi-button port-forward --address 127.0.0.1 svc/joi-button-web 18080:80"
# then open http://localhost:8080/
```

Cache contract, checked in both directions by `deploy/smoke-image.sh` and worth a
manual look because the whole voice-file workflow rests on it:

| URL family                              | Expected                              |
| --------------------------------------- | ------------------------------------- |
| `/`, `/index.html`, any deep link       | `no-cache, must-revalidate`           |
| `/js/app.<hash>.js`, `/css/…`, `/fonts/…`, `/img/…` | `max-age=31536000, immutable` |
| `/voices/*.mp3`                         | `max-age=31536000, immutable`          |
| `/resources/**`, `/site.webmanifest`    | `max-age=3600, must-revalidate`        |

The last row is the one that is easy to get wrong in the dangerous direction:
those filenames are copied verbatim from `public/` and do **not** change when
their bytes do, so freezing them for a year would be unrecoverable for every
visitor who cached them. `immutable` is granted only where a new byte forces a
new name — webpack's content hashes, and `/voices/*` where the project convention
requires a new filename per recut (see the repository README).

Voice filenames contain spaces, apostrophes and question marks, so quote and
URL-encode them when curling one directly.

The deep-link check returning 200 is correct (vue-router runs in history mode, so
nginx falls back to `index.html`) — and it is also why `/healthz` exists as a
separate endpoint. Every other path is 200 by construction, so no other path can
tell you whether the site is really there.

## What this baseline does not do

Read this as the list of things nobody has done yet, not as accepted risk that
somebody signed off.

- **No TLS.** Plain HTTP on port 80, no cert, no redirect. There is no
  `tls:` block in the Ingress.
- **No public internet exposure, and no authentication.** The reachability limit
  is a private ingress address plus a name that only resolves on the LAN.
  Anything that can reach that address with the right `Host` header gets the
  site. Nothing here authenticates anyone.
- **No autoscaling, no PodDisruptionBudget, single replica.** Pod eviction, image
  change or node reboot means a short outage. On a single-node cluster there is no
  second failure domain to spread over anyway.
- **Node-local image, if imported.** No registry pull secret is shipped, so a
  private GHCR package will fail to pull.
- **No NetworkPolicy, no ResourceQuota, no LimitRange, no metrics or
  ServiceMonitor.** Observability is `kubectl logs` and nginx's access log.
- **Nothing verifies the DNS record.** `$APP_HOST` has to resolve by some means
  outside these files. Do not assume it does: an ingress can be perfectly healthy
  while the name resolves nowhere on the machine you are testing from, and the two
  failures look identical in a browser. Browsing by name needs a LAN DNS record or
  a hosts entry (`$LB_ADDRESS $APP_HOST`); adding a hosts entry needs root and is
  the operator's call. The `curl --resolve` and port-forward recipes above are the
  DNS-independent ways to confirm the deployment itself.
- **This does not replace GitHub Pages.** The Pages workflow
  (`.github/workflows/deploy.yml`, publishing `dist/` on push to `main`) is
  untouched. The two deployments are not the same build: the container build
  passes `PUBLIC_PATH=/` because it serves from the domain root, while the Pages
  build keeps the default `/joi-button/`. A `dist/` built for one will load no
  assets under the other.
