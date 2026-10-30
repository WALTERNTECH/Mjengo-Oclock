import { one, type Db, type Q } from "./config/db.js";

// The trades and their rates, from the Construction & Site Labor Rate Schedule. This is the
// catalogue, not sample data: the operations team edits it in Admin › Trades and rates, and
// each job keeps the rate it was booked at. A catalogue version is recorded in settings, so a
// new schedule is applied once and later edits survive restarts.
//
// Billing rules from the schedule, enforced in pricing.ts and jobflow.ts:
// - Standard day shifts are 8 hours; hours beyond that are billed hourly where an hourly rate exists.
// - Site manager visits are a flat rate by zone: within the Nairobi area, or out of station.
// - Plumber, welder and general fundi work is a flat rate per task or engagement.
// - Painters and gypsum installers are billed per working day.
// - Contractor overhead and specialised engineering review fees are not in the schedule; they
//   are quoted under separate scope contracts.
//
// Version 2 replaced the earlier catalogue with the schedule. Later versions only add trades and
// services that aren't there yet (matched by trade and name), so rates the team has edited stay.
// v3 (2026-10-30): painters and gypsum installers at KES 1,600 a day.

export const CATALOG_VERSION = 3;
const SCHEDULE_VERSION = 2;

const LABOR = "General labor services";
const TRADES = "Specialized trades and skilled crafts";
const MANAGEMENT = "Management and supervisory roles";

const CATEGORIES = [
  { id: "general_labor", name: "General Labor", trade: "general worker", blurb: "Day shifts, hourly help, heavy labor and earthworks", section: LABOR, requires_certificate: false, sort: 1 },
  { id: "plumbing", name: "Plumbing", trade: "plumber", blurb: "Repairs, fittings, installations and blockages", section: TRADES, requires_certificate: true, sort: 2 },
  { id: "electrical", name: "Electrical", trade: "electrician", blurb: "Wiring, faults, sockets and fittings", section: TRADES, requires_certificate: true, sort: 3 },
  { id: "welding", name: "Welding", trade: "welder", blurb: "Gates, grilles, frames and metal repairs", section: TRADES, requires_certificate: false, sort: 4 },
  { id: "fundi", name: "General Fundis", trade: "fundi", blurb: "Masonry, carpentry, painting and repairs", section: TRADES, requires_certificate: false, sort: 5 },
  { id: "painting", name: "Painting", trade: "painter", blurb: "Walls, ceilings, gates and finishes, inside and out", section: TRADES, requires_certificate: false, sort: 6 },
  { id: "gypsum", name: "Gypsum Installation", trade: "gypsum installer", blurb: "Gypsum ceilings, partitions and cornices", section: TRADES, requires_certificate: false, sort: 7 },
  { id: "site_management", name: "Site Management", trade: "supervisor", blurb: "Site manager visits and foremen", section: MANAGEMENT, requires_certificate: false, sort: 8 },
];

type Svc = {
  name: string;
  description: string;
  pricing: "flat" | "hourly" | "shift" | "per_unit";
  rate: number;
  unit: "task" | "visit" | "shift" | "hour" | "ft" | "day";
  minQty?: number;
  shiftHours?: number;
  overtimeRate?: number;
  zone?: "nairobi" | "outside";
};

const MATERIALS = "Materials are extra and need your approval in the app.";

