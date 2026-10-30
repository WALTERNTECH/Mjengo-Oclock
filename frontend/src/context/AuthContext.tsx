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

/**
 * Picks up live updates (job changes, offers, the worker's position, payments, notifications)
 * while signed in: every 3 seconds with the app on screen, every 30 in the background, and at
 * once when it comes back into view. Short requests rather than an open stream, so it works
 * on serverless hosting.
 */
export function LiveEvents() {
  const { me, refresh } = useAuth();
  const id = me?.id;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let busy = false;
    let cursor: number | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      if (busy) return;
      busy = true;
      try {
        const r = await api.get<{ cursor: number; events: { event: string; data: unknown }[] }>("/notifications/events", { params: cursor == null ? {} : { after: cursor } });
        if (stopped) return;
        cursor = r.data.cursor;
        for (const e of r.data.events) dispatch(e.event, e.data);
        if (r.data.events.some((e) => e.event === "notification" || e.event === "job")) void refreshRef.current();
        if (r.data.events.some((e) => e.event === "notification")) void invalidate("/notifications");
      } catch {
        // Offline or signed out; the next poll tries again.
      } finally {
        busy = false;
        if (!stopped) timer = setTimeout(poll, document.visibilityState === "visible" ? 3_000 : 30_000);
      }
    };
    const onShow = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onShow);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [id]);
  return null;
}
