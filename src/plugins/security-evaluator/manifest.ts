import { firstPartyEventContainer, type OpenLeashPluginManifest } from "@openleash/shared";

export const securityEvaluatorManifest: OpenLeashPluginManifest = {
  id: "openleash.rules-enforcer",
  name: "rules-enforcer",
  description: "Watch agent conversations and pause when configured rules are violated.",
  repositoryUrl: "https://github.com/open-leash/plugin-rules-enforcer",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "container",
  execution: firstPartyEventContainer("rules-enforcer", "1.0.0"),
  entrypoint: "container",
  events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse"],
  permissions: ["event:read", "prompt:read", "tool:read", "decision:write", "model:invoke", "audit:write", "log:write", "signal:write", "usage:write", "notification:send"],
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
      rules: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            action: { type: "string", enum: ["ask", "block"] }
          }
        }
      }
    }
  },
  defaultConfig: {
    enabled: true,
    rules: []
  },
  tags: ["security", "rules", "policy", "approval"]
};
