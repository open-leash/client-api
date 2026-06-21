# OpenLeash Pipeline Plugins

OpenLeash features run as ordered pipeline plugins. A plugin is a folder with:

- `manifest.ts` - metadata, stages, permissions, effects, ordering, and config schema.
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
```

If a plugin needs a new privileged operation, add a narrow capability to the shared plugin contract first, declare the matching permission in the manifest, and let the OpenLeash runtime adapt that capability to internal providers. This keeps external plugins contained while still allowing OpenLeash to share configured model access, deterministic fallbacks, audit sinks, plugin-scoped storage, or other approved services.

## Plugin Storage

Plugins should not create their own database or import OpenLeash database modules. OpenLeash owns tenancy, migrations, backup, encryption policy, and public/private cloud portability.

Use `capabilities.storage` for plugin-owned state. Storage is scoped by:

```text
organization_id + plugin_id + scope + key
```

The runtime supplies `organization_id` and `plugin_id`; plugin code supplies only the logical scope and key.

Example: a prompt evaluator should not show the same notification twice within five hours for the same session and conversation:

```ts
const scope = {
  sessionId: input.request.event.sessionId,
  conversationId: input.request.event.raw?.conversation_id
};

const previous = await capabilities.storage.get({
  scope,
  key: "risky-prompt-notification"
});

if (!previous) {
  await capabilities.storage.set({
    scope,
    key: "risky-prompt-notification",
    value: {
      title: "Risky prompt needs review",
      reason: "Prompt asked the agent to expose customer data."
    },
    ttlSeconds: 5 * 60 * 60
  });

  return pluginRun({
    pluginId: manifest.id,
    stage: "prompt.beforeSubmit",
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

## Stages

Use the narrowest stage possible:

- `openleash.startup`
- `agent.detected`
- `skill.changed`
- `prompt.beforeSubmit`
- `agent.response`
- `tool.beforeUse`
- `tool.afterUse`
- `session.started`
- `session.ended`

`agent.response` is the post-answer stage. Claude-style `Stop`, `Notification`, and subagent completion hooks map here because they represent agent output or completion after work has happened.

## Result Shape

Plugins should return typed findings and plugin run records instead of writing directly to unrelated tables.
The hook pipeline is responsible for merging results, storing audit payloads, and returning native agent hook responses.
