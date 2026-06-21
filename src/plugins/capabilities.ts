import type { EvaluationRequest, PluginCapabilities, PluginStorageGetRequest, PluginStorageScope } from "@openleash/shared";
import { pool } from "../db.js";
import { evaluatePolicies } from "../evaluator.js";
import type { TenantModelKey } from "../model-keys.js";
import { compressPromptCapability, inspectDlpCapability } from "../prompt-transforms.js";

export function createPluginCapabilities({
  apiKey,
  tenantModelKey,
  organizationId,
  pluginId,
  request
}: {
  apiKey?: string;
  tenantModelKey?: TenantModelKey;
  organizationId?: string;
  pluginId: string;
  request?: EvaluationRequest;
}): PluginCapabilities {
  const storage: PluginCapabilities["storage"] = {
    async get<T = unknown>({ key, scope }: PluginStorageGetRequest) {
      if (!organizationId) return undefined;
      const result = await pool.query<{ value: unknown; updated_at: string; expires_at: string | null }>(
        `select value, updated_at, expires_at
         from plugin_state
         where organization_id = $1
           and plugin_id = $2
           and scope_key = $3
           and state_key = $4
           and (expires_at is null or expires_at > now())`,
        [organizationId, pluginId, scopeKey(scope, request), key]
      );
      const row = result.rows[0];
      return row ? { value: row.value as T, updatedAt: row.updated_at, expiresAt: row.expires_at } : undefined;
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
      return { value: row.value, updatedAt: row.updated_at, expiresAt: row.expires_at };
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
    }
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
