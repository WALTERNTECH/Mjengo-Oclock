import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { env } from "../config/env.js";
import { requireAdmin, type AdminRole } from "../middleware/auth.js";
import { logEvent } from "../services/audit.js";
import { adminAssign, adminCancel, adminRedispatch, resolveDispute, type JobRow } from "../services/jobflow.js";
import { notify } from "../services/notify.js";
import { paymentDriver, publicPayment, reconcile, type PaymentRow } from "../services/payments.js";
import { announcePaid, payoutDriver, sendPayout } from "../services/payouts.js";
import { DEFAULTS, getSettings, setSettings } from "../services/settings.js";
import { timeline } from "../services/views.js";
import { haversineSql } from "../utils/geo.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../utils/http.js";
import { normalizePhone } from "../utils/kenya.js";
import { mediaUrl } from "../utils/media.js";
import { smsBalance, smsConfigured } from "../utils/sms.js";
import { decrypt, encrypt, hashPassword, newTotpSecret, signAdmin, totpUri, verifyPassword, verifyToken, verifyTotp, type AdminClaims } from "../utils/security.js";
import { catalog } from "./catalog.routes.js";

// The admin console (PRD View 6): worker approvals, open disputes and unassigned bookings,
// plus safety reports, payments and payouts, rates and policies, the team, and the audit
// log. Sign-in is a password and an authenticator code. Every change is audited.

export const adminRouter = Router();

const strict = rateLimit({ windowMs: 15 * 60_000, limit: env.nodeEnv === "test" ? 1000 : 15, standardHeaders: "draft-8", legacyHeaders: false, message: { error: { code: "rate_limited", message: "Too many attempts. Wait a few minutes." } } });

async function audit(req: Request, action: string, targetType: string | null, targetId: string | null, detail: Record<string, unknown> = {}) {
  await db().query(`insert into audit_log (admin_id, action, target_type, target_id, detail) values ($1, $2, $3, $4, $5)`, [req.admin?.id ?? null, action, targetType, targetId, JSON.stringify(detail)]);
}

const uuidParam = (v: unknown) => {
  const s = String(v);
  if (!z.uuid().safeParse(s).success) throw notFound();
  return s;
};

// ——— Sign-in: password, then an authenticator code ———

async function preMfa(req: Request) {
  const h = req.headers.authorization;
  const claims = h?.startsWith("Bearer ") ? verifyToken<AdminClaims>(h.slice(7), "admin") : null;
  if (!claims) throw unauthorized("Start again from the sign-in page");
  const a = await one<{ id: string; email: string; token_version: number; totp_secret: string | null; totp_enabled: boolean }>(
    db(),
    `select id, email, token_version, totp_secret, totp_enabled from admin_users where id = $1`,
    [claims.sub],
  );
  if (!a || a.token_version !== claims.tv) throw unauthorized("Start again from the sign-in page");
  return a;
}

async function enrolment(adminId: string, email: string) {
  const secret = newTotpSecret();
  await db().query(`update admin_users set totp_secret = $2, totp_enabled = false where id = $1`, [adminId, encrypt(secret)]);
  const uri = totpUri(secret, email);
  return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: "#0B0F0C", light: "#FFFFFF" } }) };
}

adminRouter.get("/setup", async (_req, res) => {
  const n = await one<{ n: number }>(db(), `select count(*)::int as n from admin_users`);
  res.json({ needed: n!.n === 0, available: Boolean(env.adminSetupToken) });
});

adminRouter.post("/setup", strict, async (req, res) => {
  const b = z
    .object({ token: z.string().min(1), name: z.string().trim().min(2).max(60), email: z.string().trim().toLowerCase().pipe(z.email()), password: z.string().min(12, "Use at least 12 characters") })
    .parse(req.body);
  const want = Buffer.from(env.adminSetupToken ?? "");
  const got = Buffer.from(b.token);
  if (!env.adminSetupToken || want.length !== got.length || !timingSafeEqual(want, got)) throw forbidden("The setup token is not right");
  const a = await db().tx(async (q) => {
    const n = await one<{ n: number }>(q, `select count(*)::int as n from admin_users`);
    if (n!.n > 0) throw conflict("Setup is already complete");
    return one<{ id: string; token_version: number }>(q, `insert into admin_users (email, name, role, password_hash) values ($1, $2, 'owner', $3) returning id, token_version`, [b.email, b.name, await hashPassword(b.password)]);
  });
  res.status(201).json({ token: signAdmin(a!.id, a!.token_version, false), enrol: await enrolment(a!.id, b.email) });
});

adminRouter.post("/login", strict, async (req, res) => {
  const b = z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }).parse(req.body);
  const a = await one<{ id: string; email: string; password_hash: string; token_version: number; totp_enabled: boolean }>(
    db(),
    `select id, email, password_hash, token_version, totp_enabled from admin_users where email = $1`,
    [b.email],
  );
  if (!a || !(await verifyPassword(b.password, a.password_hash))) throw unauthorized("Those details don't match an admin account");
  res.json({ token: signAdmin(a.id, a.token_version, false), enrol: a.totp_enabled ? null : await enrolment(a.id, a.email) });
});

adminRouter.post("/totp", strict, async (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
  const a = await preMfa(req);
  if (!a.totp_secret || !verifyTotp(decrypt(a.totp_secret), code)) throw badRequest("That code is not right", [{ path: "code", message: "Not right" }]);
  await db().query(`update admin_users set totp_enabled = true, last_login_at = now() where id = $1`, [a.id]);
  await db().query(`insert into audit_log (admin_id, action) values ($1, 'admin.sign_in')`, [a.id]);
  res.json({ token: signAdmin(a.id, a.token_version, true) });
});

adminRouter.get("/me", requireAdmin(), (req, res) => res.json({ admin: req.admin }));

const any = requireAdmin();
const ops = requireAdmin("admin", "ops");
const finance = requireAdmin("admin", "finance");
const owner = requireAdmin("owner");

