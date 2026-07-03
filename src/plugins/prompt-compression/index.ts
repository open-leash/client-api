import type { PluginCapabilities, PluginPromptCompressionConfig } from "@openleash/shared";
import { promptCompressionManifest as manifest } from "./manifest.js";
import { pluginRun, type PromptPipelineResult } from "../types.js";

export { manifest };

type TokenSaverLlmResult = {
  compressed: string;
  reason: string;
};

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
        event: "prompt.beforeSubmit",
        status: "skipped",
        summary: "Token saver is disabled.",
        startedAt
      })
    };
  }

  const llm = await capabilities.llm.evaluateJson<TokenSaverLlmResult>({
    purpose: "token-saver",
    system: tokenSaverSystemPrompt(config.level),
    prompt: JSON.stringify({
      level: config.level,
      conciseResponse: config.conciseResponse,
      text: prompt
    }),
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["compressed", "reason"],
      properties: {
        compressed: { type: "string" },
        reason: { type: "string" }
      }
    },
    temperature: 0,
    maxOutputTokens: maxOutputTokensFor(prompt, config.level)
  });
  const llmCompressed = typeof llm?.json?.compressed === "string" ? llm.json.compressed.trim() : "";
  let finalPrompt = usefulCompression(prompt, llmCompressed) ? llmCompressed : heuristicCompress(prompt, config.level);
  if (config.conciseResponse) {
    finalPrompt = `${finalPrompt.trim()}\n\nRespond concisely. Be short, direct, and avoid filler.`;
  }
  const model = llm?.model ?? "token-saver-heuristic";
  const compression: NonNullable<PromptPipelineResult["compression"]> = {
    enabled: true,
    originalLength: prompt.length,
    compressedLength: finalPrompt.length,
    ratio: prompt.length > 0 ? finalPrompt.length / prompt.length : 1
  };
  await capabilities.usage.record({
    kind: "llm.tokens",
    model,
    provider: llm?.provider ?? "openleash-plugin",
    inputTokens: prompt.length,
    outputTokens: finalPrompt.length,
    savedTokens: Math.max(0, prompt.length - finalPrompt.length),
    details: {
      level: config.level,
      conciseResponse: config.conciseResponse,
      reason: llm?.json?.reason,
      source: llm?.source ?? "heuristic",
      ratio: compression.ratio
    }
  });
  const summary = compressionSummary(prompt, finalPrompt, compression);
  const result = {
    finalPrompt,
    blocked: false,
    summary,
    model,
    compression
  };

  return {
    prompt: finalPrompt,
    result,
    run: pluginRun({
      pluginId: manifest.id,
      event: "prompt.beforeSubmit",
      status: finalPrompt !== prompt ? "modified" : "passed",
      summary,
      startedAt,
      metadata: {
        model,
        source: llm?.source ?? "heuristic",
        compression
      }
    })
  };
}

function tokenSaverSystemPrompt(level: PluginPromptCompressionConfig["level"]) {
  const aggressiveness = level === "maximum"
    ? "Compress aggressively."
    : level === "light"
      ? "Compress lightly."
      : "Compress moderately.";
  return [
    "You are the token-saver OpenLeash plugin.",
    aggressiveness,
    "Rewrite the provided prompt to use fewer tokens while preserving all user intent, hard constraints, security requirements, file paths, commands, identifiers, quoted values, and acceptance criteria.",
    "Do not add facts. Do not remove tasks. Do not summarize code or secrets away if they are required for the user's request.",
    "Return JSON only."
  ].join("\n");
}

function maxOutputTokensFor(prompt: string, level: PluginPromptCompressionConfig["level"]) {
  const divisor = level === "maximum" ? 5 : level === "light" ? 2 : 3;
  return Math.max(256, Math.min(4096, Math.ceil(prompt.length / divisor)));
}

function usefulCompression(original: string, candidate: string) {
  if (!candidate) return false;
  if (candidate.length >= original.length * 0.98) return false;
  if (candidate.length < 40 && original.length > 300) return false;
  return true;
}

function heuristicCompress(prompt: string, level: PluginPromptCompressionConfig["level"]) {
  const normalized = prompt.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (level === "light") return normalized;
  const limit = level === "maximum" ? 1800 : 3600;
  return normalized.length > limit ? `${normalized.slice(0, limit).trim()}\n\n[Token-saver removed repetitive trailing context.]` : normalized;
}

function compressionSummary(
  originalPrompt: string,
  finalPrompt: string,
  compression: NonNullable<PromptPipelineResult["compression"]>
) {
  if (finalPrompt === originalPrompt) return "Token saver checked with no changes.";
  return `Token saver reduced prompt from ${compression.originalLength} to ${compression.compressedLength} chars.`;
}
