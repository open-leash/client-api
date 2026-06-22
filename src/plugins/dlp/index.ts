import type { PluginCapabilities, PluginDlpConfig } from "@openleash/shared";
import { dlpManifest as manifest } from "./manifest.js";
import { pluginRun, type PromptPipelineResult } from "../types.js";

export { manifest };

export async function runDlp({
  prompt,
  config,
  capabilities,
  startedAt
}: {
  prompt: string;
  config: PluginDlpConfig;
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
        summary: "DLP is disabled.",
        startedAt
      })
    };
  }

  const inspected = await capabilities.dlp.inspect({
    prompt,
    action: config.action,
    categories: config.categories,
    model: config.model
  });
  const dlp: NonNullable<PromptPipelineResult["dlp"]> = {
    enabled: true,
    action: config.action,
    matched: inspected.matched,
    categories: inspected.categories,
    findings: inspected.findings,
    masked: inspected.masked
  };
  const summary = dlpSummary(dlp, inspected.blocked);
  if (inspected.matched) {
    await capabilities.signals.emit({
      kind: "secret.detected",
      severity: inspected.blocked ? "high" : "medium",
      title: inspected.blocked ? "Sensitive data blocked" : "Sensitive data detected",
      summary,
      decision: inspected.blocked ? "blocked" : inspected.masked ? "observed" : "allow",
      status: inspected.masked ? "masked" : inspected.blocked ? "blocked" : "detected",
      target: { type: "prompt", name: "agent prompt" },
      evidence: inspected.findings.map((finding) => ({
        category: finding.category,
        reason: finding.reason,
        quote: finding.quote
      })),
      details: {
        categories: inspected.categories,
        action: config.action,
        model: inspected.model
      },
      correlationKeys: inspected.categories.map((category) => `dlp:${category}`)
    });
  }
  const result = {
    finalPrompt: inspected.prompt,
    blocked: inspected.blocked,
    summary,
    model: inspected.model,
    dlp
  };

  return {
    prompt: inspected.prompt,
    result,
    run: pluginRun({
      pluginId: manifest.id,
      event: "prompt.beforeSubmit",
      status: inspected.blocked ? "blocked" : inspected.masked ? "modified" : "passed",
      summary,
      startedAt,
      findings: inspected.findings.map((finding) => ({
        title: `${finding.category.toUpperCase()} detected`,
        severity: inspected.blocked ? "high" : "medium",
        summary: finding.reason,
        evidence: [finding.quote]
      })),
      metadata: {
        model: inspected.model,
        dlp
      }
    })
  };
}

function dlpSummary(dlp: NonNullable<PromptPipelineResult["dlp"]>, blocked: boolean) {
  if (!dlp.matched) return "DLP checked with no sensitive data detected.";
  const categories = dlp.categories.join(", ") || "sensitive data";
  if (blocked) return `DLP blocked prompt submission: ${categories}.`;
  if (dlp.masked) return `DLP masked ${categories}.`;
  return `DLP detected ${categories}.`;
}
