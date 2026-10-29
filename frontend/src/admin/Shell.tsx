import { ArrowRight, Bell, ChevronDown, Check, ClipboardList, HardHat, LogOut, Menu, Search, User, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Mark } from "../components/Logo";
import { ago, initials } from "../lib/format";
import type { AdminMe } from "./Admin";
import { adminApi } from "./api";
import { badgesFrom, LiveProvider, useLive, type Badge } from "./live";
import { allowed, DASHBOARD, findCurrent, GROUPS, type NavGroup } from "./nav";

// The console frame. Desktop: a sidebar with Dashboard first and groups that open like
// dropdowns, and a top bar with the page's place, "Jump to", alerts and the account menu.
// Phone: the same sidebar slides in from the left behind a menu button, tables turn into
// cards, and dialogs rise from the bottom.

export function Shell({ me, onSignOut, children }: { me: AdminMe; onSignOut: () => void; children: ReactNode }) {
  return (
    <LiveProvider>
      <Frame me={me} onSignOut={onSignOut}>
        {children}
      </Frame>
    </LiveProvider>
  );
}

function Frame({ me, onSignOut, children }: { me: AdminMe; onSignOut: () => void; children: ReactNode }) {
  const loc = useLocation();
  const { data, reload } = useLive();
  const [drawer, setDrawer] = useState(false);
  const [jump, setJump] = useState(false);
  const current = findCurrent(loc.pathname);
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i, me.role)) })).filter((g) => g.items.length), [me.role]);
  const badges = badgesFrom(data?.counts);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    setDrawer(false);
    void reload();
  }, [loc.pathname, reload]);
  useEffect(() => {
    document.body.classList.toggle("locked", drawer);
    return () => document.body.classList.remove("locked");
  }, [drawer]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJump((j) => !j);
      } else if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  useTableLabels(main);

  const sandbox = data && (data.drivers.payments === "simulated" || data.drivers.sms === "log");
  return (
    <div className="console">
      <div className="console-bg" aria-hidden="true" />
      <Sidebar me={me} open={drawer} groups={groups} badges={badges} current={current} sandbox={Boolean(sandbox)} onClose={() => setDrawer(false)} onSignOut={onSignOut} />
      {drawer ? <div className="side-scrim" onClick={() => setDrawer(false)} aria-hidden="true" /> : null}
      <div className="console-main">
        <Topbar me={me} current={current} sandbox={Boolean(sandbox)} onMenu={() => setDrawer(true)} onJump={() => setJump(true)} onSignOut={onSignOut} />
        <main className="content" ref={main} key={loc.pathname}>
          {children}
        </main>
      </div>
      <Jump open={jump} onClose={() => setJump(false)} groups={groups} />
    </div>
  );
}

/**
 * On a phone a table becomes a list of cards: each cell shows its column name. Pages write
 * plain tables, so the labels are copied from each table's header here.
 */
function useTableLabels(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const label = () => {
      for (const t of el.querySelectorAll<HTMLTableElement>("table.data")) {
        const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
        for (const tr of t.querySelectorAll("tbody tr")) {
          [...tr.children].forEach((td, i) => {
            const want = heads[i] ?? "";
            if (td.getAttribute("data-label") !== want) td.setAttribute("data-label", want);
          });
        }
      }
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  });
}

function BadgeView({ b }: { b?: Badge }) {
  if (!b) return null;
  return b.n ? <span className={`nav-count ${b.tone}`}>{b.n > 99 ? "99+" : b.n}</span> : <span className={`nav-dot ${b.tone}`} aria-label="Needs a look" />;
}

const OPEN_KEY = "mjengo.admin.nav-open";

