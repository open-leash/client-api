type PluginRun = Record<string, unknown>;

const STATUS_PRIORITY: Record<string, number> = {
  blocked: 3,
  failed: 3,
  needs_question: 2,
};

const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function notificationPluginAttribution(payload: unknown) {
  if (!payload || typeof payload !== "object") return coreAttribution();
  const runs = Array.isArray(
    (payload as { openleashPluginRuns?: unknown }).openleashPluginRuns,
  )
    ? (payload as { openleashPluginRuns: PluginRun[] }).openleashPluginRuns
    : [];
  const responsible = runs
    .filter((run) => STATUS_PRIORITY[normalizedStatus(run)] != null)
    .sort((left, right) => responsibilityScore(right) - responsibilityScore(left))[0];
  if (!responsible) return coreAttribution();
  const pluginId = String(
    responsible.pluginId ?? responsible.plugin_id ?? "openleash.core",
  );
  return { plugin_id: pluginId, plugin_name: pluginPackageSlug(pluginId) };
}

function responsibilityScore(run: PluginRun) {
  return STATUS_PRIORITY[normalizedStatus(run)] * 10 + highestFindingSeverity(run);
}

function normalizedStatus(run: PluginRun) {
  return String(run.status ?? "").toLowerCase();
}

function highestFindingSeverity(run: PluginRun) {
  if (!Array.isArray(run.findings)) return 0;
  return run.findings.reduce((highest, finding) => {
    if (!finding || typeof finding !== "object") return highest;
    const severity = String((finding as { severity?: unknown }).severity ?? "").toLowerCase();
    return Math.max(highest, SEVERITY_PRIORITY[severity] ?? 0);
  }, 0);
}

function coreAttribution() {
  return { plugin_id: "openleash.core", plugin_name: "OpenLeash core" };
}

function pluginPackageSlug(pluginId: string) {
  const slug = pluginId.replace(/^openleash\./, "");
  return slug === "prompt-compression"
    ? "token-saver"
    : slug || "openleash-core";
}
