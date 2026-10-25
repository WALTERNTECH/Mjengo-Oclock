import type { Q } from "../config/db.js";
import { env } from "../config/env.js";

// Identity checks for worker applications (PRD 5.1). The PRD proposes Smile ID, which
// matches the national ID against government records and the selfie against the ID photo,
// with Didit as the fallback; the provider is still an open question (PRD 13).
//
// Until a provider contract and sandbox keys exist, the "manual" driver sends every
// application to the admin queue, where the ID photo and selfie are shown side by side.
// An automated driver implements `check` and returns "verified" (admins then review only
// certificates), "failed" or "manual_review" (unclear: an admin decides).

export type IdCheckInput = { userId: string; fullName: string; nationalId: string; idFrontMediaId: string; selfieMediaId: string };
export type IdCheckOutcome = { status: "verified" | "failed" | "manual_review"; provider: string; detail: Record<string, unknown> };

export interface IdVerifier {
  name: string;
  check(q: Q, input: IdCheckInput): Promise<IdCheckOutcome>;
}

const manual: IdVerifier = {
  name: "manual",
  async check() {
    return { status: "manual_review", provider: "manual", detail: { note: "No automated ID provider is connected; an admin compares the ID photo and selfie." } };
  },
};

export const idVerifier = (): IdVerifier => {
  switch (env.idVerifyDriver) {
    default:
      return manual;
  }
};
