import type { OpenLeashPluginManifest } from "@openleash/shared";

export const dlpManifest: OpenLeashPluginManifest = {
  id: "openleash.dlp",
  name: "data-leakage-prevention",
  description: "Mask secrets before agents send them.",
  repositoryUrl: "https://github.com/open-leash/plugin-data-leakage-prevention",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/dlp",
  events: ["prompt.beforeSubmit"],
  permissions: ["event:read", "prompt:read", "prompt:write", "decision:write", "model:invoke", "audit:write", "signal:write"],
  effects: ["transform", "deny", "observe"],
  ordering: {
    priority: 200,
    after: ["openleash.prompt-compression"]
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      action: { enum: ["mask", "block"] },
      categories: {
        type: "array",
        items: { enum: ["pii", "phi", "tokens", "keys", "credentials"] }
      },
      model: { type: "string" }
    }
  },
  defaultConfig: {
    enabled: false,
    action: "mask",
    categories: ["pii", "phi", "tokens", "keys", "credentials"]
  },
  tags: ["security", "privacy", "prompt"]
};
