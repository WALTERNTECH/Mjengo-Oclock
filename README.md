# Mjengo O'clock

On-demand construction trades in Nairobi: general workers, plumbers, electricians, welders, fundis, site managers and foremen, booked from a phone with the price upfront, tracked live, and paid by M-Pesa only when the client approves the work. Built from *PRD v2 – On-Demand Construction Trades Service*.

## What's in it

**Clients** (mobile web, installable as an app)
- Sign in with a phone number and a code by SMS.
- Choose a trade and a job from the rate schedule (per task or visit, per hour, per 8-hour shift with optional overtime, or per foot), pick the address by search, current location or a pin on the map, add directions, a date and time (or right away), a description and up to 3 photos, and see the price with the 9% fee before confirming.
- Pay the hold by M-Pesa; it stays in escrow until the job is approved.
- Track the job: the worker's verified name, photo and rating, a call button, live location on the map (shown only while the job is active; "Location unavailable" after 2 minutes without an update), and the En route → On site → In progress → Done timeline.
- Approve or decline extra hours and materials before they're done; approved extras are paid into escrow on the spot.
- Cancel with the fee shown first, reschedule, report a problem or raise an emergency (texts the emergency contact with your location).
- Itemised invoice by SMS link; approve with a rating and optional tip, or dispute within 24 hours. Escrow releases by itself after 24 hours.

**Workers**
- Apply with trade, experience, national ID number and photo, a selfie, a certificate (required for electricians and plumbers), a base location and M-Pesa or bank payout details.
- Go available (location sharing with consent), get offers by SMS and in the app with the area, distance, pay and photos, and 2 minutes to accept.
- Tap each status (start trip with an ETA, arrived, start, complete with photos); each tap texts the client. Request extras with a photo, log a client no-show after a 15-minute wait for the call-out fee, cancel, rate the client.
- Earnings and payouts: 91% of every job price and tips in full.

**Rate schedule** (Construction & Site Labor Rate Schedule), seeded in `backend/src/seed.ts` and editable in Admin › Trades and rates:

| Section | Service | Rate |
|---|---|---|
| General labor | General worker, standard shift | KES 800 per 8-hour shift (overtime KES 100/h) |
| | General worker, by the hour | KES 100 per hour |
| | Heavy labor: clearing, loading and bagging | KES 200 per hour |
| | Earthworks: digging and trenching | KES 60 per foot |
| Skilled trades | Plumbing job | KES 2,000 per task |
| | Electrician, by the hour | KES 250 per hour |
| | Welding job | KES 2,000 per task |
| | General fundi job | KES 1,600 per task |
| Management | Site manager visit, Nairobi | KES 15,000 per visit |
| | Site manager visit, outside Nairobi | KES 35,000 per visit |
| | Foreman, standard shift | KES 2,000 per 8-hour shift |

