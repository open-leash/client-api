import type { OpenLeashPluginManifest } from "@openleash/shared";

export const skillScannerManifest: OpenLeashPluginManifest = {
  id: "openleash.skill-scanner",
  name: "Skill Scanner",
  description: "Scans agent skills for suspicious instructions and records skill inventory.",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/skill-scanner",
  stages: ["openleash.startup", "agent.detected", "skill.changed"],
  permissions: ["event:read", "filesystem:read", "decision:write", "model:invoke", "audit:write", "notification:send"],
  effects: ["observe", "ask", "inventory"],
  ordering: {
    priority: 150
  },
  defaultConfig: {
    enabled: true,
    suspiciousRiskThreshold: 50
  },
  tags: ["skills", "security", "inventory"]
};
