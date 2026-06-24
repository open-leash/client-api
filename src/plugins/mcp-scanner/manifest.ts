import type { OpenLeashPluginManifest } from "@openleash/shared";

export const mcpScannerManifest: OpenLeashPluginManifest = {
  id: "openleash.mcp-scanner",
  name: "mcp-scanner",
  description: "See every MCP server, tool, and call.",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/mcp-scanner",
  events: ["tool.beforeUse", "tool.afterUse"],
  permissions: ["event:read", "tool:read", "audit:write", "signal:write"],
  effects: ["observe", "inventory"],
  ordering: {
    priority: 400,
    after: ["openleash.security-evaluator"]
  },
  defaultConfig: {
    enabled: true,
    redactSecrets: true
  },
  tags: ["mcp", "inventory", "audit"]
};
