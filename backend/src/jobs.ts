import { db } from "./config/db.js";
import { dispatchTick } from "./services/dispatch.js";
import { autoRelease, detectNoShows, expireUnpaid } from "./services/jobflow.js";
import { reconcile } from "./services/payments.js";
import { sendDuePayouts } from "./services/payouts.js";
import { retryDueSms } from "./services/sms.js";

// Two loops. Dispatch runs every five seconds, because acceptance windows are two minutes
// long. Housekeeping runs every thirty: M-Pesa follow-up, unpaid bookings, no-shows,
// auto-release, payouts and SMS retries.

async function housekeeping() {
  await reconcile();
  await expireUnpaid();
  await detectNoShows();
  await autoRelease();
  await sendDuePayouts();
  await retryDueSms();
  await db().query(`delete from otp_codes where created_at < now() - interval '2 days'`);
  await db().query(`delete from perf_samples where created_at < now() - interval '180 days'`);
}

function loop(name: string, fn: () => Promise<void>, everyMs: number, firstMs: number) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[jobs:${name}]`, e);
    } finally {
      running = false;
    }
  };
  setTimeout(run, firstMs).unref();
  setInterval(run, everyMs).unref();
}

export function startJobs() {
  loop("dispatch", dispatchTick, 5_000, 2_000);
  loop("housekeeping", housekeeping, 30_000, 6_000);
}

export const runDispatchOnce = dispatchTick;
export const runHousekeepingOnce = housekeeping;
