import type { OpenLeashPluginManifest } from "@openleash/shared";

export const skillScannerManifest: OpenLeashPluginManifest = {
  id: "openleash.skill-scanner",
  name: "skill-scanner",
  description: "Catch suspicious instructions before they spread.",
  repositoryUrl: "https://github.com/open-leash/plugin-skill-scanner",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/skill-scanner",
  events: ["openleash.startup", "agent.detected", "skill.changed"],
  permissions: ["event:read", "filesystem:read", "decision:write", "model:invoke", "audit:write", "log:write", "signal:write", "notification:send"],
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
