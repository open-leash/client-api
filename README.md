<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0EA5E9,45:2563EB,100:111827&height=220&section=header&text=Client%20API&fontSize=54&fontColor=ffffff&fontAlignY=38&desc=The%20managed%20agent%20decision%20surface.&descSize=18&descAlignY=58" width="100%" />

<p>
  <a href="https://openleash.com"><img src="https://img.shields.io/badge/OpenLeash-openleash.com-0EA5E9?style=for-the-badge&logo=googlechrome&logoColor=white" /></a>
  <a href="https://docs.openleash.com"><img src="https://img.shields.io/badge/Docs-docs.openleash.com-2563EB?style=for-the-badge&logo=readthedocs&logoColor=white" /></a>
  <img src="https://img.shields.io/badge/Open%20Core-Client%20API-111827?style=for-the-badge&logo=github&logoColor=white" />
</p>

<p>
  <img src="https://img.shields.io/badge/Postgres-schema%20migrations-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" />
  <img src="https://img.shields.io/badge/Node-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Surface-desktop%20%2B%20mobile%20%2B%20hooks-0EA5E9?style=for-the-badge" />
</p>

<h3>🐾 Unleash your agents. Keep the decision layer calm, fast, and observable.</h3>

</div>

---

## ✨ What this app is

`client-api` is the single public backend used by Individual Open Source and Private Cloud. OpenLeash Cloud wraps the same surface through `cloud-client-api`; it does not fork the core plugin, policy, or agent-event semantics.

It evaluates agent events, records audit trails, stores pending approvals, serves mobile state, manages update metadata, and exposes the core API that OpenLeash Cloud wraps for hosted customers.

```text
installed hooks ───────────────► configured client-api
provider traffic ─► local proxy ─► desktop edge ─► plugin containers
                                         │
                                         └────────► configured client-api

client-api ──► Postgres policy, plugin settings, audit, approvals, account/org state
```

---

## 🚀 Where it runs

| Mode | Role |
| --- | --- |
| 🧑‍💻 Individual Open Source | Runs locally with the real public Postgres schema for one user. |
| 🏢 Private Cloud | Customer-hosted managed API. |
| ☁️ OpenLeash Cloud | Wrapped by `cloud-client-api` for hosted tenancy and cloud controls. |

---

## 🔥 Responsibilities

- Receive normalized events from installed hooks, the desktop provider edge, and retrospective provider connectors
- Evaluate actions against policy and model providers
- Store audit, evaluations, MCP calls, skills, triggers, and pending approvals
- Run the ordered OpenLeash plugin pipeline for prompts, tools, agent responses, startup, sessions, MCP inventory, and skill changes
- Serve mobile approval and account state
- Enroll managed endpoints with deployment tokens
- Apply Postgres migrations safely through `schema_migrations`
- Provide extension points for hosted/private wrappers

### Attention interaction contract

`GET /v1/client/notifications` and `GET /v1/mobile/state` include versioned
`attentionEvents` for approvals, native questions, plan reviews, blocked
actions, completed turns, and completed subagents. `GET /v1/client/events`
provides an authenticated per-user server-sent event stream. Postgres emits an
invalidation after activity creation, attention creation, and resolution, so
desktop, web, and mobile can refresh the same durable record immediately.

Desktop, web, and mobile resolve the same durable decision through the client
or mobile decision endpoint. An allow resolution may include a bounded,
structured `response`; the exact hook/proxy request already waiting for that
decision receives the payload and its agent adapter translates it into the
agent's native answer format. Resolutions are not broadcast as commands to
other desktops. Cloud and SaaS requests are resumed by their server-side
request owner.

This path is deliberately backend-owned. Individual Open Source uses its local
`client-api` and Postgres, Private Cloud uses the customer-hosted service, and
OpenLeash Cloud uses the same public API through its thin cloud wrapper. The
desktop local server mirrors the contract only for setup, development, and
legacy relay behavior; it is not a separate product backend.

---

## 🔌 Plugin architecture

Core protections are implemented as pipeline plugins. Each plugin declares a manifest with metadata, events, permissions, settings, effects, ordering, and execution environment. Implementations use stable runtime capabilities instead of importing OpenLeash internals.

