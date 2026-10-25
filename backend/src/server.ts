import { env } from "./config/env.js";
import { pgDb, pgliteDb, setDb } from "./config/db.js";
import { createApp } from "./app.js";
import { startJobs } from "./jobs.js";
import { migrate } from "./migrate.js";
import { seedCatalog } from "./seed.js";
import { initPayments } from "./services/payments.js";
import { initPayouts } from "./services/payouts.js";
import { smsConfigured } from "./utils/sms.js";

async function main() {
  // Without DATABASE_URL (local development) an embedded Postgres keeps data in .local/pglite.
  const db = env.databaseUrl ? pgDb(env.databaseUrl) : await pgliteDb(process.env.PGLITE_DIR ?? "../.local/pglite");
  setDb(db);
  await migrate(db, (m) => console.log(`[db] ${m}`));
  await seedCatalog(db, (m) => console.log(`[seed] ${m}`));
  initPayments();
  initPayouts();
  console.log(`[sms] ${smsConfigured() ? "Celcom Africa" : "not configured: messages are written to this log"}`);
  startJobs();

  const server = createApp().listen(env.port, () => {
    console.log(`[mjengo] listening on :${env.port} (${env.nodeEnv}, ${env.databaseUrl ? "postgres" : "pglite"})`);
  });
  const stop = () => {
    console.log("[mjengo] shutting down");
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
