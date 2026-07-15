import type { AgentKind, PluginSettingProfile } from "@openleash/shared";

const AGENT_KINDS = new Set<AgentKind>([
  "claude-code", "codex", "openclaw", "nanoclaw", "salesforce-agentforce",
  "azure-ai-foundry", "microsoft-copilot-studio", "aws-bedrock-agentcore",
  "google-vertex-ai", "n8n", "zapier-agents", "openai-codex-cloud", "cursor",
  "gemini", "opencode", "cline", "continue", "windsurf", "github-copilot",
  "kiro", "aider", "zed", "unknown",
]);

export function normalizePluginSettingProfiles(value: unknown): PluginSettingProfile[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 64).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const input = raw as Record<string, unknown>;
    let id = String(input.id ?? `profile-${index + 1}`)
      .trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (!id) id = `profile-${index + 1}`;
    if (ids.has(id)) return [];
    ids.add(id);
    const name = String(input.name ?? id).trim().slice(0, 80) || id;
    const agentKinds = Array.isArray(input.agentKinds)
      ? [...new Set(input.agentKinds.map(String).filter((kind): kind is AgentKind => AGENT_KINDS.has(kind as AgentKind)))].slice(0, 24)
      : [];
    const agentIds = Array.isArray(input.agentIds)
      ? [...new Set(input.agentIds.map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 64)
      : [];
    const config = input.config && typeof input.config === "object" && !Array.isArray(input.config)
      ? input.config as Record<string, unknown>
      : {};
    if (JSON.stringify(config).length > 65_536) return [];
    const priority = Number.isFinite(Number(input.priority))
      ? Math.max(-10_000, Math.min(10_000, Math.trunc(Number(input.priority))))
      : undefined;
    return [{
      id,
      name,
      agentKinds,
      ...(agentIds.length > 0 ? { agentIds } : {}),
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      config,
      ...(priority === undefined ? {} : { priority }),
    }];
  });
}

export function resolvePluginSettingProfiles(input: {
  enabled: boolean;
  config: Record<string, unknown>;
  organizationProfiles?: PluginSettingProfile[];
  userProfiles?: PluginSettingProfile[];
  agentKind?: string;
  agentId?: string;
  configLocked?: boolean;
}) {
  let enabled = input.enabled;
  let config = { ...input.config };
  const effectiveProfileIds: string[] = [];
  if (!input.agentKind && !input.agentId) return { enabled, config, effectiveProfileIds };

  const apply = (scope: "organization" | "user", profiles: PluginSettingProfile[]) => {
    for (const profile of [...profiles].sort(compareProfiles)) {
      if (profile.agentKinds.length > 0 && (!input.agentKind || !profile.agentKinds.includes(input.agentKind as AgentKind))) continue;
      if ((profile.agentIds?.length ?? 0) > 0 && (!input.agentId || !profile.agentIds!.includes(input.agentId))) continue;
      if (typeof profile.enabled === "boolean") enabled = profile.enabled;
      config = { ...config, ...profile.config };
      effectiveProfileIds.push(`${scope}:${profile.id}`);
    }
  };
  apply("organization", input.organizationProfiles ?? []);
  if (!input.configLocked) apply("user", input.userProfiles ?? []);
  return { enabled, config, effectiveProfileIds };
}

function compareProfiles(a: PluginSettingProfile, b: PluginSettingProfile) {
  return (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id);
}
