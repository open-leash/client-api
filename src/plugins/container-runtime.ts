import crypto from "node:crypto";
import type {
  OpenLeashPluginManifest,
  PluginCatalogItem,
  PluginContainerExecution,
  PluginLogRequest,
  PluginIslandPublishRequest,
  PluginSignalRequest,
  PluginUsageRecordRequest,
} from "@openleash/shared";

export const CONTAINER_PLUGIN_PROTOCOL = "openleash-container-plugin.v1" as const;

export type JsonPatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
};

export type ContainerTransformRequest = {
  protocol: typeof CONTAINER_PLUGIN_PROTOCOL;
  requestId: string;
  plugin: { id: string; version: string };
  tenant: { organizationId: string; userId: string };
  event: "provider.request.beforeSend";
  context: {
    provider: string;
    agentKind: string;
    sessionId: string;
  };
  settings: {
    profileIds: string[];
    configHash: string;
  };
  config: Record<string, unknown>;
  payload: unknown;
};

export type ContainerTransformResponse = {
  protocol: typeof CONTAINER_PLUGIN_PROTOCOL;
  requestId: string;
  status: "unchanged" | "modified" | "skipped";
  patches?: JsonPatchOperation[];
  metrics?: Record<string, number | string | boolean | null>;
  ccrHashes?: string[];
  summary?: string;
  /** Host-mediated capability calls. The container never receives database or cloud credentials. */
  emissions?: {
    logs?: PluginLogRequest[];
    signals?: PluginSignalRequest[];
    usage?: PluginUsageRecordRequest[];
    island?: PluginIslandPublishRequest[];
  };
};

export type ContainerTransformResult = {
  payload: unknown;
  appliedPluginIds: string[];
  runs: Array<{
    pluginId: string;
    status: ContainerTransformResponse["status"] | "failed";
    summary?: string;
    metrics?: ContainerTransformResponse["metrics"];
    ccrHashes?: string[];
    durationMs?: number;
    emissions?: ContainerTransformResponse["emissions"];
  }>;
};

