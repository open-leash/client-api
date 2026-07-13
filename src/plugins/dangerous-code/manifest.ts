import type { AgentKind, OpenLeashPluginManifest } from "@openleash/shared";

export const DANGEROUS_CODE_AGENT_KINDS: AgentKind[] = [
  "claude-code",
  "codex",
  "openai-codex-cloud",
  "cursor",
  "github-copilot",
  "gemini",
  "opencode",
  "cline",
  "continue",
  "windsurf",
  "kiro",
  "aider",
  "zed",
];

export const dangerousCodeManifest: OpenLeashPluginManifest & {
  agentKinds: AgentKind[];
} = {
  id: "openleash.dangerous-code",
  slug: "dangerous-code",
  name: "dangerous-code",
  description:
    "Review AI-generated code for exploitable vulnerabilities and notify the developer.",
  repositoryUrl: "https://github.com/open-leash/plugin-dangerous-code",
  version: "1.0.0",
  publisher: "openleash",
  runtime: "openleash-core",
  entrypoint: "plugins/dangerous-code",
  events: ["agent.response", "tool.beforeUse"],
  agentKinds: DANGEROUS_CODE_AGENT_KINDS,
  permissions: [
    "event:read",
    "tool:read",
    "model:invoke",
    "audit:write",
    "log:write",
    "signal:write",
    "notification:send",
  ],
  effects: ["observe", "notify"],
  ordering: { priority: 260, before: ["openleash.rules-enforcer"] },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      notificationRiskThreshold: { type: "number", minimum: 0, maximum: 100 },
      minimumCodeCharacters: { type: "number", minimum: 40, maximum: 4000 },
    },
  },
  defaultConfig: {
    enabled: true,
    notificationRiskThreshold: 70,
    minimumCodeCharacters: 80,
  },
  tags: ["security", "code", "vulnerabilities", "vibe-coding", "notifications"],
};
