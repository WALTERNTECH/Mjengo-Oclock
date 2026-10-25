import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { env } from "../config/env.js";
import { requireApprovedWorker, requireAuth, requireWorker } from "../middleware/auth.js";
import { adminAlert } from "../services/audit.js";
import { acceptOffer, declineOffer } from "../services/dispatch.js";
import { emit } from "../services/events.js";
import { idVerifier } from "../services/idcheck.js";
import { arrive, clientNoShow, complete, rate, requestExtra, startTrip, startWork, TRACKING, workerCancel, type JobRow } from "../services/jobflow.js";
import { getSettings } from "../services/settings.js";
import { jobForWorker, offerView } from "../services/views.js";
import { badRequest, conflict, notFound } from "../utils/http.js";
import { normalizePhone } from "../utils/kenya.js";
import { mediaUrl, storeImage, upload } from "../utils/media.js";
import { decrypt, encrypt } from "../utils/security.js";

// The trade professional's side: the application and vetting (PRD 5, US-05, View 5),
// availability and live location, offers (US-02), and the job itself (US-03, US-07).

export const workerRouter = Router();

// ——— Application ———

async function profileView(userId: string) {
  const w = await one<Record<string, any>>(db(), `select * from worker_profiles where user_id = $1`, [userId]);
  if (!w) return null;
  const cat = w.category_id ? await one<{ name: string; requires_certificate: boolean }>(db(), `select name, requires_certificate from categories where id = $1`, [w.category_id]) : null;
  return {
    status: w.status,
    categoryId: w.category_id,
    category: cat?.name ?? null,
    requiresCertificate: Boolean(cat?.requires_certificate),
    bio: w.bio,
    yearsExperience: w.years_experience,
    nationalIdLast4: w.national_id_last4,
    documents: { idFront: mediaUrl(w.id_front_media_id), selfie: mediaUrl(w.selfie_media_id), certificate: mediaUrl(w.certificate_media_id) },
    idCheck: w.id_check_status,
    reviewReason: w.review_reason,
    submittedAt: w.submitted_at,
    approvedAt: w.approved_at,
    payout: { method: w.payout_method, phone: w.payout_phone, bankName: w.bank_name, bankBranch: w.bank_branch, accountName: w.bank_account_name, accountNumber: w.bank_account_number ? `••••${String(w.bank_account_number).slice(-4)}` : null },
    available: w.available,
    lastLocationAt: w.last_location_at,
    stats: { jobs: w.jobs_completed, rating: w.rating_count ? Math.round((w.rating_sum / w.rating_count) * 10) / 10 : null, ratings: w.rating_count, cancellations: w.cancellations, noShows: w.no_shows },
    probationLeft: Math.max(0, (await getSettings()).probation_jobs - w.jobs_completed),
    flagged: w.flagged,
  };
}

workerRouter.get("/profile", requireAuth, async (req, res) => {
  res.json({ profile: await profileView(req.user!.id) });
});

const EDITABLE = ["draft", "more_info", "rejected"];

