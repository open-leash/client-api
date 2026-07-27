# Container plugin example

This example implements `openleash-container-plugin.v1` with Node.js. It
requests recent authenticated conversation context, validates signed runtime
requests, returns correlated responses, and optionally keeps runtime-local
analytics in PostgreSQL.

## Five-minute local loop

Copy this folder, then change these fields in `manifest.json`:

- `id`, for example `com.yourname.my-plugin`
- `slug`, `name`, and `description`
- `publisher`
- `execution.image`, using a local tag you control

Do not add `execution.digest` during development. A digest pins the published
image and prevents rebuilt local tags from being picked up.

```bash
npm install
npm run smoke
```

`smoke` validates the manifest and JavaScript, builds the image, starts it with
production-style restrictions, verifies health and request signing, round-trips
conversation context, and removes the test container. The built image remains
ready for OpenLeash. Use `npm run check` for a fast no-Docker check and
`npm run image` when you only need to rebuild.

Start OpenLeash in **Individual Open Source**, then open:

```text
Plugins → Add/reload local folder → choose this plugin folder
```

OpenLeash validates the manifest, enables the plugin, starts its container, and
reports an actionable error if the image or health check fails. Trigger a local
agent event and inspect the result in the Island, plugin logs, or Flow Viewer.

Your edit loop is:

```text
edit → npm run check → npm run image → Add/reload local folder → trigger event
```

The desktop detects that the local image tag now points to a new image and
replaces the running development container even when the manifest version did
not change.

For a headless local catalog test from an OpenLeash checkout:

```bash
python3 run.py \
  --mode individual-open-source \
  --keep-local \
  --dev-auth \
  --load-plugins \
  --plugins-dir /absolute/path/to/your-plugin \
  --yes
```

The loader accepts a plugin directory directly or a parent directory containing
multiple plugins. It recognizes `openleash.plugin.json`, `plugin.json`,
`manifest.json`, an embedded package manifest, or `manifest.ts`. Install the
loaded plugin with the desktop or `openleash plugins install <plugin-id>`.

## Run the handler without Docker

```bash
OPENLEASH_PLUGIN_RUNTIME_SECRET=local-development-secret npm start
```

Use `npm run smoke` for the complete signed protocol test.

## Add a private PostgreSQL database

The development Compose file runs PostgreSQL as a separate service. The plugin
uses it only for private runtime-local analytics; conversation-aware decisions
come from OpenLeash context.

```bash
docker compose -f docker-compose.dev.yml up --build
curl http://127.0.0.1:8080/healthz
```

The named `plugin-postgres` volume survives container replacement. Remove it
only when you intentionally want to delete the example data:

```bash
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml down --volumes
```

The second command is destructive.

## Bundle PostgreSQL when isolation requires it

A `user-dedicated` plugin may bundle its application and private PostgreSQL as
one stateful container appliance:

```bash
docker compose -f docker-compose.bundled-postgres.yml up --build
curl http://127.0.0.1:8080/healthz
```

`entrypoint-bundled-postgres.sh` initializes PostgreSQL only when `/data` is
empty, listens on loopback, starts the plugin API, and shuts both processes down
on `SIGTERM`. `PGDATA` is `/data/postgres`, so the named volume survives pod or
container replacement.

This shape has intentional constraints:

- `isolation` must be `user-dedicated`, `tenant-dedicated`, or
  `customer-hosted`; never `shared-trusted`.
- Run exactly one replica with a single-writer volume.
- Do not expose port 5432.
- Snapshot or back up `/data` before destructive upgrades.
- Use managed PostgreSQL instead when the plugin needs high availability,
  replicas, large data, or independent database maintenance.

## Publish

```bash
npm run smoke
docker push ghcr.io/acme/history-aware:1.0.0
docker inspect --format='{{index .RepoDigests 0}}' \
  ghcr.io/acme/history-aware:1.0.0
```

Put the immutable digest returned by the last command into `manifest.json`,
commit the manifest, and submit that exact version. Never publish a mutable tag
without its digest.

## History, storage, and isolation

The manifest declares `conversation:read`. On its first round the container
requests:

```json
{
  "id": "context.conversation.recent:0",
  "capability": "context.conversation.recent",
  "request": { "limit": 20 }
}
```

OpenLeash checks the permission and returns only the authenticated current
session. The container never chooses a user or arbitrary conversation.

The example uses `placement: "either"`: local agent events execute in the local
container and cloud-agent events execute in the cloud container. Any PostgreSQL
data belongs only to that runtime. OpenLeash does not copy or merge the two
databases.

Because the workload and volume are already user-bound, the plugin does not
accept or persist a caller-selected `user_id`.

Use `shared-trusted` only after an explicit shared-runtime security review and
only when authoritative tenant state stays behind host-mediated capabilities.
Use `/data` for local databases, indexes, and caches. Use conversation context
for history-aware decisions. Keep `capabilities.storage` for occasional small
plugin-owned values—not as a replacement conversation database.
