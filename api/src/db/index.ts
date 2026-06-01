import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "studio.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret   TEXT,
    totp_enabled  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    prefix      TEXT NOT NULL,
    key_hash    TEXT NOT NULL,
    raw_key     TEXT,
    name        TEXT,
    owner_email TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    scopes      TEXT NOT NULL DEFAULT '["chat"]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS requests (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    api_key_id       TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    model            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    tokens_in        INTEGER,
    tokens_out       INTEGER,
    latency_ms       INTEGER,
    prompt_preview   TEXT,
    prompt_full      TEXT,
    response_content TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrations — add columns that may not exist in older databases
for (const col of [
  "totp_secret TEXT",
  "totp_enabled INTEGER NOT NULL DEFAULT 0",
]) {
  try { db.exec(`ALTER TABLE admins ADD COLUMN ${col}`); } catch { /* already exists */ }
}
for (const col of [
  "prompt_full TEXT",
  "response_content TEXT",
]) {
  try { db.exec(`ALTER TABLE requests ADD COLUMN ${col}`); } catch { /* already exists */ }
}


export type Admin = {
  id: string; username: string; password_hash: string;
  totp_secret: string | null; totp_enabled: number;
  created_at: string;
};
export type ApiKey = {
  id: string; prefix: string; key_hash: string; raw_key: string | null;
  name: string | null; owner_email: string | null; active: number;
  scopes: string; created_at: string; last_used_at: string | null;
};
export type Request = {
  id: string; api_key_id: string | null; model: string; status: string;
  tokens_in: number | null; tokens_out: number | null; latency_ms: number | null;
  prompt_preview: string | null; prompt_full: string | null;
  response_content: string | null; error: string | null; created_at: string;
};

export default db;
