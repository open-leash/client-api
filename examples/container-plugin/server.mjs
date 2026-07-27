import crypto from "node:crypto";
import http from "node:http";
import { Pool } from "pg";

const protocol = "openleash-container-plugin.v1";
const port = Number(process.env.PORT || 8080);
const runtimeSecret = String(process.env.OPENLEASH_PLUGIN_RUNTIME_SECRET || "");
const databaseUrl = String(process.env.DATABASE_URL || "");
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 4,
      application_name: "acme-history-aware"
    })
  : undefined;

if (pool) {
  await pool.query(`
    create table if not exists plugin_events (
      id bigserial primary key,
      request_id text not null unique,
      event_name text not null,
      summary jsonb not null,
      created_at timestamptz not null default now()
    )
  `);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      if (pool) await pool.query("select 1");
      return json(response, 200, { ok: true });
    }

    if (request.method !== "POST") {
      return json(response, 404, { error: "not found" });
    }

    const rawBody = await readBody(request);
    verifyRuntimeRequest(request, rawBody);
    const envelope = JSON.parse(rawBody);
    validateEnvelope(envelope);

    if (request.url === "/v1/events") {
      const capabilityId = "context.conversation.recent:0";
      const capabilityResult = envelope.capabilityResults?.[capabilityId];
      if (!capabilityResult) {
        return json(response, 200, {
          protocol,
          requestId: envelope.requestId,
          status: "capability_required",
          capabilityRequests: [{
            id: capabilityId,
            capability: "context.conversation.recent",
            request: { limit: 20 }
          }]
        });
      }
      const conversation = capabilityResult.ok
        ? capabilityResult.value
        : { turns: [] };
      await rememberEvent(envelope);
      return json(response, 200, {
        protocol,
        requestId: envelope.requestId,
        status: "completed",
        output: {
          status: "passed",
          summary: `Reviewed ${conversation.turns?.length ?? 0} recent conversation turns.`,
          findings: []
        }
      });
    }

    if (request.url === "/v1/transform") {
      return json(response, 200, {
        protocol,
        requestId: envelope.requestId,
        status: "unchanged",
        summary: "Example plugin observed the provider request."
      });
    }

    if (request.url === "/v1/tools/execute") {
      return json(response, 200, {
        protocol,
        requestId: envelope.requestId,
        status: "completed",
        output: { ok: true, tool: envelope.tool }
      });
    }

    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 400, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await pool?.end();
    process.exit(0);
  });
}

async function rememberEvent(envelope) {
  if (!pool) return;
  // This table intentionally has no user_id. A user-dedicated runtime receives
  // credentials for exactly one user's database/schema from the trusted operator.
  await pool.query(
    `insert into plugin_events (request_id, event_name, summary)
     values ($1, $2, $3::jsonb)
     on conflict (request_id) do nothing`,
    [
      envelope.requestId,
      envelope.event,
      JSON.stringify({
        label: envelope.config?.label,
        sessionId: envelope.input?.event?.sessionId
      })
    ]
  );
}

function validateEnvelope(envelope) {
  if (envelope?.protocol !== protocol) throw new Error("unsupported protocol");
  if (!envelope.requestId || typeof envelope.requestId !== "string") {
    throw new Error("requestId is required");
  }
  if (!envelope.plugin?.id || !envelope.plugin?.version) {
    throw new Error("plugin identity is required");
  }
}

function verifyRuntimeRequest(request, rawBody) {
  if (!runtimeSecret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("OPENLEASH_PLUGIN_RUNTIME_SECRET is required");
    }
    return;
  }

  const timestamp = String(request.headers["x-openleash-timestamp"] || "");
  const supplied = String(request.headers["x-openleash-signature"] || "");
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
    throw new Error("expired runtime request");
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", runtimeSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")}`;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !crypto.timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    throw new Error("invalid runtime signature");
  }
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
      throw new Error("request body is too large");
    }
  }
  return body;
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
