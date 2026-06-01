import { createMiddleware } from "hono/factory";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import db from "../db/index.js";
import type { ApiKey } from "../db/index.js";

// Hono env variable types
export type HonoVars = {
  Variables: {
    apiKey: ApiKey;
    adminId: string;
  };
};

const JWT_SECRET = process.env.JWT_SECRET || "inference-studio-dev-secret-change-me";

export function signAdminToken(username: string, id: string): string {
  return jwt.sign({ sub: id, username }, JWT_SECRET, { expiresIn: "24h" });
}

export function verifyAdminToken(token: string): { sub: string; username: string } | null {
  try { return jwt.verify(token, JWT_SECRET) as { sub: string; username: string }; }
  catch { return null; }
}

// Validates API key from Authorization: Bearer <key>
// Sets c.var.apiKey if valid
export const apiKeyAuth = createMiddleware(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!raw) return c.json({ error: "API key required" }, 401);

  const hash = createHash("sha256").update(raw).digest("hex");
  const key  = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hash) as ApiKey | undefined;
  if (!key || !key.active) return c.json({ error: "Invalid or inactive API key" }, 401);

  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);
  c.set("apiKey", key);
  await next();
});

// Admin JWT auth — sets c.var.adminId
export const adminAuth = createMiddleware(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const payload = verifyAdminToken(token);
  if (!payload) return c.json({ error: "Unauthorized" }, 401);
  c.set("adminId", payload.sub);
  await next();
});