function Sidebar({
  me,
  open,
  groups,
  badges,
  current,
  sandbox,
  onClose,
  onSignOut,
}: {
  me: AdminMe;
  open: boolean;
  groups: NavGroup[];
  badges: Record<string, Badge | undefined>;
  current: ReturnType<typeof findCurrent>;
  sandbox: boolean;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    try {
      const v = localStorage.getItem(OPEN_KEY);
      if (v) return new Set(JSON.parse(v));
    } catch {
      /* first visit */
    }
    return new Set(["attention"]);
  });
  const groupId = current?.group?.id;
  // The group holding the page you're on is always open.
  useEffect(() => {
    if (groupId) setOpenIds((s) => (s.has(groupId) ? s : new Set(s).add(groupId)));
  }, [groupId]);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...openIds]));
    } catch {
      /* the choice lasts this visit */
    }
  }, [openIds]);
  const toggle = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <aside className={`side${open ? " open" : ""}`} aria-label="Console menu">
      <div className="side-top">
        <Link to="/admin" className="side-brand">
          <Mark size={32} />
          <span>
            <b>Mjengo O'clock</b>
            <small>Operations console</small>
          </span>
        </Link>
        <button className="icon-btn side-close" onClick={onClose} aria-label="Close menu">
          <X />
        </button>
      </div>
      {sandbox ? (
        <div className="side-env">
          <span className="env-pill">
            <span className="d" />
            Test mode
          </span>
        </div>
      ) : null}
      <nav className="side-nav">
        <NavLink to={DASHBOARD.to} end className="side-link side-home">
          <DASHBOARD.icon />
          <span className="grow">Dashboard</span>
        </NavLink>
        {groups.map((g) => {
          const isOpen = openIds.has(g.id);
          const inGroup = g.items.map((i) => (i.badge ? badges[i.badge] : undefined)).filter(Boolean) as Badge[];
          const sum = inGroup.reduce((s, b) => s + (b.n ?? 0), 0);
          const tone = inGroup.some((b) => b.tone === "bad") ? "bad" : inGroup.length ? "wait" : null;
          return (
            <div key={g.id} className={`side-group${isOpen ? " open" : ""}${groupId === g.id ? " here" : ""}`}>
              <button className="side-head" aria-expanded={isOpen} onClick={() => toggle(g.id)}>
                <g.icon />
                <span className="grow">{g.label}</span>
                {!isOpen && tone ? <BadgeView b={{ n: sum || undefined, tone }} /> : null}
                <ChevronDown className="chev" />
              </button>
              <div className="side-items" inert={!isOpen}>
                <div>
                  {g.items.map((i) => (
                    <NavLink key={i.to} to={i.to} className="side-link">
                      <i.icon />
                      <span className="grow">{i.label}</span>
                      <BadgeView b={i.badge ? badges[i.badge] : undefined} />
                    </NavLink>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </nav>
      <div className="side-foot">
        <div className="side-me">
          <span className="monogram">{initials(me.name)}</span>
          <span className="grow">
            <b>{me.name}</b>
            <small>{me.role}</small>
          </span>
        </div>
        <button className="icon-btn" onClick={onSignOut} aria-label="Sign out" title="Sign out">
          <LogOut />
        </button>
      </div>
    </aside>
  );
}

type AlertRow = { id: string; title: string; created_at: string; job_id: string | null; ref: string | null; kind: string };

function Topbar({ me, current, sandbox, onMenu, onJump, onSignOut }: { me: AdminMe; current: ReturnType<typeof findCurrent>; sandbox: boolean; onMenu: () => void; onJump: () => void; onSignOut: () => void }) {
  const loc = useLocation();
  const { data } = useLive();
  const [menu, setMenu] = useState<"bell" | "me" | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => setMenu(null), [loc.pathname]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  useEffect(() => {
    if (menu !== "bell") return;
    adminApi
      .get<{ alerts: AlertRow[] }>("/alerts")
      .then((r) => setAlerts(r.data.alerts))
      .catch(() => setAlerts([]));
  }, [menu]);
  const c = data?.counts ?? {};
  const alertN = c.alerts ?? 0;
  const urgent = Boolean(c.q_emergencies);
  const d = data?.drivers;
  const envTitle = d ? [d.payments === "simulated" && "M-Pesa is simulated: no money moves.", d.sms === "log" && "SMS isn't connected: messages are only logged.", d.otpOnScreen && "Sign-in codes show on screen."].filter(Boolean).join(" ") : "";

  return (
    <header className={`topbar${sandbox ? " sandbox" : ""}`}>
      <button className="icon-btn topbar-menu" onClick={onMenu} aria-label="Open menu">
        <Menu />
      </button>
      <div className="crumbs">
        {current?.group ? <span className="crumb-g">{current.group.label}</span> : null}
        <b>{current?.item.label ?? "Console"}</b>
      </div>
      <span className="grow" />
      <button className="jump-btn" onClick={onJump} aria-label="Jump to a page, job, worker or person">
        <Search />
        <span>Jump to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      {sandbox ? (
        <span className="env-pill" title={envTitle}>
          <span className="d" />
          Test mode
        </span>
      ) : null}
      <div className="top-actions" ref={wrap}>
        <div className="pop-wrap">
          <button className="icon-btn" onClick={() => setMenu(menu === "bell" ? null : "bell")} aria-label={`Alerts${alertN ? `, ${alertN} unseen` : ""}`} aria-expanded={menu === "bell"}>
            <Bell />
            {alertN ? <span className={`bell-n${urgent ? " bad" : ""}`}>{alertN > 9 ? "9+" : alertN}</span> : null}
          </button>
          {menu === "bell" ? (
            <div className="pop wide" role="menu">
              <div className="pop-head">
                <b>Unseen alerts</b>
                <span>{alertN ? `${alertN} waiting${urgent ? `, ${c.q_emergencies} emergency` : ""}` : "Nothing new"}</span>
              </div>
              {alerts === null ? (
                <div className="pop-empty">Loading…</div>
              ) : alerts.length ? (
                alerts.slice(0, 6).map((a) => (
                  <Link key={a.id} to={a.job_id ? `/admin/jobs/${a.job_id}` : "/admin/alerts"} className="pop-row" role="menuitem">
                    <span className={`sev-dot ${a.kind === "emergency" || a.kind === "unassigned" ? "bad" : "wait"}`} />
                    <span className="grow">{a.title}</span>
                    <time>{ago(a.created_at)}</time>
                  </Link>
                ))
              ) : (
                <div className="pop-empty">
                  <Check size={16} /> All clear
                </div>
              )}
              <Link to="/admin/alerts" className="pop-foot">
                All alerts <ArrowRight size={15} />
              </Link>
            </div>
          ) : null}
        </div>
        <div className="pop-wrap">
          <button className="avatar-btn" onClick={() => setMenu(menu === "me" ? null : "me")} aria-label="Account" aria-expanded={menu === "me"}>
            <span className="monogram">{initials(me.name)}</span>
          </button>
          {menu === "me" ? (
            <div className="pop" role="menu">
              <div className="pop-head">
                <b>{me.name}</b>
                <span>{me.email}</span>
                <span className="role">{me.role}</span>
              </div>
              <Link to="/" className="pop-row" role="menuitem">
                <User size={16} /> Open the app
              </Link>
              <button className="pop-row" role="menuitem" onClick={onSignOut}>
                <LogOut size={16} /> Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

type Hit = { key: string; label: string; sub?: string; to: string; icon: ReactNode; kind: string };

/** Ctrl K: jump to any page, or find a job, worker or person. */
function Jump({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: NavGroup[] }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState<Hit[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setRemote([]);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < 2) return setRemote([]);
    const id = setTimeout(async () => {
      const enc = encodeURIComponent(term);
      const [jobs, workers, people] = await Promise.all([
        adminApi.get<{ jobs: any[] }>(`/jobs?q=${enc}`).catch(() => null),
        adminApi.get<{ workers: any[] }>(`/workers?status=&q=${enc}`).catch(() => null),
        adminApi.get<{ users: any[] }>(`/users?q=${enc}`).catch(() => null),
      ]);
      const out: Hit[] = [];
      for (const j of jobs?.data.jobs.slice(0, 5) ?? []) out.push({ key: `j${j.id}`, label: `${j.ref} · ${j.service_name}`, sub: `${j.client_name}${j.worker_name ? ` · ${j.worker_name}` : ""}`, to: `/admin/jobs/${j.id}`, icon: <ClipboardList />, kind: "Job" });
      const workerIds = new Set<string>();
      for (const w of workers?.data.workers.slice(0, 5) ?? []) {
        workerIds.add(w.id);
        out.push({ key: `w${w.id}`, label: w.full_name || w.phone, sub: `${w.category ?? "Worker"} · ${w.status}`, to: `/admin/workers/${w.id}`, icon: <HardHat />, kind: "Worker" });
      }
      for (const u of people?.data.users.filter((x) => !workerIds.has(x.id)).slice(0, 5) ?? [])
        out.push({ key: `u${u.id}`, label: u.full_name || u.phone, sub: u.phone, to: u.worker_status ? `/admin/workers/${u.id}` : `/admin/people?q=${encodeURIComponent(u.phone)}`, icon: <Users />, kind: "Person" });
      setRemote(out);
    }, 220);
    return () => clearTimeout(id);
  }, [q, open]);

  const pages: Hit[] = useMemo(() => {
    const all: Hit[] = [{ key: DASHBOARD.to, label: DASHBOARD.label, to: DASHBOARD.to, icon: <DASHBOARD.icon />, kind: "Page" }];
    for (const g of groups) for (const i of g.items) all.push({ key: i.to, label: i.label, sub: g.label, to: i.to, icon: <i.icon />, kind: "Page" });
    const t = q.trim().toLowerCase();
    return t ? all.filter((h) => `${h.label} ${h.sub ?? ""}`.toLowerCase().includes(t)) : all;
  }, [groups, q]);

  const hits = [...pages, ...remote];
  useEffect(() => setSel(0), [q]);
  if (!open) return null;
  const go = (h?: Hit) => {
    if (!h) return;
    onClose();
    nav(h.to);
  };

  return (
    <div className="jump-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="jump" role="dialog" aria-modal="true" aria-label="Jump to">
        <div className="jump-in">
          <Search />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Page, job ref, name or phone"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(hits.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") go(hits[sel]);
              else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="jump-list">
          {hits.length ? (
            hits.map((h, i) => (
              <button key={h.key} className={`jump-row${i === sel ? " sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                <span className="jump-ic">{h.icon}</span>
                <span className="grow">
                  <b>{h.label}</b>
                  {h.sub ? <small>{h.sub}</small> : null}
                </span>
                <span className="jump-kind">{h.kind}</span>
              </button>
            ))
          ) : (
            <div className="pop-empty">Nothing matches “{q}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}