workerRouter.put("/profile", requireAuth, async (req, res) => {
  const b = z
    .object({
      categoryId: z.string().min(1, "Choose your trade"),
      bio: z.string().trim().max(600).default(""),
      yearsExperience: z.coerce.number().int().min(0).max(60).default(0),
      nationalId: z.string().trim().regex(/^\d{6,10}$/, "Enter your ID number (digits only)").optional(),
      payoutMethod: z.enum(["mpesa", "bank"]),
      payoutPhone: z.string().trim().optional(),
      bankName: z.string().trim().max(80).optional(),
      bankBranch: z.string().trim().max(80).optional(),
      accountName: z.string().trim().max(80).optional(),
      accountNumber: z.string().trim().regex(/^\d{6,20}$/, "Account number: digits only").optional(),
    })
    .parse(req.body);
  const id = req.user!.id;
  const cat = await one(db(), `select 1 from categories where id = $1 and active`, [b.categoryId]);
  if (!cat) throw badRequest("Choose your trade", [{ path: "categoryId", message: "Required" }]);
  const payoutPhone = b.payoutPhone ? normalizePhone(b.payoutPhone) : null;
  if (b.payoutMethod === "mpesa" && b.payoutPhone && !payoutPhone) throw badRequest("Enter a Kenyan M-Pesa number", [{ path: "payoutPhone", message: "Not a Kenyan number" }]);
  if (b.payoutMethod === "bank" && (!b.bankName || !b.accountName)) throw badRequest("Enter the bank and account name", [{ path: "bankName", message: "Required" }]);
  const cur = await one<{ status: string; bank_account_number: string | null }>(db(), `select status, bank_account_number from worker_profiles where user_id = $1`, [id]);
  if (cur && !EDITABLE.includes(cur.status)) {
    // After submission only payout details can change.
    await db().query(
      `update worker_profiles set payout_method = $2, payout_phone = $3, bank_name = $4, bank_branch = $5, bank_account_name = $6, bank_account_number = coalesce($7, bank_account_number), updated_at = now() where user_id = $1`,
      [id, b.payoutMethod, payoutPhone, b.bankName ?? null, b.bankBranch ?? null, b.accountName ?? null, b.accountNumber ?? null],
    );
    return res.json({ profile: await profileView(id) });
  }
  await db().query(
    `insert into worker_profiles (user_id, category_id, bio, years_experience, national_id_last4, national_id_enc, payout_method, payout_phone, bank_name, bank_branch, bank_account_name, bank_account_number)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (user_id) do update set category_id = excluded.category_id, bio = excluded.bio, years_experience = excluded.years_experience,
        national_id_last4 = coalesce(excluded.national_id_last4, worker_profiles.national_id_last4), national_id_enc = coalesce(excluded.national_id_enc, worker_profiles.national_id_enc),
        payout_method = excluded.payout_method, payout_phone = excluded.payout_phone, bank_name = excluded.bank_name, bank_branch = excluded.bank_branch,
        bank_account_name = excluded.bank_account_name, bank_account_number = coalesce(excluded.bank_account_number, worker_profiles.bank_account_number), updated_at = now()`,
    [
      id, b.categoryId, b.bio, b.yearsExperience, b.nationalId ? b.nationalId.slice(-4) : null, b.nationalId ? encrypt(b.nationalId) : null,
      b.payoutMethod, payoutPhone, b.bankName ?? null, b.bankBranch ?? null, b.accountName ?? null, b.accountNumber ?? null,
    ],
  );
  res.json({ profile: await profileView(id) });
});

const DOCS = { "id-front": "id_front_media_id", selfie: "selfie_media_id", certificate: "certificate_media_id" } as const;

workerRouter.post("/documents/:kind", requireWorker, upload.single("file"), async (req, res) => {
  const kind = String(req.params.kind) as keyof typeof DOCS;
  if (!(kind in DOCS)) throw notFound();
  if (!req.file) throw badRequest("Choose a photo");
  const cur = await one<Record<string, string | null> & { status: string }>(db(), `select status, ${Object.values(DOCS).join(", ")} from worker_profiles where user_id = $1`, [req.user!.id]);
  if (!cur || !EDITABLE.includes(cur.status)) throw conflict("Documents can be changed only before you submit, or when the team asks for more information");
  const id = await storeImage(db(), req.user!.id, kind === "id-front" ? "id_front" : (kind as "selfie" | "certificate"), req.file, 2000);
  const old = cur[DOCS[kind]];
  await db().query(`update worker_profiles set ${DOCS[kind]} = $2, updated_at = now() where user_id = $1`, [req.user!.id, id]);
  if (old) await db().query(`delete from media where id = $1`, [old]);
  res.status(201).json({ profile: await profileView(req.user!.id) });
});