// ——— Overview and the success metrics (PRD section 2) ———

export async function metrics(days: number) {
  const w = `now() - make_interval(days => ${Math.round(days)})`;
  const m = await one<Record<string, number | null>>(
    db(),
    `with paid as (
       select j.* from jobs j where j.confirmed_at > ${w}
     ), dispatched as (
       select * from paid where status not in ('SCHEDULED','SEARCHING')
         and (accepted_at is not null or status = 'UNASSIGNED' or unassigned_at is not null or exists (select 1 from job_events e where e.job_id = paid.id and e.kind = 'status.accepted'))
     ), accepted0 as (
       select p.*, (select min(e.created_at) from job_events e where e.job_id = p.id and e.kind = 'status.accepted') as first_accept
         from paid p where exists (select 1 from job_events e where e.job_id = p.id and e.kind = 'status.accepted')
     ), accepted as (
       -- Measured from the start of the dispatch round that was accepted, not an earlier round that timed out.
       select a.*, (select max(e.created_at) from job_events e where e.job_id = a.id and e.kind = 'status.searching' and e.created_at <= a.first_accept) as first_search
         from accepted0 a
     )
     select
       (select count(*) from paid)::int as bookings,
       (select count(*) from dispatched)::int as dispatched,
       (select count(*) from accepted)::int as matched,
       (select percentile_cont(0.5) within group (order by extract(epoch from (first_accept - coalesce(first_search, confirmed_at)))) from accepted where first_accept is not null)::float as median_accept_seconds,
       (select count(*) from accepted where status in ('CLOSED','CANCELLED','EXPIRED'))::int as accepted_finished,
       (select count(*) from accepted where outcome in ('done','split') and status = 'CLOSED')::int as completed_paid,
       (select count(*) from accepted where worker_no_show_at is not null and on_site_at is null)::int as no_shows,
       (select count(*) from paid where completed_at is not null)::int as completed,
       (select count(*) from disputes d join paid p on p.id = d.job_id)::int as disputes,
       (select avg(stars) from ratings where rater_role = 'client' and created_at > ${w})::float as avg_rating,
       (select count(*) from ratings where rater_role = 'client' and created_at > ${w})::int as ratings,
       (select count(distinct client_id) from jobs where confirmed_at > now() - interval '60 days')::int as clients_60,
       (select count(*) from (select client_id from jobs where confirmed_at > now() - interval '60 days' group by client_id having count(*) > 1) r)::int as repeat_60,
       (select percentile_cont(0.75) within group (order by ms) from perf_samples where created_at > ${w})::float as load_p75_ms,
       (select percentile_cont(0.5) within group (order by ms) from perf_samples where created_at > ${w})::float as load_p50_ms,
       (select count(*) from perf_samples where created_at > ${w})::int as load_samples`,
  );
  const r = (a: number | null | undefined, b: number | null | undefined) => (b ? Math.round(((a ?? 0) / b) * 1000) / 10 : null);
  return {
    days,
    matchRate: { value: r(m!.matched, m!.dispatched), target: 85, n: m!.dispatched, unit: "%" },
    timeToAccept: { value: m!.median_accept_seconds != null ? Math.round(m!.median_accept_seconds) : null, target: 180, n: m!.matched, unit: "s", lowerIsBetter: true },
    completionRate: { value: r(m!.completed_paid, m!.accepted_finished), target: 90, n: m!.accepted_finished, unit: "%" },
    noShowRate: { value: r(m!.no_shows, m!.matched), target: 3, n: m!.matched, unit: "%", lowerIsBetter: true },
    disputeRate: { value: r(m!.disputes, m!.completed), target: 5, n: m!.completed, unit: "%", lowerIsBetter: true },
    averageRating: { value: m!.avg_rating != null ? Math.round(m!.avg_rating * 100) / 100 : null, target: 4.3, n: m!.ratings, unit: "★" },
    repeatRate: { value: r(m!.repeat_60, m!.clients_60), target: 30, n: m!.clients_60, unit: "%" },
    pageLoad: { value: m!.load_p75_ms != null ? Math.round(m!.load_p75_ms) : null, median: m!.load_p50_ms != null ? Math.round(m!.load_p50_ms) : null, target: 3000, n: m!.load_samples, unit: "ms", lowerIsBetter: true },
    bookings: m!.bookings,
  };
}

