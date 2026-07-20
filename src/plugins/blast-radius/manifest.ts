import type { OpenLeashPluginManifest } from "@openleash/shared";

export const blastRadiusManifest: OpenLeashPluginManifest = {
  id: "openleash.blast-radius",
  slug: "blast-radius",
  name: "blast-radius",
  description: "Block destructive tool use before agents damage files, databases, or infrastructure.",
  repositoryUrl: "https://github.com/open-leash/plugin-blast-radius",
  version: "1.0.2",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/blast-radius",
  events: ["prompt.beforeSubmit", "tool.beforeUse"],
  permissions: ["event:read", "prompt:read", "tool:read", "decision:write", "audit:write", "log:write", "signal:write", "island:publish"],
  effects: ["observe", "ask", "deny"],
  ordering: {
    priority: 220,
    before: ["openleash.rules-enforcer", "openleash.mcp-scanner"]
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      destructiveAction: { enum: ["ask", "block"] },
      databaseMutationAction: { enum: ["ask", "block"] },
      broadFilesystemAction: { enum: ["ask", "block"] }
    }
  },
  defaultConfig: {
    enabled: true,
    destructiveAction: "block",
    databaseMutationAction: "ask",
    broadFilesystemAction: "block"
  },
  tags: ["security", "destructive", "database", "tools"]
};
