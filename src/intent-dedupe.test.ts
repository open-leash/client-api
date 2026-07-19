import assert from "node:assert/strict";
import test from "node:test";
import {
  handledIntentKeysMatch,
  isReusableHandledIntent,
} from "./intent-dedupe.js";

test("credential approval matches hook and proxy copies when proxy lacks project path", () => {
  assert.equal(
    handledIntentKeysMatch(
      "claude-code|/Users/max/Code/MyProj|credential-read|.env",
      "claude-code||credential-read|.env",
    ),
    true,
  );
});

test("credential approval does not cross known projects, resources, or agents", () => {
  const approved = "claude-code|/project-a|credential-read|.env";
  assert.equal(handledIntentKeysMatch(approved, "claude-code|/project-b|credential-read|.env"), false);
  assert.equal(handledIntentKeysMatch(approved, "claude-code|/project-a|credential-read|id_rsa"), false);
  assert.equal(handledIntentKeysMatch(approved, "codex|/project-a|credential-read|.env"), false);
});

test("only explicit prompt approvals are reusable by later pipeline stages", () => {
  assert.equal(isReusableHandledIntent({ eventName: "UserPromptSubmit", decision: "allow" }), false);
  assert.equal(isReusableHandledIntent({ eventName: "UserPromptSubmit", decision: "ask" }), true);
  assert.equal(isReusableHandledIntent({ eventName: "PreToolUse", decision: "allow" }), true);
});
