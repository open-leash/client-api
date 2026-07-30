import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SESSION_MONITORING_PAUSE_MS,
  normalizeSessionMonitoringScope,
  normalizedSessionPauseExpiry,
} from "./session-monitoring.js";

test("normalizes a bounded exact-session pause scope", () => {
  assert.deepEqual(normalizeSessionMonitoringScope({
    agentKind: " Codex ",
    sessionIds: ["conversation-1", "conversation-1", "proxy", "unknown", ""],
  }), {
    agentKind: "codex",
    sessionIds: ["conversation-1"],
  });
  assert.equal(normalizeSessionMonitoringScope({
    agentKind: "codex",
    sessionIds: ["proxy"],
  }), undefined);
});

test("caps conversation monitoring pauses at thirty minutes", () => {
  const now = Date.parse("2026-07-29T10:00:00.000Z");
  assert.equal(
    normalizedSessionPauseExpiry("2026-07-29T12:00:00.000Z", now).getTime(),
    now + MAX_SESSION_MONITORING_PAUSE_MS,
  );
});
