import { BadgeCheck, Banknote, ChevronRight, ClipboardList, Clock, IdCard, LocateFixed, MapPin, ShieldCheck, Star, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorCode, errorMessage, useApi } from "../../api/client";
import { Badge, Button, LinkButton, Notice, PageHead, Skeleton, StatusBadge, Switch } from "../../components/ui";
import { onLive, useAuth, useConfig } from "../../context/AuthContext";
import { useToast } from "../../context/toast";
import { ACTIVE, kes, mmss, when, WORKER_STATUS_LABEL } from "../../lib/format";
import { currentPosition, useShareLocation } from "../../lib/location";
import type { JobStatus, Offer, WorkerProfile } from "../../types";

// The worker's hub: application status, going available, incoming offers with the
// acceptance countdown (US-02), and the job in hand.

type JobRow = { id: string; ref: string; status: JobStatus; service: string; address: string; earn: number; scheduledFor: string | null; client: string };

export default function WorkHome() {
  const { me, ready } = useAuth();
  const cfg = useConfig();
  const prof = useApi<{ profile: WorkerProfile | null }>(me ? "/worker/profile" : null, { staleMs: 10_000 });
  if (!ready) return <Skeleton h={300} />;
  if (!me) return <Intro signedIn={false} />;
  if (prof.loading) return <Skeleton h={300} />;
  const p = prof.data?.profile;
  if (!p || p.status === "draft") return <Intro signedIn draft={Boolean(p)} />;
  if (p.status === "approved") return <OnDuty profile={p} reload={() => void prof.reload()} />;
  return (
    <div className="stack g-20">
      <PageHead title="Work" />
      {p.status === "submitted" && (
        <div className="card stack g-14">
          <Badge tone="amber" icon={<Clock />}>
            Under review
          </Badge>
          <h2>We're checking your application</h2>
          <p className="muted small">The team compares your ID photo and selfie{p.requiresCertificate ? " and checks your certificate" : ""}. You'll get an SMS with the decision.</p>
          <Steps p={p} />
        </div>
      )}
      {p.status === "more_info" && (
        <div className="stack g-12">
          <Notice tone="warn">
            <b>We need a little more.</b> {p.reviewReason}
          </Notice>
          <LinkButton to="/work/apply" variant="primary" size="lg" block>
            Update my application
          </LinkButton>
        </div>
      )}
      {p.status === "rejected" && (
        <div className="stack g-12">
          <Notice tone="error">
            <b>Your application wasn't approved.</b> {p.reviewReason}
          </Notice>
          <LinkButton to="/work/apply" block>
            Review and resubmit
          </LinkButton>
        </div>
      )}
      {p.status === "suspended" && (
        <Notice tone="error" icon={<TriangleAlert />}>
          <b>Your account is paused for review.</b> {p.reviewReason} The team will contact you. Paid and pending earnings are not affected.
        </Notice>
      )}
      <LinkButton to="/work/earnings" icon={<Banknote />}>
        Earnings and payouts
      </LinkButton>
      {cfg && <p className="tiny muted">Workers keep {100 - cfg.fees.workerPct}% of every job price, plus tips in full.</p>}
    </div>
  );
}

function Intro({ signedIn, draft }: { signedIn: boolean; draft?: boolean }) {
  const cfg = useConfig();
  return (
    <div className="stack g-24">
      <div className="stack g-10">
        <h1>Work with Mjengo O'clock</h1>
        <p className="muted">Jobs near you in Nairobi for plumbers, electricians, site managers and general workers. See the area, the job and your pay before you accept, and get paid to M-Pesa once the client approves.</p>
      </div>
      <div className="trust">
        <div className="trust-item">
          <MapPin />
          <div className="stack g-4">
            <span className="strong">Nearby jobs, your choice</span>
            <span className="small muted">Go available when you want work. Each offer gives you {Math.round((cfg?.policy.offerWindowSeconds ?? 120) / 60)} minutes to accept or pass.</span>
          </div>
        </div>
        <div className="trust-item">
          <Banknote />
          <div className="stack g-4">
            <span className="strong">Clear pay, paid out fast</span>
            <span className="small muted">You keep {100 - (cfg?.fees.workerPct ?? 9)}% of the job price and every tip. Extra hours and materials are approved and paid before you do them.</span>
          </div>
        </div>
        <div className="trust-item">
          <ShieldCheck />
          <div className="stack g-4">
            <span className="strong">Protected for no-shows</span>
            <span className="small muted">If the client isn't there after a {cfg?.policy.clientWaitMinutes ?? 15}-minute wait, you earn the call-out fee.</span>
          </div>
        </div>
      </div>
      <div className="card stack g-10">
        <h3>What you'll need</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          <li>Your Kenyan national ID and a clear photo of it</li>
          <li>A selfie, taken in the app</li>
          <li>For electricians and plumbers: a trade certificate or a reference letter</li>
          <li>An M-Pesa number or bank account for payouts</li>
          <li>A smartphone with location turned on</li>
        </ul>
      </div>
      <LinkButton to={signedIn ? "/work/apply" : "/login?next=/work/apply"} variant="primary" size="lg" block icon={<IdCard />}>
        {draft ? "Continue my application" : "Apply now"}
      </LinkButton>
    </div>
  );
}

