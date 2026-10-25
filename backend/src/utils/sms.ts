import { env } from "../config/env.js";
import { darajaPhone } from "./kenya.js";

// Celcom Africa bulk SMS (isms.celcomafrica.com), sent from the registered sender ID in
// CELCOM_SHORTCODE. Without credentials the message is only written to the log.
// The queue, retries and in-app fallback live in services/sms.ts.

export const smsConfigured = () => Boolean(env.sms.apiKey && env.sms.partnerId && env.sms.shortcode);

export type SmsResult = { ok: true; providerId: string | null } | { ok: false; error: string; permanent?: boolean };

const BASE = "https://isms.celcomafrica.com/api/services";

export async function deliverSms(to: string, message: string): Promise<SmsResult> {
  if (!smsConfigured()) {
    console.log(`[sms:log] to ${to}: ${message}`);
    return { ok: true, providerId: null };
  }
  try {
    const r = await fetch(`${BASE}/sendsms/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apikey: env.sms.apiKey, partnerID: env.sms.partnerId, message, shortcode: env.sms.shortcode, mobile: darajaPhone(to), pass_type: "plain" }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => null)) as { responses?: Record<string, unknown>[] } | null;
    const first = j?.responses?.[0];
    // Celcom's field really is spelt "respose-code".
    const code = Number(first?.["respose-code"] ?? first?.["response-code"]);
    if (r.ok && code === 200) return { ok: true, providerId: first?.messageid != null ? String(first.messageid) : null };
    const desc = String(first?.["response-description"] ?? `HTTP ${r.status}`);
    // 1001 invalid sender id, 1002 network not allowed, 1003 invalid mobile, 1004 low balance, 1005 system error,
    // 1006 invalid credentials. A bad number never succeeds on retry.
    return { ok: false, error: `${code || r.status}: ${desc}`.slice(0, 300), permanent: code === 1003 };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

/** Remaining Celcom credit, for the admin console. */
export async function smsBalance(): Promise<string | null> {
  if (!smsConfigured()) return null;
  try {
    const r = await fetch(`${BASE}/getbalance/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: env.sms.apiKey, partnerID: env.sms.partnerId }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    const v = j?.credit ?? j?.balance ?? (j && Object.values(j)[0]);
    return v != null ? String(v) : null;
  } catch {
    return null;
  }
}
