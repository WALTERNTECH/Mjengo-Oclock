import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { adminApi } from "./api";

// Counts the whole console shares: the menu badges, the bell and the test-mode pill all read
// one light overview, refreshed every 20 seconds and after any change a page makes.

export type Lite = {
  counts: Record<string, number>;
  money: Record<string, number>;
  drivers: { payments: string; payouts: string | null; sms: string; otpOnScreen: boolean };
};

const Ctx = createContext<{ data: Lite | null; reload: () => Promise<void> }>({ data: null, reload: async () => {} });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Lite | null>(null);
  const reload = useCallback(async () => {
    try {
      setData((await adminApi.get<Lite>("/overview?lite=1")).data);
    } catch {
      /* keep the last counts */
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 20_000);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);
  return <Ctx.Provider value={{ data, reload }}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);

export type Badge = { n?: number; tone: "bad" | "wait" | "info" };

/** Live counts beside menu items. */
export function badgesFrom(c: Record<string, number> | undefined): Record<string, Badge | undefined> {
  if (!c) return {};
  const n = (v: number | undefined, tone: Badge["tone"]): Badge | undefined => (v ? { n: v, tone } : undefined);
  return {
    alerts: n(c.alerts, c.q_emergencies ? "bad" : "wait"),
    unassigned: n(c.q_unassigned, "bad"),
    approvals: n(c.q_applications, "wait"),
    disputes: n(c.q_disputes, "wait"),
    reports: n(c.q_reports, c.q_emergencies ? "bad" : "wait"),
    payouts: n(c.q_payouts, "wait"),
    jobs: c.q_late ? { n: c.q_late, tone: "bad" } : c.q_probation ? { tone: "wait" } : undefined,
    workers: c.q_flagged || c.q_suspended ? { tone: "wait" } : undefined,
  };
}
