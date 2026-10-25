import { Router } from "express";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { attach, issueTicket, redeemTicket } from "../services/events.js";
import { reportProblem, type JobRow } from "../services/jobflow.js";
import { invoice } from "../services/views.js";
import { notFound, unauthorized } from "../utils/http.js";
import { checkMediaSig } from "../utils/security.js";

// Private photos by signed link, notifications and the live stream, safety reports
// (US-09), and the invoice link sent by SMS (US-04).

export const mediaRouter = Router();

mediaRouter.get("/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!z.uuid().safeParse(id).success || !checkMediaSig(id, String(req.query.e ?? ""), String(req.query.s ?? ""))) throw notFound();
  const m = await one<{ mime: string; bytes: Buffer }>(db(), `select mime, bytes from media where id = $1`, [id]);
  if (!m) throw notFound();
  res.set({ "Content-Type": m.mime, "Cache-Control": "private, max-age=21600", "Cross-Origin-Resource-Policy": "same-origin" });
  res.send(Buffer.from(m.bytes));
});

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, async (req, res) => {
  const rows = await many(db(), `select id, kind, title, body, link, sms_status, read_at, created_at from notifications where user_id = $1 order by created_at desc limit 60`, [req.user!.id]);
  res.json({ notifications: rows });
});

notificationsRouter.post("/read", requireAuth, async (req, res) => {
  const b = z.object({ ids: z.array(z.uuid()).max(200).optional() }).parse(req.body ?? {});
  if (b.ids?.length) await db().query(`update notifications set read_at = now() where user_id = $1 and id = any($2::uuid[]) and read_at is null`, [req.user!.id, b.ids]);
  else await db().query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [req.user!.id]);
  res.json({ ok: true });
});

notificationsRouter.post("/stream-ticket", requireAuth, (req, res) => {
  res.json({ ticket: issueTicket(req.user!.id) });
});

notificationsRouter.get("/stream", (req, res) => {
  const userId = redeemTicket(String(req.query.ticket ?? ""));
  if (!userId) throw unauthorized("Stream ticket expired");
  attach(userId, res);
});

export const safetyRouter = Router();

safetyRouter.post("/report", requireAuth, async (req, res) => {
  const b = z
    .object({
      jobId: z.uuid().nullable().optional(),
      kind: z.enum(["problem", "emergency"]),
      category: z.string().trim().min(2).max(60),
      message: z.string().trim().max(1000).default(""),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
      alertContact: z.boolean().default(false),
    })
    .parse(req.body);
  res.status(201).json(await reportProblem(req.user!.id, b));
});

export const metricsRouter = Router();

/** One page-load time per visit, sent by the app with navigator.sendBeacon. */
metricsRouter.post("/load", async (req, res) => {
  const b = z.object({ path: z.string().max(80), ms: z.number().int().min(0).max(120_000), connection: z.string().max(16).optional() }).safeParse(req.body);
  if (b.success) {
    const path = b.data.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id").slice(0, 80);
    await db().query(`insert into perf_samples (path, ms, connection) values ($1, $2, $3)`, [path, b.data.ms, b.data.connection ?? null]);
  }
  res.status(204).end();
});

export const invoiceRouter = Router();

/** Public, but only with the token from the SMS link. */
invoiceRouter.get("/:ref", async (req, res) => {
  const j = await one<JobRow & { client_name: string; worker_name: string | null }>(
    db(),
    `select j.*, c.full_name as client_name, w.full_name as worker_name from jobs j join users c on c.id = j.client_id left join users w on w.id = j.worker_id where j.ref = $1`,
    [String(req.params.ref)],
  );
  if (!j || !j.completed_at || String(req.query.t ?? "") !== j.invoice_token) throw notFound("Invoice not found");
  res.set("Cache-Control", "no-store");
  res.json({
    invoice: { ...(await invoice(db(), j)), client: j.client_name, worker: j.worker_name, address: j.address, completedAt: j.completed_at, jobId: j.id, status: j.status, outcome: j.outcome },
  });
});
