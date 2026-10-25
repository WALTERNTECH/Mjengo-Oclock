import { Router } from "express";
import { z } from "zod";
import { db, one } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { OPEN } from "../services/jobflow.js";
import { conflict } from "../utils/http.js";
import { normalizePhone } from "../utils/kenya.js";

// The signed-in person's own profile: name, contact, primary service location, emergency
// contact (PRD 4.1 and 5), and the consents the Data Protection Act asks for (PRD 11).

export const meRouter = Router();

export async function meView(id: string) {
  const u = await one<Record<string, unknown>>(
    db(),
    `select u.id, u.phone, u.full_name, u.email, u.home_label, u.home_lat, u.home_lng, u.emergency_name, u.emergency_phone,
            u.terms_accepted_at, u.location_consent_at, u.created_at, w.status as worker_status,
            (select count(*)::int from notifications n where n.user_id = u.id and n.read_at is null) as unread,
            (select j.id from jobs j where j.client_id = u.id and j.status in ('SCHEDULED','SEARCHING','UNASSIGNED','ACCEPTED','EN_ROUTE','ON_SITE','IN_PROGRESS','COMPLETED','DISPUTED')
              order by j.created_at desc limit 1) as active_job_id
       from users u left join worker_profiles w on w.user_id = u.id where u.id = $1`,
    [id],
  );
  if (!u) return null;
  return {
    id: u.id,
    phone: u.phone,
    fullName: u.full_name,
    email: u.email,
    home: u.home_lat != null ? { label: u.home_label, lat: u.home_lat, lng: u.home_lng } : null,
    emergency: u.emergency_phone ? { name: u.emergency_name, phone: u.emergency_phone } : null,
    termsAcceptedAt: u.terms_accepted_at,
    locationConsentAt: u.location_consent_at,
    workerStatus: u.worker_status,
    unread: u.unread,
    activeJobId: u.active_job_id,
    createdAt: u.created_at,
  };
}

meRouter.get("/", requireAuth, async (req, res) => {
  res.json({ user: await meView(req.user!.id) });
});

const optionalPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (!v) return null;
    const p = normalizePhone(v);
    if (!p) {
      ctx.addIssue({ code: "custom", message: "Enter a Kenyan mobile number" });
      return z.NEVER;
    }
    return p;
  });

meRouter.patch("/", requireAuth, async (req, res) => {
  const b = z
    .object({
      fullName: z.string().trim().min(2, "Enter your full name").max(80).optional(),
      email: z.union([z.literal(""), z.string().trim().toLowerCase().pipe(z.email("Enter a valid email"))]).optional(),
      home: z.object({ label: z.string().trim().min(2).max(200), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
      emergency: z.object({ name: z.string().trim().min(2, "Enter their name").max(80), phone: optionalPhone }).nullable().optional(),
      acceptTerms: z.literal(true).optional(),
      locationConsent: z.boolean().optional(),
    })
    .parse(req.body);
  const id = req.user!.id;
  if (b.emergency?.phone && b.emergency.phone === req.user!.phone) throw conflict("Your emergency contact needs a different number from yours");
  await db().query(
    `update users set
       full_name = coalesce($2, full_name),
       email = case when $3::boolean then nullif($4, '') else email end,
       home_label = case when $5::boolean then $6 else home_label end,
       home_lat = case when $5::boolean then $7::float8 else home_lat end,
       home_lng = case when $5::boolean then $8::float8 else home_lng end,
       emergency_name = case when $9::boolean then $10 else emergency_name end,
       emergency_phone = case when $9::boolean then $11 else emergency_phone end,
       terms_accepted_at = case when $12::boolean then coalesce(terms_accepted_at, now()) else terms_accepted_at end,
       location_consent_at = case when $13::boolean is null then location_consent_at when $13 then coalesce(location_consent_at, now()) else null end
     where id = $1`,
    [
      id, b.fullName ?? null,
      b.email !== undefined, b.email ?? null,
      b.home !== undefined, b.home?.label ?? null, b.home?.lat ?? null, b.home?.lng ?? null,
      b.emergency !== undefined, b.emergency?.name ?? null, b.emergency?.phone ?? null,
      Boolean(b.acceptTerms), b.locationConsent ?? null,
    ],
  );
  // Withdrawing location consent also stops a worker being dispatched by location.
  if (b.locationConsent === false) await db().query(`update worker_profiles set available = false, last_lat = null, last_lng = null, last_location_at = null where user_id = $1`, [id]);
  res.json({ user: await meView(id) });
});

/** The Data Protection Act's right to erasure: the profile is cleared; job records are kept for accounting. */
meRouter.delete("/", requireAuth, async (req, res) => {
  const id = req.user!.id;
  const open = await one(db(), `select 1 from jobs where (client_id = $1 or worker_id = $1) and status = any($2::text[]) limit 1`, [id, OPEN]);
  if (open) throw conflict("Finish or cancel your open jobs first");
  await db().tx(async (q) => {
    await q.query(
      `update users set status = 'deleted', full_name = '', email = null, home_label = null, home_lat = null, home_lng = null, emergency_name = null, emergency_phone = null,
              location_consent_at = null, token_version = token_version + 1 where id = $1`,
      [id],
    );
    const w = await one<{ id_front_media_id: string | null; selfie_media_id: string | null; certificate_media_id: string | null }>(q, `select id_front_media_id, selfie_media_id, certificate_media_id from worker_profiles where user_id = $1`, [id]);
    if (w) {
      await q.query(`delete from media where id = any($1::uuid[])`, [[w.id_front_media_id, w.selfie_media_id, w.certificate_media_id].filter(Boolean)]);
      await q.query(
        `update worker_profiles set status = 'rejected', available = false, national_id_enc = null, id_front_media_id = null, selfie_media_id = null, certificate_media_id = null,
                bank_account_number = null, payout_phone = null, last_lat = null, last_lng = null, review_reason = 'Account deleted by the user' where user_id = $1`,
        [id],
      );
    }
  });
  res.json({ ok: true });
});
