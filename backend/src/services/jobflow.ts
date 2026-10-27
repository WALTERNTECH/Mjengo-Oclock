import { db, many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/http.js";
import { estimateMinutes, etaMinutes, haversineKm, inKenya, inServiceArea, type Point } from "../utils/geo.js";
import { kes, shortName, timeEAT, whenEAT } from "../utils/kenya.js";
import { randomToken, shortRef } from "../utils/security.js";
import { adminAlert, logEvent, SYSTEM, type Actor } from "./audit.js";
import { offerNext, withdrawOffers } from "./dispatch.js";
import { emit } from "./events.js";
import { notifyAll, type After } from "./notify.js";
import type { PaymentRow } from "./payments.js";
import { startPayment } from "./payments.js";
import { queuePayout, sendJobPayouts } from "./payouts.js";
import { pct, quote, split, type Pricing, type Split } from "./pricing.js";
import { getSettings, type Settings } from "./settings.js";
import { queueSms } from "./sms.js";

// The life of a job, from booking to payout (PRD sections 4, 6 and 7).
//
//   PENDING_PAYMENT → SCHEDULED → SEARCHING → ACCEPTED → EN_ROUTE → ON_SITE → IN_PROGRESS → COMPLETED → CLOSED
//                                     ↘ UNASSIGNED (no acceptance in 10 min)          ↘ DISPUTED → CLOSED
//   CANCELLED and EXPIRED end a job early.
//
// Each change happens in one transaction that locks the job row, writes the timeline, and
// collects the texts and pushes to send once it commits.

export type JobStatus =
  | "PENDING_PAYMENT" | "SCHEDULED" | "SEARCHING" | "UNASSIGNED" | "ACCEPTED" | "EN_ROUTE" | "ON_SITE" | "IN_PROGRESS" | "COMPLETED" | "DISPUTED" | "CLOSED" | "CANCELLED" | "EXPIRED";

export type JobRow = {
  id: string;
  ref: string;
  client_id: string;
  service_id: string | null;
  service_name: string;
  category_id: string;
  pricing: Pricing;
  rate_kes: number;
  hours: number;
  unit_label: string;
  quantity: number;
  shift_hours: number | null;
  overtime_hours: number;
  overtime_rate_kes: number | null;
  zone: "nairobi" | "outside";
  base_kes: number;
  client_fee_pct: number;
  client_fee_kes: number;
  total_kes: number;
  worker_fee_pct: number;
  address: string;
  lat: number;
  lng: number;
  address_notes: string;
  description: string;
  scheduled_for: Date | null;
  status: JobStatus;
  outcome: string | null;
  worker_id: string | null;
  excluded_workers: string[];
  dispatch_round: number;
  dispatch_started_at: Date | null;
  unassigned_at: Date | null;
  confirmed_at: Date | null;
  accepted_at: Date | null;
  en_route_at: Date | null;
  eta_minutes: number | null;
  eta_at: Date | null;
  on_site_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  approved_at: Date | null;
  auto_released: boolean;
  closed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  worker_no_show_at: Date | null;
  client_no_show_at: Date | null;
  extras_kes: number;
  tip_kes: number;
  paid_kes: number;
  escrow: "NONE" | "HELD" | "FROZEN" | "RELEASED" | "REFUNDED" | "SPLIT";
  worker_gross_kes: number | null;
  worker_net_kes: number | null;
  refund_kes: number | null;
  platform_kes: number | null;
  probation: boolean;
  probation_reviewed_at: Date | null;
  invoice_token: string;
  created_at: Date;
  updated_at: Date;
};

/** Statuses during which a worker is committed to the job. */
export const ACTIVE: JobStatus[] = ["ACCEPTED", "EN_ROUTE", "ON_SITE", "IN_PROGRESS"];
/** Statuses during which the client sees the worker's live location (PRD 11: only while the job is active). */
export const TRACKING: JobStatus[] = ["EN_ROUTE", "ON_SITE", "IN_PROGRESS"];
export const OPEN: JobStatus[] = ["PENDING_PAYMENT", "SCHEDULED", "SEARCHING", "UNASSIGNED", ...ACTIVE, "COMPLETED", "DISPUTED"];

export type Followups = { notices: After[]; then: (() => Promise<void>)[] };

const link = (path: string) => `${env.publicUrl}${path}`;
const jobLink = (j: { id: string }) => link(`/jobs/${j.id}`);
export const invoiceLink = (j: { ref: string; invoice_token: string }) => link(`/invoice/${j.ref}?t=${j.invoice_token}`);

/** Runs a change in one transaction, then sends what it collected. Settings are read first: PGlite runs one transaction at a time. */
export async function run<T>(fn: (q: Q, f: Followups, s: Settings) => Promise<T>): Promise<T> {
  const s = await getSettings();
  const f: Followups = { notices: [], then: [] };
  const out = await db().tx((q) => fn(q, f, s));
  await notifyAll(f.notices);
  for (const t of f.then) await t().catch((e) => console.error("[job] follow-up", e));
  return out;
}

export async function lockJob(q: Q, id: string): Promise<JobRow> {
  const j = await one<JobRow>(q, `select * from jobs where id = $1 for update`, [id]);
  if (!j) throw notFound("Job not found");
  return j;
}

/** Tells the open screens of both people on the job to refresh it. */
export function touch(f: Followups, j: { id: string; client_id: string; worker_id: string | null }, alsoWorker?: string | null) {
  f.then.push(async () => {
    emit(j.client_id, "job", { id: j.id });
    if (j.worker_id) emit(j.worker_id, "job", { id: j.id });
    if (alsoWorker && alsoWorker !== j.worker_id) emit(alsoWorker, "job", { id: j.id });
  });
}

async function setStatus(q: Q, j: JobRow, status: JobStatus, actor: Actor, extra: Record<string, unknown> = {}, sqlSet = "") {
  await q.query(`update jobs set status = $2, updated_at = now()${sqlSet ? `, ${sqlSet}` : ""} where id = $1`, [j.id, status]);
  await logEvent(q, j.id, actor, `status.${status.toLowerCase()}`, { from: j.status, ...extra });
  j.status = status;
}

async function names(q: Q, j: JobRow) {
  const r = await one<{ client: string; worker: string | null; trade: string; category: string }>(
    q,
    `select c.full_name as client, w.full_name as worker, cat.trade, cat.name as category
       from users c left join users w on w.id = $2 join categories cat on cat.id = $3 where c.id = $1`,
    [j.client_id, j.worker_id, j.category_id],
  );
  return { client: shortName(r!.client) || "Your client", worker: shortName(r!.worker ?? "") || "Your worker", trade: r!.trade, category: r!.category };
}

/** Pays out of escrow: the worker's net share and any refund, recorded now and sent after commit. */
async function settleEscrow(q: Q, j: JobRow, actor: Actor, how: { workerGross: number; fullRelease?: boolean; flatFee?: boolean }, f: Followups): Promise<Split> {
  const sp = split({ paid: j.paid_kes, workerGross: how.workerGross, clientFeePct: j.client_fee_pct, workerFeePct: j.worker_fee_pct, fullRelease: how.fullRelease, flatFee: how.flatFee });
  if (sp.workerNet > 0 && j.worker_id) await queuePayout(q, { jobId: j.id, kind: "WORKER", userId: j.worker_id, amount: sp.workerNet });
  if (sp.refund > 0) await queuePayout(q, { jobId: j.id, kind: "REFUND", userId: j.client_id, amount: sp.refund });
  await q.query(`update jobs set worker_gross_kes = $2, worker_net_kes = $3, refund_kes = $4, platform_kes = $5 where id = $1`, [j.id, sp.workerGross, sp.workerNet, sp.refund, sp.platform]);
  await logEvent(q, j.id, actor, "escrow.settled", { ...sp, paid: j.paid_kes });
  f.then.push(() => sendJobPayouts(j.id));
  return sp;
}

// ——— Booking ———

export type NewJob = {
  serviceId: string;
  /** Hourly services. */
  hours?: number;
  /** Per-unit services: feet of trench, for example. */
  quantity?: number;
  /** Shift services: hours beyond the standard shift, billed hourly where the schedule allows. */
  overtimeHours?: number;
  address: string;
  lat: number;
  lng: number;
  addressNotes?: string;
  description: string;
  scheduledFor?: string | null;
  clientKey?: string;
};

export async function createJob(clientId: string, b: NewJob): Promise<JobRow> {
  const s = await getSettings();
  const svc = await one<{
    id: string; name: string; category_id: string; pricing: Pricing; rate_kes: number; unit_label: string; min_hours: number; shift_hours: number;
    overtime_rate_kes: number | null; zone: "nairobi" | "outside"; active: boolean; cat_active: boolean;
  }>(db(), `select s.*, c.active as cat_active from services s join categories c on c.id = s.category_id where s.id = $1`, [b.serviceId]);
  if (!svc || !svc.active || !svc.cat_active) throw badRequest("That service isn't available right now");

  // Zoning: site visits are priced by whether the site is in the Nairobi area or out of station.
  const inNairobi = inServiceArea(b, s.service_radius_km);
  if (svc.zone === "outside") {
    if (inNairobi) throw badRequest("This site is in the Nairobi area. Choose the Nairobi visit rate instead.", [{ path: "address", message: "Inside the Nairobi area" }]);
    if (!inKenya(b)) throw badRequest("Choose a site in Kenya", [{ path: "address", message: "Outside Kenya" }]);
  } else if (!inNairobi) {
    const outside = await one(db(), `select 1 from services where category_id = $1 and zone = 'outside' and active`, [svc.category_id]);
    throw badRequest(outside ? "This site is outside the Nairobi area. Choose the out-of-station rate instead." : "We only cover the Nairobi area for this service. Choose an address in Nairobi.", [
      { path: "address", message: "Outside the Nairobi area" },
    ]);
  }

  const hours = Number(b.hours ?? svc.min_hours);
  if (svc.pricing === "hourly" && (hours < svc.min_hours || hours > 24)) throw badRequest(`Book between ${svc.min_hours} and 24 hours`, [{ path: "hours", message: `At least ${svc.min_hours}` }]);
  const quantity = Number(b.quantity ?? svc.min_hours);
  if (svc.pricing === "per_unit" && (quantity < svc.min_hours || quantity > 100_000 || !Number.isFinite(quantity)))
    throw badRequest(`Enter at least ${svc.min_hours} ${svc.unit_label || "units"}`, [{ path: "quantity", message: `At least ${svc.min_hours}` }]);
  const overtimeHours = Number(b.overtimeHours ?? 0);
  if (svc.pricing === "shift" && overtimeHours > 0) {
    // Hours past the standard shift move to hourly billing only where the schedule has an hourly rate.
    if (!svc.overtime_rate_kes) throw badRequest(`This is a standard ${svc.shift_hours}-hour shift. Book another shift for longer work.`, [{ path: "overtimeHours", message: "No overtime rate" }]);
    if (overtimeHours > 8) throw badRequest("Add up to 8 hours beyond the shift", [{ path: "overtimeHours", message: "Up to 8" }]);
  }
  let scheduled: Date | null = null;
  if (b.scheduledFor) {
    scheduled = new Date(b.scheduledFor);
    if (Number.isNaN(scheduled.getTime())) throw badRequest("Pick a valid date and time");
    if (scheduled.getTime() < Date.now() + 30 * 60_000) throw badRequest("Pick a time at least 30 minutes from now, or choose As soon as possible", [{ path: "scheduledFor", message: "Too soon" }]);
    if (scheduled.getTime() > Date.now() + 14 * 86_400_000) throw badRequest("Book up to 14 days ahead", [{ path: "scheduledFor", message: "Too far ahead" }]);
  }
  if (b.clientKey) {
    const dup = await one<JobRow>(db(), `select * from jobs where client_id = $1 and client_key = $2`, [clientId, b.clientKey]);
    if (dup) return dup;
  }
  const qt = quote({
    pricing: svc.pricing,
    rate: svc.rate_kes,
    hours,
    quantity,
    shiftHours: svc.shift_hours,
    overtimeHours,
    overtimeRate: svc.overtime_rate_kes,
    clientFeePct: s.client_fee_pct,
    workerFeePct: s.worker_fee_pct,
  });
  return db().tx(async (q) => {
    const j = await one<JobRow>(
      q,
      `insert into jobs (ref, client_id, client_key, service_id, service_name, category_id, pricing, rate_kes, hours, base_kes, client_fee_pct, client_fee_kes, total_kes,
                         worker_fee_pct, address, lat, lng, address_notes, description, scheduled_for, invoice_token,
                         unit_label, quantity, shift_hours, overtime_hours, overtime_rate_kes, zone)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) returning *`,
      [
        shortRef("MJ-"), clientId, b.clientKey ?? null, svc.id, svc.name, svc.category_id, svc.pricing, svc.rate_kes, qt.hours, qt.base, s.client_fee_pct, qt.clientFee, qt.total,
        s.worker_fee_pct, b.address, b.lat, b.lng, b.addressNotes ?? "", b.description, scheduled, randomToken(),
        svc.unit_label, qt.quantity, svc.pricing === "shift" ? svc.shift_hours : null, qt.overtimeHours, svc.pricing === "shift" ? svc.overtime_rate_kes : null, svc.zone,
      ],
    );
    await logEvent(q, j!.id, { type: "client", id: clientId }, "job.created", { service: svc.name, total: qt.total, scheduledFor: scheduled, quantity: qt.quantity, overtimeHours: qt.overtimeHours });
    return j!;
  });
}

/** Sends the M-Pesa prompt for the booking hold: the job price plus the client fee. */
export async function payHold(clientId: string, jobId: string, phone: string) {
  const j = await one<JobRow>(db(), `select * from jobs where id = $1`, [jobId]);
  if (!j || j.client_id !== clientId) throw notFound("Job not found");
  if (j.status !== "PENDING_PAYMENT") throw conflict("This booking isn't waiting for payment", "not_payable");
  return startPayment({ userId: clientId, purpose: "JOB_HOLD", jobId: j.id, phone, amount: j.total_kes, accountRef: j.ref.replace("-", ""), description: "Mjengo job" });
}

export async function onHoldPaid(q: Q, p: PaymentRow, f: Followups) {
  const s = await settingsInTx(q);
  const j = await lockJob(q, p.job_id);
  if (j.status !== "PENDING_PAYMENT") {
    // The prompt was answered after the booking ended (cancelled or expired): send the money back.
    await q.query(`update jobs set paid_kes = paid_kes + $2 where id = $1`, [j.id, p.amount_kes]);
    await queuePayout(q, { jobId: j.id, kind: "REFUND", userId: j.client_id, amount: p.amount_kes });
    await q.query(`update jobs set escrow = 'REFUNDED', refund_kes = coalesce(refund_kes, 0) + $2 where id = $1`, [j.id, p.amount_kes]);
    await logEvent(q, j.id, SYSTEM, "payment.late_refund", { amount: p.amount_kes, receipt: p.mpesa_receipt });
    f.then.push(() => sendJobPayouts(j.id));
    return;
  }
  const n = await names(q, j);
  const later = j.scheduled_for && new Date(j.scheduled_for).getTime() - s.schedule_lead_minutes * 60_000 > Date.now();
  await q.query(`update jobs set paid_kes = $2, escrow = 'HELD', confirmed_at = now() where id = $1`, [j.id, p.amount_kes]);
  await logEvent(q, j.id, { type: "client", id: j.client_id }, "payment.held", { amount: p.amount_kes, receipt: p.mpesa_receipt });
  if (later) await setStatus(q, j, "SCHEDULED", SYSTEM);
  else await setStatus(q, j, "SEARCHING", SYSTEM, {}, "dispatch_started_at = now(), dispatch_round = dispatch_round + 1");
  const when = j.scheduled_for ? ` for ${whenEAT(j.scheduled_for)}` : "";
  f.notices.push({
    userId: j.client_id,
    n: {
      kind: "job",
      title: "Booking confirmed",
      body: `${j.service_name}${when} · ${kes(j.total_kes)} held until the job is done`,
      link: `/jobs/${j.id}`,
      sms: `Mjengo O'clock: booking ${j.ref} confirmed - ${j.service_name}${when}. ${kes(j.total_kes)} is held safely until you approve the work. ${later ? `We'll assign a ${n.trade} before then.` : `Finding the nearest ${n.trade} now.`} ${jobLink(j)}`,
    },
  });
  touch(f, j);
  if (!later) f.then.push(() => offerNext(j.id));
}

// Settings without a second connection: inside a PGlite transaction db() would deadlock.
async function settingsInTx(q: Q): Promise<Settings> {
  const { DEFAULTS } = await import("./settings.js");
  const rows = await many<{ key: string; value: unknown }>(q, `select key, value from settings`);
  const v = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULTS) v[r.key] = r.value;
  return v as Settings;
}

