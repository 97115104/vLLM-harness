import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { HonoVars } from "./middleware/auth.js";
import { health } from "./routes/health.js";
import { setup }  from "./routes/setup.js";
import { chat }   from "./routes/chat.js";
import { admin }  from "./routes/admin.js";

const app = new Hono<HonoVars>();

app.use("*", cors({
  origin: "*",
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
}));
app.use("*", logger());

app.route("/health", health);
app.route("/setup",  setup);
app.route("/v1",     chat);
app.route("/admin",  admin);

app.notFound(c => c.json({ error: "not found" }, 404));

const port = Number(process.env.PORT ?? 3001);
console.log(`[inference-studio] API listening on http://0.0.0.0:${port}`);
serve({ fetch: app.fetch, port });
