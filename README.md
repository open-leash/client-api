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

`client-api` is the managed API that desktop clients, mobile clients, hooks, and enrollment flows talk to in Private Cloud. OpenLeash Cloud wraps the same surface through `cloud-client-api`.

It evaluates agent events, records audit trails, stores pending approvals, serves mobile state, manages update metadata, and exposes the core API that OpenLeash Cloud wraps for hosted customers.

```text
desktop-client local API
        │
        ▼
client-api ──► Postgres policies, audit, approvals, org state
        ▲
        │
mobile-client
```

---

## 🚀 Where it runs

| Mode | Role |
| --- | --- |
| 🏢 Private Cloud | Customer-hosted managed API. |
| ☁️ OpenLeash Cloud | Wrapped by `cloud-client-api` for hosted tenancy and cloud controls. |

---

## 🔥 Responsibilities

- Receive normalized agent events from `desktop-client`
- Evaluate actions against policy and model providers
- Store audit, evaluations, MCP calls, skills, triggers, and pending approvals
- Run the ordered OpenLeash plugin pipeline for prompts, tools, agent responses, startup, sessions, MCP inventory, and skill changes
- Serve mobile approval and account state
- Enroll managed endpoints with deployment tokens
- Apply Postgres migrations safely through `schema_migrations`
- Provide extension points for hosted/private wrappers

---

## 🔌 Plugin architecture

Core protections are implemented as pipeline plugins. Each plugin declares a manifest with metadata, stages, permissions, settings, effects, and ordering. Implementations use stable runtime capabilities instead of importing OpenLeash internals.

Developer docs live in [`src/plugins/README.md`](src/plugins/README.md). Public examples live in [`open-leash/openleash-plugins`](https://github.com/open-leash/openleash-plugins).

---

## 🛠 Run locally

```bash
npm install
docker compose up -d postgres
npm run db:migrate
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
