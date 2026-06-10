import crypto from "node:crypto";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://openleash:openleash@localhost:9543/openleash"
});

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function getUserByToken(token: string) {
  const tokenHash = hashToken(token);
  const result = await pool.query(
    "select id, email, display_name, organization_id from users where token_hash = $1 limit 1",
    [tokenHash]
  );
  if (result.rows[0]) {
    return result.rows[0] as { id: string; email: string; display_name: string; organization_id?: string | null };
  }

  const session = await pool.query(
    `update dashboard_sessions ds
     set last_seen_at = now()
     from users u
     where ds.user_id = u.id
       and ds.token_hash = $1
       and ds.revoked_at is null
       and ds.expires_at > now()
     returning u.id, u.email, u.display_name, u.organization_id`,
    [hashToken(token)]
  );
  return session.rows[0] as
    | { id: string; email: string; display_name: string; organization_id?: string | null }
    | undefined;
}

export async function ensureDevToken() {
  const token = process.env.OPENLEASH_DEV_TOKEN;
  if (!token) return;
  const user = await pool.query<{ id: string }>(
    `insert into users (email, display_name, role, token_hash)
     values ('max.brin@openleash.local', 'Max Brin', 'owner', $1)
     on conflict (email) do update set display_name = excluded.display_name, role = excluded.role, token_hash = excluded.token_hash
     returning id`,
    [hashToken(token)]
  );
  const maxUserId = user.rows[0].id;
  const legacy = await pool.query<{ id: string }>("select id from users where email = 'dev@openleash.local' limit 1");
  const legacyUserId = legacy.rows[0]?.id;
  if (legacyUserId && legacyUserId !== maxUserId) {
    await pool.query("update conversation_events set user_id = $1 where user_id = $2", [maxUserId, legacyUserId]);
    await pool.query("update evaluations set user_id = $1 where user_id = $2", [maxUserId, legacyUserId]);
    await pool.query(
      `update computers c
       set user_id = $1
       where c.user_id = $2
         and not exists (
           select 1 from computers existing
           where existing.user_id = $1 and existing.hostname = c.hostname
         )`,
      [maxUserId, legacyUserId]
    );
    await pool.query("update computers set user_id = null where user_id = $1", [legacyUserId]);
    await pool.query("delete from users where id = $1", [legacyUserId]);
  }
}
