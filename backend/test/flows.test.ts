import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";

// End-to-end flows against an in-process Postgres, following the PRD's user stories:
// SMS sign-in, booking with the 9% + 9% split, nearest-worker dispatch with time-outs,
// live status and ETA texts, extras, invoices, approval and payout, every cancellation
// rule, no-shows both ways, disputes, auto-release, rating suspension, safety alerts,
// location privacy, and the admin console with an authenticator code.

process.env.NODE_ENV = "test";
process.env.MPESA_DRIVER = "simulated";
process.env.MPESA_SIM_DELAY_MS = "30";
process.env.ADMIN_SETUP_TOKEN = "test-setup";

const { pgliteDb, setDb, many, one } = await import("../src/config/db.js");
const { migrate } = await import("../src/migrate.js");
const { seedCatalog } = await import("../src/seed.js");
const { initPayments } = await import("../src/services/payments.js");
const { initPayouts } = await import("../src/services/payouts.js");
const { clearSettingsCache } = await import("../src/services/settings.js");
const { quote, split } = await import("../src/services/pricing.js");
const { createApp } = await import("../src/app.js");
const { runDispatchOnce, runHousekeepingOnce } = await import("../src/jobs.js");
const { totpAt } = await import("../src/utils/security.js");

let base = "";
let close: () => void;
let db: Awaited<ReturnType<typeof pgliteDb>>;
let png: Buffer;

