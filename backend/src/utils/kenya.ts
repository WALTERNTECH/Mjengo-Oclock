// Kenyan phone numbers, money and Nairobi time.

/** Accepts 07XX, 01XX, 7XX, 254…, +254… and returns +2547XXXXXXXX / +2541XXXXXXXX, or null. */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/[\s()-]/g, "").replace(/^\+/, "");
  const m = d.match(/^254([17]\d{8})$/) ?? d.match(/^0([17]\d{8})$/) ?? d.match(/^([17]\d{8})$/);
  return m ? `+254${m[1]}` : null;
}

/** The 2547XXXXXXXX form Daraja and Celcom want. */
export const darajaPhone = (e164: string) => e164.replace(/^\+/, "");

export const maskPhone = (e164: string) => e164.replace(/^(\+254\d{2})\d{4}(\d{3})$/, "$1 •••• $2");

export const kes = (n: number) => `KES ${Math.round(n).toLocaleString("en-KE")}`;

/** "3:40 pm" in Nairobi. */
export const timeEAT = (d: Date | string | number) =>
  new Date(d).toLocaleTimeString("en-KE", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Africa/Nairobi" }).toLowerCase();

/** "Sat 26 Oct, 9:00 am" in Nairobi. */
export const whenEAT = (d: Date | string | number) =>
  new Date(d).toLocaleString("en-KE", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Africa/Nairobi" });

/** First name and the initial of the last, as workers and clients see each other: "Juma K." */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
