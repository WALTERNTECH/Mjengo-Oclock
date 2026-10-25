import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, invalidate, onTokenChange, tokenStore, useApi } from "../api/client";
import type { Config, Me } from "../types";

// Sign-in is a phone number and an SMS code; the first code creates the account.

type Auth = {
  me: Me | null;
  ready: boolean;
  requestCode: (phone: string) => Promise<{ phone: string; devCode?: string }>;
  verify: (phone: string, code: string) => Promise<{ user: Me; isNew: boolean }>;
  logout: () => void;
  refresh: () => Promise<void>;
  setMe: (m: Me) => void;
};

const Ctx = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setMe(null);
      setReady(true);
      return;
    }
    try {
      const r = await api.get<{ user: Me }>("/me");
      setMe(r.data.user);
    } catch {
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onTokenChange(() => {
      if (!tokenStore.get()) setMe(null);
    });
  }, [refresh]);

  const requestCode = useCallback(async (phone: string) => (await api.post<{ phone: string; devCode?: string }>("/auth/request-code", { phone })).data, []);

  const verify = useCallback(async (phone: string, code: string) => {
    const r = await api.post<{ token: string; user: Me; isNew: boolean }>("/auth/verify", { phone, code });
    tokenStore.set(r.data.token);
    setMe(r.data.user);
    return { user: r.data.user, isNew: r.data.isNew };
  }, []);

  const logout = useCallback(() => {
    tokenStore.set(null);
    setMe(null);
    void invalidate("/");
  }, []);

  const value = useMemo(() => ({ me, ready, requestCode, verify, logout, refresh, setMe }), [me, ready, requestCode, verify, logout, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

/** Public app settings: fees, policy times, map tiles, test-mode flags. */
export function useConfig(): Config | undefined {
  return useApi<Config>("/config", { staleMs: 5 * 60_000 }).data;
}

// ——— Live events (server-sent) ———

type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
export function onLive(event: string, fn: Handler) {
  let s = handlers.get(event);
  if (!s) handlers.set(event, (s = new Set()));
  s.add(fn);
  return () => {
    s!.delete(fn);
  };
}
const dispatch = (event: string, data: unknown) => handlers.get(event)?.forEach((h) => h(data));

const EVENTS = ["notification", "job", "offer", "offer_gone", "location", "payment"];

/** Keeps one event stream open while signed in, reconnecting with a fresh ticket after drops. */
export function LiveEvents() {
  const { me, refresh } = useAuth();
  const id = me?.id;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!id) return;
    let es: EventSource | null = null;
    let stopped = false;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout>;
    const open = async () => {
      try {
        const r = await api.post<{ ticket: string }>("/notifications/stream-ticket");
        if (stopped) return;
        es = new EventSource(`/api/notifications/stream?ticket=${encodeURIComponent(r.data.ticket)}`);
        es.onopen = () => (delay = 2000);
        for (const ev of EVENTS) {
          es.addEventListener(ev, (m) => {
            const data = JSON.parse((m as MessageEvent).data);
            dispatch(ev, data);
            if (ev === "notification" || ev === "job") void refreshRef.current();
            if (ev === "notification") void invalidate("/notifications");
          });
        }
        es.onerror = () => {
          es?.close();
          if (!stopped) timer = setTimeout(open, (delay = Math.min(delay * 2, 30_000)));
        };
      } catch {
        if (!stopped) timer = setTimeout(open, (delay = Math.min(delay * 2, 30_000)));
      }
    };
    void open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [id]);
  return null;
}
