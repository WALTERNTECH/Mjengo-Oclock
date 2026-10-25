import axios, { AxiosError } from "axios";
import { useCallback, useEffect, useRef, useState } from "react";

// One Axios instance for the app. The JWT lives in localStorage and rides on every request;
// a 401 clears it so the next protected screen asks the person to sign in again.

const TOKEN_KEY = "mjengo.token";

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: the session lasts until the tab closes */
    }
    listeners.forEach((l) => l());
  },
};
const listeners = new Set<() => void>();
export const onTokenChange = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL ?? "/api", timeout: 30_000 });

api.interceptors.request.use((cfg) => {
  const t = tokenStore.get();
  if (t && !cfg.headers.Authorization) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});
api.interceptors.response.use(
  (r) => r,
  (e: AxiosError) => {
    if (e.response?.status === 401 && tokenStore.get() && !String(e.config?.url).startsWith("/admin")) tokenStore.set(null);
    return Promise.reject(e);
  },
);

export type ApiErrorBody = { error: { code: string; message: string; details?: { path: string; message: string }[] } };

/** The server's message for an error, or a plain one when the request never got an answer. */
export function errorMessage(e: unknown): string {
  const ax = e as AxiosError<ApiErrorBody>;
  if (ax?.response?.data?.error?.message) return ax.response.data.error.message;
  if (ax?.code === "ECONNABORTED") return "The request took too long. Try again.";
  if (ax?.isAxiosError && !ax.response) return "Can't reach Mjengo O'clock. Check your connection.";
  return "Something went wrong. Try again.";
}
export const errorCode = (e: unknown) => (e as AxiosError<ApiErrorBody>)?.response?.data?.error?.code;
export function fieldErrors(e: unknown): Record<string, string> {
  const d = (e as AxiosError<ApiErrorBody>)?.response?.data?.error?.details;
  const out: Record<string, string> = {};
  if (Array.isArray(d)) for (const x of d) if (x.path && !out[x.path]) out[x.path] = x.message;
  return out;
}

// ——— A small fetch cache: one request per key, shared by every component that asks. ———

type Entry = { data?: unknown; error?: unknown; at: number; promise?: Promise<unknown>; subs: Set<() => void> };
const cache = new Map<string, Entry>();
const entry = (k: string) => {
  let e = cache.get(k);
  if (!e) cache.set(k, (e = { at: 0, subs: new Set() }));
  return e;
};

async function load(key: string, force = false) {
  const e = entry(key);
  if (e.promise && !force) return e.promise;
  const p = api
    .get(key)
    .then((r) => {
      e.data = r.data;
      e.error = undefined;
      e.at = Date.now();
    })
    .catch((err) => {
      e.error = err;
      e.at = Date.now();
    })
    .finally(() => {
      if (e.promise === p) e.promise = undefined;
      e.subs.forEach((s) => s());
    });
  e.promise = p;
  e.subs.forEach((s) => s());
  return p;
}

/** Re-fetches every cached key that starts with one of the prefixes. */
export async function invalidate(...prefixes: string[]) {
  const keys = [...cache.keys()].filter((k) => prefixes.some((p) => k.startsWith(p)));
  await Promise.all(keys.map((k) => (cache.get(k)!.subs.size ? load(k, true) : (cache.delete(k), undefined))));
}
export function setCached<T>(key: string, fn: (prev: T | undefined) => T | undefined) {
  const e = entry(key);
  e.data = fn(e.data as T | undefined);
  e.subs.forEach((s) => s());
}

export function useApi<T>(key: string | null, opts: { staleMs?: number } = {}) {
  const stale = opts.staleMs ?? 20_000;
  // Entries are mutated in place, so subscribers re-render through a counter.
  const [, force] = useState(0);
  useEffect(() => {
    if (!key) return;
    const en = entry(key);
    const f = () => force((n) => n + 1);
    en.subs.add(f);
    if (!en.at || Date.now() - en.at > stale) void load(key);
    return () => {
      en.subs.delete(f);
    };
  }, [key, stale]);
  const e = key ? cache.get(key) : undefined;
  return {
    data: e?.data as T | undefined,
    error: e?.error,
    loading: Boolean(key) && !e?.data && !e?.error,
    refreshing: Boolean(e?.promise),
    reload: () => (key ? load(key, true) : Promise.resolve()),
  };
}

/** Wraps a mutation with busy state and a readable error. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      setFields({});
      try {
        return await fn(...a);
      } catch (e) {
        if (live.current) {
          setError(errorMessage(e));
          setFields(fieldErrors(e));
        }
        throw e;
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, fields, setError };
}
