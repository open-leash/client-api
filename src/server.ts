import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cors from "cors";
import "dotenv/config";
import express, { type Express } from "express";
import {
  OPENLEASH_API_CONTRACTS,
  OPENLEASH_API_FUNCTION_HEADER,
  OPENLEASH_API_VERSION_HEADER,
  HOOK_AGENT_METADATA,
  type AgentKind,
  type ConversationTurn,
  type EvaluationRequest,
  type EvaluationResponse,
  type HookAgentSlug,
  type HookEventName,
  type MobileAuthExchangeRequest,
  type MobileAuthStartRequest,
  type MobileDeviceRegisterRequest,
  type MobileDecisionResolveRequest,
  type OpenLeashApiFunction,
  type McpToolCall,
  type OpenLeashPluginManifest,
  type PluginCatalogItem,
  type PluginLogRecord,
  type PluginMarketplaceListing,
  type PluginRunRecord,
  type PluginSettingState,
  type Policy,
  type PolicyDecision
} from "@openleash/shared";
import { z } from "zod";
import { ensureDevToken, getUserByToken, hashToken, pool } from "./db.js";
import { summarizeActionPurpose } from "./evaluator.js";
import {
  defaultPromptTransformConfig,
  normalizePromptTransformConfig,
  promptTransformsEnabled,
  type PromptTransformConfig
} from "./prompt-transforms.js";
import { firstPartyPluginManifests } from "./plugins/registry.js";
import { eventForHookEvent } from "./plugins/events.js";
import { runEvaluationPipeline, runPromptPipeline } from "./plugins/runtime.js";
import { createPluginCapabilities } from "./plugins/capabilities.js";
import { runExportPlugins, runLogExportPlugins } from "./plugins/exports.js";
import { runSkillScanner } from "./plugins/skill-scanner/index.js";
import type { PromptPipelineResult } from "./plugins/types.js";
import {
  EXTERNAL_PROVIDER_IDS,
  externalConversationToEvaluation,
  externalEvaluationKey,
  externalProviderLabel,
  fetchConfiguredExternalConversations,
  listExternalConnectors,
  type ExternalProvider
} from "./external-agents.js";
import {
  listProviderUsageConnections,
  normalizeUsageProvider,
  providerUsageOverview,
  syncProviderUsage,
  upsertProviderUsageConnection,
  upsertProviderUsageBudget,
  validateProviderConnection
} from "./provider-usage.js";
import {
  normalizeTenantModelProvider,
  readTenantModelKey,
  upsertTenantModelKey
} from "./model-keys.js";
import { assertReleaseAdmin, checkForClientUpdate, updateRequestSchema, upsertRelease } from "./releases.js";

export type ApiSurface = "client" | "dashboard" | "all";
export type OpenLeashApiExtension = (context: OpenLeashApiContext) => void | Promise<void>;
export type OpenLeashApiContext = {
  app: Express;
  surface: ApiSurface;
};
export type StartOpenLeashApiOptions = {
  app?: Express;
  surface?: ApiSurface;
  port?: number;
  extensions?: OpenLeashApiExtension[];
};
export type PrepareOpenLeashApiOptions = Pick<StartOpenLeashApiOptions, "app" | "surface" | "extensions">;

export const app = express();
export const apiSurface = apiSurfaceFromEnv();
const LOCAL_HOOK_AGENT_METADATA: Record<string, { kind: AgentKind | string; displayName: string }> = {
  ...HOOK_AGENT_METADATA,
  gemini: { kind: "gemini", displayName: "Google Gemini CLI" },
  opencode: { kind: "opencode", displayName: "OpenCode" }
};

