import { CalendarClock, Clock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorMessage, fieldErrors, invalidate, useApi } from "../api/client";
import { AddressPicker, type PickedAddress } from "../components/AddressPicker";
import { PaymentSheet } from "../components/PaymentSheet";
import { PhotoPicker } from "../components/PhotoPicker";
import { Button, CategoryIcon, Field, Input, Notice, PageHead, Segmented, Select, Sheet, Skeleton, Stepper, Textarea } from "../components/ui";
import { useAuth, useConfig } from "../context/AuthContext";
import { kes, newKey } from "../lib/format";
import { saveWhere, useWhere } from "../lib/where";
import type { Category, ClientJob, Me, Started } from "../types";

// View 2: job details, date and time, photos, and a sticky footer with the live price
// breakdown and Confirm and book (US-01). Payment is the M-Pesa hold.

type Draft = { serviceId: string | null; hours: number; notes: string; description: string; when: "asap" | "later"; date: string; time: string; key: string };

// Kept across the sign-in step (same tab, no reload), photos included.
let draftStore: { category: string; draft: Draft; photos: File[] } | null = null;

const eatToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TIMES = Array.from({ length: 27 }, (_, i) => {
  const m = 7 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});
const label12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

export default function Book() {
  const { category = "" } = useParams();
  const nav = useNavigate();
  const { me, refresh } = useAuth();
  const cfg = useConfig();
  const cats = useApi<{ categories: Category[] }>("/catalog", { staleMs: 60_000 });
  const cat = cats.data?.categories.find((c) => c.id === category);
  const where = useWhere(me?.home ?? null);

  const restored = draftStore?.category === category ? draftStore : null;
  const [draft, setDraft] = useState<Draft>(
    restored?.draft ?? { serviceId: new URLSearchParams(location.search).get("service"), hours: 0, notes: "", description: "", when: "asap", date: addDays(eatToday(), 1), time: "09:00", key: newKey() },
  );
  const [photos, setPhotos] = useState<File[]>(restored?.photos ?? []);
  const [address, setAddress] = useState<PickedAddress | null>(where);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needDetails, setNeedDetails] = useState(false);
  const [job, setJob] = useState<ClientJob | null>(null);

  useEffect(() => {
    if (!address && where) setAddress(where);
  }, [where]); // eslint-disable-line react-hooks/exhaustive-deps

  const svc = cat?.services.find((s) => s.id === draft.serviceId) ?? null;
  useEffect(() => {
    if (cat && !svc && cat.services.length) setDraft((d) => ({ ...d, serviceId: cat.services[0].id }));
  }, [cat]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (svc?.pricing === "hourly" && draft.hours < svc.minHours) setDraft((d) => ({ ...d, hours: svc.minHours }));
  }, [svc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const price = useMemo(() => {
    if (!svc) return null;
    const hours = svc.pricing === "hourly" ? Math.max(draft.hours, svc.minHours) : 1;
    const base = svc.pricing === "hourly" ? Math.round(svc.rate * hours) : svc.rate;
    const pct = cfg?.fees.clientPct ?? 9;
    const fee = Math.round((base * pct) / 100);
    return { hours, base, fee, pct, total: base + fee };
  }, [svc, draft.hours, cfg]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const scheduledFor = draft.when === "later" ? `${draft.date}T${draft.time}:00+03:00` : null;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!address) e.address = "Choose where the job is";
    if (draft.description.trim().length < 10) e.description = "Describe the job in a sentence or two";
    if (draft.when === "later" && Date.parse(scheduledFor!) < Date.now() + 30 * 60_000) e.when = "Pick a time at least 30 minutes from now";
    setErrors(e);
    return !Object.keys(e).length;
  };

  const confirm = async () => {
    setError(null);
    if (!svc || !validate()) return;
    if (!me) {
      draftStore = { category, draft, photos };
      if (address) saveWhere(address);
      nav(`/login?next=${encodeURIComponent(`/book/${category}`)}`);
      return;
    }
    if (!me.fullName || !me.termsAcceptedAt) return setNeedDetails(true);
    setBusy(true);
    try {
      let j = job;
      if (!j || j.status !== "PENDING_PAYMENT") {
        const r = await api.post<{ job: ClientJob }>("/jobs", {
          serviceId: svc.id,
          hours: svc.pricing === "hourly" ? price!.hours : undefined,
          address: address!.label,
          lat: address!.lat,
          lng: address!.lng,
          addressNotes: draft.notes,
          description: draft.description,
          scheduledFor,
          clientKey: draft.key,
        });
        j = r.data.job;
        if (photos.length && !j.photos.length) {
          const form = new FormData();
          photos.forEach((p) => form.append("photos", p));
          j = (await api.post<{ job: ClientJob }>(`/jobs/${j.id}/photos`, form)).data.job;
        }
        setJob(j);
      }
      draftStore = null;
    } catch (e) {
      setError(errorMessage(e));
      setErrors(fieldErrors(e));
    } finally {
      setBusy(false);
    }
  };

  if (cats.loading) return <Skeleton h={300} />;
  if (!cat)
    return (
      <div className="stack g-16">
        <PageHead title="Not found" back="/" />
        <Notice>That trade isn't available. <Link to="/" className="link">See all trades</Link></Notice>
      </div>
    );

  return (
    <div className="stack g-24 has-foot">
      <PageHead
        back="/"
        title={
          <span className="row g-10">
            <span className="cat-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
              <CategoryIcon id={cat.id} size={20} />
            </span>
            {cat.name}
          </span>
        }
      />

      <section className="stack g-10" aria-label="Service">
        <div className="section-title">Choose the job</div>
        {cat.services.map((s) => (
          <button key={s.id} type="button" className="svc" aria-pressed={s.id === draft.serviceId} onClick={() => set("serviceId", s.id)}>
            <span className="radio-dot" />
            <span className="grow stack g-4">
              <span className="strong">{s.name}</span>
              <span className="small muted">{s.description}</span>
            </span>
            <span className="stack" style={{ alignItems: "flex-end" }}>
              <span className="price">{kes(s.rate)}</span>
              <span className="per">{s.pricing === "hourly" ? `per hour · min ${s.minHours} h` : "fixed"}</span>
            </span>
          </button>
        ))}
        {svc?.pricing === "hourly" && (
          <Field label="How many hours?" hint="Extra time needs your approval in the app before it's charged.">
            <Stepper value={Math.max(draft.hours, svc.minHours)} onChange={(v) => set("hours", v)} min={svc.minHours} max={24} step={svc.minHours % 1 ? 0.5 : 1} format={(v) => `${v} h`} />
          </Field>
        )}
      </section>

      <section className="stack g-10" aria-label="Location">
        <div className="section-title">Where</div>
        <AddressPicker
          value={address}
          onChange={(a) => {
            setAddress(a);
            saveWhere(a);
          }}
          error={errors.address}
        />
        <Input label="Directions for the worker" placeholder="Gate colour, building, floor, house number" value={draft.notes} onChange={(e) => set("notes", e.target.value)} maxLength={300} />
      </section>

      <section className="stack g-10" aria-label="When">
        <div className="section-title">When</div>
        <Segmented
          value={draft.when}
          onChange={(v) => set("when", v)}
          options={[
            { value: "asap", label: <span className="row g-6" style={{ justifyContent: "center" }}><Clock size={16} /> Right away</span> },
            { value: "later", label: <span className="row g-6" style={{ justifyContent: "center" }}><CalendarClock size={16} /> Schedule</span> },
          ]}
        />
        {draft.when === "later" && (
          <div className="row g-10">
            <div className="grow">
              <Input type="date" label="Date" value={draft.date} min={eatToday()} max={addDays(eatToday(), 14)} onChange={(e) => set("date", e.target.value)} />
            </div>
            <div className="grow">
              <Select label="Time" value={draft.time} onChange={(e) => set("time", e.target.value)}>
                {TIMES.map((t) => (
                  <option key={t} value={t}>
                    {label12(t)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        )}
        {errors.when && <div className="small red strong">{errors.when}</div>}
      </section>

      <section className="stack g-10" aria-label="Details">
        <div className="section-title">Describe the job</div>
        <Textarea
          placeholder="What needs doing? Anything the worker should bring?"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          maxLength={2000}
          error={errors.description}
        />
        <Field label="Photos (up to 3)" hint="Photos help the worker bring the right tools and parts.">
          <PhotoPicker files={photos} onChange={setPhotos} max={3} capture="environment" />
        </Field>
      </section>

      <Notice>
        Cancel free until a worker accepts. After that, fees may apply; the cancel screen always shows the amount first. <Link to="/legal/policies" className="link">Fees and cancellations</Link>
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}

      <div className="sticky-foot">
        <div className="sticky-foot-inner">
          {price && (
            <div className="price-line">
              <div className="stack">
                <span className="price-detail">
                  {svc!.pricing === "hourly" ? `${price.hours} h × ${kes(svc!.rate)}` : svc!.name} = {kes(price.base)} · {price.pct}% fee {kes(price.fee)}
                </span>
                <span className="price-detail">Held by M-Pesa until you approve the work</span>
              </div>
              <span className="total">{kes(price.total)}</span>
            </div>
          )}
          <Button variant="primary" size="lg" block loading={busy} disabled={!svc} onClick={confirm}>
            Confirm and book
          </Button>
        </div>
      </div>

      <DetailsSheet
        open={needDetails}
        me={me}
        onClose={() => setNeedDetails(false)}
        onDone={async () => {
          await refresh();
          setNeedDetails(false);
        }}
      />

      {job && (
        <PaymentSheet
          open={Boolean(job)}
          onClose={() => {
            const id = job.id;
            setJob(null);
            void invalidate("/jobs");
            nav(`/jobs/${id}`);
          }}
          title="Pay to confirm your booking"
          amount={job.price.total}
          summary={
            <div className="stack g-4 small">
              <div className="kv">
                <span>{job.service.name}</span>
                <span className="num">{kes(job.price.base)}</span>
              </div>
              <div className="kv">
                <span>Service fee ({job.price.clientFeePct}%)</span>
                <span className="num">{kes(job.price.clientFee)}</span>
              </div>
              <div className="muted tiny">Held until you approve the work. Refunded in full if you cancel before a worker accepts.</div>
            </div>
          }
          start={(phone) => api.post<Started>(`/jobs/${job.id}/pay`, { phone }).then((r) => r.data)}
          onPaid={() => {
            void refresh();
            void invalidate("/jobs");
          }}
          doneLabel="Track my booking"
        />
      )}
    </div>
  );
}

/** Name and agreement to the terms, asked once before the first booking. */
export function DetailsSheet({ open, me, onClose, onDone }: { open: boolean; me: Me | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(me?.fullName ?? "");
  const [agree, setAgree] = useState(Boolean(me?.termsAcceptedAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(me?.fullName ?? "");
      setAgree(Boolean(me?.termsAcceptedAt));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setError(null);
    if (name.trim().length < 2) return setError("Enter your full name");
    if (!agree) return setError("Agree to the terms to continue");
    setBusy(true);
    try {
      await api.patch("/me", { fullName: name.trim(), acceptTerms: true });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Your details">
      <div className="stack g-16">
        <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            I agree to the <Link to="/legal/terms" className="link" target="_blank">terms</Link>, the <Link to="/legal/policies" className="link" target="_blank">cancellation, refund and dispute policy</Link> and the{" "}
            <Link to="/legal/privacy" className="link" target="_blank">privacy notice</Link>.
          </span>
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <Button variant="primary" size="lg" block loading={busy} onClick={save}>
          Continue
        </Button>
      </div>
    </Sheet>
  );
}