const SERVICES: Record<string, Svc[]> = {
  general_labor: [
    { name: "General worker, standard shift", description: "One worker for a standard 8-hour day shift. Hours beyond 8 are billed at KES 100 per hour.", pricing: "shift", rate: 800, unit: "shift", shiftHours: 8, overtimeRate: 100 },
    { name: "General worker, by the hour", description: "Carrying, mixing, cleaning and general site help, billed per hour.", pricing: "hourly", rate: 100, unit: "hour", minQty: 1 },
    { name: "Heavy labor: clearing, loading and bagging", description: "Site clearing, loading and bagging, billed per hour. Transport isn't included.", pricing: "hourly", rate: 200, unit: "hour", minQty: 1 },
    { name: "Earthworks: digging and trenching", description: "Digging and trenching, billed per foot.", pricing: "per_unit", rate: 60, unit: "ft", minQty: 1 },
  ],
  plumbing: [{ name: "Plumbing job", description: `One plumbing task or engagement at a fixed rate: repairs, fittings, installations or blockages. ${MATERIALS}`, pricing: "flat", rate: 2000, unit: "task" }],
  electrical: [{ name: "Electrician, by the hour", description: `Wiring, fault finding, sockets and fittings, billed per hour. ${MATERIALS}`, pricing: "hourly", rate: 250, unit: "hour", minQty: 1 }],
  welding: [{ name: "Welding job", description: `One welding task or engagement at a fixed rate: gates, grilles, frames or repairs. ${MATERIALS}`, pricing: "flat", rate: 2000, unit: "task" }],
  fundi: [{ name: "General fundi job", description: `One task or engagement at a fixed rate: masonry, carpentry, painting, tiling or general repairs. ${MATERIALS}`, pricing: "flat", rate: 1600, unit: "task" }],
  painting: [{ name: "Painter, by the day", description: `One painter per working day: walls, ceilings, gates and finishes, inside or out. Book as many days as the job needs. Paint and ${MATERIALS.toLowerCase()}`, pricing: "per_unit", rate: 1600, unit: "day", minQty: 1 }],
  gypsum: [{ name: "Gypsum installer, by the day", description: `One gypsum installer per working day: ceilings, partitions and cornices. Book as many days as the job needs. Boards and ${MATERIALS.toLowerCase()}`, pricing: "per_unit", rate: 1600, unit: "day", minQty: 1 }],
  site_management: [
    { name: "Site manager visit, Nairobi", description: "A site manager visits your site in the Nairobi area to inspect work and review progress.", pricing: "flat", rate: 15_000, unit: "visit", zone: "nairobi" },
    { name: "Site manager visit, outside Nairobi", description: "The same visit for a site outside the Nairobi area (out of station).", pricing: "flat", rate: 35_000, unit: "visit", zone: "outside" },
    { name: "Foreman, standard shift", description: "A foreman supervising your crew for a standard 8-hour day shift.", pricing: "shift", rate: 2000, unit: "shift", shiftHours: 8 },
  ],
};

const version = async (q: Q) => Number((await one<{ value: unknown }>(q, `select value from settings where key = 'catalog_version'`))?.value ?? 0);

export async function seedCatalog(db: Db, log: (m: string) => void = () => {}) {
  if ((await version(db)) >= CATALOG_VERSION) return;
  await db.tx(async (q) => {
    // Several instances can start at once; the first applies the upgrade, the rest find it done.
    await q.query(`select pg_advisory_xact_lock(hashtext('mjengo.catalog'))`);
    const from = await version(q);
    if (from >= CATALOG_VERSION) return;
    const replace = from < SCHEDULE_VERSION;
    for (const c of CATEGORIES) {
      // Certificates and bookability are the team's call once set, so an existing category keeps them.
      await q.query(
        `insert into categories (id, name, trade, blurb, section, requires_certificate, sort) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (id) do update set name = excluded.name, trade = excluded.trade, blurb = excluded.blurb, section = excluded.section, sort = excluded.sort`,
        [c.id, c.name, c.trade, c.blurb, c.section, c.requires_certificate, c.sort],
      );
    }
    // Services from before the schedule stay in the table for the jobs that reference them, but can't be booked.
    const old = replace ? (await q.query<{ id: string }>(`update services set active = false, updated_at = now() where active returning id`)).rows : [];
    let n = 0;
    for (const [cat, list] of Object.entries(SERVICES)) {
      for (const [i, s] of list.entries()) {
        // A service the team edited or switched off is theirs; only missing ones are added.
        if (!replace && (await q.query(`select 1 from services where category_id = $1 and name = $2`, [cat, s.name])).rows.length) continue;
        await q.query(
          `insert into services (category_id, name, description, pricing, rate_kes, unit_label, min_hours, shift_hours, overtime_rate_kes, zone, sort)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [cat, s.name, s.description, s.pricing, s.rate, s.unit, s.minQty ?? 1, s.shiftHours ?? 8, s.overtimeRate ?? null, s.zone ?? "nairobi", i + 1],
        );
        n++;
      }
    }
    await q.query(
      `insert into settings (key, value, updated_at) values ('catalog_version', $1::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(CATALOG_VERSION)],
    );
    log(`catalogue v${CATALOG_VERSION}: ${n} services added across ${CATEGORIES.length} trades${old.length ? `, ${old.length} earlier services retired` : ""}`);
  });
}
