export const MAX_SESSION_MONITORING_PAUSE_MS = 30 * 60_000;

export function normalizeSessionMonitoringScope(value: unknown) {
  const input = value && typeof value === "object"
    ? value as { agentKind?: unknown; sessionIds?: unknown }
    : undefined;
  const agentKind = String(input?.agentKind ?? "").trim().toLowerCase();
  const values = Array.isArray(input?.sessionIds) ? input.sessionIds : [];
  const sessionIds = [...new Set(values
    .map((item) => String(item ?? "").trim())
    .filter((item) =>
      item.length > 0 &&
      item.length <= 512 &&
      !["proxy", "unknown"].includes(item.toLowerCase())
    ))].slice(0, 16);
  if (!agentKind || agentKind.length > 80 || sessionIds.length === 0) return undefined;
  return { agentKind, sessionIds };
}

export function normalizedSessionPauseExpiry(value: unknown, now = Date.now()) {
  const requested = typeof value === "string" ? Date.parse(value) : Number.NaN;
  const upperBound = now + MAX_SESSION_MONITORING_PAUSE_MS;
  const expiresAt = Number.isFinite(requested)
    ? Math.min(upperBound, Math.max(now + 60_000, requested))
    : upperBound;
  return new Date(expiresAt);
}