// ——— The worker's steps ———

async function workerJob(q: Q, workerId: string, jobId: string): Promise<JobRow> {
  const j = await lockJob(q, jobId);
  if (j.worker_id !== workerId) throw notFound("Job not found");
  return j;
}

async function workerPoint(q: Q, workerId: string, given?: Point | null): Promise<Point | null> {
  if (given) return given;
  const w = await one<{ last_lat: number | null; last_lng: number | null; home_lat: number | null; home_lng: number | null }>(
    q,
    `select w.last_lat, w.last_lng, u.home_lat, u.home_lng from worker_profiles w join users u on u.id = w.user_id where w.user_id = $1`,
    [workerId],
  );
  if (w?.last_lat != null && w.last_lng != null) return { lat: w.last_lat, lng: w.last_lng };
  if (w?.home_lat != null && w.home_lng != null) return { lat: w.home_lat, lng: w.home_lng };
  return null;
}

export async function startTrip(workerId: string, jobId: string, at?: Point | null) {
  // The drive time is asked for before the transaction, which must not wait on the network.
  const pre = await one<JobRow>(db(), `select * from jobs where id = $1`, [jobId]);
  const from = pre ? await workerPoint(db(), workerId, at) : null;
  const eta = pre && from ? await etaMinutes(from, pre) : null;
  return run(async (q, f) => {
    const j = await workerJob(q, workerId, jobId);
    if (j.status !== "ACCEPTED") throw conflict("You can start the trip only after accepting and before arriving");
    const minutes = eta?.minutes ?? 30;
    await setStatus(q, j, "EN_ROUTE", { type: "worker", id: workerId }, { eta: minutes, source: eta?.source ?? "default" }, `en_route_at = now(), eta_minutes = ${Math.round(minutes)}, eta_at = now() + make_interval(mins => ${Math.round(minutes)})`);
    const n = await names(q, j);
    const by = timeEAT(Date.now() + minutes * 60_000);
    f.notices.push({
      userId: j.client_id,
      n: { kind: "job", title: `${n.worker} is on the way`, body: `Arriving in about ${minutes} min (${by})`, link: `/jobs/${j.id}`, sms: `Mjengo O'clock: ${n.worker} is on the way for job ${j.ref}. ETA about ${minutes} min (${by}). Track live: ${jobLink(j)}` },
    });
    touch(f, j);
  });
}