OpenLeash resolves installation and configuration before invoking plugin code. Individual users can configure a plugin globally, for an agent kind, or for an exact authenticated/enrolled agent runtime. Organization admins independently control mandatory installation, default enablement, optional employee installs, and configuration locking; organization profiles apply across employees, followed by permitted user profiles. A mandatory plugin cannot be removed or disabled by an employee, but it remains configurable when the admin leaves settings unlocked.

Plugins may publish typed, expiring annotations, progress, and ambient status through the Island capability. OpenLeash owns rendering and navigation; plugins never send UI code. See [`docs/PLUGIN_ISLAND.md`](docs/PLUGIN_ISLAND.md).

Developer docs live in [`src/plugins/README.md`](src/plugins/README.md). First-party plugin examples live as one public repository per plugin under the `open-leash/plugin-*` pattern.

---

## 🧩 Build a container plugin

OpenLeash plugins are ordinary OCI containers. Use any language, keep private
files or a database under `/data`, and communicate through the signed
`openleash-container-plugin.v1` HTTP protocol.

```text
GET  /healthz
POST /v1/events
```

History-aware plugins should request the authenticated current conversation:

```ts
const conversation = await capabilities.context.conversation.recent({
  limit: 20
});
```

Use `/data` for runtime-local SQLite, PostgreSQL, MongoDB, files, indexes, or
caches. OpenLeash does not copy private database files between desktop and
cloud runtimes. `capabilities.storage` remains optional for small plugin-owned
values; it is not the normal conversation-history interface.

- [Read the complete plugin guide](src/plugins/README.md)
- [Run the container example](examples/container-plugin)
- [Browse the hosted documentation](https://docs.openleash.com/reference/plugin-containers)

The example includes the complete local loop:

```bash
cd examples/container-plugin
npm install
npm run smoke
```

Then choose **Plugins → Add/reload local folder** in an Individual Open Source
desktop. The smoke test validates the manifest and JavaScript, builds the
image, exercises a signed conversation-context round trip, and leaves the image
ready to load. For later edits, run `npm run image` and choose the same folder
again; the desktop replaces the running development container automatically.

---

## 🛠 Run locally

```bash
npm install
docker compose up -d postgres
python3 migrate.py --target local --scope core --apply --yes
npm run dev:client-api
```

Health:

```bash
curl http://localhost:9318/health
```

Recommended full-mode runner:

```bash
python3 run.py
```

---

## 🗄 Database install and upgrades

`client-api` owns the public self-hosted schema. It must be migrated before `client-api` or `dashboard-api` starts.

Fresh self-hosted Postgres database:

```bash
python3 migrate.py --target custom --database-url 'postgres://...' --scope core --apply --yes
```

Upgrade an existing self-hosted deployment:

```bash
python3 migrate.py --target custom --database-url 'postgres://...' --scope core --backup-apply --yes
```

Read-only status:

```bash
python3 migrate.py --target custom --database-url 'postgres://...' --scope core --status --yes
```

Operators should run migrations as a one-shot deployment job, not as API startup logic. Migrations are tracked in `schema_migrations` with checksums and timestamps. Never edit an applied migration; add a new forward migration that performs all needed schema and data changes.

For production, use separate database roles:

- `openleash_ops` is the schema owner and migration/admin login. Operators may use it from tools such as DBeaver.
- `openleash` is the API runtime login. It receives table, sequence, and routine privileges, but normal API processes do not need schema ownership.

Run production migrations with the `openleash_ops` connection string. Migration `0032_database_role_contract` establishes default privileges so objects created by later migrations are immediately usable by `openleash` without one-off grants. Keep the runtime and operations connection strings in separate secrets.

---

## 🧠 BYOK and evaluation

OpenLeash supports tenant BYOK evaluation keys for OpenAI, Anthropic/Claude, and DeepSeek.

Keys are stored encrypted in organization config. Evaluation can run through:

- Tenant BYOK provider
- OpenLeash-managed provider
- Deterministic fallback for local/dev safety

---

## 🛡 Safety notes

- Tokens are hashed before storage.
- Postgres migrations are checksummed and tracked.
- Destructive DB changes should ship with explicit migration review.
- Public core behavior belongs here; OpenLeash-hosted-only behavior belongs in cloud wrappers.

<div align="center">

### Built for the boringly important part: decisions that can be trusted.

</div>
