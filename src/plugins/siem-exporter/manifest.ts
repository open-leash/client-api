import type { OpenLeashPluginManifest } from "@openleash/shared";

export const siemExporterManifest: OpenLeashPluginManifest = {
  id: "openleash.siem-exporter",
  slug: "siem-exporter",
  name: "siem-exporter",
  description: "Send agent incidents to your SOC stack.",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/siem-exporter",
  events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse", "session.started", "session.ended", "skill.changed", "log.emitted"],
  permissions: ["event:read", "prompt:read", "tool:read", "network:access", "audit:write", "log:write"],
  effects: ["observe", "notify"],
  ordering: { priority: 900, after: ["openleash.security-evaluator", "openleash.mcp-scanner"] },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      protocol: { enum: ["ecs-json", "splunk-hec", "generic-webhook"] },
      endpointUrl: { type: "string" },
      bearerToken: { type: "string" },
      hecToken: { type: "string" },
      source: { type: "string" },
      sourcetype: { type: "string" },
      index: { type: "string" },
      minSeverity: { enum: ["info", "low", "medium", "high", "critical"] },
      includePrompt: { type: "boolean" },
      includeToolArguments: { type: "boolean" }
    }
  },
  defaultConfig: {
    enabled: false,
    protocol: "ecs-json",
    endpointUrl: "",
    bearerToken: "",
    hecToken: "",
    source: "openleash",
    sourcetype: "openleash:security",
    index: "security",
    minSeverity: "info",
    includePrompt: false,
    includeToolArguments: false
  },
  tags: ["siem", "soc", "ecs", "splunk", "syslog", "incident-response"]
};