// The console polls this for the menu counts (?lite=1 skips the heavier parts) and the
// dashboard reads all of it, most urgent first.
adminRouter.get("/overview", any, async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
  const lite = req.query.lite === "1";
  const today = `(now() at time zone 'Africa/Nairobi')::date`;
  const money = await one<Record<string, number>>(
    db(),
    `select coalesce(sum(platform_kes) filter (where closed_at > now() - interval '30 days'), 0)::int as revenue_30,
            coalesce(sum(platform_kes) filter (where (closed_at at time zone 'Africa/Nairobi')::date = ${today}), 0)::int as revenue_today,
            coalesce(sum(platform_kes) filter (where (closed_at at time zone 'Africa/Nairobi')::date = ${today} - 1), 0)::int as revenue_yesterday,
            coalesce(sum(base_kes + extras_kes) filter (where closed_at > now() - interval '30 days' and outcome in ('done','split')), 0)::int as gmv_30,
            coalesce(sum(paid_kes) filter (where escrow in ('HELD','FROZEN')), 0)::int as in_escrow,
            coalesce(sum(paid_kes) filter (where escrow = 'FROZEN'), 0)::int as frozen,
            (select coalesce(sum(amount_kes), 0) from payouts where status in ('QUEUED','FAILED'))::int as payouts_waiting_kes,
            (select coalesce(sum(amount_kes), 0) from payouts where status = 'PAID' and paid_at > now() - interval '1 day')::int as paid_out_today
       from jobs`,
  );
  const counts = await one<Record<string, number>>(
    db(),
    `select
      (select count(*) from worker_profiles where status = 'submitted')::int as q_applications,
      (select count(*) from jobs where status = 'UNASSIGNED')::int as q_unassigned,
      (select count(*) from jobs where status = 'SEARCHING')::int as searching,
      (select count(*) from disputes where status = 'OPEN')::int as q_disputes,
      (select count(*) from reports where status = 'OPEN')::int as q_reports,
      (select count(*) from reports where status = 'OPEN' and kind = 'emergency')::int as q_emergencies,
      (select count(*) from payouts where status in ('QUEUED','FAILED'))::int as q_payouts,
      (select count(*) from jobs where probation and probation_reviewed_at is null and status = 'CLOSED')::int as q_probation,
      (select count(*) from worker_profiles where status = 'suspended')::int as q_suspended,
      (select count(*) from worker_profiles where flagged and status = 'approved')::int as q_flagged,
      (select count(*) from admin_alerts where seen_at is null)::int as alerts,
      (select count(*) from jobs where status = any($1::text[]))::int as active_jobs,
      (select count(*) from worker_profiles where status = 'approved')::int as workers,
      (select count(*) from worker_profiles where status = 'approved' and available)::int as workers_online,
      (select count(*) from users u where status = 'active' and not exists (select 1 from worker_profiles w where w.user_id = u.id))::int as clients,
      (select count(*) from jobs where status in ('ACCEPTED','EN_ROUTE') and worker_no_show_at is not null)::int as q_late,
      (select count(*) from jobs where status = 'COMPLETED')::int as awaiting_approval,
      (select count(*) from jobs where (confirmed_at at time zone 'Africa/Nairobi')::date = ${today})::int as bookings_today,
      (select count(*) from jobs where (confirmed_at at time zone 'Africa/Nairobi')::date = ${today} - 1)::int as bookings_yesterday,
      (select count(*) from jobs where outcome = 'done' and (closed_at at time zone 'Africa/Nairobi')::date = ${today})::int as completed_today`,
    [["ACCEPTED", "EN_ROUTE", "ON_SITE", "IN_PROGRESS"]],
  );
  if (lite) return res.json({ counts, money, drivers: { payments: paymentDriver(), payouts: payoutDriver(), sms: smsConfigured() ? "celcom" : "log", otpOnScreen: env.otpEcho } });
  const trades = await many(
    db(),
    `select c.id, c.name,
            (select count(*) from worker_profiles w where w.category_id = c.id and w.status = 'approved')::int as approved,
            (select count(*) from worker_profiles w where w.category_id = c.id and w.status = 'approved' and w.available)::int as available,
            (select count(*) from jobs j where j.category_id = c.id and j.status in ('ACCEPTED','EN_ROUTE','ON_SITE','IN_PROGRESS'))::int as busy,
            (select count(*) from jobs j where j.category_id = c.id and j.status in ('SEARCHING','UNASSIGNED'))::int as waiting
       from categories c where c.active order by c.sort`,
  );
  const topWorkers = await many(
    db(),
    `select u.id, u.full_name, c.name as trade, count(j.id)::int as jobs, coalesce(sum(j.worker_net_kes), 0)::int as earned,
            case when w.rating_count > 0 then round(w.rating_sum::numeric / w.rating_count, 1)::float end as rating
       from jobs j join users u on u.id = j.worker_id join worker_profiles w on w.user_id = u.id left join categories c on c.id = w.category_id
      where j.outcome in ('done','split') and j.closed_at > now() - interval '30 days'
      group by u.id, u.full_name, c.name, w.rating_count, w.rating_sum order by jobs desc, earned desc limit 5`,
  );
  const activity = await many(
    db(),
    `select e.kind, e.actor_type, e.created_at, j.id as job_id, j.ref, j.service_name from job_events e join jobs j on j.id = e.job_id
      where e.kind like 'status.%' or e.kind in ('payment.held','extra.requested','report.raised','escrow.settled')
      order by e.created_at desc limit 12`,
  );
  const alerts = await many(db(), `select a.id, a.kind, a.title, a.created_at, a.job_id, j.ref from admin_alerts a left join jobs j on j.id = a.job_id where a.seen_at is null order by a.created_at desc limit 6`);
  const series = await many(
    db(),
    `with days as (select generate_series((now() at time zone 'Africa/Nairobi')::date - 29, (now() at time zone 'Africa/Nairobi')::date, interval '1 day')::date as day)
     select to_char(d.day, 'YYYY-MM-DD') as day,
            (select count(*) from jobs j where (j.confirmed_at at time zone 'Africa/Nairobi')::date = d.day)::int as bookings,
            (select coalesce(sum(platform_kes), 0) from jobs j where (j.closed_at at time zone 'Africa/Nairobi')::date = d.day)::int as revenue
       from days d order by d.day`,
  );
  res.json({ money, counts, series, trades, topWorkers, activity, alerts, metrics: await metrics(days), drivers: { payments: paymentDriver(), payouts: payoutDriver(), sms: smsConfigured() ? "celcom" : "log", otpOnScreen: env.otpEcho, maps: env.maps.mapboxToken ? "mapbox" : "photon + estimate" } });
});

adminRouter.get("/alerts", any, async (req, res) => {
  const rows = await many(db(), `select a.*, j.ref from admin_alerts a left join jobs j on j.id = a.job_id where ($1::boolean or a.seen_at is null) order by a.created_at desc limit 100`, [req.query.all === "1"]);
  res.json({ alerts: rows });
});

adminRouter.post("/alerts/seen", any, async (req, res) => {
  const b = z.object({ ids: z.array(z.uuid()).max(200).optional() }).parse(req.body ?? {});
  if (b.ids?.length) await db().query(`update admin_alerts set seen_at = now(), seen_by = $2 where id = any($1::uuid[]) and seen_at is null`, [b.ids, req.admin!.id]);
  else await db().query(`update admin_alerts set seen_at = now(), seen_by = $1 where seen_at is null`, [req.admin!.id]);
  res.json({ ok: true });
});

