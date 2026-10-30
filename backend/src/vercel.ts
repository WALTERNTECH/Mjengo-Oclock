import type { IncomingMessage, ServerResponse } from "node:http";
import { attachDatabasePool } from "@vercel/functions";
import { env } from "./config/env.js";
import { pgDb, setDb } from "./config/db.js";
import { createApp } from "./app.js";
import { driveJobsFromRequests } from "./jobs.js";
import { migrate } from "./migrate.js";
import { seedCatalog } from "./seed.js";
import { initPayments } from "./services/payments.js";
import { initPayouts } from "./services/payouts.js";

// The API as one Vercel function (api/index.mjs re-exports this). Vercel serves the built app
// from frontend/dist and sends /api/* and /health here. Each instance connects through
// Supabase's transaction pooler with a small pool, migrates and seeds once on its first
// request, and lets requests start the background jobs (see jobs.ts).

let ready: Promise<void> | null = null;
function init() {
  ready ??= (async () => {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not set");
    const db = pgDb(env.databaseUrl, { max: 3, onPool: attachDatabasePool });
    setDb(db);
    await migrate(db, (m) => console.log(`[db] ${m}`));
    await seedCatalog(db, (m) => console.log(`[seed] ${m}`));
    initPayments();
    initPayouts();
    driveJobsFromRequests();
  })().catch((e) => {
    ready = null; // the next request tries again
    throw e;
  });
  return ready;
}

const app = createApp();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await init();
  } catch (e) {
    console.error("[mjengo] start-up failed", e);
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
    res.end(JSON.stringify({ error: { code: "starting", message: "Mjengo O'clock is starting up. Try again in a few seconds." } }));
    return;
  }
  app(req, res);
}
