import fs from "node:fs";
import process from "node:process";
import { Pool } from "pg";

type ParsedArgs = Record<string, string | boolean | string[]> & { _: string[] };

const args = parseArgs(process.argv.slice(2));
const name = String(args.name ?? args._[0] ?? "").trim();
const slug = slugify(String(args.slug ?? args._[1] ?? name));
const region = String(args.region ?? "").trim() || null;
const deploymentMode = normalizeDeploymentMode(String(args.deploymentMode ?? args.mode ?? "cloud"));
const setupCompleted = args.setupCompleted !== false;
const currentStep = Number(args.currentStep ?? (setupCompleted ? 6 : 1));

if (!name || !slug) throw new Error("--name and --slug are required");
const pool = new Pool({ connectionString: databaseUrl() });
try {
  const result = await pool.query(
    `insert into organizations (name, slug, region, setup_completed, current_step, deployment_mode, infrastructure_config)
     values ($1, $2, $3, $4, $5, $6, '{}'::jsonb)
     on conflict (slug) do update set
       name = excluded.name,
       region = excluded.region,
       setup_completed = excluded.setup_completed,
       current_step = excluded.current_step,
       deployment_mode = excluded.deployment_mode,
       updated_at = now()
     returning id, name, slug, region, setup_completed, current_step, deployment_mode, created_at, updated_at`,
    [name, slug, region, setupCompleted, currentStep, deploymentMode],
  );
  console.log(JSON.stringify({ ok: true, organization: result.rows[0] }, null, 2));
} finally {
  await pool.end();
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const match = fs.readFileSync(".env", "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    // Use the local development default.
  }
  return "postgres://openleash:openleash@localhost:9543/openleash";
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
    const next = argv[index + 1];
    if (inlineValue !== undefined) parsed[key] = parseValue(inlineValue);
    else if (next && !next.startsWith("--")) {
      parsed[key] = parseValue(next);
      index += 1;
    } else parsed[key] = true;
  }
  return parsed;
}

function parseValue(value: string): string | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function normalizeDeploymentMode(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "private" || normalized === "self-hosted" || normalized === "cloud" ? normalized : "cloud";
}
