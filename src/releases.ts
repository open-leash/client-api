import type { Request } from "express";
import { Pool } from "pg";
import { z } from "zod";

export type ClientUpdateRequest = {
  app: string;
  version: string;
  platform: string;
  arch: string;
  channel: string;
  installMode: string;
  updateSource: string;
};

export type ClientUpdateResponse = {
  updateAvailable: boolean;
  latestVersion: string;
  currentVersion: string;
  channel: string;
  platform: string;
  arch: string;
  downloadUrl?: string;
  dmgUrl?: string;
  sha256?: string;
  sizeBytes?: number;
  notesUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
  minSupportedVersion?: string;
  rollout?: {
    eligible: boolean;
    percent: number;
  };
};

export const updateRequestSchema = z.object({
  app: z.string().default("openleash-personal"),
  version: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  channel: z.string().default("stable"),
  installMode: z.string().default("personal"),
  updateSource: z.string().default("public")
});

type ReleaseRow = {
  version: string;
  channel: string;
  platform: string;
  arch: string;
  dmg_url: string;
  sha256: string | null;
  size_bytes: number | null;
  notes_url: string | null;
  release_notes: string | null;
  min_supported_version: string | null;
  rollout_percent: number;
  published_at: string;
};

let pool: Pool | undefined;
let migrated = false;
let migrationPromise: Promise<void> | undefined;

export function releaseDb() {
  const connectionString = process.env.OPENLEASH_RELEASE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  pool ??= new Pool({ connectionString });
  return pool;
}

export async function ensureReleaseSchema() {
  const database = releaseDb();
  if (!database || migrated) return;
  if (migrationPromise) return migrationPromise;
  migrationPromise = migrateSchema(database).finally(() => {
    migrationPromise = undefined;
  });
  return migrationPromise;
}

async function migrateSchema(database: Pool) {
  await database.query(`create extension if not exists pgcrypto`);
  await database.query(`
    create table if not exists client_releases (
      id uuid primary key default gen_random_uuid(),
      app text not null default 'openleash-personal',
      version text not null,
      channel text not null default 'stable',
      platform text not null,
      arch text not null,
      dmg_url text not null,
      sha256 text,
      size_bytes bigint,
      notes_url text,
      release_notes text,
      min_supported_version text,
      rollout_percent integer not null default 100 check (rollout_percent >= 0 and rollout_percent <= 100),
      active boolean not null default true,
      published_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(app, version, channel, platform, arch)
    )
  `);
  await database.query(`
    create table if not exists client_update_checks (
      id uuid primary key default gen_random_uuid(),
      app text not null,
      current_version text not null,
      latest_version text,
      platform text not null,
      arch text not null,
      channel text not null,
      install_mode text not null,
      update_source text not null,
      update_available boolean not null default false,
      checked_at timestamptz not null default now()
    )
  `);
  migrated = true;
}

export async function checkForClientUpdate(request: ClientUpdateRequest): Promise<ClientUpdateResponse> {
  await ensureReleaseSchema();
  const release = await latestRelease(request);
  const currentVersion = request.version;
  const latestVersion = release?.version ?? currentVersion;
  const updateAvailable = release ? compareVersions(release.version, currentVersion) > 0 : false;
  await recordCheck(request, release, updateAvailable);
  return {
    updateAvailable,
    latestVersion,
    currentVersion,
    channel: request.channel,
    platform: request.platform,
    arch: request.arch,
    ...(release ? {
      downloadUrl: release.dmg_url,
      dmgUrl: release.dmg_url,
      sha256: release.sha256 ?? undefined,
      sizeBytes: release.size_bytes ? Number(release.size_bytes) : undefined,
      notesUrl: release.notes_url ?? undefined,
      releaseNotes: release.release_notes ?? undefined,
      publishedAt: release.published_at,
      minSupportedVersion: release.min_supported_version ?? undefined,
      rollout: {
        eligible: release.rollout_percent > 0,
        percent: release.rollout_percent
      }
    } : {})
  };
}

async function latestRelease(request: ClientUpdateRequest) {
  const database = releaseDb();
  if (!database) return envRelease(request);
  const result = await database.query<ReleaseRow>(
    `select version, channel, platform, arch, dmg_url, sha256, size_bytes, notes_url, release_notes,
            min_supported_version, rollout_percent, published_at::text
       from client_releases
      where app = $1
        and channel = $2
        and platform = $3
        and arch = $4
        and active = true
      order by published_at desc, created_at desc
      limit 1`,
    [request.app, request.channel, request.platform, request.arch]
  );
  return result.rows[0] ?? envRelease(request);
}

