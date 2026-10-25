import { db, one } from "../config/db.js";
import { emit } from "./events.js";
import { queueSms } from "./sms.js";

export type Notice = { kind: string; title: string; body?: string; link?: string; sms?: string };

/**
 * Stores an in-app notification, pushes it to open tabs, and texts the person when the
 * notice carries an SMS. Call it after a transaction commits, never inside one.
 */
export async function notify(userId: string, n: Notice) {
  const row = await one<{ id: string }>(
    db(),
    `insert into notifications (user_id, kind, title, body, link, sms_status) values ($1, $2, $3, $4, $5, $6)
     returning id, kind, title, body, link, sms_status, created_at, read_at`,
    [userId, n.kind, n.title, n.body ?? "", n.link ?? null, n.sms ? "queued" : null],
  );
  emit(userId, "notification", row);
  if (n.sms) {
    const u = await one<{ phone: string }>(db(), `select phone from users where id = $1`, [userId]);
    if (u) await queueSms({ to: u.phone, body: n.sms, purpose: n.kind, userId, notificationId: row!.id });
  }
}

export type After = { userId: string; n: Notice };
export async function notifyAll(list: After[]) {
  for (const a of list) await notify(a.userId, a.n).catch((e) => console.error("[notify]", e));
}
