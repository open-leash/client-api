import type {
  EvaluationRequest,
  PluginCapabilities,
  PluginLogRecord,
  PluginLogLevel,
  PluginLogRequest,
  PluginStorageGetRequest,
  PluginStorageListRequest,
  PluginStorageScope
} from "@openleash/shared";
import { pool } from "../db.js";
import { evaluatePolicies } from "../evaluator.js";
import type { TenantModelKey } from "../model-keys.js";
import { compressPromptCapability, inspectDlpCapability } from "../prompt-transforms.js";

export function createPluginCapabilities({
  apiKey,
  tenantModelKey,
  organizationId,
  pluginId,
  request,
  conversationEventId,
  userId,
  computerId,
  runtimeId
}: {
  apiKey?: string;
  tenantModelKey?: TenantModelKey;
  organizationId?: string;
  pluginId: string;
  request?: EvaluationRequest;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
}): PluginCapabilities {
  const storage: PluginCapabilities["storage"] = {
    async get<T = unknown>({ key, scope }: PluginStorageGetRequest) {
      if (!organizationId) return undefined;
      const result = await pool.query<{ value: unknown; updated_at: string; expires_at: string | null }>(
        `select state_key, value, updated_at, expires_at
         from plugin_state
         where organization_id = $1
           and plugin_id = $2
           and scope_key = $3
           and state_key = $4
           and (expires_at is null or expires_at > now())`,
        [organizationId, pluginId, scopeKey(scope, request), key]
      );
      const row = result.rows[0];
      return row ? { key, scope, value: row.value as T, updatedAt: row.updated_at, expiresAt: row.expires_at } : undefined;
    },
    async set({ key, value, scope, ttlSeconds }) {
      if (!organizationId) {
        return { value, updatedAt: new Date().toISOString(), expiresAt: null };
      }
      const result = await pool.query<{ value: unknown; updated_at: string; expires_at: string | null }>(
        `insert into plugin_state (organization_id, plugin_id, scope_key, state_key, value, expires_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, case when $6::int is null then null else now() + ($6::int * interval '1 second') end, now())
         on conflict (organization_id, plugin_id, scope_key, state_key) do update set
           value = excluded.value,
           expires_at = excluded.expires_at,
           updated_at = now()
         returning value, updated_at, expires_at`,
        [organizationId, pluginId, scopeKey(scope, request), key, JSON.stringify(value), normalizedTtl(ttlSeconds)]
      );
      const row = result.rows[0];
      return { key, scope, value: row.value, updatedAt: row.updated_at, expiresAt: row.expires_at };
    },
    async list<T = unknown>({ keyPrefix, scope, limit }: PluginStorageListRequest = {}) {
      if (!organizationId) return [];
      const result = await pool.query<{ state_key: string; value: unknown; updated_at: string; expires_at: string | null }>(
        `select state_key, value, updated_at, expires_at
         from plugin_state
         where organization_id = $1
           and plugin_id = $2
           and scope_key = $3
           and ($4::text is null or state_key like $4::text || '%')
           and (expires_at is null or expires_at > now())
         order by updated_at desc
         limit $5`,
        [organizationId, pluginId, scopeKey(scope, request), cleanPrefix(keyPrefix), normalizedLimit(limit)]
      );
      return result.rows.map((row) => ({
        key: row.state_key,
        scope,
        value: row.value as T,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at
      }));
    },
    async delete({ key, scope }) {
      if (!organizationId) return;
      await pool.query(
        `delete from plugin_state
         where organization_id = $1 and plugin_id = $2 and scope_key = $3 and state_key = $4`,
        [organizationId, pluginId, scopeKey(scope, request), key]
      );
    }
  };

  return {
    prompt: {
      compress(request) {
        return compressPromptCapability({ ...request, apiKey });
      }
    },
    dlp: {
      inspect(request) {
        return inspectDlpCapability({ ...request, apiKey });
      }
    },
    security: {
      evaluatePolicies({ request, policies }) {
        return evaluatePolicies(request, policies, tenantModelKey);
      }
    },
    storage,
    notification: {
      async send(notification) {
        const dedupeKey = notification.dedupeKey?.trim();
        if (!dedupeKey || !organizationId) {
          return { sent: true, deduped: false };
        }
        const key = `notification:${dedupeKey}`;
        const existing = await storage.get({ key, scope: notification.scope });
        if (existing && notification.minIntervalSeconds) {
          const ageMs = Date.now() - new Date(existing.updatedAt).getTime();
          if (ageMs < notification.minIntervalSeconds * 1000) return { sent: false, deduped: true };
        }
        await storage.set({
          key,
          scope: notification.scope,
          value: {
            level: notification.level,
            title: notification.title,
            summary: notification.summary
          },
          ttlSeconds: notification.minIntervalSeconds
        });
        return { sent: true, deduped: false };
      }
    },
    log: {
      async emit(log) {
        return emitPluginLog({
          organizationId,
          pluginId,
          conversationEventId,
          userId,
          computerId,
          runtimeId,
          request,
          log
        });
      }
    }
  };
}

