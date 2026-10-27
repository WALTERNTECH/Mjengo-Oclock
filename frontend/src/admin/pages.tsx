import { CircleCheck, Download, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { errorMessage } from "../api/client";
import { Badge, Button, Input, Notice, Segmented, Select, Skeleton, Stars, StatusBadge, Textarea } from "../components/ui";
import { useToast } from "../context/toast";
import { dateTime, kes, prettyPhone, STATUS_LABEL } from "../lib/format";
import type { JobStatus } from "../types";
import type { AdminMe } from "./Admin";
import { adminApi, download, useAdmin } from "./api";

type Row = Record<string, any>;

function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="admin-head">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="tabs">
      {options.map(([v, l]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, "ok");
      return true;
    } catch (e) {
      toast(errorMessage(e), "error");
      return false;
    } finally {
      setBusy("");
    }
  };
  return { busy, run };
}

const Loading = () => <Skeleton h={240} />;

// ——— Overview ———

type Metric = { value: number | null; target: number; n: number; unit: string; lowerIsBetter?: boolean; median?: number | null };
const METRICS: [string, string, (m: Metric) => string, string][] = [
  ["matchRate", "Match rate", (m) => `${m.value}%`, "Bookings accepted by a worker · target 85% or higher"],
  ["timeToAccept", "Time to accept (median)", (m) => (m.value! >= 60 ? `${Math.floor(m.value! / 60)} min ${m.value! % 60} s` : `${m.value} s`), "Booking to acceptance · target under 3 minutes"],
  ["completionRate", "Completion rate", (m) => `${m.value}%`, "Accepted jobs finished and paid · target 90% or higher"],
  ["noShowRate", "Worker no-show rate", (m) => `${m.value}%`, "Accepted jobs where the worker didn't arrive · target under 3%"],
  ["disputeRate", "Dispute rate", (m) => `${m.value}%`, "Completed jobs with a dispute · target under 5%"],
  ["averageRating", "Average rating", (m) => `${m.value!.toFixed(2)} ★`, "Clients' ratings of workers · target 4.3 or higher"],
  ["repeatRate", "Repeat booking rate", (m) => `${m.value}%`, "Clients booking again within 60 days · target 30% or higher"],
  ["pageLoad", "Page load (75th percentile)", (m) => `${(m.value! / 1000).toFixed(1)} s`, "Phones on 3G/4G · target under 3 seconds"],
];

function onTarget(m: Metric) {
  if (m.value == null) return null;
  return m.lowerIsBetter ? m.value < m.target : m.value >= m.target;
}

