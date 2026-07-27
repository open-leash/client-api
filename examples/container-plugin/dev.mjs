import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] || "check";
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "manifest.json"), "utf8"),
);

validateManifest(manifest);

if (command === "check") {
  checkSource();
  console.log(`✓ ${manifest.id}@${manifest.version} is ready for local development`);
} else if (command === "image") {
  buildImage();
} else if (command === "smoke") {
  checkSource();
  buildImage();
  await smokeTest();
} else {
  throw new Error("Use: node dev.mjs check | image | smoke");
}

function validateManifest(value) {
  requireText(value.id, "id");
  requireText(value.name, "name");
  requireText(value.description, "description");
  requireText(value.version, "version");
  requireText(value.publisher, "publisher");
  if (value.runtime !== "container" || value.entrypoint !== "container") {
    throw new Error("runtime and entrypoint must both be container");
  }
  const execution = value.execution;
  if (!execution || execution.type !== "container") {
    throw new Error("execution.type must be container");
  }
  if (!["edge", "server", "either"].includes(execution.placement)) {
    throw new Error("execution.placement must be edge, server, or either");
  }
  if (execution.protocol !== "openleash-container-plugin.v1") {
    throw new Error("execution.protocol must be openleash-container-plugin.v1");
  }
  requireText(execution.image, "execution.image");
  requirePath(execution.healthPath, "execution.healthPath");
  requirePath(execution.eventPath, "execution.eventPath");
  if (
    execution.digest &&
    !/^sha256:[a-f0-9]{64}$/.test(execution.digest)
  ) {
    throw new Error(
      "execution.digest must be a real sha256 digest; omit it during local development",
    );
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    throw new Error("events must contain at least one subscribed event");
  }
  if (!Array.isArray(value.permissions)) {
    throw new Error("permissions must be an array");
  }
  if (!Array.isArray(value.effects)) {
    throw new Error("effects must be an array");
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
}

function requirePath(value, field) {
  requireText(value, field);
  if (!value.startsWith("/")) throw new Error(`${field} must start with /`);
}

function buildImage() {
  run("docker", ["build", "-t", manifest.execution.image, "."]);
  console.log(`✓ built ${manifest.execution.image}`);
}

function checkSource() {
  run("node", ["--check", "server.mjs"]);
}

async function smokeTest() {
  const secret = crypto.randomBytes(32).toString("hex");
  const containerName = `openleash-plugin-smoke-${process.pid}`;
  try {
    run("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=32m,mode=1777",
      "--tmpfs",
      "/data:rw,noexec,nosuid,size=64m,mode=1777",
      "-p",
      "127.0.0.1::8080",
      "-e",
      `OPENLEASH_PLUGIN_ID=${manifest.id}`,
      "-e",
      `OPENLEASH_PLUGIN_RUNTIME_SECRET=${secret}`,
      manifest.execution.image,
    ]);
    const portOutput = run(
      "docker",
      ["port", containerName, "8080/tcp"],
      true,
    );
    const port = portOutput.trim().match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("Docker did not publish the plugin port");
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(
      `${baseUrl}${manifest.execution.healthPath || "/healthz"}`,
    );

    const requestId = crypto.randomUUID();
    const envelope = {
      protocol: manifest.execution.protocol,
      requestId,
      round: 0,
      plugin: { id: manifest.id, version: manifest.version },
      tenant: { organizationId: "local-dev", userId: "local-dev-user" },
      event: manifest.events[0],
      settings: { profileIds: [], configHash: "local-dev" },
      config: manifest.defaultConfig || {},
      input: {
        event: {
          eventName: manifest.events[0],
          sessionId: "local-dev-session",
          prompt: "Review this local plugin smoke test.",
        },
      },
      capabilityResults: {},
    };
    const first = await sendSigned(baseUrl, envelope, secret);
    if (first.status !== "capability_required") {
      throw new Error(`expected capability_required, received ${first.status}`);
    }
    const conversationCall = first.capabilityRequests?.find(
      (item) => item.capability === "context.conversation.recent",
    );
    if (!conversationCall?.id) {
      throw new Error("plugin did not request conversation context");
    }
    const completed = await sendSigned(
      baseUrl,
      {
        ...envelope,
        round: 1,
        capabilityResults: {
          [conversationCall.id]: {
            ok: true,
            value: {
              sessionId: "local-dev-session",
              turns: [
                { role: "user", content: "First turn" },
                { role: "assistant", content: "Second turn" },
              ],
              truncated: false,
            },
          },
        },
      },
      secret,
    );
    if (completed.status !== "completed") {
      throw new Error(`expected completed, received ${completed.status}`);
    }
    console.log(
      `✓ signed protocol smoke test passed: ${completed.output?.summary || "completed"}`,
    );
  } finally {
    spawnSync("docker", ["rm", "-f", containerName], {
      cwd: root,
      stdio: "ignore",
    });
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("plugin did not become healthy within 30 seconds");
}

async function sendSigned(baseUrl, envelope, secret) {
  const body = JSON.stringify(envelope);
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const response = await fetch(
    `${baseUrl}${manifest.execution.eventPath}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openleash-plugin-protocol": manifest.execution.protocol,
        "x-openleash-plugin-id": manifest.id,
        "x-openleash-plugin-version": manifest.version,
        "x-openleash-timestamp": timestamp,
        "x-openleash-signature": `sha256=${signature}`,
      },
      body,
    },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `plugin returned HTTP ${response.status}`);
  }
  if (
    result.protocol !== manifest.execution.protocol ||
    result.requestId !== envelope.requestId
  ) {
    throw new Error("plugin returned an uncorrelated response");
  }
  return result;
}

function run(binary, args, capture = false) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    throw new Error(
      `Could not run ${binary}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || `${binary} ${args.join(" ")} failed`,
    );
  }
  return result.stdout || "";
}