// ——— Worker applications and standing (PRD 5, US-05) ———

adminRouter.get("/workers", any, async (req, res) => {
  const status = String(req.query.status ?? "");
  const q = String(req.query.q ?? "").trim();
  const rows = await many(
    db(),
    `select w.user_id as id, u.full_name, u.phone, w.category_id, c.name as category, w.status, w.id_check_status, w.submitted_at, w.approved_at, w.available, w.jobs_completed,
            w.rating_count, case when w.rating_count > 0 then round(w.rating_sum::numeric / w.rating_count, 2)::float end as rating, w.cancellations, w.no_shows, w.flagged, w.flag_reason, w.last_location_at
       from worker_profiles w join users u on u.id = w.user_id left join categories c on c.id = w.category_id
      where ($1 = '' or w.status = $1 or ($1 = 'flagged' and w.flagged))
        and ($2 = '' or u.full_name ilike '%' || $2 || '%' or u.phone like '%' || $2 || '%')
      order by case w.status when 'submitted' then 0 when 'more_info' then 1 when 'suspended' then 2 else 3 end, coalesce(w.submitted_at, w.created_at) desc limit 200`,
    [status, q],
  );
  res.json({ workers: rows });
});

adminRouter.get("/workers/:id", any, async (req, res) => {
  const id = uuidParam(req.params.id);
  const w = await one<Record<string, any>>(
    db(),
    `select w.*, u.full_name, u.phone, u.email, u.home_label, u.home_lat, u.home_lng, u.emergency_name, u.emergency_phone, u.created_at as joined_at, u.status as account_status, c.name as category, c.requires_certificate
       from worker_profiles w join users u on u.id = w.user_id left join categories c on c.id = w.category_id where w.user_id = $1`,
    [id],
  );
  if (!w) throw notFound("Worker not found");
  const ratings = await many(db(), `select r.stars, r.review, r.created_at, j.ref, j.probation from ratings r join jobs j on j.id = r.job_id where r.ratee_id = $1 and r.rater_role = 'client' order by r.created_at desc limit 30`, [id]);
  const jobs = await many(db(), `select id, ref, status, outcome, service_name, probation, probation_reviewed_at, accepted_at, closed_at from jobs where worker_id = $1 order by accepted_at desc nulls last limit 30`, [id]);
  await audit(req, "worker.viewed", "worker", id);
  res.json({
    worker: {
      id, name: w.full_name, phone: w.phone, email: w.email, joinedAt: w.joined_at, accountStatus: w.account_status,
      categoryId: w.category_id, category: w.category, requiresCertificate: w.requires_certificate, bio: w.bio, yearsExperience: w.years_experience,
      // Shown so the team can compare it with the ID photo.
      nationalId: w.national_id_enc ? decrypt(w.national_id_enc) : null,
      documents: { idFront: mediaUrl(w.id_front_media_id), selfie: mediaUrl(w.selfie_media_id), certificate: mediaUrl(w.certificate_media_id) },
      idCheck: { status: w.id_check_status, provider: w.id_check_provider, detail: w.id_check_detail },
      status: w.status, reviewReason: w.review_reason, submittedAt: w.submitted_at, reviewedAt: w.reviewed_at, approvedAt: w.approved_at,
      payout: { method: w.payout_method, phone: w.payout_phone, bankName: w.bank_name, bankBranch: w.bank_branch, accountName: w.bank_account_name, accountNumber: w.bank_account_number },
      home: w.home_lat != null ? { label: w.home_label, lat: w.home_lat, lng: w.home_lng } : null,
      emergency: w.emergency_phone ? { name: w.emergency_name, phone: w.emergency_phone } : null,
      available: w.available, lastLocationAt: w.last_location_at,
      stats: { jobs: w.jobs_completed, rating: w.rating_count ? Math.round((w.rating_sum / w.rating_count) * 100) / 100 : null, ratings: w.rating_count, cancellations: w.cancellations, noShows: w.no_shows },
      flagged: w.flagged, flagReason: w.flag_reason,
    },
    ratings,
    jobs,
  });
});

adminRouter.post("/workers/:id/decision", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ decision: z.enum(["approved", "rejected", "more_info"]), reason: z.string().trim().max(500).default(""), idVerified: z.boolean().optional() }).parse(req.body);
  if (b.decision !== "approved" && b.reason.length < 5) throw badRequest("Give the worker a reason", [{ path: "reason", message: "Required" }]);
  const w = await one<{ status: string; full_name: string }>(db(), `select w.status, u.full_name from worker_profiles w join users u on u.id = w.user_id where w.user_id = $1`, [id]);
  if (!w) throw notFound("Worker not found");
  if (!["submitted", "more_info", "rejected"].includes(w.status)) throw conflict("This application isn't waiting for a decision");
  await db().query(
    `update worker_profiles set status = $2, review_reason = nullif($3, ''), reviewed_by = $4, reviewed_at = now(),
            approved_at = case when $2 = 'approved' then now() else approved_at end,
            id_check_status = case when $2 = 'approved' and $5::boolean then 'verified' else id_check_status end, updated_at = now()
      where user_id = $1`,
    [id, b.decision, b.reason, req.admin!.id, Boolean(b.idVerified)],
  );
  await audit(req, `worker.${b.decision}`, "worker", id, { reason: b.reason });
  const sms =
    b.decision === "approved"
      ? `Mjengo O'clock: your worker application is approved. Open the app and go available to start receiving jobs.${b.reason ? ` ${b.reason}` : ""}`
      : b.decision === "rejected"
        ? `Mjengo O'clock: your worker application was not approved. Reason: ${b.reason}`
        : `Mjengo O'clock: we need more information for your worker application: ${b.reason} Update it in the app.`;
  await notify(id, { kind: "account", title: b.decision === "approved" ? "Application approved" : b.decision === "rejected" ? "Application not approved" : "More information needed", body: b.reason, link: "/work", sms: sms.slice(0, 320) });
  res.json({ ok: true });
});

