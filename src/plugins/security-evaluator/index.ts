import type { PluginCapabilities } from "@openleash/shared";
import { securityEvaluatorManifest as manifest } from "./manifest.js";
import { stageForHookEvent } from "../stages.js";
import { pluginRun, type EvaluationPipelineInput } from "../types.js";

export { manifest };

export async function runSecurityEvaluator(input: EvaluationPipelineInput, capabilities: PluginCapabilities) {
  const startedAt = Date.now();
  const { results, model } = await capabilities.security.evaluatePolicies({
    request: input.request,
    policies: input.policies
  });
  const failed = results.filter((result) => result.status === "failed" || result.status === "needs_question");
  return {
    results,
    model,
    run: pluginRun({
      pluginId: manifest.id,
      stage: stageForHookEvent(input.request.event.eventName),
      status: failed.some((result) => result.status === "failed") ? "blocked" : failed.length ? "needs_question" : "passed",
      summary: failed.length
        ? `${failed.length} policy result${failed.length === 1 ? "" : "s"} need review.`
        : "All active policies passed.",
      startedAt,
      findings: failed.map((result) => ({
        title: result.policyName,
        severity: result.severity,
        summary: result.explanation,
        evidence: result.evidence
      })),
      metadata: { model }
    })
  };
}
