# OpenLeash Pipeline Plugins

OpenLeash features run as ordered pipeline plugins. Plugins can use the trusted in-process core runtime or the language-independent container runtime. A plugin is described by a versioned manifest; in-process plugins also contain an `index.ts` implementation, while container plugins publish an OCI image.

- `manifest.ts` - metadata, events, permissions, effects, ordering, and config schema.
- `index.ts` - the implementation used by the runtime.

Current first-party plugins:

- `token-saver` runs as a Headroom-powered container on `provider.request.beforeSend` and may safely patch provider messages or input before the request leaves the machine.
- `data-leakage-prevention` runs after token-saver on `prompt.beforeSubmit` and may mask or block.
- `sensitive-access` reviews env-file reads, secret exposure, env dumps, and exfiltration attempts.
- `blast-radius` guards destructive tools and broad data operations.
- `rules-enforcer` evaluates active policies for prompts, agent responses, and tool actions.
- `mcp-scanner` observes MCP tool calls and records inventory.
- `skill-scanner` observes skill changes and can create a review finding.
- `siem-exporter` sends events and plugin logs to configured SIEM targets.

## Ordering

Plugin order is declared in the manifest:

```ts
ordering: {
  priority: 100,
  before: ["openleash.dlp"],
  after: ["openleash.prompt-compression"]
}
```

`before` and `after` are resolved first. `priority` is the stable fallback when no dependency exists.

For prompts, ordering matters:

```text
token-saver -> data-leakage-prevention -> sensitive-access
```

Token-saver runs first so data-leakage-prevention checks the final prompt that would be sent to the model.

For tool events:

```text
sensitive-access -> blast-radius -> rules-enforcer -> mcp-scanner
```

Sensitive-access and blast-radius catch specialized risks before rules-enforcer applies general policy. The MCP scanner then records inventory with the resulting decision context.

## Permissions

Permissions are declarative and should match what the implementation actually needs:

- `prompt:read` / `prompt:write`
- `tool:read`
- `decision:write`
- `model:invoke`
- `instructions:read`
- `filesystem:read` / `filesystem:write` only for reviewed first-party or explicitly approved plugins
- `storage:read` / `storage:write`
- `audit:write`
- `log:write`
- `signal:write`
- `usage:write`
- `notification:send`
- `island:publish`

The container runtime validates the declared event, limits mutation to approved provider-payload roots, signs every invocation, and applies the manifest failure mode. Permissions still remain part of review and policy; they are not a substitute for the container sandbox.

## Container Runtime v1

Container plugins use `openleash-container-plugin.v1`. The local proxy never calls a plugin container. It sends the structured provider request to the local `client-api` edge, which invokes enabled containers over loopback. Hosted `client-api` instances invoke an already-warm service pool through the same envelope.

The required endpoints are:

- `GET /healthz`
- `POST /v1/transform`
- `POST /v1/tools/execute` when the manifest advertises tool execution

Requests carry a correlation ID, exact plugin ID/version, tenant/user/session scope, config, and payload. They are HMAC-signed with a short-lived runtime secret. Responses must echo the protocol and correlation ID. Transform responses return constrained JSON Patch operations; containers never receive database credentials, provider credentials, a Docker socket, or direct OpenLeash internals. Desktop containers have networking disabled unless a reviewed manifest explicitly declares `network:access`; the desktop edge tunnels signed HTTP to the container's own loopback API with `docker exec`. The first-party Token Saver therefore has no runtime network route at all.

Desktop lifecycle is desired-state reconciliation: login/catalog sync installs enabled edge images, health-checks a candidate, switches versions with a rollback container retained until success, and removes disabled containers. Published community images require an immutable digest. Cloud runs reviewed shared plugins in a warm autoscaled pool; plugins that need stronger isolation declare `tenant-dedicated` or `customer-hosted` placement instead.

## Capability Boundary

Plugins must not import OpenLeash internals such as evaluators, database modules, prompt transforms, server handlers, or model-key readers. Those files are implementation details and can change without becoming a plugin breaking change.

Instead, plugin code receives stable primitive capabilities from the runtime. Product logic belongs in the plugin. For example, a DLP plugin owns its detectors, prompt, schema, masking rules, and parser; OpenLeash only supplies the configured evaluator LLM and trusted sinks.