adminRouter.post("/workers/:id/standing", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ action: z.enum(["suspend", "reinstate", "clear_flag"]), reason: z.string().trim().max(500).default("") }).parse(req.body);
  const w = await one<{ status: string }>(db(), `select status from worker_profiles where user_id = $1`, [id]);
  if (!w) throw notFound("Worker not found");
  if (b.action === "suspend") {
    if (b.reason.length < 5) throw badRequest("Give a reason");
    await db().query(`update worker_profiles set status = 'suspended', available = false, review_reason = $2, updated_at = now() where user_id = $1`, [id, b.reason]);
    await notify(id, { kind: "account", title: "Your worker account is paused", body: b.reason, link: "/work", sms: `Mjengo O'clock: your worker account is paused for review. ${b.reason}`.slice(0, 320) });
  } else if (b.action === "reinstate") {
    if (w.status !== "suspended") throw conflict("This worker isn't suspended");
    await db().query(`update worker_profiles set status = 'approved', flagged = false, flag_reason = null, review_reason = null, updated_at = now() where user_id = $1`, [id]);
    await notify(id, { kind: "account", title: "Your worker account is active again", body: b.reason, link: "/work", sms: `Mjengo O'clock: your worker account is active again. Go available in the app to receive jobs.` });
  } else {
    await db().query(`update worker_profiles set flagged = false, flag_reason = null, updated_at = now() where user_id = $1`, [id]);
  }
  await audit(req, `worker.${b.action}`, "worker", id, { reason: b.reason });
  res.json({ ok: true });
});

// ——— Jobs, dispatch overrides and probation reviews ———

adminRouter.get("/jobs", any, async (req, res) => {
  const status = String(req.query.status ?? "");
  const q = String(req.query.q ?? "").trim();
  const rows = await many(
    db(),
    `select j.id, j.ref, j.status, j.outcome, j.service_name, j.category_id, j.address, j.total_kes, j.paid_kes, j.escrow, j.scheduled_for, j.created_at, j.confirmed_at, j.unassigned_at,
            j.probation, j.probation_reviewed_at, j.worker_no_show_at, c.full_name as client_name, c.phone as client_phone, w.full_name as worker_name
       from jobs j join users c on c.id = j.client_id left join users w on w.id = j.worker_id
      where ($1 = '' or j.status = $1 or ($1 = 'active' and j.status in ('ACCEPTED','EN_ROUTE','ON_SITE','IN_PROGRESS'))
             or ($1 = 'probation' and j.probation and j.probation_reviewed_at is null and j.status = 'CLOSED') or ($1 = 'late' and j.worker_no_show_at is not null and j.status in ('ACCEPTED','EN_ROUTE')))
        and ($2 = '' or j.ref ilike '%' || $2 || '%' or c.phone like '%' || $2 || '%' or c.full_name ilike '%' || $2 || '%' or w.full_name ilike '%' || $2 || '%')
        and not (j.status = 'EXPIRED' and j.paid_kes = 0 and $1 <> 'EXPIRED')
      order by j.created_at desc limit 200`,
    [status, q],
  );
  res.json({ jobs: rows });
});

adminRouter.get("/jobs/:id", any, async (req, res) => {
  const id = uuidParam(req.params.id);
  const j = await one<JobRow & { client_name: string; client_phone: string; worker_name: string | null; worker_phone: string | null }>(
    db(),
    `select j.*, c.full_name as client_name, c.phone as client_phone, w.full_name as worker_name, w.phone as worker_phone
       from jobs j join users c on c.id = j.client_id left join users w on w.id = j.worker_id where j.id = $1`,
    [id],
  );
  if (!j) throw notFound("Job not found");
  const offers = await many(db(), `select o.*, u.full_name from job_offers o join users u on u.id = o.worker_id where o.job_id = $1 order by o.offered_at`, [id]);
  const payments = await many<PaymentRow>(db(), `select * from payments where job_id = $1 order by created_at`, [id]);
  const payouts = await many(db(), `select p.*, u.full_name from payouts p join users u on u.id = p.user_id where p.job_id = $1 order by p.created_at`, [id]);
  const photos = await many<{ media_id: string; kind: string; created_at: Date }>(db(), `select media_id, kind, created_at from job_photos where job_id = $1 order by created_at`, [id]);
  const extras = await many(db(), `select * from extra_requests where job_id = $1 order by created_at`, [id]);
  const dispute = await one(db(), `select * from disputes where job_id = $1`, [id]);
  const reports = await many(db(), `select r.*, u.full_name from reports r join users u on u.id = r.reporter_id where r.job_id = $1 order by r.created_at`, [id]);
  const ratings = await many(db(), `select * from ratings where job_id = $1`, [id]);
  // Candidates for a manual assignment: approved workers in the trade, nearest first.
  const nearby = await many(
    db(),
    `select w.user_id as id, u.full_name, u.phone, w.available, w.last_location_at, w.jobs_completed, case when w.rating_count > 0 then round(w.rating_sum::numeric / w.rating_count, 2)::float end as rating,
            ${haversineSql("coalesce(w.last_lat, u.home_lat)", "coalesce(w.last_lng, u.home_lng)", "$2::float8", "$3::float8")}::float8 as km,
            exists (select 1 from jobs b where b.worker_id = w.user_id and b.status in ('ACCEPTED','EN_ROUTE','ON_SITE','IN_PROGRESS')) as busy
       from worker_profiles w join users u on u.id = w.user_id
      where w.status = 'approved' and w.category_id = $1 and u.status = 'active' and coalesce(w.last_lat, u.home_lat) is not null and w.user_id <> $4
      order by km limit 15`,
    [j.category_id, j.lat, j.lng, j.client_id],
  );
  res.json({
    job: j,
    timeline: await timeline(db(), id, "admin"),
    offers,
    payments: payments.map(publicPayment),
    payouts,
    photos: photos.map((p) => ({ url: mediaUrl(p.media_id), kind: p.kind, at: p.created_at })),
    extras: extras.map((x: Record<string, any>) => ({ ...x, photo: mediaUrl(x.photo_media_id) })),
    dispute,
    reports,
    ratings,
    nearby,
  });
});

