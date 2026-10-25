import { db, one } from "../config/db.js";
import { HttpError } from "../utils/http.js";
import { sha256, sixDigits } from "../utils/security.js";
import { queueSms } from "./sms.js";

// Six-digit sign-in codes sent by SMS: ten minutes to use, five tries, one send a minute,
// five sends an hour per number.

const hash = (phone: string, code: string) => sha256(`${phone}:${code}`);

export async function sendCode(phone: string): Promise<string> {
  const recent = await one<{ last: boolean; hour: number }>(
    db(),
    `select bool_or(created_at > now() - interval '60 seconds') as last, count(*)::int as hour
       from otp_codes where phone = $1 and purpose = 'login' and created_at > now() - interval '1 hour'`,
    [phone],
  );
  if (recent?.last) throw new HttpError(429, "too_soon", "A code was sent less than a minute ago");
  if ((recent?.hour ?? 0) >= 5) throw new HttpError(429, "too_many", "Too many codes for this number. Try again in an hour.");
  const code = sixDigits();
  await db().query(`insert into otp_codes (phone, purpose, code_hash, expires_at) values ($1, 'login', $2, now() + interval '10 minutes')`, [phone, hash(phone, code)]);
  await queueSms({ to: phone, body: `${code} is your Mjengo O'clock sign-in code. It expires in 10 minutes. Never share it.`, purpose: "otp", ttlMinutes: 5 });
  return code;
}

export async function checkCode(phone: string, code: string): Promise<boolean> {
  return db().tx(async (q) => {
    const row = await one<{ id: string; code_hash: string; attempts: number }>(
      q,
      `select id, code_hash, attempts from otp_codes where phone = $1 and purpose = 'login' and used_at is null and expires_at > now() order by created_at desc limit 1 for update`,
      [phone],
    );
    if (!row || row.attempts >= 5) return false;
    if (row.code_hash !== hash(phone, code.trim())) {
      await q.query(`update otp_codes set attempts = attempts + 1 where id = $1`, [row.id]);
      return false;
    }
    await q.query(`update otp_codes set used_at = now() where id = $1`, [row.id]);
    return true;
  });
}
