import { many, one, type Q } from "../config/db.js";
import { shortName } from "../utils/kenya.js";
import { mediaUrl } from "../utils/media.js";
import { areaOf } from "./dispatch.js";
import { ACTIVE, cancelQuote, hourlyRateFor, invoiceLink, TRACKING, unitWord, type JobRow } from "./jobflow.js";
import { pct, unitPhrase } from "./pricing.js";
import type { Settings } from "./settings.js";

// What each person may see of a job. The client sees the worker's verified name, photo and
// rating, and their live location only while the job is active (PRD 5 and 11). The worker
// sees the neighbourhood before accepting and the full address after.

const CLIENT_EVENTS = new Set([
  "job.created", "payment.held", "status.searching", "status.scheduled", "status.accepted", "status.en_route", "status.on_site", "status.in_progress", "status.completed",
  "status.closed", "status.cancelled", "status.unassigned", "status.expired", "status.disputed", "worker.cancelled", "worker.late", "extra.requested", "extra.paid", "extra.declined",
  "tip.paid", "escrow.settled", "rating.added", "report.raised",
]);

export async function timeline(q: Q, jobId: string, audience: "client" | "worker" | "admin") {
  const rows = await many<{ kind: string; actor_type: string; detail: Record<string, unknown>; created_at: Date }>(q, `select kind, actor_type, detail, created_at from job_events where job_id = $1 order by created_at, id`, [jobId]);
  return rows
    .filter((r) => audience === "admin" || (CLIENT_EVENTS.has(r.kind) && !(audience === "worker" && r.kind === "worker.cancelled")))
    .map((r) => ({ kind: r.kind, actor: r.actor_type, at: r.created_at, detail: audience === "admin" ? r.detail : pickPublic(r.kind, r.detail) }));
}
function pickPublic(kind: string, d: Record<string, unknown>) {
  if (kind === "escrow.settled") return { workerNet: d.workerNet, refund: d.refund };
  if (kind.startsWith("extra.")) return { amount: d.amount, kind: d.kind, reason: d.reason };
  if (kind === "status.en_route") return { eta: d.eta };
  if (kind === "status.cancelled") return { fee: d.fee, refund: d.refund };
  return {};
}

async function photos(q: Q, jobId: string, kinds: string[]) {
  const rows = await many<{ media_id: string; kind: string; ref_id: string | null }>(q, `select media_id, kind, ref_id from job_photos where job_id = $1 and kind = any($2::text[]) order by created_at`, [jobId, kinds]);
  return rows.map((r) => ({ url: mediaUrl(r.media_id)!, kind: r.kind, refId: r.ref_id }));
}

async function extras(q: Q, jobId: string) {
  const rows = await many<{ id: string; kind: string; hours: number | null; units: number | null; amount_kes: number; client_fee_kes: number; reason: string; photo_media_id: string | null; status: string; created_at: Date; responded_at: Date | null }>(
    q,
    `select * from extra_requests where job_id = $1 order by created_at`,
    [jobId],
  );
  return rows.map((x) => ({
    id: x.id, kind: x.kind, hours: x.hours, units: x.units, amount: x.amount_kes, fee: x.client_fee_kes, total: x.amount_kes + x.client_fee_kes, reason: x.reason,
    photo: mediaUrl(x.photo_media_id), status: x.status, at: x.created_at,
  }));
}

const money = (n: number) => `KES ${Math.round(n).toLocaleString("en-KE")}`;