export async function arrive(workerId: string, jobId: string) {
  return run(async (q, f) => {
    const j = await workerJob(q, workerId, jobId);
    if (j.status !== "EN_ROUTE" && j.status !== "ACCEPTED") throw conflict("This job isn't on the way");
    await setStatus(q, j, "ON_SITE", { type: "worker", id: workerId }, {}, "on_site_at = now()");
    const n = await names(q, j);
    f.notices.push({ userId: j.client_id, n: { kind: "job", title: `${n.worker} has arrived`, body: j.service_name, link: `/jobs/${j.id}`, sms: `Mjengo O'clock: ${n.worker} has arrived for job ${j.ref}. ${jobLink(j)}` } });
    touch(f, j);
  });
}

export async function startWork(workerId: string, jobId: string) {
  return run(async (q, f) => {
    const j = await workerJob(q, workerId, jobId);
    if (j.status !== "ON_SITE") throw conflict("Mark that you've arrived first");
    await setStatus(q, j, "IN_PROGRESS", { type: "worker", id: workerId }, {}, "started_at = now()");
    const n = await names(q, j);
    f.notices.push({ userId: j.client_id, n: { kind: "job", title: "Work has started", body: `${n.worker} · ${j.service_name}`, link: `/jobs/${j.id}` } });
    touch(f, j);
  });
}

export async function complete(workerId: string, jobId: string) {
  return run(async (q, f, s) => {
    const j = await workerJob(q, workerId, jobId);
    if (j.status !== "IN_PROGRESS") throw conflict("Start the job before marking it complete");
    const pending = await many<{ id: string }>(q, `update extra_requests set status = 'EXPIRED', responded_at = now() where job_id = $1 and status = 'PENDING' returning id`, [j.id]);
    await setStatus(q, j, "COMPLETED", { type: "worker", id: workerId }, { unansweredExtras: pending.length }, "completed_at = now()");
    const n = await names(q, j);
    f.notices.push({
      userId: j.client_id,
      n: {
        kind: "job",
        title: "Job complete: your invoice is ready",
        body: `Approve the work or raise a problem within ${s.auto_release_hours} hours`,
        link: `/jobs/${j.id}`,
        sms: `Mjengo O'clock: ${n.worker} has finished job ${j.ref}. Invoice: ${invoiceLink(j)} Approve in the app or raise a problem within ${s.auto_release_hours} hours; after that payment releases to the worker.`,
      },
    });
    touch(f, j);
  });
}

/** The worker pulls out after accepting: no fee to the client, and the job goes back out (PRD 6). */
export async function workerCancel(workerId: string, jobId: string, reason: string) {
  return run(async (q, f, s) => {
    const j = await workerJob(q, workerId, jobId);
    if (!["ACCEPTED", "EN_ROUTE", "ON_SITE"].includes(j.status)) throw conflict("This job can't be cancelled now. Use Report a problem.");
    const n = await names(q, j);
    await q.query(
      `update jobs set worker_id = null, excluded_workers = array_append(excluded_workers, $2::uuid), accepted_at = null, en_route_at = null, eta_minutes = null, eta_at = null,
              on_site_at = null, worker_no_show_at = null, probation = false where id = $1`,
      [j.id, workerId],
    );
    await setStatus(q, j, "SEARCHING", { type: "worker", id: workerId }, { reason, workerCancelled: workerId }, "dispatch_started_at = now()");
    await logEvent(q, j.id, { type: "worker", id: workerId }, "worker.cancelled", { reason });
    await q.query(`update worker_profiles set cancellations = cancellations + 1, available = false, updated_at = now() where user_id = $1`, [workerId]);
    const recent = await one<{ n: number }>(q, `select count(*)::int as n from job_events where kind = 'worker.cancelled' and actor_id = $1 and created_at > now() - interval '30 days'`, [workerId]);
    if ((recent?.n ?? 0) >= s.cancel_flag_threshold) {
      await q.query(`update worker_profiles set flagged = true, flag_reason = $2 where user_id = $1`, [workerId, `${recent!.n} cancellations after accepting in 30 days`]);
      f.then.push(() => adminAlert({ kind: "worker_flagged", title: `${n.worker} flagged: ${recent!.n} cancellations in 30 days`, userId: workerId, jobId: j.id }));
    }
    f.notices.push({
      userId: j.client_id,
      n: { kind: "job", title: `${n.worker} had to cancel`, body: `Finding another ${n.trade} at no extra cost`, link: `/jobs/${j.id}`, sms: `Mjengo O'clock: ${n.worker} had to cancel job ${j.ref}. We're finding another ${n.trade} now at no extra cost. ${jobLink(j)}` },
    });
    f.notices.push({ userId: workerId, n: { kind: "job", title: `You cancelled ${j.ref}`, body: "You're set to unavailable. Go available again when you're ready.", link: "/work" } });
    touch(f, { ...j, worker_id: workerId });
    f.then.push(() => offerNext(j.id));
  });
}

