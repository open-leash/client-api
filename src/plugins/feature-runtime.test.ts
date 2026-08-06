import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBuiltinFeatureRegistry,
  latestProviderPrompt,
  replaceLatestProviderPrompt,
  verifyBuiltinFeatureRegistry,
} from "./feature-runtime.js";
import { firstPartyPluginManifests } from "./registry.js";

test("every shipped Feature has a reviewed in-process handler", () => {
  assert.doesNotThrow(assertBuiltinFeatureRegistry);
  const results = verifyBuiltinFeatureRegistry(firstPartyPluginManifests.map((feature) => ({
    ...feature,
    settings: { enabled: true, config: feature.defaultConfig ?? {} },
  })));
  assert.ok(results.length > 0);
  assert.ok(results.every((result) => result.healthy && result.protocolVerified));
});

test("provider prompt helpers support OpenAI and Anthropic request shapes", () => {
  const responses = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] }] };
  assert.equal(latestProviderPrompt(responses), "old");
  replaceLatestProviderPrompt(responses, "new");
  assert.equal(latestProviderPrompt(responses), "new");

  const messages = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
  assert.equal(latestProviderPrompt(messages), "hello");
  replaceLatestProviderPrompt(messages, "safe");
  assert.equal(latestProviderPrompt(messages), "safe");
});
