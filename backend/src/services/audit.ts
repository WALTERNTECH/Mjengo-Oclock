import { db, type Q } from "../config/db.js";
import { getSettings } from "./settings.js";
import { queueSms } from "./sms.js";

// The job timeline doubles as the audit trail (PRD section 10): every status change,
// payment action and override is written with a timestamp and who did it.

export type Actor = { type: "client" | "worker" | "admin" | "system"; id?: string | null };
export const SYSTEM: Actor = { type: "system" };

export async function logEvent(q: Q, jobId: string, actor: Actor, kind: string, detail: Record<string, unknown> = {}) {
  await q.query(`insert into job_events (job_id, actor_type, actor_id, kind, detail) values ($1, $2, $3, $4, $5)`, [jobId, actor.type, actor.id ?? null, kind, JSON.stringify(detail)]);
}

/** Puts something in front of the operations team, and texts the alert numbers when it is urgent. */
export async function adminAlert(a: { kind: string; title: string; body?: string; jobId?: string | null; userId?: string | null; urgent?: boolean }) {
  await db().query(`insert into admin_alerts (kind, title, body, job_id, user_id) values ($1, $2, $3, $4, $5)`, [a.kind, a.title, a.body ?? "", a.jobId ?? null, a.userId ?? null]);
  if (!a.urgent) return;
  const s = await getSettings();
  const phones = String(s.alert_phones ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const to of phones) await queueSms({ to, body: `Mjengo ops: ${a.title}${a.body ? `. ${a.body}` : ""}`.slice(0, 300), purpose: "admin_alert" }).catch(() => {});
}