```ts
const review = await capabilities.llm.evaluateJson({
  purpose: "acme-risk-review",
  system: "You are the Acme risk plugin. Return JSON only.",
  prompt: JSON.stringify({ text: event.prompt, rules: config.rules }),
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["risk", "reason"],
    properties: {
      risk: { type: "string", enum: ["low", "medium", "high"] },
      reason: { type: "string" }
    }
  }
});
const instructionFiles = await capabilities.context.instructions.list({ scope: "project" });
await capabilities.storage.set({ key: "last-risk", value: { score: 82 } });
const recent = await capabilities.storage.list({ keyPrefix: "sessions/", limit: 25 });
await capabilities.log.emit({ level: "security", message: "Custom evaluator flagged a risky action." });
await capabilities.signals.emit({ kind: "security.finding", severity: "high", title: "Risky action blocked." });
await capabilities.usage.record({ kind: "llm.tokens", inputTokens: 8000, savedTokens: 2400 });
await capabilities.island.annotateSession({
  key: "risk",
  label: "Destructive operation",
  value: "critical",
  tone: "danger"
});
```

If a plugin needs a new privileged operation, add a narrow capability to the shared plugin contract first, declare the matching permission in the manifest, and let the OpenLeash runtime adapt that capability to internal providers. Do not add broad domain capabilities such as `dlp.inspect`, `prompt.compress`, or `security.evaluatePolicies`; those make plugins thin wrappers over OpenLeash internals and prevent third-party developers from shipping real plugin logic. This keeps external plugins contained while still allowing OpenLeash to share configured model access, deterministic fallbacks, audit sinks, plugin-scoped storage, plugin/system logs, SIEM export, security signals, usage records, or other approved services.

The Live Sessions island follows the same boundary. Plugins publish typed annotations, activity, progress, or ambient status through `capabilities.island`; OpenLeash owns the renderer and only exposes a small allowlist of safe navigation actions. Plugins never send HTML, CSS, JavaScript, arbitrary URLs, or custom IPC. See `docs/PLUGIN_ISLAND.md` for the complete developer contract and container emission shape.

## Settings And Agent Scope

Plugin authors define one `configSchema` and consume one resolved `input.config`. They do not implement product-mode, organization-role, employee, or profile-merging logic. OpenLeash resolves those concerns before each invocation:

```text
manifest defaults
  -> organization base settings
  -> matching organization profiles by priority
  -> user base settings, unless locked
  -> matching user profiles by priority, unless locked
```

A profile may target agent kinds such as `claude-code` or `codex`, exact authenticated/enrolled runtime IDs, or both. The runtime envelope includes the resolved configuration, its hash, and the matching profile IDs. A container must treat that configuration as request-scoped data; it must not retain one tenant's settings in global mutable state.

Organization policy controls four separate things: mandatory installation, default enablement, permission to add optional plugins, and permission to customize settings. A mandatory plugin can remain configurable. A plugin developer does not need branches for these combinations: OpenLeash prevents forbidden removal/overrides and supplies the already-resolved effective state.

The same contract is used by Individual Open Source, personal OpenLeash Cloud, organization OpenLeash Cloud, and Private Cloud. Use `executionEnvironment: "cloud-only"` only when the implementation truly depends on OpenLeash-operated infrastructure. OpenLeash surfaces that restriction and refuses activation in Individual Open Source and Private Cloud.

## Host Context And Instruction Files

External plugins do not get general access to the computer running the agent. They should not walk the host filesystem, read arbitrary files, shell out to local tools, or assume they run beside the user's project. OpenLeash owns host discovery and exposes only reviewed context through explicit capabilities or event payloads.

Agent instruction files are the canonical example. Files such as `CLAUDE.md`, `AGENTS.md`, Cursor rules, Cline rules, OpenCode rules, Windsurf rules, and Copilot instructions may be useful to a plugin, but they are still host files. OpenLeash discovers known global and project instruction locations, normalizes the results, and serves them through:

```ts
const files = await capabilities.context.instructions.list();
```

Each item contains:

```ts
{
  agent: "Claude Code",
  scope: "project",
  label: "Project CLAUDE.md",
  path: "/workspace/CLAUDE.md",
  content: "...",
  parsedLines: ["Ask before publishing changes", "..."]
}
```

