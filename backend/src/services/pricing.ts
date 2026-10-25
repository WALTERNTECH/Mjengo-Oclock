// Prices and the escrow split (PRD 4.4 and 4.6). Pure functions, so the numbers the client
// sees before booking are the same ones the settlement uses.
//
// The platform adds client_fee_pct to the job price and deducts worker_fee_pct from the
// worker's share: on a KES 1,000 job the client pays 1,090, the worker receives 910 and
// the platform keeps 180. No minimum fee. Tips go to the worker in full.

export const pct = (amount: number, p: number) => Math.round((amount * p) / 100);

export type Quote = {
  pricing: "flat" | "hourly";
  rate: number;
  hours: number;
  base: number;
  clientFeePct: number;
  clientFee: number;
  total: number;
  workerFeePct: number;
  workerFee: number;
  workerNet: number;
};

export function quote(s: { pricing: "flat" | "hourly"; rate: number; hours: number; clientFeePct: number; workerFeePct: number }): Quote {
  const hours = s.pricing === "hourly" ? s.hours : 1;
  const base = s.pricing === "hourly" ? Math.round(s.rate * hours) : s.rate;
  const clientFee = pct(base, s.clientFeePct);
  const workerFee = pct(base, s.workerFeePct);
  return { pricing: s.pricing, rate: s.rate, hours, base, clientFeePct: s.clientFeePct, clientFee, total: base + clientFee, workerFeePct: s.workerFeePct, workerFee, workerNet: base - workerFee };
}

export type Split = { workerGross: number; workerNet: number; refund: number; platform: number };

/**
 * Divides what the client paid into escrow. `workerGross` is the work value the worker is
 * paid for (all of it on approval, nothing on a full refund, part on a split decision).
 * The platform's fees apply only to that part; the rest goes back to the client.
 * With `flatFee` the amount is a cancellation or call-out fee paid to the worker in full.
 */
export function split(p: { paid: number; workerGross: number; clientFeePct: number; workerFeePct: number; fullRelease?: boolean; flatFee?: boolean }): Split {
  const gross = Math.max(0, Math.min(p.workerGross, p.paid));
  if (p.flatFee) return { workerGross: gross, workerNet: gross, refund: p.paid - gross, platform: 0 };
  const workerFee = pct(gross, p.workerFeePct);
  const workerNet = gross - workerFee;
  // On approval nothing is refunded, so rounding differences on extras stay with the platform.
  const refund = p.fullRelease ? 0 : Math.max(0, p.paid - gross - pct(gross, p.clientFeePct));
  return { workerGross: gross, workerNet, refund, platform: p.paid - workerNet - refund };
}
