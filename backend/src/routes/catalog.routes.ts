import { Router } from "express";
import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { env } from "../config/env.js";
import { quote } from "../services/pricing.js";
import { paymentDriver } from "../services/payments.js";
import { getSettings } from "../services/settings.js";
import { badRequest } from "../utils/http.js";
import { NAIROBI, reversePlace, searchPlaces } from "../utils/geo.js";
import { smsConfigured } from "../utils/sms.js";

// Public reads: the trades and their rates (PRD 4.2), the upfront estimate, address search,
// and the settings the app needs to draw itself.

export const catalogRouter = Router();

export async function catalog(includeInactive = false) {
  const cats = await many<{ id: string; name: string; trade: string; blurb: string; requires_certificate: boolean; sort: number; active: boolean }>(
    db(),
    `select * from categories ${includeInactive ? "" : "where active"} order by sort`,
  );
  const svcs = await many<{ id: string; category_id: string; name: string; description: string; pricing: string; rate_kes: number; min_hours: number; active: boolean; sort: number }>(
    db(),
    `select * from services ${includeInactive ? "" : "where active"} order by sort, name`,
  );
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    trade: c.trade,
    blurb: c.blurb,
    requiresCertificate: c.requires_certificate,
    active: c.active,
    services: svcs
      .filter((s) => s.category_id === c.id)
      .map((s) => ({ id: s.id, name: s.name, description: s.description, pricing: s.pricing, rate: s.rate_kes, minHours: s.min_hours, active: s.active })),
  }));
}

catalogRouter.get("/catalog", async (_req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({ categories: await catalog() });
});

catalogRouter.get("/config", async (_req, res) => {
  const s = await getSettings();
  res.json({
    fees: { clientPct: s.client_fee_pct, workerPct: s.worker_fee_pct },
    policy: {
      lateCancelFee: s.late_cancel_fee_kes,
      enRouteCancelFee: s.enroute_cancel_fee_kes,
      calloutFee: s.callout_fee_kes,
      freeCancelMinutes: s.free_cancel_minutes,
      offerWindowSeconds: s.offer_window_seconds,
      dispatchTimeoutMinutes: s.dispatch_timeout_minutes,
      autoReleaseHours: s.auto_release_hours,
      disputeWindowHours: s.dispute_window_hours,
      clientWaitMinutes: s.client_wait_minutes,
      noShowGraceMinutes: s.no_show_grace_minutes,
      locationStaleSeconds: s.location_stale_seconds,
      serviceRadiusKm: s.service_radius_km,
    },
    support: { phone: s.support_phone || null, email: s.support_email || null },
    map: env.maps.mapboxPublicToken
      ? { tiles: `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/{z}/{x}/{y}@2x?access_token=${env.maps.mapboxPublicToken}`, attribution: "© Mapbox © OpenStreetMap" }
      : { tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors" },
    centre: NAIROBI,
    payments: { simulated: paymentDriver() === "simulated" },
    sms: { connected: smsConfigured(), codesOnScreen: env.otpEcho },
  });
});

catalogRouter.post("/quote", async (req, res) => {
  const b = z.object({ serviceId: z.uuid(), hours: z.coerce.number().positive().max(24).optional() }).parse(req.body);
  const svc = await one<{ pricing: "flat" | "hourly"; rate_kes: number; min_hours: number; active: boolean }>(db(), `select pricing, rate_kes, min_hours, active from services where id = $1`, [b.serviceId]);
  if (!svc?.active) throw badRequest("That service isn't available");
  const s = await getSettings();
  res.json({ quote: quote({ pricing: svc.pricing, rate: svc.rate_kes, hours: Math.max(svc.min_hours, b.hours ?? svc.min_hours), clientFeePct: s.client_fee_pct, workerFeePct: s.worker_fee_pct }) });
});

const coord = (min: number, max: number) => z.coerce.number().min(min).max(max);

catalogRouter.get("/geo/search", async (req, res) => {
  const b = z.object({ q: z.string().trim().min(2).max(120), lat: coord(-90, 90).optional(), lng: coord(-180, 180).optional() }).parse(req.query);
  try {
    res.json({ places: await searchPlaces(b.q, b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : undefined) });
  } catch (e) {
    console.warn("[geo] search failed", (e as Error).message);
    res.json({ places: [], unavailable: true });
  }
});

catalogRouter.get("/geo/reverse", async (req, res) => {
  const b = z.object({ lat: coord(-90, 90), lng: coord(-180, 180) }).parse(req.query);
  try {
    res.json({ place: await reversePlace(b) });
  } catch {
    res.json({ place: null, unavailable: true });
  }
});
