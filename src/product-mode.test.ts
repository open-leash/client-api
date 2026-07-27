import assert from "node:assert/strict";
import test from "node:test";
import {
  isOrganizationManagedAccount,
  openLeashProductModeFromEnv,
  pluginExecutionAvailable,
  pluginImageDigestRequired,
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

test("only private file plugins in Individual Open Source may omit an image digest", () => {
  const individual = openLeashProductModeFromEnv({
    OPENLEASH_PRODUCT_MODE: "individual-open-source",
  });
  const privateCloud = openLeashProductModeFromEnv({
    OPENLEASH_PRODUCT_MODE: "private-cloud",
  });
  const localPlugin = {
    publisher: "acme",
    source: "private",
    packageUrl: "file:/Users/developer/history-aware",
  };

  assert.equal(pluginImageDigestRequired(individual, localPlugin), false);
  assert.equal(pluginImageDigestRequired(privateCloud, localPlugin), true);
  assert.equal(
    pluginImageDigestRequired(individual, {
      ...localPlugin,
      source: "community",
    }),
    true,
  );
  assert.equal(
    pluginImageDigestRequired(individual, {
      ...localPlugin,
      packageUrl: "npm:@acme/history-aware",
    }),
    true,
  );
});
