import { env } from "../config/env.js";
import { darajaPhone } from "./kenya.js";

// Every Daraja call lives here so the integration can be swapped or simulated in one place.
// Lipa Na M-Pesa Online (STK Push): we ask Safaricom to show a PIN prompt on the customer's
// phone, then Safaricom calls our callback with the result.

export type StkRequest = { phone: string; amount: number; accountRef: string; description: string };
export type StkStarted = { checkoutRequestId: string; merchantRequestId: string; customerMessage: string };
export type StkResult = {
  checkoutRequestId: string;
  merchantRequestId?: string;
  resultCode: string;
  resultDesc: string;
  amount?: number;
  receipt?: string;
  phone?: string;
};

export interface MpesaDriver {
  name: "daraja" | "simulated";
  stkPush(req: StkRequest, callbackUrl: string): Promise<StkStarted>;
  /** Asks Safaricom for the current state of a prompt. null while it is still being processed. */
  query(checkoutRequestId: string): Promise<{ resultCode: string; resultDesc: string } | null>;
}

const base = () => (env.mpesa.env === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");

/** YYYYMMDDHHmmss in Nairobi time, as Daraja expects. */
export function darajaTimestamp(now = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`;
}

export const stkPassword = (shortcode: string, passkey: string, timestamp: string) =>
  Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

/** Pulls the fields we keep out of Safaricom's callback body. Returns null for anything malformed. */
export function parseCallback(body: unknown): StkResult | null {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  if (!cb || typeof cb.CheckoutRequestID !== "string") return null;
  const items = ((cb.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] })?.Item ?? []).reduce<Record<string, unknown>>(
    (acc, i) => ((acc[i.Name] = i.Value), acc),
    {},
  );
  return {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: typeof cb.MerchantRequestID === "string" ? cb.MerchantRequestID : undefined,
    resultCode: String(cb.ResultCode ?? ""),
    resultDesc: String(cb.ResultDesc ?? ""),
    amount: items.Amount != null ? Number(items.Amount) : undefined,
    receipt: items.MpesaReceiptNumber != null ? String(items.MpesaReceiptNumber) : undefined,
    phone: items.PhoneNumber != null ? String(items.PhoneNumber) : undefined,
  };
}

let cachedToken: { value: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.value;
  const auth = Buffer.from(`${env.mpesa.consumerKey}:${env.mpesa.consumerSecret}`).toString("base64");
  const r = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Daraja auth failed (${r.status})`);
  const j = (await r.json()) as { access_token: string; expires_in: string };
  cachedToken = { value: j.access_token, until: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return j.access_token;
}

async function darajaPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({}))) as T & { errorMessage?: string };
  if (!r.ok) throw Object.assign(new Error(j.errorMessage || `Daraja ${path} failed (${r.status})`), { daraja: j });
  return j;
}

export const daraja: MpesaDriver = {
  name: "daraja",
  async stkPush(req, callbackUrl) {
    const ts = darajaTimestamp();
    const { shortcode, passkey, till } = env.mpesa;
    const j = await darajaPost<{ MerchantRequestID: string; CheckoutRequestID: string; ResponseCode: string; ResponseDescription: string; CustomerMessage: string }>(
      "/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortcode,
        Password: stkPassword(shortcode, passkey, ts),
        Timestamp: ts,
        TransactionType: till ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
        Amount: Math.round(req.amount),
        PartyA: darajaPhone(req.phone),
        PartyB: till || shortcode,
        PhoneNumber: darajaPhone(req.phone),
        CallBackURL: callbackUrl,
        AccountReference: req.accountRef.slice(0, 12),
        TransactionDesc: req.description.slice(0, 13),
      },
    );
    if (j.ResponseCode !== "0") throw new Error(j.ResponseDescription || "M-Pesa did not accept the request");
    return { checkoutRequestId: j.CheckoutRequestID, merchantRequestId: j.MerchantRequestID, customerMessage: j.CustomerMessage };
  },
  async query(checkoutRequestId) {
    const ts = darajaTimestamp();
    try {
      const j = await darajaPost<{ ResultCode?: string; ResultDesc?: string }>("/mpesa/stkpushquery/v1/query", {
        BusinessShortCode: env.mpesa.shortcode,
        Password: stkPassword(env.mpesa.shortcode, env.mpesa.passkey, ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      });
      return j.ResultCode != null ? { resultCode: String(j.ResultCode), resultDesc: j.ResultDesc ?? "" } : null;
    } catch (e) {
      // "The transaction is being processed" comes back as an error status.
      const code = (e as { daraja?: { errorCode?: string } }).daraja?.errorCode;
      if (code === "500.001.1001") return null;
      throw e;
    }
  },
};

/**
 * Stands in for Safaricom until Daraja credentials exist: accepts every prompt and reports
 * success a few seconds later through the same settlement path a real callback takes.
 */
