import type { OpenLeashPluginManifest } from "@openleash/shared";

export const securityEvaluatorManifest: OpenLeashPluginManifest = {
  id: "openleash.security-evaluator",
  name: "Security Evaluator",
  description: "Approve, deny, or log risky agent actions.",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/security-evaluator",
  events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse"],
  permissions: ["event:read", "prompt:read", "tool:read", "decision:write", "model:invoke", "audit:write", "log:write", "notification:send"],
  effects: ["observe", "ask", "deny"],
  ordering: {
    priority: 300,
    after: ["openleash.dlp"]
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      policySet: { type: "string" }
    }
  },
  defaultConfig: {
    enabled: true,
    policySet: "active"
  },
  tags: ["security", "policy", "approval"]
};