/** The booked work as invoice lines: the rate as billed, and overtime past a shift on its own line. */
export function priceLines(j: Pick<JobRow, "service_name" | "pricing" | "rate_kes" | "hours" | "quantity" | "unit_label" | "shift_hours" | "overtime_hours" | "overtime_rate_kes" | "base_kes">) {
  if (j.pricing === "shift") {
    const ot = Math.round(Number(j.overtime_hours) * (j.overtime_rate_kes ?? 0));
    const lines = [{ label: j.service_name, detail: `Standard ${Number(j.shift_hours ?? 8)}-hour shift`, amount: j.base_kes - ot }];
    if (ot > 0) lines.push({ label: "Overtime", detail: `${Number(j.overtime_hours)} h beyond the shift × ${money(j.overtime_rate_kes!)}`, amount: ot });
    return lines;
  }
  const detail =
    j.pricing === "hourly"
      ? `${Number(j.hours)} h × ${money(j.rate_kes)}`
      : j.pricing === "per_unit"
        ? `${Number(j.quantity)} ${unitWord(j.unit_label, Number(j.quantity))} × ${money(j.rate_kes)}`
        : `Fixed rate per ${j.unit_label || "task"}`;
  return [{ label: j.service_name, detail, amount: j.base_kes }];
}

/** The itemised invoice (PRD 4.4): the price, approved extras, the fee, tip, and what came back. */
export async function invoice(q: Q, j: JobRow) {
  const xs = await many<{ kind: string; hours: number | null; units: number | null; amount_kes: number; client_fee_kes: number; reason: string }>(
    q,
    `select kind, hours, units, amount_kes, client_fee_kes, reason from extra_requests where job_id = $1 and status = 'APPROVED' order by created_at`,
    [j.id],
  );
  const lines: { label: string; detail?: string; amount: number }[] = [
    ...priceLines(j),
    ...xs.map((x) => ({
      label: x.kind === "hours" ? `Extra time${x.hours ? ` (${Number(x.hours)} h)` : ""}` : x.kind === "units" ? `Extra ${unitWord(j.unit_label, 2)}${x.units ? ` (${Number(x.units)})` : ""}` : "Materials",
      detail: x.reason,
      amount: x.amount_kes,
    })),
  ];
  const fee = j.client_fee_kes + xs.reduce((a, x) => a + x.client_fee_kes, 0);
  const work = j.base_kes + j.extras_kes;
  return {
    number: j.ref,
    lines,
    subtotal: work,
    feePct: j.client_fee_pct,
    fee,
    tip: j.tip_kes,
    total: work + fee + j.tip_kes,
    paid: j.paid_kes + j.tip_kes,
    refunded: j.refund_kes ?? 0,
    status: j.escrow,
    issuedAt: j.completed_at ?? j.closed_at,
  };
}

async function workerCard(q: Q, workerId: string) {
  const w = await one<{ full_name: string; phone: string; selfie_media_id: string | null; rating_sum: number; rating_count: number; jobs_completed: number; category: string; trade: string; id_check_status: string; status: string; years_experience: number }>(
    q,
    `select u.full_name, u.phone, w.selfie_media_id, w.rating_sum, w.rating_count, w.jobs_completed, c.name as category, c.trade, w.id_check_status, w.status, w.years_experience
       from users u join worker_profiles w on w.user_id = u.id left join categories c on c.id = w.category_id where u.id = $1`,
    [workerId],
  );
  if (!w) return null;
  return {
    id: workerId,
    name: w.full_name,
    shortName: shortName(w.full_name),
    phone: w.phone,
    photo: mediaUrl(w.selfie_media_id),
    rating: w.rating_count ? Math.round((w.rating_sum / w.rating_count) * 10) / 10 : null,
    ratings: w.rating_count,
    jobs: w.jobs_completed,
    category: w.category,
    trade: w.trade,
    years: w.years_experience,
    // Approved after the ID and certificate checks in PRD section 5.
    verified: w.status === "approved" || w.status === "suspended",
  };
}

async function clientRating(q: Q, clientId: string) {
  const r = await one<{ n: number; avg: number | null }>(q, `select count(*)::int as n, avg(stars)::float as avg from ratings where ratee_id = $1 and rater_role = 'worker'`, [clientId]);
  return r?.n ? { rating: Math.round(r.avg! * 10) / 10, ratings: r.n } : { rating: null, ratings: 0 };
}