workerRouter.post("/submit", requireWorker, async (req, res) => {
  const id = req.user!.id;
  const w = await one<Record<string, any>>(db(), `select w.*, c.requires_certificate, u.full_name, u.home_lat, u.terms_accepted_at from worker_profiles w join users u on u.id = w.user_id left join categories c on c.id = w.category_id where w.user_id = $1`, [id]);
  if (!w || !EDITABLE.includes(w.status)) throw conflict("This application has already been submitted");
  const missing = [
    !w.full_name && "your full name",
    !w.category_id && "your trade",
    !w.national_id_enc && "your national ID number",
    !w.id_front_media_id && "a photo of your national ID",
    !w.selfie_media_id && "a selfie",
    w.requires_certificate && !w.certificate_media_id && "your trade certificate or a reference letter",
    w.home_lat == null && "your base location",
    w.payout_method === "mpesa" ? false : !w.bank_account_number && "your bank account number",
    !w.terms_accepted_at && "agreement to the terms",
  ].filter(Boolean);
  if (missing.length) throw badRequest(`Add ${missing.join(", ")} before submitting`);
  const outcome = await idVerifier().check(db(), { userId: id, fullName: w.full_name, nationalId: decrypt(w.national_id_enc), idFrontMediaId: w.id_front_media_id, selfieMediaId: w.selfie_media_id });
  await db().query(
    `update worker_profiles set status = 'submitted', submitted_at = now(), review_reason = null, id_check_status = $2, id_check_provider = $3, id_check_detail = $4, updated_at = now() where user_id = $1`,
    [id, outcome.status, outcome.provider, JSON.stringify(outcome.detail)],
  );
  await adminAlert({ kind: "application", title: `New worker application: ${w.full_name}`, body: outcome.status === "verified" ? "ID verified automatically; review the certificate" : "ID needs a manual check", userId: id });
  res.json({ profile: await profileView(id) });
});

// ——— Availability and location ———

workerRouter.post("/availability", requireApprovedWorker, async (req, res) => {
  const b = z.object({ available: z.boolean(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).optional() }).parse(req.body);
  if (b.available) {
    const u = await one<{ location_consent_at: Date | null; home_lat: number | null }>(db(), `select location_consent_at, home_lat from users where id = $1`, [req.user!.id]);
    if (!u?.location_consent_at) throw conflict("Allow location sharing first, so jobs near you can reach you", "location_consent");
  }
  await db().query(
    `update worker_profiles set available = $2,
            last_lat = coalesce($3::float8, last_lat), last_lng = coalesce($4::float8, last_lng), last_accuracy_m = coalesce($5::float8, last_accuracy_m),
            last_location_at = case when $3::float8 is null then last_location_at else now() end, updated_at = now()
      where user_id = $1`,
    [req.user!.id, b.available, b.lat ?? null, b.lng ?? null, b.accuracy ?? null],
  );
  res.json({ profile: await profileView(req.user!.id) });
});

const locationLimit = rateLimit({ windowMs: 60_000, limit: env.nodeEnv === "test" ? 10_000 : 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: { code: "rate_limited", message: "Slow down location updates" } } });

workerRouter.post("/location", requireApprovedWorker, locationLimit, async (req, res) => {
  const b = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100_000).optional() }).parse(req.body);
  const u = await one<{ location_consent_at: Date | null }>(db(), `select location_consent_at from users where id = $1`, [req.user!.id]);
  if (!u?.location_consent_at) throw conflict("Location sharing is off", "location_consent");
  await db().query(`update worker_profiles set last_lat = $2, last_lng = $3, last_accuracy_m = $4, last_location_at = now() where user_id = $1`, [req.user!.id, b.lat, b.lng, b.accuracy ?? null]);
  // Passed to the client only while the job is active.
  const active = await one<{ id: string; client_id: string }>(db(), `select id, client_id from jobs where worker_id = $1 and status = any($2::text[]) order by accepted_at desc limit 1`, [req.user!.id, TRACKING]);
  if (active) emit(active.client_id, "location", { jobId: active.id, lat: b.lat, lng: b.lng, accuracy: b.accuracy ?? null, at: new Date() });
  res.json({ ok: true, sharingWith: active ? active.id : null });
});

