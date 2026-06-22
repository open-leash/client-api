import type { PluginCapabilities } from "@openleash/shared";
import { securityEvaluatorManifest as manifest } from "./manifest.js";
import { eventForHookEvent } from "../events.js";
import { pluginRun, type EvaluationPipelineInput } from "../types.js";

export { manifest };

export async function runSecurityEvaluator(input: EvaluationPipelineInput, capabilities: PluginCapabilities) {
  const startedAt = Date.now();
  const { results, model } = await capabilities.security.evaluatePolicies({
    request: input.request,
    policies: input.policies
  });
  const failed = results.filter((result) => result.status === "failed" || result.status === "needs_question");
  if (failed.length > 0) {
    await capabilities.log.emit({
      level: failed.some((result) => result.status === "failed") ? "security" : "warn",
      category: "security",
      code: "policy-review-required",
      message: failed.length === 1
        ? `Policy review required: ${failed[0].policyName}.`
        : `${failed.length} policy results require review.`,
      data: {
        policyNames: failed.map((result) => result.policyName),
        severities: failed.map((result) => result.severity)
      }
    });
  }
  return {
    results,
    model,
    run: pluginRun({
      pluginId: manifest.id,
      event: eventForHookEvent(input.request.event.eventName),
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
