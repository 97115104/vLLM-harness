import { Hono } from "hono";
import { createHash, randomBytes } from "crypto";
import { adminAuth, signAdminToken, type HonoVars } from "../middleware/auth.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import db from "../db/index.js";
import type { Admin, ApiKey, Request } from "../db/index.js";

const admin = new Hono<HonoVars>();

// ── Seed root admin on first run ──────────────────────────────────────────────
async function seedRoot() {
  const existing = db.prepare("SELECT id FROM admins WHERE username = ?").get(
    process.env.ADMIN_USERNAME || "admin"
  );
  if (!existing) {
    const hash = await hashPassword(process.env.ADMIN_PASSWORD || "password");
    db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)").run(
      process.env.ADMIN_USERNAME || "admin", hash
    );
  }
}
seedRoot().catch(console.error);

// ── Login ─────────────────────────────────────────────────────────────────────
admin.post("/login", async c => {
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}));
  if (!body.username || !body.password) return c.json({ error: "Invalid credentials" }, 401);

  const row = db.prepare("SELECT * FROM admins WHERE username = ?").get(body.username) as Admin | undefined;
  if (!row) return c.json({ error: "Invalid credentials" }, 401);
  const ok = await verifyPassword(body.password, row.password_hash);
  if (!ok) return c.json({ error: "Invalid credentials" }, 401);

  return c.json({ token: signAdminToken(row.username, row.id) });
});

// ── All routes below need JWT ─────────────────────────────────────────────────
admin.use("/*", adminAuth);

// ── Change password ───────────────────────────────────────────────────────────
admin.post("/password", async c => {
  const id   = c.get("adminId") as string;
  const body = await c.req.json<{ current?: string; new?: string }>().catch(() => ({}));
  if (!body.current || !body.new || body.new.length < 8) {
    return c.json({ error: "current password + new password (8+ chars) required" }, 400);
  }
  const row = db.prepare("SELECT * FROM admins WHERE id = ?").get(id) as Admin | undefined;
  if (!row || !(await verifyPassword(body.current, row.password_hash)))
    return c.json({ error: "Current password is incorrect" }, 401);

  const hash = await hashPassword(body.new);
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hash, id);
  return c.json({ ok: true });
});

// ── API Keys ──────────────────────────────────────────────────────────────────
admin.get("/keys", c => {
  const keys = db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as ApiKey[];
  return c.json({ keys });
});

admin.post("/keys", async c => {
  const body = await c.req.json<{ name?: string; owner_email?: string; scopes?: string[] }>().catch(() => ({}));
  const raw    = "sk-studio-" + randomBytes(24).toString("base64url");
  const hash   = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 20);
  const scopes = JSON.stringify(Array.isArray(body.scopes) ? body.scopes : ["chat"]);

  const row = db.prepare(
    "INSERT INTO api_keys (prefix, key_hash, raw_key, name, owner_email, scopes) VALUES (?,?,?,?,?,?) RETURNING id"
  ).get(prefix, hash, raw, body.name ?? null, body.owner_email ?? null, scopes) as { id: string };

  return c.json({ key: raw, id: row.id, prefix }, 201);
});

admin.patch("/keys/:id", async c => {
  const id   = c.req.param("id");
  const body = await c.req.json<{ active?: boolean; name?: string; scopes?: string[] }>().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (typeof body.active === "boolean") updates.active = body.active ? 1 : 0;
  if (typeof body.name   === "string")  updates.name   = body.name;
  if (Array.isArray(body.scopes))       updates.scopes = JSON.stringify(body.scopes);
  if (!Object.keys(updates).length)     return c.json({ error: "nothing to update" }, 400);

  const set  = Object.keys(updates).map(k => `${k} = ?`).join(", ");
  const vals = [...Object.values(updates), id];
  db.prepare(`UPDATE api_keys SET ${set} WHERE id = ?`).run(...vals);
  return c.json({ ok: true });
});

admin.delete("/keys/:id", c => {
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(c.req.param("id"));
  return c.json({ deleted: true });
});

// ── Requests ──────────────────────────────────────────────────────────────────
admin.get("/requests", c => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const rows  = db.prepare(`
    SELECT r.*, k.prefix AS key_prefix, k.name AS key_name
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.api_key_id
    ORDER BY r.created_at DESC LIMIT ?
  `).all(limit) as (Request & { key_prefix: string | null; key_name: string | null })[];
  return c.json({ requests: rows });
});

// ── Settings ──────────────────────────────────────────────────────────────────
admin.get("/settings", c => {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  rows.forEach(r => { out[r.key] = r.value; });
  return c.json(out);
});

admin.patch("/settings", async c => {
  const body = await c.req.json<Record<string, string>>().catch(() => ({}));
  const allowed = ["tunnel_url"];
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.includes(k)) continue;
    db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(k, v);
  }
  return c.json({ ok: true });
});

export { admin };