// ——— Offers ———

workerRouter.get("/offer", requireApprovedWorker, async (req, res) => {
  const o = await one<{ id: string; job_id: string; distance_km: number; expires_at: Date; offered_at: Date }>(
    db(),
    `select id, job_id, distance_km, expires_at, offered_at from job_offers where worker_id = $1 and status = 'PENDING' and expires_at > now() limit 1`,
    [req.user!.id],
  );
  if (!o) return res.json({ offer: null });
  const j = await one<JobRow>(db(), `select * from jobs where id = $1`, [o.job_id]);
  res.json({ offer: await offerView(db(), o, j!) });
});

workerRouter.post("/offers/:id/accept", requireApprovedWorker, async (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) throw notFound("Offer not found");
  res.json(await acceptOffer(req.user!.id, String(req.params.id)));
});

workerRouter.post("/offers/:id/decline", requireApprovedWorker, async (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) throw notFound("Offer not found");
  await declineOffer(req.user!.id, String(req.params.id));
  res.json({ ok: true });
});

// ——— Jobs ———

workerRouter.get("/jobs", requireWorker, async (req, res) => {
  const rows = await many<{ id: string; ref: string; status: string; outcome: string | null; service_name: string; address: string; base_kes: number; worker_fee_pct: number; worker_net_kes: number | null; scheduled_for: Date | null; accepted_at: Date | null; completed_at: Date | null; client_name: string }>(
    db(),
    `select j.id, j.ref, j.status, j.outcome, j.service_name, j.address, j.base_kes, j.worker_fee_pct, j.worker_net_kes, j.scheduled_for, j.accepted_at, j.completed_at, c.full_name as client_name
       from jobs j join users c on c.id = j.client_id where j.worker_id = $1 order by coalesce(j.accepted_at, j.created_at) desc limit 100`,
    [req.user!.id],
  );
  res.json({
    jobs: rows.map((r) => ({
      id: r.id, ref: r.ref, status: r.status, outcome: r.outcome, service: r.service_name, address: r.address, earn: r.worker_net_kes ?? r.base_kes - Math.round((r.base_kes * r.worker_fee_pct) / 100),
      scheduledFor: r.scheduled_for, acceptedAt: r.accepted_at, completedAt: r.completed_at, client: r.client_name.split(" ")[0],
    })),
  });
});

async function myJob(workerId: string, id: string) {
  if (!z.uuid().safeParse(id).success) throw notFound("Job not found");
  const j = await one<JobRow>(db(), `select * from jobs where id = $1`, [id]);
  if (!j || j.worker_id !== workerId) throw notFound("Job not found");
  return j;
}
const view = async (id: string) => jobForWorker(db(), (await one<JobRow>(db(), `select * from jobs where id = $1`, [id]))!, await getSettings());

workerRouter.get("/jobs/:id", requireWorker, async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  res.json({ job: await view(j.id) });
});

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).partial();

workerRouter.post("/jobs/:id/trip", requireApprovedWorker, async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const p = point.parse(req.body ?? {});
  await startTrip(req.user!.id, j.id, p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null);
  res.json({ job: await view(j.id) });
});

workerRouter.post("/jobs/:id/arrive", requireApprovedWorker, async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  await arrive(req.user!.id, j.id);
  res.json({ job: await view(j.id) });
});

workerRouter.post("/jobs/:id/start", requireApprovedWorker, async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  await startWork(req.user!.id, j.id);
  res.json({ job: await view(j.id) });
});

