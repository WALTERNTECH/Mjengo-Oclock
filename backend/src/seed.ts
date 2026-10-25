import { many, type Db } from "./config/db.js";

// The trades and their starting rates (PRD 4.2 and View 1). These are the catalogue, not
// sample data: the operations team edits names and rates in Admin › Rates, and each job
// keeps the rate it was booked at. Inserted only when missing, so edits survive restarts.

const CATEGORIES = [
  { id: "plumbing", name: "Plumbing", trade: "plumber", blurb: "Leaks, blockages, toilets, tanks and pumps", requires_certificate: true, sort: 1 },
  { id: "electrical", name: "Electrical", trade: "electrician", blurb: "Sockets, lights, wiring and faults", requires_certificate: true, sort: 2 },
  { id: "site_management", name: "Site Management", trade: "site manager", blurb: "Supervision, inspections and progress reports", requires_certificate: false, sort: 3 },
  { id: "general_labor", name: "General Labor", trade: "general worker", blurb: "Digging, loading, clearing and site help", requires_certificate: false, sort: 4 },
];

type Svc = { name: string; description: string; pricing: "flat" | "hourly"; rate: number; minHours?: number };

const SERVICES: Record<string, Svc[]> = {
  plumbing: [
    { name: "Fix a leaking tap or pipe", description: "Replace washers, seals or a short section of pipe. Parts are extra.", pricing: "flat", rate: 1500 },
    { name: "Unblock a drain, sink or toilet", description: "Clear one blockage with rods or a plunger.", pricing: "flat", rate: 2000 },
    { name: "Toilet or cistern repair", description: "Flush mechanism, fill valve, seat or leaking cistern.", pricing: "flat", rate: 2000 },
    { name: "Install a water tank or pump", description: "Fit and connect a tank or booster pump you have bought.", pricing: "flat", rate: 4500 },
    { name: "Plumber by the hour", description: "Anything else: you set the hours, the plumber brings tools.", pricing: "hourly", rate: 800, minHours: 2 },
  ],
  electrical: [
    { name: "Repair a socket or switch", description: "Replace or rewire one socket, switch or isolator.", pricing: "flat", rate: 1200 },
    { name: "Fit a light or ceiling fan", description: "Install one fitting on an existing point.", pricing: "flat", rate: 1500 },
    { name: "Find and fix a fault", description: "Tripping breakers, dead circuits or flickering lights.", pricing: "hourly", rate: 1000, minHours: 1 },
    { name: "Wire a room", description: "New points and cabling for one room, to standard.", pricing: "flat", rate: 6000 },
    { name: "Electrician by the hour", description: "Anything else: you set the hours.", pricing: "hourly", rate: 1000, minHours: 2 },
  ],
  site_management: [
    { name: "Site inspection and report", description: "A visit, photos and a written report on progress and quality.", pricing: "flat", rate: 4000 },
    { name: "Site manager, half day", description: "Up to 4 hours supervising crews, deliveries and quality.", pricing: "flat", rate: 3500 },
    { name: "Site manager, full day", description: "Up to 8 hours on site.", pricing: "flat", rate: 6500 },
    { name: "Site manager by the hour", description: "Short visits or extra time.", pricing: "hourly", rate: 900, minHours: 2 },
  ],
  general_labor: [
    { name: "General worker by the hour", description: "Carrying, mixing, cleaning and site help.", pricing: "hourly", rate: 350, minHours: 4 },
    { name: "General worker, full day", description: "Up to 8 hours on site.", pricing: "flat", rate: 1500 },
    { name: "Clear and load rubble", description: "Clearing, bagging and loading by the hour. Transport not included.", pricing: "hourly", rate: 400, minHours: 3 },
    { name: "Digging and trenching", description: "Foundations, drainage or cable trenches by the hour.", pricing: "hourly", rate: 450, minHours: 4 },
  ],
};

export async function seedCatalog(db: Db, log: (m: string) => void = () => {}) {
  for (const c of CATEGORIES) {
    await db.query(`insert into categories (id, name, trade, blurb, requires_certificate, sort) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`, [
      c.id, c.name, c.trade, c.blurb, c.requires_certificate, c.sort,
    ]);
  }
  const have = new Set((await many<{ category_id: string }>(db, `select distinct category_id from services`)).map((r) => r.category_id));
  for (const [cat, list] of Object.entries(SERVICES)) {
    if (have.has(cat)) continue;
    for (const [i, s] of list.entries()) {
      await db.query(`insert into services (category_id, name, description, pricing, rate_kes, min_hours, sort) values ($1,$2,$3,$4,$5,$6,$7)`, [cat, s.name, s.description, s.pricing, s.rate, s.minHours ?? 1, i + 1]);
    }
    log(`catalogue: ${list.length} ${cat} services`);
  }
}