adminRouter.post("/jobs/:id/assign", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const { workerId } = z.object({ workerId: z.uuid() }).parse(req.body);
  await adminAssign(req.admin!.id, id, workerId);
  await audit(req, "job.assign", "job", id, { workerId });
  res.json({ ok: true });
});

adminRouter.post("/jobs/:id/redispatch", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  await adminRedispatch(req.admin!.id, id);
  await audit(req, "job.redispatch", "job", id);
  res.json({ ok: true });
});

adminRouter.post("/jobs/:id/cancel", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ workerFee: z.number().int().min(0).default(0), note: z.string().trim().min(5, "Give a reason the client will see").max(300) }).parse(req.body);
  await adminCancel(req.admin!.id, id, b);
  await audit(req, "job.cancel", "job", id, b);
  res.json({ ok: true });
});

adminRouter.post("/jobs/:id/probation-reviewed", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ note: z.string().trim().max(300).default("") }).parse(req.body ?? {});
  const r = await one(db(), `update jobs set probation_reviewed_at = now() where id = $1 and probation and probation_reviewed_at is null returning id`, [id]);
  if (!r) throw conflict("Nothing to review on this job");
  await logEvent(db(), id, { type: "admin", id: req.admin!.id }, "probation.reviewed", { note: b.note });
  await audit(req, "job.probation_reviewed", "job", id, b);
  res.json({ ok: true });
});

// ——— Disputes (PRD 6, US-08) ———

adminRouter.get("/disputes", any, async (req, res) => {
  const status = req.query.status === "RESOLVED" ? "RESOLVED" : "OPEN";
  const rows = await many(
    db(),
    `select d.*, j.ref, j.service_name, j.base_kes, j.extras_kes, j.paid_kes, j.completed_at, c.full_name as client_name, w.full_name as worker_name
       from disputes d join jobs j on j.id = d.job_id join users c on c.id = j.client_id left join users w on w.id = j.worker_id
      where d.status = $1 order by d.created_at ${status === "OPEN" ? "asc" : "desc"} limit 200`,
    [status],
  );
  res.json({ disputes: rows });
});

adminRouter.post("/disputes/:jobId/resolve", ops, async (req, res) => {
  const id = uuidParam(req.params.jobId);
  const b = z.object({ decision: z.enum(["RELEASE", "REFUND", "SPLIT"]), workerGross: z.number().int().min(0).optional(), note: z.string().trim().min(5, "Explain the decision; both sides receive it").max(300) }).parse(req.body);
  const sp = await resolveDispute(req.admin!.id, id, b);
  await audit(req, "dispute.resolve", "job", id, { ...b, ...sp });
  res.json({ ok: true, split: sp });
});

// ——— Safety reports (PRD 5, US-09) ———

adminRouter.get("/reports", any, async (req, res) => {
  const status = String(req.query.status ?? "OPEN");
  const rows = await many(
    db(),
    `select r.*, u.full_name, u.phone, u.emergency_name, u.emergency_phone, j.ref from reports r join users u on u.id = r.reporter_id left join jobs j on j.id = r.job_id
      where ($1 = 'ALL' or r.status = $1 or ($1 = 'OPEN' and r.status = 'ACKNOWLEDGED')) order by (r.kind = 'emergency') desc, r.created_at desc limit 200`,
    [status],
  );
  res.json({ reports: rows });
});

adminRouter.post("/reports/:id", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ status: z.enum(["ACKNOWLEDGED", "CLOSED"]), note: z.string().trim().max(1000).default("") }).parse(req.body);
  const r = await one(db(), `update reports set status = $2, admin_note = nullif($3, ''), handled_by = $4, handled_at = now() where id = $1 returning id`, [id, b.status, b.note, req.admin!.id]);
  if (!r) throw notFound("Report not found");
  await audit(req, `report.${b.status.toLowerCase()}`, "report", id, b);
  res.json({ ok: true });
});

// ——— Money ———

adminRouter.get("/payments", finance, async (req, res) => {
  const status = String(req.query.status ?? "");
  const rows = await many(
    db(),
    `select p.id, p.purpose, p.amount_kes, p.status, p.phone, p.mpesa_receipt, p.result_desc, p.driver, p.created_at, p.completed_at, p.meta, j.ref, j.id as job_id, u.full_name
       from payments p join jobs j on j.id = p.job_id join users u on u.id = p.user_id where ($1 = '' or p.status = $1) order by p.created_at desc limit 500`,
    [status],
  );
  if (req.query.format === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["created_at", "job", "purpose", "amount_kes", "status", "receipt", "phone", "client", "driver"];
    const lines = rows.map((r: Record<string, unknown>) => [r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, r.ref, r.purpose, r.amount_kes, r.status, r.mpesa_receipt, r.phone, r.full_name, r.driver].map(esc).join(","));
    await audit(req, "payments.export", null, null, { rows: rows.length });
    res.type("text/csv").set("Content-Disposition", `attachment; filename="mjengo-payments.csv"`).send([head.join(","), ...lines].join("\n"));
    return;
  }
  res.json({ payments: rows });
});

adminRouter.post("/payments/reconcile", finance, async (req, res) => {
  await reconcile();
  await audit(req, "payments.reconcile", null, null);
  res.json({ ok: true });
});

adminRouter.get("/payouts", finance, async (req, res) => {
  const status = String(req.query.status ?? "");
  const rows = await many(
    db(),
    `select p.*, j.ref, u.full_name from payouts p join jobs j on j.id = p.job_id join users u on u.id = p.user_id
      where ($1 = '' or p.status = $1 or ($1 = 'OPEN' and p.status in ('QUEUED','FAILED','SENDING'))) order by p.created_at desc limit 500`,
    [status],
  );
  res.json({ payouts: rows, driver: payoutDriver() });
});

