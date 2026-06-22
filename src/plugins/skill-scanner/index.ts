import type { PluginCapabilities } from "@openleash/shared";
import { skillScannerManifest as manifest } from "./manifest.js";
import { pluginRun, type SkillObservationInput, type SkillObservationResult } from "../types.js";

export { manifest };

const DEFAULT_SUSPICIOUS_RISK_THRESHOLD = 50;

export async function runSkillScanner(input: SkillObservationInput, capabilities?: PluginCapabilities): Promise<SkillObservationResult> {
  const startedAt = Date.now();
  const riskScore = Math.max(0, Math.min(100, Number(input.riskScore ?? 0)));
  const suspicious =
    input.status === "suspicious" ||
    input.reasons.length > 0 ||
    riskScore >= DEFAULT_SUSPICIOUS_RISK_THRESHOLD;
  const status = suspicious ? "suspicious" : "observed";
  const normalizedRiskScore = suspicious && riskScore === 0 ? 70 : riskScore;
  const findings = input.reasons.map((reason) => ({
    title: "Suspicious skill behavior",
    severity: "high" as const,
    summary: reason.reason,
    evidence: reason.quote ? [reason.quote] : undefined
  }));
  if (capabilities && suspicious) {
    await capabilities.signals.emit({
      kind: "security.finding",
      severity: "high",
      title: "Suspicious skill behavior",
      summary: "Skill scanner found behavior that needs review.",
      decision: "ask",
      status,
      target: {
        type: "agent_skill",
        name: input.skillName
      },
      evidence: input.reasons,
      details: {
        skillName: input.skillName,
        skillPath: input.skillPath,
        agentKind: input.agentKind,
        agentName: input.agentName,
        riskScore: normalizedRiskScore
      },
      correlationKeys: [`skill:${input.skillName}`, `agent:${input.agentKind}`]
    });
  }

  return {
    status,
    riskScore: normalizedRiskScore,
    reasons: input.reasons,
    findings,
    run: pluginRun({
      pluginId: manifest.id,
      event: "skill.changed",
      status: suspicious ? "needs_question" : "passed",
      summary: suspicious
        ? "Skill scanner found behavior that needs review."
        : "Skill scanner observed the skill without suspicious findings.",
      startedAt,
      findings,
      metadata: {
        skillName: input.skillName,
        skillPath: input.skillPath
      }
    })
  };
}
