import { db, many } from "../config/db.js";

// Fees, time limits and contacts the admin console can change. The defaults are the
// starting values from the PRD (sections 4 and 6); a row in mjengo.settings overrides one.

export const DEFAULTS = {
  /** Added to the job price and paid by the client. */
  client_fee_pct: 9,
  /** Deducted from the worker's share before payout. */
  worker_fee_pct: 9,
  /** Client cancels after a worker accepted and more than free_cancel_minutes after booking. Paid to the worker. */
  late_cancel_fee_kes: 200,
  /** Client cancels once the worker is on the way. Paid to the worker. */
  enroute_cancel_fee_kes: 500,
  /** Client not there or site inaccessible after the worker waited. Paid to the worker. */
  callout_fee_kes: 500,
  free_cancel_minutes: 5,
  /** How long each worker has to accept an offer before it moves to the next nearest. */
  offer_window_seconds: 120,
  /** With no acceptance by then, the client is told and the team dispatches by hand. */
  dispatch_timeout_minutes: 10,
  /** Scheduled jobs start looking for a worker this long before the start time. */
  schedule_lead_minutes: 120,
  /** Escrow releases to the worker if the client neither approves nor disputes. */
  auto_release_hours: 24,
  dispute_window_hours: 24,
  /** How long a worker waits on site before logging a client no-show. */
  client_wait_minutes: 15,
  /** A worker not on site this long after the ETA is a no-show; the client may cancel free. */
  no_show_grace_minutes: 30,
  /** After this long without an update the client sees "Location unavailable". */
  location_stale_seconds: 120,
  /** Launch area: this far from Nairobi CBD. There is no dispatch radius inside it. */
  service_radius_km: 40,
  probation_jobs: 5,
  suspend_below_rating: 3.5,
  suspend_after_ratings: 10,
  /** Worker cancellations in 30 days that flag them for review. */
  cancel_flag_threshold: 3,
  support_phone: "",
  support_email: "",
  /** Comma-separated numbers texted for emergencies and jobs no worker accepted. */
  alert_phones: "",
};

export type Settings = typeof DEFAULTS;

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const rows = await many<{ key: string; value: unknown }>(db(), `select key, value from settings`);
  const value = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULTS) value[r.key] = r.value;
  cache = { at: Date.now(), value: value as Settings };
  return cache.value;
}

export async function setSettings(patch: Partial<Settings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS) || v === undefined) continue;
    await db().query(`insert into settings (key, value, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`, [k, JSON.stringify(v)]);
  }
  cache = null;
}

export const clearSettingsCache = () => {
  cache = null;
};