export function Overview() {
  const [days, setDays] = useState("30");
  const { data } = useAdmin<{ money: Row; counts: Row; series: { day: string; bookings: number; revenue: number }[]; metrics: Record<string, Metric>; drivers: Row }>(`/overview?days=${days}`);
  if (!data) return <Loading />;
  const c = data.counts;
  const queue = (label: string, n: number, to: string, alarm = false) => (
    <Link to={to} className={`tile queue ${n ? (alarm ? "alarm" : "hot") : ""}`}>
      <span className="label">{label}</span>
      <span className="value">{n}</span>
    </Link>
  );
  return (
    <div className="stack g-24">
      <Head title="Overview">
        <Tabs value={days} onChange={setDays} options={[["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]} />
      </Head>
      {(data.drivers.payments === "simulated" || data.drivers.sms === "log") && (
        <Notice tone="warn">
          Test mode: {data.drivers.payments === "simulated" ? "M-Pesa is simulated (no money moves). " : ""}
          {data.drivers.sms === "log" ? `SMS isn't connected (messages are only logged${data.drivers.otpOnScreen ? ", sign-in codes show on screen" : ""}). ` : ""}
          Payouts: {data.drivers.payouts ?? "by hand"}. Maps: {data.drivers.maps}.
        </Notice>
      )}
      <section className="stack g-10">
        <div className="section-title">Queues</div>
        <div className="tiles">
          {queue("Worker applications", c.q_applications, "/admin/workers")}
          {queue("Unassigned bookings", c.q_unassigned, "/admin/jobs?status=UNASSIGNED", true)}
          {queue("Open disputes", c.q_disputes, "/admin/disputes")}
          {queue(c.q_emergencies ? `Safety reports (${c.q_emergencies} emergency)` : "Safety reports", c.q_reports, "/admin/reports", Boolean(c.q_emergencies))}
          {queue("Payouts to send", c.q_payouts, "/admin/payouts")}
          {queue("Probation jobs to review", c.q_probation, "/admin/jobs?status=probation")}
          {queue("Flagged workers", c.q_flagged, "/admin/workers?status=flagged")}
          {queue("Suspended workers", c.q_suspended, "/admin/workers?status=suspended")}
        </div>
      </section>
      <section className="stack g-10">
        <div className="section-title">Success metrics · last {days} days</div>
        <div className="tiles">
          {METRICS.map(([k, label, fmt, help]) => {
            const m = data.metrics[k];
            const ok = onTarget(m);
            return (
              <div key={k} className="tile" title={help}>
                <span className="label">{label}</span>
                <span className="value">{m.value == null ? "—" : fmt(m)}</span>
                <span className="meta">
                  {ok == null ? (
                    "Not enough data yet"
                  ) : ok ? (
                    <span className="status-good row g-4">
                      <CircleCheck /> On target
                    </span>
                  ) : (
                    <span className="status-warn row g-4">
                      <TriangleAlert /> Off target
                    </span>
                  )}
                  <span>· n = {m.n}</span>
                </span>
                <span className="tiny muted">{help}</span>
              </div>
            );
          })}
        </div>
      </section>
      <section className="stack g-10">
        <div className="section-title">Money and activity</div>
        <div className="tiles">
          <div className="tile">
            <span className="label">Platform revenue, 30 days</span>
            <span className="value">{kes(data.money.revenue_30)}</span>
            <span className="meta">Today {kes(data.money.revenue_today)}</span>
          </div>
          <div className="tile">
            <span className="label">Work value paid out, 30 days</span>
            <span className="value">{kes(data.money.gmv_30)}</span>
          </div>
          <div className="tile">
            <span className="label">Held in escrow now</span>
            <span className="value">{kes(data.money.in_escrow)}</span>
          </div>
          <div className="tile">
            <span className="label">Jobs in progress</span>
            <span className="value">{c.active_jobs}</span>
            <span className="meta">{c.searching} looking for a worker</span>
          </div>
          <div className="tile">
            <span className="label">Approved workers</span>
            <span className="value">{c.workers}</span>
            <span className="meta">{c.workers_online} available now</span>
          </div>
          <div className="tile">
            <span className="label">Clients</span>
            <span className="value">{c.clients}</span>
          </div>
        </div>
      </section>
      <BookingsChart series={data.series} />
    </div>
  );
}

/** Confirmed bookings per day: one series, so the title names it and no legend is needed. */
function BookingsChart({ series }: { series: { day: string; bookings: number; revenue: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...series.map((s) => s.bookings));
  const step = max <= 4 ? 1 : Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-KE", { day: "numeric", month: "short" });
  return (
    <section className="chart stack g-12">
      <div className="row between">
        <div className="stack">
          <span className="strong">Confirmed bookings per day</span>
          <span className="tiny muted">Last 30 days, Nairobi time</span>
        </div>
        <button className="link small" onClick={() => setTable((t) => !t)}>
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table ? (
        <div className="table-wrap" style={{ maxHeight: 260 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Bookings</th>
                <th className="num">Platform revenue</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={s.day}>
                  <td>{label(s.day)}</td>
                  <td className="num">{s.bookings}</td>
                  <td className="num">{kes(s.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ paddingLeft: 28 }}>
          <div className="bars" role="img" aria-label={`Bookings per day, highest ${max}`} onMouseLeave={() => setHover(null)}>
            {ticks.slice(1).map((t) => (
              <div key={t} className="grid" style={{ bottom: `${(t / top) * 100}%` }}>
                <span>{t}</span>
              </div>
            ))}
            {series.map((s, i) => (
              <div key={s.day} className="bar-slot" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${label(s.day)}: ${s.bookings} bookings`}>
                <div className="bar" style={{ height: `${(s.bookings / top) * 100}%` }} />
              </div>
            ))}
            {hover != null && (
              <div className="chart-tip" style={{ left: `${((hover + 0.5) / series.length) * 100}%`, bottom: `${(series[hover].bookings / top) * 100}%` }}>
                {label(series[hover].day)} · <b>{series[hover].bookings}</b> booking{series[hover].bookings === 1 ? "" : "s"} · {kes(series[hover].revenue)}
              </div>
            )}
          </div>
          <div className="chart-axis">
            <span>{label(series[0].day)}</span>
            <span>{label(series[Math.floor(series.length / 2)].day)}</span>
            <span>{label(series[series.length - 1].day)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

export function Alerts() {
  const [all, setAll] = useState(false);
  const { data, reload } = useAdmin<{ alerts: Row[] }>(`/alerts${all ? "?all=1" : ""}`);
  const { busy, run } = useRun();
  return (
    <div className="stack g-16">
      <Head title="Alerts">
        <Tabs value={all ? "all" : "open"} onChange={(v) => setAll(v === "all")} options={[["open", "Unseen"], ["all", "All"]]} />
        <Button size="sm" loading={busy === "seen"} onClick={() => void run("seen", () => adminApi.post("/alerts/seen", {}).then(reload))}>
          Mark all seen
        </Button>
      </Head>
      {!data ? (
        <Loading />
      ) : !data.alerts.length ? (
        <Notice tone="ok">Nothing needs attention.</Notice>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {data.alerts.map((a) => (
                <tr key={a.id}>
                  <td style={{ width: 150 }} className="small muted">
                    {dateTime(a.created_at)}
                  </td>
                  <td>
                    <div className="strong">{a.title}</div>
                    {a.body && <div className="small muted">{a.body}</div>}
                  </td>
                  <td className="nowrap">
                    {a.job_id && (
                      <Link className="link small" to={`/admin/jobs/${a.job_id}`}>
                        {a.ref ?? "Job"}
                      </Link>
                    )}{" "}
                    {a.user_id && (
                      <Link className="link small" to={`/admin/workers/${a.user_id}`}>
                        Person
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ——— Workers ———

const WORKER_TABS: [string, string][] = [["submitted", "To review"], ["more_info", "More info asked"], ["approved", "Approved"], ["flagged", "Flagged"], ["suspended", "Suspended"], ["rejected", "Rejected"], ["", "All"]];

export function Workers() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "submitted";
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const { data } = useAdmin<{ workers: Row[] }>(`/workers?status=${status}&q=${encodeURIComponent(q)}`);
  return (
    <div className="stack g-16">
      <Head title="Workers">
        <div style={{ width: 260 }}>
          <Input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Head>
      <Tabs value={status} onChange={(v) => setParams({ status: v })} options={WORKER_TABS} />
      {!data ? (
        <Loading />
      ) : !data.workers.length ? (
        <Notice>No workers here.</Notice>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Trade</th>
                <th>Status</th>
                <th>ID check</th>
                <th className="num">Jobs</th>
                <th className="num">Rating</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.map((w) => (
                <tr key={w.id} className="click" onClick={() => nav(`/admin/workers/${w.id}`)}>
                  <td>
                    <div className="strong">{w.full_name || "—"}</div>
                    <div className="tiny muted">{prettyPhone(w.phone)}</div>
                  </td>
                  <td>{w.category}</td>
                  <td>
                    <Badge tone={w.status === "approved" ? "green" : w.status === "submitted" ? "amber" : w.status === "suspended" || w.status === "rejected" ? "red" : ""}>{w.status.replace("_", " ")}</Badge>
                    {w.flagged && (
                      <div className="tiny red mt-4" title={w.flag_reason}>
                        Flagged
                      </div>
                    )}
                    {w.status === "approved" && <div className="tiny muted mt-4">{w.available ? "Available" : "Off duty"}</div>}
                  </td>
                  <td className="small">{w.id_check_status.replace("_", " ")}</td>
                  <td className="num">{w.jobs_completed}</td>
                  <td className="num">{w.rating ?? "—"}</td>
                  <td className="small muted">{w.submitted_at ? dateTime(w.submitted_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function WorkerDetail({ me }: { me: AdminMe }) {
  const { id = "" } = useParams();
  const { data, reload } = useAdmin<{ worker: Row; ratings: Row[]; jobs: Row[] }>(`/workers/${id}`);
  const { busy, run } = useRun();
  const [reason, setReason] = useState("");
  const [idOk, setIdOk] = useState(false);
  if (!data) return <Loading />;
  const w = data.worker;
  const canDecide = ["submitted", "more_info", "rejected"].includes(w.status) && (me.role === "owner" || me.role === "admin" || me.role === "ops");
  const decide = (decision: string) =>
    void run(decision, () => adminApi.post(`/workers/${id}/decision`, { decision, reason, idVerified: idOk }).then(reload), decision === "approved" ? "Approved. They've been texted." : "Sent to the worker by SMS");
  const standing = (action: string) => void run(action, () => adminApi.post(`/workers/${id}/standing`, { action, reason }).then(reload), "Updated");
  return (
    <div className="stack g-20">
      <Head title={w.name || "Worker"}>
        <Link to="/admin/workers" className="link small">
          ← All workers
        </Link>
      </Head>
      <div className="split">
        <div className="stack g-20">
          <div className="docs">
            {[
              ["National ID", w.documents.idFront],
              ["Selfie", w.documents.selfie],
              [w.requiresCertificate ? "Certificate (required)" : "Certificate (optional)", w.documents.certificate],
            ].map(([label, url]) => (
              <div className="doc" key={label}>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    <img src={url} alt={label} />
                  </a>
                ) : (
                  <div className="none">Not uploaded</div>
                )}
                <div className="cap">{label}</div>
              </div>
            ))}
          </div>
          <div className="card kv-grid">
            <span>Phone</span>
            <span>{prettyPhone(w.phone)}</span>
            <span>Trade</span>
            <span>
              {w.category} · {w.yearsExperience} years
            </span>
            <span>National ID</span>
            <span className="mono">{w.nationalId ?? "—"}</span>
            <span>ID check</span>
            <span>
              {w.idCheck.status.replace("_", " ")} ({w.idCheck.provider ?? "—"})
            </span>
            <span>About</span>
            <span>{w.bio || "—"}</span>
            <span>Base</span>
            <span>{w.home?.label ?? "—"}</span>
            <span>Payout</span>
            <span>{w.payout.method === "mpesa" ? `M-Pesa ${prettyPhone(w.payout.phone ?? w.phone)}` : `${w.payout.bankName}, ${w.payout.bankBranch ?? ""} · ${w.payout.accountName} · ${w.payout.accountNumber}`}</span>
            <span>Emergency contact</span>
            <span>{w.emergency ? `${w.emergency.name} · ${prettyPhone(w.emergency.phone)}` : "—"}</span>
            <span>Joined</span>
            <span>{dateTime(w.joinedAt)}</span>
            <span>Standing</span>
            <span>
              {w.stats.jobs} jobs · rating {w.stats.rating ?? "—"} ({w.stats.ratings}) · {w.stats.cancellations} cancellations · {w.stats.noShows} no-shows
              {w.flagged && <div className="red small">Flagged: {w.flagReason}</div>}
            </span>
          </div>
          {data.ratings.length > 0 && (
            <div className="stack g-8">
              <div className="section-title">Recent ratings</div>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {data.ratings.map((r, i) => (
                      <tr key={i}>
                        <td style={{ width: 110 }}>
                          <Stars value={r.stars} />
                        </td>
                        <td>{r.review || <span className="muted">No comment</span>}</td>
                        <td className="small muted nowrap">
                          {r.ref}
                          {r.probation ? " · probation" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {data.jobs.length > 0 && (
            <div className="stack g-8">
              <div className="section-title">Jobs</div>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {data.jobs.map((j) => (
                      <tr key={j.id}>
                        <td>
                          <Link className="link" to={`/admin/jobs/${j.id}`}>
                            {j.ref}
                          </Link>
                        </td>
                        <td>{j.service_name}</td>
                        <td>
                          <StatusBadge status={j.status} />
                        </td>
                        <td className="small">{j.probation ? (j.probation_reviewed_at ? "Probation reviewed" : "Probation") : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="card stack g-14" style={{ position: "sticky", top: 20 }}>
          <div className="row between">
            <span className="strong">Decision</span>
            <Badge tone={w.status === "approved" ? "green" : w.status === "submitted" ? "amber" : ""}>{w.status.replace("_", " ")}</Badge>
          </div>
          {w.reviewReason && <p className="small muted">Last note: {w.reviewReason}</p>}
          <Textarea label="Reason sent to the worker by SMS" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required for More info and Reject" maxLength={500} />
          {canDecide && (
            <>
              <label className="check">
                <input type="checkbox" checked={idOk} onChange={(e) => setIdOk(e.target.checked)} />
                <span className="small">The ID photo is genuine, matches the number, and the selfie matches the ID photo</span>
              </label>
              <Button variant="primary" block disabled={!idOk && w.idCheck.status !== "verified"} loading={busy === "approved"} onClick={() => decide("approved")}>
                Approve
              </Button>
              <Button block loading={busy === "more_info"} onClick={() => decide("more_info")}>
                More info needed
              </Button>
              <Button variant="danger" block loading={busy === "rejected"} onClick={() => decide("rejected")}>
                Reject
              </Button>
            </>
          )}
          {w.status === "approved" && (
            <Button variant="danger" block loading={busy === "suspend"} onClick={() => standing("suspend")}>
              Suspend
            </Button>
          )}
          {w.status === "suspended" && (
            <Button variant="primary" block loading={busy === "reinstate"} onClick={() => standing("reinstate")}>
              Reinstate
            </Button>
          )}
          {w.flagged && (
            <Button block loading={busy === "clear_flag"} onClick={() => standing("clear_flag")}>
              Clear flag
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ——— Jobs ———

const JOB_TABS: [string, string][] = [
  ["UNASSIGNED", "Unassigned"],
  ["SEARCHING", "Searching"],
  ["SCHEDULED", "Scheduled"],
  ["active", "Active"],
  ["late", "Worker late"],
  ["COMPLETED", "Awaiting approval"],
  ["DISPUTED", "Disputed"],
  ["probation", "Probation review"],
  ["CLOSED", "Closed"],
  ["CANCELLED", "Cancelled"],
  ["", "All"],
];

export function Jobs() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const { data, reload } = useAdmin<{ jobs: Row[] }>(`/jobs?status=${status}&q=${encodeURIComponent(q)}`);
  useEffect(() => {
    const t = setInterval(() => void reload(), 15_000);
    return () => clearInterval(t);
  }, [reload]);
  return (
    <div className="stack g-16">
      <Head title="Jobs">
        <div style={{ width: 280 }}>
          <Input placeholder="Search ref, name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Head>
      <Tabs value={status} onChange={(v) => setParams(v ? { status: v } : {})} options={JOB_TABS} />
      {!data ? (
        <Loading />
      ) : !data.jobs.length ? (
        <Notice>No jobs here.</Notice>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Job</th>
                <th>Client</th>
                <th>Worker</th>
                <th>Status</th>
                <th className="num">Paid</th>
                <th>Booked</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.id} className="click" onClick={() => nav(`/admin/jobs/${j.id}`)}>
                  <td>
                    <div className="strong">{j.ref}</div>
                    <div className="tiny muted">{j.service_name}</div>
                  </td>
                  <td>
                    <div>{j.client_name}</div>
                    <div className="tiny muted">{prettyPhone(j.client_phone)}</div>
                  </td>
                  <td>{j.worker_name ?? <span className="muted">—</span>}</td>
                  <td>
                    <StatusBadge status={j.status} />
                    {j.worker_no_show_at && ["ACCEPTED", "EN_ROUTE"].includes(j.status) && <div className="tiny red mt-4">Worker late</div>}
                    {j.probation && !j.probation_reviewed_at && j.status === "CLOSED" && <div className="tiny amber mt-4">Probation</div>}
                  </td>
                  <td className="num">{kes(j.paid_kes)}</td>
                  <td className="small muted">
                    {dateTime(j.created_at)}
                    {j.scheduled_for && <div>for {dateTime(j.scheduled_for)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function JobDetail({ me }: { me: AdminMe }) {
  const { id = "" } = useParams();
  const { data, reload } = useAdmin<Row>(`/jobs/${id}`);
  const { busy, run } = useRun();
  const [cancelFee, setCancelFee] = useState("0");
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<"RELEASE" | "REFUND" | "SPLIT">("RELEASE");
  const [gross, setGross] = useState("");
  const [dnote, setDnote] = useState("");
  if (!data) return <Loading />;
  const j = data.job as Row & { status: JobStatus };
  const ops = me.role !== "finance";
  const open = ["SCHEDULED", "SEARCHING", "UNASSIGNED"].includes(j.status);
  const cancellable = ["PENDING_PAYMENT", "SCHEDULED", "SEARCHING", "UNASSIGNED", "ACCEPTED", "EN_ROUTE", "ON_SITE", "IN_PROGRESS"].includes(j.status);
  const work = j.base_kes + j.extras_kes;
  return (
    <div className="stack g-20">
      <Head title={`${j.ref} · ${j.service_name}`}>
        <StatusBadge status={j.status} />
        <Link to="/admin/jobs" className="link small">
          ← All jobs
        </Link>
      </Head>
      <div className="split">
        <div className="stack g-20">
          <div className="card kv-grid">
            <span>Client</span>
            <span>
              {j.client_name} · {prettyPhone(j.client_phone)}
            </span>
            <span>Worker</span>
            <span>
              {j.worker_id ? (
                <Link className="link" to={`/admin/workers/${j.worker_id}`}>
                  {j.worker_name} · {prettyPhone(j.worker_phone)}
                </Link>
              ) : (
                "—"
              )}
            </span>
            <span>Address</span>
            <span>
              {j.address}
              {j.address_notes ? ` · ${j.address_notes}` : ""}
            </span>
            <span>When</span>
            <span>{j.scheduled_for ? dateTime(j.scheduled_for) : "As soon as possible"}</span>
            <span>Description</span>
            <span>{j.description}</span>
            <span>Price</span>
            <span>
              {kes(j.base_kes)} + {j.client_fee_pct}% fee {kes(j.client_fee_kes)} = {kes(j.total_kes)}
              {j.extras_kes > 0 && ` · extras ${kes(j.extras_kes)}`}
              {j.tip_kes > 0 && ` · tip ${kes(j.tip_kes)}`}
            </span>
            <span>Escrow</span>
            <span>
              {j.escrow} · paid {kes(j.paid_kes)}
              {j.worker_net_kes != null && ` · worker ${kes(j.worker_net_kes)} · refund ${kes(j.refund_kes)} · platform ${kes(j.platform_kes)}`}
            </span>
            <span>Dispatch</span>
            <span>
              round {j.dispatch_round}
              {j.probation ? ` · probation job${j.probation_reviewed_at ? " (reviewed)" : ""}` : ""}
              {j.worker_no_show_at ? ` · worker late since ${dateTime(j.worker_no_show_at)}` : ""}
            </span>
          </div>

          {data.photos.length > 0 && (
            <div className="docs">
              {data.photos.map((p: Row, i: number) => (
                <div className="doc" key={i}>
                  <a href={p.url} target="_blank" rel="noreferrer">
                    <img src={p.url} alt={p.kind} style={{ height: 180 }} />
                  </a>
                  <div className="cap">
                    {p.kind} · {dateTime(p.at)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.dispute && (
            <div className="card stack g-8">
              <div className="strong">Dispute: {data.dispute.reason}</div>
              <p className="small">{data.dispute.details}</p>
              {data.dispute.decision && (
                <p className="small muted">
                  Decided {data.dispute.decision} · {data.dispute.note}
                </p>
              )}
            </div>
          )}

          {data.extras.length > 0 && (
            <Table
              title="Extra requests"
              head={["When", "Kind", "Amount", "Reason", "Status"]}
              rows={data.extras.map((x: Row) => [dateTime(x.created_at), x.kind, kes(x.amount_kes), x.reason, x.status])}
            />
          )}
          <Table title="Timeline" head={["When", "Who", "What", "Detail"]} rows={data.timeline.map((e: Row) => [dateTime(e.at), e.actor, e.kind, <span className="mono">{JSON.stringify(e.detail)}</span>])} />
          {data.offers.length > 0 && <Table title="Offers" head={["Worker", "Round", "km", "Offered", "Status"]} rows={data.offers.map((o: Row) => [o.full_name, o.round, o.distance_km, dateTime(o.offered_at), o.status])} />}
          {data.payments.length > 0 && <Table title="Payments in" head={["When", "What", "Amount", "Status", "Receipt"]} rows={data.payments.map((p: Row) => [dateTime(p.createdAt), p.purpose, kes(p.amount), p.status, p.receipt ?? "—"])} />}
          {data.payouts.length > 0 && (
            <Table title="Money out" head={["Kind", "To", "Amount", "Status", "Reference"]} rows={data.payouts.map((p: Row) => [p.kind, p.full_name, kes(p.amount_kes), p.status + (p.last_error ? ` · ${p.last_error}` : ""), p.reference ?? "—"])} />
          )}
          {data.reports.length > 0 && <Table title="Reports" head={["When", "By", "Kind", "Message"]} rows={data.reports.map((r: Row) => [dateTime(r.created_at), r.full_name, `${r.kind} · ${r.category}`, r.message])} />}
          {data.ratings.length > 0 && <Table title="Ratings" head={["By", "Stars", "Review"]} rows={data.ratings.map((r: Row) => [r.rater_role, r.stars, r.review])} />}
        </div>

        <div className="stack g-14" style={{ position: "sticky", top: 20 }}>
          {ops && open && (
            <div className="card stack g-10">
              <div className="strong">Dispatch by hand</div>
              <p className="small muted">Nearest approved {j.category_id.replace("_", " ")} workers. Assigning texts the worker and skips the offer window.</p>
              {data.nearby.length === 0 && <Notice tone="warn">No approved workers in this trade have a location yet.</Notice>}
              {data.nearby.map((w: Row) => (
                <div key={w.id} className="row g-8 small">
                  <span className="grow">
                    <b>{w.full_name}</b> · {w.km.toFixed(1)} km{w.rating ? ` · ${w.rating}★` : ""}
                    <div className="tiny muted">
                      {w.available ? "Available" : "Off duty"}
                      {w.busy ? " · on a job" : ""} · {prettyPhone(w.phone)}
                    </div>
                  </span>
                  <Button size="sm" loading={busy === `assign-${w.id}`} onClick={() => void run(`assign-${w.id}`, () => adminApi.post(`/jobs/${id}/assign`, { workerId: w.id }).then(reload), "Assigned")}>
                    Assign
                  </Button>
                </div>
              ))}
              {["UNASSIGNED", "SEARCHING"].includes(j.status) && (
                <Button block icon={<RefreshCw />} loading={busy === "redispatch"} onClick={() => void run("redispatch", () => adminApi.post(`/jobs/${id}/redispatch`).then(reload), "Offering again from the nearest")}>
                  Restart automatic dispatch
                </Button>
              )}
            </div>
          )}

          {ops && j.status === "DISPUTED" && (
            <div className="card stack g-10">
              <div className="strong">Resolve the dispute</div>
              <Segmented
                value={decision}
                onChange={setDecision}
                options={[
                  { value: "RELEASE", label: "Release" },
                  { value: "SPLIT", label: "Split" },
                  { value: "REFUND", label: "Refund" },
                ]}
              />
              {decision === "SPLIT" && <Input label={`Worker's part of the ${kes(work)} work value`} inputMode="numeric" value={gross} onChange={(e) => setGross(e.target.value.replace(/\D/g, ""))} hint="The worker receives this less their fee; the client gets the rest back." />}
              <Textarea label="Decision note (sent to both by SMS)" value={dnote} onChange={(e) => setDnote(e.target.value)} maxLength={300} />
              <Button
                variant="primary"
                block
                loading={busy === "resolve"}
                onClick={() =>
                  void run("resolve", () => adminApi.post(`/disputes/${id}/resolve`, { decision, workerGross: decision === "SPLIT" ? Number(gross) : undefined, note: dnote }).then(reload), "Decision applied and sent")
                }
              >
                Apply decision
              </Button>
            </div>
          )}

          {ops && j.probation && !j.probation_reviewed_at && j.status === "CLOSED" && (
            <div className="card stack g-10">
              <div className="strong">Probation review</div>
              <p className="small muted">One of the worker's first jobs. Check the rating and timeline.</p>
              <Button block loading={busy === "probation"} onClick={() => void run("probation", () => adminApi.post(`/jobs/${id}/probation-reviewed`, {}).then(reload), "Marked reviewed")}>
                Mark reviewed
              </Button>
            </div>
          )}

          {ops && cancellable && (
            <div className="card stack g-10">
              <div className="strong">Cancel the job</div>
              {j.worker_id && <Input label="Fee paid to the worker from the hold (KES)" inputMode="numeric" value={cancelFee} onChange={(e) => setCancelFee(e.target.value.replace(/\D/g, ""))} />}
              <Input label="Reason (sent to the client)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
              <Button variant="danger" block loading={busy === "cancel"} onClick={() => void run("cancel", () => adminApi.post(`/jobs/${id}/cancel`, { workerFee: Number(cancelFee || 0), note }).then(reload), "Cancelled and refunded")}>
                Cancel and refund
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="stack g-8">
      <div className="section-title">{title}</div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, k) => (
                  <td key={k} className={k === 0 ? "small nowrap" : "small"}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Disputes() {
  const [status, setStatus] = useState("OPEN");
  const nav = useNavigate();
  const { data } = useAdmin<{ disputes: Row[] }>(`/disputes?status=${status}`);
  return (
    <div className="stack g-16">
      <Head title="Disputes">
        <Tabs value={status} onChange={setStatus} options={[["OPEN", "Open"], ["RESOLVED", "Resolved"]]} />
      </Head>
      <p className="small muted">Target: a decision within 3 business days. Escrow stays frozen until then.</p>
      {!data ? (
        <Loading />
      ) : !data.disputes.length ? (
        <Notice tone="ok">No {status === "OPEN" ? "open " : ""}disputes.</Notice>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Job</th>
                <th>Reason</th>
                <th>Client · Worker</th>
                <th className="num">Held</th>
                <th>Raised</th>
                {status === "RESOLVED" && <th>Decision</th>}
              </tr>
            </thead>
            <tbody>
              {data.disputes.map((d) => {
                const ageDays = (Date.now() - new Date(d.created_at).getTime()) / 86_400_000;
                return (
                  <tr key={d.id} className="click" onClick={() => nav(`/admin/jobs/${d.job_id}`)}>
                    <td>
                      <div className="strong">{d.ref}</div>
                      <div className="tiny muted">{d.service_name}</div>
                    </td>
                    <td>
                      <div>{d.reason}</div>
                      <div className="tiny muted">{String(d.details).slice(0, 120)}</div>
                    </td>
                    <td className="small">
                      {d.client_name} · {d.worker_name}
                    </td>
                    <td className="num">{kes(d.paid_kes)}</td>
                    <td className="small">
                      {dateTime(d.created_at)}
                      {status === "OPEN" && ageDays > 3 && <div className="red tiny strong">Over 3 days</div>}
                    </td>
                    {status === "RESOLVED" && (
                      <td className="small">
                        {d.decision} · {d.note}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Reports() {
  const [status, setStatus] = useState("OPEN");
  const { data, reload } = useAdmin<{ reports: Row[] }>(`/reports?status=${status}`);
  const { busy, run } = useRun();
  const [notes, setNotes] = useState<Record<string, string>>({});
  return (
    <div className="stack g-16">
      <Head title="Safety reports">
        <Tabs value={status} onChange={setStatus} options={[["OPEN", "Open"], ["CLOSED", "Closed"], ["ALL", "All"]]} />
      </Head>
      {!data ? (
        <Loading />
      ) : !data.reports.length ? (
        <Notice tone="ok">No reports.</Notice>
      ) : (
        <div className="stack g-10">
          {data.reports.map((r) => (
            <div key={r.id} className="card stack g-8" style={r.kind === "emergency" && r.status !== "CLOSED" ? { borderColor: "var(--red)", boxShadow: "inset 0 0 0 1px var(--red)" } : undefined}>
              <div className="row between g-8 wrap">
                <span className="row g-8">
                  <Badge tone={r.kind === "emergency" ? "red" : "amber"}>{r.kind === "emergency" ? "Emergency" : "Problem"}</Badge>
                  <span className="strong">{r.category}</span>
                  {r.ref && (
                    <Link className="link small" to={`/admin/jobs/${r.job_id}`}>
                      {r.ref}
                    </Link>
                  )}
                </span>
                <span className="small muted">
                  {dateTime(r.created_at)} · {r.status.toLowerCase()}
                </span>
              </div>
              <div className="small">
                <b>{r.full_name}</b> ({r.reporter_role}) · <a href={`tel:${r.phone}`}>{prettyPhone(r.phone)}</a>
                {r.emergency_phone && (
                  <>
                    {" "}
                    · emergency contact {r.emergency_name} <a href={`tel:${r.emergency_phone}`}>{prettyPhone(r.emergency_phone)}</a>
                    {r.contact_alerted ? " (texted)" : ""}
                  </>
                )}
              </div>
              {r.message && <p>{r.message}</p>}
              {r.lat != null && (
                <a className="link small" href={`https://maps.google.com/?q=${r.lat},${r.lng}`} target="_blank" rel="noreferrer">
                  Open location
                </a>
              )}
              {r.admin_note && <p className="small muted">Note: {r.admin_note}</p>}
              {r.status !== "CLOSED" && (
                <div className="row g-8 wrap">
                  <div className="grow" style={{ minWidth: 200 }}>
                    <Input placeholder="Note" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                  </div>
                  {r.status === "OPEN" && (
                    <Button size="sm" loading={busy === `ack-${r.id}`} onClick={() => void run(`ack-${r.id}`, () => adminApi.post(`/reports/${r.id}`, { status: "ACKNOWLEDGED", note: notes[r.id] ?? "" }).then(reload))}>
                      Acknowledge
                    </Button>
                  )}
                  <Button size="sm" variant="ink" loading={busy === `close-${r.id}`} onClick={() => void run(`close-${r.id}`, () => adminApi.post(`/reports/${r.id}`, { status: "CLOSED", note: notes[r.id] ?? "" }).then(reload))}>
                    Close
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ——— Money ———

export function Payments() {
  const [status, setStatus] = useState("");
  const { data, reload } = useAdmin<{ payments: Row[] }>(`/payments?status=${status}`);
  const { busy, run } = useRun();
  return (
    <div className="stack g-16">
      <Head title="Payments in">
        <Button size="sm" icon={<RefreshCw />} loading={busy === "rec"} onClick={() => void run("rec", () => adminApi.post("/payments/reconcile").then(reload), "Checked pending prompts with M-Pesa")}>
          Check pending
        </Button>
        <Button size="sm" icon={<Download />} onClick={() => void download(`/payments?format=csv&status=${status}`, "mjengo-payments.csv")}>
          CSV
        </Button>
      </Head>
      <Tabs value={status} onChange={setStatus} options={[["", "All"], ["SUCCESS", "Paid"], ["PENDING", "Pending"], ["FAILED", "Failed"]]} />
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Job</th>
                <th>What</th>
                <th>Client</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td className="small nowrap">{dateTime(p.created_at)}</td>
                  <td>
                    <Link className="link" to={`/admin/jobs/${p.job_id}`}>
                      {p.ref}
                    </Link>
                  </td>
                  <td className="small">{p.purpose === "JOB_HOLD" ? "Booking hold" : p.purpose === "JOB_EXTRA" ? "Extra" : "Tip"}</td>
                  <td className="small">
                    {p.full_name}
                    <div className="tiny muted">{prettyPhone(p.phone)}</div>
                  </td>
                  <td className="num">{kes(p.amount_kes)}</td>
                  <td>
                    <Badge tone={p.status === "SUCCESS" ? "green" : p.status === "PENDING" ? "amber" : ""}>{p.status.toLowerCase()}</Badge>
                    {p.status === "FAILED" && <div className="tiny muted">{p.result_desc}</div>}
                    {p.meta?.refund_needed && <div className="tiny red">Needs refund</div>}
                  </td>
                  <td className="mono">{p.mpesa_receipt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Payouts() {
  const [status, setStatus] = useState("OPEN");
  const { data, reload } = useAdmin<{ payouts: Row[]; driver: string | null }>(`/payouts?status=${status}`);
  const { busy, run } = useRun();
  const [refs, setRefs] = useState<Record<string, string>>({});
  return (
    <div className="stack g-16">
      <Head title="Money out">
        <Tabs value={status} onChange={setStatus} options={[["OPEN", "To send"], ["PAID", "Paid"], ["", "All"]]} />
      </Head>
      <p className="small muted">
        Worker payouts, tips and client refunds. {data?.driver ? `M-Pesa B2C: ${data.driver}.` : "M-Pesa B2C isn't set up, so pay by hand and record the reference."} Bank payouts are always sent by hand.
      </p>
      {!data ? (
        <Loading />
      ) : !data.payouts.length ? (
        <Notice tone="ok">Nothing waiting.</Notice>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Job</th>
                <th>Kind</th>
                <th>To</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.payouts.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link className="link" to={`/admin/jobs/${p.job_id}`}>
                      {p.ref}
                    </Link>
                  </td>
                  <td className="small">{p.kind === "WORKER" ? "Worker share" : p.kind === "TIP" ? "Tip" : "Refund"}</td>
                  <td className="small">
                    {p.full_name}
                    <div className="tiny muted">{p.method === "bank" ? `${p.bank?.name ?? ""} · ${p.bank?.accountName ?? ""} · ${p.bank?.accountNumber ?? ""}` : prettyPhone(p.phone)}</div>
                  </td>
                  <td className="num">{kes(p.amount_kes)}</td>
                  <td className="small">
                    <Badge tone={p.status === "PAID" ? "green" : p.status === "FAILED" ? "red" : "amber"}>{p.status.toLowerCase()}</Badge>
                    {p.last_error && <div className="tiny muted">{p.last_error}</div>}
                    {p.reference && <div className="mono">{p.reference}</div>}
                  </td>
                  <td>
                    {["QUEUED", "FAILED"].includes(p.status) && (
                      <div className="row g-6">
                        {p.method === "mpesa" && data.driver && (
                          <Button size="sm" loading={busy === `send-${p.id}`} onClick={() => void run(`send-${p.id}`, () => adminApi.post(`/payouts/${p.id}/send`).then(reload), "Sent to M-Pesa")}>
                            Send
                          </Button>
                        )}
                        <input className="input" style={{ minHeight: 34, height: 34, width: 130, fontSize: 13 }} placeholder="Reference" value={refs[p.id] ?? ""} onChange={(e) => setRefs({ ...refs, [p.id]: e.target.value })} />
                        <Button size="sm" variant="ink" loading={busy === `paid-${p.id}`} onClick={() => void run(`paid-${p.id}`, () => adminApi.post(`/payouts/${p.id}/mark-paid`, { reference: refs[p.id] ?? "" }).then(reload), "Recorded and the person was texted")}>
                          Mark paid
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ——— Rates ———

type Pricing = "flat" | "hourly" | "shift" | "per_unit";
type Svc = {
  id: string;
  name: string;
  description: string;
  pricing: Pricing;
  rate: number;
  unit: string;
  unitPhrase: string;
  minQty: number;
  shiftHours: number;
  overtimeRate: number | null;
  zone: "nairobi" | "outside";
  active: boolean;
  sort: number;
};
type Cat = { id: string; name: string; trade: string; blurb: string; section: string; requiresCertificate: boolean; active: boolean; services: Svc[] };

const PRICING: [Pricing, string][] = [
  ["flat", "Per task or visit"],
  ["hourly", "Per hour"],
  ["shift", "Per shift"],
  ["per_unit", "Per unit (e.g. foot)"],
];

export function Rates() {
  const { data, setData } = useAdmin<{ categories: Cat[] }>("/catalog");
  const { busy, run } = useRun();
  if (!data) return <Loading />;
  const saveSvc = (catId: string, s: Partial<Svc> & { id?: string }) =>
    run(
      `svc-${s.id ?? catId}`,
      async () => {
        const body = {
          categoryId: catId,
          name: s.name,
          description: s.description ?? "",
          pricing: s.pricing,
          rate: Number(s.rate),
          unit: s.unit ?? "",
          minQty: Number(s.minQty ?? 1),
          shiftHours: Number(s.shiftHours ?? 8),
          overtimeRate: s.overtimeRate ? Number(s.overtimeRate) : null,
          zone: s.zone ?? "nairobi",
          active: s.active ?? true,
          sort: s.sort ?? 50,
        };
        const r = s.id ? await adminApi.put(`/services/${s.id}`, body) : await adminApi.post("/services", body);
        setData(r.data);
      },
      "Saved. New bookings use the new rate.",
    );
  return (
    <div className="stack g-20">
      <Head title="Trades and rates" />
      <Notice>
        Rates follow the construction and site labour rate schedule. They're copied onto each job when it's booked, so changes apply to new bookings only. Shifts are 8 hours; hours beyond a shift bill at its overtime rate where one is set. Site visits
        can have a Nairobi and an out-of-station rate. Contractor overhead and engineering review fees aren't part of the schedule.
      </Notice>
      {data.categories.map((c) => (
        <CategoryCard
          key={c.id}
          cat={c}
          busy={busy}
          onSaveCat={(b) => run(`cat-${c.id}`, async () => setData((await adminApi.put(`/categories/${c.id}`, b)).data), "Saved")}
          onSaveSvc={(s) => saveSvc(c.id, s)}
        />
      ))}
    </div>
  );
}

function CategoryCard({ cat, busy, onSaveCat, onSaveSvc }: { cat: Cat; busy: string; onSaveCat: (b: Omit<Cat, "id" | "services">) => Promise<boolean>; onSaveSvc: (s: Partial<Svc>) => Promise<boolean> }) {
  const [c, setC] = useState({ name: cat.name, trade: cat.trade, blurb: cat.blurb, section: cat.section, requiresCertificate: cat.requiresCertificate, active: cat.active });
  const [adding, setAdding] = useState(false);
  const live = cat.services.filter((s) => s.active);
  const off = cat.services.filter((s) => !s.active);
  return (
    <div className="card stack g-14">
      <div className="row g-10 wrap">
        <div style={{ width: 200 }}>
          <Input label="Trade" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </div>
        <div style={{ width: 160 }}>
          <Input label="Worker title (in SMS)" value={c.trade} onChange={(e) => setC({ ...c, trade: e.target.value })} />
        </div>
        <div style={{ width: 240 }}>
          <Input label="Section on the home page" value={c.section} onChange={(e) => setC({ ...c, section: e.target.value })} />
        </div>
        <div className="grow" style={{ minWidth: 220 }}>
          <Input label="Short description" value={c.blurb} onChange={(e) => setC({ ...c, blurb: e.target.value })} />
        </div>
      </div>
      <div className="row g-16 wrap">
        <label className="check">
          <input type="checkbox" checked={c.requiresCertificate} onChange={(e) => setC({ ...c, requiresCertificate: e.target.checked })} /> Certificate required to apply
        </label>
        <label className="check">
          <input type="checkbox" checked={c.active} onChange={(e) => setC({ ...c, active: e.target.checked })} /> Bookable
        </label>
        <Button size="sm" loading={busy === `cat-${cat.id}`} onClick={() => void onSaveCat(c)}>
          Save trade
        </Button>
      </div>
      <div className="stack g-8">
        {live.map((s) => (
          <ServiceRow key={s.id} svc={s} busy={busy === `svc-${s.id}`} onSave={onSaveSvc} />
        ))}
        {adding ? (
          <ServiceRow
            svc={{ name: "", description: "", pricing: "flat", rate: 1000, unit: "task", minQty: 1, shiftHours: 8, overtimeRate: null, zone: "nairobi", active: true, sort: live.length + 1 }}
            busy={busy === `svc-${cat.id}`}
            onSave={async (s) => (await onSaveSvc(s)) && (setAdding(false), true)}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)} style={{ alignSelf: "flex-start" }}>
            + Add a service
          </Button>
        )}
        {off.length > 0 && (
          <details>
            <summary className="small muted" style={{ cursor: "pointer" }}>
              Switched off ({off.length}): kept for past jobs
            </summary>
            <div className="stack g-8 mt-8">
              {off.map((s) => (
                <ServiceRow key={s.id} svc={s} busy={busy === `svc-${s.id}`} onSave={onSaveSvc} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function ServiceRow({ svc, busy, onSave }: { svc: Partial<Svc>; busy: boolean; onSave: (s: Partial<Svc>) => Promise<boolean> }) {
  const [s, setS] = useState(svc);
  const num = (v: string) => Number(v.replace(/[^\d.]/g, ""));
  return (
    <div className="row g-8 wrap" style={{ alignItems: "flex-end", paddingTop: 8, borderTop: "1px solid var(--line)" }}>
      <div className="grow" style={{ minWidth: 220 }}>
        <Input label="Service" value={s.name ?? ""} onChange={(e) => setS({ ...s, name: e.target.value })} />
      </div>
      <div style={{ width: 160 }}>
        <Select label="Billed" value={s.pricing} onChange={(e) => setS({ ...s, pricing: e.target.value as Pricing })}>
          {PRICING.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </div>
      <div style={{ width: 110 }}>
        <Input label="Rate (KES)" inputMode="numeric" value={String(s.rate ?? "")} onChange={(e) => setS({ ...s, rate: num(e.target.value) })} />
      </div>
      {(s.pricing === "flat" || s.pricing === "per_unit") && (
        <div style={{ width: 100 }}>
          <Input label="Per" placeholder={s.pricing === "flat" ? "task" : "ft"} value={s.unit ?? ""} onChange={(e) => setS({ ...s, unit: e.target.value.trim().slice(0, 20) })} />
        </div>
      )}
      {(s.pricing === "hourly" || s.pricing === "per_unit") && (
        <div style={{ width: 100 }}>
          <Input label={s.pricing === "hourly" ? "Min hours" : "Min units"} inputMode="decimal" value={String(s.minQty ?? 1)} onChange={(e) => setS({ ...s, minQty: num(e.target.value) || 1 })} />
        </div>
      )}
      {s.pricing === "shift" && (
        <>
          <div style={{ width: 100 }}>
            <Input label="Shift hours" inputMode="decimal" value={String(s.shiftHours ?? 8)} onChange={(e) => setS({ ...s, shiftHours: num(e.target.value) || 8 })} />
          </div>
          <div style={{ width: 130 }}>
            <Input label="Overtime per hour" inputMode="numeric" placeholder="None" value={s.overtimeRate ? String(s.overtimeRate) : ""} onChange={(e) => setS({ ...s, overtimeRate: num(e.target.value) || null })} />
          </div>
        </>
      )}
      <div style={{ width: 150 }}>
        <Select label="Where" value={s.zone ?? "nairobi"} onChange={(e) => setS({ ...s, zone: e.target.value as "nairobi" | "outside" })}>
          <option value="nairobi">Nairobi area</option>
          <option value="outside">Outside Nairobi</option>
        </Select>
      </div>
      <div className="grow" style={{ minWidth: 240 }}>
        <Input label="Description" value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value })} />
      </div>
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={s.active ?? true} onChange={(e) => setS({ ...s, active: e.target.checked })} /> On
      </label>
      <Button size="sm" variant="ink" loading={busy} onClick={() => void onSave(s)} style={{ marginBottom: 6 }}>
        Save
      </Button>
    </div>
  );
}

// ——— Settings ———

const GROUPS: { title: string; fields: [string, string, string?][] }[] = [
  { title: "Fees", fields: [["client_fee_pct", "Client fee (%)", "Added to the job price"], ["worker_fee_pct", "Worker fee (%)", "Deducted before payout"]] },
  {
    title: "Cancellation and call-out fees (paid to the worker)",
    fields: [
      ["late_cancel_fee_kes", "After acceptance, past the free window (KES)"],
      ["free_cancel_minutes", "Free cancellation window after booking (min)"],
      ["enroute_cancel_fee_kes", "After the worker is on the way (KES)"],
      ["callout_fee_kes", "Client no-show call-out fee (KES)"],
    ],
  },
  {
    title: "Dispatch and timing",
    fields: [
      ["offer_window_seconds", "Time to accept an offer (s)"],
      ["dispatch_timeout_minutes", "Give up and alert the team after (min)"],
      ["schedule_lead_minutes", "Start dispatching scheduled jobs before (min)"],
      ["no_show_grace_minutes", "Worker late after ETA by (min)"],
      ["client_wait_minutes", "Worker waits for client (min)"],
      ["location_stale_seconds", "Location unavailable after (s)"],
      ["service_radius_km", "Service area from Nairobi CBD (km)"],
    ],
  },
  {
    title: "Escrow and quality",
    fields: [
      ["auto_release_hours", "Auto-release escrow after (h)"],
      ["dispute_window_hours", "Disputes allowed within (h)"],
      ["probation_jobs", "Probation: first N jobs reviewed"],
      ["suspend_below_rating", "Suspend when average falls below"],
      ["suspend_after_ratings", "…over the last N ratings"],
      ["cancel_flag_threshold", "Flag after N worker cancellations in 30 days"],
    ],
  },
];

export function SettingsPage({ me }: { me: AdminMe }) {
  const { data, setData } = useAdmin<{ settings: Row; defaults: Row; sms: { connected: boolean; balance: string | null } }>("/settings");
  const { busy, run } = useRun();
  const [v, setV] = useState<Row>({});
  useEffect(() => {
    if (data) setV(data.settings);
  }, [data]);
  if (!data) return <Loading />;
  const editable = me.role === "owner" || me.role === "admin";
  const save = () =>
    void run(
      "save",
      async () => {
        const body: Row = {};
        for (const g of GROUPS) for (const [k] of g.fields) body[k] = Number(v[k]);
        body.support_phone = v.support_phone ?? "";
        body.support_email = v.support_email ?? "";
        body.alert_phones = v.alert_phones ?? "";
        const r = await adminApi.put("/settings", body);
        setData({ ...data, settings: r.data.settings });
      },
      "Saved",
    );
  return (
    <div className="stack g-20">
      <Head title="Fees and policies">{editable && <Button variant="primary" loading={busy === "save"} onClick={save}>Save changes</Button>}</Head>
      <p className="small muted">Starting values come from the PRD (sections 4 and 6). Changes apply immediately to new bookings and timers. Booked jobs keep the fee percentages they were booked with.</p>
      {GROUPS.map((g) => (
        <div key={g.title} className="card stack g-12">
          <div className="strong">{g.title}</div>
          <div className="tiles">
            {g.fields.map(([k, label, hint]) => (
              <Input key={k} label={label} hint={hint ?? `Default ${data.defaults[k]}`} inputMode="decimal" disabled={!editable} value={String(v[k] ?? "")} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/[^\d.]/g, "") })} />
            ))}
          </div>
        </div>
      ))}
      <div className="card stack g-12">
        <div className="strong">Contacts</div>
        <div className="tiles">
          <Input label="Support phone (shown in the app)" disabled={!editable} value={v.support_phone ?? ""} onChange={(e) => setV({ ...v, support_phone: e.target.value })} />
          <Input label="Support email" disabled={!editable} value={v.support_email ?? ""} onChange={(e) => setV({ ...v, support_email: e.target.value })} />
          <Input label="Alert numbers (comma-separated)" hint="Texted for emergencies and jobs nobody accepted" disabled={!editable} value={v.alert_phones ?? ""} onChange={(e) => setV({ ...v, alert_phones: e.target.value })} />
        </div>
      </div>
      <div className="card stack g-8">
        <div className="strong">SMS</div>
        <p className="small">{data.sms.connected ? `Celcom Africa connected${data.sms.balance ? ` · balance ${data.sms.balance}` : ""}.` : "Not connected. Set CELCOM_API_KEY, CELCOM_PARTNER_ID and CELCOM_SHORTCODE on the server."}</p>
      </div>
    </div>
  );
}

// ——— People, SMS, team, audit ———

export function UsersPage() {
  const [q, setQ] = useState("");
  const { data, reload } = useAdmin<{ users: Row[] }>(`/users?q=${encodeURIComponent(q)}`);
  const { busy, run } = useRun();
  return (
    <div className="stack g-16">
      <Head title="People">
        <div style={{ width: 280 }}>
          <Input placeholder="Search name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Head>
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Role</th>
                <th className="num">Bookings</th>
                <th>Joined</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.worker_status ? (
                      <Link className="link" to={`/admin/workers/${u.id}`}>
                        {u.full_name || "—"}
                      </Link>
                    ) : (
                      u.full_name || "—"
                    )}
                    {u.email && <div className="tiny muted">{u.email}</div>}
                  </td>
                  <td className="small">{prettyPhone(u.phone)}</td>
                  <td className="small">{u.worker_status ? `Worker (${u.worker_status})` : "Client"}</td>
                  <td className="num">{u.bookings}</td>
                  <td className="small muted">{dateTime(u.created_at)}</td>
                  <td>
                    <Button
                      size="sm"
                      variant={u.status === "active" ? "danger" : "outline"}
                      loading={busy === u.id}
                      onClick={() => {
                        const reason = window.prompt(u.status === "active" ? "Reason for suspending this account" : "Reason for reactivating");
                        if (reason) void run(u.id, () => adminApi.post(`/users/${u.id}/status`, { status: u.status === "active" ? "suspended" : "active", reason }).then(reload), "Updated");
                      }}
                    >
                      {u.status === "active" ? "Suspend" : "Reactivate"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Sms() {
  const { data } = useAdmin<{ messages: Row[]; connected: boolean }>("/sms");
  return (
    <div className="stack g-16">
      <Head title="SMS log" />
      {data && !data.connected && <Notice tone="warn">SMS isn't connected: these messages were written to the server log, not sent.</Notice>}
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Kind</th>
                <th>Message</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.messages.map((m) => (
                <tr key={m.id}>
                  <td className="small nowrap">{dateTime(m.created_at)}</td>
                  <td className="small nowrap">{prettyPhone(m.to_phone)}</td>
                  <td className="small">{m.purpose}</td>
                  <td className="small">{m.body}</td>
                  <td className="small">
                    <Badge tone={m.status === "SENT" ? "green" : m.status === "FAILED" ? "red" : ""}>{m.status.toLowerCase()}</Badge>
                    {m.attempts > 1 && <div className="tiny muted">{m.attempts} tries</div>}
                    {m.last_error && <div className="tiny red">{m.last_error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Team({ me }: { me: AdminMe }) {
  const { data, reload } = useAdmin<{ admins: Row[] }>(me.role === "owner" ? "/team" : null);
  const { busy, run } = useRun();
  const [f, setF] = useState({ name: "", email: "", role: "ops", password: "" });
  if (me.role !== "owner") return <Notice>Only the owner manages the team.</Notice>;
  if (!data) return <Loading />;
  return (
    <div className="stack g-20">
      <Head title="Team" />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Authenticator</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.admins.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name}
                  <div className="tiny muted">{a.email}</div>
                </td>
                <td>
                  {a.role === "owner" || a.id === me.id ? (
                    a.role
                  ) : (
                    <select className="select" style={{ minHeight: 34, width: 120 }} value={a.role} onChange={(e) => void run(`r-${a.id}`, () => adminApi.put(`/team/${a.id}`, { role: e.target.value }).then(reload), "Role changed")}>
                      <option value="admin">admin</option>
                      <option value="ops">ops</option>
                      <option value="finance">finance</option>
                    </select>
                  )}
                </td>
                <td className="small">{a.totp_enabled ? "Set up" : "Not yet"}</td>
                <td className="small muted">{a.last_login_at ? dateTime(a.last_login_at) : "—"}</td>
                <td>
                  {a.role !== "owner" && a.id !== me.id && (
                    <div className="row g-6">
                      <Button size="sm" loading={busy === `t-${a.id}`} onClick={() => void run(`t-${a.id}`, () => adminApi.put(`/team/${a.id}`, { resetAuthenticator: true }).then(reload), "They'll set up the authenticator again")}>
                        Reset authenticator
                      </Button>
                      <Button size="sm" variant="danger" loading={busy === `x-${a.id}`} onClick={() => window.confirm(`Remove ${a.name}?`) && void run(`x-${a.id}`, () => adminApi.put(`/team/${a.id}`, { remove: true }).then(reload), "Removed")}>
                        Remove
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card stack g-12" style={{ maxWidth: 520 }}>
        <div className="strong">Add a team member</div>
        <p className="small muted">ops: workers, jobs, disputes and reports. finance: payments and payouts. admin: everything except the team.</p>
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Select label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="ops">ops</option>
          <option value="finance">finance</option>
          <option value="admin">admin</option>
        </Select>
        <Input label="Temporary password" type="password" hint="At least 12 characters. They set up their authenticator on first sign-in." value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <Button variant="primary" loading={busy === "add"} onClick={() => void run("add", () => adminApi.post("/team", f).then(() => (setF({ name: "", email: "", role: "ops", password: "" }), reload())), "Added")}>
          Add
        </Button>
      </div>
    </div>
  );
}

export function Audit() {
  const { data } = useAdmin<{ entries: Row[] }>("/audit");
  return (
    <div className="stack g-16">
      <Head title="Audit log" />
      <p className="small muted">Every admin action. Status changes and payments on each job are in that job's timeline.</p>
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="small nowrap">{dateTime(e.created_at)}</td>
                  <td className="small">{e.admin_name ?? "—"}</td>
                  <td className="small">{e.action}</td>
                  <td className="small">
                    {e.target_type === "job" ? (
                      <Link className="link" to={`/admin/jobs/${e.target_id}`}>
                        job
                      </Link>
                    ) : e.target_type === "worker" ? (
                      <Link className="link" to={`/admin/workers/${e.target_id}`}>
                        worker
                      </Link>
                    ) : (
                      e.target_type ?? ""
                    )}
                  </td>
                  <td className="mono">{Object.keys(e.detail ?? {}).length ? JSON.stringify(e.detail) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export const statusLabel = (s: JobStatus) => STATUS_LABEL[s];
