import type { EvaluationRequest, PipelineEvent, PluginRunRecord, PolicyDecision } from "@openleash/shared";
import { siemExporterManifest as manifest } from "./manifest.js";
import { pluginRun } from "../types.js";

export { manifest };

type SiemExporterConfig = {
  enabled?: boolean;
  protocol?: "ecs-json" | "splunk-hec" | "generic-webhook";
  endpointUrl?: string;
  bearerToken?: string;
  hecToken?: string;
  source?: string;
  sourcetype?: string;
  index?: string;
  minSeverity?: "info" | "low" | "medium" | "high" | "critical";
  includePrompt?: boolean;
  includeToolArguments?: boolean;
};

type SiemExportInput = {
  request: EvaluationRequest;
  event: PipelineEvent;
  decision: "allow" | "ask" | "deny";
  summary: string;
  evaluationId?: string;
  conversationEventId: string;
  organization: { id: string; name?: string; slug?: string | null };
  user: { id: string; email?: string; displayName?: string };
  computerId?: string;
  runtimeId?: string;
  policyResults?: PolicyDecision[];
  pluginRuns?: PluginRunRecord[];
  config?: SiemExporterConfig;
};

const severityRank = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export async function runSiemExporter(input: SiemExportInput) {
  const startedAt = Date.now();
  const config = normalizeConfig(input.config);
  if (!config.enabled) {
    return pluginRun({
      pluginId: manifest.id,
      event: input.event,
      status: "skipped",
      summary: "SIEM export is disabled.",
      startedAt
    });
  }
  if (!config.endpointUrl) {
    return pluginRun({
      pluginId: manifest.id,
      event: input.event,
      status: "skipped",
      summary: "SIEM export endpoint is not configured.",
      startedAt
    });
  }

  const severity = eventSeverity(input);
  if (severityRank[severity] < severityRank[config.minSeverity]) {
    return pluginRun({
      pluginId: manifest.id,
      event: input.event,
      status: "skipped",
      summary: `SIEM export skipped below ${config.minSeverity} severity.`,
      startedAt,
      metadata: { severity }
    });
  }

  const payload = ecsEvent(input, config, severity);
  try {
    const response = await fetch(config.endpointUrl, {
      method: "POST",
      headers: headersFor(config),
      body: JSON.stringify(bodyFor(config, payload))
    });
    if (!response.ok) throw new Error(`SIEM endpoint returned ${response.status}`);
    return pluginRun({
      pluginId: manifest.id,
      event: input.event,
      status: "passed",
      summary: `SIEM export sent ${input.event} as ${config.protocol}.`,
      startedAt,
      metadata: { protocol: config.protocol, severity }
    });
  } catch (error) {
    return pluginRun({
      pluginId: manifest.id,
      event: input.event,
      status: "failed",
      summary: error instanceof Error ? error.message : "SIEM export failed.",
      startedAt,
      metadata: { protocol: config.protocol, severity }
    });
  }
}

function normalizeConfig(config?: SiemExporterConfig): Required<SiemExporterConfig> {
  return {
    enabled: Boolean(config?.enabled),
    protocol: config?.protocol ?? "ecs-json",
    endpointUrl: String(config?.endpointUrl ?? "").trim(),
    bearerToken: String(config?.bearerToken ?? "").trim(),
    hecToken: String(config?.hecToken ?? "").trim(),
    source: String(config?.source ?? "openleash"),
    sourcetype: String(config?.sourcetype ?? "openleash:security"),
    index: String(config?.index ?? "security"),
    minSeverity: config?.minSeverity ?? "info",
    includePrompt: Boolean(config?.includePrompt),
    includeToolArguments: Boolean(config?.includeToolArguments)
  };
}

function eventSeverity(input: SiemExportInput): keyof typeof severityRank {
  if (input.decision === "deny") return "critical";
  if (input.decision === "ask") return "high";
  const maxPolicy = input.policyResults?.reduce<keyof typeof severityRank>((severity, result) => {
    const candidate = result.severity in severityRank ? result.severity as keyof typeof severityRank : "info";
    return severityRank[candidate] > severityRank[severity] ? candidate : severity;
  }, "info");
  return maxPolicy ?? "info";
}

function ecsEvent(input: SiemExportInput, config: Required<SiemExporterConfig>, severity: keyof typeof severityRank) {
  const raw = input.request.event.raw && typeof input.request.event.raw === "object" ? input.request.event.raw : {};
  const toolArguments = config.includeToolArguments ? input.request.event.tool?.input : undefined;
  return {
    "@timestamp": input.request.event.occurredAt,
    ecs: { version: "8.11.0" },
    event: {
      kind: input.decision === "allow" ? "event" : "alert",
      category: ["process"],
      type: ["info"],
      action: input.event,
      outcome: input.decision === "allow" ? "success" : "unknown",
      severity: severityRank[severity],
      reason: input.summary,
      id: input.evaluationId ?? input.conversationEventId,
      provider: "openleash"
    },
    rule: {
      name: input.policyResults?.map((result) => result.policyName).filter(Boolean).join(", ") || undefined
    },
    organization: {
      id: input.organization.id,
      name: input.organization.name,
      slug: input.organization.slug
    },
    user: {
      id: input.user.id,
      email: input.user.email,
      name: input.user.displayName
    },
    host: {
      id: input.computerId,
      hostname: input.request.computer.hostname,
      os: {
        platform: input.request.computer.platform,
        version: input.request.computer.osRelease
      }
    },
    agent: {
      id: input.runtimeId,
      type: input.request.agent.kind,
      name: input.request.agent.displayName,
      version: input.request.agent.version
    },
    openleash: {
      decision: input.decision,
      summary: input.summary,
      event_name: input.request.event.eventName,
      session_id: input.request.event.sessionId,
      project_path: input.request.event.projectPath,
      tool_name: input.request.event.tool?.name,
      tool_arguments: toolArguments,
      prompt: config.includePrompt ? input.request.event.prompt : undefined,
      policy_results: input.policyResults ?? [],
      plugin_runs: input.pluginRuns ?? [],
      raw_event_keys: Object.keys(raw)
    }
  };
}

function headersFor(config: Required<SiemExporterConfig>) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.protocol === "splunk-hec" && config.hecToken) headers.authorization = `Splunk ${config.hecToken}`;
  else if (config.bearerToken) headers.authorization = `Bearer ${config.bearerToken}`;
  return headers;
}

function bodyFor(config: Required<SiemExporterConfig>, event: Record<string, unknown>) {
  if (config.protocol === "splunk-hec") {
    return {
      time: Date.parse(String(event["@timestamp"])) / 1000,
      source: config.source,
      sourcetype: config.sourcetype,
      index: config.index,
      event
    };
  }
  return event;
}