Plugins may use the raw `content`, use `parsedLines`, or parse the content themselves. The important boundary is that OpenLeash decides which files are discoverable and when they are attached to the plugin context. A plugin that wants one more host-derived data source should request a new narrow capability such as `context.instructions`, not a broad filesystem permission.

## Build A Plugin

Start from the manifest, then write one handler per event. Keep the plugin understandable enough that someone can review its permissions without reading the whole implementation.

1. Pick the narrowest event.
2. Declare only the permissions the plugin needs.
3. Expose settings through `configSchema` and `defaultConfig`.
4. Put plugin-specific model prompts, parsing, prompt transforms, DLP rules, and decisions in the plugin; use runtime capabilities only for primitive services such as LLM calls, storage, notifications, signals, usage, and audit logs.
5. Return a typed plugin run/result. Do not write directly to OpenLeash product tables.

Minimal manifest:

```ts
export const manifest = {
  id: "acme.prompt-labeler",
  name: "Prompt Labeler",
  version: "1.0.0",
  publisher: "acme",
  runtime: "node",
  entrypoint: "src/index.ts",
  events: ["prompt.beforeSubmit"],
  permissions: ["event:read", "prompt:read", "audit:write", "storage:write"],
  effects: ["observe"],
  ordering: {
    priority: 250,
    after: ["openleash.dlp"]
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      label: { type: "string" }
    }
  },
  defaultConfig: {
    enabled: true,
    label: "reviewed"
  }
};
```

Minimal handler:

```ts
export async function run(input, capabilities) {
  if (!input.config.enabled) {
    return {
      status: "skipped",
      summary: "Prompt Labeler is disabled."
    };
  }

  await capabilities.storage.set({
    scope: { sessionId: input.event.sessionId },
    key: "labels/latest",
    value: {
      label: input.config.label,
      at: Date.now()
    },
    ttlSeconds: 24 * 60 * 60
  });

  return {
    status: "passed",
    summary: "Prompt labeled.",
    findings: [{
      title: "Prompt label",
      severity: "info",
      summary: input.config.label
    }]
  };
}
```

External examples should live in their own public GitHub repositories. First-party plugins use one repository per plugin under the `open-leash/plugin-*` pattern and mirror the preinstalled plugins as readable reference implementations.

## Plugin Storage

Plugins should not create their own database or import OpenLeash database modules. OpenLeash owns tenancy, migrations, backup, encryption policy, and public/private cloud portability.

Use `capabilities.storage` for plugin-owned JSON state. Think of it as a small document store, not raw SQL. Storage is scoped by:

```text
organization_id + plugin_id + scope + key
```

The runtime supplies `organization_id` and `plugin_id`; plugin code supplies only the logical scope and key. One plugin cannot read or write another plugin's records because `plugin_id` is injected by the runtime, not accepted from plugin code.

Recommended key shapes:

```text
sessions/<session-id>/summary
heuristics/<user-id>/risk-profile
cache/<hash>
notifications/<dedupe-key>
```

Available operations:

- `get({ key, scope })`
- `set({ key, value, scope, ttlSeconds })`
- `list({ keyPrefix, scope, limit })`
- `delete({ key, scope })`

Limits:

- Values must be JSON-serializable.
- `list` is capped by the runtime.
- Expired rows are ignored automatically.
- Plugins cannot run arbitrary SQL or join OpenLeash product tables.
- If a plugin needs indexed analytics, add a new reviewed storage capability instead of importing database internals.

Example: a prompt evaluator wants session-aware memory and notification dedupe:

```ts
const scope = {
  sessionId: input.request.event.sessionId,
  conversationId: input.request.event.raw?.conversation_id
};

const previous = await capabilities.storage.get({
  scope,
  key: "notifications/customer-data-risk"
});

const recentSessionFacts = await capabilities.storage.list({
  scope,
  keyPrefix: "sessions/",
  limit: 20
});

if (!previous) {
  await capabilities.storage.set({
    scope,
    key: "notifications/customer-data-risk",
    value: {
      title: "Risky prompt needs review",
      reason: "Prompt asked the agent to expose customer data.",
      sessionFactCount: recentSessionFacts.length
    },
    ttlSeconds: 5 * 60 * 60
  });

  return pluginRun({
    pluginId: manifest.id,
    event: "prompt.beforeSubmit",
    status: "needs_question",
    summary: "Prompt evaluator found a risk that needs review.",
    startedAt,
    findings: [{
      title: "Risky prompt",
      severity: "high",
      summary: "Prompt asked the agent to expose customer data."
    }]
  });
}
```