/** The client wasn't there or the site was shut: after waiting, the worker earns the call-out fee (PRD 6). */
export async function clientNoShow(workerId: string, jobId: string, note: string) {
  return run(async (q, f, s) => {
    const j = await workerJob(q, workerId, jobId);
    if (j.status !== "ON_SITE") throw conflict("You can log this only while on site, before starting work");
    const waited = (Date.now() - new Date(j.on_site_at!).getTime()) / 60_000;
    if (waited < s.client_wait_minutes) throw conflict(`Wait ${s.client_wait_minutes} minutes on site first (${Math.ceil(s.client_wait_minutes - waited)} to go)`);
    const fee = Math.min(s.callout_fee_kes, j.paid_kes);
    const sp = await settleEscrow(q, j, { type: "worker", id: workerId }, { workerGross: fee, flatFee: true }, f);
    await q.query(`update jobs set outcome = 'client_no_show', escrow = 'SPLIT', client_no_show_at = now(), closed_at = now() where id = $1`, [j.id]);
    await setStatus(q, j, "CLOSED", { type: "worker", id: workerId }, { clientNoShow: true, note, waitedMinutes: Math.round(waited) });
    const n = await names(q, j);
    f.notices.push({
      userId: j.client_id,
      n: {
        kind: "job",
        title: "Marked as client no-show",
        body: `Call-out fee ${kes(sp.workerNet)} · ${kes(sp.refund)} refunded`,
        link: `/jobs/${j.id}`,
        sms: `Mjengo O'clock: ${n.worker} waited ${Math.round(waited)} min at the site for job ${j.ref} and couldn't start. A call-out fee of ${kes(sp.workerNet)} was paid to them; ${kes(sp.refund)} is being refunded to your M-Pesa. Think this is wrong? Reply in the app.`,
      },
    });
    f.notices.push({ userId: workerId, n: { kind: "job", title: `Call-out fee ${kes(sp.workerNet)} for ${j.ref}`, body: "Paid to you once it clears", link: "/work/earnings" } });
    f.then.push(() => adminAlert({ kind: "client_no_show", title: `Client no-show on ${j.ref}`, body: note, jobId: j.id }));
    touch(f, j);
  });
}

// ——— Extra hours or materials (PRD 6 and US-07) ———

/**
 * The rate for extra time on a job: the job's own hourly rate; for a shift, its overtime
 * rate (hours past the 8-hour shift bill hourly where the schedule has a rate); otherwise the
 * trade's hourly service, if it has one. Null means the worker states the amount.
 */
export async function hourlyRateFor(q: Q, j: Pick<JobRow, "pricing" | "rate_kes" | "overtime_rate_kes" | "category_id">): Promise<number | null> {
  if (j.pricing === "hourly") return j.rate_kes;
  if (j.pricing === "shift") return j.overtime_rate_kes ?? null;
  const r = await one<{ rate_kes: number }>(q, `select rate_kes from services where category_id = $1 and pricing = 'hourly' and active order by sort limit 1`, [j.category_id]);
  return r?.rate_kes ?? null;
}

export const unitWord = (label: string, n: number) => (label === "ft" ? (n === 1 ? "foot" : "feet") : `${label || "unit"}${n === 1 ? "" : "s"}`);

export async function requestExtra(workerId: string, jobId: string, b: { kind: "hours" | "materials" | "units"; hours?: number; units?: number; amount?: number; reason: string }, photoMediaId: string) {
  return run(async (q, f, s) => {
    const j = await workerJob(q, workerId, jobId);
    if (j.status !== "ON_SITE" && j.status !== "IN_PROGRESS") throw conflict("Extra work can be requested only on site");
    const open = await one(q, `select 1 from extra_requests where job_id = $1 and status in ('PENDING','AWAITING_PAYMENT')`, [j.id]);
    if (open) throw conflict("Wait for the client to answer your last request");
    let amount = Math.round(b.amount ?? 0);
    if (b.kind === "hours") {
      const rate = await hourlyRateFor(q, j);
      if (!b.hours || b.hours <= 0 || b.hours > 12) throw badRequest("Enter between 0.5 and 12 extra hours", [{ path: "hours", message: "0.5 to 12" }]);
      if (rate) amount = Math.round(rate * b.hours);
    }
    if (b.kind === "units") {
      // More of the same measured work (feet of trench) at the job's own rate.
      if (j.pricing !== "per_unit") throw badRequest("This job isn't priced per unit");
      if (!b.units || b.units <= 0 || b.units > 100_000) throw badRequest(`Enter how many more ${unitWord(j.unit_label, 2)}`, [{ path: "units", message: "Required" }]);
      amount = Math.round(j.rate_kes * b.units);
    }
    if (amount < 50 || amount > 500_000) throw badRequest("Enter an amount between KES 50 and 500,000", [{ path: "amount", message: "50 to 500,000" }]);
    const fee = pct(amount, s.client_fee_pct);
    const x = await one<{ id: string }>(
      q,
      `insert into extra_requests (job_id, worker_id, kind, hours, units, amount_kes, client_fee_kes, reason, photo_media_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [j.id, workerId, b.kind, b.kind === "hours" ? b.hours : null, b.kind === "units" ? b.units : null, amount, fee, b.reason, photoMediaId],
    );
    await q.query(`insert into job_photos (job_id, media_id, kind, ref_id, uploaded_by) values ($1, $2, 'extra', $3, $4)`, [j.id, photoMediaId, x!.id, workerId]);
    await logEvent(q, j.id, { type: "worker", id: workerId }, "extra.requested", { extraId: x!.id, kind: b.kind, hours: b.hours, units: b.units, amount, reason: b.reason });
    const n = await names(q, j);
    const what =
      b.kind === "hours" ? `${b.hours} extra hour${b.hours === 1 ? "" : "s"}` : b.kind === "units" ? `${b.units} more ${unitWord(j.unit_label, b.units!)}` : "materials";
    f.notices.push({
      userId: j.client_id,
      n: {
        kind: "extra",
        title: `${n.worker} asks for ${what}: ${kes(amount + fee)}`,
        body: b.reason,
        link: `/jobs/${j.id}`,
        sms: `Mjengo O'clock: ${n.worker} asks to add ${what} (${kes(amount + fee)}) to job ${j.ref}: "${b.reason.slice(0, 60)}". Approve or decline in the app before work continues: ${jobLink(j)}`,
      },
    });
    touch(f, j);
    return x!.id;
  });
}

