import assert from "node:assert/strict";
import test from "node:test";
import { checkForClientUpdate, clientUpdatesEnabled } from "./releases.js";

test("client update checks default to enabled", () => {
  assert.equal(clientUpdatesEnabled(undefined), true);
  assert.equal(clientUpdatesEnabled("true"), true);
});

test("client update checks can fail closed", async () => {
  const previous = process.env.OPENLEASH_CLIENT_UPDATES_ENABLED;
  process.env.OPENLEASH_CLIENT_UPDATES_ENABLED = "false";
  try {
    const response = await checkForClientUpdate({
      app: "openleash-personal",
      version: "0.36.39",
      platform: "darwin",
      arch: "arm64",
      channel: "stable",
      installMode: "cloud",
      updateSource: "test",
    });
    assert.deepEqual(response, {
      updateAvailable: false,
      latestVersion: "0.36.39",
      currentVersion: "0.36.39",
      channel: "stable",
      platform: "darwin",
      arch: "arm64",
    });
  } finally {
    if (previous === undefined) delete process.env.OPENLEASH_CLIENT_UPDATES_ENABLED;
    else process.env.OPENLEASH_CLIENT_UPDATES_ENABLED = previous;
  }
});

test("recognized false values disable client update checks", () => {
  for (const value of ["0", "false", "FALSE", "off", "OFF"])
    assert.equal(clientUpdatesEnabled(value), false);
});
