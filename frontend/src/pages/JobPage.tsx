import { BadgeCheck, CalendarClock, ChevronLeft, Clock, FileText, MapPin, Phone, Receipt, ShieldAlert, Star, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorMessage, invalidate, setCached, useApi } from "../api/client";
import { MapView } from "../components/MapView";
import { PaymentSheet } from "../components/PaymentSheet";
import { PhotoPicker } from "../components/PhotoPicker";
import { ReportProblem } from "../components/ReportProblem";
import { Avatar, Badge, Button, Input, Notice, Segmented, Select, Sheet, Skeleton, StarInput, Stars, StatusBadge, Textarea } from "../components/ui";
import { onLive, useAuth, useConfig } from "../context/AuthContext";
import { useToast } from "../context/toast";
import { ACTIVE, ago, dateTime, kes, mmss, time, unitWord, when } from "../lib/format";
import type { CancelQuote, ClientJob, Extra, Started } from "../types";

// Views 3 and 4: the live job. A map on the top half; below it the worker, the status
// timeline, any extra-work request, Report a problem, and at the end the invoice with
// Approve or Dispute before escrow releases.

const STEPS = [
  { key: "EN_ROUTE", label: "En route", at: (j: ClientJob) => j.enRouteAt },
  { key: "ON_SITE", label: "On site", at: (j: ClientJob) => j.onSiteAt },
  { key: "IN_PROGRESS", label: "In progress", at: (j: ClientJob) => j.startedAt },
  { key: "COMPLETED", label: "Done", at: (j: ClientJob) => j.completedAt },
] as const;
const ORDER = ["ACCEPTED", "EN_ROUTE", "ON_SITE", "IN_PROGRESS", "COMPLETED"];

