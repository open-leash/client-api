import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenLeashPluginManifest, PluginMarketplaceListing } from "@openleash/shared";
import { pool } from "./db.js";

type PluginImport = {
  manifest: OpenLeashPluginManifest;
  root: string;
  packageName?: string;
  readme?: string;
};

const args = parseArgs(process.argv.slice(2));
const pluginsDir = path.resolve(String(args.dir ?? args.pluginsDir ?? path.join(process.cwd(), "..", "..", "plugin-repos", "plugins", "plugins")));
const reviewStatus = String(args.reviewStatus ?? "approved") as PluginMarketplaceListing["reviewStatus"];
const sourceOverride = args.source ? String(args.source) as PluginMarketplaceListing["source"] : undefined;
const dryRun = Boolean(args.dryRun);

try {
  const imports = await discoverPlugins(pluginsDir);
  if (imports.length === 0) {
    console.log(`[db:load-plugins] no plugin manifests found in ${pluginsDir}`);
    process.exit(0);
  }

  const listings = imports.map((item, index) => toMarketplaceListing(item, index));
  if (dryRun) {
    console.log(JSON.stringify({ pluginsDir, count: listings.length, listings }, null, 2));
    process.exit(0);
  }

  for (const listing of listings) await upsertListing(listing);
  console.log(`[db:load-plugins] loaded ${listings.length} plugins from ${pluginsDir}`);
} finally {
  await pool.end();
}

async function discoverPlugins(dir: string): Promise<PluginImport[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const imports: PluginImport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = path.join(dir, entry.name);
    const manifestPath = path.join(root, "src", "manifest.ts");
    if (!await exists(manifestPath)) continue;
    const imported = await import(pathToFileURL(manifestPath).href) as { manifest?: OpenLeashPluginManifest };
    if (!imported.manifest?.id) continue;
    imports.push({
      manifest: imported.manifest,
      root,
      packageName: await readPackageName(root),
      readme: await readOptional(path.join(root, "README.md"))
    });
  }
  return imports.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

function toMarketplaceListing(item: PluginImport, index: number): PluginMarketplaceListing {
  const manifest = item.manifest;
  const slug = slugForPlugin(manifest, item);
  const readmeDescription = descriptionFromReadme(item.readme);
  const stats = fakeStats(manifest.id, index);
  const source = sourceOverride ?? (manifest.publisher === "openleash" ? "first_party" : "community");
  const developerName = manifest.publisher === "openleash" ? "OpenLeash" : titleize(manifest.publisher);
  const shortDescription = sentence(manifest.description);
  const longDescription = readmeDescription || manifest.description;
  return {
    ...manifest,
    slug,
    developerName,
    developerUrl: manifest.publisher === "openleash" ? "https://openleash.com" : undefined,
    source,
    reviewStatus,
    shortDescription,
    longDescription,
    heroTagline: shortDescription,
    packageUrl: item.packageName ? `npm:${item.packageName}` : `openleash:plugin/${slug}`,
    repositoryUrl: "https://github.com/open-leash/openleash",
    documentationUrl: `https://docs.openleash.com/plugins/${slug}`,
    iconText: iconText(slug, manifest.name),
    installCount: stats.installs,
    downloadCount: stats.downloads,
    weeklyDownloadCount: stats.weekly,
    trendPercent: stats.trend,
    rating: stats.rating,
    featuredRank: index + 1,
    seoTitle: `${slug} Plugin for OpenLeash`,
    seoDescription: `Install ${slug} for OpenLeash. ${shortDescription}`
  };
}

async function upsertListing(plugin: PluginMarketplaceListing) {
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

function slugForPlugin(manifest: OpenLeashPluginManifest, item: PluginImport) {
  const explicit = manifest.slug;
  if (explicit) return slugify(explicit);
  const npmName = item.packageName?.split("/").pop()?.replace(/^plugin-/, "");
  const folderName = path.basename(item.root);
  const base = npmName || folderName || manifest.name || manifest.id;
  if (manifest.id === "openleash.security-evaluator") return "sec-evaluator";
  if (manifest.id === "openleash.prompt-compression") return "token-saver";
  return slugify(base);
}

function fakeStats(id: string, index: number) {
  const seed = [...id].reduce((total, char) => total + char.charCodeAt(0), 0);
  const installs = 7400 + ((seed * 97) % 16000) + index * 230;
  const downloads = installs + 9200 + ((seed * 53) % 22000);
  const weekly = 520 + ((seed * 31) % 2600);
  const trend = 4 + ((seed * 17) % 23);
  const rating = Math.round((4.4 + ((seed % 6) / 10)) * 10) / 10;
  return { installs, downloads, weekly, trend, rating: Math.min(rating, 4.9) };
}

function descriptionFromReadme(readme?: string) {
  if (!readme) return undefined;
  const paragraphs = readme
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph
      .replace(/^#.*$/gm, "")
      .replace(/^- .*/gm, "")
      .replace(/\bFirst-party OpenLeash plugin\b/gi, "OpenLeash plugin")
      .replace(/\bfirst-party OpenLeash plugin\b/gi, "OpenLeash plugin")
      .replace(/\s+/g, " ")
      .trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith("See [") && !/^This plugin ships preinstalled/i.test(paragraph));
  return paragraphs.slice(0, 2).join(" ");
}

function sentence(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
}

function iconText(slug: string, name: string) {
  const words = slug.split("-").filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "OL";
}

function titleize(value: string) {
  return value.replace(/^@/, "").split(/[./_-]+/).filter(Boolean).map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

function slugify(value: string) {
  return value.toLowerCase().replace(/^@[^/]+\//, "").replace(/^plugin-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function readPackageName(root: string) {
  const raw = await readOptional(path.join(root, "package.json"));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name;
  } catch {
    return undefined;
  }
}

async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]) {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
    const next = argv[index + 1];
    if (inlineValue !== undefined) parsed[key] = inlineValue;
    else if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}
