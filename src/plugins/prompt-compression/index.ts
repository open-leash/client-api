import type { PluginCapabilities, PluginPromptCompressionConfig } from "@openleash/shared";
import { promptCompressionManifest as manifest } from "./manifest.js";
import { pluginRun, type PromptPipelineResult } from "../types.js";

export { manifest };

export async function runPromptCompression({
  prompt,
  config,
  capabilities,
  startedAt
}: {
  prompt: string;
  config: PluginPromptCompressionConfig;
  capabilities: PluginCapabilities;
  startedAt: number;
}) {
  if (!config.enabled) {
    return {
      prompt,
      result: undefined,
      run: pluginRun({
        pluginId: manifest.id,
        stage: "prompt.beforeSubmit",
        status: "skipped",
        summary: "Prompt compression is disabled.",
        startedAt
      })
    };
  }

  const compressed = await capabilities.prompt.compress({
    prompt,
    level: config.level,
    conciseResponse: config.conciseResponse,
    model: config.model
  });
  const compression: NonNullable<PromptPipelineResult["compression"]> = {
    enabled: true,
    originalLength: compressed.originalLength,
    compressedLength: compressed.compressedLength,
    ratio: compressed.ratio
  };
  const summary = compressionSummary(prompt, compressed.prompt, compression);
  const result = {
    finalPrompt: compressed.prompt,
    blocked: false,
    summary,
    model: compressed.model,
    compression
  };

  return {
    prompt: compressed.prompt,
    result,
    run: pluginRun({
      pluginId: manifest.id,
      stage: "prompt.beforeSubmit",
      status: compressed.prompt !== prompt ? "modified" : "passed",
      summary,
      startedAt,
      metadata: {
        model: compressed.model,
        compression
      }
    })
  };
}

function compressionSummary(
  originalPrompt: string,
  finalPrompt: string,
  compression: NonNullable<PromptPipelineResult["compression"]>
) {
  if (finalPrompt === originalPrompt) return "Prompt compression checked with no changes.";
  return `Prompt compressed from ${compression.originalLength} to ${compression.compressedLength} chars.`;
}
