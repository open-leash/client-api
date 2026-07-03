import type { OpenLeashPluginManifest } from "@openleash/shared";

export const sensitiveAccessManifest: OpenLeashPluginManifest = {
  id: "openleash.sensitive-access",
  slug: "sensitive-access",
  name: "sensitive-access",
  description: "Catch agents reading secrets, printing env vars, or touching credential files.",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/sensitive-access",
  events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse"],
  permissions: ["event:read", "prompt:read", "tool:read", "model:invoke", "decision:write", "audit:write", "log:write", "signal:write"],
  effects: ["observe", "ask", "deny"],
  ordering: {
    priority: 180,
    before: ["openleash.dlp", "openleash.blast-radius", "openleash.rules-enforcer"]
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      secretFileAction: { enum: ["ask", "block"] },
      envDumpAction: { enum: ["ask", "block"] },
      exfiltrationAction: { enum: ["ask", "block"] }
    }
  },
  defaultConfig: {
    enabled: true,
    secretFileAction: "ask",
    envDumpAction: "block",
    exfiltrationAction: "block"
  },
  tags: ["security", "secrets", "credentials", "privacy"]
};
