import { Router } from "express";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import {
  approve, cancelByClient, cancelQuote, createJob, dispute, payHold, rate, reschedule, respondExtra, startTip, type JobRow,
} from "../services/jobflow.js";
import { getSettings } from "../services/settings.js";
import { jobForClient } from "../services/views.js";
import { badRequest, conflict, notFound } from "../utils/http.js";
import { storeImage, upload } from "../utils/media.js";
import { phoneField } from "./auth.routes.js";

// The client's side of a job (PRD 7: US-01, US-03, US-04, US-06, US-07, US-08).

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

const uuid = z.uuid();
async function myJob(clientId: string, id: string): Promise<JobRow> {
  if (!uuid.safeParse(id).success) throw notFound("Job not found");
  const j = await one<JobRow>(db(), `select * from jobs where id = $1`, [id]);
  if (!j || j.client_id !== clientId) throw notFound("Job not found");
  return j;
}
async function view(id: string) {
  const s = await getSettings();
  const j = await one<JobRow>(db(), `select * from jobs where id = $1`, [id]);
  return jobForClient(db(), j!, s);
}

jobsRouter.get("/", async (req, res) => {
  const rows = await many<{ id: string; ref: string; status: string; outcome: string | null; service_name: string; category_id: string; address: string; total_kes: number; paid_kes: number; scheduled_for: Date | null; created_at: Date; worker_name: string | null }>(
    db(),
    `select j.id, j.ref, j.status, j.outcome, j.service_name, j.category_id, j.address, j.total_kes, j.paid_kes, j.scheduled_for, j.created_at, w.full_name as worker_name
       from jobs j left join users w on w.id = j.worker_id where j.client_id = $1 and not (j.status = 'EXPIRED' and j.paid_kes = 0) order by j.created_at desc limit 100`,
    [req.user!.id],
  );
  res.json({ jobs: rows.map((r) => ({ id: r.id, ref: r.ref, status: r.status, outcome: r.outcome, service: r.service_name, category: r.category_id, address: r.address, total: r.total_kes, paid: r.paid_kes, scheduledFor: r.scheduled_for, createdAt: r.created_at, worker: r.worker_name })) });
});

const NewJob = z.object({
  serviceId: z.uuid(),
  hours: z.coerce.number().positive().max(24).optional(),
  quantity: z.coerce.number().positive().max(100_000).optional(),
  overtimeHours: z.coerce.number().min(0).max(16).optional(),
  address: z.string().trim().min(3, "Choose the job address").max(240),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  addressNotes: z.string().trim().max(300).optional(),
  description: z.string().trim().min(10, "Describe the job in a sentence or two").max(2000),
  scheduledFor: z.iso.datetime({ offset: true }).nullable().optional(),
  clientKey: z.string().trim().min(8).max(64).optional(),
});

jobsRouter.post("/", async (req, res) => {
  const b = NewJob.parse(req.body);
  const u = await one<{ full_name: string; terms_accepted_at: Date | null }>(db(), `select full_name, terms_accepted_at from users where id = $1`, [req.user!.id]);
  if (!u?.full_name) throw badRequest("Add your name to your profile first", [{ path: "fullName", message: "Required" }]);
  if (!u.terms_accepted_at) throw conflict("Accept the terms, cancellation and dispute policy first", "terms_required");
  const j = await createJob(req.user!.id, b);
  res.status(201).json({ job: await view(j.id) });
});

/** Up to three photos of the job (US-01), before a worker accepts. */
jobsRouter.post("/:id/photos", upload.array("photos", 3), async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  if (!["PENDING_PAYMENT", "SCHEDULED", "SEARCHING", "UNASSIGNED"].includes(j.status)) throw conflict("Photos can be added before a worker accepts");
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest("Choose at least one photo");
  const have = await one<{ n: number }>(db(), `select count(*)::int as n from job_photos where job_id = $1 and kind = 'request'`, [j.id]);
  if (have!.n + files.length > 3) throw badRequest("Up to 3 photos per job");
  for (const f of files) {
    const m = await storeImage(db(), req.user!.id, "job", f);
    await db().query(`insert into job_photos (job_id, media_id, kind, uploaded_by) values ($1, $2, 'request', $3)`, [j.id, m, req.user!.id]);
  }
  res.status(201).json({ job: await view(j.id) });
});

jobsRouter.post("/:id/pay", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const { phone } = z.object({ phone: phoneField }).parse(req.body);
  res.status(202).json(await payHold(req.user!.id, j.id, phone));
});

jobsRouter.get("/:id", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  res.json({ job: await view(j.id) });
});

jobsRouter.get("/:id/cancel-quote", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  res.json({ quote: cancelQuote(j, await getSettings()) });
});

jobsRouter.post("/:id/cancel", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ reason: z.string().trim().max(300).default(""), expectedFee: z.number().int().min(0).optional() }).parse(req.body);
  // The fee shown on the cancel screen must be the fee charged (US-06).
  if (b.expectedFee != null) {
    const q = cancelQuote(j, await getSettings());
    if (q.fee !== b.expectedFee) throw conflict(`The cancellation fee is now KES ${q.fee.toLocaleString("en-KE")}. Check it and confirm again.`, "fee_changed");
  }
  await cancelByClient(req.user!.id, j.id, b.reason);
  res.json({ job: await view(j.id) });
});

jobsRouter.post("/:id/reschedule", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ scheduledFor: z.iso.datetime({ offset: true }).nullable() }).parse(req.body);
  await reschedule(req.user!.id, j.id, b.scheduledFor);
  res.json({ job: await view(j.id) });
});

jobsRouter.post("/:id/extras/:extraId", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.discriminatedUnion("approve", [z.object({ approve: z.literal(true), phone: phoneField }), z.object({ approve: z.literal(false) })]).parse(req.body);
  if (!uuid.safeParse(req.params.extraId).success) throw notFound("Request not found");
  const out = await respondExtra(req.user!.id, String(req.params.extraId), b.approve, b.approve ? b.phone : undefined);
  res.status(out.status === "AWAITING_PAYMENT" ? 202 : 200).json({ ...out, job: await view(j.id) });
});

jobsRouter.post("/:id/approve", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ stars: z.number().int().min(1).max(5).optional(), review: z.string().trim().max(1000).default("") }).parse(req.body ?? {});
  await approve(req.user!.id, j.id);
  if (b.stars) await rate(req.user!.id, j.id, b.stars, b.review).catch(() => {});
  res.json({ job: await view(j.id) });
});

jobsRouter.post("/:id/tip", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ amount: z.number().int().min(10, "Tips start at KES 10").max(50_000), phone: phoneField }).parse(req.body);
  res.status(202).json(await startTip(req.user!.id, j.id, b.amount, b.phone));
});

jobsRouter.post("/:id/dispute", upload.array("photos", 3), async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ reason: z.string().trim().min(3, "Choose a reason").max(120), details: z.string().trim().min(10, "Tell us what went wrong").max(2000) }).parse(req.body);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const ids: string[] = [];
  for (const f of files) ids.push(await storeImage(db(), req.user!.id, "dispute", f));
  await dispute(req.user!.id, j.id, b, ids);
  res.json({ job: await view(j.id) });
});

jobsRouter.post("/:id/rate", async (req, res) => {
  const j = await myJob(req.user!.id, String(req.params.id));
  const b = z.object({ stars: z.number().int().min(1).max(5), review: z.string().trim().max(1000).default("") }).parse(req.body);
  await rate(req.user!.id, j.id, b.stars, b.review);
  res.json({ job: await view(j.id) });
});
