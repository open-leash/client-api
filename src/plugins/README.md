# OpenLeash Pipeline Plugins

OpenLeash features run as ordered pipeline plugins. A plugin is a folder with:

- `manifest.ts` - metadata, events, permissions, effects, ordering, and config schema.
- `index.ts` - the implementation used by the runtime.

Current first-party plugins:

- `prompt-compression` runs on `prompt.beforeSubmit` and may modify the prompt.
- `dlp` runs after compression on `prompt.beforeSubmit` and may mask or block.
- `security-evaluator` evaluates active policies for prompts, agent responses, and tool actions.
- `mcp-scanner` observes MCP tool calls and records inventory.
- `skill-scanner` observes skill changes and can create a review finding.

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
prompt-compression -> dlp
```

Compression runs first so DLP checks the final prompt that would be sent to the model.

For tool events:

```text
security-evaluator -> mcp-scanner
```

The security evaluator decides whether human review is needed. The MCP scanner then records inventory with the resulting decision context.

## Permissions

Permissions are declarative and should match what the implementation actually needs:

- `prompt:read` / `prompt:write`
- `tool:read`
- `decision:write`
- `model:invoke`
- `filesystem:read` / `filesystem:write`
- `storage:read` / `storage:write`
- `audit:write`
- `notification:send`

The current runtime uses these for catalog and UI clarity. External plugin isolation should enforce them before third-party plugins are supported.

## Capability Boundary

Plugins must not import OpenLeash internals such as evaluators, database modules, prompt transforms, server handlers, or model-key readers. Those files are implementation details and can change without becoming a plugin breaking change.

Instead, plugin code receives stable capabilities from the runtime:

```ts
await capabilities.prompt.compress({ prompt, level: "standard" });
await capabilities.dlp.inspect({ prompt, action: "mask", categories: ["pii"] });
await capabilities.storage.set({ key: "last-risk", value: { score: 82 } });
const recent = await capabilities.storage.list({ keyPrefix: "sessions/", limit: 25 });
```

If a plugin needs a new privileged operation, add a narrow capability to the shared plugin contract first, declare the matching permission in the manifest, and let the OpenLeash runtime adapt that capability to internal providers. This keeps external plugins contained while still allowing OpenLeash to share configured model access, deterministic fallbacks, audit sinks, plugin-scoped storage, or other approved services.

## Build A Plugin

Start from the manifest, then write one handler per event. Keep the plugin understandable enough that someone can review its permissions without reading the whole implementation.

1. Pick the narrowest event.
2. Declare only the permissions the plugin needs.
3. Expose settings through `configSchema` and `defaultConfig`.
4. Use runtime capabilities for model calls, prompt transforms, DLP, storage, notifications, and audit.
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

External examples live in `open-leash/plugins`. The first-party plugin repos mirror the preinstalled plugins and are intended to be readable reference implementations.

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

That returned finding/`needs_question` is what OpenLeash core turns into the actual approval flow. The plugin does not directly pop a desktop window; OpenLeash core owns desktop, mobile, dashboard, audit, and native hook response delivery.

## Events

Use the narrowest event possible:

- `openleash.startup`
- `agent.detected`
- `skill.changed`
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
