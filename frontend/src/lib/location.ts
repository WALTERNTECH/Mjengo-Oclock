import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

// Shares the worker's position while they're available or on a job (PRD 4.3). Phones,
// iOS Safari especially, pause this when the page is in the background, so during a job we
// also ask the screen to stay awake and tell the worker to keep the app open (PRD 9).

export type GeoState = { status: "off" | "asking" | "on" | "denied" | "unsupported"; last: { lat: number; lng: number; accuracy: number; at: number } | null };

export function useShareLocation(active: boolean, keepAwake = false): GeoState {
  const [state, setState] = useState<GeoState>({ status: "off", last: null });
  const lastSent = useRef(0);
  useEffect(() => {
    if (!active) {
      setState((s) => ({ ...s, status: "off" }));
      return;
    }
    if (!("geolocation" in navigator)) {
      setState({ status: "unsupported", last: null });
      return;
    }
    setState((s) => ({ ...s, status: s.last ? "on" : "asking" }));
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy), at: Date.now() };
        setState({ status: "on", last: p });
        // At most every 10 seconds; the server rate-limits as well.
        if (Date.now() - lastSent.current >= 10_000) {
          lastSent.current = Date.now();
          void api.post("/worker/location", { lat: p.lat, lng: p.lng, accuracy: p.accuracy }).catch(() => {});
        }
      },
      (err) => setState((s) => ({ ...s, status: err.code === err.PERMISSION_DENIED ? "denied" : s.status })),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [active]);

  useEffect(() => {
    if (!keepAwake || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    const ask = async () => {
      try {
        lock = await (navigator as unknown as { wakeLock: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock.request("screen");
      } catch {
        /* not allowed right now */
      }
    };
    void ask();
    const onVis = () => document.visibilityState === "visible" && void ask();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => {});
    };
  }, [keepAwake]);

  return state;
}

/** One reading, for the moment a worker goes available or starts a trip. */
export function currentPosition(timeout = 8000): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => res(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}
