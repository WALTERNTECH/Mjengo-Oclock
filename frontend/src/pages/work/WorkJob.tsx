import { Camera, ChevronLeft, Clock, MapPin, Navigation, Phone, Plus, Star, UserX } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, errorMessage, invalidate, useApi } from "../../api/client";
import { MapView } from "../../components/MapView";
import { PhotoPicker } from "../../components/PhotoPicker";
import { ReportProblem } from "../../components/ReportProblem";
import { Badge, Button, Input, Notice, Segmented, Sheet, Skeleton, StarInput, Stars, StatusBadge, Textarea } from "../../components/ui";
import { onLive } from "../../context/AuthContext";
import { useToast } from "../../context/toast";
import { ACTIVE, kes, mmss, time, unitWord, when, WORKER_STATUS_LABEL } from "../../lib/format";
import { currentPosition, useShareLocation } from "../../lib/location";
import type { WorkerJob } from "../../types";

// The worker's active job: navigate, call, tap each status (which sends the client's SMS),
// request extras, log a client no-show after the wait, and rate the client afterwards.

export default function WorkJob() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, reload } = useApi<{ job: WorkerJob }>(`/worker/jobs/${id}`, { staleMs: 4_000 });
  const job = data?.job;
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(Date.now());
  const [extraOpen, setExtraOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const active = Boolean(job && ACTIVE.includes(job.status));
  const geo = useShareLocation(active, active);

  useEffect(() => {
    const off = onLive("job", (d: { id: string }) => d.id === id && void reload());
    const t = setInterval(() => setNow(Date.now()), 1000);
    const p = setInterval(() => void reload(), 15_000);
    return () => {
      off();
      clearInterval(t);
      clearInterval(p);
    };
  }, [id, reload]);

  if (error) return <div style={{ padding: 16 }}><Notice tone="error">{errorMessage(error)}</Notice></div>;
  if (!job) return <div style={{ padding: 16 }}><Skeleton h={320} /></div>;

  const step = async (path: string, body: unknown = {}) => {
    setBusy(path);
    try {
      await api.post(`/worker/jobs/${job.id}/${path}`, body);
      await reload();
      void invalidate("/worker/jobs");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy("");
    }
  };

  const me = geo.last ? { lat: geo.last.lat, lng: geo.last.lng } : null;
  const pendingExtra = job.extras.find((x) => x.status === "PENDING" || x.status === "AWAITING_PAYMENT");
  const noShowIn = job.clientNoShowFrom ? new Date(job.clientNoShowFrom).getTime() - now : null;
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${job.lat},${job.lng}`;

  return (
    <div className="track">
      <div className="track-map">
        <button className="icon-btn" aria-label="Back" onClick={() => nav("/work")} style={{ position: "absolute", top: 12, left: 12, zIndex: 500, background: "#fff", boxShadow: "var(--shadow)" }}>
          <ChevronLeft />
        </button>
        <MapView job={job} worker={me} />
      </div>
      <div className="track-sheet stack g-20">
        <div className="sheet-grip" />
        <div className="status-head">
          <div className="row between g-8">
            <span className="small muted">
              {job.ref}
              {job.probation ? " · onboarding review" : ""}
            </span>
            <StatusBadge status={job.status} label={WORKER_STATUS_LABEL[job.status]} />
          </div>
          <h2>{job.service.name}</h2>
          <span className="small muted">
            You earn <b className="green">{kes(job.earnings.expected)}</b>
            {job.earnings.extras > 0 ? ` (incl. ${kes(job.earnings.extrasNet)} approved extras)` : ""} after the {job.earnings.workerFeePct}% fee
          </span>
        </div>

        {job.late && active && <Notice tone="warn">You're past the expected arrival time. The client can now cancel free. Tap "I've arrived" as soon as you're there.</Notice>}

        <div className="card stack g-12">
          <div className="row g-10">
            <MapPin size={18} className="green" />
            <span className="grow">
              <span className="strong">{job.address}</span>
              {job.addressNotes && <span className="small muted"> · {job.addressNotes}</span>}
            </span>
          </div>
          {job.scheduledFor && (
            <div className="row g-10 small">
              <Clock size={16} className="faint" /> {when(job.scheduledFor)}
            </div>
          )}
          <div className="row g-8">
            <span className="grow stack">
              <span className="strong">{job.client.name}</span>
              <span className="small muted row g-4">
                {job.client.rating != null ? (
                  <>
                    <Star size={13} /> {job.client.rating} from workers
                  </>
                ) : (
                  "New client"
                )}
              </span>
            </span>
            {job.client.phone && (
              <a className="btn btn-sm" href={`tel:${job.client.phone}`}>
                <Phone /> Call
              </a>
            )}
            {active && (
              <a className="btn btn-sm btn-ink" href={directions} target="_blank" rel="noreferrer">
                <Navigation /> Directions
              </a>
            )}
          </div>
          <p className="small">{job.description}</p>
          {job.photos.filter((p) => p.kind === "request").length > 0 && (
            <div className="photos">
              {job.photos
                .filter((p) => p.kind === "request")
                .map((p) => (
                  <div className="photo" key={p.url}>
                    <img src={p.url} alt="Job" loading="lazy" />
                  </div>
                ))}
            </div>
          )}
        </div>

        {pendingExtra && (
          <Notice tone="warn">
            Extra {kes(pendingExtra.amount)} {pendingExtra.status === "AWAITING_PAYMENT" ? "approved; waiting for the client's M-Pesa payment" : "sent; waiting for the client to approve"}. Don't do the extra work until it shows as paid.
          </Notice>
        )}
        {job.extras
          .filter((x) => x.status !== "PENDING" && x.status !== "AWAITING_PAYMENT")
          .slice(-2)
          .map((x) => (
            <div key={x.id} className="row g-8 small">
              <Badge tone={x.status === "APPROVED" ? "green" : ""}>{x.status === "APPROVED" ? "Paid" : x.status === "DECLINED" ? "Declined" : "Expired"}</Badge>
              <span className="grow">{x.reason}</span>
              <span className="num">{kes(x.amount)}</span>
            </div>
          ))}

        {active && (
          <div className="stack g-8">
            {geo.status === "denied" && <Notice tone="warn">Location is blocked, so the client can't follow you on the map. Your status taps still text them.</Notice>}
            {job.status === "ACCEPTED" && (
              <>
                <Button
                  variant="primary"
                  size="lg"
                  block
                  loading={busy === "trip"}
                  onClick={async () => {
                    const p = await currentPosition(5000);
                    await step("trip", p ? { lat: p.lat, lng: p.lng } : {});
                  }}
                >
                  Start trip: I'm on my way
                </Button>
                <Button block loading={busy === "arrive"} onClick={() => void step("arrive")}>
                  I'm already here
                </Button>
              </>
            )}
            {job.status === "EN_ROUTE" && (
              <Button variant="primary" size="lg" block loading={busy === "arrive"} onClick={() => void step("arrive")}>
                I've arrived
              </Button>
            )}
            {job.status === "ON_SITE" && (
              <>
                <Button variant="primary" size="lg" block loading={busy === "start"} onClick={() => void step("start")}>
                  Start the job
                </Button>
                <Button block icon={<UserX />} disabled={noShowIn == null || noShowIn > 0} onClick={() => setNoShowOpen(true)}>
                  {noShowIn != null && noShowIn > 0 ? `Client not here? Wait ${mmss(noShowIn)}` : "Client not here or site closed"}
                </Button>
              </>
            )}
            {job.status === "IN_PROGRESS" && (
              <Button variant="primary" size="lg" block onClick={() => setCompleteOpen(true)}>
                Mark job complete
              </Button>
            )}
            {(job.status === "ON_SITE" || job.status === "IN_PROGRESS") && !pendingExtra && (
              <Button block icon={<Plus />} onClick={() => setExtraOpen(true)}>
                Request extra hours or materials
              </Button>
            )}
            <ReportProblem jobId={job.id} block />
            {["ACCEPTED", "EN_ROUTE", "ON_SITE"].includes(job.status) && (
              <Button variant="ghost" block onClick={() => setCancelOpen(true)}>
                I can't do this job
              </Button>
            )}
          </div>
        )}

        {job.status === "COMPLETED" && <Notice>Done at {time(job.completedAt!)}. The client has 24 hours to approve or raise a problem; then your {kes(job.earnings.expected)} is released automatically.</Notice>}
        {job.status === "DISPUTED" && <Notice tone="warn">The client raised "{job.dispute?.reason}". Payment is on hold while the team reviews it; you'll get an SMS with the decision.</Notice>}
        {job.status === "CLOSED" && (
          <div className="stack g-8">
            {job.payouts.map((p) => (
              <div key={p.kind} className="kv">
                <span>{p.kind === "TIP" ? "Tip" : job.outcome === "client_no_show" ? "Call-out fee" : "Payout"}</span>
                <span className="num strong">
                  {kes(p.amount)} · {p.status === "PAID" ? `paid${p.reference ? ` (${p.reference})` : ""}` : p.method === "bank" ? "bank transfer pending" : "sending"}
                </span>
              </div>
            ))}
            {job.theirRating && (
              <div className="row g-8 small">
                Client rated you <Stars value={job.theirRating.stars} />
              </div>
            )}
          </div>
        )}
        {job.status === "CANCELLED" && <Notice>{job.payouts.length ? `Cancelled by the client. ${kes(job.payouts[0].amount)} cancellation fee ${job.payouts[0].status === "PAID" ? "paid to you" : "on its way"}.` : "This job was cancelled."}</Notice>}

        {["COMPLETED", "DISPUTED", "CLOSED"].includes(job.status) && job.outcome !== "client_no_show" && !job.myRating && <RateClient job={job} onDone={() => void reload()} />}
      </div>

      <ExtraSheet open={extraOpen} job={job} onClose={() => setExtraOpen(false)} onDone={() => void reload()} />
      <CompleteSheet open={completeOpen} job={job} onClose={() => setCompleteOpen(false)} onDone={() => void reload()} />
      <Sheet open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this job?">
        <CancelForm
          onSubmit={async (reason) => {
            await api.post(`/worker/jobs/${job.id}/cancel`, { reason });
            toast("Cancelled. We're finding the client someone else.", "ok");
            void invalidate("/worker");
            nav("/work");
          }}
        />
      </Sheet>
      <Sheet open={noShowOpen} onClose={() => setNoShowOpen(false)} title="Client not available">
        <NoShowForm
          fee={job.calloutFee}
          onSubmit={async (note) => {
            await api.post(`/worker/jobs/${job.id}/no-show`, { note });
            setNoShowOpen(false);
            toast(`Logged. The ${kes(job.calloutFee)} call-out fee is on its way to you.`, "ok");
            await reload();
          }}
        />
      </Sheet>
    </div>
  );
}

function ExtraSheet({ open, job, onClose, onDone }: { open: boolean; job: WorkerJob; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<"hours" | "materials" | "units">("materials");
  const [hours, setHours] = useState("1");
  const [units, setUnits] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [photo, setPhoto] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Extra time bills at the job's hourly or overtime rate; with no rate for the trade, the worker states the amount.
  const rate = job.extraRates.hourly;
  const unitRate = job.extraRates.unit;
  const plural = unitWord(job.extraRates.unitLabel, 2);
  const preview = kind === "hours" && rate ? Math.round(rate * (Number(hours) || 0)) : kind === "units" && unitRate ? Math.round(unitRate * (Number(units) || 0)) : null;
  const send = async () => {
    setError(null);
    if (!photo.length) return setError("Add a photo showing why it's needed");
    if (reason.trim().length < 5) return setError("Explain what it's for");
    setBusy(true);
    try {
      const form = new FormData();
      form.set("kind", kind);
      if (kind === "hours") form.set("hours", hours);
      if (kind === "units") form.set("units", units);
      if (kind === "materials" || (kind === "hours" && !rate)) form.set("amount", amount);
      form.set("reason", reason);
      form.set("photo", photo[0]);
      await api.post(`/worker/jobs/${job.id}/extras`, form);
      toast("Sent. The client gets an SMS to approve it.", "ok");
      setReason("");
      setAmount("");
      setPhoto([]);
      onClose();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="Request extra">
      <div className="stack g-16">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "materials", label: "Materials" },
            { value: "hours", label: "Extra time" },
            ...(unitRate ? [{ value: "units" as const, label: `More ${plural}` }] : []),
          ]}
        />
        {kind === "hours" && (
          <>
            <Input
              label={job.service.pricing === "shift" ? `Hours beyond the ${job.service.shiftHours ?? 8}-hour shift` : "Extra hours"}
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value.replace(/[^\d.]/g, "").slice(0, 4))}
              hint={rate ? `Billed at ${kes(rate)} per hour` : "There's no hourly rate for this job, so enter the amount below."}
            />
            {!rate && <Input label="Amount for the extra time (KES)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 6))} />}
          </>
        )}
        {kind === "units" && (
          <Input label={`How many more ${plural}?`} inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value.replace(/[^\d.]/g, "").slice(0, 7))} hint={`Billed at ${kes(unitRate)} per ${unitWord(job.extraRates.unitLabel, 1)}`} />
        )}
        {kind === "materials" && (
          <Input label="Cost of materials (KES)" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 6))} hint="What you'll pay for them. The client sees this amount plus the service fee." />
        )}
        {preview != null && preview > 0 && <p className="small">The client is asked to approve {kes(preview)} plus the service fee.</p>}
        <Textarea label="What it's for" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. 2 m of copper pipe and two elbows" />
        <div className="field">
          <span className="label">Photo</span>
          <PhotoPicker files={photo} onChange={setPhoto} max={1} capture="environment" />
        </div>
        <Notice>Wait for the client to approve and pay before doing the extra work. Unapproved extras aren't paid.</Notice>
        {error && <Notice tone="error">{error}</Notice>}
        <Button variant="primary" size="lg" block loading={busy} onClick={send}>
          Send to the client
        </Button>
      </div>
    </Sheet>
  );
}

function CompleteSheet({ open, job, onClose, onDone }: { open: boolean; job: WorkerJob; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    try {
      const form = new FormData();
      photos.forEach((p) => form.append("photos", p));
      await api.post(`/worker/jobs/${job.id}/complete`, form);
      toast("Marked complete. The client gets the invoice by SMS.", "ok");
      onClose();
      onDone();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="Finish the job">
      <div className="stack g-16">
        <p className="small muted">Photos of the finished work help if the client raises a problem later.</p>
        <PhotoPicker files={photos} onChange={setPhotos} max={3} capture="environment" label="Photo" />
        {job.extras.some((x) => x.status === "PENDING") && <Notice tone="warn">Your pending extra request will expire and won't be charged.</Notice>}
        <Button variant="primary" size="lg" block loading={busy} icon={<Camera />} onClick={done}>
          Mark complete
        </Button>
      </div>
    </Sheet>
  );
}

function CancelForm({ onSubmit }: { onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack g-16">
      <Notice tone="warn">The client isn't charged and we offer the job to someone else. Cancellations after accepting count against your standing.</Notice>
      <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      {error && <Notice tone="error">{error}</Notice>}
      <Button
        variant="danger"
        size="lg"
        block
        loading={busy}
        onClick={async () => {
          if (reason.trim().length < 3) return setError("Say why you're cancelling");
          setBusy(true);
          try {
            await onSubmit(reason.trim());
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Cancel the job
      </Button>
    </div>
  );
}

function NoShowForm({ fee, onSubmit }: { fee: number; onSubmit: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack g-16">
      <p className="small muted">You've waited long enough. Logging this closes the job, pays you the {kes(fee)} call-out fee and refunds the rest to the client. The team can see your location and the timeline.</p>
      <Textarea label="What happened?" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Gate locked, called twice, no answer" maxLength={500} />
      {error && <Notice tone="error">{error}</Notice>}
      <Button
        variant="ink"
        size="lg"
        block
        loading={busy}
        onClick={async () => {
          if (note.trim().length < 3) return setError("Say what happened");
          setBusy(true);
          try {
            await onSubmit(note.trim());
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Log client no-show
      </Button>
    </div>
  );
}

function RateClient({ job, onDone }: { job: WorkerJob; onDone: () => void }) {
  const toast = useToast();
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="card stack g-10">
      <div className="strong">Rate {job.client.name}</div>
      <StarInput value={stars} onChange={setStars} />
      {stars > 0 && (
        <>
          <Textarea placeholder="Optional: clear instructions, site ready, easy to reach?" value={review} onChange={(e) => setReview(e.target.value)} maxLength={1000} />
          <Button
            variant="ink"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/worker/jobs/${job.id}/rate`, { stars, review });
                toast("Thanks", "ok");
                onDone();
              } catch (e) {
                toast(errorMessage(e), "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Send rating
          </Button>
        </>
      )}
    </div>
  );
}