async function emitPluginLog({
  organizationId,
  pluginId,
  conversationEventId,
  userId,
  computerId,
  runtimeId,
  request,
  log
}: {
  organizationId?: string;
  pluginId: string;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
  request?: EvaluationRequest;
  log: PluginLogRequest;
}) {
  const level = normalizeLogLevel(log.level);
  const category = normalizeLogCategory(log.category);
  const message = String(log.message ?? "").trim().slice(0, 4000) || "Plugin log event.";
  const code = typeof log.code === "string" && log.code.trim() ? log.code.trim().slice(0, 120) : undefined;
  const scope = log.scope ?? {
    agentKind: request?.agent.kind,
    sessionId: request?.event.sessionId,
    projectPath: request?.event.projectPath
  };
  const data = sanitizeLogData(log.data);
  const createdAt = new Date().toISOString();

  if (!organizationId) {
    return { pluginId, level, message, code, category, data, scope, createdAt };
  }

  const result = await pool.query<{ id: string; created_at: string }>(
    `insert into plugin_log_events
     (organization_id, plugin_id, conversation_event_id, user_id, computer_id, agent_runtime_id, level, category, code, message, scope, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
     returning id, created_at`,
    [
      organizationId,
      pluginId,
      conversationEventId ?? null,
      userId ?? null,
      computerId ?? null,
      runtimeId ?? null,
      level,
      category,
      code ?? null,
      message,
      JSON.stringify(scope ?? {}),
      JSON.stringify(data)
    ]
  );
  return {
    id: result.rows[0]?.id,
    pluginId,
    level,
    message,
    code,
    category,
    data,
    scope,
    createdAt: result.rows[0]?.created_at ?? createdAt
  };
}

function scopeKey(scope: PluginStorageScope | undefined, request: EvaluationRequest | undefined) {
  const merged = {
    agentKind: scope?.agentKind ?? request?.agent.kind,
    sessionId: scope?.sessionId ?? request?.event.sessionId,
    conversationId: scope?.conversationId,
    projectPath: scope?.projectPath ?? request?.event.projectPath,
    userId: scope?.userId,
    key: scope?.key
  };
  const entries = Object.entries(merged)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : "global";
}

function normalizedTtl(value: number | undefined) {
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.min(60 * 60 * 24 * 365, Math.floor(Number(value))));
}

function normalizedLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.floor(Number(value))));
}

function cleanPrefix(value: string | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function normalizeLogLevel(value: unknown): PluginLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "security"
    ? value
    : "info";
}

function normalizeLogCategory(value: unknown): PluginLogRecord["category"] {
  return value === "system" || value === "security" || value === "audit" ? value : "plugin";
}

function sanitizeLogData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, entry]) => [key.slice(0, 120), sanitizeLogValue(entry, 0)])
  );
}

function sanitizeLogValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[Truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 1999)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, entry]) => [key.slice(0, 120), sanitizeLogValue(entry, depth + 1)])
    );
  }
  return String(value);
}