adminRouter.post("/payouts/:id/send", finance, async (req, res) => {
  const id = uuidParam(req.params.id);
  const r = await sendPayout(id);
  await audit(req, "payout.send", "payout", id, r);
  if (!r.ok) throw conflict(r.error ?? "Could not send");
  res.json({ ok: true });
});

adminRouter.post("/payouts/:id/mark-paid", finance, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ reference: z.string().trim().min(4, "Enter the M-Pesa or bank reference").max(60) }).parse(req.body);
  const p = await one<{ id: string; user_id: string; kind: string; amount_kes: number; method: string; job_id: string }>(
    db(),
    `update payouts set status = 'PAID', paid_at = now(), reference = $2, recorded_by = $3, last_error = null where id = $1 and status in ('QUEUED','FAILED') returning id, user_id, kind, amount_kes, method, job_id`,
    [id, b.reference, req.admin!.id],
  );
  if (!p) throw conflict("This payout isn't waiting to be paid");
  const j = await one<{ ref: string }>(db(), `select ref from jobs where id = $1`, [p.job_id]);
  await logEvent(db(), p.job_id, { type: "admin", id: req.admin!.id }, "payout.recorded", { payout: id, reference: b.reference, amount: p.amount_kes, kind: p.kind });
  await audit(req, "payout.mark_paid", "payout", id, b);
  await announcePaid({ ...p, ref: j!.ref }, b.reference);
  res.json({ ok: true });
});

// ——— Rates and categories (PRD 4.2) ———

adminRouter.get("/catalog", any, async (_req, res) => {
  res.json({ categories: await catalog(true) });
});

adminRouter.put("/categories/:id", ops, async (req, res) => {
  const id = String(req.params.id);
  const b = z
    .object({
      name: z.string().trim().min(2).max(60),
      trade: z.string().trim().min(2).max(40),
      blurb: z.string().trim().max(200),
      section: z.string().trim().max(80).default(""),
      requiresCertificate: z.boolean(),
      active: z.boolean(),
    })
    .parse(req.body);
  const r = await one(db(), `update categories set name = $2, trade = $3, blurb = $4, section = $5, requires_certificate = $6, active = $7 where id = $1 returning id`, [
    id, b.name, b.trade, b.blurb, b.section, b.requiresCertificate, b.active,
  ]);
  if (!r) throw notFound("Category not found");
  await audit(req, "category.update", "category", id, b);
  res.json({ categories: await catalog(true) });
});

const ServiceBody = z
  .object({
    categoryId: z.string().min(1),
    name: z.string().trim().min(3).max(80),
    description: z.string().trim().max(300).default(""),
    pricing: z.enum(["flat", "hourly", "shift", "per_unit"]),
    rate: z.number().int().min(10).max(1_000_000),
    /** What one rate buys: "task" or "visit" (flat), "ft" (per unit). Hour and shift are implied. */
    unit: z.string().trim().max(20).default(""),
    /** Least that can be booked: hours (hourly) or units (per_unit). */
    minQty: z.number().min(0.5).max(10_000).default(1),
    shiftHours: z.number().min(1).max(24).default(8),
    overtimeRate: z.number().int().min(10).max(100_000).nullable().default(null),
    zone: z.enum(["nairobi", "outside"]).default("nairobi"),
    active: z.boolean().default(true),
    sort: z.number().int().min(0).max(999).default(50),
  })
  .transform((b) => ({
    ...b,
    unit: b.pricing === "hourly" ? "hour" : b.pricing === "shift" ? "shift" : b.unit || (b.pricing === "per_unit" ? "unit" : "task"),
    minQty: b.pricing === "hourly" || b.pricing === "per_unit" ? b.minQty : 1,
    overtimeRate: b.pricing === "shift" ? b.overtimeRate : null,
  }));

const serviceParams = (b: z.infer<typeof ServiceBody>) => [b.categoryId, b.name, b.description, b.pricing, b.rate, b.unit, b.minQty, b.shiftHours, b.overtimeRate, b.zone, b.active, b.sort];