function common(j: JobRow) {
  return {
    id: j.id,
    ref: j.ref,
    status: j.status,
    outcome: j.outcome,
    service: {
      id: j.service_id, name: j.service_name, category: j.category_id, pricing: j.pricing, rate: j.rate_kes, hours: Number(j.hours), quantity: Number(j.quantity), unit: j.unit_label,
      unitPhrase: unitPhrase(j), shiftHours: j.shift_hours != null ? Number(j.shift_hours) : null, overtimeHours: Number(j.overtime_hours), overtimeRate: j.overtime_rate_kes, zone: j.zone,
    },
    priceLines: priceLines(j),
    description: j.description,
    scheduledFor: j.scheduled_for,
    createdAt: j.created_at,
    confirmedAt: j.confirmed_at,
    acceptedAt: j.accepted_at,
    enRouteAt: j.en_route_at,
    etaMinutes: j.eta_minutes,
    etaAt: j.eta_at,
    onSiteAt: j.on_site_at,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    closedAt: j.closed_at,
    cancelledAt: j.cancelled_at,
    cancelledBy: j.cancelled_by,
    unassignedAt: j.unassigned_at,
    escrow: j.escrow,
  };
}

export async function jobForClient(q: Q, j: JobRow, s: Settings) {
  const worker = j.worker_id ? await workerCard(q, j.worker_id) : null;
  let location: { lat: number; lng: number; at: Date; stale: boolean; accuracy: number | null } | null = null;
  if (j.worker_id && TRACKING.includes(j.status)) {
    const l = await one<{ last_lat: number | null; last_lng: number | null; last_location_at: Date | null; last_accuracy_m: number | null }>(q, `select last_lat, last_lng, last_location_at, last_accuracy_m from worker_profiles where user_id = $1`, [j.worker_id]);
    if (l?.last_lat != null && l.last_lng != null && l.last_location_at)
      location = { lat: l.last_lat, lng: l.last_lng, at: l.last_location_at, stale: Date.now() - new Date(l.last_location_at).getTime() > s.location_stale_seconds * 1000, accuracy: l.last_accuracy_m };
  }
  const myRating = await one<{ stars: number; review: string }>(q, `select stars, review from ratings where job_id = $1 and rater_role = 'client'`, [j.id]);
  const d = await one<{ reason: string; details: string; status: string; decision: string | null; note: string | null; created_at: Date; decided_at: Date | null }>(q, `select reason, details, status, decision, note, created_at, decided_at from disputes where job_id = $1`, [j.id]);
  const pays = await many<{ id: string; purpose: string; amount_kes: number; status: string; mpesa_receipt: string | null; created_at: Date }>(q, `select id, purpose, amount_kes, status, mpesa_receipt, created_at from payments where job_id = $1 order by created_at`, [j.id]);
  const refund = await one<{ amount_kes: number; status: string; reference: string | null }>(q, `select amount_kes, status, reference from payouts where job_id = $1 and kind = 'REFUND'`, [j.id]);
  return {
    ...common(j),
    address: j.address,
    lat: j.lat,
    lng: j.lng,
    addressNotes: j.address_notes,
    price: { base: j.base_kes, clientFeePct: j.client_fee_pct, clientFee: j.client_fee_kes, total: j.total_kes, extras: j.extras_kes, tip: j.tip_kes, paid: j.paid_kes },
    worker: worker && { ...worker, phone: ACTIVE.includes(j.status) ? worker.phone : null },
    location,
    workerLate: Boolean(j.worker_no_show_at) && ACTIVE.includes(j.status),
    photos: await photos(q, j.id, ["request", "completion", "dispute"]),
    extras: await extras(q, j.id),
    timeline: await timeline(q, j.id, "client"),
    cancel: cancelQuote(j, s),
    autoReleaseAt: j.completed_at ? new Date(new Date(j.completed_at).getTime() + s.auto_release_hours * 3_600_000) : null,
    disputeUntil: j.completed_at ? new Date(new Date(j.completed_at).getTime() + s.dispute_window_hours * 3_600_000) : null,
    dispute: d,
    myRating,
    invoice: ["COMPLETED", "DISPUTED", "CLOSED"].includes(j.status) && j.outcome !== "cancelled" ? await invoice(q, j) : null,
    invoiceUrl: j.completed_at ? invoiceLink(j) : null,
    payments: pays.map((p) => ({ id: p.id, purpose: p.purpose, amount: p.amount_kes, status: p.status, receipt: p.mpesa_receipt, at: p.created_at })),
    refund: refund && { amount: refund.amount_kes, status: refund.status, reference: refund.reference },
  };
}

