import { createPluginCapabilities } from "./capabilities.js";
import { runDlp } from "./dlp/index.js";
import { runMcpScanner } from "./mcp-scanner/index.js";
import { runPromptCompression } from "./prompt-compression/index.js";
import { pluginsForEvent, orderPlugins } from "./registry.js";
import { runSecurityEvaluator } from "./security-evaluator/index.js";
import { eventForHookEvent } from "./events.js";
import {
  type EvaluationPipelineInput,
  type EvaluationPipelineResult,
  type PromptPipelineInput,
  type PromptPipelineResult
} from "./types.js";
import type { OpenLeashPluginManifest, PipelineEvent, PluginSettingState } from "@openleash/shared";

export async function runPromptPipeline(input: PromptPipelineInput): Promise<PromptPipelineResult> {
  let current = input.request.event.prompt ?? "";
  const runs: PromptPipelineResult["runs"] = [];
  const models = new Set<string>();
  let compression: PromptPipelineResult["compression"];
  let dlp: PromptPipelineResult["dlp"];

  for (const plugin of enabledPluginsForEvent("prompt.beforeSubmit", input.plugins)) {
    const capabilities = createPluginCapabilities({
      apiKey: input.apiKey,
      organizationId: input.organizationId,
      pluginId: plugin.id,
      request: input.request,
      conversationEventId: input.conversationEventId,
      userId: input.userId,
      computerId: input.computerId,
      runtimeId: input.runtimeId
    });
    if (plugin.id === "openleash.prompt-compression") {
      const step = await runPromptCompression({
        prompt: current,
        config: input.config.compression,
        capabilities,
        startedAt: Date.now()
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
        startedAt: Date.now()
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
          runs
        };
      }
    }
  }

  return {
    finalPrompt: current,
    blocked: false,
    summary: promptPipelineSummary(input.request.event.prompt ?? "", current, compression, dlp),
    model: [...models].join(", ") || "none",
    compression,
    dlp,
    runs
  };
}

export async function runEvaluationPipeline(input: EvaluationPipelineInput): Promise<EvaluationPipelineResult> {
  let results: EvaluationPipelineResult["results"] = [];
  let model = "none";
  const runs: EvaluationPipelineResult["runs"] = [];
  let mcpCall: EvaluationPipelineResult["mcpCall"];
  const event = eventForHookEvent(input.request.event.eventName);

  for (const plugin of enabledPluginsForEvent(event, input.plugins)) {
    const capabilities = createPluginCapabilities({
      tenantModelKey: input.tenantModelKey,
      organizationId: input.organizationId,
      pluginId: plugin.id,
      request: input.request,
      conversationEventId: input.conversationEventId,
      userId: input.userId,
      computerId: input.computerId,
      runtimeId: input.runtimeId
    });
    if (plugin.id === "openleash.rules-enforcer") {
      const security = await runSecurityEvaluator(input, capabilities);
      results = security.results;
      model = security.model;
      runs.push(security.run);
      continue;
    }

    if (plugin.id === "openleash.mcp-scanner") {
      const mcp = await runMcpScanner(input, capabilities);
      mcpCall = mcp.call;
      runs.push(mcp.run);
    }
  }

  return {
    results,
    model,
    runs,
    mcpCall
  };
}

function enabledPluginsForEvent(event: PipelineEvent, settings?: Map<string, PluginSettingState>) {
  const plugins = pluginsForEvent(event)
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
      } satisfies OpenLeashPluginManifest;
    });
  return orderPlugins(plugins);
}

function promptPipelineSummary(
  originalPrompt: string,
  finalPrompt: string,
  compression?: PromptPipelineResult["compression"],
  dlp?: PromptPipelineResult["dlp"]
) {
  const parts: string[] = [];
  if (compression?.enabled) {
    const saved = Math.max(0, Math.round((1 - compression.ratio) * 100));
    parts.push(saved > 0 ? `compressed prompt by ${saved}%` : "checked prompt compression");
  }
  if (dlp?.enabled) {
    if (dlp.masked) parts.push(`masked ${dlp.categories.join(", ") || "sensitive data"}`);
    else if (dlp.matched) parts.push(`detected ${dlp.categories.join(", ") || "sensitive data"}`);
    else parts.push("checked DLP");
  }
  if (parts.length === 0) return "No prompt plugins were enabled.";
  if (finalPrompt !== originalPrompt) return `OpenLeash ${parts.join(" and ")}.`;
  return `OpenLeash ${parts.join(" and ")}. Prompt was unchanged.`;
}
