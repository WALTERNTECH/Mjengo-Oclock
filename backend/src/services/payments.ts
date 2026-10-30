import { db, many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { daraja, describeResult, simulatedDriver, type MpesaDriver, type StkResult } from "../utils/mpesa.js";
import { emit } from "./events.js";
import { onExtraFailed, onExtraPaid, onHoldPaid, onTipPaid, type Followups } from "./jobflow.js";
import { notifyAll } from "./notify.js";

// Money in. Every payment is an M-Pesa STK prompt, confirmed only by Safaricom's
// server-to-server result (or, with Daraja, our own status query of the same prompt) —
// never by anything the browser says. Settlement is idempotent: a payment settles once,
// whatever arrives later, so a retried callback can never credit a job twice.
//
// M-Pesa has no card-style pre-authorisation, so the "hold" is the job price plus the
// client fee collected at booking and kept in escrow until the job is approved.

export type Purpose = "JOB_HOLD" | "JOB_EXTRA" | "JOB_TIP";
export type PaymentRow = {
  id: string;
  user_id: string;
  purpose: Purpose;
  job_id: string;
  ref_id: string | null;
  phone: string;
  amount_kes: number;
  status: "PENDING" | "SUCCESS" | "FAILED" | "CANCELLED";
  driver: string;
  mpesa_checkout_id: string | null;
  mpesa_receipt: string | null;
  result_code: string | null;
  result_desc: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
};

let driver: MpesaDriver = daraja;
export function initPayments() {
  driver =
    env.mpesa.driver === "daraja"
      ? daraja
      : simulatedDriver((r) => settle(r, "simulated").catch((e) => console.error("[pay] settle", e)), Number(process.env.MPESA_SIM_DELAY_MS ?? 4500));
  console.log(`[pay] M-Pesa driver: ${driver.name}${driver.name === "daraja" ? ` (${env.mpesa.env})` : ""}`);
}
export const paymentDriver = () => driver.name;
const callbackUrl = () => `${env.publicUrl}/api/mpesa/callback/${env.mpesa.callbackToken}`;

export type Started = { paymentId: string; status: "PENDING"; amount: number; message: string; simulated: boolean };

export async function startPayment(p: {
  userId: string;
  purpose: Purpose;
  jobId: string;
  refId?: string | null;
  phone: string;
  amount: number;
  accountRef: string;
  description: string;
  meta?: Record<string, unknown>;
}): Promise<Started> {
  // One prompt at a time per thing being paid for: a double tap never sends two.
  const inFlight = await one(
    db(),
    `select 1 from payments where job_id = $1 and purpose = $2 and coalesce(ref_id::text, '') = coalesce($3::text, '') and status = 'PENDING' and created_at > now() - interval '90 seconds'`,
    [p.jobId, p.purpose, p.refId ?? null],
  );
  if (inFlight) throw new HttpError(409, "in_flight", "A payment prompt was just sent. Check your phone.");
  const row = await one<{ id: string }>(
    db(),
    `insert into payments (user_id, purpose, job_id, ref_id, phone, amount_kes, account_ref, description, driver, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [p.userId, p.purpose, p.jobId, p.refId ?? null, p.phone, p.amount, p.accountRef, p.description, driver.name, JSON.stringify(p.meta ?? {})],
  );
  try {
    const s = await driver.stkPush({ phone: p.phone, amount: p.amount, accountRef: p.accountRef, description: p.description }, callbackUrl());
    await db().query(`update payments set mpesa_checkout_id = $2, merchant_request_id = $3 where id = $1`, [row!.id, s.checkoutRequestId, s.merchantRequestId]);
    return { paymentId: row!.id, status: "PENDING", amount: p.amount, message: "Check your phone and enter your M-Pesa PIN", simulated: driver.name === "simulated" };
  } catch (e) {
    console.error("[pay] stk push failed", (e as Error).message);
    await db().query(`update payments set status = 'FAILED', result_desc = $2, completed_at = now() where id = $1`, [row!.id, (e as Error).message.slice(0, 300)]);
    throw new HttpError(502, "mpesa_unavailable", "M-Pesa did not accept the request. Check the number and try again.");
  }
}

/** Applies a result from Safaricom. Idempotent. */
export async function settle(r: StkResult, source: "callback" | "query" | "simulated" | "timeout", raw?: unknown) {
  let settled: PaymentRow | null = null;
  const follow: Followups = { notices: [], then: [] };
  await db().tx(async (q) => {
    const p = await one<PaymentRow>(q, `select * from payments where mpesa_checkout_id = $1 for update`, [r.checkoutRequestId]);
    if (!p) {
      console.warn(`[pay] result for unknown checkout ${r.checkoutRequestId} (${source})`);
      return;
    }
    if (p.status !== "PENDING") {
      // A status query can settle a payment before the callback brings the receipt number.
      if (p.status === "SUCCESS" && !p.mpesa_receipt && r.receipt) {
        await q.query(`update payments set mpesa_receipt = $2, raw_callback = coalesce($3::jsonb, raw_callback) where id = $1`, [p.id, r.receipt, raw ? JSON.stringify(raw) : null]);
      }
      return;
    }
    let ok = r.resultCode === "0";
    let desc = r.resultDesc;
    if (ok && r.amount != null && Math.round(r.amount) < p.amount_kes) {
      ok = false;
      desc = `Amount ${r.amount} is less than ${p.amount_kes}`;
      console.error(`[pay] short payment on ${p.id}: ${desc}`);
    }
    await q.query(
      `update payments set status = $2, mpesa_receipt = $3, result_code = $4, result_desc = $5, raw_callback = coalesce($6::jsonb, raw_callback), completed_at = now() where id = $1`,
      [p.id, ok ? "SUCCESS" : "FAILED", r.receipt ?? null, r.resultCode, desc, raw ? JSON.stringify(raw) : null],
    );
    settled = { ...p, status: ok ? "SUCCESS" : "FAILED", mpesa_receipt: r.receipt ?? null, result_code: r.resultCode, result_desc: desc };
    if (ok) await applySuccess(q, settled, follow);
    else if (p.purpose === "JOB_EXTRA") await onExtraFailed(q, settled);
  });
  if (!settled) return;
  const s = settled as PaymentRow;
  emit(s.user_id, "payment", publicPayment(s));
  await notifyAll(follow.notices);
  for (const fn of follow.then) await fn().catch((e) => console.error("[pay] follow-up", e));
}

async function applySuccess(q: Q, p: PaymentRow, follow: Followups) {
  if (p.purpose === "JOB_HOLD") return onHoldPaid(q, p, follow);
  if (p.purpose === "JOB_EXTRA") return onExtraPaid(q, p, follow);
  return onTipPaid(q, p, follow);
}

export function publicPayment(p: PaymentRow) {
  return {
    id: p.id,
    purpose: p.purpose,
    jobId: p.job_id,
    refId: p.ref_id,
    amount: p.amount_kes,
    status: p.status,
    receipt: p.mpesa_receipt,
    message: p.status === "PENDING" ? "Waiting for your M-Pesa PIN" : describeResult(p.result_code ?? "", p.result_desc ?? ""),
    simulated: p.driver === "simulated",
    createdAt: p.created_at,
  };
}

/** Asks Daraja about prompts that have gone quiet, and gives up on ones nobody answered. */
export async function reconcile() {
  const stale = await many<PaymentRow>(db(), `select * from payments where status = 'PENDING' and created_at < now() - interval '45 seconds' order by created_at limit 50`);
  for (const p of stale) {
    if (!p.mpesa_checkout_id) continue;
    const age = Date.now() - new Date(p.created_at).getTime();
    try {
      const r = await driver.query(p.mpesa_checkout_id);
      if (r) {
        await settle({ checkoutRequestId: p.mpesa_checkout_id, resultCode: r.resultCode, resultDesc: r.resultDesc }, "query");
        continue;
      }
    } catch (e) {
      console.warn("[pay] status query failed", (e as Error).message);
    }
    if (age > 10 * 60_000) await settle({ checkoutRequestId: p.mpesa_checkout_id, resultCode: "1019", resultDesc: "No response from M-Pesa" }, "timeout");
  }
}
