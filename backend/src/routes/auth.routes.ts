import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, one } from "../config/db.js";
import { env } from "../config/env.js";
import { checkCode, sendCode } from "../services/otp.js";
import { badRequest, forbidden } from "../utils/http.js";
import { normalizePhone } from "../utils/kenya.js";
import { signUser } from "../utils/security.js";
import { meView } from "./me.routes.js";

// Sign-in is a phone number and a six-digit code by SMS (PRD 4.1). The first successful
// code creates the account; there are no passwords.

export const authRouter = Router();

export const phoneField = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const p = normalizePhone(v);
    if (!p) {
      ctx.addIssue({ code: "custom", message: "Enter a Kenyan mobile number, like 0712 345 678" });
      return z.NEVER;
    }
    return p;
  });

const strict = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.nodeEnv === "test" ? 10_000 : 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many attempts. Wait a few minutes." } },
});

authRouter.post("/request-code", strict, async (req, res) => {
  const { phone } = z.object({ phone: phoneField }).parse(req.body);
  const u = await one<{ status: string }>(db(), `select status from users where phone = $1`, [phone]);
  if (u && u.status === "suspended") throw forbidden("This account is suspended. Contact support.");
  const code = await sendCode(phone);
  // Only while no SMS account is connected (see OTP_ECHO in config/env.ts).
  res.json({ sent: true, phone, devCode: env.otpEcho ? code : undefined });
});

authRouter.post("/verify", strict, async (req, res) => {
  const b = z.object({ phone: phoneField, code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
  if (!(await checkCode(b.phone, b.code))) throw badRequest("That code is wrong or has expired", [{ path: "code", message: "Wrong or expired" }]);
  let u = await one<{ id: string; status: string; token_version: number }>(db(), `select id, status, token_version from users where phone = $1`, [b.phone]);
  let isNew = false;
  if (!u) {
    u = await one(db(), `insert into users (phone) values ($1) on conflict (phone) do update set phone = excluded.phone returning id, status, token_version`, [b.phone]);
    isNew = true;
  }
  if (u!.status === "suspended") throw forbidden("This account is suspended. Contact support.");
  if (u!.status === "deleted") {
    // A deleted account's number starts again from a clean profile.
    u = await one(db(), `update users set status = 'active', full_name = '', email = null, token_version = token_version + 1 where id = $1 returning id, status, token_version`, [u!.id]);
    isNew = true;
  }
  res.json({ token: signUser(u!.id, u!.token_version), user: await meView(u!.id), isNew });
});