Billing rules: day shifts are capped at 8 hours and hours beyond that bill hourly where a rate exists; site visits are priced by zone (Nairobi area or out of station, checked against the site's location); plumber, welder and fundi work is a flat rate per task; contractor overhead and engineering review fees are outside the schedule. A new schedule is applied once per database (`catalog_version` in settings); earlier services are switched off, not deleted, because past jobs reference them.

**Dispatch** offers each job to the nearest available, approved worker in the trade, 2 minutes each, then the next nearest, with no radius inside Nairobi. After 10 minutes with no acceptance the client is texted (reschedule or cancel free) and the team is alerted to dispatch by hand. Scheduled jobs start looking 2 hours ahead.

**Policies** (PRD section 6), all editable in Admin › Fees and policies: free cancellation before acceptance; free within 5 minutes after it, then KES 200 to the worker; KES 500 once the worker is on the way; worker cancellations re-dispatch at no cost and count against them; a worker 30 minutes past the ETA lets the client cancel free and is flagged; client no-show pays the worker a KES 500 call-out fee; disputes freeze escrow until the team releases, refunds or splits it. Workers are paid only from money collected for their job.

**Trust and quality**: no jobs until an admin approves the application; a new worker's first 5 jobs are flagged for review; a worker whose last 10 ratings average below 3.5 is suspended pending review.

**Admin console** at `/admin` (password + authenticator code): the PRD's success metrics (match rate, time to accept, completion, no-shows, disputes, rating, repeat bookings, page load), queues for worker approvals, unassigned bookings, disputes and safety reports, job detail with the full audit timeline and manual dispatch, payments with CSV export, payouts (send by M-Pesa B2C or record a manual payment), trades and rates, fees and time limits, people, the SMS log, the team and roles, and the audit log.

## Layout

```
backend/    Express + TypeScript API (Postgres via pg; migrations run at boot)
frontend/   React + TypeScript + Vite PWA
api/        The Vercel function entry (re-exports backend/src/vercel.ts)
brand/      Logo mark, app icon, share image, and the script that renders the PNGs
```

## Running locally

```bash
npm install
```

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Without `DATABASE_URL` the API uses an embedded Postgres in `.local/pglite`. M-Pesa is simulated (prompts confirm themselves after a few seconds), SMS is written to the API log, and sign-in codes are shown on screen. The first admin is created at http://localhost:5173/admin with the setup token `local-setup`.

```bash
npm test
```

runs the end-to-end flows: SMS sign-in, booking and the fee maths, nearest-worker dispatch with decline, time-out and hand-over, live status texts and location privacy, extras, invoices, approval and payout, every cancellation rule, both kinds of no-show, disputes, auto-release, rating suspension, probation, safety alerts and the admin console.

## Database

Mjengo has its own schema, `mjengo`, inside the Fpesa Supabase project (`mrsxvdxaoogamhkdqejp`), owned by the role `mjengo_api`. That role has no rights on Fpesa's or Konnect's tables or functions. The server applies its own migrations at boot (`backend/src/migrations.ts`). Row level security is on for every table with no policies, so Supabase's `anon` and `authenticated` roles see nothing.

## Hosting

Production runs on Vercel (project `mjengo-oclock`, region `fra1` next to the Supabase database): https://mjengo-oclock.vercel.app. `vercel.json` builds both workspaces, serves `frontend/dist` as static files with the security headers, and sends `/api/*` and `/health` to one function (`api/index.mjs`). Deploy with `vercel deploy --prod` from the repo root; `.vercelignore` keeps `.local/` and build output off the upload.

There is no process between requests on Vercel, so:

- **Background jobs** (dispatch every 5 s, housekeeping every 30 s) are started by API requests, which the open app makes every few seconds, and by a daily Vercel Cron call to `/api/cron/tick` for quiet spells. A lease row per job in `job_leases` means only one instance runs a job at a time.
- **Live updates** are rows in `live_events` that the app polls every 3 seconds while on screen (30 in the background), instead of an open stream.
- **Work after the response** (simulated M-Pesa results, event writes) goes through `waitUntil`, so the function stays up until it finishes.
- **Uploads**: a Vercel request is capped at 4.5 MB, so the app scales photos to 2000 px JPEG before sending; the server keeps at most 1600 px anyway.

`npm start` still runs the API as a long-running server (timers instead of request-driven jobs), as on Render.

## Going live

See `backend/.env.example`. Until these are set the app runs in test mode and says so on every screen:

- **SMS**: `CELCOM_API_KEY`, `CELCOM_PARTNER_ID`, `CELCOM_SHORTCODE` (the approved sender ID), and set `OTP_ECHO=off`.
- **M-Pesa**: `MPESA_DRIVER=daraja`, `MPESA_ENV=production` and the Daraja credentials; B2C credentials for automatic payouts and refunds. The callback URL is `PUBLIC_URL/api/mpesa/callback/<MPESA_CALLBACK_TOKEN>`; Daraja signs nothing, so a reported success is confirmed with a status query first. M-Pesa has no pre-authorisation, so the booking hold is a payment kept in escrow; PRD section 11 notes this may need a licensed payment partner.
- **Maps**: `MAPBOX_TOKEN` and `MAPBOX_PUBLIC_TOKEN` for traffic-aware ETAs, Mapbox search and tiles. The free OpenStreetMap tile servers are fine for testing but not for production traffic.
- **ID checks**: every application currently goes to the admin queue with the ID photo and selfie side by side. Smile ID (or Didit) plugs into `backend/src/services/idcheck.ts` once there is a contract and sandbox keys.
- **Rates and policy**: rates follow the rate schedule above; the cancellation and call-out fee amounts are still the PRD's placeholders, so set the real ones in Admin › Fees and policies. Have counsel review the terms and privacy notice (`frontend/src/pages/Legal.tsx`), including worker status, VAT and insurance, and register with the Data Protection Commissioner.