That returned finding/`needs_question` is what OpenLeash core turns into the actual approval flow. The plugin does not directly pop a desktop window; OpenLeash core owns desktop, mobile, dashboard, audit, notification policy, SIEM export, and native hook response delivery.

## Security Signals And CISO Reporting

Logs are useful for operators and SIEM export, but CISO dashboards need normalized records. Plugins should report incidents, findings, discoveries, policy decisions, and inventory observations with `capabilities.signals.emit`.

OpenLeash injects trusted context into every signal:

```text
organization_id
plugin_id
conversation_event_id
user_id
computer_id
agent_runtime_id
```

Plugin code can describe what happened, but it cannot choose a different organization, impersonate another user, or write raw dashboard rows. Identity sync stays in OpenLeash core: users and groups come from the configured IdP, endpoint enrollment links devices to users, and the runtime attaches that context to plugin records.

Example rules-enforcer output:

```ts
await capabilities.signals.emit({
  kind: "security.finding",
  severity: "high",
  title: "Destructive shell command blocked",
  summary: "The agent attempted to remove a protected directory.",
  decision: "blocked",
  status: "contained",
  target: { command: "rm -rf ./prod-data" },
  evidence: [{ type: "policy", value: "destructive-command" }],
  details: { policyIds: ["prod-safety"] },
  correlationKeys: ["user:current", "command:rm-rf", "policy:prod-safety"]
});
```

The dashboard reads OpenLeash-owned `plugin_signals`, not plugin databases. It can show:

- latest incidents and findings;
- affected synced employees;
- sources by plugin;
- contained or blocked outcomes;
- cross-plugin correlations by shared user, conversation, device, or explicit `correlationKeys`.

This means a better third-party rules plugin can coexist with the first-party rules-enforcer. Each plugin emits its own signals, OpenLeash stores them with trusted context, and the dashboard correlates normalized data without letting plugins access each other's tables.

## Usage And Cost Reporting

Plugins report cost, token savings, scans, model calls, and other measurable activity with `capabilities.usage.record`. The runtime stamps the same trusted organization, user, device, runtime, and conversation context.

```ts
await capabilities.usage.record({
  kind: "llm.tokens",
  provider: "openleash-evaluator",
  model: "policy-eval",
  inputTokens: 4200,
  outputTokens: 300,
  savedTokens: 1600,
  estimatedCostUsd: 0.018,
  details: { reason: "prompt-compression" }
});
```

The CISO sees usage by plugin and employee in the dashboard. A cost-focused plugin does not need database access to be useful; it only needs `usage:write`.

## Plugin And System Logs

Plugins emit structured logs through `capabilities.log.emit`. The runtime injects the organization, plugin id, user, host, runtime, and conversation event linkage; plugin code cannot write arbitrary audit rows or pretend to be another plugin.

```ts
await capabilities.log.emit({
  level: "security",
  category: "security",
  code: "custom-risk",
  message: "Custom evaluator flagged a risky action.",
  data: { riskScore: 91 }
});
```

OpenLeash core can write its own `openleash.core` system log records for product events such as held approvals or backend failures. The SIEM exporter subscribes to both streams as `log.emitted`, so SOC tools can receive OpenLeash system messages and plugin messages without giving plugins direct network or database access.

Notification capabilities follow the same rule: a plugin can request or dedupe a notification-shaped event, but OpenLeash core owns whether it is sent, suppressed, silenced, rate-limited, or routed elsewhere.

## Events

Use the narrowest event possible:

- `openleash.startup`
- `agent.detected`
- `skill.detected`
- `skill.changed`
- `skill.removed`
- `log.emitted`
- `prompt.beforeSubmit`
- `agent.response`
- `tool.beforeUse`
- `tool.afterUse`
- `session.started`
- `session.ended`

`agent.response` is the post-answer event. Claude-style `Stop`, `Notification`, and subagent completion hooks map here because they represent agent output or completion after work has happened.

## Result Shape

Plugins should return typed findings and plugin run records instead of writing directly to unrelated tables.
The hook pipeline is responsible for merging results, storing audit payloads, and returning native agent hook responses.