workerRouter.post("/jobs/:id/complete", requireApprovedWorker, upload.array("photos", 3), async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  if (j.status !== "IN_PROGRESS") throw conflict("Start the job before marking it complete");
  for (const f of (req.files as Express.Multer.File[] | undefined) ?? []) {
    const m = await storeImage(db(), req.user!.id, "completion", f);
    await db().query(`insert into job_photos (job_id, media_id, kind, uploaded_by) values ($1, $2, 'completion', $3)`, [j.id, m, req.user!.id]);
  }
  await complete(req.user!.id, j.id);
  res.json({ job: await view(j.id) });
});

workerRouter.post("/jobs/:id/cancel", requireWorker, async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ reason: z.string().trim().min(3, "Say why you're cancelling").max(300) }).parse(req.body);
  await workerCancel(req.user!.id, j.id, b.reason);
  res.json({ ok: true });
});

workerRouter.post("/jobs/:id/no-show", requireApprovedWorker, async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ note: z.string().trim().min(3, "Say what happened").max(500) }).parse(req.body);
  await clientNoShow(req.user!.id, j.id, b.note);
  res.json({ job: await view(j.id) });
});

workerRouter.post("/jobs/:id/extras", requireApprovedWorker, upload.single("photo"), async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z
    .object({
      kind: z.enum(["hours", "materials"]),
      hours: z.coerce.number().positive().max(12).optional(),
      amount: z.coerce.number().int().positive().optional(),
      reason: z.string().trim().min(5, "Explain what the extra is for").max(300),
    })
    .parse(req.body);
  if (!req.file) throw badRequest("Add a photo showing why the extra is needed", [{ path: "photo", message: "Required" }]);
  const photo = await storeImage(db(), req.user!.id, "extra", req.file);
  await requestExtra(req.user!.id, j.id, b, photo);
  res.status(201).json({ job: await view(j.id) });
});

workerRouter.post("/jobs/:id/rate", requireWorker, async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ stars: z.number().int().min(1).max(5), review: z.string().trim().max(1000).default("") }).parse(req.body);
  await rate(req.user!.id, j.id, b.stars, b.review);
  res.json({ job: await view(j.id) });
});

workerRouter.get("/earnings", requireWorker, async (req, res) => {
  const id = req.user!.id;
  const totals = await one<Record<string, number>>(
    db(),
    `select coalesce(sum(amount_kes) filter (where status = 'PAID'), 0)::int as paid,
            coalesce(sum(amount_kes) filter (where status in ('QUEUED','SENDING','FAILED')), 0)::int as pending,
            coalesce(sum(amount_kes) filter (where status = 'PAID' and paid_at > now() - interval '7 days'), 0)::int as week,
            coalesce(sum(amount_kes) filter (where kind = 'TIP' and status = 'PAID'), 0)::int as tips
       from payouts where user_id = $1 and kind in ('WORKER','TIP')`,
    [id],
  );
  const held = await one<{ n: number }>(db(), `select coalesce(sum(base_kes + extras_kes - round((base_kes + extras_kes) * worker_fee_pct / 100)), 0)::int as n from jobs where worker_id = $1 and escrow in ('HELD','FROZEN') and status in ('IN_PROGRESS','COMPLETED','DISPUTED')`, [id]);
  const rows = await many<{ id: string; kind: string; amount_kes: number; status: string; method: string; reference: string | null; created_at: Date; paid_at: Date | null; ref: string; service_name: string }>(
    db(),
    `select p.id, p.kind, p.amount_kes, p.status, p.method, p.reference, p.created_at, p.paid_at, j.ref, j.service_name from payouts p join jobs j on j.id = p.job_id
      where p.user_id = $1 and p.kind in ('WORKER','TIP') order by p.created_at desc limit 100`,
    [id],
  );
  res.json({
    totals: { ...totals, inEscrow: held!.n },
    payouts: rows.map((r) => ({ id: r.id, kind: r.kind, amount: r.amount_kes, status: r.status, method: r.method, reference: r.reference, createdAt: r.created_at, paidAt: r.paid_at, ref: r.ref, service: r.service_name })),
  });
});
