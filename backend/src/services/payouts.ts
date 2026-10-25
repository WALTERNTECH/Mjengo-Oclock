import { db, many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { b2cConfigured, darajaB2c, simulatedB2c, type B2cDriver, type B2cResult } from "../utils/mpesa.js";
import { kes } from "../utils/kenya.js";
import { notify } from "./notify.js";

// Money out of escrow: the worker's share, tips (in full), and refunds to clients.
// QUEUED → SENDING (Safaricom accepted it) → PAID or FAILED. Failed sends are retried a few
// times; bank payouts, and anything M-Pesa can't send, wait for the finance team, who pay
// by hand and record the reference in Admin › Payouts.
//
// A payout is only ever created from money already collected for that job, so the
// platform never pays a worker from its own funds (PRD section 6).

const MAX_AUTO_ATTEMPTS = 3;
const B2C_MAX_KES = 250_000; // Safaricom's per-transaction ceiling
const B2C_MIN_KES = 10;

let driver: B2cDriver | null = null;
export function initPayouts() {
  if (env.mpesa.driver === "simulated") driver = simulatedB2c((r) => void handleB2cResult(r).catch((e) => console.error("[payout] result", e)), Number(process.env.MPESA_SIM_DELAY_MS ?? 3000));
  else driver = b2cConfigured() ? darajaB2c : null;
  console.log(`[payout] B2C: ${driver ? driver.name : "not configured (payouts wait for the finance team)"}`);
}
export const payoutDriver = () => driver?.name ?? null;

const urls = () => ({
  result: `${env.publicUrl}/api/mpesa/b2c/result/${env.mpesa.callbackToken}`,
  timeout: `${env.publicUrl}/api/mpesa/b2c/timeout/${env.mpesa.callbackToken}`,
});

type PayoutRow = { id: string; job_id: string; kind: "WORKER" | "TIP" | "REFUND"; user_id: string; method: string; amount_kes: number; phone: string | null; status: string; attempts: number; ref: string };

/** Records a payout owed from escrow. Inside the settling transaction; sent after it commits. */
export async function queuePayout(q: Q, p: { jobId: string; kind: PayoutRow["kind"]; userId: string; amount: number }): Promise<string | null> {
  if (p.amount <= 0) return null;
  let method = "mpesa";
  let phone: string | null = null;
  let bank: Record<string, string | null> | null = null;
  if (p.kind === "REFUND") {
    // Refunds go back to the number that paid.
    const paid = await one<{ phone: string }>(q, `select phone from payments where job_id = $1 and status = 'SUCCESS' order by created_at limit 1`, [p.jobId]);
    const u = await one<{ phone: string }>(q, `select phone from users where id = $1`, [p.userId]);
    phone = paid?.phone ?? u!.phone;
  } else {
    const w = await one<{ phone: string; payout_method: string; payout_phone: string | null; bank_name: string | null; bank_branch: string | null; bank_account_name: string | null; bank_account_number: string | null }>(
      q,
      `select u.phone, w.payout_method, w.payout_phone, w.bank_name, w.bank_branch, w.bank_account_name, w.bank_account_number
         from users u left join worker_profiles w on w.user_id = u.id where u.id = $1`,
      [p.userId],
    );
    method = w?.payout_method === "bank" ? "bank" : "mpesa";
    phone = w?.payout_phone ?? w?.phone ?? null;
    if (method === "bank") bank = { name: w!.bank_name, branch: w!.bank_branch, accountName: w!.bank_account_name, accountNumber: w!.bank_account_number };
  }
  const row = await one<{ id: string }>(
    q,
    `insert into payouts (job_id, kind, user_id, method, phone, bank, amount_kes, last_error)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (job_id, kind) do nothing returning id`,
    [p.jobId, p.kind, p.userId, method, phone, bank ? JSON.stringify(bank) : null, p.amount, method === "bank" ? "Bank transfer: the finance team sends it" : null],
  );
  return row?.id ?? null;
}

/** Sends one payout if it's waiting. Safe to call twice: only one call can claim it. */
export async function sendPayout(id: string): Promise<{ ok: boolean; error?: string }> {
  const peek = await one<{ method: string }>(db(), `select method from payouts where id = $1`, [id]);
  if (peek?.method === "bank") return { ok: false, error: "Bank payouts are sent by the finance team" };
  if (!driver) {
    await db().query(`update payouts set last_error = 'M-Pesa payouts are not set up' where id = $1 and status = 'QUEUED'`, [id]);
    return { ok: false, error: "M-Pesa payouts are not set up" };
  }
  const p = await one<PayoutRow>(
    db(),
    `update payouts p set status = 'SENDING', attempts = attempts + 1, sent_at = now(), last_error = null
       from jobs j
      where p.id = $1 and j.id = p.job_id and p.method = 'mpesa' and p.status in ('QUEUED','FAILED')
      returning p.*, j.ref`,
    [id],
  );
  if (!p) return { ok: false, error: "This payout isn't waiting to be sent" };
  if (!p.phone || p.amount_kes < B2C_MIN_KES || p.amount_kes > B2C_MAX_KES) {
    await db().query(`update payouts set status = 'QUEUED', last_error = $2 where id = $1`, [p.id, `KES ${p.amount_kes} can't go by M-Pesa B2C; send it by hand`]);
    return { ok: false, error: "Amount outside M-Pesa B2C limits" };
  }
  try {
    const what = p.kind === "REFUND" ? "refund" : p.kind === "TIP" ? "tip" : "payout";
    const sent = await driver.send({ originatorId: `${p.id}-${p.attempts}`, phone: p.phone, amount: p.amount_kes, remarks: `Mjengo ${what} ${p.ref}`, occasion: p.ref }, urls());
    await db().query(`update payouts set conversation_id = $2 where id = $1`, [p.id, sent.conversationId]);
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    console.error(`[payout] send ${p.id} failed: ${msg}`);
    await db().query(`update payouts set status = 'FAILED', last_error = $2 where id = $1 and status = 'SENDING'`, [p.id, msg]);
    return { ok: false, error: msg };
  }
}

export async function sendJobPayouts(jobId: string) {
  const rows = await many<{ id: string }>(db(), `select id from payouts where job_id = $1 and status = 'QUEUED' and method = 'mpesa'`, [jobId]);
  for (const r of rows) await sendPayout(r.id);
}

/** Applies Safaricom's B2C result. Matches on the conversation id we stored, or our own originator id. */
export async function handleB2cResult(r: B2cResult) {
  const byOriginator = r.originatorId?.match(/^([0-9a-f-]{36})-\d+$/)?.[1];
  const p = await one<PayoutRow>(
    db(),
    `select p.*, j.ref from payouts p join jobs j on j.id = p.job_id
      where ($1::text is not null and p.conversation_id = $1) or ($2::uuid is not null and p.id = $2) limit 1`,
    [r.conversationId ?? null, byOriginator ?? null],
  );
  if (!p) {
    console.warn(`[payout] result for unknown payout ${r.conversationId ?? r.originatorId}`);
    return;
  }
  if (p.status !== "SENDING") return;
  if (r.resultCode === "0") {
    const updated = await one(db(), `update payouts set status = 'PAID', paid_at = now(), reference = $2, last_error = null where id = $1 and status = 'SENDING' returning id`, [p.id, r.receipt ?? null]);
    if (updated) await announcePaid(p, r.receipt ?? null);
  } else {
    await db().query(`update payouts set status = 'FAILED', last_error = $2 where id = $1 and status = 'SENDING'`, [p.id, `${r.resultCode}: ${r.resultDesc}`.slice(0, 300)]);
    console.warn(`[payout] ${p.id} failed: ${r.resultCode} ${r.resultDesc}`);
  }
}

export async function announcePaid(p: { user_id: string; kind: string; amount_kes: number; ref: string; method?: string }, reference: string | null) {
  const where = p.method === "bank" ? "your bank account" : "your M-Pesa";
  const ref = reference ? `, ref ${reference}` : "";
  const n =
    p.kind === "REFUND"
      ? { title: `${kes(p.amount_kes)} refunded`, sms: `Mjengo O'clock: ${kes(p.amount_kes)} for job ${p.ref} has been refunded to ${where}${ref}.` }
      : p.kind === "TIP"
        ? { title: `${kes(p.amount_kes)} tip received`, sms: `Mjengo O'clock: your client tipped ${kes(p.amount_kes)} for job ${p.ref}. Sent to ${where}${ref}.` }
        : { title: `${kes(p.amount_kes)} sent to ${where}`, sms: `Mjengo O'clock: ${kes(p.amount_kes)} for job ${p.ref} has been sent to ${where}${ref}.` };
  await notify(p.user_id, { kind: "payout", title: n.title, body: `Job ${p.ref}${reference ? ` · ${reference}` : ""}`, link: p.kind === "REFUND" ? "/jobs" : "/work/earnings", sms: n.sms }).catch(() => {});
}

/** Runs from the job loop: sends queued M-Pesa payouts and retries failed ones a few times. */
export async function sendDuePayouts() {
  if (!driver) return;
  const due = await many<{ id: string }>(
    db(),
    `select id from payouts
      where method = 'mpesa' and ((status = 'QUEUED' and (last_error is null or last_error = 'M-Pesa payouts are not set up'))
         or (status = 'FAILED' and attempts < ${MAX_AUTO_ATTEMPTS} and coalesce(sent_at, created_at) < now() - interval '5 minutes'))
      order by created_at limit 20`,
  );
  for (const p of due) await sendPayout(p.id);
}
