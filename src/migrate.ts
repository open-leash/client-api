import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { ensureDevToken, pool } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSchemaPath = path.resolve(here, "../infra/postgres/schema.sql");
const repoSchemaPath = path.resolve(here, "../../../infra/postgres/schema.sql");

const schemaPath = await fileExists(appSchemaPath) ? appSchemaPath : repoSchemaPath;
const sql = await fs.readFile(schemaPath, "utf8");
await pool.query(sql);
await removeLegacyMockIdentityRows();
await ensureDevToken();
await pool.end();
console.log("OpenLeash database schema is ready.");

async function fileExists(candidate: string) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
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
    where idp_group_id in ('grp-security', 'grp-platform', 'grp-product', 'grp-contractors')
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
