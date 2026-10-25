import { db, many, one } from "../config/db.js";
import { deliverSms, smsConfigured } from "../utils/sms.js";
import { emit } from "./events.js";

// Every text goes through the outbox. A send that fails is retried (30 s, then 2 min);
// after the last try it is marked failed and the in-app notification it belongs to says
// so, which is how the event still reaches the person (PRD section 10, reliability).

const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [30, 120, 600];

type Row = { id: string; to_phone: string; body: string; attempts: number; notification_id: string | null; user_id: string | null; expires_at: Date | null };

export async function queueSms(p: { to: string; body: string; purpose: string; userId?: string | null; notificationId?: string | null; ttlMinutes?: number }): Promise<string> {
  const row = await one<{ id: string }>(
    db(),
    `insert into sms_outbox (to_phone, body, purpose, user_id, notification_id, expires_at)
     values ($1, $2, $3, $4, $5, case when $6::int is null then null else now() + make_interval(mins => $6::int) end) returning id`,
    [p.to, p.body, p.purpose, p.userId ?? null, p.notificationId ?? null, p.ttlMinutes ?? null],
  );
  await attempt(row!.id);
  return row!.id;
}

/** Sends one queued message if it is due. Only one caller can claim each try. */
async function attempt(id: string) {
  const m = await one<Row>(
    db(),
    `update sms_outbox set attempts = attempts + 1,
            next_attempt_at = now() + make_interval(secs => (array[${BACKOFF_SECONDS.join(",")}])[least(attempts + 1, ${BACKOFF_SECONDS.length})])
      where id = $1 and status = 'QUEUED' and next_attempt_at <= now()
      returning id, to_phone, body, attempts, notification_id, user_id, expires_at`,
    [id],
  );
  if (!m) return;
  const r = await deliverSms(m.to_phone, m.body);
  if (r.ok) {
    await db().query(`update sms_outbox set status = $2, provider_id = $3, sent_at = now(), last_error = null where id = $1`, [m.id, smsConfigured() ? "SENT" : "LOGGED", r.providerId]);
    if (m.notification_id) await db().query(`update notifications set sms_status = 'sent' where id = $1`, [m.notification_id]);
    return;
  }
  const expired = m.expires_at && new Date(m.expires_at).getTime() < Date.now();
  const final = r.permanent || m.attempts >= MAX_ATTEMPTS || expired;
  console.warn(`[sms] to ${m.to_phone} failed (try ${m.attempts}${final ? ", giving up" : ""}): ${r.error}`);
  await db().query(`update sms_outbox set status = $2, last_error = $3 where id = $1`, [m.id, final ? "FAILED" : "QUEUED", r.error]);
  if (final && m.notification_id) {
    const n = await one(db(), `update notifications set sms_status = 'failed' where id = $1 returning id, kind, title, body, link, sms_status, created_at, read_at`, [m.notification_id]);
    if (n && m.user_id) emit(m.user_id, "notification", n);
  }
}

/** Runs from the job loop: retries messages whose back-off has passed. */
export async function retryDueSms() {
  const due = await many<{ id: string }>(db(), `select id from sms_outbox where status = 'QUEUED' and next_attempt_at <= now() order by created_at limit 50`);
  for (const m of due) await attempt(m.id);
}
