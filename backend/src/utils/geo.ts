import { env } from "../config/env.js";

// Distances, drive-time ETAs and address search. With MAPBOX_TOKEN the ETA comes from
// Mapbox's traffic-aware directions and addresses from Mapbox search; without it, a road
// distance estimate and Photon (OpenStreetMap) search, both free and keyless.

export type Point = { lat: number; lng: number };

/** Nairobi CBD, the centre of the launch area. */
export const NAIROBI: Point = { lat: -1.2864, lng: 36.8172 };

export function haversineKm(a: Point, b: Point): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The same great-circle distance as SQL, so the database can rank workers by it. */
export const haversineSql = (latA: string, lngA: string, latB: string, lngB: string) =>
  `(6371 * 2 * asin(least(1, sqrt(power(sin(radians((${latB}) - (${latA})) / 2), 2) + cos(radians(${latA})) * cos(radians(${latB})) * power(sin(radians((${lngB}) - (${lngA})) / 2), 2)))))`;

/** Within the Nairobi area: the launch zone, and the "Nairobi" rate for zoned services. */
export const inServiceArea = (p: Point, radiusKm: number) => haversineKm(NAIROBI, p) <= radiusKm;

/** Roughly Kenya's bounding box, for out-of-station site visits. */
export const inKenya = (p: Point) => p.lat >= -4.9 && p.lat <= 5.2 && p.lng >= 33.8 && p.lng <= 42.0;
const KENYA_BBOX = "33.8,-4.9,42.0,5.2";

/**
 * Minutes to drive from a to b. Without Mapbox: roads run about 1.4× the straight line,
 * Nairobi traffic averages around 20 km/h over the first 15 km, open road about 60 km/h
 * after that, plus a few minutes to get going.
 */
export function estimateMinutes(a: Point, b: Point): number {
  const km = haversineKm(a, b) * 1.4;
  const city = Math.min(km, 15);
  return Math.max(5, Math.round(3 + (city / 20) * 60 + ((km - city) / 60) * 60));
}

export async function etaMinutes(a: Point, b: Point): Promise<{ minutes: number; source: "mapbox" | "estimate" }> {
  if (env.maps.mapboxToken) {
    try {
      const r = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&access_token=${env.maps.mapboxToken}`,
        { signal: AbortSignal.timeout(6_000) },
      );
      const j = (await r.json()) as { routes?: { duration: number }[] };
      const s = j.routes?.[0]?.duration;
      if (r.ok && typeof s === "number") return { minutes: Math.max(1, Math.round(s / 60)), source: "mapbox" };
    } catch {
      /* fall back to the estimate */
    }
  }
  return { minutes: estimateMinutes(a, b), source: "estimate" };
}

export type Place = { label: string; detail: string; lat: number; lng: number };

const cache = new Map<string, { at: number; places: Place[] }>();
const UA = "MjengoOclock/1.0 (+https://github.com/WALTERNTECH/Mjengo-Oclock)";

function remember(key: string, places: Place[]) {
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), places });
  return places;
}

/** Address suggestions as the person types: around Nairobi, or anywhere in Kenya for out-of-station visits. */
export async function searchPlaces(q: string, near: Point = NAIROBI, scope: "nairobi" | "kenya" = "nairobi"): Promise<Place[]> {
  const key = `s:${scope}:${q.toLowerCase()}:${near.lat.toFixed(2)},${near.lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.places;
  if (env.maps.mapboxToken) {
    const u = new URL("https://api.mapbox.com/search/geocode/v6/forward");
    u.search = new URLSearchParams({ q, country: "ke", proximity: `${near.lng},${near.lat}`, autocomplete: "true", limit: "6", language: "en", access_token: env.maps.mapboxToken }).toString();
    const r = await fetch(u, { signal: AbortSignal.timeout(6_000) });
    const j = (await r.json()) as { features?: { geometry: { coordinates: [number, number] }; properties: { name?: string; place_formatted?: string; full_address?: string } }[] };
    return remember(
      key,
      (j.features ?? []).map((f) => ({ label: f.properties.name ?? f.properties.full_address ?? "", detail: f.properties.place_formatted ?? "", lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })),
    );
  }
  const u = new URL("https://photon.komoot.io/api/");
  // Biased to Nairobi, and kept inside the wider metro area unless the search is Kenya-wide.
  u.search = new URLSearchParams({ q, lat: String(near.lat), lon: String(near.lng), limit: "8", lang: "en", bbox: scope === "kenya" ? KENYA_BBOX : "36.55,-1.55,37.20,-1.00" }).toString();
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
  const j = (await r.json()) as { features?: PhotonFeature[] };
  return remember(key, dedupe((j.features ?? []).map(photonPlace)).slice(0, 6));
}

/** The nearest address to a dropped pin. */
export async function reversePlace(p: Point): Promise<Place | null> {
  const key = `r:${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.places[0] ?? null;
  if (env.maps.mapboxToken) {
    const r = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${p.lng}&latitude=${p.lat}&limit=1&language=en&access_token=${env.maps.mapboxToken}`, {
      signal: AbortSignal.timeout(6_000),
    });
    const j = (await r.json()) as { features?: { properties: { name?: string; place_formatted?: string } }[] };
    const f = j.features?.[0];
    return remember(key, f ? [{ label: f.properties.name ?? "", detail: f.properties.place_formatted ?? "", ...p }] : [])[0] ?? null;
  }
  const r = await fetch(`https://photon.komoot.io/reverse?lat=${p.lat}&lon=${p.lng}&lang=en&limit=1`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
  const j = (await r.json()) as { features?: PhotonFeature[] };
  const f = j.features?.[0];
  return remember(key, f ? [{ ...photonPlace(f), ...p }] : [])[0] ?? null;
}

type PhotonFeature = { geometry: { coordinates: [number, number] }; properties: Record<string, string | undefined> };

function photonPlace(f: PhotonFeature): Place {
  const p = f.properties;
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const label = p.name ?? (street || p.district || p.locality || p.city || "Pinned location");
  const detail = [p.name && street ? street : null, p.district ?? p.locality, p.city ?? p.county].filter((x, i, a) => x && x !== label && a.indexOf(x) === i).join(", ");
  return { label, detail, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
}

function dedupe(list: Place[]): Place[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = `${p.label}|${p.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