function envRelease(request: ClientUpdateRequest): ReleaseRow | undefined {
  const version = process.env.OPENLEASH_LATEST_VERSION;
  const dmgUrl = process.env.OPENLEASH_LATEST_DMG_URL;
  if (!version || !dmgUrl) return undefined;
  return {
    version,
    channel: request.channel,
    platform: request.platform,
    arch: request.arch,
    dmg_url: dmgUrl,
    sha256: process.env.OPENLEASH_LATEST_SHA256 ?? null,
    size_bytes: process.env.OPENLEASH_LATEST_SIZE_BYTES ? Number(process.env.OPENLEASH_LATEST_SIZE_BYTES) : null,
    notes_url: process.env.OPENLEASH_LATEST_NOTES_URL ?? null,
    release_notes: process.env.OPENLEASH_LATEST_NOTES ?? null,
    min_supported_version: process.env.OPENLEASH_MIN_SUPPORTED_VERSION ?? null,
    rollout_percent: Number(process.env.OPENLEASH_ROLLOUT_PERCENT ?? 100),
    published_at: new Date().toISOString()
  };
}

async function recordCheck(request: ClientUpdateRequest, release: ReleaseRow | undefined, updateAvailable: boolean) {
  const database = releaseDb();
  if (!database) return;
  await database.query(
    `insert into client_update_checks
      (app, current_version, latest_version, platform, arch, channel, install_mode, update_source, update_available)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [request.app, request.version, release?.version ?? null, request.platform, request.arch, request.channel, request.installMode, request.updateSource, updateAvailable]
  );
}

export async function upsertRelease(input: unknown) {
  const adminToken = process.env.OPENLEASH_RELEASE_ADMIN_TOKEN;
  if (!adminToken) throw new Error("OPENLEASH_RELEASE_ADMIN_TOKEN is not configured.");
  const body = releaseSchema.parse(input);
  await ensureReleaseSchema();
  const database = releaseDb();
  if (!database) throw new Error("OPENLEASH_RELEASE_DATABASE_URL or DATABASE_URL is required.");
  await database.query(
    `insert into client_releases
      (app, version, channel, platform, arch, dmg_url, sha256, size_bytes, notes_url, release_notes, min_supported_version, rollout_percent, active, published_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, coalesce($14::timestamptz, now()), now())
     on conflict(app, version, channel, platform, arch) do update set
       dmg_url = excluded.dmg_url,
       sha256 = excluded.sha256,
       size_bytes = excluded.size_bytes,
       notes_url = excluded.notes_url,
       release_notes = excluded.release_notes,
       min_supported_version = excluded.min_supported_version,
       rollout_percent = excluded.rollout_percent,
       active = excluded.active,
       published_at = excluded.published_at,
       updated_at = now()`,
    [
      body.app,
      body.version,
      body.channel,
      body.platform,
      body.arch,
      body.dmgUrl,
      body.sha256 ?? null,
      body.sizeBytes ?? null,
      body.notesUrl ?? null,
      body.releaseNotes ?? null,
      body.minSupportedVersion ?? null,
      body.rolloutPercent,
      body.active,
      body.publishedAt ?? null
    ]
  );
  return body;
}

const releaseSchema = z.object({
  app: z.string().default("openleash-personal"),
  version: z.string().min(1),
  channel: z.string().default("stable"),
  platform: z.string().default("darwin"),
  arch: z.string().default("arm64"),
  dmgUrl: z.string().url(),
  sha256: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
  notesUrl: z.string().url().optional(),
  releaseNotes: z.string().optional(),
  minSupportedVersion: z.string().optional(),
  rolloutPercent: z.number().int().min(0).max(100).default(100),
  active: z.boolean().default(true),
  publishedAt: z.string().optional()
});

export function assertReleaseAdmin(request: Request) {
  const expected = process.env.OPENLEASH_RELEASE_ADMIN_TOKEN;
  if (!expected) throw new Error("OPENLEASH_RELEASE_ADMIN_TOKEN is not configured.");
  const actual = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  return actual === expected;
}

export function compareVersions(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function versionParts(value: string) {
  return value
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}
