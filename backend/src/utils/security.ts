import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Admin passwords (bcrypt), JWTs, one-time codes, encryption of admin TOTP secrets and
// national ID numbers, and signed links to private photos.

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type UserClaims = { sub: string; tv: number; aud: "user" };
export type AdminClaims = { sub: string; tv: number; aud: "admin"; mfa: boolean };

export function signUser(id: string, tokenVersion: number): string {
  return jwt.sign({ tv: tokenVersion }, env.jwtSecret, { subject: id, audience: "user", expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"] });
}

/** Admin tokens are short-lived; `mfa` is false until the TOTP step has passed. */
export function signAdmin(id: string, tokenVersion: number, mfa: boolean): string {
  return jwt.sign({ tv: tokenVersion, mfa }, env.jwtSecret, { subject: id, audience: "admin", expiresIn: mfa ? "12h" : "10m" });
}

export function verifyToken<T extends UserClaims | AdminClaims>(token: string, aud: T["aud"]): T | null {
  try {
    return jwt.verify(token, env.jwtSecret, { audience: aud }) as T;
  } catch {
    return null;
  }
}

export const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Short human reference without look-alike characters. */
export function shortRef(prefix: string, len = 6): string {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = prefix;
  for (let i = 0; i < len; i++) s += abc[randomInt(0, abc.length)];
  return s;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", env.masterKey, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1") throw new Error("unknown ciphertext version");
  const d = createDecipheriv("aes-256-gcm", env.masterKey, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

// RFC 6238 TOTP, SHA-1, 6 digits, 30 s steps — what every authenticator app speaks.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "", out = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Decode(s: string): Buffer {
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const step = Math.floor(now / 30_000);
  const want = Buffer.from(code.replace(/\s/g, ""));
  return [-1, 0, 1].some((d) => {
    const got = Buffer.from(totpAt(secret, step + d));
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
export const totpUri = (secret: string, account: string) =>
  `otpauth://totp/Mjengo%20Admin:${encodeURIComponent(account)}?secret=${secret}&issuer=Mjengo%20Admin&period=30&digits=6`;

/** A link to a private photo that works for a few hours, for people allowed to see it. */
export function signMedia(id: string, ttlSeconds = 6 * 3600, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = createHmac("sha256", env.mediaKey).update(`${id}.${exp}`).digest("base64url");
  return `/api/media/${id}?e=${exp}&s=${sig}`;
}
export function checkMediaSig(id: string, exp: string, sig: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
  const want = Buffer.from(createHmac("sha256", env.mediaKey).update(`${id}.${exp}`).digest("base64url"));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** URL-safe random token, for invoice links and the like. */
export const randomToken = (bytes = 18) => randomBytes(bytes).toString("base64url");
