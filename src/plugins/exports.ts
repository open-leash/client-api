import type {
  EvaluationRequest,
  PipelineEvent,
  PluginLogRecord,
  PluginRunRecord,
  PluginSettingState,
  PolicyDecision
} from "@openleash/shared";
import { pluginsForEvent, orderPlugins } from "./registry.js";
import { runSiemExporter, runSiemLogExporter } from "./siem-exporter/index.js";

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
    if (plugin.id === "openleash.siem-exporter") {
      runs.push(await runSiemExporter({ ...input, config }));
      continue;
    }
    runs.push(skippedUnknownExporter(plugin.id, input.event));
  }
  return runs;
}

export async function runLogExportPlugins(input: PluginLogExportContext): Promise<PluginRunRecord[]> {
  const runs: PluginRunRecord[] = [];
  for (const plugin of enabledExportPlugins("log.emitted", input.plugins)) {
    const config = pluginConfig(plugin.id, input.plugins);
    if (plugin.id === "openleash.siem-exporter") {
      runs.push(await runSiemLogExporter({ ...input, config }));
      continue;
    }
    runs.push(skippedUnknownExporter(plugin.id, "log.emitted"));
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

function skippedUnknownExporter(pluginId: string, event: PipelineEvent): PluginRunRecord {
  return {
    pluginId,
    event,
    status: "skipped",
    summary: "No runtime implementation is registered for this exporter plugin.",
    durationMs: 0
  };
}
