import assert from "node:assert/strict";
import test from "node:test";
import { applyValidatedProviderPatches, executeContainerPluginEvent, executeContainerPluginTool, transformWithContainerPlugins } from "./container-runtime.js";
import type { PluginCapabilities, PluginCatalogItem } from "@openleash/shared";

test("applies only provider-safe JSON patches", () => {
  const result = applyValidatedProviderPatches(
    { model: "keep", messages: [{ role: "user", content: "large" }] },
    [{ op: "replace", path: "/messages/0/content", value: "small" }],
  ) as Record<string, unknown>;
  assert.equal(result.model, "keep");
  assert.equal((result.messages as Array<{ content: string }>)[0].content, "small");
  assert.throws(
    () => applyValidatedProviderPatches(result, [{ op: "replace", path: "/model", value: "steal" }]),
    /not allowed/,
  );
});

test("invokes enabled container plugins and validates correlation", async () => {
  const plugin: PluginCatalogItem = {
    id: "openleash.test",
    name: "test",
    description: "test",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "container",
    execution: {
      type: "container",
      placement: "either",
      protocol: "openleash-container-plugin.v1",
      image: "example/test:1.0.0",
    },
    entrypoint: "container",
    events: ["provider.request.beforeSend"],
    permissions: ["provider-request:read", "provider-request:write"],
    effects: ["transform"],
    settings: { enabled: true, config: {}, installedVersion: "1.0.0" },
  };
  const result = await transformWithContainerPlugins({
    plugins: [plugin],
    organizationId: "org",
    userId: "user",
    provider: "openai",
    agentKind: "codex",
    sessionId: "session",
    payload: { messages: [{ content: "before" }] },
    env: { OPENLEASH_PLUGIN_ENDPOINTS: JSON.stringify({ "openleash.test": "http://worker" }) },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        protocol: "openleash-container-plugin.v1",
        requestId: request.requestId,
        status: "modified",
        patches: [{ op: "replace", path: "/messages/0/content", value: "after" }],
        emissions: {
          logs: [{ level: "info", message: "compressed" }],
          usage: [{ kind: "llm.tokens", savedTokens: 42 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(result.appliedPluginIds, ["openleash.test"]);
  assert.equal((result.payload as any).messages[0].content, "after");
  assert.equal(result.runs[0]?.emissions?.logs?.[0]?.message, "compressed");
  assert.equal(result.runs[0]?.emissions?.usage?.[0]?.savedTokens, 42);
});

test("refuses unsigned container traffic in production", async () => {
  const plugin = {
    id: "openleash.test",
    name: "test",
    description: "test",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "container",
    execution: {
      type: "container",
      placement: "server",
      protocol: "openleash-container-plugin.v1",
      image: "example/test:1.0.0",
      failureMode: "closed",
    },
    entrypoint: "container",
    events: ["provider.request.beforeSend"],
    permissions: ["provider-request:read"],
    effects: [],
    settings: { enabled: true, config: {}, installedVersion: "1.0.0" },
  } as PluginCatalogItem;
  await assert.rejects(
    transformWithContainerPlugins({
      plugins: [plugin],
      organizationId: "org",
      userId: "user",
      provider: "openai",
      agentKind: "codex",
      sessionId: "session",
      payload: { messages: [] },
      env: {
        NODE_ENV: "production",
        OPENLEASH_PLUGIN_ENDPOINTS: JSON.stringify({ "openleash.test": "http://worker" }),
      },
      fetchImpl: async () => new Response("should not be called"),
    }),
    /RUNTIME_SECRET is required/,
  );
});

test("executes a correlated plugin tool through the same signed runtime", async () => {
  const plugin = {
    id: "openleash.retrieve",
    name: "retrieve",
    description: "test",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "container",
    execution: {
      type: "container",
      placement: "server",
      protocol: "openleash-container-plugin.v1",
      image: "example/retrieve:1.0.0",
      toolExecutePath: "/v1/tools/execute",
    },
    entrypoint: "container",
    events: ["plugin.tool.execute"],
    permissions: ["storage:read"],
    effects: [],
    settings: { enabled: true, config: {}, installedVersion: "1.0.0" },
  } as PluginCatalogItem;
  const result = await executeContainerPluginTool({
    plugin,
    organizationId: "org",
    userId: "user",
    sessionId: "session",
    tool: "retrieve",
    arguments: { hash: "abc" },
    env: { OPENLEASH_PLUGIN_ENDPOINTS: JSON.stringify({ "openleash.retrieve": "http://worker" }), OPENLEASH_PLUGIN_RUNTIME_SECRET: "secret" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.match(String((init?.headers as Record<string, string>)["x-openleash-signature"]), /^sha256=/);
      return new Response(JSON.stringify({ protocol: "openleash-container-plugin.v1", requestId: request.requestId, status: "ok", content: "original" }));
    },
  });
  assert.equal(result.content, "original");
});

test("round-trips privileged capabilities without giving the container credentials", async () => {
  const plugin = {
    id: "openleash.review",
    name: "review",
    description: "test",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "container",
    execution: {
      type: "container",
      placement: "server",
      protocol: "openleash-container-plugin.v1",
      image: "example/review:1.0.0",
      eventPath: "/v1/events",
    },
    entrypoint: "container",
    events: ["tool.beforeUse"],
    permissions: ["event:read", "model:invoke", "decision:write"],
    effects: ["ask"],
    settings: { enabled: true, config: {}, installedVersion: "1.0.0" },
  } as PluginCatalogItem;
  let calls = 0;
  const capabilities = {
    llm: {
      evaluateJson: async () => ({ json: { risky: true }, model: "test", provider: "test", source: "heuristic" }),
    },
  } as unknown as PluginCapabilities;
  const result = await executeContainerPluginEvent<{ decision: string }>({
    plugin,
    organizationId: "org",
    userId: "user",
    event: "tool.beforeUse",
    payload: { tool: { name: "Bash" } },
    capabilities,
    env: {
      OPENLEASH_PLUGIN_ENDPOINTS: JSON.stringify({ "openleash.review": "http://worker" }),
      OPENLEASH_PLUGIN_RUNTIME_SECRET: "secret",
    },
    fetchImpl: async (_url, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.tenant.organizationId, "org");
      assert.equal("providerKey" in request, false);
      const body = calls === 1
        ? {
            protocol: "openleash-container-plugin.v1",
            requestId: request.requestId,
            status: "capability_required",
            capabilityRequests: [{ id: "llm-1", capability: "llm.evaluateJson", request: { prompt: "review" } }],
          }
        : {
            protocol: "openleash-container-plugin.v1",
            requestId: request.requestId,
            status: "completed",
            output: { decision: request.capabilityResults["llm-1"].value.json.risky ? "ask" : "allow" },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.decision, "ask");
});
