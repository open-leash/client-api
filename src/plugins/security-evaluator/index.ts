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
  for (const result of failed) {
    await capabilities.signals.emit({
      kind: "security.finding",
      severity: result.status === "failed" ? "high" : result.severity,
      title: result.policyName,
      summary: result.explanation,
      decision: result.status === "failed" ? "blocked" : "ask",
      status: result.status,
      target: {
        type: input.request.event.tool?.name ? "tool_call" : "agent_event",
        name: input.request.event.tool?.name ?? input.request.event.eventName
      },
      evidence: result.evidence ?? [],
      details: {
        policyName: result.policyName,
        question: result.question,
        model
      },
      correlationKeys: [`policy:${result.policyName}`]
    });
    await capabilities.signals.emit({
      kind: "policy.decision",
      severity: result.severity,
      title: `${result.policyName}: ${result.status}`,
      summary: result.explanation,
      decision: result.status === "failed" ? "blocked" : "ask",
      status: result.status,
      target: {
        type: input.request.event.tool?.name ? "tool_call" : "agent_event",
        name: input.request.event.tool?.name ?? input.request.event.eventName
      },
      details: {
        policyName: result.policyName,
        model
      },
      correlationKeys: [`policy:${result.policyName}`]
    });
  }
  await capabilities.usage.record({
    kind: "plugin.operation",
    provider: "openleash-evaluator",
    model,
    quantity: results.length,
    unit: "policy_results",
    details: {
      policyCount: input.policies.length,
      reviewedCount: results.length,
      failedCount: failed.length
    }
  });
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
