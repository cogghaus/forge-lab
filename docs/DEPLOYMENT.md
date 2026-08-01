# Deployment

forge-lab builds on GitHub-hosted runners and publishes five images to GHCR. **It does not deploy
itself.** The deploy host pulls.

## Why it is arranged this way

The obvious design is a CD job that SSHes in, or a self-hosted runner on the deploy box that runs
`docker compose up`. This repo used the second one, and it worked well, until the repo went public.

A self-hosted runner executes workflow code on your hardware. This one mounted the docker socket,
which is root-equivalent on that host. In a public repo that is an unusual amount of trust to place
in the workflow surface: it holds as long as nothing that can reach `main` is hostile and no
workflow trigger can be reached from a fork. Those are two conditions that must keep holding
forever, and one bad `pull_request_target` or one over-permissive ruleset breaks them silently.

So the trust direction is inverted. The registry is the only shared surface. GitHub pushes images
to it; the deploy host pulls from it. **Nothing calls inward, so there is nothing inbound to
secure.** The blast radius of a compromised workflow becomes "a bad image is published", which the
digest check below is designed to catch, rather than "arbitrary code runs on the LAN".

The cost is that a deploy is no longer instant. The poll interval is the deploy latency. That is a
good trade for a repo anyone can open a pull request against.

## What runs where

```
push to main
  -> CI            (ubuntu-latest)
    -> CD build    (ubuntu-latest)  -> ghcr.io/cogghaus/forge-lab-*:{latest,<short-sha>}
                                            |
                            deploy host polls, pulls by digest, redeploys
```

## On the deploy host

A systemd timer runs `deploy-pull.sh`, which:

1. Logs in to GHCR with a read-only token (the packages are private).
2. Resolves the digest currently published for `:latest`.
3. Compares it to the digest of the running container.
4. If and only if they differ, runs `compose pull` then `up -d --no-build`, then re-checks health.

**Digest comparison, never tag comparison.** A tag is a mutable pointer; `:latest` pointing at a new
image and `:latest` pointing at the same image are indistinguishable by name. Comparing digests is
what makes "nothing changed, do nothing" trustworthy, and it is the same check used to verify a
deploy actually took effect rather than silently reusing a cached layer.

`up -d --no-build` is deliberate: an accidental on-box build becomes an immediate error rather than
a load spike. Building on the deploy box once drove load to ~1400 and wedged the host
(`docs/design/m3-reliability.md`, issue 50).

### Credential

The five packages are private, so the host needs a token with **`read:packages` and nothing else**.
Store it outside the repo, mode 600, and pass it via `--password-stdin`. Never inline it in a
compose file: a token sitting in a YAML file is one careless `cat` away from a transcript or a
screen share.

### Manual deploy and rollback

```sh
# deploy whatever :latest currently points at
IMAGE_TAG=latest docker compose -p deploy -f deploy/compose.yml --env-file <env> up -d --no-build

# roll back to a specific build
IMAGE_TAG=<short-sha> docker compose -p deploy -f deploy/compose.yml --env-file <env> up -d --no-build
```

Every build is tagged with its short SHA as well as `latest`, so rollback is always available
without rebuilding.

## Verifying a deploy actually happened

A config edit is not evidence, and neither is a green pipeline. Check the running container:

```sh
docker inspect forge-hub --format '{{.Config.Image}} {{.State.StartedAt}}'
docker image inspect "$(docker inspect forge-hub --format '{{.Image}}')" --format '{{join .RepoDigests ","}}'
```

The digest should match the package version you expect to be running. If the digest is unchanged
and the start time is old, the deploy did not take, whatever the pipeline said.

## Configuration

Deployment-specific values are interpolated, never committed. See `deploy/.env.example`:

| Variable | Purpose |
|---|---|
| `FORGE_DATA_ROOT` | Host directory holding `data/` and `workdir/` |
| `FORGE_DASH_HOST` | Public hostname for the dashboard router |
| `FORGE_MCP_HOST` | Public hostname for the MCP router |
| `APP_BASE_URL` | External URL the hub emits in links and email |
| `FORGE_HUB_MAIL_FROM` | Optional From address on hub-sent email |
