import { useEffect, useState } from "react";
import type { PickedAddress } from "../components/AddressPicker";

// The job location chosen on the home screen, carried into the booking form.

const KEY = "mjengo.where";
const listeners = new Set<() => void>();

export function readWhere(): PickedAddress | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v ? (JSON.parse(v) as PickedAddress) : null;
  } catch {
    return null;
  }
}
export function saveWhere(a: PickedAddress | null) {
  try {
    if (a) sessionStorage.setItem(KEY, JSON.stringify(a));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* kept for this screen only */
  }
  listeners.forEach((l) => l());
}
export function useWhere(fallback?: PickedAddress | null) {
  const [v, setV] = useState<PickedAddress | null>(() => readWhere() ?? fallback ?? null);
  useEffect(() => {
    const l = () => setV(readWhere());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!v && fallback) setV(fallback);
  }, [fallback?.lat, fallback?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}
