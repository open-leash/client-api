import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import "dotenv/config";
import { ensureDevToken, pool } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appMigrationsPath = path.resolve(here, "../infra/postgres/migrations");
const repoMigrationsPath = path.resolve(here, "../../../infra/postgres/migrations");
const appSchemaPath = path.resolve(here, "../infra/postgres/schema.sql");
const repoSchemaPath = path.resolve(here, "../../../infra/postgres/schema.sql");

const args = new Set(process.argv.slice(2));
const shouldApply = args.has("--apply") || process.env.OPENLEASH_MIGRATION_APPLY === "1";
const shouldList = args.has("--list");
const shouldStatus = args.has("--status") || args.has("--pending");
const shouldBackup = args.has("--backup") || process.env.OPENLEASH_MIGRATION_BACKUP === "1";
const backupDir = process.env.OPENLEASH_MIGRATION_BACKUP_DIR
  ?? path.resolve(here, "../../../backups/postgres");

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openleash:openleash@localhost:9543/openleash";

try {
  if (args.has("--help") || args.has("-h")) {
    printUsage();
    process.exit(0);
  }

  if (shouldBackup) {
    await backupPostgres(databaseUrl, backupDir);
    if (!shouldApply && !shouldList && !shouldStatus) {
      console.log("[db:migrate] backup complete; no migrations applied.");
      process.exit(0);
    }
  }

  const migrations = await loadMigrations();
  if (shouldList || shouldStatus) {
    await printMigrationStatus(migrations);
  } else if (!shouldApply) {
    console.error(
      "[db:migrate] refusing to mutate the database without --apply. " +
      "Use --status to inspect pending migrations or --apply to run them."
    );
    process.exitCode = 2;
  } else {
    await withMigrationLock(async () => {
      await ensureMigrationLedger();
    if (migrations.length === 0) {
      await applyLegacySchemaFallback();
    } else {
      for (const migration of migrations) {
        await applyMigration(migration);
      }
    }
    await removeLegacyMockIdentityRows();
    await ensureDevToken();
    });
  }

  if (shouldApply) console.log("OpenLeash database schema is ready.");
} finally {
  await pool.end();
}

type Migration = {
  id: string;
  path: string;
  sql: string;
  checksum: string;
};

async function loadMigrations(): Promise<Migration[]> {
  const migrationsPath = await existingPath(appMigrationsPath, repoMigrationsPath);
  if (!migrationsPath) return [];
  const files = (await fs.readdir(migrationsPath))
    .filter((file) => /^\d+.*\.sql$/i.test(file))
    .sort((left, right) => left.localeCompare(right));

  const migrations: Migration[] = [];
  for (const file of files) {
    const fullPath = path.join(migrationsPath, file);
    const sql = await fs.readFile(fullPath, "utf8");
    migrations.push({
      id: file.replace(/\.sql$/i, ""),
      path: fullPath,
      sql,
      checksum: crypto.createHash("sha256").update(sql).digest("hex")
    });
  }
  return migrations;
}

