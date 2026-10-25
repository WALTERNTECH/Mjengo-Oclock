import { db, many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { conflict, notFound } from "../utils/http.js";
import { estimateMinutes, haversineSql } from "../utils/geo.js";
import { kes, shortName, whenEAT } from "../utils/kenya.js";
import { adminAlert, logEvent, SYSTEM } from "./audit.js";
import { emit } from "./events.js";
import { lockJob, run, touch, type JobRow } from "./jobflow.js";
import { notify } from "./notify.js";
import { pct } from "./pricing.js";
import { getSettings } from "./settings.js";

// Automated dispatch (PRD 4.2, US-02). The job is offered to the closest available,
// approved worker with the right skill. Each worker has offer_window_seconds to accept;
// after a decline or time-out it goes to the next nearest. There is no radius inside
// Nairobi. After dispatch_timeout_minutes with no acceptance the client is told by SMS,
// can reschedule or cancel free, and the team is alerted to dispatch by hand.
//
// Workers are ranked by where they are now (a location from the last 30 minutes) or, if
// the app hasn't sent one, the base location on their profile.

const FRESH = "interval '30 minutes'";

export async function withdrawOffers(q: Q, jobId: string) {
  const w = await many<{ worker_id: string }>(q, `update job_offers set status = 'WITHDRAWN', responded_at = now() where job_id = $1 and status = 'PENDING' returning worker_id`, [jobId]);
  for (const o of w) emit(o.worker_id, "offer_gone", { jobId });
}

type Candidate = { user_id: string; km: number };

async function nearest(q: Q, j: JobRow): Promise<Candidate | null> {
  const target = j.scheduled_for ? new Date(j.scheduled_for) : new Date();
  return one<Candidate>(
    q,
    `with w as (
       select wp.user_id,
              case when wp.last_location_at > now() - ${FRESH} then wp.last_lat else u.home_lat end as lat,
              case when wp.last_location_at > now() - ${FRESH} then wp.last_lng else u.home_lng end as lng
         from worker_profiles wp join users u on u.id = wp.user_id
        where wp.status = 'approved' and wp.available and u.status = 'active'
          and wp.category_id = $2 and wp.user_id <> $3 and not (wp.user_id = any($4::uuid[]))
          and not exists (select 1 from job_offers o where o.job_id = $1 and o.worker_id = wp.user_id and o.round = $5)
          and not exists (select 1 from job_offers o where o.worker_id = wp.user_id and o.status = 'PENDING')
          -- Busy now, or committed to another job within three hours of this one.
          and not exists (select 1 from jobs b where b.worker_id = wp.user_id and b.id <> $1 and (
                (b.status in ('EN_ROUTE','ON_SITE','IN_PROGRESS') and $6::timestamptz < now() + interval '3 hours')
             or (b.status = 'ACCEPTED' and abs(extract(epoch from (coalesce(b.scheduled_for, b.accepted_at) - $6::timestamptz))) < 10800)))
     )
     select user_id, ${haversineSql("w.lat", "w.lng", "$7::float8", "$8::float8")}::float8 as km
       from w where lat is not null and lng is not null
      order by km, user_id limit 1`,
    [j.id, j.category_id, j.client_id, j.excluded_workers ?? [], j.dispatch_round, target, j.lat, j.lng],
  );
}

/** Offers the job to the next nearest worker, if it's still looking and nobody holds an offer. */
export async function offerNext(jobId: string, tries = 0): Promise<void> {
  const s = await getSettings();
  let sent: { workerId: string; km: number; job: JobRow; trade: string; area: string } | null = null;
  try {
    await db().tx(async (q) => {
      const j = await lockJob(q, jobId);
      if (j.status !== "SEARCHING") return;
      if (await one(q, `select 1 from job_offers where job_id = $1 and status = 'PENDING'`, [j.id])) return;
      const c = await nearest(q, j);
      if (!c) return;
      await q.query(`insert into job_offers (job_id, worker_id, round, distance_km, expires_at) values ($1, $2, $3, $4, now() + make_interval(secs => $5))`, [
        j.id, c.user_id, j.dispatch_round, Math.round(c.km * 10) / 10, s.offer_window_seconds,
      ]);
      await logEvent(q, j.id, SYSTEM, "offer.sent", { worker: c.user_id, km: Math.round(c.km * 10) / 10, round: j.dispatch_round });
      const cat = await one<{ trade: string }>(q, `select trade from categories where id = $1`, [j.category_id]);
      sent = { workerId: c.user_id, km: c.km, job: j, trade: cat?.trade ?? "worker", area: areaOf(j.address) };
    });
  } catch (e) {
    // Two jobs reached for the same worker at once; the unique index let one through.
    if ((e as { code?: string }).code === "23505" && tries < 3) return offerNext(jobId, tries + 1);
    throw e;
  }
  if (!sent) return;
  const o = sent as { workerId: string; km: number; job: JobRow; trade: string; area: string };
  const earn = o.job.base_kes - pct(o.job.base_kes, o.job.worker_fee_pct);
  const when = o.job.scheduled_for ? ` on ${whenEAT(o.job.scheduled_for)}` : "";
  emit(o.workerId, "offer", { jobId: o.job.id });
  await notify(o.workerId, {
    kind: "offer",
    title: `New job ${o.km.toFixed(1)} km away: ${o.job.service_name}`,
    body: `${o.area}${when} · you earn ${kes(earn)}`,
    link: "/work",
    sms: `Mjengo O'clock: new job ${o.km.toFixed(1)} km away in ${o.area}${when} - ${o.job.service_name}. You earn ${kes(earn)}. Accept within ${Math.round(s.offer_window_seconds / 60)} min: ${env.publicUrl}/work`,
  }).catch((e) => console.error("[dispatch] notify", e));
}

/**
 * The neighbourhood part of an address, shown before a worker accepts. Addresses read
 * "place, street, area, city", so the area is the last part before the city.
 */
export function areaOf(address: string): string {
  const parts = address
    .split(",")
    .map((p) => p.trim().replace(/\s+(division|ward|location|sub-?location|sub-?county|estate)$/i, ""))
    .filter((p) => p && !/^(nairobi( county)?|kenya|\d{5})$/i.test(p));
  if (!parts.length) return "Nairobi";
  return parts.length === 1 ? parts[0] : parts[parts.length - 1];
}

export async function acceptOffer(workerId: string, offerId: string) {
  return run(async (q, f, s) => {
    const o = await one<{ id: string; job_id: string; worker_id: string; status: string; expires_at: Date; distance_km: number }>(q, `select * from job_offers where id = $1 for update`, [offerId]);
    if (!o || o.worker_id !== workerId) throw notFound("Offer not found");
    if (o.status !== "PENDING") throw conflict("This offer has ended", "offer_gone");
    if (new Date(o.expires_at).getTime() < Date.now()) {
      await q.query(`update job_offers set status = 'EXPIRED', responded_at = now() where id = $1`, [o.id]);
      f.then.push(() => offerNext(o.job_id));
      throw conflict("The time to accept ran out", "offer_gone");
    }
    const j = await lockJob(q, o.job_id);
    if (j.status !== "SEARCHING") throw conflict("This job has been taken or cancelled", "offer_gone");
    const w = await one<{ status: string; jobs_completed: number; last_lat: number | null; last_lng: number | null }>(q, `select status, jobs_completed, last_lat, last_lng from worker_profiles where user_id = $1`, [workerId]);
    if (w?.status !== "approved") throw conflict("Your account isn't approved for jobs right now");
    const minutes = w.last_lat != null && w.last_lng != null ? estimateMinutes({ lat: w.last_lat, lng: w.last_lng }, j) : Math.max(10, Math.round(o.distance_km * 4.2));
    await q.query(`update job_offers set status = 'ACCEPTED', responded_at = now() where id = $1`, [o.id]);
    await q.query(
      `update jobs set status = 'ACCEPTED', worker_id = $2, accepted_at = now(), eta_minutes = $3,
              eta_at = greatest(now() + make_interval(mins => $3), coalesce(scheduled_for, now())), probation = $4, updated_at = now() where id = $1`,
      [j.id, workerId, minutes, w.jobs_completed < s.probation_jobs],
    );
    await logEvent(q, j.id, { type: "worker", id: workerId }, "status.accepted", { from: "SEARCHING", offer: o.id, km: o.distance_km, probation: w.jobs_completed < s.probation_jobs });
    const u = await one<{ full_name: string }>(q, `select full_name from users where id = $1`, [workerId]);
    f.notices.push({ userId: j.client_id, n: { kind: "job", title: `${shortName(u!.full_name)} accepted your job`, body: j.scheduled_for ? `See you ${whenEAT(j.scheduled_for)}` : `About ${minutes} min away`, link: `/jobs/${j.id}` } });
    touch(f, { ...j, worker_id: workerId });
    return { jobId: j.id };
  });
}

export async function declineOffer(workerId: string, offerId: string) {
  const o = await one<{ job_id: string }>(db(), `update job_offers set status = 'DECLINED', responded_at = now() where id = $1 and worker_id = $2 and status = 'PENDING' returning job_id`, [offerId, workerId]);
  if (!o) throw conflict("This offer has ended", "offer_gone");
  await logEvent(db(), o.job_id, { type: "worker", id: workerId }, "offer.declined", {});
  await offerNext(o.job_id);
}

/** Every few seconds: time out offers, start scheduled jobs, give up after the dispatch window. */
export async function dispatchTick() {
  const s = await getSettings();
  const expired = await many<{ job_id: string; worker_id: string }>(db(), `update job_offers set status = 'EXPIRED', responded_at = now() where status = 'PENDING' and expires_at < now() returning job_id, worker_id`);
  for (const e of expired) {
    await logEvent(db(), e.job_id, SYSTEM, "offer.expired", { worker: e.worker_id });
    emit(e.worker_id, "offer_gone", { jobId: e.job_id });
  }

  const due = await many<{ id: string }>(
    db(),
    `update jobs set status = 'SEARCHING', dispatch_started_at = now(), dispatch_round = dispatch_round + 1, updated_at = now()
      where status = 'SCHEDULED' and scheduled_for - make_interval(mins => $1) <= now() returning id`,
    [s.schedule_lead_minutes],
  );
  for (const d of due) await logEvent(db(), d.id, SYSTEM, "status.searching", { from: "SCHEDULED" });

  const timedOut = await many<JobRow>(
    db(),
    `update jobs set status = 'UNASSIGNED', unassigned_at = now(), updated_at = now()
      where status = 'SEARCHING' and dispatch_started_at < now() - make_interval(mins => $1) returning *`,
    [s.dispatch_timeout_minutes],
  );
  for (const j of timedOut) {
    await db().tx((q) => withdrawOffers(q, j.id));
    await logEvent(db(), j.id, SYSTEM, "status.unassigned", { from: "SEARCHING", minutes: s.dispatch_timeout_minutes });
    const cat = await one<{ trade: string }>(db(), `select trade from categories where id = $1`, [j.category_id]);
    await notify(j.client_id, {
      kind: "job",
      title: `No ${cat?.trade ?? "worker"} has accepted yet`,
      body: "Reschedule or cancel at no charge. Our team is also looking.",
      link: `/jobs/${j.id}`,
      sms: `Mjengo O'clock: no ${cat?.trade ?? "worker"} has accepted job ${j.ref} yet. You can reschedule or cancel at no charge: ${env.publicUrl}/jobs/${j.id} Our team is also trying to find someone.`,
    }).catch(() => {});
    await adminAlert({ kind: "unassigned", title: `No worker for ${j.ref} after ${s.dispatch_timeout_minutes} min`, body: `${j.service_name} · ${j.address}`, jobId: j.id, urgent: true });
    emit(j.client_id, "job", { id: j.id });
  }

  // Jobs still looking with nobody holding an offer: try the next nearest (new workers come online).
  const waiting = await many<{ id: string }>(
    db(),
    `select id from jobs j where status = 'SEARCHING' and not exists (select 1 from job_offers o where o.job_id = j.id and o.status = 'PENDING') order by created_at limit 50`,
  );
  for (const w of waiting) await offerNext(w.id).catch((e) => console.error("[dispatch] offer", w.id, e));
}
