// Prices and the escrow split (PRD 4.4 and 4.6, and the construction and site labour rate
// schedule). Pure functions, so the numbers the client sees before booking are the same
// ones the settlement uses.
//
// Four ways a rate applies:
//   flat      one task or visit at a fixed price (plumber, welder, fundi, site visits)
//   hourly    rate × hours
//   shift     a fixed price for a standard 8-hour shift; hours beyond it are billed at the
//             overtime (hourly) rate where the schedule has one
//   per_unit  rate × quantity (earthworks by the foot, painters and gypsum installers by the day)
//
// The platform adds client_fee_pct to the job price and deducts worker_fee_pct from the
// worker's share: on a KES 1,000 job the client pays 1,090, the worker receives 910 and
// the platform keeps 180. No minimum fee. Tips go to the worker in full.

export type Pricing = "flat" | "hourly" | "shift" | "per_unit";

export const pct = (amount: number, p: number) => Math.round((amount * p) / 100);

export type Quote = {
  pricing: Pricing;
  rate: number;
  /** Hours booked (hourly), or the shift length plus overtime (shift). 1 otherwise. */
  hours: number;
  /** Units booked (per_unit). 1 otherwise. */
  quantity: number;
  overtimeHours: number;
  overtimeRate: number | null;
  overtimeKes: number;
  base: number;
  clientFeePct: number;
  clientFee: number;
  total: number;
  workerFeePct: number;
  workerFee: number;
  workerNet: number;
};

export function quote(s: {
  pricing: Pricing;
  rate: number;
  hours?: number;
  quantity?: number;
  shiftHours?: number;
  overtimeHours?: number;
  overtimeRate?: number | null;
  clientFeePct: number;
  workerFeePct: number;
}): Quote {
  const overtimeHours = s.pricing === "shift" && s.overtimeRate ? Math.max(0, s.overtimeHours ?? 0) : 0;
  const overtimeKes = Math.round(overtimeHours * (s.overtimeRate ?? 0));
  const hours = s.pricing === "hourly" ? (s.hours ?? 1) : s.pricing === "shift" ? (s.shiftHours ?? 8) + overtimeHours : 1;
  const quantity = s.pricing === "per_unit" ? (s.quantity ?? 1) : 1;
  const base =
    s.pricing === "hourly" ? Math.round(s.rate * hours) : s.pricing === "per_unit" ? Math.round(s.rate * quantity) : s.pricing === "shift" ? s.rate + overtimeKes : s.rate;
  const clientFee = pct(base, s.clientFeePct);
  const workerFee = pct(base, s.workerFeePct);
  return {
    pricing: s.pricing,
    rate: s.rate,
    hours,
    quantity,
    overtimeHours,
    overtimeRate: s.pricing === "shift" ? (s.overtimeRate ?? null) : null,
    overtimeKes,
    base,
    clientFeePct: s.clientFeePct,
    clientFee,
    total: base + clientFee,
    workerFeePct: s.workerFeePct,
    workerFee,
    workerNet: base - workerFee,
  };
}

/** "per task", "per hour", "per 8-hour shift", "per foot". */
export function unitPhrase(p: { pricing: Pricing; unit_label?: string | null; shift_hours?: number | null }): string {
  if (p.pricing === "hourly") return "per hour";
  if (p.pricing === "shift") return `per ${Number(p.shift_hours ?? 8)}-hour shift`;
  if (p.pricing === "per_unit") return p.unit_label === "ft" ? "per foot" : `per ${p.unit_label || "unit"}`;
  return `per ${p.unit_label || "task"}`;
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
