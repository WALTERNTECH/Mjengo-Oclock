import axios from "axios";
import { useCallback, useEffect, useState } from "react";

// The console has its own short-lived token, kept for this tab only.

const KEY = "mjengo.admin";
export const adminToken = {
  get: () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) sessionStorage.setItem(KEY, t);
      else sessionStorage.removeItem(KEY);
    } catch {
      /* the session lasts until reload */
    }
  },
};

export const adminApi = axios.create({ baseURL: "/api/admin", timeout: 30_000 });
adminApi.interceptors.request.use((cfg) => {
  const t = adminToken.get();
  if (t && !cfg.headers.Authorization) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});
let onExpired: () => void = () => {};
export const setOnExpired = (fn: () => void) => (onExpired = fn);
adminApi.interceptors.response.use(
  (r) => r,
  (e) => {
    if (e.response?.status === 401 && !String(e.config?.url).match(/\/(login|totp|setup)$/)) {
      adminToken.set(null);
      onExpired();
    }
    return Promise.reject(e);
  },
);

/** Plain per-page loading for the console; no shared cache needed here. */
export function useAdmin<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const r = await adminApi.get<T>(path);
      setData(r.data);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, loading, error, reload: load, setData };
}

/** Downloads a file (CSV export) with the admin token. */
export async function download(path: string, filename: string) {
  const r = await adminApi.get(path, { responseType: "blob" });
  const u = URL.createObjectURL(r.data);
  const a = Object.assign(document.createElement("a"), { href: u, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
