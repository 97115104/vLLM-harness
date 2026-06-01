import { Hono } from "hono";

const health = new Hono();

health.get("/", c => c.json({ ok: true, service: "inference-studio-api", ts: new Date().toISOString() }));

export { health };