export async function executeContainerPluginTool(input: {
  plugin: PluginCatalogItem;
  organizationId: string;
  userId: string;
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}) {
  const execution = input.plugin.execution;
  if (!input.plugin.settings.enabled || execution?.type !== "container" || !execution.toolExecutePath) {
    throw new Error(`plugin ${input.plugin.id} does not expose tool execution`);
  }
  const requestId = crypto.randomUUID();
  const envelope = {
    protocol: CONTAINER_PLUGIN_PROTOCOL,
    requestId,
    plugin: { id: input.plugin.id, version: input.plugin.settings.installedVersion ?? input.plugin.version },
    tenant: { organizationId: input.organizationId, userId: input.userId },
    event: "plugin.tool.execute",
    context: { sessionId: input.sessionId },
    settings: settingsContext(input.plugin.settings),
    config: input.plugin.settings.config,
    tool: input.tool,
    arguments: input.arguments,
  };
  const env = input.env ?? process.env;
  const body = JSON.stringify(envelope);
  const timestamp = String(Date.now());
  const secret = String(env.OPENLEASH_PLUGIN_RUNTIME_SECRET ?? "");
  if (env.NODE_ENV === "production" && !secret) throw new Error("OPENLEASH_PLUGIN_RUNTIME_SECRET is required in production");
  const signature = secret ? crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex") : "";
  const response = await (input.fetchImpl ?? fetch)(
    joinUrl(endpointBaseForPlugin(input.plugin.id, env), execution.toolExecutePath),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openleash-plugin-protocol": CONTAINER_PLUGIN_PROTOCOL,
        "x-openleash-plugin-id": input.plugin.id,
        "x-openleash-plugin-version": envelope.plugin.version,
        "x-openleash-timestamp": timestamp,
        ...(signature ? { "x-openleash-signature": `sha256=${signature}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(execution.timeoutMs ?? 30_000),
    },
  );
  if (!response.ok) throw new Error(`container plugin ${input.plugin.id} tool returned HTTP ${response.status}`);
  const result = await response.json() as Record<string, unknown>;
  if (result.protocol !== CONTAINER_PLUGIN_PROTOCOL || result.requestId !== requestId) {
    throw new Error(`container plugin ${input.plugin.id} returned an incompatible tool response`);
  }
  return result;
}

const ALLOWED_PROVIDER_ROOTS = new Set([
  "messages",
  "input",
  "system",
  "tools",
  "prompt_cache_key",
]);

export async function transformWithContainerPlugins(input: {
  plugins: PluginCatalogItem[];
  organizationId: string;
  userId: string;
  provider: string;
  agentKind: string;
  sessionId: string;
  payload: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<ContainerTransformResult> {
  let payload = structuredClone(input.payload);
  const appliedPluginIds: string[] = [];
  const runs: ContainerTransformResult["runs"] = [];
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;

  for (const plugin of input.plugins.filter(isEnabledContainerPlugin)) {
    const startedAt = Date.now();
    const execution = plugin.execution!;
    try {
      const requestId = crypto.randomUUID();
      const request: ContainerTransformRequest = {
        protocol: CONTAINER_PLUGIN_PROTOCOL,
        requestId,
        plugin: { id: plugin.id, version: plugin.settings.installedVersion ?? plugin.version },
        tenant: {
          organizationId: input.organizationId,
          userId: input.userId,
        },
        event: "provider.request.beforeSend",
        context: {
          provider: input.provider,
          agentKind: input.agentKind,
          sessionId: input.sessionId,
        },
        settings: settingsContext(plugin.settings),
        config: plugin.settings.config,
        payload,
      };
      const response = await invokeContainerPlugin({
        plugin,
        execution,
        request,
        env,
        fetchImpl,
      });
      if (response.status === "modified") {
        payload = applyValidatedProviderPatches(payload, response.patches ?? []);
        appliedPluginIds.push(plugin.id);
      }
      runs.push({
        pluginId: plugin.id,
        status: response.status,
        summary: response.summary,
        metrics: response.metrics,
        ccrHashes: response.ccrHashes,
        emissions: response.emissions,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      runs.push({
        pluginId: plugin.id,
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      if ((execution.failureMode ?? "open") === "closed") throw error;
    }
  }
  return { payload, appliedPluginIds, runs };
}

export function applyValidatedProviderPatches(
  payload: unknown,
  patches: JsonPatchOperation[],
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("container plugin payload must be a JSON object");
  }
  if (patches.length > 256) throw new Error("container plugin returned too many patches");
  const result = structuredClone(payload) as Record<string, unknown>;
  for (const patch of patches) {
    const segments = jsonPointerSegments(patch.path);
    if (segments.length === 0 || !ALLOWED_PROVIDER_ROOTS.has(segments[0])) {
      throw new Error(`container plugin patch path is not allowed: ${patch.path}`);
    }
    applyPatch(result, patch, segments);
  }
  return result;
}

function isEnabledContainerPlugin(plugin: PluginCatalogItem) {
  return Boolean(
    plugin.settings.enabled &&
      plugin.settings.runtimeAvailable !== false &&
      plugin.execution?.type === "container" &&
      plugin.events.includes("provider.request.beforeSend"),
  );
}

function settingsContext(settings: PluginCatalogItem["settings"]) {
  return {
    profileIds: settings.effectiveProfileIds ?? [],
    configHash: crypto.createHash("sha256").update(JSON.stringify(settings.config)).digest("hex"),
  };
}

async function invokeContainerPlugin(input: {
  plugin: OpenLeashPluginManifest;
  execution: PluginContainerExecution;
  request: ContainerTransformRequest;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<ContainerTransformResponse> {
  const endpoint = endpointForPlugin(input.plugin.id, input.execution, input.env);
  const body = JSON.stringify(input.request);
  const timestamp = String(Date.now());
  const secret = String(input.env.OPENLEASH_PLUGIN_RUNTIME_SECRET ?? "");
  if (input.env.NODE_ENV === "production" && !secret) {
    throw new Error("OPENLEASH_PLUGIN_RUNTIME_SECRET is required in production");
  }
  const signature = secret
    ? crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
    : "";
  const response = await input.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openleash-plugin-protocol": CONTAINER_PLUGIN_PROTOCOL,
      "x-openleash-plugin-id": input.plugin.id,
      "x-openleash-plugin-version": input.request.plugin.version,
      "x-openleash-timestamp": timestamp,
      ...(signature ? { "x-openleash-signature": `sha256=${signature}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(input.execution.timeoutMs ?? 30_000),
  });
  if (!response.ok) {
    throw new Error(`container plugin ${input.plugin.id} returned HTTP ${response.status}`);
  }
  const result = (await response.json()) as Partial<ContainerTransformResponse>;
  if (result.protocol !== CONTAINER_PLUGIN_PROTOCOL) {
    throw new Error(`container plugin ${input.plugin.id} returned an incompatible protocol`);
  }
  if (result.requestId !== input.request.requestId) {
    throw new Error(`container plugin ${input.plugin.id} returned the wrong request id`);
  }
  if (!result.status || !["unchanged", "modified", "skipped"].includes(result.status)) {
    throw new Error(`container plugin ${input.plugin.id} returned an invalid status`);
  }
  return result as ContainerTransformResponse;
}

function endpointForPlugin(
  pluginId: string,
  execution: PluginContainerExecution,
  env: NodeJS.ProcessEnv,
) {
  const configured = parseEndpointMap(env.OPENLEASH_PLUGIN_ENDPOINTS)[pluginId];
  if (configured) return joinUrl(configured, execution.transformPath ?? "/v1/transform");
  const router = String(env.OPENLEASH_PLUGIN_RUNTIME_URL ?? "").trim();
  if (router) {
    return joinUrl(router, `/v1/plugins/${encodeURIComponent(pluginId)}/transform`);
  }
  throw new Error(`no container runtime endpoint is configured for ${pluginId}`);
}

function endpointBaseForPlugin(pluginId: string, env: NodeJS.ProcessEnv) {
  const configured = parseEndpointMap(env.OPENLEASH_PLUGIN_ENDPOINTS)[pluginId];
  if (configured) return configured;
  const router = String(env.OPENLEASH_PLUGIN_RUNTIME_URL ?? "").trim();
  if (router) return joinUrl(router, `/v1/plugins/${encodeURIComponent(pluginId)}`);
  throw new Error(`no container runtime endpoint is configured for ${pluginId}`);
}

function parseEndpointMap(value?: string) {
  if (!value?.trim()) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    throw new Error("OPENLEASH_PLUGIN_ENDPOINTS must be a JSON object of plugin ids to URLs");
  }
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function jsonPointerSegments(path: string) {
  if (!path.startsWith("/")) throw new Error(`invalid JSON patch path: ${path}`);
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function applyPatch(
  root: Record<string, unknown>,
  patch: JsonPatchOperation,
  segments: string[],
) {
  let parent: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!parent || typeof parent !== "object") throw new Error(`patch path does not exist: ${patch.path}`);
    parent = Array.isArray(parent)
      ? parent[arrayIndex(segment, parent.length, false)]
      : (parent as Record<string, unknown>)[segment];
  }
  if (!parent || typeof parent !== "object") throw new Error(`patch parent does not exist: ${patch.path}`);
  const key = segments.at(-1)!;
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length, patch.op === "add");
    if (patch.op === "remove") parent.splice(index, 1);
    else if (patch.op === "add") parent.splice(index, 0, structuredClone(patch.value));
    else parent[index] = structuredClone(patch.value);
    return;
  }
  const object = parent as Record<string, unknown>;
  if (patch.op === "remove") delete object[key];
  else object[key] = structuredClone(patch.value);
}

function arrayIndex(segment: string, length: number, allowAppend: boolean) {
  if (segment === "-" && allowAppend) return length;
  const index = Number(segment);
  if (!Number.isInteger(index) || index < 0 || index >= length + (allowAppend ? 1 : 0)) {
    throw new Error(`invalid JSON patch array index: ${segment}`);
  }
  return index;
}
