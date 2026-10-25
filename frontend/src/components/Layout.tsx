import { Bell, Briefcase, ClipboardList, House, Info, User } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth, useConfig } from "../context/AuthContext";
import { Logo } from "./Logo";

const NAV = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/jobs", label: "My jobs", icon: ClipboardList },
  { to: "/work", label: "Work", icon: Briefcase },
  { to: "/account", label: "Account", icon: User },
];

/** Tells people plainly when payments or SMS are in test mode. */
function TestModeBanner() {
  const cfg = useConfig();
  if (!cfg) return null;
  const parts = [cfg.payments.simulated && "payments are simulated", cfg.sms.codesOnScreen && "sign-in codes show on screen"].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div className="banner" role="note">
      <Info />
      <span>Test mode: {parts.join(", ")}. No money moves.</span>
    </div>
  );
}

export function Layout() {
  const { me, ready } = useAuth();
  const loc = useLocation();
  const flush = /^\/jobs\/[^/]+$/.test(loc.pathname) || /^\/work\/jobs\/[^/]+$/.test(loc.pathname);
  const wide = loc.pathname === "/";
  return (
    <div className="app">
      <TestModeBanner />
      <header className="topbar">
        <div className="topbar-inner">
          <Logo />
          <nav className="topnav" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-actions">
            {me ? (
              <Link to="/notifications" className="icon-btn" aria-label={`Notifications${me.unread ? `, ${me.unread} unread` : ""}`}>
                <Bell />
                {me.unread > 0 && <span className="dot-badge">{me.unread > 9 ? "9+" : me.unread}</span>}
              </Link>
            ) : (
              ready &&
              loc.pathname !== "/login" && (
                <Link to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} className="btn btn-sm">
                  Sign in
                </Link>
              )
            )}
          </div>
        </div>
      </header>
      <main className={`main ${flush ? "flush" : wide ? "wide" : ""}`}>
        <Outlet />
      </main>
      {!flush && <Footer />}
      <nav className="bottomnav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <n.icon />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>© {new Date().getFullYear()} Mjengo O'clock · Nairobi</span>
        <Link to="/legal/terms">Terms</Link>
        <Link to="/legal/privacy">Privacy</Link>
        <Link to="/legal/policies">Fees, cancellations and disputes</Link>
        <Link to="/help">Help and safety</Link>
      </div>
    </footer>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="stack g-12">
      <div className="row between">
        <div className="section-title">{title}</div>
        {action}
      </div>
      {children}
    </section>
  );
}