export async function respondExtra(clientId: string, extraId: string, approve: boolean, phone?: string) {
  const x = await one<{ id: string; job_id: string; amount_kes: number; client_fee_kes: number; status: string }>(db(), `select * from extra_requests where id = $1`, [extraId]);
  if (!x) throw notFound("Request not found");
  const out = await run(async (q, f) => {
    const j = await lockJob(q, x.job_id);
    if (j.client_id !== clientId) throw notFound("Request not found");
    const cur = await one<{ status: string }>(q, `select status from extra_requests where id = $1 for update`, [x.id]);
    if (cur!.status !== "PENDING") throw conflict("This request has already been answered");
    if (j.status !== "ON_SITE" && j.status !== "IN_PROGRESS") throw conflict("The job has moved on; this request has expired");
    const n = await names(q, j);
    if (!approve) {
      await q.query(`update extra_requests set status = 'DECLINED', responded_at = now() where id = $1`, [x.id]);
      await logEvent(q, j.id, { type: "client", id: clientId }, "extra.declined", { extraId: x.id, amount: x.amount_kes });
      f.notices.push({ userId: j.worker_id!, n: { kind: "extra", title: `${n.client} declined the extra ${kes(x.amount_kes)}`, body: "Don't do the extra work; it won't be paid", link: `/work/jobs/${j.id}` } });
      touch(f, j);
      return "declined" as const;
    }
    await q.query(`update extra_requests set status = 'AWAITING_PAYMENT', responded_at = now() where id = $1`, [x.id]);
    await logEvent(q, j.id, { type: "client", id: clientId }, "extra.approved_pending_payment", { extraId: x.id });
    touch(f, j);
    return "pay" as const;
  });
  if (out === "declined") return { status: "DECLINED" as const };
  const j = await one<JobRow>(db(), `select * from jobs where id = $1`, [x.job_id]);
  try {
    const p = await startPayment({ userId: clientId, purpose: "JOB_EXTRA", jobId: x.job_id, refId: x.id, phone: phone!, amount: x.amount_kes + x.client_fee_kes, accountRef: j!.ref.replace("-", ""), description: "Extra work" });
    return { status: "AWAITING_PAYMENT" as const, payment: p };
  } catch (e) {
    // The prompt never went out: let the client answer again.
    await db().query(`update extra_requests set status = 'PENDING', responded_at = null where id = $1 and status = 'AWAITING_PAYMENT'`, [x.id]);
    throw e;
  }
}

export async function onExtraPaid(q: Q, p: PaymentRow, f: Followups) {
  const j = await lockJob(q, p.job_id);
  const x = await one<{ id: string; amount_kes: number; status: string }>(q, `select * from extra_requests where id = $1 for update`, [p.ref_id]);
  if (!x) return;
  if (j.escrow !== "HELD" && j.escrow !== "FROZEN") {
    // Paid after escrow already settled: return it.
    await q.query(`update payments set meta = meta || '{"refund_needed": true}'::jsonb where id = $1`, [p.id]);
    f.then.push(() => adminAlert({ kind: "refund_needed", title: `Late extra payment on ${j.ref} needs a refund`, body: `${kes(p.amount_kes)} receipt ${p.mpesa_receipt ?? ""}`, jobId: j.id }));
    return;
  }
  await q.query(`update extra_requests set status = 'APPROVED' where id = $1`, [x.id]);
  await q.query(`update jobs set extras_kes = extras_kes + $2, paid_kes = paid_kes + $3, updated_at = now() where id = $1`, [j.id, x.amount_kes, p.amount_kes]);
  await logEvent(q, j.id, { type: "client", id: j.client_id }, "extra.paid", { extraId: x.id, amount: x.amount_kes, paid: p.amount_kes, receipt: p.mpesa_receipt });
  const n = await names(q, j);
  if (j.worker_id)
    f.notices.push({ userId: j.worker_id, n: { kind: "extra", title: `Extra ${kes(x.amount_kes)} approved and paid`, body: `${n.client} approved it. Carry on.`, link: `/work/jobs/${j.id}`, sms: `Mjengo O'clock: the extra ${kes(x.amount_kes)} on job ${j.ref} is approved and paid into escrow. Carry on.` } });
  touch(f, j);
}

export async function onExtraFailed(q: Q, p: PaymentRow) {
  await q.query(`update extra_requests set status = 'PENDING', responded_at = null where id = $1 and status = 'AWAITING_PAYMENT'`, [p.ref_id]);
}

// ——— Cancellation (PRD 6, US-06) ———

export type CancelQuote = { allowed: boolean; fee: number; refund: number; rule: string; reason?: string };

export function cancelQuote(j: JobRow, s: Settings, now = Date.now()): CancelQuote {
  const free = (rule: string): CancelQuote => ({ allowed: true, fee: 0, refund: j.paid_kes, rule });
  const fee = (amount: number, rule: string): CancelQuote => {
    const f = Math.min(amount, j.paid_kes);
    return { allowed: true, fee: f, refund: j.paid_kes - f, rule };
  };
  switch (j.status) {
    case "PENDING_PAYMENT":
      return { allowed: true, fee: 0, refund: 0, rule: "Nothing has been paid yet." };
    case "SCHEDULED":
    case "SEARCHING":
    case "UNASSIGNED":
      return free("No worker has accepted yet, so cancelling is free and the full amount is refunded.");
    case "ACCEPTED":
    case "EN_ROUTE":
    case "ON_SITE":
      if (j.worker_no_show_at) return free("Your worker didn't arrive in time, so cancelling is free and the full amount is refunded.");
      if (j.status === "ACCEPTED") {
        if (now - new Date(j.created_at).getTime() <= s.free_cancel_minutes * 60_000) return free(`You booked less than ${s.free_cancel_minutes} minutes ago, so cancelling is free.`);
        return fee(s.late_cancel_fee_kes, `A worker has accepted and it's more than ${s.free_cancel_minutes} minutes since you booked, so a ${kes(s.late_cancel_fee_kes)} fee goes to the worker.`);
      }
      return fee(s.enroute_cancel_fee_kes, `Your worker is already on the way, so a ${kes(s.enroute_cancel_fee_kes)} cancellation fee goes to them.`);
    default:
      return { allowed: false, fee: 0, refund: 0, rule: "", reason: j.status === "IN_PROGRESS" ? "Work has started. Use Report a problem if something is wrong." : "This job can no longer be cancelled." };
  }
}

export async function cancelByClient(clientId: string, jobId: string, reason: string) {
  return run(async (q, f, s) => {
    const j = await lockJob(q, jobId);
    if (j.client_id !== clientId) throw notFound("Job not found");
    const cq = cancelQuote(j, s);
    if (!cq.allowed) throw conflict(cq.reason ?? "This job can't be cancelled");
    const actor: Actor = { type: "client", id: clientId };
    const workerId = j.worker_id;
    const n = await names(q, j);
    await withdrawOffers(q, j.id);
    if (j.paid_kes > 0) {
      await settleEscrow(q, j, actor, { workerGross: cq.fee, flatFee: true }, f);
      await q.query(`update jobs set escrow = $2 where id = $1`, [j.id, cq.fee > 0 ? "SPLIT" : "REFUNDED"]);
    }
    const noShow = Boolean(j.worker_no_show_at && workerId);
    await q.query(`update jobs set outcome = 'cancelled', cancelled_at = now(), cancelled_by = 'client', cancel_reason = $2, closed_at = now() where id = $1`, [j.id, reason]);
    await setStatus(q, j, "CANCELLED", actor, { reason, fee: cq.fee, refund: cq.refund, workerNoShow: noShow });
    if (noShow) {
      await q.query(`update worker_profiles set no_shows = no_shows + 1, flagged = true, flag_reason = 'No-show on ' || $2::text, updated_at = now() where user_id = $1`, [workerId, j.ref]);
      f.then.push(() => adminAlert({ kind: "worker_no_show", title: `${n.worker} no-show: client cancelled ${j.ref}`, userId: workerId, jobId: j.id }));
    }
    if (cq.refund > 0) f.notices.push({ userId: clientId, n: { kind: "job", title: `${j.ref} cancelled`, body: `${kes(cq.refund)} is being refunded to your M-Pesa`, link: `/jobs/${j.id}` } });
    if (workerId)
      f.notices.push({
        userId: workerId,
        n: {
          kind: "job",
          title: `${j.ref} was cancelled by the client`,
          body: cq.fee > 0 ? `You'll receive the ${kes(cq.fee)} cancellation fee` : "No need to go",
          link: "/work",
          sms: `Mjengo O'clock: the client cancelled job ${j.ref}.${cq.fee > 0 ? ` A ${kes(cq.fee)} cancellation fee is being sent to you.` : " You don't need to go."}`,
        },
      });
    touch(f, j, workerId);
    return cq;
  });
}

