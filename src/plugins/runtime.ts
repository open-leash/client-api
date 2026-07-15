import { createPluginCapabilities } from "./capabilities.js";
import { runBlastRadius } from "./blast-radius/index.js";
import { runDlp } from "./dlp/index.js";
import { runCodeScanner } from "./code-scanner/index.js";
import { runMcpScanner } from "./mcp-scanner/index.js";
import { runPromptCompression } from "./prompt-compression/index.js";
import {
  pluginSupportsAgent,
  pluginsForEvent,
  orderPlugins,
} from "./registry.js";
import { runSecurityEvaluator } from "./security-evaluator/index.js";
import { runSensitiveAccess } from "./sensitive-access/index.js";
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
  )) {
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
    });
    if (plugin.id === "openleash.prompt-compression") {
      const step = await runPromptCompression({
        prompt: current,
        config: input.config.compression,
        capabilities,
        startedAt: Date.now(),
        supportsPromptReplacement: sourceAllowsPromptReplacement(input.request),
      });
      current = step.prompt;
      runs.push(step.run);
      if (step.result?.model) models.add(step.result.model);
      if (step.result?.compression) compression = step.result.compression;
      continue;
    }

    if (plugin.id === "openleash.dlp") {
      const step = await runDlp({
        prompt: current,
        config: input.config.dlp,
        capabilities,
        startedAt: Date.now(),
      });
      current = step.prompt;
      runs.push(step.run);
      if (step.result?.model) models.add(step.result.model);
      if (step.result?.dlp) dlp = step.result.dlp;
      if (step.result?.blocked) {
        return {
          finalPrompt: current,
          blocked: true,
          summary: step.result.summary,
          model: [...models].join(", ") || "none",
          compression,
          dlp,
          runs,
        };
      }
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
  return Array.isArray(raw?.containerPluginApplied) &&
    raw.containerPluginApplied.includes(pluginId);
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
    enabledPluginsForEvent(event, input.plugins, input.request.agent.kind).map(
      async (plugin) => {
        const capabilities = createPluginCapabilities({
          tenantModelKey: input.tenantModelKey,
          organizationId: input.organizationId,
          pluginId: plugin.id,
          request: input.request,
          conversationEventId: input.conversationEventId,
          userId: input.userId,
          computerId: input.computerId,
          runtimeId: input.runtimeId,
        });
        if (plugin.id === "openleash.sensitive-access") {
          const sensitive = await runSensitiveAccess(input, capabilities);
          return {
            results: sensitive.results,
            runs: [sensitive.run],
            model: "none",
          };
        }

        if (plugin.id === "openleash.code-scanner") {
          const run = await runCodeScanner(
            input.request,
            event,
            capabilities,
            input.plugins?.get(plugin.id)?.config,
          );
          return {
            results: [],
            runs: [run],
            model: String(run.metadata?.evaluatedBy ?? "none"),
          };
        }

        if (plugin.id === "openleash.blast-radius") {
          const blastRadius = await runBlastRadius(input, capabilities);
          return {
            results: blastRadius.results,
            runs: [blastRadius.run],
            model: "none",
          };
        }

        if (plugin.id === "openleash.rules-enforcer") {
          const security = await runSecurityEvaluator(input, capabilities);
          return {
            results: security.results,
            runs: [security.run],
            model: security.model,
          };
        }

        if (plugin.id === "openleash.mcp-scanner") {
          const mcp = await runMcpScanner(input, capabilities);
          return {
            results: [],
            runs: [mcp.run],
            model: "none",
            mcpCall: mcp.call,
          };
        }
        return { results: [], runs: [], model: "none" };
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

function enabledPluginsForEvent(
  event: PipelineEvent,
  settings?: Map<string, PluginSettingState>,
  agentKind?: string,
) {
  const plugins = pluginsForEvent(event)
    .filter(
      (plugin) =>
        plugin.executionEnvironment !== "cloud-only" ||
        isOpenLeashCloudRuntime(),
    )
    .filter((plugin) => {
      const state = settings?.get(plugin.id);
      return (state?.enabled ?? true) && state?.runtimeAvailable !== false;
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