app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) return callback(null, true);
    return callback(new Error("origin is not allowed by OpenLeash CORS policy"));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["authorization", "content-type", OPENLEASH_API_FUNCTION_HEADER, OPENLEASH_API_VERSION_HEADER]
}));
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const routeSurface = surfaceForRequest(req.method, req.path);
  if (apiSurface !== "all" && routeSurface && routeSurface !== "all" && routeSurface !== apiSurface) {
    return res.status(404).json({
      error: "not found",
      service: apiSurface === "dashboard" ? "openleash-dashboard-api" : "openleash-api"
    });
  }
  return next();
});
app.use((req, res, next) => {
  const functionName = apiFunctionForRequest(req.method, req.path);
  if (!functionName) return next();
  res.setHeader(OPENLEASH_API_FUNCTION_HEADER, functionName);
  res.setHeader(OPENLEASH_API_VERSION_HEADER, OPENLEASH_API_CONTRACTS[functionName]);
  const requestedVersion = req.header(OPENLEASH_API_VERSION_HEADER);
  if (requestedVersion && requestedVersion !== OPENLEASH_API_CONTRACTS[functionName]) {
    return res.status(426).json({
      error: "unsupported OpenLeash API contract version",
      function: functionName,
      expectedVersion: OPENLEASH_API_CONTRACTS[functionName],
      receivedVersion: requestedVersion
    });
  }
  return next();
});
app.use(async (req, res, next) => {
  try {
    if (!requiresDashboardWriteSession(req)) return next();
    if (allowsLocalDashboardWriteBypass(req)) return next();
    const session = await getDashboardSession(req.header("authorization") ?? "");
    if (!session || !["owner", "admin"].includes(session.user.role)) {
      return res.status(401).json({ error: "dashboard admin session required" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

const eventSchema = z.object({
  computer: z.object({
    hostname: z.string(),
    platform: z.string(),
    osRelease: z.string().optional()
  }),
  agent: z.object({
    kind: z.string(),
    displayName: z.string(),
    version: z.string().optional(),
    executablePath: z.string().optional()
  }),
  event: z.object({
    eventName: z.string(),
    agentKind: z.string(),
    agentVersion: z.string().optional(),
    sessionId: z.string(),
    projectPath: z.string().optional(),
    transcript: z.array(z.any()).optional(),
    tool: z.any().optional(),
    prompt: z.string().optional(),
    raw: z.any().optional(),
    occurredAt: z.string()
  })
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: apiSurface === "dashboard" ? "openleash-dashboard-api" : "openleash-client-api",
  surface: apiSurface,
  apiContracts: OPENLEASH_API_CONTRACTS
}));

app.get("/admin/prompt-transforms", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json({ config: await readPromptTransformConfig(organizationId) });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/prompt-transforms", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const config = normalizePromptTransformConfig(req.body?.config ?? req.body);
    await pool.query(
      `insert into prompt_transform_settings (organization_id, config, updated_at)
       values ($1, $2, now())
       on conflict (organization_id) do update set config = excluded.config, updated_at = now()`,
      [organizationId, JSON.stringify(config)]
    );
    res.json({ ok: true, config });
  } catch (error) {
    next(error);
  }
});

app.post("/api/updates/check", async (req, res) => {
  try {
    const updateRequest = updateRequestSchema.parse(req.body);
    res.json(await checkForClientUpdate(updateRequest));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid update request." });
  }
});

app.get("/api/updates/latest", async (req, res) => {
  const response = await checkForClientUpdate({
    app: firstQuery(req.query.app) || "openleash-personal",
    version: firstQuery(req.query.version) || "0.0.0",
    platform: firstQuery(req.query.platform) || "darwin",
    arch: firstQuery(req.query.arch) || "arm64",
    channel: firstQuery(req.query.channel) || "stable",
    installMode: firstQuery(req.query.installMode) || "personal",
    updateSource: "latest-get"
  });
  res.json({
    version: response.latestVersion,
    dmgUrl: response.dmgUrl,
    downloadUrl: response.downloadUrl,
    sha256: response.sha256,
    sizeBytes: response.sizeBytes,
    notesUrl: response.notesUrl,
    releaseNotes: response.releaseNotes,
    publishedAt: response.publishedAt,
    updateAvailable: response.updateAvailable
  });
});

app.post("/api/admin/releases", async (req, res) => {
  try {
    if (!assertReleaseAdmin(req)) return res.status(401).json({ error: "Unauthorized." });
    const release = await upsertRelease(req.body);
    res.json({ ok: true, release });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not publish release." });
  }
});

app.post("/v1/enroll", async (req, res, next) => {
  try {
    const deploymentToken = String(req.body.deploymentToken ?? req.body.token ?? "").trim();
    if (!deploymentToken) return res.status(401).json({ error: "missing deployment token" });
    const token = await pool.query<{
      id: string;
      label: string;
      mode: string;
      tenant_url: string;
      mdm: string | null;
    }>(
      `update deployment_tokens
       set last_used_at = now()
       where token_hash = $1
         and revoked_at is null
         and (expires_at is null or expires_at > now())
       returning id, label, mode, tenant_url, mdm`,
      [hashToken(deploymentToken)]
    );
    const deployment = token.rows[0];
    if (!deployment) return res.status(401).json({ error: "invalid or expired deployment token" });

    const hostname = String(req.body.hostname ?? os.hostname()).trim() || os.hostname();
    const platform = String(req.body.platform ?? "unknown");
    const osRelease = typeof req.body.osRelease === "string" ? req.body.osRelease : null;
    const displayName = String(req.body.displayName ?? req.body.userName ?? hostname).trim() || hostname;
    const email = String(req.body.email ?? `${slug(displayName)}@managed.openleash.com`).toLowerCase();
    const agentToken = `ol_${crypto.randomBytes(24).toString("base64url")}`;

    const user = await pool.query<{ id: string; email: string; display_name: string }>(
      `insert into users (email, display_name, role, token_hash)
       values ($1, $2, 'engineer', $3)
       on conflict (email) do update set display_name = excluded.display_name, token_hash = excluded.token_hash
       returning id, email, display_name`,
      [email, displayName, hashToken(agentToken)]
    );
    const computer = await pool.query<{ id: string }>(
      `insert into computers (user_id, hostname, platform, os_release, enrollment_token_id, enrolled_at, last_seen_at)
       values ($1, $2, $3, $4, $5, now(), now())
       on conflict (user_id, hostname) do update set
         platform = excluded.platform,
         os_release = excluded.os_release,
         enrollment_token_id = excluded.enrollment_token_id,
         enrolled_at = coalesce(computers.enrolled_at, now()),
         last_seen_at = now()
       returning id`,
      [user.rows[0].id, hostname, platform, osRelease, deployment.id]
    );

    res.status(201).json({
      mode: deployment.mode,
      tenantUrl: deployment.tenant_url,
      apiUrl: publicApiUrl(req),
      token: agentToken,
      user: user.rows[0],
      computer: { id: computer.rows[0].id, hostname },
      rulesManagedBy: "admin-dashboard"
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/evaluate", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ error: "invalid OpenLeash token" });

    const request = eventSchema.parse(req.body) as EvaluationRequest;
    res.json(await evaluateAndRecord(request, user));
  } catch (error) {
    next(error);
  }
});

app.post("/v1/hooks/:agent/:event", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ error: "invalid OpenLeash token" });
    const agent = req.params.agent as HookAgentSlug;
    const eventName = req.params.event as HookEventName;
    if (!LOCAL_HOOK_AGENT_METADATA[agent] || !isHookEventName(eventName)) {
      return res.status(400).json({ error: "unsupported OpenLeash hook target" });
    }
    const request = normalizeHookRequest(agent, eventName, req.body, req.query);
    if (isPromptOnlyHook(request)) {
      const transformed = await handlePromptOnlyHook(agent, eventName, request, user);
      return res.json(transformed);
    }
    const decision = await evaluateAndRecord(request, user);
    const resolvedDecision = await waitForHookDecision(user, decision);
    res.json(nativeHookDecision(agent, eventName, resolvedDecision));
  } catch (error) {
    next(error);
  }
});

app.get("/admin/external-agents", async (_req, res, next) => {
  try {
    const connectors = await listExternalConnectors();
    const known = await pool.query(
      `select ar.id, ar.kind, ar.display_name, ar.version, ar.last_seen_at,
              c.hostname, u.display_name as user_name,
              latest.session_id, latest.created_at as latest_event_at,
              ev.id as latest_evaluation_id, ev.decision, ev.summary
       from agent_runtimes ar
       join computers c on c.id = ar.computer_id
       left join users u on u.id = c.user_id
       left join lateral (
         select ce.*
         from conversation_events ce
         where ce.agent_runtime_id = ar.id
         order by ce.created_at desc
         limit 1
       ) latest on true
       left join evaluations ev on ev.conversation_event_id = latest.id
       where ar.kind = any($1)
       order by greatest(ar.last_seen_at, coalesce(latest.created_at, ar.last_seen_at)) desc`,
      [EXTERNAL_PROVIDER_IDS]
    );
    res.json({ connectors, known: known.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/external-agents/sync", async (req, res, next) => {
  try {
    const provider = typeof req.body?.provider === "string" ? req.body.provider as ExternalProvider : undefined;
    const conversations = await fetchConfiguredExternalConversations(provider);
    const user = await ensureExternalUser(provider ?? "external-agents");
    const synced = [];
    const skipped = [];
    for (const conversation of conversations) {
      const key = externalEvaluationKey(conversation);
      if (await externalEventExists(key)) {
        skipped.push({ provider: conversation.provider, sessionId: conversation.sessionId, reason: "already synced" });
        continue;
      }
      const response = await evaluateAndRecord(externalConversationToEvaluation(conversation), user);
      synced.push({ provider: conversation.provider, sessionId: conversation.sessionId, decisionId: response.decisionId, decision: response.decision });
    }
    res.json({ ok: true, synced, skipped, total: conversations.length });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/provider-usage", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const days = Math.max(1, Math.min(180, Number(req.query.days ?? 30) || 30));
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    res.json(await providerUsageOverview(organizationId, start));
  } catch (error) {
    next(error);
  }
});

app.get("/admin/provider-usage/connections", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json({ connections: await listProviderUsageConnections(organizationId) });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/connections", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    const apiKey = String(req.body?.apiKey ?? "").trim();
    if (!provider) return res.status(400).json({ ok: false, message: "provider must be cursor, openai, or anthropic" });
    if (!apiKey) return res.status(400).json({ ok: false, message: "apiKey is required" });
    const result = await upsertProviderUsageConnection({
      organizationId,
      provider,
      apiKey,
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      externalOrgId: typeof req.body?.externalOrgId === "string" ? req.body.externalOrgId : undefined
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/validate", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    if (!provider) return res.status(400).json({ ok: false, message: "provider must be cursor, openai, or anthropic" });
    const result = await validateProviderConnection(organizationId, provider);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/budgets", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    const budget = await upsertProviderUsageBudget({
      organizationId,
      provider,
      monthlyBudgetCents: Number(req.body?.monthlyBudgetCents ?? 0)
    });
    res.json({ ok: true, budget });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/sync", async (req, res, next) => {
  let started: { rows: Array<{ id: string }> } | undefined;
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    started = await pool.query<{ id: string }>(
      `insert into provider_usage_sync_jobs (organization_id, provider, status, triggered_by)
       values ($1, $2, 'running', $3)
       returning id`,
      [organizationId, provider ?? null, typeof req.body?.triggeredBy === "string" ? req.body.triggeredBy : "manual"]
    );
    const result = await syncProviderUsage(organizationId, provider);
    const records = result.synced.reduce((sum, item) => sum + item.events, 0);
    await pool.query(
      `update provider_usage_sync_jobs
       set status = $2, records = $3, error = $4, finished_at = now()
       where id = $1`,
      [started.rows[0].id, result.ok ? "completed" : "partial", records, result.failed.map(item => `${item.provider}: ${item.error}`).join("; ") || null]
    );
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    if (started?.rows[0]?.id) {
      await pool.query(
        `update provider_usage_sync_jobs
         set status = 'failed', error = $2, finished_at = now()
         where id = $1`,
        [started.rows[0].id, message]
      );
    }
    next(error);
  }
});

app.post("/admin/evaluation-key", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeTenantModelProvider(req.body?.provider ?? req.body?.apiProvider);
    const apiKey = String(req.body?.apiKey ?? "").trim();
    if (!provider) return res.status(400).json({ ok: false, error: "provider must be openai, anthropic, or deepseek" });
    if (!apiKey) return res.status(400).json({ ok: false, error: "apiKey is required" });
    const result = await upsertTenantModelKey({ organizationId, provider, apiKey });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/overview", async (_req, res, next) => {
  try {
      const [metrics, sessionMetrics, agentSessions, usageSessions, agents, recent, policies, users] = await Promise.all([
      pool.query(`select
        (select count(*) from computers) as computers,
        (select count(*) from agent_runtimes where kind not in ('openclaw', 'nanoclaw')) as agents,
        (select count(*) from conversation_events where created_at > now() - interval '30 days') as events,
        (select count(*) from evaluations where decision = 'deny' and created_at > now() - interval '30 days') as denied,
        (select count(*) from evaluations where decision = 'ask' and created_at > now() - interval '30 days') as questions`),
      dashboardSessionMetrics(),
      dashboardAgentSessions(),
      dashboardUsageSessions(),
      pool.query(`select ar.*, c.hostname, u.display_name as user_name
        from agent_runtimes ar
        join computers c on c.id = ar.computer_id
        left join users u on u.id = c.user_id
        where ar.kind not in ('openclaw', 'nanoclaw')
        order by ar.last_seen_at desc limit 20`),
      pool.query(`select e.id, e.decision, e.resolution, e.summary, e.question, e.created_at, ce.event_name, ce.tool_name, ce.project_path, ce.prompt,
          ar.kind as agent_kind, ar.display_name as agent_name, c.hostname, u.display_name as user_name,
          coalesce(triggered.items, '[]'::jsonb) as triggered_policies
        from evaluations e
        join conversation_events ce on ce.id = e.conversation_event_id
        join agent_runtimes ar on ar.id = ce.agent_runtime_id
        join computers c on c.id = ce.computer_id
        left join users u on u.id = e.user_id
        left join lateral (
          select jsonb_agg(
            jsonb_build_object(
              'policy_name', pr.policy_name,
              'status', pr.status,
              'severity', pr.severity,
              'explanation', pr.explanation,
              'evidence', pr.evidence
            )
            order by pr.created_at asc
          ) as items
          from policy_results pr
          where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
        ) triggered on true
        where (
          e.decision in ('ask', 'deny')
          or e.resolution = 'deny'
          or exists (
            select 1 from policy_results pr
            where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
          )
        )
        order by e.created_at desc limit 30`),
      pool.query(policyInventorySql()),
      pool.query(`select u.id, u.email, u.display_name, u.role, u.created_at,
          u.department, u.title as hr_title, u.idp_provider, u.status,
          count(distinct c.id) as endpoint_count,
          count(distinct ar.id) filter (where ar.kind not in ('openclaw', 'nanoclaw')) as agent_count,
          max(greatest(c.last_seen_at, coalesce(ar.last_seen_at, c.last_seen_at))) as last_seen_at,
          coalesce(jsonb_agg(distinct ar.display_name) filter (where ar.id is not null and ar.kind not in ('openclaw', 'nanoclaw')), '[]'::jsonb) as agents,
          coalesce(jsonb_agg(distinct c.hostname) filter (where c.id is not null), '[]'::jsonb) as hostnames
        from users u
        left join computers c on c.user_id = u.id
        left join agent_runtimes ar on ar.computer_id = c.id
        group by u.id
        order by u.display_name asc`)
    ]);
    res.json({
      metrics: { ...metrics.rows[0], session_time: sessionMetrics.rows[0] },
      agents: agents.rows.map((agent) => ({
        ...agent,
        sessions: agentSessions.rows.filter((session) => session.agent_runtime_id === agent.id).slice(0, 8)
      })),
      recent: recent.rows,
      policies: policies.rows,
      users: users.rows,
      usage: { sessions: usageSessions.rows }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/security", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const days = Math.max(1, Math.min(180, Number(req.query.days ?? 30) || 30));
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [summary, signals, byPlugin, byUser, usageByPlugin, usageByUser, correlations] = await Promise.all([
      pool.query(
        `select
           count(*)::int as total_signals,
           count(*) filter (where kind = 'security.finding')::int as findings,
           count(*) filter (where severity in ('high', 'critical'))::int as high_severity,
           count(*) filter (where decision in ('blocked', 'deny', 'ask'))::int as contained,
           count(distinct user_id)::int as affected_users
         from plugin_signals
         where organization_id = $1 and created_at >= $2`,
        [organizationId, start]
      ),
      pool.query(
        `select ps.id, ps.plugin_id, ps.kind, ps.severity, ps.title, ps.summary, ps.decision, ps.status,
                ps.target, ps.details, ps.correlation_keys, ps.occurred_at, ps.created_at,
                u.id as user_id, u.email as user_email, u.display_name as user_name,
                c.hostname, ar.kind as agent_kind, ar.display_name as agent_name,
                ce.event_name, ce.tool_name, ce.project_path, e.id as evaluation_id
         from plugin_signals ps
         left join users u on u.id = ps.user_id
         left join computers c on c.id = ps.computer_id
         left join agent_runtimes ar on ar.id = ps.agent_runtime_id
         left join conversation_events ce on ce.id = ps.conversation_event_id
         left join evaluations e on e.conversation_event_id = ce.id
         where ps.organization_id = $1 and ps.created_at >= $2
         order by ps.created_at desc
         limit 100`,
        [organizationId, start]
      ),
      pool.query(
        `select plugin_id, kind, severity, count(*)::int as count
         from plugin_signals
         where organization_id = $1 and created_at >= $2
         group by plugin_id, kind, severity
         order by count desc, plugin_id asc`,
        [organizationId, start]
      ),
      pool.query(
        `select u.id as user_id, u.email, u.display_name as name,
                count(*)::int as signal_count,
                count(*) filter (where ps.severity in ('high', 'critical'))::int as high_count,
                max(ps.created_at) as last_signal_at
         from plugin_signals ps
         left join users u on u.id = ps.user_id
         where ps.organization_id = $1 and ps.created_at >= $2
         group by u.id, u.email, u.display_name
         order by high_count desc, signal_count desc
         limit 25`,
        [organizationId, start]
      ),
      pool.query(
        `select plugin_id, kind, coalesce(provider, 'plugin') as provider, coalesce(model, '') as model,
                count(*)::int as records,
                coalesce(sum(input_tokens), 0)::int as input_tokens,
                coalesce(sum(output_tokens), 0)::int as output_tokens,
                coalesce(sum(saved_tokens), 0)::int as saved_tokens,
                coalesce(sum(estimated_cost_cents), 0)::int as estimated_cost_cents
         from plugin_usage_records
         where organization_id = $1 and created_at >= $2
         group by plugin_id, kind, provider, model
         order by estimated_cost_cents desc, records desc
         limit 50`,
        [organizationId, start]
      ),
      pool.query(
        `select u.id as user_id, u.email, u.display_name as name,
                count(pur.*)::int as records,
                coalesce(sum(pur.input_tokens), 0)::int as input_tokens,
                coalesce(sum(pur.output_tokens), 0)::int as output_tokens,
                coalesce(sum(pur.saved_tokens), 0)::int as saved_tokens,
                coalesce(sum(pur.estimated_cost_cents), 0)::int as estimated_cost_cents,
                max(pur.created_at) as last_usage_at
         from plugin_usage_records pur
         left join users u on u.id = pur.user_id
         where pur.organization_id = $1 and pur.created_at >= $2
         group by u.id, u.email, u.display_name
         order by estimated_cost_cents desc, records desc
         limit 25`,
        [organizationId, start]
      ),
      pool.query(
        `select key as correlation_key,
                count(*)::int as signal_count,
                count(distinct plugin_id)::int as plugin_count,
                count(distinct user_id)::int as user_count,
                max(created_at) as last_signal_at,
                array_agg(distinct plugin_id) as plugin_ids
         from plugin_signals ps, unnest(ps.correlation_keys) as key
         where ps.organization_id = $1 and ps.created_at >= $2
         group by key
         having count(*) > 1 or count(distinct plugin_id) > 1
         order by plugin_count desc, signal_count desc, last_signal_at desc
         limit 30`,
        [organizationId, start]
      )
    ]);
    res.json({
      range: { days, since: start.toISOString() },
      summary: summary.rows[0] ?? {},
      signals: signals.rows,
      byPlugin: byPlugin.rows,
      byUser: byUser.rows,
      usage: {
        byPlugin: usageByPlugin.rows,
        byUser: usageByUser.rows
      },
      correlations: correlations.rows
    });
  } catch (error) {
    next(error);
  }
});

function dashboardSessionMetrics() {
  return pool.query(
    `with sessions as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds
       from conversation_events ce
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
     )
     select
       coalesce(sum(duration_seconds) filter (where last_activity_at >= date_trunc('day', now())), 0)::int as today_seconds,
       count(*) filter (where last_activity_at >= date_trunc('day', now()))::int as today_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '24 hours'), 0)::int as last24h_seconds,
       count(*) filter (where last_activity_at >= now() - interval '24 hours')::int as last24h_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '7 days'), 0)::int as week_seconds,
       count(*) filter (where last_activity_at >= now() - interval '7 days')::int as week_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '30 days'), 0)::int as month_seconds,
       count(*) filter (where last_activity_at >= now() - interval '30 days')::int as month_sessions
     from sessions`
  );
}

function dashboardAgentSessions() {
  return pool.query(
    `with session_groups as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds,
              count(*)::int as event_count,
              count(e.id) filter (where e.decision = 'ask')::int as approval_count,
              count(e.id) filter (where e.decision = 'deny' or e.resolution = 'deny')::int as denied_count
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
       order by max(ce.created_at) desc
       limit 200
     )
     select sg.agent_runtime_id,
            concat(sg.agent_runtime_id, ':', sg.session_id, ':', sg.project_path_key) as id,
            sg.session_id,
            nullif(sg.project_path_key, '') as project_path,
            sg.started_at,
            sg.last_activity_at,
            sg.duration_seconds,
            sg.event_count,
            sg.approval_count,
            sg.denied_count,
            coalesce(title_item.title, 'Agent session') as title,
            concat_ws(' · ',
              sg.event_count::text || case when sg.event_count = 1 then ' event' else ' events' end,
              case when sg.approval_count > 0 then sg.approval_count::text || case when sg.approval_count = 1 then ' approval' else ' approvals' end end,
              case when sg.denied_count > 0 then sg.denied_count::text || ' denied' end
            ) as summary
     from session_groups sg
     left join lateral (
       select left(regexp_replace(coalesce(ce.prompt, e.summary, ce.tool_name, ce.event_name, 'Agent session'), '\\s+', ' ', 'g'), 64) as title
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ce.agent_runtime_id = sg.agent_runtime_id
         and ce.session_id = sg.session_id
         and coalesce(ce.project_path, '') = sg.project_path_key
       order by case when ce.prompt is not null and length(ce.prompt) > 0 then 0 else 1 end, ce.created_at asc
       limit 1
     ) title_item on true
     order by sg.last_activity_at desc`
  );
}

function dashboardUsageSessions() {
  return pool.query(
    usageSessionsSql("true", [], "limit 500")
  );
}

function usageSessionsSql(whereClause: string, params: unknown[], limitClause: string) {
  return {
    text: `with session_groups as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds,
              count(*)::int as event_count,
              count(e.id) filter (where e.decision = 'ask')::int as approval_count,
              count(e.id) filter (where e.decision = 'deny' or e.resolution = 'deny')::int as denied_count,
              max(ce.user_id::text) as user_id,
              max(ce.computer_id::text) as computer_id
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ${whereClause}
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
     ),
     subagent_events as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              ce.created_at,
              ce.event_name,
              coalesce(ce.payload->>'agent_id', ce.payload->>'agentId', ce.payload->>'subagent_id', ce.payload->>'subagentId', ce.payload->>'thread_id', ce.payload->>'threadId') as subagent_id
       from conversation_events ce
       where ${whereClause}
         and ce.event_name in ('SubagentStart', 'SubagentStop')
     ),
     subagent_pairs as (
       select start_event.agent_runtime_id,
              start_event.session_id,
              start_event.project_path_key,
              start_event.subagent_id,
              start_event.created_at as started_at,
              (
                select min(stop_event.created_at)
                from subagent_events stop_event
                where stop_event.agent_runtime_id = start_event.agent_runtime_id
                  and stop_event.session_id = start_event.session_id
                  and stop_event.project_path_key = start_event.project_path_key
                  and stop_event.subagent_id = start_event.subagent_id
                  and stop_event.event_name = 'SubagentStop'
                  and stop_event.created_at >= start_event.created_at
              ) as stopped_at
       from subagent_events start_event
       where start_event.event_name = 'SubagentStart'
         and start_event.subagent_id is not null
     ),
     subagent_totals as (
       select agent_runtime_id,
              session_id,
              project_path_key,
              count(*)::int as subagent_count,
              coalesce(sum(greatest(0, extract(epoch from coalesce(stopped_at, started_at) - started_at))), 0)::int as subagent_seconds
       from subagent_pairs
       group by agent_runtime_id, session_id, project_path_key
     )
     select concat(sg.agent_runtime_id, ':', sg.session_id, ':', sg.project_path_key) as id,
            sg.agent_runtime_id,
            sg.session_id,
            nullif(sg.project_path_key, '') as project_path,
            sg.started_at,
            sg.last_activity_at,
            sg.duration_seconds,
            coalesce(st.subagent_count, 0)::int as subagent_count,
            coalesce(st.subagent_seconds, 0)::int as subagent_seconds,
            greatest(0, sg.duration_seconds - coalesce(st.subagent_seconds, 0))::int as orchestrator_seconds,
            sg.event_count,
            sg.approval_count,
            sg.denied_count,
            u.id as user_id,
            u.email as user_email,
            u.display_name as user_name,
            c.hostname,
            ar.kind as agent_kind,
            ar.display_name as agent_name,
            coalesce(title_item.title, 'Agent session') as title,
            concat_ws(' · ',
              sg.event_count::text || case when sg.event_count = 1 then ' event' else ' events' end,
              case when sg.approval_count > 0 then sg.approval_count::text || case when sg.approval_count = 1 then ' approval' else ' approvals' end end,
              case when sg.denied_count > 0 then sg.denied_count::text || ' denied' end,
              case when coalesce(st.subagent_seconds, 0) > 0 then 'subagents ' || coalesce(st.subagent_seconds, 0)::text || 's' end
            ) as summary
     from session_groups sg
     join agent_runtimes ar on ar.id = sg.agent_runtime_id
     left join users u on u.id = sg.user_id::uuid
     left join computers c on c.id = sg.computer_id::uuid
     left join subagent_totals st on st.agent_runtime_id = sg.agent_runtime_id and st.session_id = sg.session_id and st.project_path_key = sg.project_path_key
     left join lateral (
       select left(regexp_replace(coalesce(ce.prompt, e.summary, ce.tool_name, ce.event_name, 'Agent session'), '\\s+', ' ', 'g'), 72) as title
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ce.agent_runtime_id = sg.agent_runtime_id
         and ce.session_id = sg.session_id
         and coalesce(ce.project_path, '') = sg.project_path_key
       order by case when ce.prompt is not null and length(ce.prompt) > 0 then 0 else 1 end, ce.created_at asc
       limit 1
     ) title_item on true
     order by sg.last_activity_at desc
     ${limitClause}`,
    values: params
  };
}

app.get("/admin/mcp-servers", async (_req, res, next) => {
  try {
    const servers = await pool.query(
      `select s.id, s.server_name, s.first_seen_at, s.last_seen_at, s.tool_count, s.call_count,
              count(distinct c.user_id) as user_count,
              coalesce(jsonb_agg(distinct jsonb_build_object('tool_name', c.tool_name)) filter (where c.tool_name is not null), '[]'::jsonb) as tools,
              coalesce(jsonb_agg(distinct jsonb_build_object('id', u.id, 'name', u.display_name, 'email', u.email)) filter (where u.id is not null), '[]'::jsonb) as users,
              coalesce(recent.items, '[]'::jsonb) as recent_calls
       from mcp_servers s
       left join mcp_tool_calls c on c.mcp_server_id = s.id
       left join users u on u.id = c.user_id
       left join lateral (
         select jsonb_agg(jsonb_build_object(
           'id', rc.id,
           'tool_name', rc.tool_name,
           'argument_summary', rc.argument_summary,
           'project_path', rc.project_path,
           'decision', rc.decision,
           'risk_level', rc.risk_level,
           'occurred_at', rc.occurred_at,
           'agent_name', ar.display_name,
           'hostname', comp.hostname,
           'user_name', ru.display_name
         ) order by rc.occurred_at desc) as items
         from (
           select *
           from mcp_tool_calls
           where mcp_server_id = s.id
           order by occurred_at desc
           limit 5
         ) rc
         left join agent_runtimes ar on ar.id = rc.agent_runtime_id
         left join computers comp on comp.id = rc.computer_id
         left join users ru on ru.id = rc.user_id
       ) recent on true
       group by s.id, recent.items
       order by s.last_seen_at desc
       limit 250`
    );
    res.json({ servers: servers.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/mcp-servers/:id", async (req, res, next) => {
  try {
    const [server, calls] = await Promise.all([
      pool.query(
        `select s.id, s.server_name, s.first_seen_at, s.last_seen_at, s.tool_count, s.call_count,
                count(distinct c.user_id) as user_count
         from mcp_servers s
         left join mcp_tool_calls c on c.mcp_server_id = s.id
         where s.id = $1
         group by s.id`,
        [req.params.id]
      ),
      pool.query(
        `select c.id, c.server_name, c.tool_name, c.full_tool_name, c.arguments, c.argument_summary,
                c.project_path, c.session_id, c.decision, c.resolution, c.risk_level, c.occurred_at, c.created_at,
                e.summary, e.question, e.resolution as evaluation_resolution,
                ce.event_name, ar.display_name as agent_name, ar.kind as agent_kind,
                comp.hostname, u.display_name as user_name, u.email as user_email
         from mcp_tool_calls c
         left join evaluations e on e.id = c.evaluation_id
         left join conversation_events ce on ce.id = c.conversation_event_id
         left join agent_runtimes ar on ar.id = c.agent_runtime_id
         left join computers comp on comp.id = c.computer_id
         left join users u on u.id = c.user_id
         where c.mcp_server_id = $1
         order by c.occurred_at desc
         limit 100`,
        [req.params.id]
      )
    ]);
    if (!server.rows[0]) return res.status(404).json({ error: "MCP server not found" });
    res.json({ server: server.rows[0], calls: calls.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/skills", async (_req, res, next) => {
  try {
    const skills = await pool.query(
      `select s.*, u.display_name as user_name, u.email as user_email
       from skills s
       left join users u on u.id = s.user_id
       where s.status <> 'deleted'
       order by s.updated_at desc
       limit 500`
    );
    const events = await pool.query(
      `select se.*, u.display_name as user_name
       from skill_events se
       left join users u on u.id = se.user_id
       order by se.created_at desc
       limit 100`
    );
    res.json({ skills: skills.rows, events: events.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/onboarding", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const [idp, groups, users, roles, tokens, providerUsage] = await Promise.all([
      pool.query(
        `select id, provider, enabled, last_sync_at, user_count, group_count, last_error, created_at, updated_at,
                config - array['ClientSecret','clientSecret','PrivateKey','privateKey','ApiToken','apiToken','AccessToken','accessToken','ServiceAccountJson','serviceAccountJson'] as config
         from idp_connections
         where organization_id = $1
         limit 1`,
        [organization.id]
      ),
      pool.query(
        `select g.id, g.name, g.description, g.idp_group_id, g.idp_provider,
                count(gm.user_id) as member_count
         from identity_groups g
         left join identity_group_members gm on gm.group_id = g.id
         where g.organization_id = $1
         group by g.id
         order by g.name asc`,
        [organization.id]
      ),
      pool.query(
        `select id, email, display_name, role, first_name, last_name, department, title, idp_provider, status, last_login_at, created_at
         from users
         where organization_id = $1
         order by display_name asc
         limit 500`,
        [organization.id]
      ),
      pool.query(
        `select ra.id, ra.role, ra.user_id, ra.group_id, u.display_name as user_name, g.name as group_name
         from role_assignments ra
         left join users u on u.id = ra.user_id
         left join identity_groups g on g.id = ra.group_id
         where ra.organization_id = $1
         order by ra.role asc, coalesce(g.name, u.display_name) asc`,
        [organization.id]
      ),
      pool.query(
        `select id, label, mode, tenant_url, mdm, expires_at, revoked_at, created_at, last_used_at
         from deployment_tokens
         order by created_at desc
         limit 10`
      ),
      pool.query(
        `select
           (select count(*)::int from provider_usage_connections where organization_id = $1 and enabled = true) as connection_count,
           (select count(*)::int from provider_usage_budgets where organization_id = $1 and enabled = true) as budget_count`,
        [organization.id]
      )
    ]);
    const deploymentMode = process.env.OPENLEASH_DEPLOYMENT_MODE ?? process.env.OPENLEASH_EDITION ?? organization.deployment_mode ?? "cloud";
    res.json({ organization: { ...organization, deployment_mode: deploymentMode }, idp: idp.rows[0] ?? null, groups: groups.rows, users: users.rows, roles: roles.rows, deploymentTokens: tokens.rows, providerUsage: providerUsage.rows[0] ?? { connection_count: 0, budget_count: 0 } });
  } catch (error) {
    next(error);
  }
});

app.get("/organizations/:slug", async (req, res, next) => {
  try {
    const organization = await getOrganizationBySlug(req.params.slug);
    if (!organization) return res.status(404).json({ error: "Organization not found" });
    res.json({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      setupCompleted: organization.setup_completed,
      deploymentMode: organization.deployment_mode
    });
  } catch (error) {
    next(error);
  }
});

app.post("/organizations", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "Organization name is required" });
    const requestedSlug = String(req.body.slug ?? "").trim();
    const slug = slugifyTenant(requestedSlug || name);
    if (!slug) return res.status(400).json({ error: "Organization slug is required" });
    const result = await pool.query(
      `insert into organizations (name, slug, region, setup_completed, current_step, deployment_mode)
       values ($1, $2, $3, false, 1, $4)
       on conflict (slug) do update set
         name = excluded.name,
         region = excluded.region,
         setup_completed = false,
         current_step = 1,
         deployment_mode = excluded.deployment_mode,
         updated_at = now()
       returning id, name, slug, region, setup_completed, current_step, deployment_mode`,
      [name, slug, req.body.region ?? null, normalizeDeploymentMode(req.body.deploymentMode ?? process.env.OPENLEASH_DEPLOYMENT_MODE)]
    );
    res.status(201).json({ organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/organizations/:slug/sso-providers", async (req, res, next) => {
  try {
    const organization = await getOrganizationBySlug(req.params.slug);
    if (!organization) return res.status(404).json({ error: "Organization not found" });
    const result = await pool.query(
      `select id, provider, enabled, config
       from idp_connections
       where organization_id = $1 and enabled = true
       order by updated_at desc`,
      [organization.id]
    );
    const providers = result.rows.map((row) => ssoProviderFromIdp(row, organization.id)).filter(Boolean);
    res.json({ providers });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/sso/authorize", async (req, res, next) => {
  try {
    const organizationId = String(req.body.organizationId ?? "").trim();
    const providerType = String(req.body.providerType ?? "").trim();
    if (!organizationId || !providerType) return res.status(400).json({ error: "organizationId and providerType are required" });
    const result = await pool.query(
      `select provider, config from idp_connections where organization_id = $1 and enabled = true limit 1`,
      [organizationId]
    );
    const row = result.rows.find((item) => ssoProviderType(item.provider) === providerType) ?? result.rows[0];
    if (!row) return res.status(404).json({ error: "SSO provider not found or disabled" });
    const redirectUri = process.env.OPENLEASH_SSO_REDIRECT_URI ?? `${process.env.OPENLEASH_TENANT_URL ?? "http://localhost:9300"}/auth/sso/callback`;
    const state = crypto.randomBytes(18).toString("base64url");
    const authorizationUrl = buildAuthorizationUrl(providerType, row.config ?? {}, redirectUri, state);
    if (!authorizationUrl) return res.status(400).json({ error: `Unsupported provider type: ${providerType}` });
    res.json({ authorizationUrl, state, providerType, organizationId });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/sso/callback", async (req, res, next) => {
  try {
    const organizationId = String(req.body.organizationId ?? "").trim();
    const providerType = String(req.body.providerType ?? "").trim();
    const authorizationCode = String(req.body.authorizationCode ?? req.body.code ?? "").trim();
    const redirectUri = String(req.body.redirectUri ?? "").trim();
    if (!organizationId || !providerType || !authorizationCode || !redirectUri) {
      return res.status(400).json({ success: false, message: "organizationId, providerType, authorizationCode, and redirectUri are required" });
    }

    const providerResult = await pool.query(
      `select provider, config from idp_connections where organization_id = $1 and enabled = true`,
      [organizationId]
    );
    const row = providerResult.rows.find((item) => ssoProviderType(item.provider) === providerType) ?? providerResult.rows[0];
    if (!row) return res.status(404).json({ success: false, message: "SSO provider not found or disabled" });

    const organizationResult = await pool.query(`select id, name, slug, region from organizations where id = $1 limit 1`, [organizationId]);
    const organization = organizationResult.rows[0];
    if (!organization) return res.status(404).json({ success: false, message: "Organization not found" });

    const tokenSet = await exchangeAuthorizationCode(providerType, row.config ?? {}, authorizationCode, redirectUri);
    const profile = await fetchSsoProfile(providerType, row.config ?? {}, tokenSet);
    if (!profile.email) return res.status(400).json({ success: false, message: "Identity provider did not return an email address" });

    const displayName = profile.name || profile.email.split("@")[0] || "OpenLeash user";
    const userResult = await pool.query<{
      id: string;
      email: string;
      display_name: string;
      role: string;
      first_name: string | null;
      last_name: string | null;
      department: string | null;
      title: string | null;
    }>(
      `insert into users (organization_id, email, display_name, role, first_name, last_name, idp_user_id, idp_provider, status, last_login_at, metadata)
       values ($1, $2, $3, 'engineer', $4, $5, $6, $7, 'active', now(), $8)
       on conflict (email) do update set
         organization_id = excluded.organization_id,
         display_name = excluded.display_name,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         idp_user_id = excluded.idp_user_id,
         idp_provider = excluded.idp_provider,
         status = 'active',
         last_login_at = now(),
         metadata = excluded.metadata
       returning id, email, display_name, role, first_name, last_name, department, title`,
      [
        organizationId,
       profile.email.toLowerCase(),
        displayName,
        profile.givenName,
        profile.familyName,
        profile.subject,
        providerType,
        JSON.stringify({ ssoProfile: profile.raw })
      ]
    );
    if (!isDashboardAccessRole(userResult.rows[0].role)) {
      return res.status(403).json({ success: false, message: "Dashboard access has not been assigned for this user." });
    }

    const sessionToken = `ols_${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + Number(process.env.OPENLEASH_DASHBOARD_SESSION_DAYS ?? 14) * 86400000);
    await pool.query(
      `insert into dashboard_sessions (organization_id, user_id, token_hash, provider, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [organizationId, userResult.rows[0].id, hashToken(sessionToken), providerType, expiresAt.toISOString()]
    );

    res.json({
      success: true,
      tokens: { accessToken: sessionToken, expiresAt: expiresAt.toISOString() },
      user: userResult.rows[0],
      organization
    });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google/start", (req, res) => {
  const finalRedirectUri = String(req.query.redirectUri ?? "").trim();
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).json({ error: "redirectUri is required and must be an allowed OpenLeash dashboard URL" });
  }
  const exchangeRedirectUri = webGoogleRedirectUri(req);
  if (process.env.OPENLEASH_MOBILE_DEV_AUTH === "1") {
    const redirect = new URL(finalRedirectUri);
    redirect.searchParams.set("code", "dev-auth");
    redirect.searchParams.set("state", "development");
    redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
    return res.redirect(302, redirect.toString());
  }
  const state = encodeMobileAuthState({
    nonce: crypto.randomBytes(18).toString("base64url"),
    finalRedirectUri,
    exchangeRedirectUri
  });
  const authorizationUrl = buildMobileGoogleAuthorizationUrl(exchangeRedirectUri, state);
  if (!authorizationUrl) {
    return res.status(501).json({
      error: "Managed Google login is not configured",
      required: ["OPENLEASH_GOOGLE_CLIENT_ID", "OPENLEASH_GOOGLE_CLIENT_SECRET"]
    });
  }
  res.redirect(302, authorizationUrl);
});

app.get("/auth/microsoft/start", (req, res) => {
  const finalRedirectUri = String(req.query.redirectUri ?? "").trim();
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).json({ error: "redirectUri is required and must be an allowed OpenLeash dashboard URL" });
  }
  const exchangeRedirectUri = webMicrosoftRedirectUri(req);
  if (process.env.OPENLEASH_MOBILE_DEV_AUTH === "1") {
    const redirect = new URL(finalRedirectUri);
    redirect.searchParams.set("code", "dev-auth");
    redirect.searchParams.set("state", "development");
    redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
    return res.redirect(302, redirect.toString());
  }
  const state = encodeMobileAuthState({
    nonce: crypto.randomBytes(18).toString("base64url"),
    finalRedirectUri,
    exchangeRedirectUri
  });
  const authorizationUrl = buildAuthorizationUrl("azure_ad", cloudMicrosoftConfig(), exchangeRedirectUri, state);
  if (!authorizationUrl) {
    return res.status(501).json({
      error: "Managed Microsoft 365 login is not configured",
      required: ["OPENLEASH_MICROSOFT_CLIENT_ID", "OPENLEASH_MICROSOFT_CLIENT_SECRET"]
    });
  }
  res.redirect(302, authorizationUrl);
});

app.get("/auth/google/callback", (req, res) => {
  const state = String(req.query.state ?? "");
  const callbackState = decodeMobileAuthState(state);
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).send("OpenLeash sign-in could not continue because the return URL is invalid.");
  }

  const redirect = new URL(finalRedirectUri);
  const exchangeRedirectUri = callbackState.exchangeRedirectUri ?? webGoogleRedirectUri(req);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value) redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
  res.redirect(302, redirect.toString());
});

app.get("/auth/microsoft/callback", (req, res) => {
  const state = String(req.query.state ?? "");
  const callbackState = decodeMobileAuthState(state);
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).send("OpenLeash sign-in could not continue because the return URL is invalid.");
  }

  const redirect = new URL(finalRedirectUri);
  const exchangeRedirectUri = callbackState.exchangeRedirectUri ?? webMicrosoftRedirectUri(req);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value) redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
  res.redirect(302, redirect.toString());
});

app.get("/auth/session", async (req, res, next) => {
  try {
    const session = await getDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ authenticated: false });
    res.json({
      authenticated: true,
      user: session.user,
      organization: session.organization,
      account: session.account
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/account/package", async (req, res, next) => {
  try {
    const session = await getDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const packageId = normalizeCloudPackage(req.body?.packageId ?? req.body?.plan);
    if (!packageId) return res.status(400).json({ error: "packageId must be personal-byok, personal-managed, work-byok, or work-managed" });
    const audience = packageId.startsWith("work-") ? "organization" : "individual";
    await pool.query(
      `update users
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'accountAudience', $2::text,
         'cloudPackage', $3::text,
         'cloudPackageSelectedAt', now()
       )
       where id = $1`,
      [session.user.id, audience, packageId]
    );
    await pool.query(
      `update organizations
       set infrastructure_config = coalesce(infrastructure_config, '{}'::jsonb) || jsonb_build_object(
         'cloudPackage', $2::text,
         'cloudPackageSelectedAt', now()
       ),
       updated_at = now()
       where id = $1`,
      [session.organization.id, packageId]
    );
    res.json({
      ok: true,
      account: {
        audience,
        packageId
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", async (req, res, next) => {
  try {
    const token = bearerToken(req.header("authorization") ?? "");
    if (token) {
      await pool.query(`update dashboard_sessions set revoked_at = now() where token_hash = $1`, [hashToken(token)]);
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/mobile/bootstrap", async (req, res, next) => {
  try {
    const slug = String(req.query.organizationSlug ?? req.query.slug ?? "").trim();
    let organization = slug ? await getOrganizationBySlug(slug) : undefined;
    if (!organization && clientModeFromEnvironment() === "enterprise") {
      const defaultSlug = String(process.env.OPENLEASH_MANAGED_MOBILE_ORG_SLUG ?? process.env.OPENLEASH_DEV_ORG_SLUG ?? "").trim();
      organization = defaultSlug ? await getOrganizationBySlug(defaultSlug) : await ensureDefaultOrganization();
    }
    const providers = organization
      ? await mobileProvidersForOrganization(organization.id, organization.slug)
      : mobileCloudProviders();
    res.json({
      mode: clientModeFromEnvironment(),
      apiUrl: publicApiUrl(req),
      cloudApiUrl: process.env.OPENLEASH_CLOUD_API_URL ?? publicApiUrl(req),
      providers,
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            region: "region" in organization ? organization.region : null
          }
        : undefined
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/auth/start", async (req, res, next) => {
  try {
    const body = req.body as MobileAuthStartRequest;
    const audience = body.audience === "organization" ? "organization" : "individual";
    const redirectUri = String(body.redirectUri ?? "").trim();
    if (!redirectUri) return res.status(400).json({ error: "redirectUri is required" });

    const organization = body.organizationId
      ? await getOrganizationById(body.organizationId)
      : body.organizationSlug
        ? await getOrganizationBySlug(body.organizationSlug)
        : undefined;

    if (organization) {
      const providerType = String(body.providerType ?? "").trim();
      const provider = await configuredSsoProvider(organization.id, providerType);
      if (!provider) return res.status(404).json({ error: "Identity provider is not configured for this organization" });
      const state = crypto.randomBytes(18).toString("base64url");
      const authorizationUrl = buildAuthorizationUrl(provider.providerType, provider.config, redirectUri, state);
      if (!authorizationUrl) return res.status(400).json({ error: `Identity provider ${provider.providerType} is missing OAuth configuration` });
      return res.json({ authorizationUrl, state, providerType: provider.providerType, organizationId: organization.id });
    }

    const requestedProviderType = String(body.providerType ?? "google").trim();
    const providerType = requestedProviderType === "azure_ad" || requestedProviderType === "microsoft" ? "azure_ad" : "google";
    if (process.env.OPENLEASH_MOBILE_DEV_AUTH === "1") {
      const authorizationUrl = new URL("/v1/mobile/dev-auth/callback", publicApiUrl(req));
      authorizationUrl.searchParams.set("redirectUri", redirectUri);
      authorizationUrl.searchParams.set("audience", audience);
      if (body.organizationId) authorizationUrl.searchParams.set("organizationId", body.organizationId);
      if (body.organizationSlug) authorizationUrl.searchParams.set("organizationSlug", body.organizationSlug);
      return res.json({
        authorizationUrl: authorizationUrl.toString(),
        state: "development",
        providerType,
        exchangeRedirectUri: redirectUri,
        organizationId: body.organizationId,
        development: true
      });
    }

    const exchangeRedirectUri = providerType === "azure_ad"
      ? process.env.OPENLEASH_MICROSOFT_REDIRECT_URI ?? `${publicApiUrl(req)}/v1/auth/microsoft/callback`
      : process.env.OPENLEASH_GOOGLE_REDIRECT_URI ?? `${publicApiUrl(req)}/v1/auth/google/callback`;
    const state = encodeMobileAuthState({
      nonce: crypto.randomBytes(18).toString("base64url"),
      finalRedirectUri: redirectUri,
      exchangeRedirectUri
    });
    const authorizationUrl = providerType === "azure_ad"
      ? buildAuthorizationUrl("azure_ad", cloudMicrosoftConfig(), exchangeRedirectUri, state)
      : buildMobileGoogleAuthorizationUrl(exchangeRedirectUri, state);
    if (!authorizationUrl) {
      return res.status(501).json({
        error: providerType === "azure_ad" ? "Managed Microsoft 365 login is not configured" : "Managed Google login is not configured",
        required: providerType === "azure_ad"
          ? ["OPENLEASH_MICROSOFT_CLIENT_ID", "OPENLEASH_MICROSOFT_CLIENT_SECRET"]
          : ["OPENLEASH_GOOGLE_CLIENT_ID", "OPENLEASH_GOOGLE_CLIENT_SECRET"]
      });
    }
    res.json({ authorizationUrl, state, providerType, exchangeRedirectUri });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/mobile/dev-auth/callback", (req, res) => {
  if (process.env.OPENLEASH_MOBILE_DEV_AUTH !== "1") return res.status(404).send("Not found");
  const redirectUri = String(req.query.redirectUri ?? desktopRedirectUriFallback()).trim();
  if (!isAllowedAuthRedirectUri(redirectUri)) {
    return res.status(400).send("OpenLeash sign-in could not continue because the return URL is invalid.");
  }
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", "development");
  redirect.searchParams.set("state", String(req.query.state ?? "development"));
  const audience = String(req.query.audience ?? "").trim();
  if (audience) redirect.searchParams.set("audience", audience);
  res.redirect(302, redirect.toString());
});

app.get("/v1/auth/google/callback", (req, res) => {
  const state = String(req.query.state ?? "");
  const callbackState = decodeMobileAuthState(state);
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).send("OpenLeash sign-in could not continue because the return URL is invalid.");
  }

  const redirect = new URL(finalRedirectUri);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value) redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set(
    "exchangeRedirectUri",
    callbackState.exchangeRedirectUri ?? `${publicApiUrl(req)}/v1/auth/google/callback`
  );
  res.redirect(302, redirect.toString());
});

app.get("/v1/auth/microsoft/callback", (req, res) => {
  const state = String(req.query.state ?? "");
  const callbackState = decodeMobileAuthState(state);
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).send("OpenLeash sign-in could not continue because the return URL is invalid.");
  }

  const redirect = new URL(finalRedirectUri);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value) redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set(
    "exchangeRedirectUri",
    callbackState.exchangeRedirectUri ?? `${publicApiUrl(req)}/v1/auth/microsoft/callback`
  );
  res.redirect(302, redirect.toString());
});

app.post("/v1/mobile/auth/exchange", async (req, res, next) => {
  try {
    const body = req.body as MobileAuthExchangeRequest;
    const audience = body.audience === "organization" ? "organization" : "individual";
    const providerType = String(body.providerType ?? "google").trim();
    const redirectUri = String(body.redirectUri ?? "").trim();
    const authorizationCode = String(body.authorizationCode ?? "").trim();
    const idToken = String(body.idToken ?? "").trim();
    if (!redirectUri) return res.status(400).json({ success: false, message: "redirectUri is required" });

    const requestedOrganization = body.organizationId
      ? await getOrganizationById(body.organizationId)
      : body.organizationSlug
        ? await getOrganizationBySlug(body.organizationSlug)
        : undefined;
    if ((body.organizationId || body.organizationSlug) && !requestedOrganization) return res.status(404).json({ success: false, message: "Organization not found" });

    const isDevelopmentMobileAuthCode = authorizationCode === "development" || authorizationCode === "dev-auth";
    if ((providerType === "google" || providerType === "azure_ad") && (!authorizationCode || isDevelopmentMobileAuthCode) && !idToken && process.env.OPENLEASH_MOBILE_DEV_AUTH === "1") {
      const profile = {
        subject: "mobile-dev-user",
        email: process.env.OPENLEASH_MOBILE_DEV_EMAIL ?? "mobile.user@openleash.com",
        name: process.env.OPENLEASH_MOBILE_DEV_NAME ?? "Mobile User",
        givenName: "Mobile",
        familyName: "User",
        raw: { development: true }
      };
      if (
        audience === "organization" &&
        isPersonalEmailDomain(profile.email) &&
        !(requestedOrganization && await canUseCloudOwnerLogin(requestedOrganization.id, profile.email))
      ) {
        return res.status(400).json({ success: false, message: "Use your company Google Workspace or Microsoft 365 account, not a personal email address." });
      }
      const provisionUser = body.provisionUser !== false;
      const organization: ManagedOrganization = requestedOrganization
        ? { ...requestedOrganization }
        : provisionUser
        ? await resolveManagedMobileOrganization(profile, audience)
          : await resolveExistingMobileOrganizationForProfile(profile);
      const response = await createDashboardSessionFromProfile({
        organizationId: organization.id,
        providerType,
        profile,
        role: requestedOrganization ? organization.defaultUserRole : audience === "organization" ? "admin" : "engineer",
        provisionUser,
        accountAudience: audience
      });
      return res.json({ ...response, authMode: "development" });
    }

    const organizationForProvider = requestedOrganization ?? (providerType === "google" || providerType === "azure_ad" ? undefined : await ensureManagedMobileOrganization());
    const publicProviderType = providerType === "google" ? "google_workspace" : providerType;
    const publicProviderConfig = providerType === "google"
      ? mobileGoogleConfig()
      : providerType === "azure_ad"
        ? cloudMicrosoftConfig()
        : {};
    const tokenSet = providerType === "google" || (providerType === "azure_ad" && !requestedOrganization)
      ? await exchangeAuthorizationCode(publicProviderType, publicProviderConfig, authorizationCode, redirectUri)
      : body.organizationId || body.organizationSlug
        ? await exchangeOrganizationAuthorizationCode(organizationForProvider!.id, providerType, authorizationCode, redirectUri)
        : await exchangeAuthorizationCode(providerType, {}, authorizationCode, redirectUri);

    const profile = providerType === "google" || (providerType === "azure_ad" && !requestedOrganization)
      ? await fetchSsoProfile(publicProviderType, publicProviderConfig, idToken ? { id_token: idToken } : tokenSet)
      : await fetchSsoProfile(providerType, (await configuredSsoProvider(organizationForProvider!.id, providerType))?.config ?? {}, idToken ? { id_token: idToken } : tokenSet);
    if (!profile.email) return res.status(400).json({ success: false, message: "Identity provider did not return an email address" });
    if (
      audience === "organization" &&
      isPersonalEmailDomain(profile.email) &&
      !(requestedOrganization && await canUseCloudOwnerLogin(requestedOrganization.id, profile.email))
    ) {
      return res.status(400).json({ success: false, message: "Use your company Google Workspace or Microsoft 365 account, not a personal email address." });
    }

    const provisionUser = body.provisionUser !== false;
    const organization: ManagedOrganization = requestedOrganization
      ? { ...requestedOrganization }
      : provisionUser
        ? (providerType === "google" || providerType === "azure_ad" ? await resolveManagedMobileOrganization(profile, audience) : organizationForProvider!)
        : await resolveExistingMobileOrganizationForProfile(profile);
    const response = await createDashboardSessionFromProfile({
      organizationId: organization.id,
      providerType,
      profile,
      role: requestedOrganization ? organization.defaultUserRole : audience === "organization" ? "admin" : "engineer",
      provisionUser,
      accountAudience: audience
    });
    res.json({ ...response, authMode: providerType === "google" ? "google" : "sso" });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/model-key", async (req, res, next) => {
  try {
    const session = await getDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const provider = normalizeTenantModelProvider(req.body.provider ?? req.body.apiProvider);
    const apiKey = String(req.body.apiKey ?? "").trim();
    if (!provider) return res.status(400).json({ error: "provider must be openai, anthropic, or deepseek" });
    if (!apiKey) return res.status(400).json({ error: "apiKey is required" });
    const result = await upsertTenantModelKey({ organizationId: session.organization.id, provider, apiKey });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/devices", async (req, res, next) => {
  try {
    const session = await getDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const body = req.body as MobileDeviceRegisterRequest;
    const result = await pool.query(
      `insert into mobile_devices (organization_id, user_id, platform, push_token, device_name, app_version, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (user_id, push_token) do update set
         platform = excluded.platform,
         device_name = excluded.device_name,
         app_version = excluded.app_version,
         last_seen_at = now()
       returning id, platform, device_name, app_version, last_seen_at`,
      [
        session.organization.id,
        session.user.id,
        body.platform ?? "unknown",
        String(body.pushToken ?? `${session.user.id}:manual`).trim(),
        body.deviceName ?? null,
        body.appVersion ?? null
      ]
    );
    res.status(201).json({ device: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/desktop/enroll", async (req, res, next) => {
  try {
    const session = await getDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const hostname = String(req.body?.hostname ?? os.hostname()).trim() || os.hostname();
    const platform = String(req.body?.platform ?? "unknown");
    const osRelease = typeof req.body?.osRelease === "string" ? req.body.osRelease : null;
    const clientVersion = typeof req.body?.clientVersion === "string" ? req.body.clientVersion : null;
    const agents = normalizeEnrollmentAgents(req.body?.agents);
    const agentToken = `ol_${crypto.randomBytes(24).toString("base64url")}`;
    const user = await pool.query(
      `update users
       set token_hash = $2, status = 'active', last_login_at = now()
       where id = $1 and organization_id = $3
       returning id, email, display_name, organization_id`,
      [session.user.id, hashToken(agentToken), session.organization.id]
    );
    if (!user.rows[0]) return res.status(404).json({ error: "session user not found" });
    const computer = await pool.query(
      `insert into computers (user_id, hostname, platform, os_release, enrolled_at, last_seen_at)
       values ($1, $2, $3, $4, now(), now())
       on conflict (user_id, hostname) do update set
         platform = excluded.platform,
         os_release = excluded.os_release,
         enrolled_at = coalesce(computers.enrolled_at, now()),
         last_seen_at = now()
       returning id, hostname, platform, os_release, enrolled_at, last_seen_at`,
      [session.user.id, hostname, platform, osRelease]
    );
    await upsertDesktopAgentInventory(computer.rows[0].id, agents);
    res.status(201).json({
      token: agentToken,
      user: user.rows[0],
      computer: computer.rows[0],
      agents,
      organization: session.organization,
      clientVersion,
      rulesManagedBy: "openleash-cloud"
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/desktop/agents", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const hostname = String(req.body?.hostname ?? os.hostname()).trim() || os.hostname();
    const platform = String(req.body?.platform ?? "unknown");
    const osRelease = typeof req.body?.osRelease === "string" ? req.body.osRelease : null;
    const agents = normalizeEnrollmentAgents(req.body?.agents);
    const computer = await pool.query(
      `insert into computers (user_id, hostname, platform, os_release, enrolled_at, last_seen_at)
       values ($1, $2, $3, $4, now(), now())
       on conflict (user_id, hostname) do update set
         platform = excluded.platform,
         os_release = excluded.os_release,
         enrolled_at = coalesce(computers.enrolled_at, now()),
         last_seen_at = now()
       returning id, hostname, platform, os_release, enrolled_at, last_seen_at`,
      [session.user.id, hostname, platform, osRelease]
    );
    await upsertDesktopAgentInventory(computer.rows[0].id, agents);
    res.json({ ok: true, computer: computer.rows[0], agents });
  } catch (error) {
    next(error);
  }
});

async function upsertDesktopAgentInventory(computerId: string, agents: ReturnType<typeof normalizeEnrollmentAgents>) {
  for (const agent of agents) {
    await pool.query(
      `insert into agent_runtimes (computer_id, kind, display_name, executable_path, last_seen_at)
       values ($1, $2, $3, $4, now())
       on conflict (computer_id, kind, executable_path_key) do update set
         display_name = excluded.display_name,
         last_seen_at = now()`,
      [computerId, agent.kind, agent.displayName, agent.executablePath]
    );
  }
}

function normalizeEnrollmentAgents(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const kind = typeof item === "string" ? item : String((item as { kind?: unknown })?.kind ?? "");
    const cleanKind = kind.trim().toLowerCase();
    if (!cleanKind || seen.has(cleanKind)) return [];
    seen.add(cleanKind);
    const displayName = typeof item === "object" && item && typeof (item as { displayName?: unknown }).displayName === "string"
      ? (item as { displayName: string }).displayName.trim()
      : "";
    const executablePath = typeof item === "object" && item && typeof (item as { executablePath?: unknown }).executablePath === "string"
      ? (item as { executablePath: string }).executablePath.trim()
      : "";
    return [{ kind: cleanKind, displayName: displayName || enrollmentAgentDisplayName(cleanKind), executablePath }];
  });
}

function enrollmentAgentDisplayName(kind: string) {
  if (kind === "claude-code") return "Claude Code";
  if (kind === "codex") return "OpenAI Codex";
  if (kind === "cline") return "Cline";
  if (kind === "opencode") return "OpenCode";
  if (kind === "cursor") return "Cursor";
  if (kind === "gemini") return "Google Gemini CLI";
  if (kind === "windsurf") return "Windsurf";
  return kind;
}

app.get("/v1/mobile/state", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const [pending, agents, history, sessionMetrics, policies, pluginCatalog] = await Promise.all([
      mobilePendingApprovals(session.user.id, session.organization.id, session.source !== "client"),
      mobileAgents(session.organization.id),
      mobileRecentActivity(session.organization.id),
      mobileSessionMetrics(session.organization.id),
      pool.query(`select id, name, description, severity, natural_language_rule, enabled, locked from policies order by created_at asc`),
      pluginCatalogForOrganization(session.organization.id)
    ]);
    res.json({
      user: session.user,
      organization: session.organization,
      apiUrl: publicApiUrl(req),
      mode: clientModeFromEnvironment(),
      pendingApprovals: pending.rows,
      agents: agents.rows,
      recentActivity: history.rows,
      sessionMetrics: sessionMetrics.rows[0],
      policies: policies.rows,
      plugins: pluginCatalog.plugins,
      clientConfig: {
        approvalNotifications: true,
        managedByOrganization: true
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/decisions/:id/resolve", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const body = req.body as MobileDecisionResolveRequest;
    const resolution = body.resolution === "allow" ? "allow" : "deny";
    const result = await resolveApprovalGroup(req.params.id, resolution, `mobile:${session.user.id}`, {
      organizationId: session.source === "client" ? undefined : session.organization.id,
      userId: session.source === "client" ? session.user.id : undefined
    }, body.resolutionGuidance);
    if (!result) return res.status(404).json({ error: "approval not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function resolveApprovalGroup(
  id: string,
  resolution: "allow" | "deny",
  resolvedBy: string,
  scope: { organizationId?: string; userId?: string } = {},
  resolutionGuidance?: string
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const selected = await client.query<{
      id: string;
      decision: "ask";
      resolution: null;
      resolved_at: Date | null;
      intent_key: string | null;
    }>(
      `select e.id, e.decision, e.resolution, e.resolved_at, ce.payload->'raw'->>'openleashIntentKey' as intent_key
       from evaluations e
       join conversation_events ce on ce.id = e.conversation_event_id
       where e.id = $1
         and e.decision = 'ask'
         and e.resolution is null
         and ($2::uuid is null or e.user_id = $2)
         and (
           $3::uuid is null or exists (
             select 1 from users owner
             where owner.id = e.user_id and owner.organization_id = $3
           )
         )
       for update`,
      [id, scope.userId ?? null, scope.organizationId ?? null]
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("rollback");
      return undefined;
    }
    const guidance = resolution === "deny" ? cleanResolutionGuidance(resolutionGuidance) : undefined;
    const result = await client.query(
      `update evaluations
       set resolution = $2, resolved_at = now(), resolved_by = $3, resolution_guidance = $4
       where id = $1
         and decision = 'ask'
         and resolution is null
       returning id, decision, resolution, resolution_guidance, resolved_at`,
      [id, resolution, resolvedBy, guidance ?? null]
    );
    if (row.intent_key) {
      await client.query(
        `update evaluations e
         set resolution = $2, resolved_at = now(), resolved_by = $3, resolution_guidance = $7
         from conversation_events ce
         where ce.id = e.conversation_event_id
           and e.id <> $1
           and e.decision = 'ask'
           and e.resolution is null
           and ce.payload->'raw'->>'openleashIntentKey' = $4
           and e.created_at > now() - interval '5 minutes'
           and ($5::uuid is null or e.user_id = $5)
           and (
             $6::uuid is null or exists (
               select 1 from users owner
               where owner.id = e.user_id and owner.organization_id = $6
             )
           )`,
        [id, resolution, resolvedBy, row.intent_key, scope.userId ?? null, scope.organizationId ?? null, guidance ?? null]
      );
      const candidates = await client.query<{ id: string; intent_key: string | null }>(
        `select e.id, ce.payload->'raw'->>'openleashIntentKey' as intent_key
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         where e.id <> $1
           and e.decision = 'ask'
           and e.resolution is null
           and e.created_at > now() - interval '5 minutes'
           and ($2::uuid is null or e.user_id = $2)
           and (
             $3::uuid is null or exists (
               select 1 from users owner
               where owner.id = e.user_id and owner.organization_id = $3
             )
           )`,
        [id, scope.userId ?? null, scope.organizationId ?? null]
      );
      const canonicalKey = canonicalIntentKey(row.intent_key);
      const duplicateIds = candidates.rows
        .filter((candidate) => canonicalIntentKey(candidate.intent_key) === canonicalKey)
        .map((candidate) => candidate.id);
      if (duplicateIds.length > 0) {
        await client.query(
          `update evaluations
           set resolution = $2, resolved_at = now(), resolved_by = $3, resolution_guidance = $4
           where id = any($1::uuid[])`,
          [duplicateIds, resolution, resolvedBy, guidance ?? null]
        );
      }
    }
    await client.query("commit");
    return result.rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

app.post("/admin/onboarding/infrastructure", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const deploymentMode = normalizeDeploymentMode(req.body.deploymentMode ?? process.env.OPENLEASH_DEPLOYMENT_MODE);
    if (deploymentMode !== "private") {
      return res.json({ success: true, organization });
    }
    const databaseUrl = String(req.body.databaseUrl ?? "").trim();
    if (!databaseUrl) return res.status(400).json({ success: false, error: "Postgres connection string is required for private deployments." });
    const config = {
      databaseUrl,
      apiUrl: String(req.body.apiUrl ?? "").trim(),
      dashboardUrl: String(req.body.dashboardUrl ?? "").trim(),
      identityLoaderUrl: String(req.body.identityLoaderUrl ?? "").trim(),
      updateFeedUrl: String(req.body.updateFeedUrl ?? "").trim()
    };
    const result = await pool.query(
      `update organizations
       set deployment_mode = 'private', infrastructure_config = $2, current_step = greatest(current_step, 2), updated_at = now()
       where id = $1
       returning *`,
      [organization.id, JSON.stringify(config)]
    );
    res.json({ success: true, organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/company", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const name = String(req.body.name ?? req.body.organizationName ?? "").trim();
    if (!name) return res.status(400).json({ success: false, error: "Organization name is required" });
    const requestedSlug = String(req.body.slug ?? "").trim();
    const slug = slugifyTenant(requestedSlug || name);
    const existingSlug = await pool.query(`select id from organizations where slug = $1 and id <> $2 limit 1`, [slug, organization.id]);
    if ((existingSlug.rowCount ?? 0) > 0) {
      return res.status(409).json({ success: false, error: "That dashboard URL is already taken." });
    }
    const packageId = normalizeCloudPackage(req.body.packageId ?? req.body.plan) ?? "work-managed";
    const result = await pool.query(
      `update organizations
       set name = $2,
           slug = $3,
           region = $4,
           logo_url = $5,
           infrastructure_config = coalesce(infrastructure_config, '{}'::jsonb) || jsonb_build_object(
             'cloudPackage', $6::text,
             'cloudPackageSelectedAt', now()
           ),
           current_step = greatest(current_step, 2),
           updated_at = now()
       where id = $1
       returning *`,
      [organization.id, name, slug, req.body.region ?? null, req.body.logoUrl ?? null, packageId]
    );
    res.json({ organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/generate-code", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const code = generateOnboardingCode();
    const result = await pool.query(
      `update organizations set onboarding_code = $2, updated_at = now() where id = $1 returning *`,
      [organization.id, code]
    );
    res.json({ organization: result.rows[0], code, url: `/setup?code=${encodeURIComponent(code)}` });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/test-idp", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const provider = normalizeIdpProvider(req.body.provider);
    const credentials = providerCredentials(provider, req.body.credentials ?? req.body);
    if (!provider) return res.status(400).json({ success: false, error: "Unsupported identity provider" });
    const identityLoader = process.env.IDENTITY_LOADER_URL;
    if (identityLoader) {
      const response = await fetch(`${identityLoader.replace(/\/+$/, "")}/api/sync/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idpType: provider.idpType, credentials, additionalConfig: { OrganizationId: organization.id } })
      });
      const data = await response.json().catch(() => ({}));
      return res.status(response.ok ? 200 : 400).json(data);
    }
    res.status(400).json({
      success: false,
      error: "Identity sync service is not configured. Set IDENTITY_LOADER_URL to test this provider."
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/sync-identity", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const existing = await pool.query<{ provider: string; config: Record<string, unknown> }>(
      `select provider, config from idp_connections where organization_id = $1 limit 1`,
      [organization.id]
    );
    const provider = normalizeIdpProvider(req.body.provider ?? existing.rows[0]?.provider);
    if (!provider) return res.status(400).json({ success: false, error: "Unsupported identity provider" });
    const incomingCredentials = providerCredentials(provider, req.body.credentials ?? req.body);
    const credentials = hasAnyCredential(incomingCredentials) ? incomingCredentials : (existing.rows[0]?.config ?? {});

    await pool.query(
      `insert into idp_connections (organization_id, provider, config, enabled, updated_at)
       values ($1, $2, $3, true, now())
       on conflict (organization_id) do update set provider = excluded.provider, config = excluded.config, enabled = true, updated_at = now()`,
      [organization.id, provider.idpType, JSON.stringify(credentials)]
    );

    const identityLoader = process.env.IDENTITY_LOADER_URL;
    if (!identityLoader) {
      const error = "Identity sync service is not configured. Set IDENTITY_LOADER_URL to sync real users and groups.";
      await pool.query(`update idp_connections set last_error = $2, updated_at = now() where organization_id = $1`, [organization.id, error]);
      return res.status(400).json({ success: false, error });
    }
    const response = await fetch(`${identityLoader.replace(/\/+$/, "")}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idpType: provider.idpType, credentials, additionalConfig: { OrganizationId: organization.id } })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      await pool.query(`update idp_connections set last_error = $2, updated_at = now() where organization_id = $1`, [organization.id, data.error ?? data.message ?? "Identity sync failed"]);
      return res.status(400).json(data);
    }
    const stats = {
      usersProcessed: Number(data.statistics?.usersProcessed ?? 0),
      groupsProcessed: Number(data.statistics?.groupsProcessed ?? 0),
      membershipsProcessed: Number(data.statistics?.membershipsProcessed ?? 0)
    };

    await pool.query(
      `update idp_connections
       set last_sync_at = now(), user_count = $2, group_count = $3, last_error = null, updated_at = now()
       where organization_id = $1`,
      [organization.id, stats.usersProcessed, stats.groupsProcessed]
    );
    await pool.query(`update organizations set current_step = greatest(current_step, 4), updated_at = now() where id = $1`, [organization.id]);
    res.json({ success: true, message: "Identity sync completed", statistics: stats });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/rbac", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    await pool.query(`delete from role_assignments where organization_id = $1`, [organization.id]);
    const roles = Array.isArray(req.body.roles) ? req.body.roles : [];
    const adminUserIds: string[] = [];
    for (const item of roles) {
      const role = ["admin", "analyst", "responder", "viewer"].includes(item.role) ? item.role : "viewer";
      const groupId = typeof item.groupId === "string" && item.groupId ? item.groupId : null;
      const userId = typeof item.userId === "string" && item.userId ? item.userId : null;
      if (!groupId && !userId) continue;
      if (role === "admin" && userId) adminUserIds.push(userId);
      await pool.query(
        `insert into role_assignments (organization_id, role, group_id, user_id) values ($1, $2, $3, $4)`,
        [organization.id, role, groupId, userId]
      );
    }
    await pool.query(`update users set role = 'engineer' where organization_id = $1 and role = 'admin'`, [organization.id]);
    if (adminUserIds.length > 0) {
      await pool.query(`update users set role = 'admin' where organization_id = $1 and id = any($2::uuid[])`, [organization.id, adminUserIds]);
    }
    await pool.query(`update organizations set current_step = greatest(current_step, 5), updated_at = now() where id = $1`, [organization.id]);
    res.json({ success: true, count: roles.length });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/complete", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    if (!organization.name?.trim()) {
      return res.status(400).json({ success: false, error: "Save your company profile before activating OpenLeash." });
    }
    const result = await pool.query(
      `update organizations set setup_completed = true, current_step = 8, updated_at = now() where id = $1 returning *`,
      [organization.id]
    );
    res.json({ success: true, organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/identity", async (_req, res, next) => {
  try {
    const organization = await ensureDefaultOrganization();
    const [idp, groups, users, roles] = await Promise.all([
      pool.query(`select provider, enabled, last_sync_at, user_count, group_count, last_error from idp_connections where organization_id = $1`, [organization.id]),
      pool.query(
        `select g.id, g.name, g.description, g.idp_provider, count(gm.user_id) as member_count
         from identity_groups g
         left join identity_group_members gm on gm.group_id = g.id
         where g.organization_id = $1
         group by g.id
         order by g.name asc`,
        [organization.id]
      ),
      pool.query(
        `select u.id, u.email, u.display_name, u.role, u.department, u.title, u.idp_provider, u.status,
                count(distinct c.id) as endpoint_count,
                count(distinct ar.id) as agent_count,
                max(greatest(c.last_seen_at, coalesce(ar.last_seen_at, c.last_seen_at))) as last_seen_at
         from users u
         left join computers c on c.user_id = u.id
         left join agent_runtimes ar on ar.computer_id = c.id
         where u.organization_id = $1
         group by u.id
         order by u.display_name asc`,
        [organization.id]
      ),
      pool.query(`select role, count(*) as count from role_assignments where organization_id = $1 group by role`, [organization.id])
    ]);
    res.json({ organization, idp: idp.rows[0] ?? null, groups: groups.rows, users: users.rows, roles: roles.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/triggers", async (req, res, next) => {
  try {
    const filters: string[] = ["exists (select 1 from policy_results pr where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question'))"];
    const values: unknown[] = [];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const param = add(`%${req.query.q.trim()}%`);
      filters.push(`(e.summary ilike ${param} or ce.prompt ilike ${param} or ce.project_path ilike ${param} or ce.tool_name ilike ${param})`);
    }
    if (typeof req.query.user === "string" && req.query.user.trim()) {
      const param = add(`%${req.query.user.trim()}%`);
      filters.push(`u.display_name ilike ${param}`);
    }
    if (typeof req.query.policy === "string" && req.query.policy.trim()) {
      const param = add(`%${req.query.policy.trim()}%`);
      filters.push(`exists (select 1 from policy_results pr where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question') and pr.policy_name ilike ${param})`);
    }
    if (typeof req.query.decision === "string" && ["ask", "deny", "allow"].includes(req.query.decision)) {
      filters.push(`e.decision = ${add(req.query.decision)}`);
    }
    if (typeof req.query.dateFrom === "string" && req.query.dateFrom.trim()) {
      filters.push(`e.created_at >= ${add(req.query.dateFrom)}`);
    }
    if (typeof req.query.dateTo === "string" && req.query.dateTo.trim()) {
      filters.push(`e.created_at <= ${add(req.query.dateTo)}`);
    }
    const limit = Math.min(Number(req.query.limit ?? 100), 250);
    const result = await pool.query(
      `select e.id, e.decision, e.resolution, e.summary, e.question, e.created_at,
              ce.id as event_id, ce.event_name, ce.tool_name, ce.project_path, ce.prompt,
              ar.display_name as agent_name, ar.kind as agent_kind,
              c.hostname, u.display_name as user_name,
              coalesce(triggered.items, '[]'::jsonb) as triggered_policies
       from evaluations e
       join conversation_events ce on ce.id = e.conversation_event_id
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers c on c.id = ce.computer_id
       left join users u on u.id = e.user_id
       left join lateral (
         select jsonb_agg(
           jsonb_build_object(
             'policy_name', pr.policy_name,
             'status', pr.status,
             'severity', pr.severity,
             'explanation', pr.explanation,
             'evidence', pr.evidence
           )
           order by pr.created_at asc
         ) as items
         from policy_results pr
         where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
       ) triggered on true
       where ${filters.join(" and ")}
       order by e.created_at desc
       limit ${add(limit)}`,
      values
    );
    res.json({ triggers: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/triggers/:id", async (req, res, next) => {
  try {
    const [trigger, policies] = await Promise.all([
      pool.query(
        `select e.id, e.decision, e.resolution, e.resolved_at, e.resolved_by, e.summary, e.question, e.model, e.created_at,
                ce.id as event_id, ce.session_id, ce.event_name, ce.tool_name, ce.project_path, ce.prompt, ce.payload, ce.occurred_at,
                ar.display_name as agent_name, ar.kind as agent_kind, ar.version as agent_version,
                c.hostname, c.platform, u.display_name as user_name, u.email as user_email
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         join agent_runtimes ar on ar.id = ce.agent_runtime_id
         join computers c on c.id = ce.computer_id
         left join users u on u.id = e.user_id
         where e.id = $1`,
        [req.params.id]
      ),
      pool.query(
        `select policy_name, status, severity, explanation, evidence, question, created_at
         from policy_results
         where evaluation_id = $1
         order by created_at asc`,
        [req.params.id]
      )
    ]);
    if (!trigger.rows[0]) return res.status(404).json({ error: "trigger not found" });
    const payload = await withTranscriptContext(trigger.rows[0].payload, trigger.rows[0].occurred_at);
    res.json({ trigger: { ...trigger.rows[0], payload, policy_results: policies.rows } });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/logs", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const filters: string[] = ["u.organization_id = $1"];
    const values: unknown[] = [organization.id];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const param = add(`%${req.query.q.trim()}%`);
      filters.push(`(
        ce.prompt ilike ${param}
        or ce.project_path ilike ${param}
        or ce.tool_name ilike ${param}
        or ce.session_id ilike ${param}
        or ce.event_name ilike ${param}
        or ar.display_name ilike ${param}
        or ar.kind ilike ${param}
        or c.hostname ilike ${param}
        or u.display_name ilike ${param}
        or u.email ilike ${param}
        or ce.payload::text ilike ${param}
      )`);
    }
    if (typeof req.query.userId === "string" && req.query.userId.trim()) {
      filters.push(`u.id = ${add(req.query.userId.trim())}`);
    }
    if (typeof req.query.user === "string" && req.query.user.trim()) {
      const param = add(`%${req.query.user.trim()}%`);
      filters.push(`(u.display_name ilike ${param} or u.email ilike ${param})`);
    }
    if (typeof req.query.agent === "string" && req.query.agent.trim()) {
      const param = add(`%${req.query.agent.trim()}%`);
      filters.push(`(ar.display_name ilike ${param} or ar.kind ilike ${param})`);
    }
    if (typeof req.query.event === "string" && req.query.event.trim()) {
      filters.push(`ce.event_name = ${add(req.query.event.trim())}`);
    }
    if (typeof req.query.decision === "string" && ["ask", "deny", "allow", "passed", "logged"].includes(req.query.decision)) {
      if (req.query.decision === "logged") {
        filters.push(`e.id is null`);
      } else if (req.query.decision === "passed") {
        filters.push(`e.decision = 'allow' and not exists (select 1 from policy_results pr where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question'))`);
      } else {
        filters.push(`e.decision = ${add(req.query.decision)}`);
      }
    }
    if (typeof req.query.dateFrom === "string" && req.query.dateFrom.trim()) {
      filters.push(`ce.created_at >= ${add(req.query.dateFrom)}`);
    }
    if (typeof req.query.dateTo === "string" && req.query.dateTo.trim()) {
      filters.push(`ce.created_at <= ${add(req.query.dateTo)}`);
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 250);
    const result = await pool.query(
      `select ce.id, ce.session_id, ce.event_name, ce.project_path, ce.prompt, ce.tool_name,
              ce.payload, ce.occurred_at, ce.created_at,
              e.id as evaluation_id, e.decision, e.resolution, e.summary, e.question, e.created_at as evaluated_at,
              ar.display_name as agent_name, ar.kind as agent_kind, ar.version as agent_version,
              c.hostname, c.platform,
              u.id as user_id, u.display_name as user_name, u.email as user_email,
              coalesce(policy_summary.items, '[]'::jsonb) as policy_results
       from conversation_events ce
       join users u on u.id = ce.user_id
       left join evaluations e on e.conversation_event_id = ce.id
       left join agent_runtimes ar on ar.id = ce.agent_runtime_id
       left join computers c on c.id = ce.computer_id
       left join lateral (
         select jsonb_agg(
           jsonb_build_object(
             'policy_name', pr.policy_name,
             'status', pr.status,
             'severity', pr.severity,
             'explanation', pr.explanation,
             'question', pr.question,
             'evidence', pr.evidence
           )
           order by case pr.status when 'failed' then 0 when 'needs_question' then 1 else 2 end, pr.created_at asc
         ) as items
         from policy_results pr
         where pr.evaluation_id = e.id
       ) policy_summary on true
       where ${filters.join(" and ")}
       order by ce.created_at desc
       limit ${add(limit)}`,
      values
    );
    res.json({ logs: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/logs/:id", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const [log, policies] = await Promise.all([
      pool.query(
        `select ce.id, ce.session_id, ce.event_name, ce.project_path, ce.prompt, ce.tool_name,
                ce.payload, ce.occurred_at, ce.created_at,
                e.id as evaluation_id, e.decision, e.resolution, e.resolution_guidance, e.summary, e.question, e.model, e.created_at as evaluated_at,
                ar.display_name as agent_name, ar.kind as agent_kind, ar.version as agent_version,
                c.hostname, c.platform,
                u.id as user_id, u.display_name as user_name, u.email as user_email
         from conversation_events ce
         join users u on u.id = ce.user_id
         left join evaluations e on e.conversation_event_id = ce.id
         left join agent_runtimes ar on ar.id = ce.agent_runtime_id
         left join computers c on c.id = ce.computer_id
         where ce.id = $1 and u.organization_id = $2`,
        [req.params.id, organization.id]
      ),
      pool.query(
        `select pr.policy_name, pr.status, pr.severity, pr.explanation, pr.evidence, pr.question, pr.created_at
         from policy_results pr
         join evaluations e on e.id = pr.evaluation_id
         join conversation_events ce on ce.id = e.conversation_event_id
         join users u on u.id = ce.user_id
         where ce.id = $1 and u.organization_id = $2
         order by pr.created_at asc`,
        [req.params.id, organization.id]
      )
    ]);
    if (!log.rows[0]) return res.status(404).json({ error: "log not found" });
    const payload = await withTranscriptContext(log.rows[0].payload, log.rows[0].occurred_at);
    res.json({ log: { ...log.rows[0], payload, policy_results: policies.rows } });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/skills/observations", async (req, res, next) => {
  try {
    const token = bearerToken(req.header("authorization") ?? "");
    const user = token ? await getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ error: "missing or invalid OpenLeash token" });
    const organizationId = user.organization_id ?? (await ensureDefaultOrganization()).id;
    const body = req.body as {
      agentKind?: string;
      agentName?: string;
      scope?: "user" | "project";
      projectPath?: string | null;
      skillName?: string;
      skillPath?: string;
      contentHash?: string;
      content?: string;
      contentPreview?: string;
      purposeSummary?: string;
      status?: string;
      riskScore?: number;
      reasons?: Array<{ reason?: string; quote?: string }>;
    };
	    const skillName = String(body.skillName ?? "").trim();
	    const skillPath = String(body.skillPath ?? "").trim();
	    if (!skillName || !skillPath) return res.status(400).json({ error: "skillName and skillPath are required" });
	    const runtimePlugins = await pluginSettingsForRuntime(organizationId);
	    if (runtimePlugins.get("openleash.skill-scanner")?.enabled === false) {
	      return res.json({ ok: true, skipped: true, pluginId: "openleash.skill-scanner" });
	    }
	    const reasons = normalizeSkillReasons(body.reasons);
    const content = typeof body.content === "string" ? body.content.slice(0, 80000) : null;
    const contentPreview = typeof body.contentPreview === "string" ? body.contentPreview.slice(0, 12000) : content?.slice(0, 12000) ?? null;
    const skillScan = await runSkillScanner({
      agentKind: body.agentKind ?? "unknown",
      agentName: body.agentName ?? "Local agent",
      skillName,
      skillPath,
      content,
      contentPreview,
      status: body.status,
      riskScore: body.riskScore,
      reasons
    });
    const suspicious = skillScan.status === "suspicious";
    const status = skillScan.status;
    const contentHash = body.contentHash ?? crypto.createHash("sha256").update(content ?? skillPath).digest("hex");
    const purposeSummary = await skillPurposeSummary({
      provided: body.purposeSummary,
      content: content ?? contentPreview ?? "",
      skillName,
      skillPath
    });
    const client = await pool.connect();
    let signalContext: { eventId: string; computerId: string; runtimeId: string } | undefined;
    try {
      await client.query("begin");
      const skill = await client.query(
        `insert into skills
         (organization_id, user_id, agent_kind, agent_name, scope, project_path, skill_name, skill_path, status, risk_score, reasons, content_hash, content, content_preview, purpose_summary, content_updated_at, first_seen_at, last_seen_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, now(), now(), now(), now())
         on conflict (organization_id, user_id, skill_path) do update set
           agent_kind = excluded.agent_kind,
           agent_name = excluded.agent_name,
           scope = excluded.scope,
           project_path = excluded.project_path,
           skill_name = excluded.skill_name,
           status = excluded.status,
           risk_score = excluded.risk_score,
           reasons = excluded.reasons,
           content_hash = excluded.content_hash,
           content = excluded.content,
           content_preview = excluded.content_preview,
           purpose_summary = excluded.purpose_summary,
           content_updated_at = case when skills.content_hash is distinct from excluded.content_hash then excluded.content_updated_at else coalesce(skills.content_updated_at, excluded.content_updated_at) end,
           last_seen_at = now(),
           updated_at = now()
         returning *`,
        [
          organizationId,
          user.id,
          body.agentKind ?? "unknown",
          body.agentName ?? "Local agent",
          body.scope === "project" ? "project" : "user",
          body.projectPath ?? null,
          skillName,
          skillPath,
          status,
          skillScan.riskScore,
          JSON.stringify(skillScan.reasons),
          contentHash,
          content,
          contentPreview,
          purposeSummary
        ]
      );
      let evaluationId: string | null = null;
      if (suspicious) {
        const computer = await client.query(
          `insert into computers (user_id, hostname, platform, last_seen_at)
           values ($1, $2, $3, now())
           on conflict (user_id, hostname) do update set last_seen_at = now()
           returning id`,
          [user.id, req.hostname || "unknown", "unknown"]
        );
        const runtime = await client.query(
          `insert into agent_runtimes (computer_id, kind, display_name, executable_path, last_seen_at)
           values ($1, $2, $3, $4, now())
           on conflict (computer_id, kind, executable_path_key) do update set display_name = excluded.display_name, last_seen_at = now()
           returning id`,
          [computer.rows[0].id, body.agentKind ?? "unknown", body.agentName ?? "Local agent", ""]
        );
        const event = await client.query(
          `insert into conversation_events
           (user_id, computer_id, agent_runtime_id, session_id, event_name, project_path, prompt, tool_name, payload, occurred_at)
           values ($1, $2, $3, $4, 'SkillChanged', $5, $6, 'agent-skill', $7::jsonb, now())
           returning id`,
          [
            user.id,
            computer.rows[0].id,
            runtime.rows[0].id,
            `skill:${skillPath}`,
            body.projectPath ?? null,
            `Skill ${skillName} changed at ${skillPath}`,
            JSON.stringify({
              openleashEventType: "skill-risk",
              skillName,
              skillPath,
              reasons: skillScan.reasons,
              contentPreview: contentPreview ?? "",
              purposeSummary,
              openleashPluginRuns: [skillScan.run]
            })
          ]
        );
        const evaluation = await client.query(
          `insert into evaluations (conversation_event_id, user_id, decision, summary, question, model)
           values ($1, $2, 'ask', $3, $4, 'skill-evaluator') returning id`,
          [
            event.rows[0].id,
            user.id,
            "OpenLeash detected a possibly malicious agent skill.",
            "OpenLeash detected a possibly malicious agent skill. Delete this skill or approve it?"
          ]
        );
        evaluationId = evaluation.rows[0].id;
        signalContext = {
          eventId: event.rows[0].id,
          computerId: computer.rows[0].id,
          runtimeId: runtime.rows[0].id
        };
        await client.query(
          `insert into policy_results (evaluation_id, policy_id, policy_name, status, severity, explanation, evidence, question)
           values ($1, null, 'Agent skill integrity', 'needs_question', 'high', $2, $3::jsonb, $4)`,
          [
            evaluationId,
            "A newly added or edited agent skill may contain unsafe instructions or executable behavior.",
            JSON.stringify(skillScan.reasons.map((reason) => reason.quote ? `${reason.reason}: ${reason.quote}` : reason.reason)),
            "Delete this skill or approve it?"
          ]
        );
      }
      const event = await client.query(
        `insert into skill_events
         (organization_id, skill_id, evaluation_id, user_id, agent_kind, agent_name, scope, project_path, skill_name, skill_path, event_type, status, risk_score, reasons, content_preview, purpose_summary)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'changed', $11, $12, $13::jsonb, $14, $15)
         returning *`,
        [
          organizationId,
          skill.rows[0].id,
          evaluationId,
          user.id,
          body.agentKind ?? "unknown",
          body.agentName ?? "Local agent",
          body.scope === "project" ? "project" : "user",
          body.projectPath ?? null,
          skillName,
          skillPath,
          status,
          skillScan.riskScore,
          JSON.stringify(skillScan.reasons),
          contentPreview,
          purposeSummary
        ]
      );
      await client.query("commit");
      if (signalContext) {
        await createPluginCapabilities({
          organizationId,
          pluginId: "openleash.skill-scanner",
          conversationEventId: signalContext.eventId,
          userId: user.id,
          computerId: signalContext.computerId,
          runtimeId: signalContext.runtimeId,
          request: {
            computer: {
              hostname: req.hostname || "unknown",
              platform: "unknown"
            },
            agent: {
              kind: body.agentKind ?? "unknown",
              displayName: body.agentName ?? "Local agent"
            },
            event: {
              eventName: "SubagentStart",
              agentKind: body.agentKind ?? "unknown",
              sessionId: `skill:${skillPath}`,
              projectPath: body.projectPath ?? undefined,
              prompt: `Skill ${skillName} changed at ${skillPath}`,
              occurredAt: new Date().toISOString(),
              raw: { openleashEventType: "skill-risk", skillName, skillPath }
            }
          } as EvaluationRequest
        }).signals.emit({
          kind: "security.finding",
          severity: "high",
          title: "Suspicious skill behavior",
          summary: "Skill scanner found behavior that needs review.",
          decision: "ask",
          status,
          target: { type: "agent_skill", name: skillName },
          evidence: skillScan.reasons,
          details: {
            skillName,
            skillPath,
            agentKind: body.agentKind ?? "unknown",
            agentName: body.agentName ?? "Local agent",
            riskScore: skillScan.riskScore
          },
          correlationKeys: [`skill:${skillName}`, `agent:${body.agentKind ?? "unknown"}`]
        });
      }
      if (evaluationId) {
        notifyMobileApprovers(user.id, evaluationId, "Possible malicious skill", "Delete this skill or approve it?", undefined).catch((error) => {
          console.warn("mobile skill notification failed", error);
        });
      }
      res.status(201).json({ skill: skill.rows[0], event: event.rows[0], evaluationId });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get("/admin/pending-decisions", async (_req, res, next) => {
  try {
    const pending = await pool.query(
      `select e.id, e.decision, e.summary, e.question, e.created_at,
              ce.event_name, ce.tool_name, ce.project_path, ce.payload,
              ar.display_name as agent_name, ar.kind as agent_kind,
              c.hostname, u.display_name as user_name,
              coalesce(triggered.items, '[]'::jsonb) as triggered_policies
       from evaluations e
       join conversation_events ce on ce.id = e.conversation_event_id
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers c on c.id = ce.computer_id
       left join users u on u.id = e.user_id
       left join lateral (
         select jsonb_agg(
           jsonb_build_object(
             'policy_name', pr.policy_name,
             'status', pr.status,
             'severity', pr.severity,
             'explanation', pr.explanation,
             'evidence', pr.evidence
           )
           order by pr.created_at asc
         ) as items
         from policy_results pr
         where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
       ) triggered on true
       where e.decision = 'ask' and e.resolution is null
       order by e.created_at asc
       limit 20`
    );
    res.json({ pending: pending.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/tray-status", async (_req, res, next) => {
  try {
    const [pending, agents] = await Promise.all([
      pool.query(
        `select e.id, e.decision, e.summary, e.question, e.created_at,
                ce.event_name, ce.tool_name, ce.project_path, ce.payload,
                ar.display_name as agent_name, ar.kind as agent_kind,
                c.hostname, u.display_name as user_name,
                coalesce(triggered.items, '[]'::jsonb) as triggered_policies
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         join agent_runtimes ar on ar.id = ce.agent_runtime_id
         join computers c on c.id = ce.computer_id
         left join users u on u.id = e.user_id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
         ) triggered on true
         where e.decision = 'ask' and e.resolution is null
         order by e.created_at asc
         limit 20`
      ),
      pool.query(
        `select ar.id, ar.kind, ar.display_name, ar.version, ar.last_seen_at,
                c.hostname, u.display_name as user_name,
                latest.event_name, latest.tool_name, latest.project_path, latest.prompt,
                latest.payload, latest.created_at as activity_at,
                ev.id as decision_id, ev.decision, ev.resolution, ev.resolved_at, ev.summary as decision_summary, ev.question,
                coalesce(triggered.items, '[]'::jsonb) as triggered_policies,
                coalesce(recent.items, '[]'::jsonb) as recent_activity
         from agent_runtimes ar
         join computers c on c.id = ar.computer_id
         left join users u on u.id = c.user_id
         left join lateral (
           select *
           from conversation_events ce
           where ce.agent_runtime_id = ar.id
           order by ce.created_at desc
           limit 1
         ) latest on true
         left join evaluations ev on ev.conversation_event_id = latest.id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = ev.id and pr.status in ('failed', 'needs_question')
         ) triggered on true
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'event_name', item.event_name,
               'tool_name', item.tool_name,
               'project_path', item.project_path,
               'created_at', item.created_at,
               'decision', item.decision,
               'summary', item.summary
             )
             order by item.created_at desc
           ) as items
           from (
             select ce.event_name, ce.tool_name, ce.project_path, ce.created_at, e.decision, e.summary
             from conversation_events ce
             left join evaluations e on e.conversation_event_id = ce.id
             where ce.agent_runtime_id = ar.id
             order by ce.created_at desc
             limit 5
           ) item
         ) recent on true
         where ar.last_seen_at > now() - interval '5 minutes'
            or latest.created_at > now() - interval '5 minutes'
         order by greatest(ar.last_seen_at, coalesce(latest.created_at, ar.last_seen_at)) desc
         limit 12`
      )
    ]);

    res.json({
      pending: pending.rows,
      agents: agents.rows.map((agent) => ({
        ...agent,
        short_summary: summarizeAgentActivity(agent)
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/decisions/:id", async (req, res, next) => {
  try {
    const auth = req.header("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const user = token ? await getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ error: "invalid OpenLeash token" });

    const decision = await pool.query(
      `select id, decision, resolution, summary, question, resolved_at
       from evaluations
       where id = $1 and user_id = $2`,
      [req.params.id, user.id]
    );
    res.json(decision.rows[0] ?? null);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/decisions/:id/resolve", async (req, res, next) => {
  try {
    const resolution = req.body.resolution === "allow" ? "allow" : "deny";
    const result = await resolveApprovalGroup(req.params.id, resolution, req.body.resolvedBy ?? "local-user", {}, req.body.resolutionGuidance);
    res.json(result ?? null);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/users", async (req, res, next) => {
  try {
    const token = `ol_${crypto.randomBytes(24).toString("base64url")}`;
    const user = await pool.query(
      `insert into users (email, display_name, role, token_hash)
       values ($1, $2, $3, $4)
       returning id, email, display_name, role, created_at`,
      [req.body.email, req.body.displayName, req.body.role ?? "engineer", hashToken(token)]
    );
    res.status(201).json({ user: user.rows[0], token });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/deployment-tokens", async (_req, res, next) => {
  try {
    const tokens = await pool.query(
      `select id, label, mode, tenant_url, mdm, expires_at, revoked_at, created_at, last_used_at
       from deployment_tokens
       order by created_at desc
       limit 50`
    );
    res.json({ tokens: tokens.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/deployment-tokens", async (req, res, next) => {
  try {
    const token = `ol_deploy_${crypto.randomBytes(24).toString("base64url")}`;
    const label = String(req.body.label ?? "MDM deployment").trim() || "MDM deployment";
    const mode = req.body.mode === "private" ? "private" : "cloud";
    const tenantUrl = String(req.body.tenantUrl ?? process.env.OPENLEASH_TENANT_URL ?? "openleash.com").trim();
    const mdm = typeof req.body.mdm === "string" && req.body.mdm.trim() ? req.body.mdm.trim() : null;
    const expiresInDays = Number(req.body.expiresInDays ?? 30);
    const result = await pool.query(
      `insert into deployment_tokens (label, token_hash, mode, tenant_url, mdm, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6::text || ' days')::interval)
       returning id, label, mode, tenant_url, mdm, expires_at, created_at`,
      [label, hashToken(token), mode, tenantUrl, mdm, Number.isFinite(expiresInDays) ? Math.max(1, Math.min(365, expiresInDays)) : 30]
    );
    res.status(201).json({ token, deploymentToken: result.rows[0], command: enrollmentCommand(tenantUrl, token) });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/deployment-tokens/:id/revoke", async (req, res, next) => {
  try {
    const result = await pool.query(
      `update deployment_tokens set revoked_at = now() where id = $1 returning id, revoked_at`,
      [req.params.id]
    );
    res.json(result.rows[0] ?? null);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/events/:id", async (req, res, next) => {
  try {
    const event = await pool.query(
      `select ce.*, e.decision, e.summary, e.question
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ce.id = $1`,
      [req.params.id]
    );
    res.json(event.rows[0] ?? null);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/policies", async (req, res, next) => {
  try {
    const naturalLanguageRule = String(req.body.naturalLanguageRule ?? "");
    const name = summarizePolicyTitle(naturalLanguageRule);
    const category = policyCategory(String(req.body.category ?? ""), name, naturalLanguageRule);
    const result = await pool.query(
      `insert into policies (name, category, description, severity, natural_language_rule, enabled, locked)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [name, category, req.body.description ?? "", req.body.severity ?? "medium", naturalLanguageRule, req.body.enabled ?? true, Boolean(req.body.locked)]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/plugins", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json(await pluginCatalogForOrganization(organizationId));
  } catch (error) {
    next(error);
  }
});

app.get("/v1/plugins", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    res.json(await pluginCatalogForOrganization(session.organization.id));
  } catch (error) {
    next(error);
  }
});

app.get("/v1/plugin-marketplace", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    res.json(await pluginMarketplaceForOrganization(session.organization.id, String(req.query.search ?? "")));
  } catch (error) {
    next(error);
  }
});

app.get("/public/plugins", async (req, res, next) => {
  try {
    res.json({ listings: await readMarketplaceListings(String(req.query.search ?? "")) });
  } catch (error) {
    next(error);
  }
});

app.get("/public/plugins/:slug", async (req, res, next) => {
  try {
    const plugin = await readMarketplaceListingBySlug(req.params.slug);
    if (!plugin) return res.status(404).json({ error: "plugin not found" });
    res.json(plugin);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/plugin-marketplace", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json(await pluginMarketplaceForOrganization(organizationId, String(req.query.search ?? ""), { includePending: true }));
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugins/:pluginId/settings", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const result = await savePluginSettingsForOrganization(organizationId, req.params.pluginId, req.body);
    if (!result) return res.status(404).json({ error: "plugin not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugins/:pluginId/policy", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const result = await saveOrganizationPluginPolicy(organizationId, req.params.pluginId, req.body);
    if (!result) return res.status(404).json({ error: "plugin not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugin-marketplace/policy", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json(await saveOrganizationMarketplacePolicy(organizationId, req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugins/:pluginId/settings", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const result = await savePluginSettingsForOrganization(session.organization.id, req.params.pluginId, req.body);
    if (!result) return res.status(404).json({ error: "plugin not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugins/:pluginId/install", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const result = await installMarketplacePluginForUser(session.organization.id, req.params.pluginId, session.source);
    if (!result) return res.status(404).json({ error: "plugin not found or not installable" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugins/:pluginId/uninstall", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const result = await uninstallMarketplacePluginForUser(session.organization.id, req.params.pluginId, session.source);
    if (!result) return res.status(404).json({ error: "plugin not found or mandatory" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugin-submissions", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(req.header("authorization") ?? "");
    if (!session) return res.status(401).json({ error: "invalid OpenLeash session" });
    const submission = await createPluginSubmission(session.organization.id, session.user.id, req.body);
    res.status(201).json(submission);
  } catch (error) {
    next(error);
  }
});

type ApiUser = { id: string; email?: string; display_name?: string; organization_id?: string | null };

async function handlePromptOnlyHook(agent: HookAgentSlug, eventName: HookEventName, request: EvaluationRequest, user: ApiUser) {
  const intentKey = triggerIntentKey(request);
  const { conversationEventId, computerId, runtimeId, organizationId } = await recordConversationEvent(request, user, intentKey);
  const config = await readPromptTransformConfig(organizationId);
  if (!request.event.prompt || !promptTransformsEnabled(config)) {
    return nativeHookDecision(agent, eventName, { decision: "allow", decisionId: "", summary: "OpenLeash logged this prompt intent.", results: [] });
  }
  const result = await runPromptPipeline({
    request,
    config,
    organizationId,
    conversationEventId,
    userId: user.id,
    computerId,
    runtimeId,
    apiKey: process.env.OPENAI_API_KEY || process.env.OPENLEASH_OPENAI_API_KEY,
    plugins: await pluginSettingsForRuntime(organizationId)
  });
  await recordPromptTransformResult(conversationEventId, user.id, request.event.prompt, result);
  if (result.blocked) {
    return nativeHookDecision(agent, eventName, {
      decision: "deny",
      decisionId: "",
      summary: result.summary,
      results: []
    });
  }
  return promptTransformHookDecision(agent, eventName, result.finalPrompt, result.summary);
}

async function readPromptTransformConfig(organizationId: string): Promise<PromptTransformConfig> {
  const row = await pool.query<{ config: unknown }>(
    "select config from prompt_transform_settings where organization_id = $1",
    [organizationId]
  );
  const config = normalizePromptTransformConfig(row.rows[0]?.config ?? defaultPromptTransformConfig);
  const pluginSettings = await readPluginSettings(organizationId);
  const compression = pluginSettings.get("openleash.prompt-compression");
  if (compression) {
    config.compression = normalizePromptTransformConfig({
      compression: {
        ...config.compression,
        ...(compression.config ?? {}),
        enabled: compression.enabled
      }
    }).compression;
  }
  const dlp = pluginSettings.get("openleash.dlp");
  if (dlp) {
    config.dlp = normalizePromptTransformConfig({
      dlp: {
        ...config.dlp,
        ...(dlp.config ?? {}),
        enabled: dlp.enabled
      }
    }).dlp;
  }
  return config;
}

type PluginSettingRecord = {
  pluginId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  orderingPriority: number | null;
  updatedAt?: string;
};

type PluginPolicyRecord = {
  pluginId: string;
  mandatory: boolean;
  defaultEnabled: boolean;
  userInstallAllowed: boolean;
};

type MarketplacePolicyRecord = {
  allowUserMarketplaceInstalls: boolean;
  allowUserCommunityPlugins: boolean;
};

async function pluginCatalogForOrganization(organizationId: string): Promise<{ plugins: PluginCatalogItem[]; marketplacePolicy: MarketplacePolicyRecord }> {
  const settings = await readPluginSettings(organizationId);
  const policy = await readOrganizationPluginPolicy(organizationId);
  const marketplacePolicy = await readOrganizationMarketplacePolicy(organizationId);
  const marketplace = await readMarketplaceListings("");
  const marketplaceById = new Map(marketplace.map((item) => [item.id, item]));
  const manifestsById = new Map(firstPartyPluginManifests.map((manifest) => [manifest.id, manifest]));
  const ids = new Set([...marketplaceById.keys(), ...manifestsById.keys()]);
  return {
    marketplacePolicy,
    plugins: [...ids]
      .map((pluginId) => {
        const listing = marketplaceById.get(pluginId);
        const manifest = manifestsById.get(pluginId) ?? listing;
        if (!manifest) return undefined;
        return pluginCatalogItem(manifest, settings.get(pluginId), listing, policy.get(pluginId), marketplacePolicy);
      })
      .filter((item): item is PluginCatalogItem => Boolean(item))
  };
}

function pluginCatalogItem(
  manifest: OpenLeashPluginManifest,
  settings?: PluginSettingRecord,
  marketplace?: PluginMarketplaceListing,
  policy?: PluginPolicyRecord,
  marketplacePolicy?: MarketplacePolicyRecord
): PluginCatalogItem {
  const enabled = policy?.mandatory ? true : settings?.enabled ?? policy?.defaultEnabled ?? true;
  return {
    ...manifest,
    slug: manifest.slug ?? marketplace?.slug,
    marketplace,
    settings: {
      enabled,
      config: settings?.config ?? manifest.defaultConfig ?? {},
      orderingPriority: settings?.orderingPriority ?? manifest.ordering?.priority ?? null,
      updatedAt: settings?.updatedAt
    },
    organizationPolicy: {
      mandatory: Boolean(policy?.mandatory),
      defaultEnabled: Boolean(policy?.defaultEnabled ?? true),
      userInstallAllowed: Boolean(policy?.userInstallAllowed ?? marketplacePolicy?.allowUserMarketplaceInstalls ?? true)
    }
  };
}

async function savePluginSettingsForOrganization(organizationId: string, pluginId: string, body: Record<string, unknown>) {
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  const policy = (await readOrganizationPluginPolicy(organizationId)).get(pluginId);
  const enabled = policy?.mandatory ? true : typeof body.enabled === "boolean" ? body.enabled : true;
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config)
    ? body.config as Record<string, unknown>
    : manifest.defaultConfig ?? {};
  const orderingPriority = Number.isFinite(Number(body.orderingPriority))
    ? Number(body.orderingPriority)
    : manifest.ordering?.priority ?? null;
  const result = await pool.query(
    `insert into plugin_settings (organization_id, plugin_id, enabled, config, ordering_priority, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, now())
     on conflict (organization_id, plugin_id) do update set
       enabled = excluded.enabled,
       config = excluded.config,
       ordering_priority = excluded.ordering_priority,
       updated_at = now()
     returning plugin_id, enabled, config, ordering_priority as "orderingPriority", updated_at`,
    [organizationId, manifest.id, enabled, JSON.stringify(config), orderingPriority]
  );
  return { pluginId: manifest.id, settings: result.rows[0] };
}

async function pluginMarketplaceForOrganization(organizationId: string, search: string, options: { includePending?: boolean } = {}) {
  const [plugins, marketplacePolicy] = await Promise.all([
    pluginCatalogForOrganization(organizationId),
    readOrganizationMarketplacePolicy(organizationId)
  ]);
  let listings = await readMarketplaceListings(search, options);
  if (!marketplacePolicy.allowUserCommunityPlugins) {
    listings = listings.filter((listing) => listing.source === "first_party");
  }
  const installed = new Set(plugins.plugins.filter((plugin) => plugin.settings.enabled).map((plugin) => plugin.id));
  const mandatory = new Set(plugins.plugins.filter((plugin) => plugin.organizationPolicy?.mandatory).map((plugin) => plugin.id));
  return {
    marketplacePolicy,
    listings: listings.map((listing) => ({
      ...listing,
      installed: installed.has(listing.id),
      mandatory: mandatory.has(listing.id),
      installable: marketplacePolicy.allowUserMarketplaceInstalls || mandatory.has(listing.id) || installed.has(listing.id)
    }))
  };
}

async function readMarketplaceListings(search: string, options: { includePending?: boolean } = {}): Promise<PluginMarketplaceListing[]> {
  const query = search.trim();
  const params: unknown[] = [];
  const where = [options.includePending ? "review_status <> 'rejected'" : "review_status = 'approved'"];
  if (query) {
    params.push(query);
    where.push(`(
      to_tsvector('english', slug || ' ' || description || ' ' || short_description || ' ' || coalesce(tags::text, '')) @@ plainto_tsquery('english', $${params.length})
      or slug ilike '%' || $${params.length} || '%'
    )`);
  }
  const rows = await pool.query(
    `select *
     from plugin_marketplace
     where ${where.join(" and ")}
     order by featured_rank nulls last, slug asc
     limit 50`,
    params
  );
  return rows.rows.map(marketplaceListingFromRow);
}

async function readMarketplaceListingBySlug(slug: string): Promise<PluginMarketplaceListing | undefined> {
  const rows = await pool.query(
    `select *
     from plugin_marketplace
     where slug = $1 and review_status = 'approved'
     limit 1`,
    [slug]
  );
  return rows.rows[0] ? marketplaceListingFromRow(rows.rows[0]) : undefined;
}

function marketplaceListingFromRow(row: Record<string, unknown>): PluginMarketplaceListing {
  const slug = String(row.slug);
  return {
    id: String(row.plugin_id),
    slug,
    name: slug,
    description: String(row.description),
    version: String(row.version),
    publisher: String(row.publisher),
    developerName: String(row.developer_name),
    developerUrl: optionalString(row.developer_url),
    source: String(row.source) as PluginMarketplaceListing["source"],
    reviewStatus: String(row.review_status) as PluginMarketplaceListing["reviewStatus"],
    shortDescription: String(row.short_description),
    longDescription: String(row.long_description),
    heroTagline: String(row.hero_tagline),
    packageUrl: optionalString(row.package_url),
    repositoryUrl: optionalString(row.repository_url),
    documentationUrl: optionalString(row.documentation_url),
    runtime: String(row.runtime) as PluginMarketplaceListing["runtime"],
    entrypoint: String(row.entrypoint),
    events: arrayValue(row.events) as PluginMarketplaceListing["events"],
    permissions: arrayValue(row.permissions) as PluginMarketplaceListing["permissions"],
    effects: arrayValue(row.effects) as PluginMarketplaceListing["effects"],
    ordering: objectValue(row.ordering) as PluginMarketplaceListing["ordering"],
    configSchema: objectValue(row.config_schema) as PluginMarketplaceListing["configSchema"],
    defaultConfig: objectValue(row.default_config) ?? {},
    tags: arrayValue(row.tags),
    iconText: String(row.icon_text ?? "OL"),
    visualPng: optionalString(row.visual_png),
    featuredRank: row.featured_rank === null || row.featured_rank === undefined ? null : Number(row.featured_rank),
    seoTitle: String(row.seo_title),
    seoDescription: String(row.seo_description),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at)
  };
}

async function manifestForPluginId(pluginId: string): Promise<OpenLeashPluginManifest | undefined> {
  const firstParty = firstPartyPluginManifests.find((plugin) => plugin.id === pluginId);
  if (firstParty) return firstParty;
  const rows = await pool.query("select * from plugin_marketplace where plugin_id = $1 and review_status = 'approved'", [pluginId]);
  const listing = rows.rows[0] ? marketplaceListingFromRow(rows.rows[0]) : undefined;
  return listing;
}

async function installMarketplacePluginForUser(organizationId: string, pluginId: string, source: "client" | "dashboard") {
  const policy = await readOrganizationMarketplacePolicy(organizationId);
  const pluginPolicy = (await readOrganizationPluginPolicy(organizationId)).get(pluginId);
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  if (source === "client" && !pluginPolicy?.mandatory && !policy.allowUserMarketplaceInstalls) return undefined;
  if (source === "client" && manifest.publisher !== "openleash" && !policy.allowUserCommunityPlugins) return undefined;
  return savePluginSettingsForOrganization(organizationId, pluginId, { enabled: true, config: manifest.defaultConfig ?? {} });
}

async function uninstallMarketplacePluginForUser(organizationId: string, pluginId: string, source: "client" | "dashboard") {
  const pluginPolicy = (await readOrganizationPluginPolicy(organizationId)).get(pluginId);
  if (pluginPolicy?.mandatory) return undefined;
  if (source === "client" && !pluginPolicy?.userInstallAllowed) return undefined;
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  return savePluginSettingsForOrganization(organizationId, pluginId, { enabled: false, config: manifest.defaultConfig ?? {} });
}

async function saveOrganizationPluginPolicy(organizationId: string, pluginId: string, body: Record<string, unknown>) {
  if (!await manifestForPluginId(pluginId)) return undefined;
  const mandatory = Boolean(body.mandatory);
  const defaultEnabled = mandatory || Boolean(body.defaultEnabled);
  const userInstallAllowed = body.userInstallAllowed !== false;
  const result = await pool.query(
    `insert into organization_plugin_policy (organization_id, plugin_id, mandatory, default_enabled, user_install_allowed, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (organization_id, plugin_id) do update set
       mandatory = excluded.mandatory,
       default_enabled = excluded.default_enabled,
       user_install_allowed = excluded.user_install_allowed,
       updated_at = now()
     returning plugin_id as "pluginId", mandatory, default_enabled as "defaultEnabled", user_install_allowed as "userInstallAllowed", updated_at as "updatedAt"`,
    [organizationId, pluginId, mandatory, defaultEnabled, userInstallAllowed]
  );
  if (mandatory) await savePluginSettingsForOrganization(organizationId, pluginId, { enabled: true });
  return { pluginId, policy: result.rows[0] };
}

async function saveOrganizationMarketplacePolicy(organizationId: string, body: Record<string, unknown>) {
  const allowUserMarketplaceInstalls = body.allowUserMarketplaceInstalls !== false;
  const allowUserCommunityPlugins = Boolean(body.allowUserCommunityPlugins);
  const result = await pool.query(
    `insert into organization_plugin_marketplace_policy (organization_id, allow_user_marketplace_installs, allow_user_community_plugins, updated_at)
     values ($1, $2, $3, now())
     on conflict (organization_id) do update set
       allow_user_marketplace_installs = excluded.allow_user_marketplace_installs,
       allow_user_community_plugins = excluded.allow_user_community_plugins,
       updated_at = now()
     returning allow_user_marketplace_installs as "allowUserMarketplaceInstalls",
               allow_user_community_plugins as "allowUserCommunityPlugins",
               updated_at as "updatedAt"`,
    [organizationId, allowUserMarketplaceInstalls, allowUserCommunityPlugins]
  );
  return { marketplacePolicy: result.rows[0] };
}

async function readOrganizationPluginPolicy(organizationId: string) {
  const rows = await pool.query<{
    plugin_id: string;
    mandatory: boolean;
    default_enabled: boolean;
    user_install_allowed: boolean;
  }>(
    `select plugin_id, mandatory, default_enabled, user_install_allowed
     from organization_plugin_policy
     where organization_id = $1`,
    [organizationId]
  );
  return new Map<string, PluginPolicyRecord>(rows.rows.map((row) => [row.plugin_id, {
    pluginId: row.plugin_id,
    mandatory: row.mandatory,
    defaultEnabled: row.default_enabled,
    userInstallAllowed: row.user_install_allowed
  }]));
}

async function readOrganizationMarketplacePolicy(organizationId: string): Promise<MarketplacePolicyRecord> {
  const rows = await pool.query<{
    allow_user_marketplace_installs: boolean;
    allow_user_community_plugins: boolean;
  }>(
    `select allow_user_marketplace_installs, allow_user_community_plugins
     from organization_plugin_marketplace_policy
     where organization_id = $1`,
    [organizationId]
  );
  return {
    allowUserMarketplaceInstalls: rows.rows[0]?.allow_user_marketplace_installs ?? true,
    allowUserCommunityPlugins: rows.rows[0]?.allow_user_community_plugins ?? true
  };
}

async function createPluginSubmission(organizationId: string, submittedBy: string, body: Record<string, unknown>) {
  const slug = slugify(String(body.slug ?? body.name ?? ""));
  const pluginId = String(body.pluginId ?? `community.${slug}`).trim();
  const developerName = String(body.developerName ?? "").trim();
  if (!slug || !developerName) {
    const error = new Error("Plugin slug and developer name are required.");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const manifest = body.manifest && typeof body.manifest === "object" && !Array.isArray(body.manifest) ? body.manifest : {};
  const result = await pool.query(
    `insert into plugin_submissions (organization_id, submitted_by, plugin_id, slug, name, developer_name, package_url, repository_url, manifest)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     returning id, plugin_id as "pluginId", slug, name, developer_name as "developerName", status, created_at as "createdAt"`,
    [organizationId, submittedBy, pluginId, slug, slug, developerName, optionalString(body.packageUrl), optionalString(body.repositoryUrl), JSON.stringify(manifest)]
  );
  return { submission: result.rows[0] };
}

async function readPluginSettings(organizationId: string) {
  const rows = await pool.query<{
    plugin_id: string;
    enabled: boolean;
    config: Record<string, unknown>;
    ordering_priority: number | null;
    updated_at: string;
  }>(
    `select plugin_id, enabled, config, ordering_priority, updated_at
     from plugin_settings
     where organization_id = $1`,
    [organizationId]
  );
  return new Map<string, PluginSettingRecord>(rows.rows.map((row) => [
    row.plugin_id,
    {
      pluginId: row.plugin_id,
      enabled: row.enabled,
      config: row.config ?? {},
      orderingPriority: row.ordering_priority,
      updatedAt: row.updated_at
    }
  ]));
}

async function pluginSettingsForRuntime(organizationId: string) {
  const settings = await readPluginSettings(organizationId);
  return new Map(firstPartyPluginManifests.map((manifest) => {
    const stored = settings.get(manifest.id);
    return [
      manifest.id,
      {
        enabled: stored?.enabled ?? true,
        config: stored?.config ?? manifest.defaultConfig ?? {},
        orderingPriority: stored?.orderingPriority ?? manifest.ordering?.priority ?? null,
        updatedAt: stored?.updatedAt
      }
    ];
  }));
}

async function organizationIdForAdminRequest(req: express.Request) {
  const slug = typeof req.query.organizationSlug === "string" ? req.query.organizationSlug : undefined;
  if (slug) {
    const organization = await pool.query<{ id: string }>("select id from organizations where slug = $1", [slug]);
    if (organization.rows[0]?.id) return organization.rows[0].id;
  }
  return (await ensureDefaultOrganization()).id;
}

async function recordPromptTransformResult(conversationEventId: string, userId: string, originalPrompt: string, result: PromptPipelineResult) {
  await pool.query(
    `update conversation_events
     set payload = payload || $2::jsonb
     where id = $1`,
    [conversationEventId, JSON.stringify({
      openleashPromptTransform: {
        originalPrompt,
        finalPrompt: result.finalPrompt,
        blocked: result.blocked,
        compression: result.compression,
        dlp: result.dlp
      },
      openleashPluginRuns: result.runs
    })]
  );
  await pool.query(
    `insert into evaluations (conversation_event_id, user_id, decision, summary, question, model)
     values ($1, $2, $3, $4, null, $5)`,
    [conversationEventId, userId, result.blocked ? "deny" : "allow", result.summary, result.model]
  );
}

async function recordPluginRuns(conversationEventId: string, runs: PluginRunRecord[]) {
  if (runs.length === 0) return;
  await pool.query(
    `update conversation_events
     set payload = payload || $2::jsonb
     where id = $1`,
    [conversationEventId, JSON.stringify({ openleashPluginRuns: runs })]
  );
}

async function readPluginLogsForConversation(conversationEventId: string): Promise<PluginLogRecord[]> {
  const rows = await pool.query<{
    id: string;
    plugin_id: string;
    level: PluginLogRecord["level"];
    category: PluginLogRecord["category"];
    code: string | null;
    message: string;
    scope: PluginLogRecord["scope"] | null;
    data: Record<string, unknown> | null;
    created_at: string;
  }>(
    `select id, plugin_id, level, category, code, message, scope, data, created_at
     from plugin_log_events
     where conversation_event_id = $1
     order by created_at asc`,
    [conversationEventId]
  );
  return rows.rows.map((row) => ({
    id: row.id,
    pluginId: row.plugin_id,
    level: row.level,
    category: row.category,
    code: row.code ?? undefined,
    message: row.message,
    scope: row.scope ?? undefined,
    data: row.data ?? {},
    createdAt: row.created_at
  }));
}

async function recordOpenLeashSystemLog({
  organizationId,
  conversationEventId,
  userId,
  computerId,
  runtimeId,
  level,
  code,
  message,
  data
}: {
  organizationId: string;
  conversationEventId: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
  level: PluginLogRecord["level"];
  code: string;
  message: string;
  data?: Record<string, unknown>;
}) {
  await pool.query(
    `insert into plugin_log_events
     (organization_id, plugin_id, conversation_event_id, user_id, computer_id, agent_runtime_id, level, category, code, message, data)
     values ($1, 'openleash.core', $2, $3, $4, $5, $6, 'system', $7, $8, $9::jsonb)`,
    [
      organizationId,
      conversationEventId,
      userId ?? null,
      computerId ?? null,
      runtimeId ?? null,
      level,
      code,
      message,
      JSON.stringify(data ?? {})
    ]
  );
}

async function exportPluginLogs({
  logs,
  organization,
  user,
  request,
  conversationEventId,
  plugins
}: {
  logs: PluginLogRecord[];
  organization: { id: string; name?: string; slug?: string | null };
  user: { id: string; email?: string; displayName?: string };
  request: EvaluationRequest;
  conversationEventId: string;
  plugins: Map<string, PluginSettingState>;
}) {
  const runs: PluginRunRecord[] = [];
  for (const log of logs) {
    runs.push(...await runLogExportPlugins({
      log,
      organization,
      user,
      request,
      conversationEventId,
      plugins
    }));
  }
  return runs;
}

async function evaluateAndRecord(request: EvaluationRequest, user: ApiUser): Promise<EvaluationResponse> {
  const intentKey = triggerIntentKey(request);
  const { conversationEventId, computerId, runtimeId, organizationId } = await recordConversationEvent(request, user, intentKey);
  const handledIntent = intentKey ? await findRecentHandledIntent(user.id, request, intentKey) : undefined;
  if (handledIntent) {
    return {
      decision: handledIntent.resolution ?? handledIntent.decision,
      decisionId: handledIntent.id,
      summary: handledIntent.summary,
      question: handledIntent.resolution ? undefined : handledIntent.question ?? undefined,
      results: []
    };
  }
  const policies = await pool.query<Policy>(
      `select id, name, description, severity, natural_language_rule as "naturalLanguageRule", enabled, locked
     from policies where enabled = true order by created_at asc`
  );
  const tenantModelKey = await tenantModelKeyForEvaluation(organizationId);
  const runtimePlugins = await pluginSettingsForRuntime(organizationId);
  const pipeline = await runEvaluationPipeline({
    request,
    organizationId,
    conversationEventId,
    userId: user.id,
    computerId,
    runtimeId,
    policies: policies.rows,
    tenantModelKey,
    plugins: runtimePlugins
  });
  const { results: evaluatedResults, model } = pipeline;
  const promptOnlyDeferred = shouldDeferPromptOnlyApproval(request, evaluatedResults);
  const results = promptOnlyDeferred ? deferPromptOnlyPolicyResults(evaluatedResults) : evaluatedResults;
  const decision = results.some((r) => r.status === "failed" || r.status === "needs_question")
    ? "ask"
    : "allow";
  const blockingResult = results.find((r) => r.status === "failed");
  const approvalSummary =
    blockingResult
      ? summarizeBlockedAction(request, blockingResult.policyName)
      : results.find((r) => r.status === "needs_question")?.explanation ??
        "OpenLeash needs a human decision before continuing.";
  const question =
    blockingResult
      ? `${approvalSummary} Allow this action once?`
      : results.find((r) => r.status === "needs_question")?.question ??
        (decision === "ask"
          ? `${request.agent.displayName} needs approval for ${request.event.tool?.name ?? request.event.eventName}. Allow it?`
          : undefined);
  const summary =
    decision === "allow"
      ? "All active policies passed."
      : approvalSummary;
  const evaluation = await pool.query(
    `insert into evaluations (conversation_event_id, user_id, decision, summary, question, model)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [conversationEventId, user.id, decision, summary, question ?? null, model]
  );
  for (const result of results) {
    const policyId = resolvePolicyResultPolicyId(result, policies.rows);
    await pool.query(
      `insert into policy_results
       (evaluation_id, policy_id, policy_name, status, severity, explanation, evidence, question)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        evaluation.rows[0].id,
        policyId,
        result.policyName,
        result.status,
        result.severity,
        result.explanation,
        JSON.stringify(result.evidence ?? []),
        result.question ?? null
      ]
    );
  }
  await recordMcpToolCall({
    call: pipeline.mcpCall,
    organizationId,
    conversationEventId,
    evaluationId: evaluation.rows[0].id,
    userId: user.id,
    computerId,
    runtimeId,
    request,
    decision
  });
  if (decision === "ask") {
    await recordOpenLeashSystemLog({
      organizationId,
      conversationEventId,
      userId: user.id,
      computerId,
      runtimeId,
      level: "security",
      code: "action-held-for-approval",
      message: summary,
      data: {
        evaluationId: evaluation.rows[0].id,
        eventName: request.event.eventName,
        toolName: request.event.tool?.name,
        policyNames: results
          .filter((result) => result.status === "failed" || result.status === "needs_question")
          .map((result) => result.policyName)
      }
    });
  }
  const organization = await organizationSummary(organizationId);
  const pluginLogs = await readPluginLogsForConversation(conversationEventId);
  const logExportRuns = await exportPluginLogs({
    logs: pluginLogs,
    organization,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name
    },
    request,
    conversationEventId,
    plugins: runtimePlugins
  });
  const exportRuns = await runExportPlugins({
    request,
    event: eventForRequest(request),
    decision,
    summary,
    evaluationId: evaluation.rows[0].id,
    conversationEventId,
    organization,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name
    },
    computerId,
    runtimeId,
    policyResults: results,
    pluginRuns: pipeline.runs,
    pluginLogs,
    plugins: runtimePlugins
  });
  await recordPluginRuns(conversationEventId, [...pipeline.runs, ...logExportRuns, ...exportRuns]);
  let purposeSummary: string | undefined;
  if (decision === "ask") {
    purposeSummary = await summarizeActionPurpose(request, tenantModelKey);
    await pool.query(
      `update conversation_events
       set payload = payload || $2::jsonb
       where id = $1`,
      [conversationEventId, JSON.stringify({ openleashPurposeSummary: purposeSummary })]
    );
    notifyMobileApprovers(user.id, evaluation.rows[0].id, summary, question, purposeSummary).catch((error) => {
      console.warn("mobile approval notification failed", error);
    });
  }
  return { decision, decisionId: evaluation.rows[0].id, summary, question, results };
}

function resolvePolicyResultPolicyId(result: PolicyDecision, policies: Policy[]) {
  const byId = policies.find((policy) => policy.id === result.policyId);
  if (byId) return byId.id;
  const byName = policies.find((policy) => policy.name === result.policyName);
  return byName?.id ?? null;
}

async function tenantModelKeyForEvaluation(organizationId: string) {
  try {
    return await readTenantModelKey(organizationId);
  } catch (error) {
    console.warn("tenant model key unavailable; falling back to managed or heuristic evaluation", error);
    return undefined;
  }
}

async function organizationSummary(organizationId: string) {
  const result = await pool.query<{ id: string; name: string; slug: string | null }>(
    "select id, name, slug from organizations where id = $1 limit 1",
    [organizationId]
  );
  return result.rows[0] ?? { id: organizationId };
}

function eventForRequest(request: EvaluationRequest) {
  return eventForHookEvent(request.event.eventName);
}

async function recordConversationEvent(request: EvaluationRequest, user: ApiUser, intentKey?: string) {
  const client = await pool.connect();
  let conversationEventId = "";
  let computerId = "";
  let runtimeId = "";
  const organizationId = user.organization_id ?? (await ensureDefaultOrganization()).id;
  try {
    await client.query("begin");
    const computer = await client.query(
      `insert into computers (user_id, hostname, platform, os_release, last_seen_at)
       values ($1, $2, $3, $4, now())
       on conflict (user_id, hostname) do update set platform = excluded.platform, os_release = excluded.os_release, last_seen_at = now()
       returning id`,
      [user.id, request.computer.hostname, request.computer.platform, request.computer.osRelease ?? null]
    );
    computerId = computer.rows[0].id;
    const runtime = await client.query(
      `insert into agent_runtimes (computer_id, kind, display_name, version, executable_path, last_seen_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (computer_id, kind, executable_path_key) do update set display_name = excluded.display_name, version = excluded.version, last_seen_at = now()
       returning id`,
      [
        computerId,
        request.agent.kind,
        request.agent.displayName,
        request.agent.version ?? null,
        request.agent.executablePath ?? ""
      ]
    );
    runtimeId = runtime.rows[0].id;
    const event = await client.query(
      `insert into conversation_events
       (user_id, computer_id, agent_runtime_id, session_id, event_name, project_path, prompt, tool_name, payload, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        user.id,
        computerId,
        runtimeId,
        request.event.sessionId,
        request.event.eventName,
        request.event.projectPath ?? null,
        request.event.prompt ?? null,
        request.event.tool?.name ?? null,
          { ...request.event, raw: { ...(request.event.raw && typeof request.event.raw === "object" ? request.event.raw : {}), openleashIntentKey: intentKey } },
        request.event.occurredAt
      ]
    );
    conversationEventId = event.rows[0].id;
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { conversationEventId, computerId, runtimeId, organizationId };
}

async function recordMcpToolCall({
  call,
  organizationId,
  conversationEventId,
  evaluationId,
  userId,
  computerId,
  runtimeId,
  request,
  decision
}: {
  call?: McpToolCall;
  organizationId?: string | null;
  conversationEventId: string;
  evaluationId: string;
  userId: string;
  computerId: string;
  runtimeId: string;
  request: EvaluationRequest;
  decision: "allow" | "ask";
}) {
  if (!call) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const server = await client.query(
      `insert into mcp_servers (organization_id, server_name, first_seen_at, last_seen_at, tool_count, call_count)
       values ($1, $2, $3, $3, 1, 1)
       on conflict (organization_id, server_name) do update
         set last_seen_at = greatest(mcp_servers.last_seen_at, excluded.last_seen_at),
             call_count = mcp_servers.call_count + 1,
             tool_count = greatest(
               mcp_servers.tool_count,
               (select count(distinct tool_name)::int + 1 from mcp_tool_calls where mcp_server_id = mcp_servers.id and tool_name <> $4)
             )
       returning id`,
      [organizationId ?? null, call.serverName, request.event.occurredAt, call.toolName]
    );
    await client.query(
      `insert into mcp_tool_calls
       (organization_id, mcp_server_id, conversation_event_id, evaluation_id, user_id, computer_id, agent_runtime_id,
        server_name, tool_name, full_tool_name, arguments, argument_summary, project_path, session_id, decision, risk_level, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17)`,
      [
        organizationId ?? null,
        server.rows[0].id,
        conversationEventId,
        evaluationId,
        userId,
        computerId,
        runtimeId,
        call.serverName,
        call.toolName,
        call.fullToolName,
        JSON.stringify(call.arguments ?? {}),
        call.argumentSummary || null,
        request.event.projectPath ?? null,
        request.event.sessionId,
        decision,
        decision === "ask" ? "policy_review" : "observed",
        request.event.occurredAt
      ]
    );
    await client.query(
      `update mcp_servers s
       set tool_count = stats.tool_count,
           call_count = stats.call_count,
           last_seen_at = stats.last_seen_at
       from (
         select mcp_server_id, count(distinct tool_name)::int as tool_count, count(*)::int as call_count, max(occurred_at) as last_seen_at
         from mcp_tool_calls
         where mcp_server_id = $1
         group by mcp_server_id
       ) stats
       where s.id = stats.mcp_server_id`,
      [server.rows[0].id]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    console.warn("failed to record MCP tool call", error);
  } finally {
    client.release();
  }
}

async function waitForHookDecision(user: ApiUser, decision: EvaluationResponse): Promise<EvaluationResponse> {
  if (decision.decision !== "ask") return decision;
  const timeoutMs = Number(process.env.OPENLEASH_HOOK_APPROVAL_TIMEOUT_MS ?? 120000);
  const pollMs = Number(process.env.OPENLEASH_HOOK_APPROVAL_POLL_MS ?? 750);
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    const result = await pool.query<{
      resolution: "allow" | "deny" | null;
      resolution_guidance: string | null;
      summary: string | null;
    }>(
      `select resolution, resolution_guidance, summary
       from evaluations
       where id = $1 and user_id = $2`,
      [decision.decisionId, user.id]
    );
    const row = result.rows[0];
    if (row?.resolution === "allow" || row?.resolution === "deny") {
      return {
        ...decision,
        decision: row.resolution,
        summary: row.resolution === "allow" ? "OpenLeash approved this action." : row.summary ?? decision.summary,
        resolutionGuidance: row.resolution === "deny" ? row.resolution_guidance ?? undefined : undefined,
        question: undefined
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, pollMs)));
  }
  return {
    ...decision,
    decision: "deny",
    summary: "OpenLeash timed out waiting for approval.",
    question: undefined
  };
}

async function ensureExternalUser(provider: string): Promise<ApiUser> {
  const displayName = provider === "external-agents" ? "SaaS agents" : externalProviderLabel(provider);
  const email = `${slug(displayName)}@external.openleash.com`;
  const result = await pool.query<{ id: string; email: string; display_name: string }>(
    `insert into users (email, display_name, role)
     values ($1, $2, 'external-agent')
     on conflict (email) do update set display_name = excluded.display_name
     returning id, email, display_name`,
    [email, displayName]
  );
  return result.rows[0];
}

async function externalEventExists(key: string) {
  const result = await pool.query(
    `select 1
     from conversation_events
     where payload->'raw'->>'externalEvaluationKey' = $1
     limit 1`,
    [key]
  );
  return (result.rowCount ?? 0) > 0;
}

async function findRecentHandledIntent(userId: string, request: EvaluationRequest, intentKey: string) {
  const sessionScoped = !isSessionlessIntentKey(intentKey);
  const canonicalKey = canonicalIntentKey(intentKey);
  const result = await pool.query<{
    id: string;
    decision: "allow" | "ask" | "deny";
    resolution: "allow" | "deny" | null;
    summary: string;
    question: string | null;
    intent_key: string | null;
  }>(
    `select e.id, e.decision, e.resolution, e.summary, e.question, ce.payload->'raw'->>'openleashIntentKey' as intent_key
     from evaluations e
     join conversation_events ce on ce.id = e.conversation_event_id
     join agent_runtimes ar on ar.id = ce.agent_runtime_id
     where e.user_id = $1
       and ar.kind = $2
       and ce.event_name <> 'UserPromptSubmit'
       and ($6::boolean = false or ce.session_id = $3)
       and coalesce(ce.project_path, '') = $4
       and ($6::boolean = false or ce.payload->'raw'->>'openleashIntentKey' = $5)
       and e.created_at > now() - interval '5 minutes'
     order by e.created_at desc
     limit 25`,
    [userId, request.agent.kind, request.event.sessionId, request.event.projectPath ?? "", intentKey, sessionScoped]
  );
  if (sessionScoped) return result.rows[0];
  return result.rows.find((row) => canonicalIntentKey(row.intent_key) === canonicalKey);
}

function triggerIntentKey(request: EvaluationRequest) {
  const category = intentCategory(request);
  if (!category) return undefined;
  if (category.startsWith("credential-")) {
    return [
      request.agent.kind,
      request.event.projectPath ?? "",
      category,
      primaryResource(request)
    ].join("|");
  }
  return [
    request.agent.kind,
    request.event.sessionId,
    request.event.projectPath ?? "",
    category,
    primaryResource(request)
  ].join("|");
}

function isSessionlessIntentKey(intentKey: string) {
  return intentKey.includes("|credential-");
}

function canonicalIntentKey(intentKey?: string | null) {
  if (!intentKey) return undefined;
  const parts = intentKey.split("|");
  if (parts.length === 4 && parts[2]?.startsWith("credential-")) {
    return [parts[0], parts[1], "credential", parts[3]].join("|");
  }
  if (parts.length === 5 && parts[3]?.startsWith("credential-")) {
    return [parts[0], parts[2], "credential", parts[4]].join("|");
  }
  return intentKey;
}

function intentCategory(request: EvaluationRequest) {
  const text = eventTextForIntent(request).toLowerCase();
  if (/(git init|gh repo create|create (a )?(new )?git repo|initialize (a )?(new )?repository)/i.test(text)) return "git-repo";
  if (/(\.env(?:\b|["'\\/\s])|\.npmrc|id_rsa|id_ed25519|credentials|kubeconfig|private key|api[_ -]?key|secret|token|password)/i.test(text)) {
    return `credential-${credentialActionVerb((request.event.tool?.name ?? "").toLowerCase(), text)}`;
  }
  if (/(rm\s+-rf|sudo rm|delete all|format disk|chmod\s+-r|chown\s+-r|git reset\s+--hard|terraform destroy)/i.test(text)) return "destructive";
  if (/(curl|wget|upload|pastebin|gist|send .*code|post .*secret|external domain|webhook)/i.test(text)) return "exfiltration";
  if (/(ssn|social security|passport|credit card|personal data|customer list|employee data|customer emails?|email export)/i.test(text)) return "personal-data";
  if (/(npm install|pip install|brew install|curl .* sh|unknown package)/i.test(text)) return "package-install";
  return undefined;
}

function eventTextForIntent(request: EvaluationRequest) {
  return [
    request.event.prompt,
    request.event.tool?.name,
    JSON.stringify(request.event.tool?.input ?? ""),
    JSON.stringify(request.event.raw ?? "")
  ].filter(Boolean).join("\n");
}

function credentialActionVerb(toolName: string, text: string) {
  if (/(curl|wget|upload|post|webhook|pastebin|gist|send|exfiltrat|external|remote)/i.test(text)) return "send";
  if (/read|cat|open|print|show|display|dump|list|grep|scan|parse|copy/i.test(`${toolName} ${text}`)) return "read";
  if (/write|create|add|generate|save|put|touch|edit|multiedit/i.test(`${toolName} ${text}`)) return "write";
  return "other";
}

function stableHookSessionId(agent: string, raw: any) {
  const projectPath = raw?.cwd ?? raw?.workspace ?? raw?.project_dir ?? raw?.context?.workspaceDir ?? process.cwd();
  const seed = [
    agent,
    projectPath,
    raw?.pid ?? "",
    raw?.process_id ?? "",
    raw?.terminal_id ?? "",
    raw?.conversation_id ?? ""
  ].join("|");
  return `${agent}-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function primaryResource(request: EvaluationRequest) {
  const input = request.event.tool?.input;
  const values: string[] = [];
  if (typeof input === "string") values.push(input);
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "command", "url"]) {
      if (typeof record[key] === "string") values.push(record[key]);
    }
  }
  const text = values.join(" ") || eventTextForIntent(request);
  if (/\.env(?:\b|["'\\/\s])/.test(text)) return ".env";
  const match = text.match(/(?:^|[/"'\s])([A-Za-z0-9._-]*(?:credentials|kubeconfig|id_rsa|id_ed25519|\.npmrc)[A-Za-z0-9._-]*)/i);
  return match?.[1] ? truncate(match[1], 80) : "unknown-resource";
}

app.put("/admin/policies/:id", async (req, res, next) => {
  try {
    const naturalLanguageRule = String(req.body.naturalLanguageRule ?? "");
    const name = summarizePolicyTitle(naturalLanguageRule);
    const category = policyCategory(String(req.body.category ?? ""), name, naturalLanguageRule);
    const result = await pool.query(
      `update policies set name = $2, category = $3, description = $4, severity = $5, natural_language_rule = $6, enabled = $7, locked = $8, updated_at = now()
       where id = $1 returning *`,
      [req.params.id, name, category, req.body.description ?? "", req.body.severity ?? "medium", naturalLanguageRule, req.body.enabled, Boolean(req.body.locked)]
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : "unknown error" });
});

function summarizeAgentActivity(agent: {
  display_name: string;
  event_name?: string;
  tool_name?: string;
  prompt?: string;
  project_path?: string;
  decision?: string;
  resolution?: string;
  question?: string;
  decision_summary?: string;
  payload?: unknown;
}) {
  if (agent.question && !agent.resolution) return `Waiting for approval: ${agent.question}`;
  const purpose = actionPurposeFromPayload(agent.payload);
  if (purpose) return truncate(purpose, 140);

  const target = extractTarget(agent.payload);
  if (agent.tool_name) {
    return target
      ? `Using ${agent.tool_name} on ${truncate(target, 70)}`
      : `Using ${agent.tool_name}`;
  }
  if (agent.event_name === "UserPromptSubmit" && agent.prompt) {
    return `Prompt: ${truncate(agent.prompt, 100)}`;
  }
  if (agent.decision_summary && !isBoringEvaluationSummary(agent.decision_summary)) {
    return truncate(agent.decision_summary, 140);
  }
  return agent.prompt ? `Prompt: ${truncate(agent.prompt, 100)}` : "Active";
}

function extractTarget(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const event = payload as { tool?: { input?: unknown }; prompt?: string };
  const input = event.tool?.input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const candidate = record.file_path ?? record.path ?? record.command ?? record.url;
  return typeof candidate === "string" ? candidate : undefined;
}

function actionPurposeFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const summary = (payload as { openleashPurposeSummary?: unknown }).openleashPurposeSummary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

function isBoringEvaluationSummary(summary?: string | null) {
  if (!summary) return false;
  return /all active policies passed/i.test(summary);
}

function shouldDeferPromptOnlyApproval(request: EvaluationRequest, results: PolicyDecision[]) {
  if (!isPromptOnlyHook(request)) return false;
  return results.some((result) => result.status === "failed" || result.status === "needs_question");
}

function isPromptOnlyHook(request: EvaluationRequest) {
  return request.event.eventName === "UserPromptSubmit" && !request.event.tool?.name;
}

function deferPromptOnlyPolicyResults(results: PolicyDecision[]): PolicyDecision[] {
  return results.map((result) => result.status === "passed"
    ? result
    : {
        ...result,
        status: "passed",
        explanation: "Prompt-only intent observed. Enforcement is deferred until the agent attempts the actual tool action.",
        evidence: [],
        question: undefined
      });
}

async function withTranscriptContext(payload: unknown, occurredAt?: string | Date) {
  if (!payload || typeof payload !== "object") return payload;
  const event = payload as { transcript?: unknown; raw?: { transcript_path?: unknown; transcriptPath?: unknown } };
  if (Array.isArray(event.transcript) && event.transcript.length > 0) return payload;
  const transcript = await readClaudeTranscript(event.raw?.transcript_path ?? event.raw?.transcriptPath, occurredAt);
  return transcript ? { ...event, transcript } : payload;
}

async function readClaudeTranscript(filePath: unknown, occurredAt?: string | Date): Promise<ConversationTurn[] | undefined> {
  if (typeof filePath !== "string" || !filePath.trim()) return undefined;
  const resolved = path.resolve(filePath);
  const claudeProjects = path.join(os.homedir(), ".claude", "projects");
  if (!resolved.startsWith(claudeProjects)) return undefined;
  try {
    const cutoff = occurredAt ? new Date(occurredAt).getTime() + 5000 : undefined;
    const content = await fs.readFile(resolved, "utf8");
    const turns = content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => claudeTranscriptTurn(line))
      .filter((turn) => {
        if (!cutoff || !turn.at) return true;
        const at = new Date(turn.at).getTime();
        return Number.isNaN(at) || at <= cutoff;
      });
    return turns.length > 0 ? turns.slice(-20) : undefined;
  } catch {
    return undefined;
  }
}

function claudeTranscriptTurn(line: string): ConversationTurn[] {
  try {
    const record = JSON.parse(line) as {
      type?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const role = typeof record.message?.role === "string" ? record.message.role : record.type;
    if (role !== "user" && role !== "assistant") return [];
    const content = transcriptContentToText(record.message?.content);
    if (!content || shouldSkipTranscriptText(content)) return [];
    return [{
      role,
      content,
      at: typeof record.timestamp === "string" ? record.timestamp : undefined
    }];
  } catch {
    return [];
  }
}

function transcriptContentToText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as { type?: unknown; text?: unknown; content?: unknown };
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "tool_result" && typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function shouldSkipTranscriptText(value: string) {
  const normalized = value.trim();
  return (
    !normalized ||
    normalized.startsWith("Operation stopped by hook:") ||
    normalized.startsWith("<system-reminder>") ||
    normalized.startsWith("Caveat:") ||
    normalized.includes("<local-command-stdout>")
  );
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function projectTag(value?: string) {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function publicApiUrl(req: express.Request) {
  return process.env.OPENLEASH_PUBLIC_API_URL ?? `${req.protocol}://${req.get("host")}`;
}

function desktopRedirectUriFallback() {
  return "openleash://auth/callback";
}

function webGoogleRedirectUri(req: express.Request) {
  return process.env.OPENLEASH_GOOGLE_WEB_REDIRECT_URI ?? `${publicApiUrl(req)}/v1/auth/google/callback`;
}

function webMicrosoftRedirectUri(req: express.Request) {
  return process.env.OPENLEASH_MICROSOFT_WEB_REDIRECT_URI ?? `${publicApiUrl(req)}/v1/auth/microsoft/callback`;
}

async function ensureDefaultOrganization() {
  const existing = await pool.query(
    `select * from organizations
     order by setup_completed desc, updated_at desc, created_at desc
     limit 1`
  );
  if (existing.rows[0]) {
    const organization = existing.rows[0];
    await pool.query(`update users set organization_id = $1 where organization_id is null`, [organization.id]);
    return organization as {
      id: string;
      name: string;
      slug: string;
      region?: string | null;
      logo_url?: string | null;
      setup_completed: boolean;
      current_step: number;
      onboarding_code?: string | null;
      deployment_mode?: string | null;
      infrastructure_config?: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    };
  }
  const result = await pool.query(
    `insert into organizations (name, slug, region, onboarding_code)
     values ($1, $2, $3, $4)
     on conflict (slug) do update set updated_at = now()
     returning *`,
    [
      process.env.OPENLEASH_ORG_NAME ?? "",
      process.env.OPENLEASH_ORG_SLUG ?? "openleash",
      process.env.OPENLEASH_ORG_REGION ?? null,
      process.env.OPENLEASH_ONBOARDING_CODE ?? null
    ]
  );
  const organization = result.rows[0];
  await pool.query(`update users set organization_id = $1 where organization_id is null`, [organization.id]);
  return organization as {
    id: string;
    name: string;
    slug: string;
    region?: string | null;
    logo_url?: string | null;
    setup_completed: boolean;
    current_step: number;
    onboarding_code?: string | null;
    deployment_mode?: string | null;
    infrastructure_config?: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  };
}

async function resolveOnboardingOrganization(req: express.Request) {
  const slug = String(req.query.organizationSlug ?? req.body?.organizationSlug ?? req.query.slug ?? "").trim();
  if (slug) {
    const organization = await getOrganizationBySlug(slug);
    if (!organization) {
      const error = new Error(`Organization ${slug} was not found`);
      (error as Error & { status?: number }).status = 404;
      throw error;
    }
    await pool.query(`update users set organization_id = $1 where organization_id is null`, [organization.id]);
    return organization as Awaited<ReturnType<typeof ensureDefaultOrganization>>;
  }
  return ensureDefaultOrganization();
}

async function ensureManagedMobileOrganization() {
  const slug = slugifyTenant(
    process.env.OPENLEASH_MANAGED_MOBILE_ORG_SLUG ??
    process.env.OPENLEASH_DEV_ORG_SLUG ??
    "openleash-dev"
  );
  const deploymentMode = normalizeDeploymentMode(process.env.OPENLEASH_DEPLOYMENT_MODE);
  const result = await pool.query(
    `insert into organizations (name, slug, region, setup_completed, current_step, deployment_mode)
     values ($1, $2, $3, true, 6, $4)
     on conflict (slug) do update set updated_at = now()
     returning id, name, slug, region, setup_completed, current_step, deployment_mode`,
    [
      process.env.OPENLEASH_MANAGED_MOBILE_ORG_NAME ?? "OpenLeash Managed Dev",
      slug,
      process.env.OPENLEASH_ORG_REGION ?? null,
      deploymentMode
    ]
  );
  return result.rows[0] as {
    id: string;
    name: string;
    slug: string;
    region?: string | null;
    setup_completed: boolean;
    current_step: number;
    deployment_mode?: string | null;
  };
}

type ManagedAuthProfile = {
  subject: string;
  email: string;
  name: string;
  givenName: string | null;
  familyName: string | null;
  raw: Record<string, unknown>;
};

type ManagedOrganization = {
  id: string;
  name: string;
  slug: string;
  region?: string | null;
  setup_completed: boolean;
  current_step?: number;
  deployment_mode?: string | null;
  defaultUserRole?: string;
};

async function resolveManagedMobileOrganization(profile: ManagedAuthProfile, audience: "individual" | "organization" = "individual"): Promise<ManagedOrganization> {
  const email = profile.email.toLowerCase();
  const domain = email.split("@")[1]?.trim() ?? "";
  const domainSlug = domain ? slugifyTenant(domain.split(".")[0] ?? domain) : "";
  const configuredSlug = audience === "organization"
    ? domainSlug
    : process.env.OPENLEASH_MANAGED_MOBILE_ORG_SLUG ?? process.env.OPENLEASH_DEV_ORG_SLUG;
  const existing = configuredSlug
    ? await getOrganizationBySlug(configuredSlug)
    : domain
      ? await getOrganizationBySlug(domainSlug)
      : undefined;
  if (existing) {
    const configuredName = process.env.OPENLEASH_MANAGED_MOBILE_ORG_NAME?.trim();
    if (configuredName && !String(existing.name ?? "").trim()) {
      const updated = await pool.query(
        `update organizations set name = $2, deployment_mode = $3, updated_at = now() where id = $1 returning *`,
        [existing.id, configuredName, normalizeDeploymentMode(process.env.OPENLEASH_DEPLOYMENT_MODE)]
      );
      return { ...updated.rows[0], defaultUserRole: audience === "organization" ? "admin" : "engineer" };
    }
    return { ...existing, defaultUserRole: audience === "organization" ? "admin" : "engineer" };
  }

  if (audience === "organization" && domainSlug) {
    const result = await pool.query(
      `insert into organizations (name, slug, region, setup_completed, current_step, deployment_mode)
       values ($1, $2, $3, false, 1, 'cloud')
       on conflict (slug) do update set updated_at = now()
       returning id, name, slug, region, setup_completed, current_step, deployment_mode`,
      [organizationNameFromDomain(domain), domainSlug, process.env.OPENLEASH_ORG_REGION ?? null]
    );
    return { ...result.rows[0], defaultUserRole: "admin" };
  }

  return { ...(await ensureManagedMobileOrganization()), defaultUserRole: audience === "organization" ? "admin" : "engineer" };
}

async function resolveExistingMobileOrganizationForProfile(profile: ManagedAuthProfile): Promise<ManagedOrganization> {
  const result = await pool.query(
    `select o.id, o.name, o.slug, o.region, o.setup_completed, o.current_step, o.deployment_mode, u.role as default_user_role
     from users u
     join organizations o on o.id = u.organization_id
     where lower(u.email) = lower($1)
       and u.status = 'active'
     order by case when u.role in ('owner', 'admin') then 0 else 1 end, u.last_login_at desc nulls last
     limit 1`,
    [profile.email]
  );
  if (result.rows[0]) {
    return {
      ...result.rows[0],
      defaultUserRole: result.rows[0].default_user_role ?? "engineer"
    };
  }
  const error = new Error("No OpenLeash account exists for this email. Create your account from desktop or the web, then sign in on mobile.");
  (error as Error & { status?: number }).status = 403;
  throw error;
}

function organizationNameFromDomain(domain: string) {
  const first = domain.split(".")[0] || "Company";
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Company";
}

function isPersonalEmailDomain(email: string) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return new Set([
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "yahoo.com",
    "proton.me",
    "protonmail.com",
    "aol.com"
  ]).has(domain);
}

async function canUseCloudOwnerLogin(organizationId: string, email: string) {
  const result = await pool.query(
    `select 1
     from users
     where organization_id = $1
       and lower(email) = lower($2)
       and role in ('owner', 'admin')
       and status = 'active'
     limit 1`,
    [organizationId, email]
  );
  return Boolean(result.rows[0]);
}

function generateOnboardingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = Array.from({ length: 12 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

function slugifyTenant(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "openleash";
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function optionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeDeploymentMode(value: unknown) {
  const normalized = String(value ?? "cloud").toLowerCase();
  return normalized.includes("private") || normalized.includes("onprem") || normalized.includes("on-prem") ? "private" : "cloud";
}

function normalizeCloudPackage(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (["personal-byok", "personal-managed", "work-byok", "work-managed"].includes(normalized)) {
    return normalized as "personal-byok" | "personal-managed" | "work-byok" | "work-managed";
  }
  return null;
}

async function getOrganizationBySlug(slug: string) {
  const normalized = slugifyTenant(slug);
  const result = await pool.query(`select * from organizations where slug = $1 limit 1`, [normalized]);
  return result.rows[0] as
    | {
        id: string;
        name: string;
        slug: string;
        setup_completed: boolean;
        deployment_mode?: string | null;
      }
    | undefined;
}

async function getOrganizationById(id: string) {
  const result = await pool.query(`select * from organizations where id = $1 limit 1`, [id]);
  return result.rows[0] as
    | {
        id: string;
        name: string;
        slug: string;
        region?: string | null;
        setup_completed: boolean;
        deployment_mode?: string | null;
      }
    | undefined;
}

function ssoProviderType(provider: string) {
  const normalized = provider.toLowerCase();
  if (normalized === "azuread") return "azure_ad";
  if (normalized === "okta") return "okta";
  if (normalized === "google") return "google_workspace";
  if (normalized === "ping") return "ping";
  if (normalized === "activedirectory") return "active_directory";
  return normalized;
}

function clientModeFromEnvironment() {
  const mode = String(process.env.OPENLEASH_CLIENT_MODE ?? process.env.OPENLEASH_DEPLOYMENT_MODE ?? "cloud").toLowerCase();
  if (mode.includes("enterprise") || mode.includes("private") || mode.includes("onprem") || mode.includes("on-prem")) return "enterprise";
  if (mode.includes("community") || mode.includes("personal")) return "community";
  return "cloud";
}

function mobileGoogleConfig() {
  return {
    ClientId: process.env.OPENLEASH_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? "",
    ClientSecret: process.env.OPENLEASH_GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? ""
  };
}

function cloudMicrosoftConfig() {
  return {
    TenantId: process.env.OPENLEASH_MICROSOFT_TENANT_ID ?? process.env.MICROSOFT_ENTRA_TENANT_ID ?? process.env.AZURE_TENANT_ID ?? "organizations",
    ClientId: process.env.OPENLEASH_MICROSOFT_CLIENT_ID ?? process.env.MICROSOFT_CLIENT_ID ?? process.env.AZURE_CLIENT_ID ?? "",
    ClientSecret: process.env.OPENLEASH_MICROSOFT_CLIENT_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET ?? process.env.AZURE_CLIENT_SECRET ?? ""
  };
}

function buildMobileGoogleAuthorizationUrl(redirectUri: string, state: string) {
  return buildAuthorizationUrl("google_workspace", mobileGoogleConfig(), redirectUri, state);
}

function encodeMobileAuthState(state: { nonce: string; finalRedirectUri: string; exchangeRedirectUri?: string }) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeMobileAuthState(state: string) {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { finalRedirectUri?: unknown; nonce?: unknown; exchangeRedirectUri?: unknown };
    if (typeof parsed.finalRedirectUri !== "string" || typeof parsed.nonce !== "string") return undefined;
    return {
      nonce: parsed.nonce,
      finalRedirectUri: parsed.finalRedirectUri,
      exchangeRedirectUri: typeof parsed.exchangeRedirectUri === "string" ? parsed.exchangeRedirectUri : undefined
    };
  } catch {
    return undefined;
  }
}

function isAllowedAuthRedirectUri(redirectUri: string) {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "openleash:") return true;
    if ((url.protocol === "http:" || url.protocol === "https:") && ["localhost", "127.0.0.1"].includes(url.hostname)) return true;
    const allowedHosts = (process.env.OPENLEASH_ALLOWED_AUTH_REDIRECT_HOSTS ?? "localhost,127.0.0.1")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    if (url.protocol === "https:" && allowedHosts.includes(url.hostname.toLowerCase())) return true;
    return false;
  } catch {
    return false;
  }
}

function mobileCloudProviders() {
  return [
    {
      id: "openleash-cloud-google",
      type: "google",
      label: "Google Workspace"
    },
    {
      id: "openleash-cloud-microsoft",
      type: "azure_ad",
      label: "Microsoft 365"
    }
  ];
}

async function mobileProvidersForOrganization(organizationId: string, organizationSlug: string) {
  const result = await pool.query(
    `select id, provider, enabled, config
     from idp_connections
     where organization_id = $1 and enabled = true
     order by updated_at desc`,
    [organizationId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: ssoProviderType(row.provider),
    label: row.provider === "AzureAD" ? "Microsoft Entra ID" : row.provider === "Google" ? "Google Workspace" : row.provider,
    organizationId,
    organizationSlug
  }));
}

async function configuredSsoProvider(organizationId: string, requestedProviderType?: string) {
  const result = await pool.query(
    `select provider, config from idp_connections where organization_id = $1 and enabled = true`,
    [organizationId]
  );
  const row = result.rows.find((item) => ssoProviderType(item.provider) === requestedProviderType) ?? result.rows[0];
  if (!row) return undefined;
  return {
    providerType: ssoProviderType(row.provider),
    config: (row.config ?? {}) as Record<string, unknown>
  };
}

async function exchangeOrganizationAuthorizationCode(organizationId: string, providerType: string, authorizationCode: string, redirectUri: string) {
  const provider = await configuredSsoProvider(organizationId, providerType);
  if (!provider) throw new Error("Identity provider is not configured for this organization");
  return exchangeAuthorizationCode(provider.providerType, provider.config, authorizationCode, redirectUri);
}

async function createDashboardSessionFromProfile({
  organizationId,
  providerType,
  profile,
  role = "engineer",
  provisionUser = true,
  accountAudience = "individual"
}: {
  organizationId: string;
  providerType: string;
  profile: ManagedAuthProfile;
  role?: string;
  provisionUser?: boolean;
  accountAudience?: "individual" | "organization";
}) {
  const organizationResult = await pool.query(`select id, name, slug, region, setup_completed from organizations where id = $1 limit 1`, [organizationId]);
  const organization = organizationResult.rows[0];
  if (!organization) throw new Error("Organization not found");
  const displayName = profile.name || profile.email.split("@")[0] || "OpenLeash user";
  const userEmail = profile.email.toLowerCase();
  const userResult = provisionUser
    ? await pool.query<{
    id: string;
    email: string;
    display_name: string;
    role: string;
  }>(
    `insert into users (organization_id, email, display_name, role, first_name, last_name, idp_user_id, idp_provider, status, last_login_at, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now(), $9)
     on conflict (email) do update set
       organization_id = excluded.organization_id,
       display_name = excluded.display_name,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       idp_user_id = excluded.idp_user_id,
       idp_provider = excluded.idp_provider,
       status = 'active',
       last_login_at = now(),
       metadata = coalesce(users.metadata, '{}'::jsonb) || excluded.metadata
     returning id, email, display_name, role`,
    [
      organizationId,
      userEmail,
      displayName,
      role,
      profile.givenName,
      profile.familyName,
      profile.subject,
      providerType,
      JSON.stringify({ ssoProfile: profile.raw, mobile: true, accountAudience })
    ]
      )
    : await pool.query<{
        id: string;
        email: string;
        display_name: string;
        role: string;
      }>(
        `select id, email, display_name, role
         from users
         where organization_id = $1
           and lower(email) = lower($2)
           and status = 'active'
         limit 1`,
        [organizationId, userEmail]
      );
  if (!userResult.rows[0] && !provisionUser) {
    const error = new Error("No OpenLeash account exists for this email. Create your account from desktop or the web, then sign in on mobile.");
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
  const sessionToken = `ols_${crypto.randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + Number(process.env.OPENLEASH_DASHBOARD_SESSION_DAYS ?? 14) * 86400000);
  await pool.query(
    `insert into dashboard_sessions (organization_id, user_id, token_hash, provider, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [organizationId, userResult.rows[0].id, hashToken(sessionToken), providerType, expiresAt.toISOString()]
  );
  return {
    success: true,
    token: sessionToken,
    sessionToken,
    tokens: { accessToken: sessionToken, expiresAt: expiresAt.toISOString() },
    user: userResult.rows[0],
    organization,
    account: {
      audience: accountAudience,
      packageId: null
    }
  };
}

async function mobilePendingApprovals(userId: string, organizationId: string, includeOrganization = true) {
  const result = await pool.query(
    `select e.id, e.summary, e.question, e.created_at,
            ce.event_name, ce.tool_name, ce.project_path, ce.prompt, ce.payload, ce.occurred_at,
            ce.payload->'raw'->>'openleashIntentKey' as intent_key,
            ar.display_name as agent_name,
            ar.kind as agent_kind,
            c.hostname,
            u.display_name as user_name,
            coalesce(triggered.items, '[]'::jsonb) as triggered_policies
     from evaluations e
     join conversation_events ce on ce.id = e.conversation_event_id
     join agent_runtimes ar on ar.id = ce.agent_runtime_id
     join computers c on c.id = ce.computer_id
     left join users u on u.id = e.user_id
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'policy_name', pr.policy_name,
           'status', pr.status,
           'severity', pr.severity,
           'explanation', pr.explanation,
           'evidence', pr.evidence
         )
         order by pr.created_at asc
       ) as items
       from policy_results pr
       where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
     ) triggered on true
     where e.decision = 'ask'
       and e.resolution is null
       and (e.user_id = $1 or ($3::boolean and exists (
         select 1 from users u
         where u.id = e.user_id and u.organization_id = $2
       )))
     order by e.created_at asc
     limit 20`,
    [userId, organizationId, includeOrganization]
  );
  const rows = dedupePendingApprovalRows(result.rows);
  return {
    ...result,
    rows: await Promise.all(rows.map((row) => enrichMobileApproval(row)))
  };
}

function dedupePendingApprovalRows<T extends { intent_key?: string | null; agent_kind?: string | null; project_path?: string | null; tool_name?: string | null; event_name?: string | null; summary?: string | null }>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = canonicalIntentKey(row.intent_key) ?? [
      row.agent_kind ?? "",
      row.project_path ?? "",
      row.tool_name ?? row.event_name ?? "",
      row.summary ?? ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enrichMobileApproval(row: {
  project_path?: string | null;
  prompt?: string | null;
  payload?: unknown;
  occurred_at?: string | Date;
  question?: string | null;
  summary?: string | null;
  triggered_policies?: unknown;
}) {
  const payloadWithContext = await withTranscriptContext(row.payload, row.occurred_at);
  const triggeredPolicies = Array.isArray(row.triggered_policies) ? row.triggered_policies : [];
  const primaryPolicy = triggeredPolicies.find((policy) => policy && typeof policy === "object") as Record<string, unknown> | undefined;
  const purposeSummary = await approvalPurposeSummary({ ...row, payload: payloadWithContext });
  return {
    ...row,
    payload: payloadWithContext,
    project_name: projectTag(row.project_path ?? undefined) ?? null,
    primary_policy: typeof primaryPolicy?.policy_name === "string" ? primaryPolicy.policy_name : null,
    purpose_summary: purposeSummary,
    quote: approvalQuote({ ...row, payload: payloadWithContext }, primaryPolicy),
    recent_context: approvalRecentContext(payloadWithContext)
  };
}

async function approvalPurposeSummary(row: { payload?: unknown; project_path?: string | null; prompt?: string | null }) {
  if (!row.payload || typeof row.payload !== "object") return null;
  const event = row.payload as { openleashPurposeSummary?: unknown; eventName?: string; agentKind?: string; agentVersion?: string; sessionId?: string; projectPath?: string; prompt?: string; tool?: { name?: string; input?: unknown; output?: unknown }; transcript?: ConversationTurn[]; raw?: unknown; occurredAt?: string };
  if (typeof event.openleashPurposeSummary === "string" && event.openleashPurposeSummary.trim()) {
    return event.openleashPurposeSummary.trim();
  }
  return summarizeActionPurpose({
    computer: { hostname: "unknown", platform: "unknown" },
    agent: { kind: "unknown", displayName: "Agent" },
    event: {
      eventName: (event.eventName as any) ?? "UserPromptSubmit",
      agentKind: "unknown",
      sessionId: event.sessionId ?? "unknown",
      projectPath: event.projectPath ?? row.project_path ?? undefined,
      prompt: event.prompt ?? row.prompt ?? undefined,
      tool: typeof event.tool?.name === "string" ? { name: event.tool.name, input: event.tool.input, output: event.tool.output } : undefined,
      transcript: Array.isArray(event.transcript) ? event.transcript : undefined,
      raw: event.raw,
      occurredAt: event.occurredAt ?? new Date().toISOString()
    }
  });
}

function approvalQuote(
  row: { prompt?: string | null; payload?: unknown; question?: string | null; summary?: string | null },
  primaryPolicy?: Record<string, unknown>
) {
  const evidence = primaryPolicy?.evidence;
  const evidenceItems =
    Array.isArray(evidence)
      ? evidence
      : typeof evidence === "string"
        ? safeJsonArray(evidence)
        : [];
  const evidenceText = evidenceItems.find((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (evidenceText) return truncate(cleanContextText(evidenceText), 220);

  const prompt = typeof row.prompt === "string" ? row.prompt : undefined;
  if (prompt?.trim()) return truncate(cleanContextText(prompt), 220);

  const target = extractTarget(row.payload);
  if (target) return truncate(cleanContextText(target), 220);

  const question = typeof row.question === "string" ? row.question : undefined;
  if (question?.trim()) return truncate(cleanContextText(question), 220);
  return null;
}

function approvalRecentContext(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const transcript = (payload as { transcript?: unknown }).transcript;
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((turn): turn is { role?: unknown; content?: unknown; at?: unknown } => Boolean(turn && typeof turn === "object"))
    .map((turn) => {
      const role = typeof turn.role === "string" && isConversationRole(turn.role) ? turn.role : "user";
      const content = typeof turn.content === "string" ? cleanContextText(turn.content) : "";
      if (!content) return undefined;
      return {
        role,
        content: truncate(content, 220),
        ...(typeof turn.at === "string" ? { at: turn.at } : {})
      };
    })
    .filter((turn): turn is { role: ConversationTurn["role"]; content: string; at?: string } => Boolean(turn))
    .slice(-5);
}

function safeJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [value];
  }
}

function cleanContextText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function mobileAgents(organizationId: string) {
  const result = await pool.query(
    `with latest_runs as (
       select distinct on (ar.id)
              ar.id as id,
              ar.id as agent_runtime_id,
              ar.kind,
              ar.display_name,
              ar.version,
              ar.last_seen_at,
              c.hostname,
              c.platform,
              ce.session_id,
              ce.event_name,
              ce.tool_name,
              ce.project_path,
              ce.prompt,
              ce.payload,
              ce.created_at as activity_at,
              ev.id as decision_id,
              ev.decision,
              ev.resolution,
              ev.resolved_at,
              ev.summary as decision_summary,
              ev.question
       from conversation_events ce
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers c on c.id = ce.computer_id
       left join evaluations ev on ev.conversation_event_id = ce.id
       where ce.event_name <> 'Stop'
         and exists (
           select 1
           from users u
           where u.id = c.user_id and u.organization_id = $1
         )
       order by ar.id, ce.created_at desc
     )
     select latest_runs.*,
            coalesce(triggered.items, '[]'::jsonb) as triggered_policies,
            coalesce(recent.items, '[]'::jsonb) as recent_activity
     from latest_runs
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'policy_name', pr.policy_name,
           'status', pr.status,
           'severity', pr.severity,
           'explanation', pr.explanation,
           'evidence', pr.evidence
         )
         order by pr.created_at asc
       ) as items
       from policy_results pr
       where pr.evaluation_id = latest_runs.decision_id
         and pr.status in ('failed', 'needs_question')
     ) triggered on true
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'id', item.id,
           'event_name', item.event_name,
           'tool_name', item.tool_name,
           'project_path', item.project_path,
           'prompt', item.prompt,
           'payload', item.payload,
           'created_at', item.created_at,
           'decision', item.decision,
           'resolution', item.resolution,
           'summary', item.summary,
           'question', item.question,
           'triggered_policies', item.triggered_policies
         )
         order by item.created_at desc
       ) as items
       from (
         select e.id,
                ce.event_name,
                ce.tool_name,
                ce.project_path,
                ce.prompt,
                ce.payload,
                ce.created_at,
                e.decision,
                e.resolution,
                e.summary,
                e.question,
                coalesce(policy_items.items, '[]'::jsonb) as triggered_policies
         from conversation_events ce
         join evaluations e on e.conversation_event_id = ce.id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
         ) policy_items on true
         where ce.agent_runtime_id = latest_runs.agent_runtime_id
           and ce.event_name <> 'Stop'
           and (
             e.decision in ('ask', 'deny')
             or e.resolution = 'deny'
             or exists (
               select 1 from policy_results pr
               where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
             )
           )
         order by ce.created_at desc
         limit 5
       ) item
     ) recent on true
     order by latest_runs.activity_at desc
     limit 50`,
    [organizationId]
  );
  const sessions = await mobileAgentSessions(organizationId);
  return {
    ...result,
    rows: result.rows.map((agent) => ({
      ...agent,
      sessions: sessions.filter((session) => session.agent_runtime_id === agent.agent_runtime_id).slice(0, 8),
      short_summary: summarizeAgentActivity(agent)
    }))
  };
}

async function mobileAgentSessions(organizationId: string) {
  const result = await pool.query(
    `with session_groups as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds,
              count(*)::int as event_count,
              count(e.id) filter (where e.decision = 'ask')::int as approval_count,
              count(e.id) filter (where e.decision = 'deny' or e.resolution = 'deny')::int as denied_count,
              array_remove(array_agg(distinct c.server_name), null) as mcp_servers
       from conversation_events ce
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers comp on comp.id = ce.computer_id
       left join evaluations e on e.conversation_event_id = ce.id
       left join mcp_tool_calls c on c.evaluation_id = e.id
       where exists (
           select 1 from users u
           where u.id = comp.user_id and u.organization_id = $1
         )
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
       order by max(ce.created_at) desc
       limit 120
     )
     select sg.agent_runtime_id,
            concat(sg.agent_runtime_id, ':', sg.session_id, ':', sg.project_path_key) as id,
            sg.session_id,
            nullif(sg.project_path_key, '') as project_path,
            sg.started_at,
            sg.last_activity_at,
            sg.duration_seconds,
            sg.event_count,
            sg.approval_count,
            sg.denied_count,
            coalesce(to_jsonb(sg.mcp_servers), '[]'::jsonb) as mcp_servers,
            coalesce(title_item.title, 'Agent session') as title,
            concat_ws(' · ',
              sg.event_count::text || case when sg.event_count = 1 then ' event' else ' events' end,
              case when sg.approval_count > 0 then sg.approval_count::text || case when sg.approval_count = 1 then ' approval' else ' approvals' end end,
              case when sg.denied_count > 0 then sg.denied_count::text || ' denied' end,
              case when cardinality(sg.mcp_servers) > 0 then 'MCP: ' || array_to_string(sg.mcp_servers[1:3], ', ') end
            ) as summary,
            coalesce(events.items, '[]'::jsonb) as events
     from session_groups sg
     left join lateral (
       select left(regexp_replace(coalesce(ce.prompt, e.summary, ce.tool_name, ce.event_name, 'Agent session'), '\\s+', ' ', 'g'), 64) as title
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ce.agent_runtime_id = sg.agent_runtime_id
         and ce.session_id = sg.session_id
         and coalesce(ce.project_path, '') = sg.project_path_key
       order by case when ce.prompt is not null and length(ce.prompt) > 0 then 0 else 1 end, ce.created_at asc
       limit 1
     ) title_item on true
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'id', item.id,
           'event_name', item.event_name,
           'tool_name', item.tool_name,
           'project_path', item.project_path,
           'prompt', item.prompt,
           'payload', item.payload,
           'created_at', item.created_at,
           'decision', item.decision,
           'resolution', item.resolution,
           'summary', item.summary,
           'question', item.question,
           'mcp_server', item.mcp_server,
           'mcp_tool', item.mcp_tool,
           'triggered_policies', item.triggered_policies
         )
         order by item.created_at desc
       ) as items
       from (
         select e.id,
                ce.event_name,
                ce.tool_name,
                ce.project_path,
                ce.prompt,
                ce.payload,
                ce.created_at,
                e.decision,
                e.resolution,
                e.summary,
                e.question,
                m.server_name as mcp_server,
                m.tool_name as mcp_tool,
                coalesce(policy_items.items, '[]'::jsonb) as triggered_policies
         from conversation_events ce
         left join evaluations e on e.conversation_event_id = ce.id
         left join mcp_tool_calls m on m.evaluation_id = e.id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
         ) policy_items on true
         where ce.agent_runtime_id = sg.agent_runtime_id
           and ce.session_id = sg.session_id
           and coalesce(ce.project_path, '') = sg.project_path_key
         order by ce.created_at desc
         limit 20
       ) item
     ) events on true
     order by sg.last_activity_at desc`,
    [organizationId]
  );
  return result.rows;
}

function mobileSessionMetrics(organizationId: string) {
  return pool.query(
    `with sessions as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds
       from conversation_events ce
       join computers comp on comp.id = ce.computer_id
       where exists (
           select 1 from users u
           where u.id = comp.user_id and u.organization_id = $1
         )
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
     )
     select
       coalesce(sum(duration_seconds) filter (where last_activity_at >= date_trunc('day', now())), 0)::int as today_seconds,
       count(*) filter (where last_activity_at >= date_trunc('day', now()))::int as today_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '24 hours'), 0)::int as last24h_seconds,
       count(*) filter (where last_activity_at >= now() - interval '24 hours')::int as last24h_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '7 days'), 0)::int as week_seconds,
       count(*) filter (where last_activity_at >= now() - interval '7 days')::int as week_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '30 days'), 0)::int as month_seconds,
       count(*) filter (where last_activity_at >= now() - interval '30 days')::int as month_sessions
     from sessions`,
    [organizationId]
  );
}

function mobileRecentActivity(organizationId: string) {
  return pool.query(
    `select e.id, e.decision, e.resolution, e.summary, e.question, e.created_at,
            ce.event_name, ce.tool_name, ce.project_path, ce.prompt, ce.payload,
            ar.display_name as agent_name, ar.kind as agent_kind,
            c.hostname,
            coalesce(triggered.items, '[]'::jsonb) as triggered_policies
     from evaluations e
     join conversation_events ce on ce.id = e.conversation_event_id
     join agent_runtimes ar on ar.id = ce.agent_runtime_id
     join computers c on c.id = ce.computer_id
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'policy_name', pr.policy_name,
           'status', pr.status,
           'severity', pr.severity,
           'explanation', pr.explanation,
           'evidence', pr.evidence
         )
         order by pr.created_at asc
       ) as items
       from policy_results pr
       where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
     ) triggered on true
     where exists (
       select 1
       from users u
       where u.id = e.user_id and u.organization_id = $1
     )
       and ce.event_name <> 'Stop'
       and not coalesce(e.summary, '') ~* 'all active policies passed'
       and (
         e.decision in ('ask', 'deny')
         or e.resolution = 'deny'
         or exists (
           select 1 from policy_results pr
           where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
         )
       )
     order by e.created_at desc
     limit 30`,
    [organizationId]
  );
}

async function notifyMobileApprovers(userId: string, decisionId: string, summary: string, question?: string, purposeSummary?: string) {
  const devices = await pool.query<{ push_token: string }>(
    `select distinct md.push_token
     from mobile_devices md
     join users u on u.id = md.user_id
     where md.push_token is not null
       and (md.user_id = $1 or u.organization_id = (select organization_id from users where id = $1))
       and md.last_seen_at > now() - interval '45 days'
     limit 50`,
    [userId]
  );
  const expoMessages = devices.rows
    .map((row) => row.push_token)
    .filter((token): token is string => Boolean(token && /^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/.test(token)))
    .map((token) => ({
      to: token,
      title: summary || "OpenLeash approval needed",
      body: [purposeSummary, question].filter(Boolean).join("\n") || "An AI agent is waiting for your decision.",
      sound: "default",
      categoryId: "openleash.approval",
      data: { decisionId, purposeSummary }
    }));
  if (!expoMessages.length) return;
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(expoMessages)
  });
}

function ssoProviderFromIdp(row: { id: string; provider: string; enabled: boolean; config: Record<string, unknown> }, organizationId: string) {
  const providerType = ssoProviderType(row.provider);
  const label = row.provider === "AzureAD" ? "Microsoft Entra ID" : row.provider === "Google" ? "Google Workspace" : row.provider;
  return {
    id: row.id,
    organizationId,
    providerType,
    providerName: label,
    enabled: row.enabled,
    isPrimary: true
  };
}

function buildAuthorizationUrl(providerType: string, config: Record<string, unknown>, redirectUri: string, state: string) {
  const clientId = String(config.ClientId ?? config.clientId ?? "");
  const scope = encodeURIComponent("openid profile email");
  if (providerType === "okta") {
    const domain = String(config.Domain ?? config.domain ?? "").replace(/\/+$/, "");
    if (!domain || !clientId) return "";
    return `${domain}/oauth2/v1/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
  }
  if (providerType === "azure_ad") {
    const tenantId = String(config.TenantId ?? config.tenantId ?? "common");
    if (!clientId) return "";
    return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
  }
  if (providerType === "google_workspace") {
    if (!clientId) return "";
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}&access_type=offline&prompt=select_account`;
  }
  return "";
}

async function exchangeAuthorizationCode(providerType: string, config: Record<string, unknown>, code: string, redirectUri: string) {
  const tokenEndpoint = oauthTokenEndpoint(providerType, config);
  const clientId = String(config.ClientId ?? config.clientId ?? "");
  const clientSecret = String(config.ClientSecret ?? config.clientSecret ?? "");
  if (!tokenEndpoint || !clientId) throw new Error(`SSO token exchange is not configured for ${providerType}`);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  } else {
    const assertion = clientAssertion(providerType, config, tokenEndpoint);
    if (assertion) {
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      body.set("client_assertion", assertion);
    }
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error_description ?? payload.error ?? "SSO token exchange failed"));
  return payload as { access_token?: string; id_token?: string; token_type?: string };
}

async function fetchSsoProfile(providerType: string, config: Record<string, unknown>, tokenSet: { access_token?: string; id_token?: string }) {
  const userinfoEndpoint = oauthUserinfoEndpoint(providerType, config);
  let raw: Record<string, unknown> = {};
  if (userinfoEndpoint && tokenSet.access_token) {
    const response = await fetch(userinfoEndpoint, { headers: { authorization: `Bearer ${tokenSet.access_token}`, accept: "application/json" } });
    if (response.ok) raw = await response.json() as Record<string, unknown>;
  }
  if (!Object.keys(raw).length && tokenSet.id_token) raw = decodeJwtPayload(tokenSet.id_token);
  return {
    subject: String(raw.sub ?? raw.oid ?? raw.id ?? ""),
    email: String(raw.email ?? raw.preferred_username ?? raw.upn ?? "").toLowerCase(),
    name: String(raw.name ?? [raw.given_name, raw.family_name].filter(Boolean).join(" ") ?? ""),
    givenName: nullableString(raw.given_name),
    familyName: nullableString(raw.family_name),
    raw
  };
}

function oauthTokenEndpoint(providerType: string, config: Record<string, unknown>) {
  if (providerType === "okta") {
    const domain = String(config.Domain ?? config.domain ?? "").replace(/\/+$/, "");
    return domain ? `${domain}/oauth2/v1/token` : "";
  }
  if (providerType === "azure_ad") {
    const tenantId = String(config.TenantId ?? config.tenantId ?? "common");
    return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  }
  if (providerType === "google_workspace") return "https://oauth2.googleapis.com/token";
  return "";
}

function oauthUserinfoEndpoint(providerType: string, config: Record<string, unknown>) {
  if (providerType === "okta") {
    const domain = String(config.Domain ?? config.domain ?? "").replace(/\/+$/, "");
    return domain ? `${domain}/oauth2/v1/userinfo` : "";
  }
  if (providerType === "azure_ad") return "https://graph.microsoft.com/oidc/userinfo";
  if (providerType === "google_workspace") return "https://openidconnect.googleapis.com/v1/userinfo";
  return "";
}

function clientAssertion(providerType: string, config: Record<string, unknown>, audience: string) {
  if (providerType !== "okta" && providerType !== "azure_ad") return "";
  const privateKey = String(config.PrivateKey ?? config.privateKey ?? "").trim();
  const clientId = String(config.ClientId ?? config.clientId ?? "").trim();
  if (!privateKey || !clientId) return "";
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: String(config.KeyId ?? config.kid ?? "") || undefined };
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    jti: crypto.randomBytes(16).toString("hex"),
    iat: now,
    exp: now + 300
  };
  const input = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

async function getDashboardSession(authHeader: string) {
  const token = bearerToken(authHeader);
  if (!token) return null;
  const result = await pool.query<{
    user_id: string;
    email: string;
    display_name: string;
    role: string;
    user_metadata: Record<string, unknown> | null;
    organization_id: string;
    organization_name: string;
    organization_slug: string;
    region: string | null;
    infrastructure_config: Record<string, unknown> | null;
  }>(
    `update dashboard_sessions ds
     set last_seen_at = now()
     from users u
     join organizations o on o.id = u.organization_id
     where ds.user_id = u.id
       and ds.token_hash = $1
       and ds.revoked_at is null
       and ds.expires_at > now()
     returning u.id as user_id, u.email, u.display_name, u.role, u.metadata as user_metadata,
               o.id as organization_id, o.name as organization_name, o.slug as organization_slug, o.region,
               o.infrastructure_config`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row) return null;
  const userMetadata = row.user_metadata ?? {};
  const organizationConfig = row.infrastructure_config ?? {};
  const accountAudience = userMetadata.accountAudience === "individual" ? "individual" : "organization";
  const packageId = normalizeCloudPackage(userMetadata.cloudPackage ?? organizationConfig.cloudPackage);
  return {
    user: { id: row.user_id, email: row.email, display_name: row.display_name, role: row.role },
    organization: { id: row.organization_id, name: row.organization_name, slug: row.organization_slug, region: row.region },
    account: {
      audience: accountAudience,
      packageId
    }
  };
}

async function getClientOrDashboardSession(authHeader: string) {
  const dashboardSession = await getDashboardSession(authHeader);
  if (dashboardSession) return { ...dashboardSession, source: "dashboard" as const };

  const token = bearerToken(authHeader);
  const user = token ? await getUserByToken(token) : undefined;
  if (!user?.organization_id) return null;

  const organization = await pool.query<{
    id: string;
    name: string;
    slug: string | null;
    region: string | null;
  }>(
    `select id, name, slug, region
     from organizations
     where id = $1
     limit 1`,
    [user.organization_id]
  );
  const row = organization.rows[0];
  if (!row) return null;
  return {
    source: "client" as const,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: "client"
    },
    organization: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      region: row.region
    }
  };
}

function bearerToken(authHeader: string) {
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

function isDashboardAccessRole(role: unknown) {
  return ["owner", "admin", "ciso", "security_admin"].includes(String(role ?? "").toLowerCase());
}

function isAllowedCorsOrigin(origin: string | undefined) {
  if (!origin) return true;
  const allowed = configuredCorsOrigins();
  if (allowed.has("*")) return true;
  try {
    const url = new URL(origin);
    if (isLocalHostname(url.hostname)) return true;
  } catch {
    return false;
  }
  return allowed.has(origin);
}

function configuredCorsOrigins() {
  return new Set(
    (process.env.OPENLEASH_ALLOWED_ORIGINS ?? process.env.OPENLEASH_DASHBOARD_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function requiresDashboardWriteSession(req: express.Request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return false;
  if (req.path === "/admin/external-agents/sync") return true;
  if (req.path.startsWith("/admin/provider-usage")) return true;
  if (req.path.startsWith("/admin/onboarding")) return true;
  if (req.path.startsWith("/admin/decisions/")) return true;
  if (req.path === "/admin/users") return true;
  if (req.path.startsWith("/admin/deployment-tokens")) return true;
  if (req.path.startsWith("/admin/policies")) return true;
  if (req.path === "/admin/prompt-transforms") return true;
  return false;
}

function allowsLocalDashboardWriteBypass(req: express.Request) {
  if (process.env.OPENLEASH_INSECURE_ADMIN_WRITE === "1") return true;
  if (process.env.NODE_ENV === "production") return false;
  const remote = req.socket.remoteAddress ?? "";
  const forwarded = String(req.header("x-forwarded-for") ?? "").split(",")[0]?.trim();
  return isLocalAddress(remote) && (!forwarded || isLocalAddress(forwarded));
}

function isLocalAddress(value: string) {
  const address = value.replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function isLocalHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeSkillReasons(value: unknown): Array<{ reason: string; quote?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const reason = typeof record.reason === "string" ? truncate(record.reason, 240) : "";
    const quote = typeof record.quote === "string" ? truncate(record.quote, 320) : undefined;
    return reason ? [{ reason, ...(quote ? { quote } : {}) }] : [];
  }).slice(0, 12);
}

async function skillPurposeSummary({ provided, content, skillName, skillPath }: { provided?: string; content: string; skillName: string; skillPath: string }) {
  const normalized = normalizeSkillPurpose(provided ?? "", skillName);
  if (normalized) return normalized;
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENLEASH_OPENAI_API_KEY;
  if (apiKey && content.trim()) {
    const llm = await summarizeSkillPurposeWithOpenAI({ apiKey, content, skillName, skillPath });
    if (llm) return llm;
  }
  return heuristicSkillPurpose(content, skillName);
}

async function summarizeSkillPurposeWithOpenAI({ apiKey, content, skillName, skillPath }: { apiKey: string; content: string; skillName: string; skillPath: string }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENLEASH_SKILL_SUMMARY_MODEL ?? process.env.OPENAI_EVAL_MODEL ?? "gpt-4.1-mini",
        input: [
          { role: "system", content: "Summarize this AI agent skill purpose in 4 to 8 words. No punctuation unless needed. No quotes. Return only the phrase." },
          { role: "user", content: JSON.stringify({ skillName, skillPath, content: truncate(content, 10000) }) }
        ],
        temperature: 0,
        max_output_tokens: 40
      })
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const output = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
    return normalizeSkillPurpose(output, skillName);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function heuristicSkillPurpose(content: string, skillName: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1] ?? content.match(/^description:\s*["']?(.+?)["']?\s*$/mi)?.[1];
  return normalizeSkillPurpose(heading ?? skillName.replace(/[-_]+/g, " "), skillName) ?? titleCaseWords(skillName.replace(/[-_]+/g, " "));
}

function normalizeSkillPurpose(value: string, fallback: string) {
  const cleaned = value.replace(/["'`]/g, "").replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length >= 4) return titleCaseWords(words.join(" "));
  const fallbackWords = fallback.replace(/[-_]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 8);
  return fallbackWords.length ? titleCaseWords(fallbackWords.join(" ")) : undefined;
}

function titleCaseWords(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.length <= 3 ? word : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function decodeJwtPayload(jwt: string) {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function nullableString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeIdpProvider(provider: unknown) {
  const value = String(provider ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const providers = [
    { keys: ["azure", "azuread", "entra", "entraid", "microsoftentra"], idpType: "AzureAD", label: "Microsoft Entra ID" },
    { keys: ["okta"], idpType: "Okta", label: "Okta" },
    { keys: ["ping", "pingone"], idpType: "Ping", label: "Ping Identity" },
    { keys: ["google", "googleworkspace", "workspace"], idpType: "Google", label: "Google Workspace" },
    { keys: ["activedirectory", "ad", "ldap"], idpType: "ActiveDirectory", label: "Active Directory / LDAP" }
  ];
  return providers.find((item) => item.keys.includes(value));
}

function providerCredentials(provider: ReturnType<typeof normalizeIdpProvider>, body: Record<string, unknown>) {
  if (!provider) return {};
  const value = (key: string) => String(body[key] ?? "").trim();
  switch (provider.idpType) {
    case "AzureAD":
      return { TenantId: value("tenantId") || value("TenantId"), ClientId: value("clientId") || value("ClientId"), ClientSecret: value("clientSecret") || value("ClientSecret") };
    case "Okta":
      return { Domain: value("domain") || value("Domain"), ClientId: value("clientId") || value("oktaClientId") || value("ClientId"), PrivateKey: value("privateKey") || value("oktaPrivateKey") || value("PrivateKey") || value("apiToken") || value("ApiToken") };
    case "Ping":
      return { ApiUrl: value("apiUrl") || value("ApiUrl"), AccessToken: value("accessToken") || value("AccessToken"), EnvironmentId: value("environmentId") || value("EnvironmentId") };
    case "Google":
      return { ServiceAccountJson: value("serviceAccountJson") || value("ServiceAccountJson"), AdminEmail: value("adminEmail") || value("AdminEmail") };
    case "ActiveDirectory":
      return { LdapHost: value("ldapHost") || value("LdapHost"), LdapPort: value("ldapPort") || value("LdapPort"), BindDn: value("bindDn") || value("BindDn"), BindPassword: value("bindPassword") || value("BindPassword"), BaseDn: value("baseDn") || value("BaseDn"), UseSsl: value("useSsl") || value("UseSsl") };
    default:
      return {};
  }
}

function hasAnyCredential(credentials: Record<string, unknown>) {
  return Object.values(credentials).some((value) => String(value ?? "").trim().length > 0);
}

function enrollmentCommand(tenantUrl: string, token: string) {
  return `openleash enroll --tenant ${tenantUrl} --token ${token}`;
}

function tokenFromRequest(req: express.Request) {
  const auth = req.header("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const queryToken = firstQuery(req.query.user_token) ?? firstQuery(req.query.token);
  return bearer || queryToken || "";
}

function firstQuery(value: unknown) {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function normalizeHookRequest(
  agent: HookAgentSlug,
  eventName: HookEventName,
  raw: any,
  query: express.Request["query"]
): EvaluationRequest {
  const metadata = LOCAL_HOOK_AGENT_METADATA[agent];
  const agentKind = metadata.kind as AgentKind;
  const sessionId = firstString(raw?.session_id, raw?.sessionId, raw?.conversation_id, raw?.conversationId, raw?.thread_id, raw?.threadId, raw?.chat_id, raw?.chatId, raw?.run_id, raw?.runId) ?? stableHookSessionId(agent, raw);
  const toolName = firstString(raw?.tool_name, raw?.toolName, raw?.tool?.name, raw?.function?.name, raw?.command?.name);
  const toolInput = firstDefined(raw?.tool_input, raw?.toolInput, raw?.tool?.input, raw?.input, raw?.arguments, raw?.args, raw?.params, raw?.command?.args);
  const prompt = normalizeHookPrompt(raw);
  return {
    computer: {
      hostname: firstQuery(query.hostname) ?? os.hostname(),
      platform: firstQuery(query.platform) ?? "unknown",
      osRelease: firstQuery(query.os_release)
    },
    agent: {
      kind: agentKind,
      displayName: metadata.displayName,
      version: firstQuery(query.agent_version) ?? raw?.version,
      executablePath: raw?.executable_path
    },
    event: {
      eventName,
      agentKind,
      agentVersion: firstQuery(query.agent_version) ?? raw?.version,
      sessionId,
      projectPath: firstString(raw?.cwd, raw?.workspace, raw?.workspaceDir, raw?.workspace_dir, raw?.project_dir, raw?.projectPath, raw?.project_path, raw?.root, raw?.repo, raw?.repository, raw?.context?.workspaceDir),
      prompt,
      tool: toolName ? { name: toolName, input: toolInput, output: raw?.tool_response ?? raw?.output } : undefined,
      transcript: normalizeHookTranscript(raw?.transcript),
      raw,
      occurredAt: new Date().toISOString()
    }
  };
}

function normalizeHookPrompt(raw: any) {
  const direct = firstString(
    raw?.prompt,
    raw?.user_prompt,
    raw?.userPrompt,
    raw?.message,
    raw?.input_text,
    raw?.inputText,
    raw?.prompt_response,
    raw?.promptResponse,
    raw?.agent_response,
    raw?.agentResponse,
    raw?.response,
    raw?.output_text,
    raw?.outputText,
    raw?.body,
    raw?.text,
    raw?.context?.content,
    raw?.context?.bodyForAgent,
    raw?.context?.sessionEntry?.content
  );
  if (direct) return direct;
  if (Array.isArray(raw?.messages)) {
    const message = raw.messages.slice().reverse().find((item: any) => typeof item?.content === "string" && item.content.trim());
    if (message) return message.content;
  }
  return undefined;
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeHookTranscript(value: unknown): ConversationTurn[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const turns = value
    .map((turn) => {
      if (!turn || typeof turn !== "object") return undefined;
      const record = turn as { role?: unknown; content?: unknown; at?: unknown };
      const role = typeof record.role === "string" && isConversationRole(record.role) ? record.role : undefined;
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!role || !content) return undefined;
      return {
        role,
        content,
        ...(typeof record.at === "string" ? { at: record.at } : {})
      };
    })
    .filter((turn): turn is ConversationTurn => Boolean(turn));
  return turns.length > 0 ? turns.slice(-20) : undefined;
}

function isConversationRole(value: string): value is ConversationTurn["role"] {
  return value === "user" || value === "assistant" || value === "tool" || value === "system";
}

function isHookEventName(value: string): value is HookEventName {
  return ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Notification", "SessionEnd", "Stop"].includes(value);
}

function nativeHookDecision(agent: HookAgentSlug, eventName: HookEventName, decision: EvaluationResponse) {
  const reason = humanDecisionReason(decision);
  if (agent === "claude" || agent === "nanoclaw") {
    if (eventName === "PreToolUse") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.decision,
          permissionDecisionReason: reason
        },
        suppressOutput: true
      };
    }
    return { continue: decision.decision !== "deny", stopReason: reason, suppressOutput: true };
  }
  return { decision: decision.decision === "deny" ? "block" : decision.decision, reason };
}

function promptTransformHookDecision(agent: HookAgentSlug, eventName: HookEventName, prompt: string, summary: string) {
  const base = nativeHookDecision(agent, eventName, {
    decision: "allow",
    decisionId: "",
    summary,
    results: []
  });
  return {
    ...base,
    prompt,
    transformedPrompt: prompt,
    replacementPrompt: prompt,
    output: prompt,
    hookSpecificOutput: {
      ...((base as { hookSpecificOutput?: object }).hookSpecificOutput ?? {}),
      hookEventName: eventName,
      prompt,
      transformedPrompt: prompt,
      replacementPrompt: prompt
    }
  };
}

function humanDecisionReason(decision: EvaluationResponse) {
  if (decision.decision === "allow") return "OpenLeash approved this action.";
  if (decision.decision === "deny" && decision.resolutionGuidance) {
    return `OpenLeash denied this action. User guidance: ${decision.resolutionGuidance}`;
  }
  if (decision.decision === "deny") return decision.summary || "OpenLeash denied this action.";
  return decision.question ?? decision.summary;
}

function cleanResolutionGuidance(value?: string) {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 64) || "user";
}

function apiSurfaceFromEnv(): ApiSurface {
  const value = String(process.env.OPENLEASH_API_SURFACE ?? "client").toLowerCase();
  return value === "dashboard" || value === "all" ? value : "client";
}

function surfaceForRequest(method: string, requestPath: string): ApiSurface | undefined {
  const verb = method.toUpperCase();
  if (requestPath === "/health") return "all";

  if (
    requestPath === "/admin/overview" ||
    requestPath === "/admin/security" ||
    requestPath === "/admin/mcp-servers" ||
    /^\/admin\/mcp-servers\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/skills" ||
    requestPath === "/admin/plugins" ||
    requestPath.startsWith("/admin/plugins/") ||
    requestPath === "/admin/plugin-marketplace" ||
    requestPath === "/admin/plugin-marketplace/policy" ||
    requestPath === "/admin/logs" ||
    /^\/admin\/logs\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/triggers" ||
    /^\/admin\/triggers\/[^/]+$/.test(requestPath) ||
    /^\/admin\/events\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/external-agents" ||
    requestPath === "/admin/external-agents/sync" ||
    requestPath === "/admin/provider-usage" ||
    requestPath.startsWith("/admin/provider-usage/") ||
    requestPath === "/admin/evaluation-key" ||
    requestPath === "/admin/onboarding" ||
    requestPath.startsWith("/admin/onboarding/") ||
    requestPath === "/admin/identity" ||
    requestPath === "/admin/users" ||
    requestPath === "/admin/deployment-tokens" ||
    requestPath.startsWith("/admin/deployment-tokens") ||
    requestPath === "/admin/policies" ||
    /^\/admin\/policies\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/prompt-transforms" ||
    requestPath === "/auth/session" ||
    requestPath === "/auth/account/package" ||
    requestPath === "/auth/logout" ||
    requestPath === "/auth/sso/authorize" ||
    requestPath === "/auth/sso/callback" ||
    requestPath === "/auth/google/start" ||
    requestPath === "/auth/google/callback" ||
    requestPath === "/auth/microsoft/start" ||
    requestPath === "/auth/microsoft/callback" ||
    /^\/organizations\/[^/]+\/sso-providers$/.test(requestPath) ||
    /^\/organizations\/[^/]+$/.test(requestPath) ||
    (verb === "POST" && requestPath === "/organizations")
  ) {
    return "dashboard";
  }

  if (
    requestPath === "/v1/enroll" ||
    requestPath === "/v1/auth/google/callback" ||
    requestPath === "/v1/auth/microsoft/callback" ||
    requestPath === "/public/plugins" ||
    /^\/public\/plugins\/[^/]+$/.test(requestPath) ||
    requestPath === "/v1/evaluate" ||
    /^\/v1\/hooks\/[^/]+\/[^/]+$/.test(requestPath) ||
    requestPath === "/v1/desktop/enroll" ||
    requestPath === "/v1/desktop/agents" ||
    requestPath === "/v1/plugins" ||
    requestPath === "/v1/plugin-marketplace" ||
    requestPath === "/v1/plugin-submissions" ||
    /^\/v1\/plugins\/[^/]+\/settings$/.test(requestPath) ||
    /^\/v1\/plugins\/[^/]+\/install$/.test(requestPath) ||
    /^\/v1\/plugins\/[^/]+\/uninstall$/.test(requestPath) ||
    requestPath === "/v1/skills/observations" ||
    /^\/v1\/decisions\/[^/]+$/.test(requestPath) ||
    /^\/admin\/decisions\/[^/]+\/resolve$/.test(requestPath) ||
    requestPath === "/admin/tray-status" ||
    requestPath.startsWith("/v1/mobile/") ||
    requestPath === "/api/updates/check" ||
    requestPath === "/api/updates/latest" ||
    requestPath === "/api/admin/releases"
  ) {
    return "client";
  }

  return undefined;
}

function apiFunctionForRequest(method: string, requestPath: string): OpenLeashApiFunction | undefined {
  const verb = method.toUpperCase();
  if (requestPath === "/health") return "health";
  if (verb === "POST" && requestPath === "/v1/enroll") return "tenantEnroll";
  if (verb === "POST" && requestPath === "/v1/desktop/enroll") return "desktopEnroll";
  if (verb === "POST" && requestPath === "/v1/desktop/agents") return "desktopEnroll";
  if (verb === "GET" && requestPath === "/v1/plugins") return "tenantPluginsRead";
  if (verb === "GET" && requestPath === "/v1/plugin-marketplace") return "tenantPluginsRead";
  if (verb === "GET" && requestPath === "/public/plugins") return "tenantPluginsRead";
  if (verb === "GET" && /^\/public\/plugins\/[^/]+$/.test(requestPath)) return "tenantPluginsRead";
  if (verb === "POST" && /^\/v1\/plugins\/[^/]+\/settings$/.test(requestPath)) return "adminPluginsWrite";
  if (verb === "POST" && /^\/v1\/plugins\/[^/]+\/install$/.test(requestPath)) return "adminPluginsWrite";
  if (verb === "POST" && /^\/v1\/plugins\/[^/]+\/uninstall$/.test(requestPath)) return "adminPluginsWrite";
  if (verb === "POST" && requestPath === "/v1/plugin-submissions") return "adminPluginsWrite";
  if (verb === "POST" && requestPath === "/v1/evaluate") return "tenantEvaluate";
  if (verb === "POST" && /^\/v1\/hooks\/[^/]+\/[^/]+$/.test(requestPath)) return "tenantHookEvaluate";
  if (verb === "POST" && requestPath === "/v1/skills/observations") return "tenantSkillObservation";
  if (verb === "GET" && /^\/v1\/decisions\/[^/]+$/.test(requestPath)) return "tenantDecisionPoll";
  if (verb === "POST" && /^\/admin\/decisions\/[^/]+\/resolve$/.test(requestPath)) return "tenantDecisionResolve";
  if (verb === "GET" && requestPath === "/admin/tray-status") return "tenantTrayStatus";
  if (verb === "GET" && requestPath === "/admin/overview") return "adminOverview";
  if (verb === "GET" && requestPath === "/admin/security") return "adminSecurity";
  if (verb === "GET" && requestPath === "/admin/mcp-servers") return "adminMcpServers";
  if (verb === "GET" && /^\/admin\/mcp-servers\/[^/]+$/.test(requestPath)) return "adminMcpServerDetail";
  if (verb === "GET" && requestPath === "/admin/skills") return "adminSkills";
  if (verb === "GET" && requestPath === "/admin/plugins") return "adminPluginsRead";
  if (verb === "GET" && requestPath === "/admin/plugin-marketplace") return "adminPluginsRead";
  if (verb === "POST" && /^\/admin\/plugins\/[^/]+\/settings$/.test(requestPath)) return "adminPluginsWrite";
  if (verb === "POST" && /^\/admin\/plugins\/[^/]+\/policy$/.test(requestPath)) return "adminPluginsWrite";
  if (verb === "POST" && requestPath === "/admin/plugin-marketplace/policy") return "adminPluginsWrite";
  if (verb === "GET" && requestPath === "/admin/logs") return "adminLogs";
  if (verb === "GET" && /^\/admin\/logs\/[^/]+$/.test(requestPath)) return "adminLogDetail";
  if (verb === "GET" && requestPath === "/admin/triggers") return "adminTriggers";
  if (verb === "GET" && /^\/admin\/triggers\/[^/]+$/.test(requestPath)) return "adminTriggerDetail";
  if (verb === "GET" && /^\/admin\/events\/[^/]+$/.test(requestPath)) return "adminEventDetail";
  if (verb === "GET" && requestPath === "/admin/external-agents") return "adminExternalAgents";
  if (verb === "POST" && requestPath === "/admin/external-agents/sync") return "adminExternalAgentsSync";
  if (verb === "GET" && (requestPath === "/admin/provider-usage" || requestPath === "/admin/provider-usage/connections")) return "adminProviderUsageRead";
  if (verb === "POST" && requestPath === "/admin/provider-usage/sync") return "adminProviderUsageSync";
  if (verb === "POST" && requestPath.startsWith("/admin/provider-usage/")) return "adminProviderUsageWrite";
  if (verb === "POST" && requestPath === "/admin/evaluation-key") return "adminProviderUsageWrite";
  if (verb === "GET" && requestPath === "/admin/onboarding") return "adminOnboardingRead";
  if (verb === "GET" && requestPath === "/admin/identity") return "adminIdentityRead";
  if (requestPath.startsWith("/admin/onboarding/")) return "adminOnboardingWrite";
  if (verb === "POST" && requestPath === "/admin/users") return "adminUsersWrite";
  if (verb === "GET" && requestPath === "/admin/deployment-tokens") return "adminDeploymentTokensRead";
  if (requestPath.startsWith("/admin/deployment-tokens")) return "adminDeploymentTokensWrite";
  if (verb === "POST" && requestPath === "/admin/policies") return "adminPoliciesWrite";
  if (verb === "PUT" && /^\/admin\/policies\/[^/]+$/.test(requestPath)) return "adminPoliciesWrite";
  if (verb === "GET" && requestPath === "/admin/prompt-transforms") return "adminPromptTransformsRead";
  if (verb === "POST" && requestPath === "/admin/prompt-transforms") return "adminPromptTransformsWrite";
  if (verb === "GET" && requestPath === "/auth/session") return "authSession";
  if (verb === "POST" && requestPath === "/auth/account/package") return "authSession";
  if (verb === "POST" && requestPath === "/auth/logout") return "authLogout";
  if (verb === "POST" && requestPath === "/auth/sso/authorize") return "authSsoAuthorize";
  if (verb === "POST" && requestPath === "/auth/sso/callback") return "authSsoCallback";
  if (verb === "GET" && requestPath === "/v1/auth/google/callback") return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/v1/auth/microsoft/callback") return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/auth/microsoft/start") return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/auth/microsoft/callback") return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/v1/mobile/bootstrap") return "mobileBootstrap";
  if (verb === "POST" && requestPath === "/v1/mobile/auth/start") return "mobileAuthStart";
  if (verb === "POST" && requestPath === "/v1/mobile/auth/exchange") return "mobileAuthExchange";
  if (verb === "POST" && requestPath === "/v1/mobile/model-key") return "mobileModelKey";
  if (verb === "POST" && requestPath === "/v1/mobile/devices") return "mobileDeviceRegister";
  if (verb === "GET" && requestPath === "/v1/mobile/state") return "mobileState";
  if (verb === "POST" && /^\/v1\/mobile\/decisions\/[^/]+\/resolve$/.test(requestPath)) return "mobileDecisionResolve";
  if (verb === "GET" && /^\/organizations\/[^/]+\/sso-providers$/.test(requestPath)) return "organizationSsoProviders";
  if (verb === "GET" && /^\/organizations\/[^/]+$/.test(requestPath)) return "organizationsRead";
  if (verb === "POST" && requestPath === "/organizations") return "organizationsWrite";
  if (verb === "POST" && requestPath === "/api/updates/check") return "clientUpdateCheck";
  if (verb === "GET" && requestPath === "/api/updates/latest") return "clientUpdateLatest";
  if (verb === "POST" && requestPath === "/api/admin/releases") return "clientReleasePublish";
  return undefined;
}

function summarizeBlockedAction(request: EvaluationRequest, policyName: string) {
  const agent = request.agent.displayName;
  const tool = request.event.tool?.name;
  const input = request.event.tool?.input;
  const inputText = JSON.stringify(input ?? {}).toLowerCase();
  const policy = policyName.toLowerCase();
  if (policy.includes("credential") || policy.includes("secret") || /(\.env|credential|secret|token|private key|id_rsa|kubeconfig)/.test(inputText)) {
    return `${agent} is trying to access or create sensitive file content.`;
  }
  if (policy.includes("destructive") || /(rm\s+-rf|delete|destroy|git reset|chmod|chown)/.test(inputText)) {
    return `${agent} is trying to run a potentially destructive command.`;
  }
  if (policy.includes("git repo") || /(git init|new git repo|create .*repo)/.test(inputText)) {
    return `${agent} is trying to create a new Git repository.`;
  }
  if (policy.includes("external") || policy.includes("sharing") || /(http|curl|upload|send)/.test(inputText)) {
    return `${agent} is trying to share code or data outside this workspace.`;
  }
  if (tool) return `${agent} is trying to use ${tool} in a way OpenLeash paused.`;
  if (request.event.eventName === "UserPromptSubmit") return `${agent} is trying to answer a prompt OpenLeash paused.`;
  return `${agent} is trying to continue with an action OpenLeash paused.`;
}

function summarizePolicyTitle(rule: string) {
  const lower = rule.toLowerCase();
  if (/(credential files|local files|\.env|kubeconfig|npm token|password vault|cloud credentials|api key stores)/.test(lower)) return "Credential files access";
  if (/(delete files|destructive|irreversible|rewrite history|terraform destroy|git reset|change permissions)/.test(lower)) return "Destructive commands";
  if (/(personal data|pii|reveal secrets|tokens|private keys|credentials)/.test(lower)) return "Secret and personal data";
  if (/5\s*(\+|plus|add|added to)\s*4/.test(lower)) return "5 plus 4 answers";
  if (/(new git repo|create .*git repo|git init|repository)/.test(lower)) return "Git repo creation";
  if (/(source code|external domains|unknown external|exfiltrat)/.test(lower)) return "External code sharing";
  const cleaned = rule
    .replace(/[^\w\s.+/#-]/g, " ")
    .replace(/\b(do not|don't|never|disallow|prevent|block|deny|allow|agents?|the|a|an|to|from|that|which|any|before)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = (cleaned || "New policy").split(/\s+/).slice(0, 7);
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function policyCategory(input: string, name: string, rule: string) {
  const provided = input.trim();
  if (provided) return provided;
  const text = `${name} ${rule}`.toLowerCase();
  if (/credential|secret|token|private key|api key|\.env|kubeconfig|password|cookie|npmrc/.test(text)) return "Secrets and credentials";
  if (/personal|pii|customer|employee|passport|ssn|credit card|regulated|external|upload|source code|exfiltrat|unknown url|third-party/.test(text)) return "Data protection";
  if (/git|branch|commit|push|rebase|repository|repo|history|worktree/.test(text)) return "Source control";
  if (/database|drop table|drop database|truncate|delete from|update statement|sql/.test(text)) return "Databases";
  if (/terraform|kubernetes|kubectl|cloud|s3|gcp|aws|azure|namespace|vm|dns|helm|infrastructure/.test(text)) return "Infrastructure";
  if (/package|dependency|lockfile|npm|pnpm|yarn|pip|gem|cargo|go install|supply-chain/.test(text)) return "Supply chain";
  if (/rm -rf|delete|destructive|format|chmod|chown|filesystem|disk|volume/.test(text)) return "System safety";
  return "General";
}

function policyInventorySql(organizationWhere = "") {
  const organizationFilter = organizationWhere ? `and ${organizationWhere}` : "";
  return `
    select p.*,
           coalesce(stats.trigger_count, 0)::int as trigger_count,
           coalesce(stats.deny_count, 0)::int as deny_count,
           coalesce(stats.question_count, 0)::int as question_count,
           stats.last_triggered_at,
           stats.last_agent_name,
           stats.last_project_path
    from policies p
    left join lateral (
      select count(*) filter (where pr.status in ('failed', 'needs_question'))::int as trigger_count,
             count(*) filter (where pr.status = 'failed')::int as deny_count,
             count(*) filter (where pr.status = 'needs_question')::int as question_count,
             max(pr.created_at) filter (where pr.status in ('failed', 'needs_question')) as last_triggered_at,
             (array_agg(ar.display_name order by pr.created_at desc) filter (where pr.status in ('failed', 'needs_question')))[1] as last_agent_name,
             (array_agg(ce.project_path order by pr.created_at desc) filter (where pr.status in ('failed', 'needs_question')))[1] as last_project_path
      from policy_results pr
      join evaluations e on e.id = pr.evaluation_id
      join conversation_events ce on ce.id = e.conversation_event_id
      left join agent_runtimes ar on ar.id = ce.agent_runtime_id
      left join users u on u.id = e.user_id
      where (pr.policy_id = p.id or pr.policy_name = p.name)
        ${organizationFilter}
    ) stats on true
    order by p.category asc, p.created_at asc`;
}

export async function prepareOpenLeashApi(options: PrepareOpenLeashApiOptions = {}) {
  const runningApp = options.app ?? app;
  const surface = options.surface ?? apiSurface;
  await ensureDevToken();
  for (const extension of options.extensions ?? []) {
    await extension({ app: runningApp, surface });
  }
  return runningApp;
}

export async function startOpenLeashApi(options: StartOpenLeashApiOptions = {}) {
  const runningApp = await prepareOpenLeashApi(options);
  const surface = options.surface ?? apiSurface;
  const port = Number(
    options.port ??
    process.env.OPENLEASH_API_PORT ??
    (surface === "dashboard" ? process.env.OPENLEASH_DASHBOARD_API_PORT ?? 9319 : 9318)
  );
  return runningApp.listen(port, () => {
    const label = surface === "dashboard" ? "OpenLeash dashboard API" : "OpenLeash client API";
    console.log(`${label} listening on http://localhost:${port}`);
  });
}

const isEntrypoint = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isEntrypoint) {
  await startOpenLeashApi();
}
