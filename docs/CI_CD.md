# CI/CD and containers

M9 slice 7. How Talk2Tax is tested on every change, built into container images, published and
deployed.

## Container images

| Image | Built from | What it runs |
|---|---|---|
| `talk2tax-migrate` | `apps/api/Dockerfile`, target `migrate` | `prisma migrate deploy` against `DATABASE_URL`, then exits. The release step, run once before new API containers start |
| `talk2tax-api` | `apps/api/Dockerfile`, target `api` | The API (`dist/main.js`). Distroless Node 22 (no shell or package manager), non-root user, health check on `/health` |
| `talk2tax-web` | `apps/web/Dockerfile` | The web app as Next.js's self-contained server. Distroless, non-root, health check on `/login`. No database access; reaches the API at `T2T_API_URL` |

- The build stage is the full `node:22-bookworm` image (OpenSSL for Prisma is already there, so no
  `apt-get`). The API image takes a production-only copy of the workspace (`pnpm deploy --prod`)
  with the Prisma client generated for this OS, and loads it once during the build to prove it.
- `GIT_SHA` (build argument) is baked in and shown under Platform admin → System health.
- Behind a TLS-inspecting proxy, give the build its CA: `--secret id=extra_ca,src=<ca.pem>`
  (optional; without it nothing changes).
- `.dockerignore` keeps `.env*` files, local builds and `node_modules` out of the build context.

## The whole stack locally

```bash
export JWT_SECRET=$(openssl rand -base64 48)
docker compose --profile app up --build      # database → migrations → API → web on :3000
node scripts/smoke-stack.mjs                 # sign up, organisation, posted journal, trial balance
```

`POSTGRES_PORT`, `API_PORT` and `WEB_PORT` move the host ports; images are tagged
`talk2tax-{migrate,api,web}:${IMAGE_TAG:-local}`, so images built elsewhere run with `--no-build`.

`scripts/smoke-stack.mjs [web url]` checks a running stack the way a browser reaches it: the
web app answers, service status is read, an account is registered, an organisation created, a
balanced journal posted and seen in the trial balance, an unbalanced one refused, and the API
returns request ids. It creates a throwaway account and organisation.

## Continuous integration (`.github/workflows/ci.yml`)

On every pull request and push to `main`; a newer push cancels the run in progress.

| Job | What it checks |
|---|---|
| Build, typecheck, unit, API and browser tests | `pnpm install --frozen-lockfile` (the lockfile must match every `package.json`), build, typecheck, all unit and API integration tests against PostgreSQL 16 as an ordinary role (row-level security applies), the feature registry, then the API and web app started with local stand-ins for Claude, SMTP and the payment gateways and every browser test, one file at a time. Server logs are kept when it fails |
| Dependency audit | `pnpm audit --prod --audit-level=high`: no known high or critical advisory in anything the running app uses |
| Container images and full-stack smoke test | Builds the three images (layers cached between runs), starts database → migrations → API → web with Docker Compose, runs the smoke test, and runs the migrations again to prove they are idempotent |

Dependabot (`.github/dependabot.yml`) opens weekly update pull requests for npm packages, GitHub
Actions and the base images; each runs the checks above. Fixes for advisories in transitive
dependencies are pinned in `pnpm-workspace.yaml` under `overrides` until the packages that bring
them in update.

## Release and deployment (`.github/workflows/release.yml`)

- **Images**: on every push to `main`, every `v*.*.*` tag, and by hand. The three images go to
  GitHub's registry as `ghcr.io/<owner>/talk2tax-<name>`, tagged with the commit (`sha-abc1234`),
  the version for a tag (`1.4.0`), and `main` for the main branch, with provenance and an SBOM.
- **Deploy**: for a version tag, or by hand with "Deploy after publishing". It runs only when the
  `production` environment is set up in the repository (Settings → Environments), so add required
  reviewers there to make each deployment wait for an approval. It needs:
  - variables `DEPLOY_HOST`, `DEPLOY_USER`, `PUBLIC_URL`, and optionally `DEPLOY_PATH` (default
    `/opt/talk2tax`);
  - secrets `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` (the host key, so the connection is verified).

  Over SSH it copies `deploy/docker-compose.prod.yml` and `deploy/Caddyfile`, pulls the images for
  this commit, runs the migrations once (if they fail, nothing else changes), starts the new API
  and web containers and waits for them to be healthy, then checks that `PUBLIC_URL` answers.
- **Rolling back**: run the same compose commands with an earlier `IMAGE_TAG`. Migrations are
  forward-only; a release whose migration must be undone needs a new migration.

### The production host

One Docker host with `deploy/docker-compose.prod.yml` and, next to it, `.env.production` (never in
the repository) holding `DATABASE_URL`, `JWT_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`, `APP_URL`,
`DOMAIN` and the other settings in [`DEPLOYMENT.md`](DEPLOYMENT.md). PostgreSQL is a managed service
with backups and point-in-time recovery, reached as the application role (never a superuser).
Caddy is the only container reachable from outside: it obtains and renews TLS certificates for
`DOMAIN`, sends HSTS, and forwards to the web app, which forwards API calls (and payment webhooks)
to the API on the internal network.

## Not built yet

- The workflows have not run on GitHub: Actions is blocked for this account by a billing problem.
  Everything they do was run locally instead (images built, stack started, smoke and browser tests
  against the containers, the dependency audit). `actionlint` was not run.
- One host only: no Kubernetes, autoscaling, blue-green or canary releases, and a short gap while
  containers are replaced. Request timings and runner heartbeats are per instance (see
  [`OPERATIONS.md`](OPERATIONS.md)).
- No staging environment, image vulnerability scan, or database backup automation (that is the
  managed database's job). The API image is about 680 MB because the Prisma CLI's dependencies
  come with the client; trimming it is follow-up work.
