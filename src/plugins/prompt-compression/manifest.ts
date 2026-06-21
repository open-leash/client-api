import type { OpenLeashPluginManifest } from "@openleash/shared";

export const promptCompressionManifest: OpenLeashPluginManifest = {
  id: "openleash.prompt-compression",
  name: "Token Saver",
  description: "Trim noisy context before every model call.",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/prompt-compression",
  events: ["prompt.beforeSubmit"],
  permissions: ["event:read", "prompt:read", "prompt:write", "model:invoke", "audit:write"],
  effects: ["transform", "observe"],
  ordering: {
    priority: 100,
    before: ["openleash.dlp"]
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      level: { enum: ["light", "standard", "maximum"] },
      conciseResponse: { type: "boolean" },
      model: { type: "string" }
    }
  },
  defaultConfig: {
    enabled: false,
    level: "standard",
    conciseResponse: false
  },
  tags: ["tokens", "cost", "prompt"]
};