/** A new time for a job no worker has taken yet (or one the team couldn't fill). */
export async function reschedule(clientId: string, jobId: string, when: string | null) {
  return run(async (q, f, s) => {
    const j = await lockJob(q, jobId);
    if (j.client_id !== clientId) throw notFound("Job not found");
    if (!["SCHEDULED", "SEARCHING", "UNASSIGNED"].includes(j.status)) throw conflict("A worker has already taken this job");
    let at: Date | null = null;
    if (when) {
      at = new Date(when);
      if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 30 * 60_000 || at.getTime() > Date.now() + 14 * 86_400_000) throw badRequest("Pick a time between 30 minutes and 14 days from now");
    }
    await withdrawOffers(q, j.id);
    const later = at && at.getTime() - s.schedule_lead_minutes * 60_000 > Date.now();
    await q.query(`update jobs set scheduled_for = $2, unassigned_at = null where id = $1`, [j.id, at]);
    j.scheduled_for = at;
    if (later) await setStatus(q, j, "SCHEDULED", { type: "client", id: clientId }, { rescheduledTo: at });
    else await setStatus(q, j, "SEARCHING", { type: "client", id: clientId }, { rescheduledTo: at }, "dispatch_started_at = now(), dispatch_round = dispatch_round + 1");
    touch(f, j);
    if (!later) f.then.push(() => offerNext(j.id));
  });
}

// ——— Checkout: approve, tip, dispute (PRD 4.6, 6, US-08) ———

async function release(q: Q, j: JobRow, actor: Actor, f: Followups, auto: boolean) {
  const sp = await settleEscrow(q, j, actor, { workerGross: j.base_kes + j.extras_kes, fullRelease: true }, f);
  await q.query(`update jobs set escrow = 'RELEASED', outcome = 'done', approved_at = now(), auto_released = $2, closed_at = now() where id = $1`, [j.id, auto]);
  await setStatus(q, j, "CLOSED", actor, { auto });
  await q.query(`update worker_profiles set jobs_completed = jobs_completed + 1, updated_at = now() where user_id = $1`, [j.worker_id]);
  const n = await names(q, j);
  f.notices.push({
    userId: j.worker_id!,
    n: { kind: "payout", title: `${j.ref} ${auto ? "auto-released" : "approved"}: ${kes(sp.workerNet)} on its way`, body: `${n.client} · ${j.service_name}`, link: `/work/jobs/${j.id}` },
  });
  return sp;
}

export async function approve(clientId: string, jobId: string) {
  return run(async (q, f) => {
    const j = await lockJob(q, jobId);
    if (j.client_id !== clientId) throw notFound("Job not found");
    if (j.status !== "COMPLETED") throw conflict(j.status === "CLOSED" ? "This job is already approved" : "The worker hasn't marked the job complete yet");
    await release(q, j, { type: "client", id: clientId }, f, false);
    touch(f, j);
  });
}

export async function startTip(clientId: string, jobId: string, amount: number, phone: string) {
  const j = await one<JobRow>(db(), `select * from jobs where id = $1`, [jobId]);
  if (!j || j.client_id !== clientId) throw notFound("Job not found");
  if (!["COMPLETED", "CLOSED"].includes(j.status) || !j.worker_id || j.outcome === "client_no_show") throw conflict("Tips can be added once the work is done");
  if (j.tip_kes > 0) throw conflict("You've already tipped for this job");
  return startPayment({ userId: clientId, purpose: "JOB_TIP", jobId: j.id, phone, amount, accountRef: j.ref.replace("-", ""), description: "Tip" });
}

export async function onTipPaid(q: Q, p: PaymentRow, f: Followups) {
  const j = await lockJob(q, p.job_id);
  await q.query(`update jobs set tip_kes = tip_kes + $2, updated_at = now() where id = $1`, [j.id, p.amount_kes]);
  await logEvent(q, j.id, { type: "client", id: j.client_id }, "tip.paid", { amount: p.amount_kes, receipt: p.mpesa_receipt });
  // Tips go to the worker in full, separately from the escrow release.
  if (j.worker_id) await queuePayout(q, { jobId: j.id, kind: "TIP", userId: j.worker_id, amount: p.amount_kes });
  f.then.push(() => sendJobPayouts(j.id));
  touch(f, j);
}

export async function dispute(clientId: string, jobId: string, b: { reason: string; details: string }, photoIds: string[]) {
  return run(async (q, f, s) => {
    const j = await lockJob(q, jobId);
    if (j.client_id !== clientId) throw notFound("Job not found");
    if (j.status !== "COMPLETED") throw conflict(j.status === "DISPUTED" ? "You've already raised this" : "Only a completed job that isn't approved yet can be disputed");
    if (Date.now() - new Date(j.completed_at!).getTime() > s.dispute_window_hours * 3_600_000) throw conflict(`Disputes can be raised within ${s.dispute_window_hours} hours of completion`);
    await q.query(`insert into disputes (job_id, raised_by, reason, details) values ($1, $2, $3, $4)`, [j.id, clientId, b.reason, b.details]);
    for (const m of photoIds) await q.query(`insert into job_photos (job_id, media_id, kind, uploaded_by) values ($1, $2, 'dispute', $3)`, [j.id, m, clientId]);
    await q.query(`update jobs set escrow = 'FROZEN' where id = $1`, [j.id]);
    await setStatus(q, j, "DISPUTED", { type: "client", id: clientId }, { reason: b.reason, photos: photoIds.length });
    const n = await names(q, j);
    f.notices.push({
      userId: j.worker_id!,
      n: { kind: "dispute", title: `${n.client} raised a concern about ${j.ref}`, body: "Payment is on hold while the team reviews it", link: `/work/jobs/${j.id}`, sms: `Mjengo O'clock: the client raised a concern about job ${j.ref}. Payment is on hold while our team reviews it, usually within 3 business days.` },
    });
    f.notices.push({ userId: clientId, n: { kind: "dispute", title: "We've received your dispute", body: "Payment is frozen. We aim to decide within 3 business days.", link: `/jobs/${j.id}` } });
    f.then.push(() => adminAlert({ kind: "dispute", title: `Dispute on ${j.ref}: ${b.reason}`, body: b.details.slice(0, 200), jobId: j.id }));
    touch(f, j);
  });
}

