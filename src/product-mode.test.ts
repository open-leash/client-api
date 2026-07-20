import assert from "node:assert/strict";
import test from "node:test";
import {
  isOrganizationManagedAccount,
  openLeashProductModeFromEnv,
  pluginExecutionAvailable,
} from "./product-mode.js";

test("individual open source is user-managed and cannot run cloud-only plugins", () => {
  const mode = openLeashProductModeFromEnv({ OPENLEASH_PRODUCT_MODE: "individual-open-source" });
  assert.equal(isOrganizationManagedAccount(mode, "individual"), false);
  assert.equal(pluginExecutionAvailable(mode, "any"), true);
  assert.equal(pluginExecutionAvailable(mode, "cloud-only"), false);
});

test("personal OpenLeash Cloud is user-managed and supports cloud-only plugins", () => {
  const mode = openLeashProductModeFromEnv({ OPENLEASH_PRODUCT_MODE: "openleash-cloud" });
  assert.equal(isOrganizationManagedAccount(mode, "individual"), false);
  assert.equal(pluginExecutionAvailable(mode, "cloud-only"), true);
});

test("organization Cloud and Private Cloud clients are organization-managed", () => {
  const cloud = openLeashProductModeFromEnv({ OPENLEASH_PRODUCT_MODE: "openleash-cloud" });
  const privateCloud = openLeashProductModeFromEnv({ OPENLEASH_PRODUCT_MODE: "private-cloud" });
  assert.equal(isOrganizationManagedAccount(cloud, "organization"), true);
  assert.equal(isOrganizationManagedAccount(privateCloud, "individual"), true);
  assert.equal(pluginExecutionAvailable(privateCloud, "cloud-only"), false);
});
