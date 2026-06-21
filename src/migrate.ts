import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import "dotenv/config";
import { FIRST_PARTY_PLUGIN_MARKETPLACE } from "@openleash/shared";
import { ensureDevToken, pool } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appMigrationsPath = path.resolve(here, "../infra/postgres/migrations");
const repoMigrationsPath = path.resolve(here, "../../../infra/postgres/migrations");
const appSchemaPath = path.resolve(here, "../infra/postgres/schema.sql");
const repoSchemaPath = path.resolve(here, "../../../infra/postgres/schema.sql");

const args = new Set(process.argv.slice(2));
const shouldBackup = args.has("--backup") || process.env.OPENLEASH_MIGRATION_BACKUP === "1";
const backupDir = process.env.OPENLEASH_MIGRATION_BACKUP_DIR
  ?? path.resolve(here, "../../../backups/postgres");

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openleash:openleash@localhost:9543/openleash";

try {
  if (shouldBackup) {
    await backupPostgres(databaseUrl, backupDir);
  }

  await withMigrationLock(async () => {
    await ensureMigrationLedger();
    const migrations = await loadMigrations();
    if (migrations.length === 0) {
      await applyLegacySchemaFallback();
    } else {
      for (const migration of migrations) {
        await applyMigration(migration);
      }
    }
    await seedFirstPartyMarketplacePlugins();
    await removeLegacyMockIdentityRows();
    await ensureDevToken();
  });

  console.log("OpenLeash database schema is ready.");
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

async function seedFirstPartyMarketplacePlugins() {
  for (const plugin of FIRST_PARTY_PLUGIN_MARKETPLACE) {
    await pool.query(
      `insert into plugin_marketplace (
         plugin_id, slug, name, description, version, publisher, developer_name, developer_url,
         source, review_status, short_description, long_description, hero_tagline, package_url,
         repository_url, documentation_url, runtime, entrypoint, events, permissions, effects,
         ordering, config_schema, default_config, tags, icon_text, install_count,
         download_count, weekly_download_count, trend_percent, rating,
         featured_rank, seo_title, seo_description, updated_at
       )
       values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb,
         $22::jsonb, $23::jsonb, $24::jsonb, $25::jsonb, $26, $27,
         $28, $29, $30, $31,
         $32, $33, $34, now()
       )
       on conflict (plugin_id) do update set
         slug = excluded.slug,
         name = excluded.name,
         description = excluded.description,
         version = excluded.version,
         publisher = excluded.publisher,
         developer_name = excluded.developer_name,
         developer_url = excluded.developer_url,
         source = excluded.source,
         review_status = excluded.review_status,
         short_description = excluded.short_description,
         long_description = excluded.long_description,
         hero_tagline = excluded.hero_tagline,
         package_url = excluded.package_url,
         repository_url = excluded.repository_url,
         documentation_url = excluded.documentation_url,
         runtime = excluded.runtime,
         entrypoint = excluded.entrypoint,
         events = excluded.events,
         permissions = excluded.permissions,
         effects = excluded.effects,
         ordering = excluded.ordering,
         config_schema = excluded.config_schema,
         default_config = excluded.default_config,
         tags = excluded.tags,
         icon_text = excluded.icon_text,
         install_count = excluded.install_count,
         download_count = excluded.download_count,
         weekly_download_count = excluded.weekly_download_count,
         trend_percent = excluded.trend_percent,
         rating = excluded.rating,
         featured_rank = excluded.featured_rank,
         seo_title = excluded.seo_title,
         seo_description = excluded.seo_description,
         updated_at = now()`,
      [
        plugin.id,
        plugin.slug,
        plugin.name,
        plugin.description,
        plugin.version,
        plugin.publisher,
        plugin.developerName,
        plugin.developerUrl ?? null,
        plugin.source,
        plugin.reviewStatus,
        plugin.shortDescription,
        plugin.longDescription,
        plugin.heroTagline,
        plugin.packageUrl ?? null,
        plugin.repositoryUrl ?? null,
        plugin.documentationUrl ?? null,
        plugin.runtime,
        plugin.entrypoint,
        JSON.stringify(plugin.events),
        JSON.stringify(plugin.permissions),
        JSON.stringify(plugin.effects),
        JSON.stringify(plugin.ordering ?? null),
        JSON.stringify(plugin.configSchema ?? null),
        JSON.stringify(plugin.defaultConfig ?? {}),
        JSON.stringify(plugin.tags ?? []),
        plugin.iconText,
        plugin.installCount,
        plugin.downloadCount,
        plugin.weeklyDownloadCount,
        plugin.trendPercent,
        plugin.rating,
        plugin.featuredRank ?? null,
        plugin.seoTitle,
        plugin.seoDescription
      ]
    );
  }
  console.log(`[db:migrate] seeded ${FIRST_PARTY_PLUGIN_MARKETPLACE.length} first-party marketplace plugins`);
}

function run(command: string, commandArgs: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: process.env
    });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    child.on("error", reject);
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
