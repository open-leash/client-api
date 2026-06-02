# OpenLeash Client API 🧠⚡

[![Open Core](https://img.shields.io/badge/open--core-yes-111718)](#)
[![Surface](https://img.shields.io/badge/surface-client_api-0c8b67)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3975a8)](#)
[![Postgres](https://img.shields.io/badge/postgres-required-4169e1)](#)

The client-facing OpenLeash API. Desktop hooks, endpoint enrollment, mobile approvals, policy evaluation, audit ingestion, MCP telemetry, skill observations, and update checks speak here.

## Where It Fits

```text
desktop-client local API -> client-api -> policies + audit + approvals
mobile-client ----------^
```

Standalone desktop mode does not require this service. Managed self-hosted and OpenLeash Cloud do.

## Responsibilities

- Receive normalized local-agent events from `desktop-client`
- Evaluate actions against enabled policies
- Store events, evaluations, policy results, MCP calls, skills, and pending approvals
- Serve mobile approval state
- Enroll managed endpoints with deployment tokens
- Serve desktop update metadata
- Export extension points for private cloud wrappers

## Run Locally

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

Smoke an evaluation:

```bash
OPENLEASH_CLIENT_API_URL=http://localhost:9318 ./scripts/smoke-evaluate.sh
```

## Deployment Modes

| Mode | What happens |
| --- | --- |
| Standalone | Hooks call `desktop-client` local API; evaluation can happen locally. |
| Managed self-hosted | Desktop forwards to a customer-hosted `client-api`. |
| OpenLeash Cloud | Private `cloud-client-api` wraps this core and adds hosted tenant enforcement. |

## Extension Pattern

Do not fork the API to add hosted behavior. Import it and wrap it:

```ts
import { app as coreApp, prepareOpenLeashApi } from "@openleash/client-api";

await prepareOpenLeashApi({ app: coreApp, surface: "client" });
wrapper.use(cloudTenantMiddleware);
wrapper.use(coreApp);
```

## Security Notes

- Tokens are hashed before storage.
- CORS is restricted to local and configured dashboard origins.
- No production dev token is seeded unless explicitly configured.
- Keep secrets in environment or a vault, never in fixtures or code.
