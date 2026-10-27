import "../styles/admin.css";
import { Bell, Briefcase, ClipboardList, Gauge, IdCard, LogOut, Menu, MessageSquare, Receipt, ScrollText, Settings, ShieldAlert, Siren, Tags, UserCog, Users, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { errorMessage } from "../api/client";
import { Mark } from "../components/Logo";
import { Button, Input, Spinner } from "../components/ui";
import { adminApi, adminToken, setOnExpired, useAdmin } from "./api";
import { Alerts, Audit, Disputes, JobDetail, Jobs, Overview, Payments, Payouts, Rates, Reports, SettingsPage, Sms, Team, UsersPage, WorkerDetail, Workers } from "./pages";

export type AdminMe = { id: string; email: string; name: string; role: "owner" | "admin" | "ops" | "finance" };
type Enrol = { secret: string; uri: string; qr: string };

export default function Admin() {
  const [token, setToken] = useState(adminToken.get());
  const [me, setMe] = useState<AdminMe | null>(null);
  useEffect(() => {
    document.title = "Mjengo O'clock Admin";
    setOnExpired(() => {
      setToken(null);
      setMe(null);
    });
    return () => {
      document.title = "Mjengo O'clock";
    };
  }, []);
  useEffect(() => {
    if (!token) return;
    adminApi
      .get<{ admin: AdminMe }>("/me")
      .then((r) => setMe(r.data.admin))
      .catch(() => {
        adminToken.set(null);
        setToken(null);
      });
  }, [token]);
  if (!token) return <SignIn onDone={(t) => (adminToken.set(t), setToken(t))} />;
  if (!me)
    return (
      <div className="auth">
        <Spinner />
      </div>
    );
  return <Shell me={me} onSignOut={() => (adminToken.set(null), setToken(null), setMe(null))} />;
}

function SignIn({ onDone }: { onDone: (token: string) => void }) {
  const setup = useAdmin<{ needed: boolean; available: boolean }>("/setup");
  const [stage, setStage] = useState<"password" | "code">("password");
  const [pre, setPre] = useState<string | null>(null);
  const [enrol, setEnrol] = useState<Enrol | null>(null);
  const [f, setF] = useState({ email: "", password: "", name: "", token: "" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRun = setup.data?.needed;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (stage === "password") {
        const r = firstRun
          ? await adminApi.post<{ token: string; enrol: Enrol }>("/setup", { token: f.token, name: f.name, email: f.email, password: f.password })
          : await adminApi.post<{ token: string; enrol: Enrol | null }>("/login", { email: f.email, password: f.password });
        setPre(r.data.token);
        setEnrol(r.data.enrol);
        setStage("code");
      } else {
        const r = await adminApi.post<{ token: string }>("/totp", { code }, { headers: { Authorization: `Bearer ${pre}` } });
        onDone(r.data.token);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row g-10">
          <Mark size={40} />
          <span className="badge ink">Admin</span>
        </div>
        <div className="stack g-8">
          <h1>{stage === "code" ? (enrol ? "Set up your authenticator" : "Authenticator code") : firstRun ? "Create the owner account" : "Admin sign-in"}</h1>
          <p className="muted small">
            {stage === "code"
              ? enrol
                ? "Scan this with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code it shows."
                : "Enter the 6-digit code from your authenticator app."
              : firstRun
                ? "No admin exists yet. Use the setup token from the server's ADMIN_SETUP_TOKEN setting."
                : "For the Mjengo O'clock operations team."}
          </p>
        </div>
        <form className="stack g-16" onSubmit={submit}>
          {stage === "password" ? (
            <>
              {firstRun && (
                <>
                  <Input label="Setup token" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="off" />
                  <Input label="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
                </>
              )}
              <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" autoFocus={!firstRun} />
              <Input label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={firstRun ? "new-password" : "current-password"} hint={firstRun ? "At least 12 characters." : undefined} />
            </>
          ) : (
            <>
              {enrol && (
                <div className="stack g-10" style={{ alignItems: "center" }}>
                  <img src={enrol.qr} alt="Authenticator QR code" className="qr" />
                  <span className="tiny muted">Or enter this key by hand</span>
                  <span className="secret">{enrol.secret.replace(/(.{4})/g, "$1 ").trim()}</span>
                </div>
              )}
              <Input aria-label="6-digit code" className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            </>
          )}
          {error && <div className="notice error small">{error}</div>}
          <Button variant="primary" size="lg" block loading={busy} type="submit">
            {stage === "code" ? "Verify" : firstRun ? "Create owner" : "Continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function Shell({ me, onSignOut }: { me: AdminMe; onSignOut: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const ov = useAdmin<{ counts: Record<string, number> }>(`/overview?_=${loc.pathname}`);
  const c = ov.data?.counts ?? {};
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    const t = setInterval(() => void ov.reload(), 20_000);
    return () => clearInterval(t);
  }, [ov.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");
  const Count = ({ n, alert }: { n?: number; alert?: boolean }) => (n ? <span className={`count ${alert ? "alert" : ""}`}>{n}</span> : null);
  const can = (...roles: AdminMe["role"][]) => me.role === "owner" || roles.includes(me.role);
  return (
    <div className={`admin ${open ? "nav-open" : ""}`}>
      <aside className="admin-side">
        <div className="brand row g-10">
          <Mark size={30} />
          <span className="wordmark" style={{ fontSize: 16 }}>
            Mjengo <b>O'clock</b>
          </span>
        </div>
        <NavLink to="/admin" end className={link}>
          <Gauge /> Overview
        </NavLink>
        <NavLink to="/admin/alerts" className={link}>
          <Bell /> Alerts <Count n={c.alerts} />
        </NavLink>
        <div className="group">Queues</div>
        <NavLink to="/admin/workers" className={link}>
          <IdCard /> Worker approvals <Count n={c.q_applications} />
        </NavLink>
        <NavLink to="/admin/jobs?status=UNASSIGNED" className={() => (loc.pathname === "/admin/jobs" && loc.search.includes("UNASSIGNED") ? "active" : "")}>
          <Siren /> Unassigned <Count n={c.q_unassigned} alert />
        </NavLink>
        <NavLink to="/admin/disputes" className={link}>
          <ShieldAlert /> Disputes <Count n={c.q_disputes} />
        </NavLink>
        <NavLink to="/admin/reports" className={link}>
          <MessageSquare /> Safety reports <Count n={c.q_reports} alert={Boolean(c.q_emergencies)} />
        </NavLink>
        <div className="group">Operations</div>
        <NavLink to="/admin/jobs" className={() => (loc.pathname.startsWith("/admin/jobs") && !loc.search.includes("UNASSIGNED") ? "active" : "")}>
          <ClipboardList /> Jobs
        </NavLink>
        <NavLink to="/admin/people" className={link}>
          <Users /> People
        </NavLink>
        <NavLink to="/admin/rates" className={link}>
          <Tags /> Trades and rates
        </NavLink>
        {can("admin", "finance") && (
          <>
            <div className="group">Money</div>
            <NavLink to="/admin/payments" className={link}>
              <Receipt /> Payments
            </NavLink>
            <NavLink to="/admin/payouts" className={link}>
              <Wallet /> Payouts <Count n={c.q_payouts} />
            </NavLink>
          </>
        )}
        <div className="group">Platform</div>
        <NavLink to="/admin/settings" className={link}>
          <Settings /> Fees and policies
        </NavLink>
        <NavLink to="/admin/sms" className={link}>
          <Briefcase /> SMS log
        </NavLink>
        {can() && (
          <NavLink to="/admin/team" className={link}>
            <UserCog /> Team
          </NavLink>
        )}
        {can("admin") && (
          <NavLink to="/admin/audit" className={link}>
            <ScrollText /> Audit log
          </NavLink>
        )}
        <div className="foot stack g-10">
          <span>
            {me.name} · {me.role}
          </span>
          <button
            className="row g-8"
            onClick={() => {
              onSignOut();
              nav("/admin");
            }}
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>
      <div>
        <div className="admin-top">
          <button className="icon-btn" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
            <Menu />
          </button>
          <Mark size={26} />
          <span className="strong">Admin</span>
        </div>
        <main className="admin-main">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="workers" element={<Workers />} />
            <Route path="workers/:id" element={<WorkerDetail me={me} />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:id" element={<JobDetail me={me} />} />
            <Route path="disputes" element={<Disputes />} />
            <Route path="reports" element={<Reports />} />
            <Route path="people" element={<UsersPage />} />
            <Route path="rates" element={<Rates />} />
            <Route path="payments" element={<Payments />} />
            <Route path="payouts" element={<Payouts />} />
            <Route path="settings" element={<SettingsPage me={me} />} />
            <Route path="sms" element={<Sms />} />
            <Route path="team" element={<Team me={me} />} />
            <Route path="audit" element={<Audit />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
