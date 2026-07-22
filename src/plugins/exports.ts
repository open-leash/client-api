import type {
  EvaluationRequest,
  PipelineEvent,
  PluginLogRecord,
  PluginCapabilities,
  PluginCatalogItem,
  PluginRunRecord,
  PluginSettingState,
  PolicyDecision
} from "@openleash/shared";
import { pluginsForEvent, orderPlugins } from "./registry.js";
import { executeContainerPluginEvent } from "./container-runtime.js";

export type PluginExportContext = {
  request: EvaluationRequest;
  event: PipelineEvent;
  decision: "allow" | "ask" | "deny";
  summary: string;
  evaluationId?: string;
  conversationEventId: string;
  organization: { id: string; name?: string; slug?: string | null };
  user: { id: string; email?: string; displayName?: string };
  computerId?: string;
  runtimeId?: string;
  policyResults?: PolicyDecision[];
  pluginRuns?: PluginRunRecord[];
  pluginLogs?: PluginLogRecord[];
  plugins?: Map<string, PluginSettingState>;
};

export type PluginLogExportContext = {
  log: PluginLogRecord;
  organization: { id: string; name?: string; slug?: string | null };
  user?: { id?: string; email?: string; displayName?: string };
  request?: EvaluationRequest;
  conversationEventId?: string | null;
  plugins?: Map<string, PluginSettingState>;
};

export async function runExportPlugins(input: PluginExportContext): Promise<PluginRunRecord[]> {
  const runs: PluginRunRecord[] = [];
  for (const plugin of enabledExportPlugins(input.event, input.plugins)) {
    const config = pluginConfig(plugin.id, input.plugins);
    runs.push(await runContainerExporter(plugin, config, input.event, { ...input, config }));
  }
  return runs;
}

export async function runLogExportPlugins(input: PluginLogExportContext): Promise<PluginRunRecord[]> {
  const runs: PluginRunRecord[] = [];
  for (const plugin of enabledExportPlugins("log.emitted", input.plugins)) {
    const config = pluginConfig(plugin.id, input.plugins);
    runs.push(await runContainerExporter(plugin, config, "log.emitted", { ...input, config }));
  }
  return runs;
}

function enabledExportPlugins(event: PipelineEvent, settings?: Map<string, PluginSettingState>) {
  const candidates = pluginsForEvent(event)
    .filter((plugin) => plugin.effects.includes("notify"))
    .filter((plugin) => plugin.permissions.includes("network:access"))
    .filter((plugin) => settings?.get(plugin.id)?.enabled ?? true)
    .map((plugin) => {
      const priority = settings?.get(plugin.id)?.orderingPriority;
      if (priority === undefined || priority === null) return plugin;
      return {
        ...plugin,
        ordering: {
          ...(plugin.ordering ?? {}),
          priority
        }
      };
    });
  return orderPlugins(candidates);
}

function pluginConfig(pluginId: string, settings?: Map<string, PluginSettingState>) {
  const stored = settings?.get(pluginId);
  return {
    ...(stored?.config ?? {}),
    enabled: Boolean(stored?.enabled)
  };
}

async function runContainerExporter(
  plugin: ReturnType<typeof enabledExportPlugins>[number],
  config: Record<string, unknown>,
  event: PipelineEvent,
  payload: (PluginExportContext | PluginLogExportContext) & { config: Record<string, unknown> },
): Promise<PluginRunRecord> {
  const organizationId = payload.organization.id;
  const userId = "user" in payload && payload.user?.id ? payload.user.id : "system";
  const settings = { enabled: true, config, ...(payload.plugins?.get(plugin.id) ?? {}) };
  const catalogPlugin: PluginCatalogItem = { ...plugin, settings };
  try {
    const output = await executeContainerPluginEvent<{ run?: PluginRunRecord }>({
      plugin: catalogPlugin,
      organizationId,
      userId,
      event,
      payload,
      capabilities: {} as PluginCapabilities,
    });
    return output.run ?? {
      pluginId: plugin.id,
      event,
      status: "failed",
      summary: "Container plugin returned no run record.",
    };
  } catch (error) {
    if ((plugin.execution?.failureMode ?? "closed") === "closed") throw error;
    return {
      pluginId: plugin.id,
      event,
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}