export function Steps({ p }: { p: WorkerProfile }) {
  const items = [
    { done: Boolean(p.categoryId), label: "Trade and experience" },
    { done: Boolean(p.nationalIdLast4 && p.documents.idFront && p.documents.selfie), label: "ID and selfie" },
    { done: !p.requiresCertificate || Boolean(p.documents.certificate), label: p.requiresCertificate ? "Trade certificate" : "Certificate (optional)" },
    { done: Boolean(p.payout.method === "bank" ? p.payout.accountNumber : true), label: "Payout details" },
    { done: p.status === "approved", label: "Approved by the team" },
  ];
  return (
    <div className="app-steps">
      {items.map((s, i) => (
        <div key={s.label} className={`app-step ${s.done ? "done" : ""}`}>
          <span className="n">{s.done ? "✓" : i + 1}</span>
          <span className={s.done ? "" : "muted"}>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

function OnDuty({ profile, reload }: { profile: WorkerProfile; reload: () => void }) {
  const { me, refresh } = useAuth();
  const cfg = useConfig();
  const toast = useToast();
  const nav = useNavigate();
  const jobs = useApi<{ jobs: JobRow[] }>("/worker/jobs", { staleMs: 8_000 });
  const active = jobs.data?.jobs.filter((j) => ACTIVE.includes(j.status)) ?? [];
  const waiting = jobs.data?.jobs.filter((j) => j.status === "COMPLETED" || j.status === "DISPUTED") ?? [];
  const [offer, setOffer] = useState<Offer | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<"" | "duty" | "accept" | "decline">("");
  const consent = Boolean(me?.locationConsentAt);
  const geo = useShareLocation(profile.available || active.length > 0, active.length > 0);

  const loadOffer = useCallback(async () => {
    try {
      const r = await api.get<{ offer: Offer | null }>("/worker/offer");
      setOffer(r.data.offer);
    } catch {
      /* try again shortly */
    }
  }, []);

  useEffect(() => {
    if (!profile.available) return;
    void loadOffer();
    const poll = setInterval(loadOffer, 8000);
    const offA = onLive("offer", () => void loadOffer());
    const offB = onLive("offer_gone", () => setOffer(null));
    const offJ = onLive("job", () => void jobs.reload());
    return () => {
      clearInterval(poll);
      offA();
      offB();
      offJ();
    };
  }, [profile.available, loadOffer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // A sound and vibration when an offer arrives, so it isn't missed with the phone in a pocket.
  useEffect(() => {
    if (!offer) return;
    try {
      navigator.vibrate?.([300, 150, 300]);
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.35);
    } catch {
      /* no sound allowed yet */
    }
  }, [offer?.offerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setDuty = async (v: boolean) => {
    setBusy("duty");
    try {
      if (v && !consent) await api.patch("/me", { locationConsent: true });
      const pos = v ? await currentPosition() : null;
      await api.post("/worker/availability", { available: v, ...(pos ?? {}) });
      if (v && !pos) toast("Couldn't read your location. Turn on location so nearby jobs reach you.", "error");
      await refresh();
      reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy("");
    }
  };

  const accept = async () => {
    if (!offer) return;
    setBusy("accept");
    try {
      const r = await api.post<{ jobId: string }>(`/worker/offers/${offer.offerId}/accept`);
      setOffer(null);
      nav(`/work/jobs/${r.data.jobId}`);
    } catch (e) {
      toast(errorMessage(e), "error");
      if (errorCode(e) === "offer_gone") setOffer(null);
    } finally {
      setBusy("");
    }
  };
  const decline = async () => {
    if (!offer) return;
    setBusy("decline");
    try {
      await api.post(`/worker/offers/${offer.offerId}/decline`);
    } catch {
      /* it has gone anyway */
    } finally {
      setOffer(null);
      setBusy("");
    }
  };

  const left = offer ? new Date(offer.expiresAt).getTime() - now : 0;
  const total = offer ? new Date(offer.expiresAt).getTime() - new Date(offer.offeredAt).getTime() : 1;
  useEffect(() => {
    if (offer && left <= 0) setOffer(null);
  }, [left <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack g-20">
      <PageHead title="Work" right={<Badge tone="green" icon={<BadgeCheck />}>Approved</Badge>} />

      <div className={`duty ${profile.available ? "on" : ""}`}>
        <div className="grow stack g-4">
          <span className="strong" style={{ fontSize: 16 }}>
            {profile.available ? "You're available" : "You're off duty"}
          </span>
          <span className="small muted">
            {profile.available
              ? geo.status === "on"
                ? `Sharing location (±${geo.last?.accuracy ?? "?"} m). Nearby ${profile.category?.toLowerCase()} jobs will appear here.`
                : geo.status === "denied"
                  ? "Location is blocked. Allow it in your browser so jobs near you reach you."
                  : "Getting your location…"
              : "Go available to receive job offers near you."}
          </span>
        </div>
        <Switch label="Available for jobs" checked={profile.available} disabled={busy === "duty"} onChange={(v) => void setDuty(v)} />
      </div>
      {!consent && !profile.available && <p className="tiny muted">Going available turns on location sharing. Clients see your location only while you're on their job.</p>}

      {offer && left > 0 && (
        <div className="offer" role="alertdialog" aria-label="New job offer">
          <div className="row between">
            <span className="strong">New job · {offer.distanceKm.toFixed(1)} km away</span>
            <span className="num strong">{mmss(left)}</span>
          </div>
          <div className="countdown">
            <i style={{ width: `${Math.max(0, (left / total) * 100)}%` }} />
          </div>
          <div className="stack g-4">
            <span className="earn">{kes(offer.earn)}</span>
            <span className="muted small">your pay, after the {cfg?.fees.workerPct ?? 9}% platform fee</span>
          </div>
          <div className="stack g-6">
            <span className="strong">{offer.service.name}</span>
            {offer.service.pricing !== "flat" && <span className="small">{offer.summary}</span>}
            <span className="row g-6 small">
              <MapPin size={15} /> {offer.area}
              {offer.scheduledFor && (
                <>
                  {" "}
                  · <Clock size={15} /> {when(offer.scheduledFor)}
                </>
              )}
            </span>
            <span className="small" style={{ color: "#dfe4e0" }}>
              "{offer.description}"
            </span>
            {offer.client.rating != null && (
              <span className="row g-4 small muted">
                <Star size={14} /> Client rated {offer.client.rating} by {offer.client.ratings} worker{offer.client.ratings === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {offer.photos.length > 0 && (
            <div className="photos">
              {offer.photos.map((p) => (
                <div className="photo" key={p.url} style={{ borderColor: "transparent" }}>
                  <img src={p.url} alt="Job" />
                </div>
              ))}
            </div>
          )}
          <div className="row g-8">
            <Button variant="ghost" block loading={busy === "decline"} onClick={decline}>
              Pass
            </Button>
            <Button variant="primary" size="lg" block loading={busy === "accept"} onClick={accept}>
              Accept
            </Button>
          </div>
          <span className="tiny muted">The full address shows once you accept.</span>
        </div>
      )}

      {active.map((j) => (
        <Link key={j.id} to={`/work/jobs/${j.id}`} className="active-job">
          <span className="pulse" />
          <span className="grow stack">
            <span className="strong">{j.service}</span>
            <span className="small muted">
              {j.client} · {j.address}
            </span>
          </span>
          <StatusBadge status={j.status} label={WORKER_STATUS_LABEL[j.status]} />
          <ChevronRight size={18} />
        </Link>
      ))}
      {active.length > 0 && (
        <Notice icon={<LocateFixed />}>Keep this screen open while you're on a job so the client can follow you. Status updates still reach them by SMS if your location pauses.</Notice>
      )}

      {profile.available && !offer && !active.length && (
        <div className="card flat searching">
          <span className="radar" />
          <div className="stack g-4">
            <span className="strong">Waiting for jobs near you</span>
            <span className="small muted">We'll buzz this phone and text you when one comes in.</span>
          </div>
        </div>
      )}

      {waiting.length > 0 && (
        <section className="stack g-10">
          <div className="section-title">Waiting for the client</div>
          {waiting.map((j) => (
            <Link key={j.id} to={`/work/jobs/${j.id}`} className="card card-link row g-12">
              <span className="grow stack">
                <span className="strong">{j.service}</span>
                <span className="small muted">{j.ref}</span>
              </span>
              <span className="num strong">{kes(j.earn)}</span>
            </Link>
          ))}
        </section>
      )}

      <div className="stat-grid">
        <div className="stat">
          <div className="v">{profile.stats.jobs}</div>
          <div className="k">Jobs done</div>
        </div>
        <div className="stat">
          <div className="v">{profile.stats.rating != null ? profile.stats.rating.toFixed(1) : "–"}</div>
          <div className="k">Rating ({profile.stats.ratings})</div>
        </div>
        <div className="stat">
          <div className="v">{profile.stats.cancellations}</div>
          <div className="k">Cancellations</div>
        </div>
      </div>
      {profile.probationLeft > 0 && <p className="tiny muted">Your first {profile.probationLeft} job{profile.probationLeft === 1 ? "" : "s"} are reviewed by the team as part of onboarding.</p>}

      <div className="stack g-8">
        <LinkButton to="/work/earnings" icon={<Banknote />}>
          Earnings and payouts
        </LinkButton>
        <LinkButton to="/work/jobs" icon={<ClipboardList />}>
          Job history
        </LinkButton>
      </div>
    </div>
  );
}
