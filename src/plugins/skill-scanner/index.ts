import { skillScannerManifest as manifest } from "./manifest.js";
import { pluginRun, type SkillObservationInput, type SkillObservationResult } from "../types.js";

export { manifest };

const DEFAULT_SUSPICIOUS_RISK_THRESHOLD = 50;

export function runSkillScanner(input: SkillObservationInput): SkillObservationResult {
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
