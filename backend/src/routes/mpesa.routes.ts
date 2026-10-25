import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, one } from "../config/db.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { paymentDriver, publicPayment, settle, type PaymentRow } from "../services/payments.js";
import { handleB2cResult } from "../services/payouts.js";
import { notFound } from "../utils/http.js";
import { daraja, parseB2cResult, parseCallback } from "../utils/mpesa.js";

export const mpesaRouter = Router();

mpesaRouter.get("/payments/:id", requireAuth, async (req, res) => {
  if (!z.uuid().safeParse(req.params.id).success) throw notFound("Payment not found");
  const p = await one<PaymentRow>(db(), `select * from payments where id = $1`, [req.params.id]);
  if (!p || p.user_id !== req.user!.id) throw notFound("Payment not found");
  res.json({ payment: publicPayment(p) });
});

const tokenOk = (got: string) => {
  const a = Buffer.from(got), b = Buffer.from(env.mpesa.callbackToken);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Safaricom's result webhook. Daraja signs nothing, so the URL carries a secret, and a
 * reported success is confirmed with our own status query before any job is released.
 * Always answers 200, as Daraja requires.
 */
mpesaRouter.post("/callback/:token", async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  if (!tokenOk(String(req.params.token))) {
    console.warn(`[mpesa] callback with a wrong token from ${req.ip}`);
    return;
  }
  const r = parseCallback(req.body);
  if (!r) {
    console.warn("[mpesa] unreadable callback body");
    return;
  }
  try {
    if (r.resultCode === "0" && paymentDriver() === "daraja") {
      const check = await daraja.query(r.checkoutRequestId).catch(() => null);
      // Not confirmed yet: leave it pending; the reconciler asks again shortly.
      if (!check || check.resultCode !== "0") {
        console.warn(`[mpesa] success callback for ${r.checkoutRequestId} not confirmed by query (${check?.resultCode ?? "no answer"})`);
        if (check) await settle({ ...r, resultCode: check.resultCode, resultDesc: check.resultDesc }, "query", req.body);
        return;
      }
    }
    await settle(r, "callback", req.body);
  } catch (e) {
    console.error("[mpesa] settle failed", e);
  }
});

/** Safaricom's answer to a payout or refund (B2C). Same secret path as the STK callback. */
mpesaRouter.post("/b2c/result/:token", async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  if (!tokenOk(String(req.params.token))) return console.warn(`[mpesa] b2c result with a wrong token from ${req.ip}`);
  const r = parseB2cResult(req.body);
  if (!r) return console.warn("[mpesa] unreadable b2c result");
  await handleB2cResult(r).catch((e) => console.error("[mpesa] b2c result", e));
});

/** The payout sat in Safaricom's queue too long and wasn't processed; it will be retried. */
mpesaRouter.post("/b2c/timeout/:token", async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  if (!tokenOk(String(req.params.token))) return;
  const r = parseB2cResult(req.body);
  if (r) await handleB2cResult({ ...r, resultCode: r.resultCode && r.resultCode !== "0" ? r.resultCode : "timeout", resultDesc: r.resultDesc || "Timed out in the M-Pesa queue" }).catch(() => {});
});