async function ensureMigrationLedger() {
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function applyMigration(migration: Migration) {
  const existing = await pool.query<{ checksum: string }>(
    "select checksum from schema_migrations where id = $1",
    [migration.id]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.id} checksum changed after it was applied. ` +
        "Create a new migration instead of editing applied migrations."
      );
    }
    console.log(`[db:migrate] ${migration.id} already applied`);
    return;
  }

  console.log(`[db:migrate] applying ${migration.id}`);
  await pool.query("begin");
  try {
    await pool.query(migration.sql);
    await pool.query(
      "insert into schema_migrations (id, checksum) values ($1, $2)",
      [migration.id, migration.checksum]
    );
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }
}

async function printMigrationStatus(migrations: Migration[]) {
  const applied = await readMigrationLedger();
  const appliedById = new Map(applied.map((row) => [row.id, row]));
  console.log(`Database: ${redactDatabaseUrl(databaseUrl)}`);
  console.log(`Migrations: ${migrations.length}`);
  for (const migration of migrations) {
    const row = appliedById.get(migration.id);
    if (!row) {
      console.log(`pending  ${migration.id}  ${path.basename(migration.path)}`);
    } else if (row.checksum !== migration.checksum) {
      console.log(`changed  ${migration.id}  applied=${row.applied_at.toISOString()}`);
    } else {
      console.log(`applied  ${migration.id}  ${row.applied_at.toISOString()}`);
    }
  }
  const known = new Set(migrations.map((migration) => migration.id));
  for (const row of applied) {
    if (!known.has(row.id)) console.log(`orphan   ${row.id}  ${row.applied_at.toISOString()}`);
  }
}

async function readMigrationLedger() {
  const exists = await pool.query<{ exists: boolean }>("select to_regclass('schema_migrations') is not null as exists");
  if (!exists.rows[0]?.exists) return [] as { id: string; checksum: string; applied_at: Date }[];
  const applied = await pool.query<{ id: string; checksum: string; applied_at: Date }>(
    "select id, checksum, applied_at from schema_migrations order by id asc"
  );
  return applied.rows;
}

function redactDatabaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:\s]+):([^@\s]+)@/, "://$1:****@");
  }
}

function printUsage() {
  console.log(`OpenLeash database migrations

Usage:
  DATABASE_URL=postgres://... npm run db:migrate -w @openleash/client-api -- --status
  DATABASE_URL=postgres://... npm run db:migrate -w @openleash/client-api -- --backup
  DATABASE_URL=postgres://... npm run db:migrate -w @openleash/client-api -- --apply
  DATABASE_URL=postgres://... npm run db:migrate -w @openleash/client-api -- --backup --apply

Options:
  --status   Show applied, pending, changed, and orphan migrations.
  --list     Alias of --status.
  --backup   Write a schema-only pg_dump before doing anything else.
  --apply    Apply pending migrations. Required for database mutations.
`);
}

async function applyLegacySchemaFallback() {
  const schemaPath = await existingPath(appSchemaPath, repoSchemaPath);
  if (!schemaPath) throw new Error("No Postgres schema or migration directory was found.");
  console.log("[db:migrate] no migration files found; applying legacy schema.sql fallback");
  const sql = await fs.readFile(schemaPath, "utf8");
  await pool.query(sql);
}

async function withMigrationLock(fn: () => Promise<void>) {
  const lockId = 873177295;
  await pool.query("select pg_advisory_lock($1)", [lockId]);
  try {
    await fn();
  } finally {
    await pool.query("select pg_advisory_unlock($1)", [lockId]);
  }
}

async function existingPath(...candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next packaged/repo path.
    }
  }
  return undefined;
}

async function backupPostgres(connectionString: string, outputDir: string) {
  const pgDump = process.env.PG_DUMP || "pg_dump";
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `openleash-${stamp}.schema.sql`);
  await fs.mkdir(outputDir, { recursive: true });
  await run(pgDump, [
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--file",
    outputPath,
    connectionString
  ]);
  console.log(`[db:migrate] backup wrote ${outputPath}`);
}

function run(command: string, commandArgs: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: process.env
    });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`${command} was not found. Install PostgreSQL client tools or set PG_DUMP=/path/to/pg_dump.`));
      } else {
        reject(error);
      }
    });
  });
}

async function removeLegacyMockIdentityRows() {
  await pool.query(`
    delete from identity_group_members
    where user_id in (
      select id from users
      where email ilike '%@northwind.example'
         or idp_user_id in ('usr-max', 'usr-margaret', 'usr-jenny', 'usr-floyd', 'usr-kristin', 'usr-robert')
    )
       or group_id in (
      select id from identity_groups
      where idp_group_id in ('grp-security', 'grp-platform', 'grp-product', 'grp-contractors')
    )
  `);
  await pool.query(`
    delete from role_assignments
    where user_id in (
      select id from users
      where email ilike '%@northwind.example'
         or idp_user_id in ('usr-max', 'usr-margaret', 'usr-jenny', 'usr-floyd', 'usr-kristin', 'usr-robert')
    )
       or group_id in (
      select id from identity_groups
      where idp_group_id in ('grp-security', 'grp-platform', 'grp-product', 'grp-contractors')
    )
  `);
  await pool.query(`
    delete from users
    where email ilike '%@northwind.example'
       or idp_user_id in ('usr-max', 'usr-margaret', 'usr-jenny', 'usr-floyd', 'usr-kristin', 'usr-robert')
  `);
  await pool.query(`
    delete from identity_groups
    where idp_group_id in ('grp-security', 'grp-platform', 'grp-contractors')
  `);
  await pool.query(`
    update idp_connections
    set user_count = coalesce(real_users.count, 0),
        group_count = coalesce(real_groups.count, 0),
        last_sync_at = case
          when coalesce(real_users.count, 0) = 0 and coalesce(real_groups.count, 0) = 0 then null
          else last_sync_at
        end,
        last_error = case
          when coalesce(real_users.count, 0) = 0 and coalesce(real_groups.count, 0) = 0 then 'Identity sync has not run with a real provider yet.'
          else last_error
        end,
        updated_at = now()
    from (
      select c.organization_id, count(u.id)::int as count
      from idp_connections c
      left join users u on u.organization_id = c.organization_id and u.idp_provider = c.provider
      group by c.organization_id
    ) real_users,
    (
      select c.organization_id, count(g.id)::int as count
      from idp_connections c
      left join identity_groups g on g.organization_id = c.organization_id and g.idp_provider = c.provider
      group by c.organization_id
    ) real_groups
    where idp_connections.organization_id = real_users.organization_id
      and idp_connections.organization_id = real_groups.organization_id
  `);
  await pool.query(`
    delete from idp_connections
    where user_count = 0
      and group_count = 0
      and last_sync_at is null
      and (
        config = '{}'::jsonb
        or not exists (
          select 1
          from jsonb_each_text(config) as credential(key, value)
          where btrim(coalesce(credential.value, '')) <> ''
        )
      )
  `);
}