export async function jobForWorker(q: Q, j: JobRow, s: Settings) {
  const c = await one<{ full_name: string; phone: string }>(q, `select full_name, phone from users where id = $1`, [j.client_id]);
  const myRating = await one<{ stars: number; review: string }>(q, `select stars, review from ratings where job_id = $1 and rater_role = 'worker'`, [j.id]);
  const theirRating = await one<{ stars: number; review: string }>(q, `select stars, review from ratings where job_id = $1 and rater_role = 'client'`, [j.id]);
  const pay = await many<{ kind: string; amount_kes: number; status: string; reference: string | null; method: string }>(q, `select kind, amount_kes, status, reference, method from payouts where job_id = $1 and kind <> 'REFUND'`, [j.id]);
  const d = await one<{ reason: string; status: string; decision: string | null; note: string | null }>(q, `select reason, status, decision, note from disputes where job_id = $1`, [j.id]);
  const baseNet = j.base_kes - pct(j.base_kes, j.worker_fee_pct);
  const extrasNet = j.extras_kes - pct(j.extras_kes, j.worker_fee_pct);
  return {
    ...common(j),
    address: j.address,
    lat: j.lat,
    lng: j.lng,
    addressNotes: j.address_notes,
    client: { name: shortName(c!.full_name) || "Client", phone: ACTIVE.includes(j.status) ? c!.phone : null, ...(await clientRating(q, j.client_id)) },
    earnings: { base: j.base_kes, workerFeePct: j.worker_fee_pct, baseNet, extras: j.extras_kes, extrasNet, expected: baseNet + extrasNet, paidOut: j.worker_net_kes, tip: j.tip_kes },
    payouts: pay.map((p) => ({ kind: p.kind, amount: p.amount_kes, status: p.status, reference: p.reference, method: p.method })),
    photos: await photos(q, j.id, ["request", "completion"]),
    extras: await extras(q, j.id),
    timeline: await timeline(q, j.id, "worker"),
    late: Boolean(j.worker_no_show_at),
    clientNoShowFrom: j.on_site_at && j.status === "ON_SITE" ? new Date(new Date(j.on_site_at).getTime() + s.client_wait_minutes * 60_000) : null,
    calloutFee: s.callout_fee_kes,
    myRating,
    theirRating,
    dispute: d,
    probation: j.probation,
    // What the worker can ask for on site: extra time at this rate (null: they state the amount), or more units.
    extraRates: { hourly: await hourlyRateFor(q, j), unit: j.pricing === "per_unit" ? j.rate_kes : null, unitLabel: j.unit_label },
  };
}

/** What a worker sees before accepting: the neighbourhood, distance, pay and the job itself. */
export async function offerView(q: Q, o: { id: string; distance_km: number; expires_at: Date; offered_at: Date }, j: JobRow) {
  const baseNet = j.base_kes - pct(j.base_kes, j.worker_fee_pct);
  return {
    offerId: o.id,
    jobId: j.id,
    ref: j.ref,
    service: { name: j.service_name, category: j.category_id, pricing: j.pricing, hours: Number(j.hours), quantity: Number(j.quantity), unit: j.unit_label, overtimeHours: Number(j.overtime_hours), zone: j.zone },
    summary: priceLines(j).map((l) => l.detail).join(" + "),
    area: areaOf(j.address),
    distanceKm: o.distance_km,
    earn: baseNet,
    description: j.description,
    scheduledFor: j.scheduled_for,
    photos: await photos(q, j.id, ["request"]),
    client: await clientRating(q, j.client_id),
    offeredAt: o.offered_at,
    expiresAt: o.expires_at,
  };
}
