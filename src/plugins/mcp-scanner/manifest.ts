import { firstPartyEventContainer, type OpenLeashPluginManifest } from "@openleash/shared";

export const mcpScannerManifest: OpenLeashPluginManifest = {
  id: "openleash.mcp-scanner",
  name: "mcp-scanner",
  description: "See every MCP server, tool, and call.",
  repositoryUrl: "https://github.com/open-leash/plugin-mcp-scanner",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "container",
  execution: firstPartyEventContainer("mcp-scanner", "1.0.0"),
  entrypoint: "container",
  events: ["tool.beforeUse", "tool.afterUse"],
  permissions: ["event:read", "tool:read", "audit:write", "signal:write"],
  effects: ["observe", "inventory"],
  ordering: {
    priority: 400,
    after: ["openleash.rules-enforcer"]
  },
  defaultConfig: {
    enabled: true,
    redactSecrets: true
  },
  tags: ["security", "mcp", "inventory", "audit"]
};
