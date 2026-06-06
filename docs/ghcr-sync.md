# GHCR + upstream sync workflow

This repo's `docker-compose.yml` pulls a prebuilt image from GHCR
(`ghcr.io/jzkk720/odysseus:<tag>`) instead of building locally. This file
documents how to keep your fork's image fresh and how to merge upstream
changes back in.

## Branch model reminder

| Branch | What it is |
| --- | --- |
| `upstream/dev`   | upstream moving edge (pewdiepie-archdaemon/odysseus) |
| `upstream/main`  | upstream curated stable |
| `origin/main`    | your fork's mirror of upstream stable (default clone branch) |
| `origin/dev`     | your fork's mirror of upstream dev |
| `origin/feat/*`  | your work-in-progress branches |

CONTRIBUTING.md in the upstream repo says PRs go to `dev`, and end-users
clone `dev` by default. Your fork follows the same convention.

## Day-to-day: pull the latest image

The compose file uses `pull_policy: always`, so:

```bash
docker compose pull
docker compose up -d
```

…always pulls the current `dev` tag before starting containers. No
`--build` flag, no local build, no Python install on the host.

To pin a specific build instead of tracking `dev`:

```bash
# 1. Find the sha tag from the workflow run you want:
gh run list --workflow docker-publish.yml --branch dev --limit 20 \
  --json databaseId,headSha,conclusion,createdAt

# 2. Set it in .env:
echo "ODYSSEUS_TAG=sha-1a2b3c4" >> .env
docker compose pull
docker compose up -d
```

## Syncing from upstream

The image is rebuilt automatically by `.github/workflows/docker-publish.yml`
whenever commits land on `dev` or `main` of your fork. But for your fork's
**source code** to track upstream, sync your branches periodically.

### Sync `dev` (the common case)

```bash
# Make sure you're on a clean working tree first:
git status --short

# From origin/main (your fork's mirror of upstream stable):
git fetch upstream
git checkout dev
git merge --ff-only upstream/dev || git rebase upstream/dev

# If there are local commits on dev, rebase onto upstream/dev:
#   git rebase upstream/dev
#   git push --force-with-lease origin dev

git push origin dev
```

The `docker-publish.yml` workflow will run on the push to `origin/dev` and
rebuild the `:dev` image.

### Sync `main` from upstream `main`

```bash
git checkout main
git merge --ff-only upstream/main
git push origin main
```

Same effect — the workflow rebuilds `:main` and emits a new
`sha-<7char>` alias.

### If you have local commits on `main` or `dev` that aren't in upstream

Don't try to merge upstream into a dirty `main`/`dev`. Move your local
work onto a feature branch first:

```bash
git checkout -b feat/<topic>
git push origin feat/<topic>
# Open PR from feat/<topic> → origin/dev (or main, per CONTRIBUTING.md)
```

Then sync the clean `dev`/`main` branch as above.

## When you change the image

Any change to `Dockerfile`, `requirements*.txt`, `docker/entrypoint.sh`,
or `.github/workflows/docker-publish.yml` triggers a rebuild on push
to `dev` or `main`. You don't need to bump a version anywhere — the
workflow emits both the moving tag and the immutable `sha-<7char>` alias.

To trigger a rebuild without a code change (e.g. flaky CI):

```bash
gh workflow run docker-publish.yml --ref dev
```

## Local development with a hot image

If you change code and want to test it inside Docker before pushing:

```bash
# One-off: build locally and run, ignoring the GHCR image.
docker compose -f docker-compose.yml build odysseus
docker compose -f docker-compose.yml up -d

# When done, return to the GHCR image:
docker compose -f docker-compose.yml down
docker compose pull
docker compose up -d
```

> Note: when you `build` a service that has an `image:` line in compose,
> Docker tags the local build as `odysseus:dev` (or whatever tag is in
> `image:`) and re-uses it on subsequent `up` runs even after `pull`.
> `docker compose down --rmi local` clears the local build if you want
> to be sure the GHCR image is back.

## Rollback

The `:dev` tag moves. To roll back to a known-good build:

```bash
# Find a working build from the workflow history:
gh run list --workflow docker-publish.yml --branch dev --status success --limit 20

# Pin to its sha tag:
echo "ODYSSEUS_TAG=sha-<7char>" >> .env
docker compose pull
docker compose up -d
```

The previous container's bind-mounted data (`./data`, `./logs`) is
preserved across rollback — only the image changes.

## Verification checklist (first deploy)

```bash
# 1. Image is reachable:
docker pull ghcr.io/jzkk720/odysseus:dev

# 2. Compose resolves cleanly:
docker compose config | grep -E 'image:|pull_policy'

# 3. Containers start:
docker compose up -d
docker compose ps

# 4. First-boot admin password (printed once per fresh data/ dir):
docker compose logs odysseus | grep -iE 'temporary password|admin'

# 5. Healthcheck on the bundled services:
curl -fsS http://127.0.0.1:7000/ | head -1
curl -fsS http://127.0.0.1:8080/ | head -1   # SearXNG
curl -fsS http://127.0.0.1:8100/api/v1/heartbeat  # ChromaDB
curl -fsS http://127.0.0.1:8091/v1/health   # ntfy

# 6. Port remap test (override APP_PORT and recreate):
echo "APP_PORT=7080" >> .env
docker compose up -d
curl -fsS http://127.0.0.1:7080/ | head -1   # 7000 should be free
```

## Host port reference

| Service     | Host default | Container | Env override           |
| ----------- | ------------ | --------- | ---------------------- |
| Odysseus UI | 7000         | 7000      | `APP_PORT`, `APP_BIND` |
| ChromaDB    | 8100         | 8000      | `CHROMADB_BIND`        |
| SearXNG     | 8080         | 8080      | (hardcoded — PR if needed) |
| ntfy        | 8091         | 80        | `NTFY_BIND`, `NTFY_BASE_URL` |

All default to loopback. Set `*_BIND=0.0.0.0` only when you intentionally
want LAN access (and put the service behind a reverse proxy + TLS).