before(async () => {
  db = await pgliteDb();
  setDb(db);
  await migrate(db);
  await seedCatalog(db);
  initPayments();
  initPayouts();
  png = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#1a7f43" } }).png().toBuffer();
  const server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

type Res = { status: number; body: any };
async function call(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text && r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}
async function upload(path: string, fields: Record<string, string>, files: Record<string, number>, token: string): Promise<Res> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const [k, n] of Object.entries(files)) for (let i = 0; i < n; i++) form.append(k, new Blob([new Uint8Array(png)], { type: "image/png" }), `p${i}.png`);
  const r = await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: r.status, body: await r.json() };
}
const ok = (r: Res, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const v = await fn();
    if (v) return v;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const sms = (phone: string) => many<{ body: string; purpose: string }>(db, `select body, purpose from sms_outbox where to_phone = $1 order by created_at`, [phone]);
const lastSms = async (phone: string) => (await sms(phone)).at(-1)?.body ?? "";

// Kilimani, Westlands, Karen, Kasarani, and a point in Mombasa.
const KILIMANI = { lat: -1.2921, lng: 36.7836 };
const WESTLANDS = { lat: -1.2676, lng: 36.8108 };
const KAREN = { lat: -1.3197, lng: 36.7076 };
const KASARANI = { lat: -1.2219, lng: 36.8986 };
const MOMBASA = { lat: -4.0435, lng: 39.6682 };

let n = 0;
async function signIn(name: string, at = KILIMANI) {
  const phone = `07${String(10_000_000 + ++n).slice(-8)}`;
  const sent = ok(await call("POST", "/api/auth/request-code", { phone }));
  assert.match(sent.devCode, /^\d{6}$/);
  const v = ok(await call("POST", "/api/auth/verify", { phone, code: sent.devCode }));
  ok(await call("PATCH", "/api/me", { fullName: name, acceptTerms: true, home: { label: "Home", ...at }, locationConsent: true }, v.token));
  return { token: v.token as string, id: v.user.id as string, phone: v.user.phone as string };
}

let admin = "";
async function adminToken() {
  if (admin) return admin;
  const s = ok(await call("POST", "/api/admin/setup", { token: "test-setup", name: "Ops Lead", email: "ops@example.com", password: "a long admin password" }), 201);
  const code = totpAt(s.enrol.secret, Math.floor(Date.now() / 30_000));
  admin = ok(await call("POST", "/api/admin/totp", { code }, s.token)).token;
  return admin;
}

async function worker(name: string, category: string, at: { lat: number; lng: number }, opts: { approve?: boolean; available?: boolean } = {}) {
  const w = await signIn(name, at);
  ok(await call("PUT", "/api/worker/profile", { categoryId: category, bio: "Ten years on Nairobi sites", yearsExperience: 10, nationalId: "23456789", payoutMethod: "mpesa" }, w.token));
  ok(await upload("/api/worker/documents/id-front", {}, { file: 1 }, w.token), 201);
  ok(await upload("/api/worker/documents/selfie", {}, { file: 1 }, w.token), 201);
  const cert = (await one<{ requires_certificate: boolean }>(db, `select requires_certificate from categories where id = $1`, [category]))!.requires_certificate;
  if (cert) {
    const early = await call("POST", "/api/worker/submit", {}, w.token);
    assert.equal(early.status, 400);
    assert.match(early.body.error.message, /certificate/);
    ok(await upload("/api/worker/documents/certificate", {}, { file: 1 }, w.token), 201);
  }
  const sub = ok(await call("POST", "/api/worker/submit", {}, w.token));
  assert.equal(sub.profile.status, "submitted");
  assert.equal(sub.profile.idCheck, "manual_review");
  if (opts.approve !== false) {
    ok(await call("POST", `/api/admin/workers/${w.id}/decision`, { decision: "approved", idVerified: true }, await adminToken()));
    if (opts.available !== false) ok(await call("POST", "/api/worker/availability", { available: true, ...at, accuracy: 15 }, w.token));
  }
  return w;
}

const svc = async (name: string) => (await one<{ id: string }>(db, `select id from services where name = $1`, [name]))!.id;

async function book(client: { token: string }, service: string, extra: Record<string, unknown> = {}) {
  const r = ok(await call("POST", "/api/jobs", { serviceId: await svc(service), address: "Argwings Kodhek Rd, Kilimani, Nairobi", ...KILIMANI, description: "Kitchen tap drips all night and the pipe under the sink leaks.", ...extra }, client.token), 201);
  return r.job;
}
async function payHold(client: { token: string; phone: string }, jobId: string) {
  const p = ok(await call("POST", `/api/jobs/${jobId}/pay`, { phone: client.phone }, client.token), 202);
  await until(async () => (await call("GET", `/api/mpesa/payments/${p.paymentId}`, undefined, client.token)).body.payment.status === "SUCCESS", "hold payment");
  return until(async () => {
    const j = (await call("GET", `/api/jobs/${jobId}`, undefined, client.token)).body.job;
    return j.status !== "PENDING_PAYMENT" && j;
  }, "job confirmed");
}
const offerFor = async (w: { token: string }) => (await call("GET", "/api/worker/offer", undefined, w.token)).body.offer;
const job = async (c: { token: string }, id: string) => ok(await call("GET", `/api/jobs/${id}`, undefined, c.token)).job;
const payouts = (jobId: string) => many<{ kind: string; amount_kes: number; status: string }>(db, `select kind, amount_kes, status from payouts where job_id = $1 order by kind`, [jobId]);
async function setting(key: string, value: unknown) {
  await db.query(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
  clearSettingsCache();
}
/** Takes every worker in a trade off duty, so each test controls who is available. */
const offDuty = (category: string) => db.query(`update worker_profiles set available = false where category_id = $1`, [category]);

describe("pricing", () => {
  it("adds 9% for the client and deducts 9% from the worker: 1,000 → 1,090 / 910 / 180", () => {
    const q = quote({ pricing: "flat", rate: 1000, hours: 1, clientFeePct: 9, workerFeePct: 9 });
    assert.deepEqual([q.total, q.workerNet, q.clientFee + q.workerFee], [1090, 910, 180]);
    const h = quote({ pricing: "hourly", rate: 350, hours: 4, clientFeePct: 9, workerFeePct: 9 });
    assert.deepEqual([h.base, h.total], [1400, 1526]);
  });
  it("splits escrow on release, refund, split and flat fees", () => {
    assert.deepEqual(split({ paid: 1090, workerGross: 1000, clientFeePct: 9, workerFeePct: 9, fullRelease: true }), { workerGross: 1000, workerNet: 910, refund: 0, platform: 180 });
    assert.deepEqual(split({ paid: 1090, workerGross: 0, clientFeePct: 9, workerFeePct: 9 }), { workerGross: 0, workerNet: 0, refund: 1090, platform: 0 });
    assert.deepEqual(split({ paid: 1090, workerGross: 500, clientFeePct: 9, workerFeePct: 9 }), { workerGross: 500, workerNet: 455, refund: 545, platform: 90 });
    assert.deepEqual(split({ paid: 1090, workerGross: 500, clientFeePct: 9, workerFeePct: 9, flatFee: true }), { workerGross: 500, workerNet: 500, refund: 590, platform: 0 });
  });
});

describe("sign-in and booking", () => {
  it("signs in with an SMS code and rejects a wrong one", async () => {
    const phone = "0799000111";
    const sent = ok(await call("POST", "/api/auth/request-code", { phone }));
    assert.equal((await call("POST", "/api/auth/request-code", { phone })).status, 429, "one code a minute");
    const wrong = await call("POST", "/api/auth/verify", { phone, code: sent.devCode === "000000" ? "111111" : "000000" });
    assert.equal(wrong.status, 400);
    const v = ok(await call("POST", "/api/auth/verify", { phone, code: sent.devCode }));
    assert.equal(v.isNew, true);
    assert.equal(v.user.phone, "+254799000111");
    assert.equal((await call("POST", "/api/auth/verify", { phone, code: sent.devCode })).status, 400, "a code works once");
    assert.match((await sms("+254799000111"))[0].body, /sign-in code/);
  });

  it("needs a name and the terms, covers Nairobi only, and quotes upfront", async () => {
    const phone = "0799000222";
    const sent = ok(await call("POST", "/api/auth/request-code", { phone }));
    const v = ok(await call("POST", "/api/auth/verify", { phone, code: sent.devCode }));
    const body = { serviceId: await svc("Plumbing job"), address: "Somewhere", ...KILIMANI, description: "A tap that drips constantly." };
    assert.equal((await call("POST", "/api/jobs", body, v.token)).status, 400, "name first");
    ok(await call("PATCH", "/api/me", { fullName: "Akinyi Otieno" }, v.token));
    assert.equal((await call("POST", "/api/jobs", body, v.token)).body.error.code, "terms_required");
    ok(await call("PATCH", "/api/me", { acceptTerms: true }, v.token));
    const far = await call("POST", "/api/jobs", { ...body, ...MOMBASA }, v.token);
    assert.match(far.body.error.message, /Nairobi/);
    const q = ok(await call("POST", "/api/quote", { serviceId: await svc("General worker, by the hour"), hours: 6 }));
    assert.deepEqual([q.quote.base, q.quote.clientFee, q.quote.total], [600, 54, 654]);
    const j = ok(await call("POST", "/api/jobs", { ...body, clientKey: "same-tap-twice" }, v.token), 201).job;
    const again = ok(await call("POST", "/api/jobs", { ...body, clientKey: "same-tap-twice" }, v.token), 201).job;
    assert.equal(again.id, j.id, "a retried booking is not created twice");
    assert.equal(j.price.total, 2180);
    const photos = await upload(`/api/jobs/${j.id}/photos`, {}, { photos: 3 }, v.token);
    assert.equal(photos.body.job.photos.length, 3);
    assert.equal((await upload(`/api/jobs/${j.id}/photos`, {}, { photos: 1 }, v.token)).status, 400, "three photos at most");
    const img = await fetch(base + photos.body.job.photos[0].url);
    assert.equal(img.status, 200);
    assert.equal((await fetch(base + photos.body.job.photos[0].url.replace(/s=[^&]+/, "s=forged"))).status, 404, "photos need a valid signature");
  });
});

describe("dispatch", () => {
  it("offers the nearest approved worker, then the next after a decline or time-out, then hands over after 10 minutes", async () => {
    await offDuty("plumbing");
    const near = await worker("Juma Kamau", "plumbing", WESTLANDS);
    const far = await worker("Otieno Were", "plumbing", KASARANI);
    const pending = await worker("Brian Unapproved", "plumbing", KILIMANI, { approve: false });
    const client = await signIn("Wanjiru Mwangi");
    const j = await book(client, "Plumbing job");
    const confirmed = await payHold(client, j.id);
    assert.equal(confirmed.status, "SEARCHING");
    assert.equal(confirmed.escrow, "HELD");
    assert.match(await lastSms(client.phone), /booking MJ-.* confirmed .*KES 2,180 is held/);

    const o1 = await until(() => offerFor(near), "offer to the nearest");
    assert.equal(await offerFor(far), null);
    assert.equal(o1.earn, 1820);
    assert.equal(o1.area, "Kilimani");
    assert.ok(!("address" in o1), "no full address before accepting");
    assert.match(await lastSms(near.phone), /new job .* km away in Kilimani .*You earn KES 1,820/);
    assert.equal((await call("GET", "/api/worker/offer", undefined, pending.token)).status, 403, "unapproved workers never get offers");

    ok(await call("POST", `/api/worker/offers/${o1.offerId}/decline`, {}, near.token));
    const o2 = await until(() => offerFor(far), "offer to the next nearest");
    await db.query(`update job_offers set expires_at = now() - interval '1 second' where id = $1`, [o2.offerId]);
    await runDispatchOnce();
    assert.equal(await offerFor(far), null);
    assert.equal((await job(client, j.id)).status, "SEARCHING", "keeps looking while nobody is left");

    await db.query(`update jobs set dispatch_started_at = now() - interval '11 minutes' where id = $1`, [j.id]);
    await runDispatchOnce();
    const un = await job(client, j.id);
    assert.equal(un.status, "UNASSIGNED");
    assert.match(await lastSms(client.phone), /no plumber has accepted .*reschedule or cancel at no charge/);
    const alerts = ok(await call("GET", "/api/admin/alerts", undefined, await adminToken())).alerts;
    assert.ok(alerts.some((a: any) => a.kind === "unassigned" && a.job_id === j.id));

    // The team assigns by hand.
    ok(await call("POST", `/api/admin/jobs/${j.id}/assign`, { workerId: near.id }, await adminToken()));
    assert.equal((await job(client, j.id)).status, "ACCEPTED");
    assert.match(await lastSms(near.phone), /assigned you job/);
  });
});

async function acceptedJob(category = "plumbing", service = "Plumbing job", at = WESTLANDS) {
  await offDuty(category);
  const w = await worker(`Worker ${n}`, category, at);
  const c = await signIn(`Client ${n}`);
  const j = await book(c, service);
  await payHold(c, j.id);
  const o = await until(() => offerFor(w), "offer");
  ok(await call("POST", `/api/worker/offers/${o.offerId}/accept`, {}, w.token));
  return { w, c, j };
}

describe("a job from acceptance to payout", () => {
  it("tracks status with SMS, approves extras, issues the invoice, and pays the worker 91%", async () => {
    const { w, c, j } = await acceptedJob();
    let v = await job(c, j.id);
    assert.equal(v.status, "ACCEPTED");
    assert.equal(v.worker.verified, true);
    assert.ok(v.worker.photo, "the client sees the worker's verified photo");
    assert.equal(v.location, null, "no live location until the worker is on the way");

    ok(await call("POST", `/api/worker/jobs/${j.id}/trip`, WESTLANDS, w.token));
    assert.match(await lastSms(c.phone), /is on the way .*ETA about \d+ min/);
    ok(await call("POST", "/api/worker/location", { lat: -1.28, lng: 36.8, accuracy: 10 }, w.token));
    v = await job(c, j.id);
    assert.equal(v.status, "EN_ROUTE");
    assert.equal(v.location.stale, false);
    await db.query(`update worker_profiles set last_location_at = now() - interval '3 minutes' where user_id = $1`, [w.id]);
    assert.equal((await job(c, j.id)).location.stale, true, "Location unavailable after 2 minutes without an update");

    ok(await call("POST", `/api/worker/jobs/${j.id}/arrive`, {}, w.token));
    assert.match(await lastSms(c.phone), /has arrived/);
    ok(await call("POST", `/api/worker/jobs/${j.id}/start`, {}, w.token));

    const noPhoto = await upload(`/api/worker/jobs/${j.id}/extras`, { kind: "materials", amount: "1200", reason: "Copper pipe and fittings" }, {}, w.token);
    assert.equal(noPhoto.status, 400, "extras need a photo");
    ok(await upload(`/api/worker/jobs/${j.id}/extras`, { kind: "materials", amount: "1200", reason: "Copper pipe and fittings" }, { photo: 1 }, w.token), 201);
    assert.match(await lastSms(c.phone), /asks to add materials \(KES 1,308\)/);
    v = await job(c, j.id);
    const x = v.extras[0];
    assert.deepEqual([x.amount, x.fee, x.status], [1200, 108, "PENDING"]);
    const r = ok(await call("POST", `/api/jobs/${j.id}/extras/${x.id}`, { approve: true, phone: c.phone }, c.token), 202);
    assert.equal(r.payment.amount, 1308);
    await until(async () => (await job(c, j.id)).extras[0].status === "APPROVED", "extra paid");

    ok(await upload(`/api/worker/jobs/${j.id}/complete`, {}, { photos: 1 }, w.token));
    v = await job(c, j.id);
    assert.equal(v.status, "COMPLETED");
    assert.deepEqual([v.invoice.subtotal, v.invoice.fee, v.invoice.total, v.invoice.paid], [3200, 288, 3488, 3488]);
    const link = (await lastSms(c.phone)).match(/\/invoice\/(MJ-\w+)\?t=([\w-]+)/)!;
    const inv = ok(await call("GET", `/api/invoice/${link[1]}?t=${link[2]}`));
    assert.equal(inv.invoice.lines.length, 2);
    assert.equal((await call("GET", `/api/invoice/${link[1]}?t=wrong`)).status, 404);

    ok(await call("POST", `/api/jobs/${j.id}/approve`, { stars: 5, review: "Quick and tidy" }, c.token));
    const paid = await until(async () => {
      const p = await payouts(j.id);
      return p.length && p.every((x) => x.status === "PAID") && p;
    }, "payout");
    assert.deepEqual(paid, [{ kind: "WORKER", amount_kes: 2912, status: "PAID" }]);
    const settled = (await one<{ platform_kes: number; escrow: string; status: string }>(db, `select platform_kes, escrow, status from jobs where id = $1`, [j.id]))!;
    assert.deepEqual(settled, { platform_kes: 576, escrow: "RELEASED", status: "CLOSED" });
    assert.match(await lastSms(w.phone), /KES 2,912 for job .* has been sent to your M-Pesa/);

    const tip = ok(await call("POST", `/api/jobs/${j.id}/tip`, { amount: 200, phone: c.phone }, c.token), 202);
    assert.equal(tip.amount, 200);
    await until(async () => (await payouts(j.id)).some((p) => p.kind === "TIP" && p.status === "PAID" && p.amount_kes === 200), "tip paid in full");
    ok(await call("POST", `/api/worker/jobs/${j.id}/rate`, { stars: 4, review: "Clear instructions" }, w.token));
    const earnings = ok(await call("GET", "/api/worker/earnings", undefined, w.token));
    assert.equal(earnings.totals.paid, 3112);
  });

  it("bills extra time on a shift at its overtime rate, and doesn't charge a declined extra", async () => {
    const { w, c, j } = await acceptedJob("general_labor", "General worker, standard shift");
    ok(await call("POST", `/api/worker/jobs/${j.id}/arrive`, {}, w.token));
    ok(await upload(`/api/worker/jobs/${j.id}/extras`, { kind: "hours", hours: "2", reason: "Wall needs chasing" }, { photo: 1 }, w.token), 201);
    const x = (await job(c, j.id)).extras[0];
    assert.equal(x.amount, 200, "two hours past the shift at KES 100 an hour");
    ok(await call("POST", `/api/jobs/${j.id}/extras/${x.id}`, { approve: false }, c.token));
    ok(await call("POST", `/api/worker/jobs/${j.id}/start`, {}, w.token));
    ok(await call("POST", `/api/worker/jobs/${j.id}/complete`, {}, w.token));
    const v = await job(c, j.id);
    assert.equal(v.invoice.total, 872);
  });
});

describe("cancellation rules (PRD section 6)", () => {
  it("is free before acceptance and refunds the hold", async () => {
    await offDuty("plumbing");
    const c = await signIn("Early Canceller");
    const j = await book(c, "Plumbing job");
    await payHold(c, j.id);
    const q = ok(await call("GET", `/api/jobs/${j.id}/cancel-quote`, undefined, c.token)).quote;
    assert.deepEqual([q.fee, q.refund], [0, 2180]);
    ok(await call("POST", `/api/jobs/${j.id}/cancel`, { expectedFee: 0 }, c.token));
    await until(async () => (await payouts(j.id))[0]?.status === "PAID", "refund");
    assert.deepEqual(await payouts(j.id), [{ kind: "REFUND", amount_kes: 2180, status: "PAID" }]);
  });

  it("is free within 5 minutes of booking after acceptance, then charges the late fee to the worker", async () => {
    const a = await acceptedJob();
    assert.equal(ok(await call("GET", `/api/jobs/${a.j.id}/cancel-quote`, undefined, a.c.token)).quote.fee, 0);
    const b = await acceptedJob();
    await db.query(`update jobs set created_at = now() - interval '6 minutes' where id = $1`, [b.j.id]);
    const q = ok(await call("GET", `/api/jobs/${b.j.id}/cancel-quote`, undefined, b.c.token)).quote;
    assert.equal(q.fee, 200);
    assert.equal((await call("POST", `/api/jobs/${b.j.id}/cancel`, { expectedFee: 0 }, b.c.token)).body.error.code, "fee_changed", "the fee shown is the fee charged");
    ok(await call("POST", `/api/jobs/${b.j.id}/cancel`, { expectedFee: 200 }, b.c.token));
    await until(async () => (await payouts(b.j.id)).every((p) => p.status === "PAID") && (await payouts(b.j.id)).length === 2, "fee and refund");
    assert.deepEqual(await payouts(b.j.id), [
      { kind: "REFUND", amount_kes: 1980, status: "PAID" },
      { kind: "WORKER", amount_kes: 200, status: "PAID" },
    ]);
    assert.ok((await sms(b.w.phone)).some((m) => /cancelled job .*KES 200 cancellation fee/.test(m.body)));
  });

  it("charges the en-route fee once the worker is on the way", async () => {
    const { w, c, j } = await acceptedJob();
    ok(await call("POST", `/api/worker/jobs/${j.id}/trip`, {}, w.token));
    assert.equal(ok(await call("GET", `/api/jobs/${j.id}/cancel-quote`, undefined, c.token)).quote.fee, 500);
    ok(await call("POST", `/api/worker/jobs/${j.id}/arrive`, {}, w.token));
    ok(await call("POST", `/api/worker/jobs/${j.id}/start`, {}, w.token));
    const q = ok(await call("GET", `/api/jobs/${j.id}/cancel-quote`, undefined, c.token)).quote;
    assert.equal(q.allowed, false, "no cancelling once work has started");
  });

  it("re-dispatches at no cost when the worker cancels, and never offers it to them again", async () => {
    const { w, c, j } = await acceptedJob();
    const other = await worker("Second Plumber", "plumbing", KAREN);
    ok(await call("POST", `/api/worker/jobs/${j.id}/cancel`, { reason: "Van broke down" }, w.token));
    assert.match(await lastSms(c.phone), /had to cancel .*at no extra cost/);
    const o = await until(() => offerFor(other), "offer to another worker");
    assert.equal(o.jobId, j.id);
    const profile = ok(await call("GET", "/api/worker/profile", undefined, w.token)).profile;
    assert.equal(profile.stats.cancellations, 1);
    assert.equal(profile.available, false);
  });
});

describe("no-shows", () => {
  it("lets the client cancel free when the worker is 30 minutes past the ETA, and flags the worker", async () => {
    const { w, c, j } = await acceptedJob();
    ok(await call("POST", `/api/worker/jobs/${j.id}/trip`, {}, w.token));
    await db.query(`update jobs set eta_at = now() - interval '31 minutes', created_at = now() - interval '1 hour' where id = $1`, [j.id]);
    await runHousekeepingOnce();
    assert.match(await lastSms(c.phone), /hasn't arrived .*cancel at no charge/);
    const q = ok(await call("GET", `/api/jobs/${j.id}/cancel-quote`, undefined, c.token)).quote;
    assert.deepEqual([q.fee, q.refund], [0, 2180]);
    ok(await call("POST", `/api/jobs/${j.id}/cancel`, { expectedFee: 0 }, c.token));
    const wp = (await one<{ no_shows: number; flagged: boolean }>(db, `select no_shows, flagged from worker_profiles where user_id = $1`, [w.id]))!;
    assert.deepEqual(wp, { no_shows: 1, flagged: true });
  });

  it("pays the call-out fee when the client isn't there after a 15-minute wait", async () => {
    const { w, c, j } = await acceptedJob();
    ok(await call("POST", `/api/worker/jobs/${j.id}/arrive`, {}, w.token));
    const early = await call("POST", `/api/worker/jobs/${j.id}/no-show`, { note: "Gate locked" }, w.token);
    assert.equal(early.status, 409);
    await db.query(`update jobs set on_site_at = now() - interval '16 minutes' where id = $1`, [j.id]);
    ok(await call("POST", `/api/worker/jobs/${j.id}/no-show`, { note: "Gate locked, no answer on the phone" }, w.token));
    assert.equal((await job(c, j.id)).outcome, "client_no_show");
    await until(async () => (await payouts(j.id)).length === 2, "payouts");
    assert.deepEqual((await payouts(j.id)).map((p) => [p.kind, p.amount_kes]), [["REFUND", 1680], ["WORKER", 500]]);
  });
});

describe("disputes and auto-release", () => {
  async function completed() {
    const a = await acceptedJob();
    for (const step of ["arrive", "start", "complete"]) ok(await call("POST", `/api/worker/jobs/${a.j.id}/${step}`, {}, a.w.token));
    return a;
  }

  it("freezes escrow on a dispute and applies the admin's split, telling both sides", async () => {
    const { w, c, j } = await completed();
    ok(await upload(`/api/jobs/${j.id}/dispute`, { reason: "Still leaking", details: "The pipe drips again an hour after the plumber left." }, { photos: 1 }, c.token));
    const v = await job(c, j.id);
    assert.deepEqual([v.status, v.escrow], ["DISPUTED", "FROZEN"]);
    assert.equal((await call("POST", `/api/jobs/${j.id}/approve`, {}, c.token)).status, 409);
    const open = ok(await call("GET", "/api/admin/disputes", undefined, await adminToken())).disputes;
    assert.ok(open.some((d: any) => d.job_id === j.id));
    const bad = await call("POST", `/api/admin/disputes/${j.id}/resolve`, { decision: "SPLIT", workerGross: 2500, note: "More than the work value" }, await adminToken());
    assert.equal(bad.status, 400);
    ok(await call("POST", `/api/admin/disputes/${j.id}/resolve`, { decision: "SPLIT", workerGross: 750, note: "The seal was fixed but the pipe was not." }, await adminToken()));
    await until(async () => (await payouts(j.id)).length === 2, "split payouts");
    // Worker: 750 less 9% (68) = 682. Client: 2,180 less 750 and its 9% fee (68) = 1,362. Platform keeps 136.
    assert.deepEqual((await payouts(j.id)).map((p) => [p.kind, p.amount_kes]), [["REFUND", 1362], ["WORKER", 682]]);
    assert.equal((await one<{ platform_kes: number }>(db, `select platform_kes from jobs where id = $1`, [j.id]))!.platform_kes, 136);
    assert.ok((await sms(c.phone)).some((m) => /decision on job .*split/.test(m.body)));
    assert.ok((await sms(w.phone)).some((m) => /decision on job .*KES 682/.test(m.body)));
  });

  it("releases escrow by itself 24 hours after completion", async () => {
    const { j } = await completed();
    await db.query(`update jobs set completed_at = now() - interval '25 hours' where id = $1`, [j.id]);
    await runHousekeepingOnce();
    const r = (await one<{ status: string; auto_released: boolean }>(db, `select status, auto_released from jobs where id = $1`, [j.id]))!;
    assert.deepEqual(r, { status: "CLOSED", auto_released: true });
    await until(async () => (await payouts(j.id))[0]?.amount_kes === 1820, "auto-released payout");
  });

  it("refuses a dispute after the 24-hour window", async () => {
    const { c, j } = await completed();
    await db.query(`update jobs set completed_at = now() - interval '25 hours' where id = $1`, [j.id]);
    const r = await upload(`/api/jobs/${j.id}/dispute`, { reason: "Late", details: "Raising this far too late to count." }, {}, c.token);
    assert.equal(r.status, 409);
  });
});

describe("quality and safety", () => {
  it("suspends a worker whose last 10 ratings average below 3.5", async () => {
    const { w, c, j } = await acceptedJob("electrical", "Electrician, by the hour");
    for (const step of ["arrive", "start", "complete"]) ok(await call("POST", `/api/worker/jobs/${j.id}/${step}`, {}, w.token));
    // Nine earlier 3-star ratings from other clients, then this client's 2: average 2.9.
    for (let i = 0; i < 9; i++) {
      const r = await signIn(`Rater ${i}`);
      await db.query(`insert into ratings (job_id, rater_id, ratee_id, rater_role, stars, created_at) values ($1, $2, $3, 'client', 3, now() - make_interval(days => $4))`, [j.id, r.id, w.id, i + 1]);
    }
    ok(await call("POST", `/api/jobs/${j.id}/rate`, { stars: 2, review: "Left a mess" }, c.token));
    const p = ok(await call("GET", "/api/worker/profile", undefined, w.token)).profile;
    assert.equal(p.status, "suspended");
    assert.equal((await call("GET", "/api/worker/offer", undefined, w.token)).status, 403);
    assert.match(await lastSms(w.phone), /paused for review/);
  });

  it("flags probation jobs for a new worker's first five", async () => {
    const { j } = await acceptedJob("general_labor", "General worker, standard shift");
    assert.equal((await one<{ probation: boolean }>(db, `select probation from jobs where id = $1`, [j.id]))!.probation, true);
  });

  it("alerts the emergency contact and the team when someone raises an emergency", async () => {
    const { w, j } = await acceptedJob();
    await setting("alert_phones", "+254700000999");
    ok(await call("PATCH", "/api/me", { emergency: { name: "Mary Kamau", phone: "0722000333" } }, w.token));
    const r = ok(await call("POST", "/api/safety/report", { jobId: j.id, kind: "emergency", category: "Threatened on site", message: "Need help", lat: -1.29, lng: 36.78, alertContact: true }, w.token), 201);
    assert.equal(r.contactAlerted, true);
    assert.match(await lastSms("+254722000333"), /safety alert: .*emergency .*maps\.google\.com/);
    assert.match(await lastSms("+254700000999"), /EMERGENCY on MJ-/);
    const reports = ok(await call("GET", "/api/admin/reports", undefined, await adminToken())).reports;
    assert.equal(reports[0].kind, "emergency");
  });
});

describe("rate schedule", () => {
  it("lists every rate in the construction and site labour schedule", async () => {
    const cats = ok(await call("GET", "/api/catalog")).categories as { id: string; section: string; services: { name: string; pricing: string; rate: number; unitPhrase: string; overtimeRate: number | null; zone: string }[] }[];
    const got = cats.flatMap((c) => c.services.map((s) => [c.id, s.name, s.pricing, s.rate, s.unitPhrase]));
    assert.deepEqual(got, [
      ["general_labor", "General worker, standard shift", "shift", 800, "per 8-hour shift"],
      ["general_labor", "General worker, by the hour", "hourly", 100, "per hour"],
      ["general_labor", "Heavy labor: clearing, loading and bagging", "hourly", 200, "per hour"],
      ["general_labor", "Earthworks: digging and trenching", "per_unit", 60, "per foot"],
      ["plumbing", "Plumbing job", "flat", 2000, "per task"],
      ["electrical", "Electrician, by the hour", "hourly", 250, "per hour"],
      ["welding", "Welding job", "flat", 2000, "per task"],
      ["fundi", "General fundi job", "flat", 1600, "per task"],
      ["site_management", "Site manager visit, Nairobi", "flat", 15000, "per visit"],
      ["site_management", "Site manager visit, outside Nairobi", "flat", 35000, "per visit"],
      ["site_management", "Foreman, standard shift", "shift", 2000, "per 8-hour shift"],
    ]);
    assert.deepEqual([...new Set(cats.map((c) => c.section))], ["General labor services", "Specialized trades and skilled crafts", "Management and supervisory roles"]);
    const shift = cats[0].services[0];
    assert.equal(shift.overtimeRate, 100, "hours past the shift bill at the general worker hourly rate");
    assert.equal(cats.find((c) => c.id === "site_management")!.services[2].overtimeRate, null, "the schedule gives no hourly rate for a foreman");
  });

  it("bills hours beyond an 8-hour shift hourly, only where the schedule has an hourly rate", async () => {
    const c = await signIn("Shift Booker");
    const j = await book(c, "General worker, standard shift", { overtimeHours: 2 });
    assert.deepEqual([j.price.base, j.price.total], [1000, 1090]);
    assert.deepEqual(j.priceLines.map((l: any) => [l.label, l.amount]), [["General worker, standard shift", 800], ["Overtime", 200]]);
    const foreman = await call("POST", "/api/jobs", { serviceId: await svc("Foreman, standard shift"), address: "Kilimani, Nairobi", ...KILIMANI, description: "Supervise the masons on the slab.", overtimeHours: 1 }, c.token);
    assert.equal(foreman.status, 400);
    assert.match(foreman.body.error.message, /standard 8-hour shift/);
  });

  it("prices earthworks per foot, and extra feet at the same rate", async () => {
    await offDuty("general_labor");
    const w = await worker("Digger Otieno", "general_labor", WESTLANDS);
    const c = await signIn("Trench Owner");
    const j = await book(c, "Earthworks: digging and trenching", { quantity: 120 });
    assert.deepEqual([j.price.base, j.price.total], [7200, 7848]);
    assert.equal(j.priceLines[0].detail, "120 feet × KES 60");
    await payHold(c, j.id);
    const o = await until(() => offerFor(w), "offer");
    assert.match(o.summary, /120 feet/);
    ok(await call("POST", `/api/worker/offers/${o.offerId}/accept`, {}, w.token));
    for (const step of ["arrive", "start"]) ok(await call("POST", `/api/worker/jobs/${j.id}/${step}`, {}, w.token));
    assert.deepEqual(ok(await call("GET", `/api/worker/jobs/${j.id}`, undefined, w.token)).job.extraRates, { hourly: 100, unit: 60, unitLabel: "ft" });
    ok(await upload(`/api/worker/jobs/${j.id}/extras`, { kind: "units", units: "30", reason: "Rock band; trench runs 30 ft further" }, { photo: 1 }, w.token), 201);
    assert.match(await lastSms(c.phone), /asks to add 30 more feet \(KES 1,962\)/);
    const x = (await job(c, j.id)).extras[0];
    assert.deepEqual([x.kind, x.units, x.amount], ["units", 30, 1800]);
    ok(await call("POST", `/api/jobs/${j.id}/extras/${x.id}`, { approve: true, phone: c.phone }, c.token), 202);
    await until(async () => (await job(c, j.id)).extras[0].status === "APPROVED", "extra paid");
    ok(await call("POST", `/api/worker/jobs/${j.id}/complete`, {}, w.token));
    const inv = (await job(c, j.id)).invoice;
    assert.deepEqual(inv.lines.map((l: any) => [l.label, l.amount]), [["Earthworks: digging and trenching", 7200], ["Extra feet (30)", 1800]]);
    assert.equal(inv.total, 9810);
  });

  it("prices site manager visits by zone: Nairobi area or out of station", async () => {
    const c = await signIn("Site Owner");
    const NAKURU = { lat: -0.3031, lng: 36.08 };
    const body = async (name: string, at: { lat: number; lng: number }) => ({ serviceId: await svc(name), address: "Site, Kenya", ...at, description: "Inspect the second-floor slab before casting." });
    const wrongIn = await call("POST", "/api/jobs", await body("Site manager visit, Nairobi", MOMBASA), c.token);
    assert.match(wrongIn.body.error.message, /out-of-station rate/);
    const wrongOut = await call("POST", "/api/jobs", await body("Site manager visit, outside Nairobi", KILIMANI), c.token);
    assert.match(wrongOut.body.error.message, /Nairobi visit rate/);
    const nairobi = ok(await call("POST", "/api/jobs", await body("Site manager visit, Nairobi", KILIMANI), c.token), 201).job;
    const nakuru = ok(await call("POST", "/api/jobs", await body("Site manager visit, outside Nairobi", NAKURU), c.token), 201).job;
    assert.deepEqual([nairobi.price.total, nakuru.price.total], [16350, 38150]);
    assert.equal(nakuru.service.zone, "outside");
    const plumbingOut = await call("POST", "/api/jobs", { ...(await body("Plumbing job", NAKURU)) }, c.token);
    assert.match(plumbingOut.body.error.message, /only cover the Nairobi area/);
  });

  it("applies a new schedule to an existing catalogue once, keeping old services for past jobs", async () => {
    const db2 = await pgliteDb();
    await migrate(db2);
    await db2.query(`insert into categories (id, name, trade) values ('plumbing', 'Plumbing', 'plumber')`);
    await db2.query(`insert into services (category_id, name, pricing, rate_kes) values ('plumbing', 'Fix a leaking tap', 'flat', 1500)`);
    await seedCatalog(db2);
    await seedCatalog(db2);
    const rows = await many<{ name: string; active: boolean }>(db2, `select name, active from services order by name`);
    assert.equal(rows.find((r) => r.name === "Fix a leaking tap")!.active, false);
    assert.equal(rows.filter((r) => r.active).length, 11, "the schedule is added once");
    await db2.close();
  });
});

describe("admin console", () => {
  it("needs the authenticator step, reports the PRD metrics, and keeps sign-in codes hidden", async () => {
    const t = await adminToken();
    const pre = ok(await call("POST", "/api/admin/login", { email: "ops@example.com", password: "a long admin password" }));
    assert.equal((await call("GET", "/api/admin/overview", undefined, pre.token)).status, 401, "a password alone is not enough");
    const o = ok(await call("GET", "/api/admin/overview", undefined, t));
    for (const k of ["matchRate", "timeToAccept", "completionRate", "noShowRate", "disputeRate", "averageRating", "repeatRate", "pageLoad"]) assert.ok(k in o.metrics, k);
    assert.ok(o.metrics.matchRate.value > 0);
    const out = ok(await call("GET", "/api/admin/sms", undefined, t)).messages;
    assert.ok(out.filter((m: any) => m.purpose === "otp").every((m: any) => m.body.startsWith("••••••")));
    const csv = await fetch(`${base}/api/admin/payments?format=csv`, { headers: { Authorization: `Bearer ${t}` } });
    assert.match(await csv.text(), /^created_at,job,purpose/);
    const cat = ok(await call("GET", "/api/admin/catalog", undefined, t)).categories;
    const tap = cat.find((c: any) => c.id === "plumbing").services[0];
    ok(await call("PUT", `/api/admin/services/${tap.id}`, { categoryId: "plumbing", name: tap.name, description: tap.description, pricing: "flat", rate: 1800 }, t));
    assert.equal(ok(await call("POST", "/api/quote", { serviceId: tap.id })).quote.total, 1962);
    const audit = ok(await call("GET", "/api/admin/audit", undefined, t)).entries;
    assert.ok(audit.some((e: any) => e.action === "service.update"));
  });

  it("records page-load samples", async () => {
    const r = await fetch(`${base}/api/metrics/load`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ path: "/", ms: 1800, connection: "4g" }) });
    assert.equal(r.status, 204);
    const o = ok(await call("GET", "/api/admin/overview", undefined, await adminToken()));
    assert.equal(o.metrics.pageLoad.n, 1);
  });
});
