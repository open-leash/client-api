import assert from "node:assert/strict";
import test from "node:test";
import { notificationPluginAttribution } from "./notification-plugin-attribution.js";

test("attributes recursive deletion to blast-radius instead of the first asking plugin", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      {
        pluginId: "openleash.sensitive-access",
        status: "needs_question",
        findings: [{ severity: "high" }],
      },
      {
        pluginId: "openleash.blast-radius",
        status: "blocked",
        findings: [{ severity: "critical" }],
      },
    ],
  });

  assert.deepEqual(attribution, {
    plugin_id: "openleash.blast-radius",
    plugin_name: "blast-radius",
  });
});

test("uses severity to break ties between responsible plugins", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      { pluginId: "openleash.rules-enforcer", status: "blocked", findings: [{ severity: "high" }] },
      { pluginId: "openleash.blast-radius", status: "blocked", findings: [{ severity: "critical" }] },
    ],
  });

  assert.equal(attribution.plugin_name, "blast-radius");
});

test("attributes equal ask-level database destruction to blast-radius", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      { pluginId: "openleash.sensitive-access", status: "needs_question", findings: [{ severity: "high" }] },
      { pluginId: "openleash.blast-radius", status: "needs_question", findings: [{ severity: "high" }] },
    ],
  });

  assert.equal(attribution.plugin_name, "blast-radius");
});

test("does not let tie priority override a higher-severity sensitive finding", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      { pluginId: "openleash.sensitive-access", status: "needs_question", findings: [{ severity: "critical" }] },
      { pluginId: "openleash.blast-radius", status: "needs_question", findings: [{ severity: "high" }] },
    ],
  });

  assert.equal(attribution.plugin_name, "sensitive-access");
});