/** Admin's decision on a dispute: release in full, refund in full, or split (PRD 6). */
export async function resolveDispute(adminId: string, jobId: string, b: { decision: "RELEASE" | "REFUND" | "SPLIT"; workerGross?: number; note: string }) {
  return run(async (q, f) => {
    const j = await lockJob(q, jobId);
    if (j.status !== "DISPUTED") throw conflict("This job isn't in dispute");
    const work = j.base_kes + j.extras_kes;
    const gross = b.decision === "RELEASE" ? work : b.decision === "REFUND" ? 0 : Math.round(b.workerGross ?? -1);
    if (b.decision === "SPLIT" && (gross <= 0 || gross >= work)) throw badRequest(`For a split, the worker's part must be between KES 1 and ${work - 1}`);
    const actor: Actor = { type: "admin", id: adminId };
    const sp = await settleEscrow(q, j, actor, { workerGross: gross, fullRelease: b.decision === "RELEASE" }, f);
    const escrow = b.decision === "RELEASE" ? "RELEASED" : b.decision === "REFUND" ? "REFUNDED" : "SPLIT";
    const outcome = b.decision === "RELEASE" ? "done" : b.decision === "REFUND" ? "refunded" : "split";
    await q.query(`update disputes set status = 'RESOLVED', decision = $2, worker_gross_kes = $3, note = $4, decided_by = $5, decided_at = now() where job_id = $1`, [j.id, b.decision, gross, b.note, adminId]);
    await q.query(`update jobs set escrow = $2, outcome = $3, closed_at = now() where id = $1`, [j.id, escrow, outcome]);
    await setStatus(q, j, "CLOSED", actor, { decision: b.decision, ...sp, note: b.note });
    if (gross > 0) await q.query(`update worker_profiles set jobs_completed = jobs_completed + 1 where user_id = $1`, [j.worker_id]);
    const words = b.decision === "RELEASE" ? "payment released to the worker in full" : b.decision === "REFUND" ? "full refund to the client" : "payment split between client and worker";
    f.notices.push({
      userId: j.client_id,
      n: { kind: "dispute", title: `Decision on ${j.ref}`, body: b.note, link: `/jobs/${j.id}`, sms: `Mjengo O'clock: decision on job ${j.ref}: ${words}.${sp.refund > 0 ? ` ${kes(sp.refund)} is being refunded to you.` : ""} ${b.note}`.slice(0, 320) },
    });
    f.notices.push({
      userId: j.worker_id!,
      n: { kind: "dispute", title: `Decision on ${j.ref}`, body: b.note, link: `/work/jobs/${j.id}`, sms: `Mjengo O'clock: decision on job ${j.ref}: ${words}.${sp.workerNet > 0 ? ` ${kes(sp.workerNet)} is being sent to you.` : ""} ${b.note}`.slice(0, 320) },
    });
    touch(f, j);
    return sp;
  });
}

// ——— Ratings (PRD 4.5) and the quality rules (PRD 5) ———

export async function rate(raterId: string, jobId: string, stars: number, review: string) {
  return run(async (q, f, s) => {
    const j = await lockJob(q, jobId);
    const role = j.client_id === raterId ? "client" : j.worker_id === raterId ? "worker" : null;
    if (!role || !j.worker_id) throw notFound("Job not found");
    if (!["COMPLETED", "DISPUTED", "CLOSED"].includes(j.status) || j.outcome === "cancelled") throw conflict("You can rate once the job is done");
    const ratee = role === "client" ? j.worker_id : j.client_id;
    const ins = await one(q, `insert into ratings (job_id, rater_id, ratee_id, rater_role, stars, review) values ($1,$2,$3,$4,$5,$6) on conflict (job_id, rater_id) do nothing returning id`, [
      j.id, raterId, ratee, role, stars, review,
    ]);
    if (!ins) throw conflict("You've already rated this job");
    await logEvent(q, j.id, { type: role, id: raterId }, "rating.added", { stars });
    if (role !== "client") return;
    await q.query(`update worker_profiles set rating_sum = rating_sum + $2, rating_count = rating_count + 1, updated_at = now() where user_id = $1`, [ratee, stars]);
    // Below the bar over the last N rated jobs: suspended pending review.
    const recent = await one<{ n: number; avg: number }>(
      q,
      `select count(*)::int as n, coalesce(avg(stars), 0)::float as avg from (select stars from ratings where ratee_id = $1 and rater_role = 'client' order by created_at desc limit $2) r`,
      [ratee, s.suspend_after_ratings],
    );
    if (recent && recent.n >= s.suspend_after_ratings && recent.avg < s.suspend_below_rating) {
      const w = await one<{ status: string }>(q, `select status from worker_profiles where user_id = $1`, [ratee]);
      if (w?.status === "approved") {
        const why = `Average rating ${recent.avg.toFixed(2)} over the last ${recent.n} jobs is below ${s.suspend_below_rating}`;
        await q.query(`update worker_profiles set status = 'suspended', available = false, review_reason = $2, updated_at = now() where user_id = $1`, [ratee, why]);
        f.notices.push({ userId: ratee, n: { kind: "account", title: "Your account is paused for review", body: why, link: "/work", sms: `Mjengo O'clock: your worker account is paused for review because your average rating fell below ${s.suspend_below_rating}. The team will be in touch.` } });
        f.then.push(() => adminAlert({ kind: "worker_suspended", title: `Worker suspended for low ratings`, body: why, userId: ratee }));
      }
    }
    touch(f, j);
  });
}

// ——— Admin overrides ———

export async function adminAssign(adminId: string, jobId: string, workerId: string) {
  const pre = await one<JobRow>(db(), `select * from jobs where id = $1`, [jobId]);
  const from = pre ? await workerPoint(db(), workerId) : null;
  return run(async (q, f, s) => {
    const j = await lockJob(q, jobId);
    if (!["SCHEDULED", "SEARCHING", "UNASSIGNED"].includes(j.status)) throw conflict("This job already has a worker or has ended");
    const w = await one<{ status: string; category_id: string }>(q, `select status, category_id from worker_profiles where user_id = $1`, [workerId]);
    if (!w || w.status !== "approved") throw badRequest("Only approved workers can be assigned");
    if (workerId === j.client_id) throw badRequest("A client can't be their own worker");
    await withdrawOffers(q, j.id);
    const minutes = from ? estimateMinutes(from, j) : 45;
    const probation = await one<{ n: number }>(q, `select jobs_completed as n from worker_profiles where user_id = $1`, [workerId]);
    await q.query(
      `update jobs set worker_id = $2, accepted_at = now(), unassigned_at = null, eta_minutes = $3, eta_at = greatest(now() + make_interval(mins => $3), coalesce(scheduled_for, now())), probation = $4 where id = $1`,
      [j.id, workerId, minutes, (probation?.n ?? 0) < s.probation_jobs],
    );
    j.worker_id = workerId;
    await setStatus(q, j, "ACCEPTED", { type: "admin", id: adminId }, { override: "manual_dispatch", worker: workerId });
    const n = await names(q, j);
    const when = j.scheduled_for ? ` for ${whenEAT(j.scheduled_for)}` : "";
    f.notices.push({ userId: workerId, n: { kind: "job", title: `You've been assigned ${j.ref}`, body: `${j.service_name}${when}`, link: `/work/jobs/${j.id}`, sms: `Mjengo O'clock: our team assigned you job ${j.ref} - ${j.service_name}${when}. Open the app for the address: ${link(`/work/jobs/${j.id}`)}` } });
    f.notices.push({ userId: j.client_id, n: { kind: "job", title: `${n.worker} is assigned to your job`, body: j.service_name, link: `/jobs/${j.id}` } });
    touch(f, j);
  });
}

export async function adminRedispatch(adminId: string, jobId: string) {
  return run(async (q, f) => {
    const j = await lockJob(q, jobId);
    if (!["UNASSIGNED", "SEARCHING"].includes(j.status)) throw conflict("Only jobs waiting for a worker can be re-sent");
    await withdrawOffers(q, j.id);
    await q.query(`update jobs set unassigned_at = null where id = $1`, [j.id]);
    await setStatus(q, j, "SEARCHING", { type: "admin", id: adminId }, { override: "redispatch" }, "dispatch_started_at = now(), dispatch_round = dispatch_round + 1");
    touch(f, j);
    f.then.push(() => offerNext(j.id));
  });
}

