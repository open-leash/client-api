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
