import { createPluginCapabilities } from "./capabilities.js";
import { executeContainerPluginEvent } from "./container-runtime.js";
import {
  pluginSupportsAgent,
  pluginsForEvent,
  orderPlugins,
} from "./registry.js";
import { eventForHookEvent } from "./events.js";
import {
  type EvaluationPipelineInput,
  type EvaluationPipelineResult,
  type PromptPipelineInput,
  type PromptPipelineResult,
} from "./types.js";
import type {
  OpenLeashPluginManifest,
  PipelineEvent,
  PluginCatalogItem,
  PluginSettingState,
} from "@openleash/shared";

export async function runPromptPipeline(
  input: PromptPipelineInput,
): Promise<PromptPipelineResult> {
  let current = input.request.event.prompt ?? "";
  const runs: PromptPipelineResult["runs"] = [];
  const models = new Set<string>();
  let compression: PromptPipelineResult["compression"];
  let dlp: PromptPipelineResult["dlp"];

  for (const plugin of enabledPluginsForEvent(
    "prompt.beforeSubmit",
    input.plugins,
    input.request.agent.kind,
  ).filter((plugin) => plugin.effects.includes("transform"))) {
    if (containerPluginAlreadyApplied(input.request, plugin.id)) continue;
    const capabilities = createPluginCapabilities({
      tenantModelKey: input.tenantModelKey,
      organizationId: input.organizationId,
      pluginId: plugin.id,
      request: input.request,
      conversationEventId: input.conversationEventId,
      userId: input.userId,
      computerId: input.computerId,
      runtimeId: input.runtimeId,
      permissions: plugin.permissions,
    });
    const settings = input.plugins?.get(plugin.id) ?? {
      enabled: true,
      config: plugin.defaultConfig ?? {},
    };
    const catalogPlugin: PluginCatalogItem = { ...plugin, settings };
    try {
      const step = await executeContainerPluginEvent<{
        prompt?: string;
        finalPrompt?: string;
        blocked?: boolean;
        summary?: string;
        model?: string;
        compression?: PromptPipelineResult["compression"];
        dlp?: PromptPipelineResult["dlp"];
        run?: PromptPipelineResult["runs"][number];
        runs?: PromptPipelineResult["runs"];
      }>({
        plugin: catalogPlugin,
        organizationId: requiredRuntimeScope(input.organizationId, "organization"),
        userId: requiredRuntimeScope(input.userId, "user"),
        event: "prompt.beforeSubmit",
        payload: {
          request: input.request,
          prompt: current,
          supportsPromptReplacement: sourceAllowsPromptReplacement(input.request),
        },
        capabilities,
      });
      current = step.finalPrompt ?? step.prompt ?? current;
      runs.push(...(step.runs ?? (step.run ? [step.run] : [])));
      if (step.model && step.model !== "none") models.add(step.model);
      if (step.compression) compression = step.compression;
      if (step.dlp) dlp = step.dlp;
      if (step.blocked) {
        return {
          finalPrompt: current,
          blocked: true,
          summary: step.summary ?? "A plugin blocked the prompt.",
          model: [...models].join(", ") || "none",
          compression,
          dlp,
          runs,
        };
      }
    } catch (error) {
      if ((plugin.execution?.failureMode ?? "closed") === "closed") throw error;
      runs.push({
        pluginId: plugin.id,
        event: "prompt.beforeSubmit",
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    finalPrompt: current,
    blocked: false,
    summary: promptPipelineSummary(
      input.request.event.prompt ?? "",
      current,
      compression,
      dlp,
    ),
    model: [...models].join(", ") || "none",
    compression,
    dlp,
    runs,
  };
}

function containerPluginAlreadyApplied(
  request: PromptPipelineInput["request"],
  pluginId: string,
) {
  const raw =
    request.event.raw && typeof request.event.raw === "object"
      ? (request.event.raw as Record<string, unknown>)
      : undefined;
  if (
    Array.isArray(raw?.containerPluginApplied) &&
    raw.containerPluginApplied.includes(pluginId)
  ) {
    return true;
  }
  // A container that successfully inspected a request owns that event even when
  // it returned `unchanged`. Re-running its legacy in-process implementation in
  // the cloud would duplicate work and can trigger a second model evaluation.
  return Array.isArray(raw?.containerPluginRuns) &&
    raw.containerPluginRuns.some((run) => {
      if (!run || typeof run !== "object") return false;
      const record = run as { pluginId?: unknown; status?: unknown };
      return record.pluginId === pluginId && record.status !== "failed";
    });
}

function sourceAllowsPromptReplacement(
  request: PromptPipelineInput["request"],
) {
  const raw =
    request.event.raw && typeof request.event.raw === "object"
      ? (request.event.raw as Record<string, unknown>)
      : undefined;
  const envelope =
    raw?.openleashEventEnvelope &&
    typeof raw.openleashEventEnvelope === "object"
      ? (raw.openleashEventEnvelope as {
          capabilities?: { rewritePrompt?: unknown };
        })
      : undefined;
  if (envelope) return envelope.capabilities?.rewritePrompt === true;
  // Legacy direct callers retain their protocol behavior until migrated to the envelope.
  return !["claude", "claude-code", "nanoclaw"].includes(
    String(request.agent.kind).toLowerCase(),
  );
}

export async function runEvaluationPipeline(
  input: EvaluationPipelineInput,
): Promise<EvaluationPipelineResult> {
  const event = eventForHookEvent(input.request.event.eventName);
  const steps = await Promise.all(
    enabledPluginsForEvent(event, input.plugins, input.request.agent.kind)
      // Prompt transformers own their prompt.beforeSubmit execution in
      // runPromptPipeline. Running them again here duplicates container work,
      // metrics, and notifications. Evaluation plugins remain owned here.
      .filter(
        (plugin) =>
          event !== "prompt.beforeSubmit" ||
          !plugin.effects.includes("transform"),
      )
      .map(
      async (plugin) => {
        if (containerPluginAlreadyApplied(input.request, plugin.id)) {
          return { results: [], runs: [], model: "none" };
        }
        const capabilities = createPluginCapabilities({
          tenantModelKey: input.tenantModelKey,
          organizationId: input.organizationId,
          pluginId: plugin.id,
          request: input.request,
          conversationEventId: input.conversationEventId,
          userId: input.userId,
          computerId: input.computerId,
          runtimeId: input.runtimeId,
          permissions: plugin.permissions,
        });
        const settings = input.plugins?.get(plugin.id) ?? {
          enabled: true,
          config: plugin.defaultConfig ?? {},
        };
        const catalogPlugin: PluginCatalogItem = { ...plugin, settings };
        try {
          const output = await executeContainerPluginEvent<{
            results?: EvaluationPipelineResult["results"];
            run?: EvaluationPipelineResult["runs"][number];
            runs?: EvaluationPipelineResult["runs"];
            model?: string;
            mcpCall?: EvaluationPipelineResult["mcpCall"];
          }>({
            plugin: catalogPlugin,
            organizationId: requiredRuntimeScope(input.organizationId, "organization"),
            userId: requiredRuntimeScope(input.userId, "user"),
            event,
            payload: {
              request: input.request,
              policies: input.policies,
              computerId: input.computerId,
              runtimeId: input.runtimeId,
              conversationEventId: input.conversationEventId,
            },
            capabilities,
          });
          return {
            results: output.results ?? [],
            runs: output.runs ?? (output.run ? [output.run] : []),
            model: output.model ?? "none",
            mcpCall: output.mcpCall,
          };
        } catch (error) {
          if ((plugin.execution?.failureMode ?? "closed") === "closed") throw error;
          return {
            results: [],
            runs: [{
              pluginId: plugin.id,
              event,
              status: "failed" as const,
              summary: error instanceof Error ? error.message : String(error),
            }],
            model: "none",
          };
        }
      },
    ),
  );

  return {
    results: steps.flatMap((step) => step.results),
    model:
      steps.map((step) => step.model).find((model) => model !== "none") ??
      "none",
    runs: steps.flatMap((step) => step.runs),
    mcpCall: steps.find((step) => step.mcpCall)?.mcpCall,
  };
}

function requiredRuntimeScope(value: string | undefined, label: string) {
  if (!value) throw new Error(`container plugin execution requires ${label} scope`);
  return value;
}

function enabledPluginsForEvent(
  event: PipelineEvent,
  settings?: Map<string, PluginSettingState>,
  agentKind?: string,
) {
  const plugins = pluginsForEvent(event)
    // This runtime is the managed/backend executor. Edge-only images are owned
    // by the desktop; "either" runs here only when no correlated edge result
    // was supplied with the event.
    .filter((plugin) => plugin.execution?.placement !== "edge")
    .filter(
      (plugin) =>
        plugin.executionEnvironment !== "cloud-only" ||
        isOpenLeashCloudRuntime(),
    )
    .filter((plugin) => {
      const state = settings?.get(plugin.id);
      return (settings ? state?.enabled === true : true) && state?.runtimeAvailable !== false;
    })
    .filter((plugin) => pluginSupportsAgent(plugin, agentKind))
    .map((plugin) => {
      const priority = settings?.get(plugin.id)?.orderingPriority;
      if (priority === undefined || priority === null) return plugin;
      return {
        ...plugin,
        ordering: {
          ...(plugin.ordering ?? {}),
          priority,
        },
      } satisfies OpenLeashPluginManifest;
    });
  return orderPlugins(plugins);
}

function isOpenLeashCloudRuntime() {
  return ["cloud", "public-cloud", "openleash-cloud"].includes(
    String(process.env.OPENLEASH_DEPLOYMENT_MODE ?? "").toLowerCase(),
  );
}

function promptPipelineSummary(
  originalPrompt: string,
  finalPrompt: string,
  compression?: PromptPipelineResult["compression"],
  dlp?: PromptPipelineResult["dlp"],
) {
  const parts: string[] = [];
  if (compression?.enabled) {
    const saved = Math.max(0, Math.round((1 - compression.ratio) * 100));
    parts.push(
      saved > 0
        ? `compressed prompt by ${saved}%`
        : "checked prompt compression",
    );
  }
  if (dlp?.enabled) {
    if (dlp.masked)
      parts.push(`masked ${dlp.categories.join(", ") || "sensitive data"}`);
    else if (dlp.matched)
      parts.push(`detected ${dlp.categories.join(", ") || "sensitive data"}`);
    else parts.push("checked DLP");
  }
  if (parts.length === 0) return "No prompt plugins were enabled.";
  if (finalPrompt !== originalPrompt)
    return `OpenLeash ${parts.join(" and ")}.`;
  return `OpenLeash ${parts.join(" and ")}. Prompt was unchanged.`;
}
