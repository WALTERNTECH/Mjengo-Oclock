import { db } from "./config/db.js";
import { dispatchTick } from "./services/dispatch.js";
import { autoRelease, detectNoShows, expireUnpaid } from "./services/jobflow.js";
import { reconcile } from "./services/payments.js";
import { sendDuePayouts } from "./services/payouts.js";
import { retryDueSms } from "./services/sms.js";
import { background } from "./utils/background.js";

// Two jobs. Dispatch runs every five seconds, because acceptance windows are two minutes
// long. Housekeeping runs every thirty: M-Pesa follow-up, unpaid bookings, no-shows,
// auto-release, payouts and SMS retries.
//
// On a long-running server timers start them. On Vercel there is no process between
// requests, so API requests start them instead (kickJobs), and a daily cron covers quiet
// spells. Either way a lease row in job_leases makes sure one runner at a time does the work.

async function housekeeping() {
  await reconcile();
  await expireUnpaid();
  await detectNoShows();
  await autoRelease();
  await sendDuePayouts();
  await retryDueSms();
  await db().query(`delete from otp_codes where created_at < now() - interval '2 days'`);
  await db().query(`delete from perf_samples where created_at < now() - interval '180 days'`);
  await db().query(`delete from live_events where created_at < now() - interval '15 minutes'`);
}

const JOBS = {
  dispatch: { fn: dispatchTick, everySec: 5 },
  housekeeping: { fn: housekeeping, everySec: 30 },
} as const;
type JobName = keyof typeof JOBS;

const running = new Set<JobName>();

/** Runs a job if it's due and no one else holds it. */
async function runIfDue(name: JobName) {
  if (running.has(name)) return;
  running.add(name);
  try {
    const { rows } = await db().query(`update job_leases set next_at = now() + ($2::int * interval '1 second') where name = $1 and next_at <= now() returning name`, [
      name,
      JOBS[name].everySec,
    ]);
    if (rows.length) await JOBS[name].fn();
  } catch (e) {
    console.error(`[jobs:${name}]`, e);
  } finally {
    running.delete(name);
  }
}

export const runDueJobs = async () => {
  await runIfDue("dispatch");
  await runIfDue("housekeeping");
};

export function startJobs() {
  for (const name of Object.keys(JOBS) as JobName[]) {
    setTimeout(() => void runIfDue(name), name === "dispatch" ? 2_000 : 6_000).unref();
    setInterval(() => void runIfDue(name), JOBS[name].everySec * 1000).unref();
  }
}

let requestDriven = false;
let lastKick = 0;

/** For hosts without a long-running process (Vercel): API requests start due jobs. */
export function driveJobsFromRequests() {
  requestDriven = true;
}

/** Called on each API request: checks for due jobs at most every three seconds. */
export function kickJobs() {
  if (!requestDriven || Date.now() - lastKick < 3_000) return;
  lastKick = Date.now();
  background(runDueJobs(), "jobs");
}

export const runDispatchOnce = dispatchTick;
export const runHousekeepingOnce = housekeeping;