adminRouter.post("/services", ops, async (req, res) => {
  const b = ServiceBody.parse(req.body);
  const r = await one<{ id: string }>(
    db(),
    `insert into services (category_id, name, description, pricing, rate_kes, unit_label, min_hours, shift_hours, overtime_rate_kes, zone, active, sort)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    serviceParams(b),
  );
  await audit(req, "service.create", "service", r!.id, b);
  res.status(201).json({ categories: await catalog(true) });
});

adminRouter.put("/services/:id", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = ServiceBody.parse(req.body);
  // Rates are copied onto each job when it's booked, so a change never alters an existing booking.
  const r = await one(
    db(),
    `update services set category_id = $2, name = $3, description = $4, pricing = $5, rate_kes = $6, unit_label = $7, min_hours = $8, shift_hours = $9,
            overtime_rate_kes = $10, zone = $11, active = $12, sort = $13, updated_at = now() where id = $1 returning id`,
    [id, ...serviceParams(b)],
  );
  if (!r) throw notFound("Service not found");
  await audit(req, "service.update", "service", id, b);
  res.json({ categories: await catalog(true) });
});

// ——— Settings: fees, time limits and contacts (PRD 6) ———

adminRouter.get("/settings", any, async (_req, res) => {
  res.json({ settings: await getSettings(), defaults: DEFAULTS, sms: { connected: smsConfigured(), balance: await smsBalance() } });
});

adminRouter.put("/settings", requireAdmin("admin"), async (req, res) => {
  const n = (min: number, max: number) => z.number().min(min).max(max).optional();
  const b = z
    .object({
      client_fee_pct: n(0, 50), worker_fee_pct: n(0, 50),
      late_cancel_fee_kes: n(0, 100_000), enroute_cancel_fee_kes: n(0, 100_000), callout_fee_kes: n(0, 100_000),
      free_cancel_minutes: n(0, 120), offer_window_seconds: n(30, 900), dispatch_timeout_minutes: n(2, 120), schedule_lead_minutes: n(15, 1440),
      auto_release_hours: n(1, 168), dispute_window_hours: n(1, 168), client_wait_minutes: n(5, 120), no_show_grace_minutes: n(5, 240),
      location_stale_seconds: n(30, 900), service_radius_km: n(5, 200), probation_jobs: n(0, 100), suspend_below_rating: n(1, 5), suspend_after_ratings: n(1, 100),
      cancel_flag_threshold: n(1, 50),
      support_phone: z.string().trim().max(20).optional(), support_email: z.string().trim().max(120).optional(), alert_phones: z.string().trim().max(300).optional(),
    })
    .strict()
    .parse(req.body);
  if (b.alert_phones !== undefined) {
    const list = b.alert_phones.split(",").map((p) => p.trim()).filter(Boolean);
    const norm = list.map(normalizePhone);
    if (norm.some((p) => !p)) throw badRequest("Alert numbers must be Kenyan mobile numbers, separated by commas", [{ path: "alert_phones", message: "Check the numbers" }]);
    b.alert_phones = norm.join(",");
  }
  await setSettings(b);
  await audit(req, "settings.update", null, null, b);
  res.json({ settings: await getSettings() });
});

// ——— People ———

adminRouter.get("/users", any, async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const rows = await many(
    db(),
    `select u.id, u.full_name, u.phone, u.email, u.status, u.created_at, u.last_seen_at, w.status as worker_status,
            (select count(*) from jobs j where j.client_id = u.id and j.confirmed_at is not null)::int as bookings,
            (select count(*) from reports r where r.reporter_id = u.id)::int as reports
       from users u left join worker_profiles w on w.user_id = u.id
      where u.status <> 'deleted' and ($1 = '' or u.full_name ilike '%' || $1 || '%' or u.phone like '%' || $1 || '%' or u.email ilike '%' || $1 || '%')
      order by u.created_at desc limit 200`,
    [q],
  );
  res.json({ users: rows });
});

adminRouter.post("/users/:id/status", ops, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ status: z.enum(["active", "suspended"]), reason: z.string().trim().min(5, "Give a reason").max(300) }).parse(req.body);
  const r = await one(db(), `update users set status = $2, token_version = token_version + case when $2 = 'suspended' then 1 else 0 end where id = $1 and status <> 'deleted' returning id`, [id, b.status]);
  if (!r) throw notFound("User not found");
  if (b.status === "suspended") await db().query(`update worker_profiles set available = false where user_id = $1`, [id]);
  await audit(req, `user.${b.status}`, "user", id, b);
  res.json({ ok: true });
});

adminRouter.get("/sms", any, async (_req, res) => {
  const rows = await many<{ id: string; to_phone: string; body: string; purpose: string; status: string; attempts: number; last_error: string | null; created_at: Date; sent_at: Date | null }>(
    db(),
    `select id, to_phone, body, purpose, status, attempts, last_error, created_at, sent_at from sms_outbox order by created_at desc limit 300`,
  );
  // Sign-in codes are never shown, even to admins.
  res.json({ messages: rows.map((m) => (m.purpose === "otp" ? { ...m, body: m.body.replace(/^\d{6}/, "••••••") } : m)), connected: smsConfigured() });
});

adminRouter.get("/audit", requireAdmin("admin"), async (_req, res) => {
  const rows = await many(db(), `select a.*, u.name as admin_name from audit_log a left join admin_users u on u.id = a.admin_id order by a.created_at desc limit 300`);
  res.json({ entries: rows });
});

// ——— Team ———

adminRouter.get("/team", owner, async (_req, res) => {
  res.json({ admins: await many(db(), `select id, email, name, role, totp_enabled, last_login_at, created_at from admin_users order by created_at`) });
});

adminRouter.post("/team", owner, async (req, res) => {
  const b = z
    .object({ name: z.string().trim().min(2).max(60), email: z.string().trim().toLowerCase().pipe(z.email()), role: z.enum(["admin", "ops", "finance"]), password: z.string().min(12, "Use at least 12 characters") })
    .parse(req.body);
  const r = await one<{ id: string }>(db(), `insert into admin_users (email, name, role, password_hash) values ($1, $2, $3, $4) on conflict (email) do nothing returning id`, [b.email, b.name, b.role, await hashPassword(b.password)]);
  if (!r) throw conflict("An admin with that email exists");
  await audit(req, "team.add", "admin", r.id, { email: b.email, role: b.role });
  res.status(201).json({ ok: true });
});

adminRouter.put("/team/:id", owner, async (req, res) => {
  const id = uuidParam(req.params.id);
  const b = z.object({ role: z.enum(["admin", "ops", "finance"]).optional(), resetAuthenticator: z.boolean().optional(), remove: z.boolean().optional() }).parse(req.body);
  if (id === req.admin!.id) throw conflict("Change your own account from another owner's session");
  const target = await one<{ role: AdminRole }>(db(), `select role from admin_users where id = $1`, [id]);
  if (!target) throw notFound("Admin not found");
  if (target.role === "owner") throw forbidden("The owner account can't be changed here");
  if (b.remove) await db().query(`delete from admin_users where id = $1`, [id]);
  else
    await db().query(
      `update admin_users set role = coalesce($2, role), totp_enabled = case when $3 then false else totp_enabled end, totp_secret = case when $3 then null else totp_secret end, token_version = token_version + 1 where id = $1`,
      [id, b.role ?? null, Boolean(b.resetAuthenticator)],
    );
  await audit(req, b.remove ? "team.remove" : "team.update", "admin", id, b);
  res.json({ ok: true });
});