export function StatusTimeline({ job }: { job: ClientJob }) {
  const cur = ORDER.indexOf(job.status === "DISPUTED" || job.status === "CLOSED" ? "COMPLETED" : job.status);
  return (
    <div className="timeline" aria-label="Job progress">
      {STEPS.map((s) => {
        const idx = ORDER.indexOf(s.key);
        const at = s.at(job);
        const state = idx < cur || (idx === cur && at) ? "done" : idx === cur + 1 && cur >= 0 && job.status !== "COMPLETED" ? "now" : "";
        return (
          <div key={s.key} className={`tl-step ${state}`}>
            <div className="tl-bar" />
            <span>{s.label}</span>
            <span className="tl-time">{at ? time(at) : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function JobPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const cfg = useConfig();
  const { refresh: refreshMe } = useAuth();
  const key = `/jobs/${id}`;
  const { data, error, reload } = useApi<{ job: ClientJob }>(key, { staleMs: 4_000 });
  const job = data?.job;
  const [now, setNow] = useState(Date.now());
  const [pay, setPay] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [extraPay, setExtraPay] = useState<Extra | null>(null);
  const [tipPay, setTipPay] = useState(0);

  const refresh = useCallback(() => {
    void reload();
    void refreshMe();
  }, [reload, refreshMe]);

  // Live: job changes and the worker's position; polling covers a dropped stream.
  useEffect(() => {
    const offJob = onLive("job", (d: { id: string }) => d.id === id && void reload());
    const offLoc = onLive("location", (d: { jobId: string; lat: number; lng: number; accuracy: number | null; at: string }) => {
      if (d.jobId !== id) return;
      setCached<{ job: ClientJob }>(key, (prev) => (prev ? { job: { ...prev.job, location: { lat: d.lat, lng: d.lng, at: d.at, accuracy: d.accuracy, stale: false } } } : prev));
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      offJob();
      offLoc();
      clearInterval(t);
    };
  }, [id, key, reload]);
  useEffect(() => {
    if (!job || ["CLOSED", "CANCELLED", "EXPIRED"].includes(job.status)) return;
    const p = setInterval(() => void reload(), 12_000);
    return () => clearInterval(p);
  }, [job?.status, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !job)
    return (
      <div className="stack g-12" style={{ padding: 16 }}>
        <Notice tone="error">{errorMessage(error)}</Notice>
        <Button onClick={() => void reload()}>Try again</Button>
      </div>
    );
  if (!job) return <div style={{ padding: 16 }}><Skeleton h={320} /></div>;

  // A position older than the limit shows as "Location unavailable" with the last known spot.
  const staleMs = (cfg?.policy.locationStaleSeconds ?? 120) * 1000;
  const loc = job.location ? { ...job.location, stale: job.location.stale || now - new Date(job.location.at).getTime() > staleMs } : null;
  const trade = job.worker?.trade ?? "worker";
  const pendingExtra = job.extras.find((x) => x.status === "PENDING" || x.status === "AWAITING_PAYMENT");
  const searchingFor = job.confirmedAt && job.status === "SEARCHING" ? now - new Date(job.timeline.filter((e) => e.kind === "status.searching").at(-1)?.at ?? job.confirmedAt).getTime() : 0;

  return (
    <div className="track">
      <div className="track-map">
        <button className="icon-btn" aria-label="Back" onClick={() => nav("/jobs")} style={{ position: "absolute", top: 12, left: 12, zIndex: 500, background: "#fff", boxShadow: "var(--shadow)" }}>
          <ChevronLeft />
        </button>
        {loc?.stale && (
          <div className="loc-stale">
            <TriangleAlert /> Location unavailable · last seen {ago(loc.at)}
          </div>
        )}
        <MapView job={job} worker={loc} />
      </div>

      <div className="track-sheet stack g-20">
        <div className="sheet-grip" />
        <div className="status-head">
          <div className="row between g-8">
            <span className="small muted">
              {job.ref} · {job.service.name}
            </span>
            <StatusBadge status={job.status} />
          </div>
          <h2>{headline(job, trade, now)}</h2>
          {sub(job, cfg?.policy.dispatchTimeoutMinutes ?? 10, searchingFor) && <p className="muted small">{sub(job, cfg?.policy.dispatchTimeoutMinutes ?? 10, searchingFor)}</p>}
        </div>

        {job.status === "PENDING_PAYMENT" && (
          <div className="stack g-10">
            <Notice tone="warn">Your booking isn't confirmed until the M-Pesa payment of {kes(job.price.total)} goes through. It's held until you approve the work.</Notice>
            <Button variant="primary" size="lg" block onClick={() => setPay(true)}>
              Pay {kes(job.price.total)} with M-Pesa
            </Button>
          </div>
        )}

        {job.status === "SEARCHING" && (
          <div className="searching">
            <span className="radar" />
            <div className="stack g-4">
              <span className="strong">Offering your job to the nearest {trade}s</span>
              <span className="small muted">Each has {Math.round((cfg?.policy.offerWindowSeconds ?? 120) / 60)} minutes to accept · {mmss(searchingFor)} so far</span>
            </div>
          </div>
        )}

        {job.status === "UNASSIGNED" && (
          <div className="stack g-10">
            <Notice tone="warn">Nobody has accepted yet. You can try again now, pick another time, or cancel at no charge. Our team has been told and is also looking.</Notice>
            <div className="row g-8">
              <Button variant="primary" block icon={<CalendarClock />} onClick={() => setRescheduleOpen(true)}>
                Reschedule
              </Button>
              <Button block onClick={() => setCancelOpen(true)}>
                Cancel free
              </Button>
            </div>
          </div>
        )}

        {job.workerLate && (
          <Notice tone="warn">
            {job.worker?.shortName ?? "Your worker"} hasn't arrived {cfg?.policy.noShowGraceMinutes ?? 30} minutes after the expected time. You can cancel at no charge, or keep waiting.
          </Notice>
        )}

        {job.worker && (ACTIVE.includes(job.status) || job.status === "COMPLETED") && (
          <div className="stack g-14">
            <div className="worker-card">
              <Avatar src={job.worker.photo} name={job.worker.name} size="lg" />
              <div className="grow stack g-4">
                <span className="strong" style={{ fontSize: 16 }}>
                  {job.worker.name}
                </span>
                <span className="row g-8 wrap small">
                  {job.worker.verified && (
                    <span className="verified">
                      <BadgeCheck /> Verified
                    </span>
                  )}
                  {job.worker.rating != null ? (
                    <span className="row g-4">
                      <Star size={14} fill="currentColor" /> {job.worker.rating.toFixed(1)} ({job.worker.ratings})
                    </span>
                  ) : (
                    <span className="muted">New on Mjengo</span>
                  )}
                  <span className="muted">{job.worker.jobs} jobs</span>
                </span>
              </div>
              {job.worker.phone && (
                <a className="btn btn-ink" href={`tel:${job.worker.phone}`} aria-label={`Call ${job.worker.shortName}`}>
                  <Phone /> Call
                </a>
              )}
            </div>
            {ACTIVE.includes(job.status) || job.status === "COMPLETED" ? <StatusTimeline job={job} /> : null}
          </div>
        )}

        {pendingExtra && (
          <div className="extra-banner">
            <div className="row between g-8">
              <span className="strong">Extra work requested</span>
              <Badge tone="amber">Needs your answer</Badge>
            </div>
            <div>
              {job.worker?.shortName} asks for{" "}
              {pendingExtra.kind === "hours"
                ? `${pendingExtra.hours} more hour${pendingExtra.hours === 1 ? "" : "s"}`
                : pendingExtra.kind === "units"
                  ? `${pendingExtra.units} more ${unitWord(job.service.unit, pendingExtra.units ?? 2)}`
                  : "materials"}
              : <b>{kes(pendingExtra.total)}</b>
              <span className="small muted"> ({kes(pendingExtra.amount)} + {kes(pendingExtra.fee)} fee)</span>
            </div>
            <div className="small">"{pendingExtra.reason}"</div>
            {pendingExtra.photo && <img src={pendingExtra.photo} alt="Why the extra is needed" />}
            {pendingExtra.status === "AWAITING_PAYMENT" ? (
              <Notice>Waiting for your M-Pesa payment. Work continues once it's paid.</Notice>
            ) : (
              <div className="row g-8">
                <Button variant="primary" block onClick={() => setExtraPay(pendingExtra)}>
                  Approve and pay
                </Button>
                <Button
                  block
                  onClick={async () => {
                    try {
                      await api.post(`/jobs/${job.id}/extras/${pendingExtra.id}`, { approve: false });
                      toast("Declined. The worker won't do or charge for it.", "ok");
                      refresh();
                    } catch (e) {
                      toast(errorMessage(e), "error");
                    }
                  }}
                >
                  Decline
                </Button>
              </div>
            )}
            <span className="tiny muted">Unanswered or declined extras are never charged.</span>
          </div>
        )}

        {job.status === "COMPLETED" && <Checkout job={job} onDispute={() => setDisputeOpen(true)} onTip={(n) => setTipPay(n)} onDone={refresh} />}

        {job.status === "DISPUTED" && job.dispute && (
          <Notice tone="warn" icon={<ShieldAlert />}>
            <b>Under review: {job.dispute.reason}.</b> Payment is frozen while our team looks at the photos and timeline. We aim to decide within 3 business days and will text you the decision.
          </Notice>
        )}

        {job.status === "CLOSED" && <Closed job={job} onTip={(n) => setTipPay(n)} onDone={refresh} />}

        {(job.status === "CANCELLED" || job.status === "EXPIRED") && (
          <Notice>
            {job.status === "EXPIRED"
              ? "This booking wasn't paid in time, so it was not confirmed."
              : `Cancelled ${job.cancelledAt ? dateTime(job.cancelledAt) : ""}${job.cancelledBy === "admin" ? " by our team" : ""}.`}
            {job.refund && ` ${kes(job.refund.amount)} refund ${job.refund.status === "PAID" ? `sent${job.refund.reference ? ` (${job.refund.reference})` : ""}` : "on its way to your M-Pesa"}.`}
          </Notice>
        )}

        {(ACTIVE.includes(job.status) || ["SEARCHING", "SCHEDULED", "UNASSIGNED", "COMPLETED"].includes(job.status)) && (
          <div className="stack g-8">
            {(ACTIVE.includes(job.status) || job.status === "COMPLETED") && <ReportProblem jobId={job.id} block />}
            {["SEARCHING", "SCHEDULED"].includes(job.status) && (
              <Button block icon={<CalendarClock />} onClick={() => setRescheduleOpen(true)}>
                Change the time
              </Button>
            )}
            {job.cancel.allowed && job.status !== "UNASSIGNED" && (
              <Button variant="ghost" block onClick={() => setCancelOpen(true)}>
                Cancel booking{job.cancel.fee === 0 ? " (free)" : ""}
              </Button>
            )}
          </div>
        )}

        <JobDetails job={job} />
      </div>

      <PaymentSheet
        open={pay}
        onClose={() => setPay(false)}
        title="Pay to confirm your booking"
        amount={job.price.total}
        start={(phone) => api.post<Started>(`/jobs/${job.id}/pay`, { phone }).then((r) => r.data)}
        onPaid={refresh}
        doneLabel="Track my booking"
      />
      {extraPay && (
        <PaymentSheet
          open={Boolean(extraPay)}
          onClose={() => {
            setExtraPay(null);
            refresh();
          }}
          title="Approve the extra"
          amount={extraPay.total}
          summary={<p className="small muted">"{extraPay.reason}" · {kes(extraPay.amount)} plus the {job.price.clientFeePct}% fee. Added to what's held until you approve the job.</p>}
          start={(phone) => api.post<{ payment: Started }>(`/jobs/${job.id}/extras/${extraPay.id}`, { approve: true, phone }).then((r) => r.data.payment)}
          onPaid={refresh}
        />
      )}
      {tipPay > 0 && (
        <PaymentSheet
          open={tipPay > 0}
          onClose={() => {
            setTipPay(0);
            refresh();
          }}
          title={`Tip ${job.worker?.shortName ?? "your worker"}`}
          amount={tipPay}
          summary={<p className="small muted">Tips go to the worker in full.</p>}
          start={(phone) => api.post<Started>(`/jobs/${job.id}/tip`, { amount: tipPay, phone }).then((r) => r.data)}
          onPaid={refresh}
          doneLabel="Thanks"
        />
      )}
      <CancelSheet open={cancelOpen} job={job} onClose={() => setCancelOpen(false)} onDone={refresh} />
      <RescheduleSheet open={rescheduleOpen} job={job} onClose={() => setRescheduleOpen(false)} onDone={refresh} />
      <DisputeSheet open={disputeOpen} job={job} onClose={() => setDisputeOpen(false)} onDone={refresh} />
    </div>
  );
}

function headline(j: ClientJob, trade: string, now: number): string {
  const name = j.worker?.shortName ?? `Your ${trade}`;
  switch (j.status) {
    case "PENDING_PAYMENT":
      return "Confirm your booking";
    case "SCHEDULED":
      return `Booked for ${when(j.scheduledFor!)}`;
    case "SEARCHING":
      return `Finding your ${trade === "worker" ? "worker" : trade}`;
    case "UNASSIGNED":
      return `No ${trade} has accepted yet`;
    case "ACCEPTED":
      return j.scheduledFor && new Date(j.scheduledFor).getTime() > now + 3_600_000 ? `${name} is booked for ${when(j.scheduledFor)}` : `${name} accepted your job`;
    case "EN_ROUTE": {
      const mins = j.etaAt ? Math.max(1, Math.round((new Date(j.etaAt).getTime() - now) / 60_000)) : j.etaMinutes;
      return mins != null ? `${name} arrives in about ${mins} min` : `${name} is on the way`;
    }
    case "ON_SITE":
      return `${name} has arrived`;
    case "IN_PROGRESS":
      return "Work in progress";
    case "COMPLETED":
      return "Job done: check and approve";
    case "DISPUTED":
      return "We're reviewing this job";
    case "CLOSED":
      return j.outcome === "client_no_show" ? "Closed: client not available" : j.outcome === "refunded" ? "Refunded" : "Job complete";
    case "CANCELLED":
      return "Booking cancelled";
    case "EXPIRED":
      return "Booking not confirmed";
  }
}

function sub(j: ClientJob, timeout: number, searchingMs: number): string | null {
  if (j.status === "SEARCHING") return `If nobody accepts within ${timeout} minutes we'll text you, and you can reschedule or cancel free.${searchingMs > timeout * 60_000 ? "" : ""}`;
  if (j.status === "SCHEDULED") return "We start looking for a worker before the time and text you when one accepts.";
  if (j.status === "EN_ROUTE" && j.etaAt) return `Expected around ${time(j.etaAt)}. Location updates live on the map.`;
  if (j.status === "ACCEPTED") return "Location appears on the map once they're on the way.";
  if (j.status === "COMPLETED" && j.autoReleaseAt) return `Approve or raise a problem by ${when(j.autoReleaseAt)}. After that, payment releases to the worker automatically.`;
  return null;
}

function Checkout({ job, onDispute, onTip, onDone }: { job: ClientJob; onDispute: () => void; onTip: (n: number) => void; onDone: () => void }) {
  const toast = useToast();
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState("");
  const [tip, setTip] = useState(0);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const inv = job.invoice;
  const approve = async () => {
    setBusy(true);
    try {
      await api.post(`/jobs/${job.id}/approve`, stars ? { stars, review } : {});
      toast("Approved. Payment is on its way to the worker.", "ok");
      const t = tip || Number(custom) || 0;
      if (t >= 10) onTip(t);
      onDone();
      void invalidate("/jobs");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack g-16">
      {inv && <InvoiceCard job={job} />}
      <div className="stack g-8">
        <div className="section-title">Rate {job.worker?.shortName}</div>
        <StarInput value={stars} onChange={setStars} />
        {stars > 0 && <Textarea placeholder="What went well, or what could be better?" value={review} onChange={(e) => setReview(e.target.value)} maxLength={1000} />}
      </div>
      <div className="stack g-8">
        <div className="section-title">Add a tip (optional)</div>
        <div className="chips">
          {[0, 100, 200, 500].map((t) => (
            <button
              key={t}
              type="button"
              className="chip"
              aria-pressed={tip === t && !custom}
              onClick={() => {
                setTip(t);
                setCustom("");
              }}
            >
              {t ? kes(t) : "No tip"}
            </button>
          ))}
          <input className="input" style={{ width: 120, minHeight: 36, height: 36, borderRadius: 999 }} inputMode="numeric" placeholder="Other" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, "").slice(0, 5))} aria-label="Other tip amount" />
        </div>
        <span className="tiny muted">Tips are paid by M-Pesa after you approve and go to the worker in full.</span>
      </div>
      <Button variant="primary" size="lg" block loading={busy} onClick={approve}>
        Approve and release payment
      </Button>
      <Button block icon={<ShieldAlert />} onClick={onDispute}>
        Something's wrong
      </Button>
    </div>
  );
}

function Closed({ job, onTip, onDone }: { job: ClientJob; onTip: (n: number) => void; onDone: () => void }) {
  const toast = useToast();
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState("");
  const [busy, setBusy] = useState(false);
  const rate = async () => {
    setBusy(true);
    try {
      await api.post(`/jobs/${job.id}/rate`, { stars, review });
      toast("Thanks for the rating", "ok");
      onDone();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack g-16">
      {job.outcome === "client_no_show" && <Notice>The worker waited at the site and couldn't start, so the call-out fee was paid to them and the rest refunded.</Notice>}
      {job.dispute?.decision && (
        <Notice>
          <b>Decision:</b> {job.dispute.decision === "RELEASE" ? "paid to the worker in full" : job.dispute.decision === "REFUND" ? "refunded to you in full" : "split between you and the worker"}. {job.dispute.note}
        </Notice>
      )}
      {job.invoice && <InvoiceCard job={job} />}
      {job.worker && job.outcome !== "client_no_show" && !job.myRating && (
        <div className="stack g-8">
          <div className="section-title">Rate {job.worker.shortName}</div>
          <StarInput value={stars} onChange={setStars} />
          {stars > 0 && (
            <>
              <Textarea placeholder="Optional review" value={review} onChange={(e) => setReview(e.target.value)} maxLength={1000} />
              <Button variant="ink" loading={busy} onClick={rate}>
                Send rating
              </Button>
            </>
          )}
        </div>
      )}
      {job.myRating && (
        <div className="row g-8 small">
          You rated <Stars value={job.myRating.stars} />
        </div>
      )}
      {job.worker && job.outcome === "done" && job.price.tip === 0 && (
        <div className="row g-8 wrap">
          <span className="small muted">Add a tip:</span>
          {[100, 200, 500].map((t) => (
            <button key={t} className="chip" onClick={() => onTip(t)}>
              {kes(t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function InvoiceCard({ job }: { job: ClientJob }) {
  const inv = job.invoice!;
  return (
    <div className="invoice">
      <div className="invoice-head">
        <div className="stack g-4">
          <span className="row g-6 strong">
            <Receipt size={16} /> Invoice {inv.number}
          </span>
          <span className="small muted">{inv.issuedAt ? dateTime(inv.issuedAt) : ""}</span>
        </div>
        {job.invoiceUrl && (
          <a className="btn btn-sm" style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,.35)" }} href={job.invoiceUrl.replace(/^https?:\/\/[^/]+/, "")} target="_blank" rel="noreferrer">
            <FileText /> Open
          </a>
        )}
      </div>
      <div className="invoice-body">
        {inv.lines.map((l, i) => (
          <div key={i} className="inv-line">
            <span className="stack">
              <span>{l.label}</span>
              {l.detail && <span className="tiny muted">{l.detail}</span>}
            </span>
            <span className="num">{kes(l.amount)}</span>
          </div>
        ))}
        <div className="kv">
          <span>Service fee ({inv.feePct}%)</span>
          <span className="num">{kes(inv.fee)}</span>
        </div>
        {inv.tip > 0 && (
          <div className="kv">
            <span>Tip</span>
            <span className="num">{kes(inv.tip)}</span>
          </div>
        )}
        <div className="kv total">
          <span>Total</span>
          <span className="num">{kes(inv.total)}</span>
        </div>
        {inv.refunded > 0 && (
          <div className="kv">
            <span>Refunded to you</span>
            <span className="num">−{kes(inv.refunded)}</span>
          </div>
        )}
        <div className="tiny muted mt-8">{inv.status === "HELD" ? "Paid by M-Pesa and held until you approve." : inv.status === "FROZEN" ? "Held while the dispute is reviewed." : "Paid by M-Pesa."}</div>
      </div>
    </div>
  );
}

function JobDetails({ job }: { job: ClientJob }) {
  return (
    <details className="card">
      <summary className="strong" style={{ cursor: "pointer" }}>
        Job details and activity
      </summary>
      <div className="stack g-12 mt-12">
        <div className="row g-8 small">
          <MapPin size={16} className="faint" />
          <span>
            {job.address}
            {job.addressNotes && <span className="muted"> · {job.addressNotes}</span>}
          </span>
        </div>
        {job.scheduledFor && (
          <div className="row g-8 small">
            <Clock size={16} className="faint" /> {when(job.scheduledFor)}
          </div>
        )}
        <p className="small">{job.description}</p>
        {job.photos.filter((p) => p.kind === "request").length > 0 && (
          <div className="photos">
            {job.photos
              .filter((p) => p.kind === "request")
              .map((p) => (
                <div className="photo" key={p.url}>
                  <img src={p.url} alt="Job photo" loading="lazy" />
                </div>
              ))}
          </div>
        )}
        <div className="stack">
          {job.priceLines.map((l) => (
            <div className="kv" key={l.label}>
              <span>
                {l.label}
                {l.detail && <span className="tiny"> · {l.detail}</span>}
              </span>
              <span className="num">{kes(l.amount)}</span>
            </div>
          ))}
          <div className="kv">
            <span>Service fee ({job.price.clientFeePct}%)</span>
            <span className="num">{kes(job.price.clientFee)}</span>
          </div>
          {job.price.extras > 0 && (
            <div className="kv">
              <span>Approved extras</span>
              <span className="num">{kes(job.price.extras)}</span>
            </div>
          )}
          <div className="kv total">
            <span>Paid so far</span>
            <span className="num">{kes(job.price.paid + job.price.tip)}</span>
          </div>
        </div>
        {job.payments.filter((p) => p.status === "SUCCESS").map((p) => (
          <div key={p.id} className="tiny muted">
            M-Pesa {p.receipt ?? ""} · {kes(p.amount)} · {dateTime(p.at)}
          </div>
        ))}
        <div className="events">
          {job.timeline.map((e, i) => (
            <div className="event" key={i}>
              <span className="event-dot" />
              <span className="grow">{eventLabel(e.kind, e.detail)}</span>
              <span className="tiny muted nowrap">{time(e.at)}</span>
            </div>
          ))}
        </div>
        <Link to="/legal/policies" className="link small">
          Rates, fees and cancellations
        </Link>
      </div>
    </details>
  );
}

function eventLabel(kind: string, d: Record<string, unknown>): string {
  const m: Record<string, string> = {
    "job.created": "Booking created",
    "payment.held": "Payment received and held",
    "status.searching": "Looking for a worker",
    "status.scheduled": "Scheduled",
    "status.accepted": "Worker accepted",
    "status.en_route": `On the way${d.eta ? ` (ETA ${d.eta} min)` : ""}`,
    "status.on_site": "Arrived",
    "status.in_progress": "Work started",
    "status.completed": "Work finished",
    "status.closed": "Closed",
    "status.cancelled": "Cancelled",
    "status.unassigned": "No worker accepted in time",
    "status.expired": "Not paid in time",
    "status.disputed": "Dispute raised",
    "worker.cancelled": "Worker cancelled; finding another",
    "worker.late": "Worker running late",
    "extra.requested": `Extra requested${d.amount ? `: ${kes(Number(d.amount))}` : ""}`,
    "extra.paid": "Extra approved and paid",
    "extra.declined": "Extra declined",
    "tip.paid": "Tip paid",
    "escrow.settled": `Payment settled${d.refund ? ` · ${kes(Number(d.refund))} refunded` : ""}`,
    "rating.added": "Rating added",
    "report.raised": "Problem reported",
  };
  return m[kind] ?? kind;
}

function CancelSheet({ open, job, onClose, onDone }: { open: boolean; job: ClientJob; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState<CancelQuote | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setQ(null);
    setError(null);
    api
      .get<{ quote: CancelQuote }>(`/jobs/${job.id}/cancel-quote`)
      .then((r) => setQ(r.data.quote))
      .catch((e) => setError(errorMessage(e)));
  }, [open, job.id]);
  const confirm = async () => {
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/jobs/${job.id}/cancel`, { reason, expectedFee: q.fee });
      toast(q.refund > 0 ? `Cancelled. ${kes(q.refund)} is on its way back to your M-Pesa.` : "Cancelled.", "ok");
      onClose();
      onDone();
      void invalidate("/jobs");
    } catch (e) {
      setError(errorMessage(e));
      const r = await api.get<{ quote: CancelQuote }>(`/jobs/${job.id}/cancel-quote`).catch(() => null);
      if (r) setQ(r.data.quote);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="Cancel this booking?">
      <div className="stack g-16">
        {!q && !error && <Skeleton h={90} />}
        {q && !q.allowed && <Notice tone="warn">{q.reason}</Notice>}
        {q?.allowed && (
          <>
            <div className="card flat stack g-4">
              <div className="kv">
                <span>Cancellation fee</span>
                <span className={`num strong ${q.fee ? "" : "green"}`}>{q.fee ? kes(q.fee) : "Free"}</span>
              </div>
              {job.price.paid > 0 && (
                <div className="kv">
                  <span>Refunded to your M-Pesa</span>
                  <span className="num strong">{kes(q.refund)}</span>
                </div>
              )}
              <p className="small muted mt-4">{q.rule}</p>
            </div>
            <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="row g-8">
          <Button block onClick={onClose} disabled={busy}>
            Keep booking
          </Button>
          <Button variant="danger" block loading={busy} disabled={!q?.allowed} onClick={confirm}>
            {q?.fee ? `Cancel and pay ${kes(q.fee)}` : "Cancel booking"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

const eatToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function RescheduleSheet({ open, job, onClose, onDone }: { open: boolean; job: ClientJob; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"asap" | "later">("asap");
  const [date, setDate] = useState(plusDays(eatToday(), 1));
  const [t, setT] = useState("09:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/jobs/${job.id}/reschedule`, { scheduledFor: mode === "asap" ? null : `${date}T${t}:00+03:00` });
      toast(mode === "asap" ? "Looking for a worker again" : "New time saved", "ok");
      onClose();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="When should we look?">
      <div className="stack g-16">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "asap", label: "Try again now" },
            { value: "later", label: "Pick a time" },
          ]}
        />
        {mode === "later" && (
          <div className="row g-10">
            <div className="grow">
              <Input type="date" label="Date" value={date} min={eatToday()} max={plusDays(eatToday(), 14)} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grow">
              <Select label="Time" value={t} onChange={(e) => setT(e.target.value)}>
                {Array.from({ length: 27 }, (_, i) => {
                  const m = 7 * 60 + i * 30;
                  const v = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
                  return (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  );
                })}
              </Select>
            </div>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <Button variant="primary" size="lg" block loading={busy} onClick={save}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

const REASONS = ["Work not finished", "Poor quality", "Damage caused", "Charged for something not done", "Worker behaviour", "Other"];

function DisputeSheet({ open, job, onClose, onDone }: { open: boolean; job: ClientJob; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState(REASONS[0]);
  const [details, setDetails] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setError(null);
    if (details.trim().length < 10) return setError("Tell us what went wrong in a sentence or two");
    setBusy(true);
    try {
      const form = new FormData();
      form.set("reason", reason);
      form.set("details", details);
      photos.forEach((p) => form.append("photos", p));
      await api.post(`/jobs/${job.id}/dispute`, form);
      toast("Payment is frozen while we review it", "ok");
      onClose();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="What went wrong?">
      <div className="stack g-16">
        <p className="small muted">
          Payment stays frozen while our team reviews the photos and the job timeline, usually within 3 business days. They then release it, refund you, or split it, and text you both the decision.
        </p>
        <div className="chips">
          {REASONS.map((r) => (
            <button key={r} type="button" className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>
              {r}
            </button>
          ))}
        </div>
        <Textarea label="Details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} />
        <div className="field">
          <span className="label">Photos (up to 3)</span>
          <PhotoPicker files={photos} onChange={setPhotos} capture="environment" />
        </div>
        {job.disputeUntil && <span className="tiny muted">You can raise this until {when(job.disputeUntil)}.</span>}
        {error && <Notice tone="error">{error}</Notice>}
        <Button variant="danger" size="lg" block loading={busy} onClick={send}>
          Raise a dispute
        </Button>
      </div>
    </Sheet>
  );
}
