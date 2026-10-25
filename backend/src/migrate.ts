import { env } from "./config/env.js";
import { pgDb, SCHEMA, type Db } from "./config/db.js";
import { MIGRATIONS } from "./migrations.js";

/** Applies pending migrations in order, each in its own transaction. */
export async function migrate(db: Db, log: (m: string) => void = () => {}) {
  // In production the schema exists already and its owner may not create schemas;
  // "create schema if not exists" checks that right even when the schema is there.
  const { rows: has } = await db.query(`select 1 from pg_namespace where nspname = $1`, [SCHEMA]);
  if (!has.length) await db.exec(`create schema ${SCHEMA}`);
  await db.exec(`create table if not exists ${SCHEMA}.schema_migrations (id text primary key, at timestamptz not null default now())`);
  const { rows } = await db.query<{ id: string }>(`select id from ${SCHEMA}.schema_migrations`);
  const done = new Set(rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.tx(async (q) => {
      await q.exec(`set local search_path to ${SCHEMA}, public`);
      await q.exec(m.sql);
      await q.query(`insert into ${SCHEMA}.schema_migrations (id) values ($1)`, [m.id]);
    });
    log(`migrated ${m.id}`);
  }
}

// `node dist/migrate.js` runs against DATABASE_URL.
if (process.argv[1] && /migrate\.(js|ts)$/.test(process.argv[1])) {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set");
  const db = pgDb(env.databaseUrl);
  migrate(db, console.log)
    .then(() => db.close())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