export function simulatedDriver(onResult: (r: StkResult) => void, delayMs = 4500): MpesaDriver {
  const results = new Map<string, StkResult>();
  return {
    name: "simulated",
    async stkPush(req) {
      const id = `ws_CO_SIM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result: StkResult = {
        checkoutRequestId: id,
        merchantRequestId: `SIM-${Date.now()}`,
        resultCode: "0",
        resultDesc: "The service request is processed successfully.",
        amount: Math.round(req.amount),
        receipt: `SIM${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
        phone: darajaPhone(req.phone),
      };
      setTimeout(() => {
        results.set(id, result);
        onResult(result);
      }, delayMs).unref?.();
      return { checkoutRequestId: id, merchantRequestId: result.merchantRequestId!, customerMessage: "Success. Request accepted for processing" };
    },
    async query(id) {
      const r = results.get(id);
      return r ? { resultCode: r.resultCode, resultDesc: r.resultDesc } : null;
    },
  };
}

/** M-Pesa result codes people actually hit, in words a customer understands. */
export function describeResult(code: string, fallback: string): string {
  switch (code) {
    case "0":
      return "Payment received";
    case "1":
      return "Your M-Pesa balance was too low for this payment";
    case "1032":
      return "The prompt was cancelled on the phone";
    case "1037":
      return "The phone could not be reached. Check it is on and has signal";
    case "2001":
      return "The M-Pesa PIN was incorrect";
    case "1019":
      return "The prompt expired before it was answered";
    default:
      return fallback || "M-Pesa could not complete the payment";
  }
}

// ——— B2C: paying workers their share and refunding clients ———

export type B2cRequest = { originatorId: string; phone: string; amount: number; remarks: string; occasion: string };
export type B2cAccepted = { conversationId: string; originatorId: string };
export type B2cResult = { originatorId?: string; conversationId?: string; resultCode: string; resultDesc: string; receipt?: string; receiver?: string; amount?: number };

export interface B2cDriver {
  name: "daraja" | "simulated";
  send(req: B2cRequest, urls: { result: string; timeout: string }): Promise<B2cAccepted>;
}

export const b2cConfigured = () => Boolean(env.mpesa.b2c.shortcode && env.mpesa.b2c.initiator && env.mpesa.b2c.securityCredential && env.mpesa.consumerKey);

export const darajaB2c: B2cDriver = {
  name: "daraja",
  async send(req, urls) {
    const { shortcode, initiator, securityCredential, commandId } = env.mpesa.b2c;
    const j = await darajaPost<{ ConversationID: string; OriginatorConversationID: string; ResponseCode: string; ResponseDescription: string }>("/mpesa/b2c/v3/paymentrequest", {
      OriginatorConversationID: req.originatorId,
      InitiatorName: initiator,
      SecurityCredential: securityCredential,
      CommandID: commandId,
      Amount: Math.round(req.amount),
      PartyA: shortcode,
      PartyB: darajaPhone(req.phone),
      Remarks: req.remarks.slice(0, 100),
      QueueTimeOutURL: urls.timeout,
      ResultURL: urls.result,
      Occassion: req.occasion.slice(0, 100),
    });
    if (j.ResponseCode !== "0") throw new Error(j.ResponseDescription || "M-Pesa did not accept the payout");
    return { conversationId: j.ConversationID, originatorId: j.OriginatorConversationID || req.originatorId };
  },
};

/** Pays every payout a few seconds later through the same result path Safaricom uses. */
export function simulatedB2c(onResult: (r: B2cResult) => void, delayMs = 3000): B2cDriver {
  return {
    name: "simulated",
    async send(req) {
      const conversationId = `AG_SIM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setTimeout(() => {
        onResult({
          originatorId: req.originatorId,
          conversationId,
          resultCode: "0",
          resultDesc: "The service request is processed successfully.",
          receipt: `SIM${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
          amount: Math.round(req.amount),
        });
      }, delayMs).unref?.();
      return { conversationId, originatorId: req.originatorId };
    },
  };
}

/** Reads Safaricom's B2C result (or queue time-out) body. */
export function parseB2cResult(body: unknown): B2cResult | null {
  const r = (body as { Result?: Record<string, unknown> })?.Result;
  if (!r) return null;
  const params = ((r.ResultParameters as { ResultParameter?: { Key: string; Value?: unknown }[] })?.ResultParameter ?? []).reduce<Record<string, unknown>>(
    (acc, p) => ((acc[p.Key] = p.Value), acc),
    {},
  );
  return {
    originatorId: typeof r.OriginatorConversationID === "string" ? r.OriginatorConversationID : undefined,
    conversationId: typeof r.ConversationID === "string" ? r.ConversationID : undefined,
    resultCode: String(r.ResultCode ?? ""),
    resultDesc: String(r.ResultDesc ?? ""),
    receipt: typeof r.TransactionID === "string" && r.TransactionID ? r.TransactionID : params.TransactionReceipt != null ? String(params.TransactionReceipt) : undefined,
    receiver: params.ReceiverPartyPublicName != null ? String(params.ReceiverPartyPublicName) : undefined,
    amount: params.TransactionAmount != null ? Number(params.TransactionAmount) : undefined,
  };
}
