import assert from "node:assert/strict";
import test from "node:test";
import { normalizePluginSettingProfiles, resolvePluginSettingProfiles } from "./settings-profiles.js";

test("normalizes bounded agent-scoped plugin profiles", () => {
  assert.deepEqual(normalizePluginSettingProfiles([{
    id: " Codex Strict ",
    name: "Codex strict",
    agentKinds: ["codex", "codex", "not-an-agent"],
    enabled: true,
    priority: 20.9,
    config: { level: "maximum" },
  }]), [{
    id: "codex-strict",
    name: "Codex strict",
    agentKinds: ["codex"],
    enabled: true,
    priority: 20,
    config: { level: "maximum" },
  }]);
});

test("merges matching organization then user profiles deterministically", () => {
  const resolved = resolvePluginSettingProfiles({
    enabled: false,
    config: { level: "light", keep: true },
    organizationProfiles: [{ id: "org", name: "Org", agentKinds: ["codex"], enabled: true, config: { level: "standard" } }],
    userProfiles: [
      { id: "claude", name: "Claude", agentKinds: ["claude-code"], config: { level: "light" } },
      { id: "codex", name: "Codex", agentKinds: ["codex"], config: { level: "maximum" }, priority: 10 },
    ],
    agentKind: "codex",
  });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.config, { level: "maximum", keep: true });
  assert.deepEqual(resolved.effectiveProfileIds, ["organization:org", "user:codex"]);
});

test("locked organization settings ignore user profiles", () => {
  const resolved = resolvePluginSettingProfiles({
    enabled: true,
    config: { action: "block" },
    userProfiles: [{ id: "relax", name: "Relax", agentKinds: [], enabled: false, config: { action: "ask" } }],
    agentKind: "codex",
    configLocked: true,
  });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.config, { action: "block" });
  assert.deepEqual(resolved.effectiveProfileIds, []);
});

test("mandatory plugins allow employee config freedom without allowing an agent-level disable", () => {
  const resolved = resolvePluginSettingProfiles({
    enabled: true,
    config: { level: "standard" },
    userProfiles: [{
      id: "codex-personal",
      name: "Codex personal",
      agentKinds: ["codex"],
      enabled: false,
      config: { level: "strict" },
    }],
    agentKind: "codex",
    mandatory: true,
  });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.config, { level: "strict" });
  assert.deepEqual(resolved.effectiveProfileIds, ["user:codex-personal"]);
});

test("targets one enrolled agent without creating another container", () => {
  const profiles = normalizePluginSettingProfiles([{
    id: "codex-laptop",
    name: "Codex on laptop",
    agentKinds: ["codex"],
    agentIds: ["agent-laptop"],
    config: { level: "aggressive" },
  }]);
  assert.equal(resolvePluginSettingProfiles({
    enabled: true,
    config: { level: "balanced" },
    userProfiles: profiles,
    agentKind: "codex",
    agentId: "agent-laptop",
  }).config.level, "aggressive");
  assert.equal(resolvePluginSettingProfiles({
    enabled: true,
    config: { level: "balanced" },
    userProfiles: profiles,
    agentKind: "codex",
    agentId: "agent-desktop",
  }).config.level, "balanced");
});