/** Cancels any open job before completion. The worker may be paid a fee out of what was held; the rest is refunded. */
export async function adminCancel(adminId: string, jobId: string, b: { workerFee: number; note: string }) {
  return run(async (q, f) => {
    const j = await lockJob(q, jobId);
    if (!["PENDING_PAYMENT", "SCHEDULED", "SEARCHING", "UNASSIGNED", ...ACTIVE].includes(j.status)) throw conflict("This job can't be cancelled at this stage; resolve it as a dispute instead");
    const fee = j.worker_id ? Math.max(0, Math.min(Math.round(b.workerFee), j.paid_kes)) : 0;
    const actor: Actor = { type: "admin", id: adminId };
    const workerId = j.worker_id;
    await withdrawOffers(q, j.id);
    if (j.paid_kes > 0) {
      await settleEscrow(q, j, actor, { workerGross: fee, flatFee: true }, f);
      await q.query(`update jobs set escrow = $2 where id = $1`, [j.id, fee > 0 ? "SPLIT" : "REFUNDED"]);
    }
    await q.query(`update jobs set outcome = 'cancelled', cancelled_at = now(), cancelled_by = 'admin', cancel_reason = $2, closed_at = now() where id = $1`, [j.id, b.note]);
    await setStatus(q, j, "CANCELLED", actor, { override: "admin_cancel", fee, note: b.note });
    const refund = j.paid_kes - fee;
    f.notices.push({ userId: j.client_id, n: { kind: "job", title: `${j.ref} was cancelled by our team`, body: b.note, link: `/jobs/${j.id}`, sms: `Mjengo O'clock: our team cancelled job ${j.ref}. ${refund > 0 ? `${kes(refund)} is being refunded to your M-Pesa. ` : ""}${b.note}`.slice(0, 320) } });
    if (workerId) f.notices.push({ userId: workerId, n: { kind: "job", title: `${j.ref} was cancelled by our team`, body: fee > 0 ? `${kes(fee)} fee paid to you` : b.note, link: "/work", sms: `Mjengo O'clock: job ${j.ref} was cancelled by our team.${fee > 0 ? ` A ${kes(fee)} fee is being sent to you.` : ""}` } });
    touch(f, j, workerId);
  });
}

// ——— Timers (run from the job loop) ———

/** Unpaid bookings end after 30 minutes. */
export async function expireUnpaid() {
  const rows = await many<{ id: string }>(db(), `update jobs set status = 'EXPIRED', outcome = 'expired', closed_at = now(), updated_at = now() where status = 'PENDING_PAYMENT' and created_at < now() - interval '30 minutes' returning id`);
  for (const r of rows) await logEvent(db(), r.id, SYSTEM, "status.expired", { reason: "unpaid" });
}

/** Escrow releases to the worker when the client neither approves nor disputes in time (PRD 4.6). */
export async function autoRelease() {
  const s = await getSettings();
  const due = await many<{ id: string }>(db(), `select id from jobs where status = 'COMPLETED' and completed_at < now() - make_interval(hours => $1) order by completed_at limit 50`, [s.auto_release_hours]);
  for (const d of due) {
    await run(async (q, f) => {
      const j = await lockJob(q, d.id);
      if (j.status !== "COMPLETED") return;
      await release(q, j, SYSTEM, f, true);
      f.notices.push({ userId: j.client_id, n: { kind: "job", title: `${j.ref} approved automatically`, body: `No response within ${s.auto_release_hours} hours, so payment was released to the worker`, link: `/jobs/${j.id}` } });
      touch(f, j);
    }).catch((e) => console.error("[job] auto-release", d.id, e));
  }
}

/** A worker not on site 30 minutes after the ETA: the client may cancel free and the team is told (PRD 6). */
export async function detectNoShows() {
  const s = await getSettings();
  const late = await many<JobRow>(
    db(),
    `update jobs set worker_no_show_at = now(), updated_at = now()
      where status in ('ACCEPTED','EN_ROUTE') and worker_no_show_at is null
        and greatest(coalesce(eta_at, accepted_at + interval '60 minutes'), coalesce(scheduled_for, '-infinity'::timestamptz)) + make_interval(mins => $1) < now()
      returning *`,
    [s.no_show_grace_minutes],
  );
  for (const j of late) {
    const f: Followups = { notices: [], then: [] };
    const n = await names(db(), j);
    await logEvent(db(), j.id, SYSTEM, "worker.late", { graceMinutes: s.no_show_grace_minutes });
    f.notices.push({
      userId: j.client_id,
      n: { kind: "job", title: `${n.worker} hasn't arrived`, body: "You can cancel at no charge, or keep waiting", link: `/jobs/${j.id}`, sms: `Mjengo O'clock: ${n.worker} hasn't arrived for job ${j.ref}. You can cancel at no charge in the app, or keep waiting: ${jobLink(j)}` },
    });
    f.notices.push({ userId: j.worker_id!, n: { kind: "job", title: `You're late for ${j.ref}`, body: "The client can now cancel free. Update your status if you're close.", link: `/work/jobs/${j.id}`, sms: `Mjengo O'clock: you're more than ${s.no_show_grace_minutes} min past the ETA for job ${j.ref}. Tap "I've arrived" when you get there.` } });
    await notifyAll(f.notices);
    await adminAlert({ kind: "worker_late", title: `${n.worker} is ${s.no_show_grace_minutes}+ min late for ${j.ref}`, jobId: j.id, userId: j.worker_id });
    emit(j.client_id, "job", { id: j.id });
  }
}

// ——— Safety (PRD 5, US-09) ———

export async function reportProblem(userId: string, b: { jobId?: string | null; kind: "problem" | "emergency"; category: string; message: string; lat?: number | null; lng?: number | null; alertContact: boolean }) {
  let role: "client" | "worker" = "client";
  let j: JobRow | null = null;
  if (b.jobId) {
    j = await one<JobRow>(db(), `select * from jobs where id = $1`, [b.jobId]);
    if (!j || (j.client_id !== userId && j.worker_id !== userId)) throw notFound("Job not found");
    role = j.client_id === userId ? "client" : "worker";
  } else {
    const w = await one(db(), `select 1 from worker_profiles where user_id = $1`, [userId]);
    role = w ? "worker" : "client";
  }
  const u = await one<{ full_name: string; phone: string; emergency_name: string | null; emergency_phone: string | null }>(db(), `select full_name, phone, emergency_name, emergency_phone from users where id = $1`, [userId]);
  const alert = (b.kind === "emergency" || b.alertContact) && Boolean(u?.emergency_phone);
  const r = await one<{ id: string }>(
    db(),
    `insert into reports (job_id, reporter_id, reporter_role, kind, category, message, lat, lng, contact_alerted) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [j?.id ?? null, userId, role, b.kind, b.category, b.message, b.lat ?? null, b.lng ?? null, alert],
  );
  if (j) await logEvent(db(), j.id, { type: role, id: userId }, "report.raised", { reportId: r!.id, kind: b.kind, category: b.category });
  const where = b.lat != null && b.lng != null ? ` Location: https://maps.google.com/?q=${b.lat.toFixed(5)},${b.lng.toFixed(5)}` : j ? ` Address: ${j.address}.` : "";
  if (alert) {
    await queueSms({
      to: u!.emergency_phone!,
      body: `Mjengo O'clock safety alert: ${u!.full_name || u!.phone} (${u!.phone}) raised ${b.kind === "emergency" ? "an emergency" : "a problem"} during a job at ${timeEAT(Date.now())}.${where} Please check on them.`,
      purpose: "emergency_contact",
      userId,
    });
  }
  await adminAlert({
    kind: b.kind === "emergency" ? "emergency" : "report",
    title: `${b.kind === "emergency" ? "EMERGENCY" : "Problem reported"}${j ? ` on ${j.ref}` : ""}: ${b.category}`,
    body: `${role} ${u!.full_name} ${u!.phone}. ${b.message}${where}`.slice(0, 400),
    jobId: j?.id ?? null,
    userId,
    urgent: true,
  });
  return { id: r!.id, contactAlerted: alert };
}

/** Distance in km from a point to the job, for offers and the worker's view. */
export const kmTo = (p: Point, j: Point) => Math.round(haversineKm(p, j) * 10) / 10;
