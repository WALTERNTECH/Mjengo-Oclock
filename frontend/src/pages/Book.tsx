import { CalendarClock, Clock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorMessage, fieldErrors, invalidate, useApi } from "../api/client";
import { AddressPicker, type PickedAddress } from "../components/AddressPicker";
import { PaymentSheet } from "../components/PaymentSheet";
import { PhotoPicker } from "../components/PhotoPicker";
import { Button, CategoryIcon, Field, Input, Notice, PageHead, Segmented, Select, Sheet, Skeleton, Stepper, Textarea } from "../components/ui";
import { useAuth, useConfig } from "../context/AuthContext";
import { estimate, kes, newKey, ratePhrase, unitWord } from "../lib/format";
import { saveWhere, useWhere } from "../lib/where";
import type { Category, ClientJob, Me, Started } from "../types";

// View 2: job details, date and time, photos, and a sticky footer with the live price
// breakdown and Confirm and book (US-01). Payment is the M-Pesa hold. Rates follow the
// construction and site labour rate schedule: per task or visit, per hour, per 8-hour shift
// (hours beyond it billed hourly where a rate exists), per day, or per foot.

/** Painters and gypsum installers are booked by the day, picked with a stepper. */
const byDay = (s: { pricing: string; unit: string }) => s.pricing === "per_unit" && s.unit === "day";
const MAX_DAYS = 30;

type Draft = {
  serviceId: string | null;
  hours: number;
  /** Feet of trench, days of painting and the like, as typed. */
  quantity: string;
  overtimeHours: number;
  notes: string;
  description: string;
  when: "asap" | "later";
  date: string;
  time: string;
  key: string;
};

/** Straight-line km, enough to tell the Nairobi area from out of station. */
function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

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
    restored?.draft ?? {
      serviceId: new URLSearchParams(location.search).get("service"),
      hours: 0,
      quantity: "",
      overtimeHours: 0,
      notes: "",
      description: "",
      when: "asap",
      date: addDays(eatToday(), 1),
      time: "09:00",
      key: newKey(),
    },
  );
  const [zoneNote, setZoneNote] = useState<string | null>(null);
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
    if (svc?.pricing === "hourly" && draft.hours < svc.minQty) setDraft((d) => ({ ...d, hours: svc.minQty }));
    if (svc && !svc.overtimeRate && draft.overtimeHours) setDraft((d) => ({ ...d, overtimeHours: 0 }));
    const days = Number(draft.quantity);
    if (svc && byDay(svc) && !(days >= svc.minQty && days <= MAX_DAYS)) setDraft((d) => ({ ...d, quantity: String(svc.minQty) }));
  }, [svc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoning: a site visit is priced by whether the site is in the Nairobi area or out of station,
  // so the matching rate is picked as soon as the address is known.
  const radius = cfg?.policy.serviceRadiusKm ?? 40;
  const inNairobi = address && cfg ? kmBetween(address, cfg.centre) <= radius : null;
  const zoned = Boolean(cat?.services.some((s) => s.zone === "outside"));
  useEffect(() => {
    if (!svc || !cat || inNairobi == null) return;
    const want = inNairobi ? "nairobi" : "outside";
    if (svc.zone === want) return;
    const twin = cat.services.find((s) => s.zone === want && s.pricing === svc.pricing && s.unit === svc.unit);
    if (twin) {
      setDraft((d) => ({ ...d, serviceId: twin.id }));
      setZoneNote(inNairobi ? `This site is in the Nairobi area, so the Nairobi rate applies (${ratePhrase(twin)}).` : `This site is outside the Nairobi area, so the out-of-station rate applies (${ratePhrase(twin)}).`);
    }
  }, [inNairobi, svc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoneProblem =
    svc && inNairobi != null && (svc.zone === "outside" ? inNairobi : !inNairobi)
      ? svc.zone === "outside"
        ? "This site is in the Nairobi area. Choose the Nairobi visit rate."
        : zoned
          ? "This site is outside the Nairobi area. Choose the out-of-station rate."
          : "We only cover the Nairobi area for this trade. Choose an address in Nairobi."
      : null;

  const qty = Number(draft.quantity) || 0;
  const price = useMemo(() => {
    if (!svc) return null;
    const hours = Math.max(draft.hours, svc.minQty);
    const pct = cfg?.fees.clientPct ?? 9;
    return { hours, pct, ...estimate(svc, { hours, quantity: Math.max(qty, svc.pricing === "per_unit" ? 0 : 1), overtimeHours: draft.overtimeHours }, pct) };
  }, [svc, draft.hours, qty, draft.overtimeHours, cfg]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const scheduledFor = draft.when === "later" ? `${draft.date}T${draft.time}:00+03:00` : null;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!address) e.address = "Choose where the job is";
    else if (zoneProblem) e.address = zoneProblem;
    if (svc?.pricing === "per_unit" && (!qty || qty < svc.minQty)) e.quantity = `Enter how many ${unitWord(svc.unit, 2)} (at least ${svc.minQty})`;
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
          quantity: svc.pricing === "per_unit" ? qty : undefined,
          overtimeHours: svc.pricing === "shift" && svc.overtimeRate ? draft.overtimeHours : undefined,
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
              <span className="per">{s.unitPhrase}</span>
            </span>
          </button>
        ))}
        {svc?.pricing === "hourly" && (
          <Field label="How many hours?" hint="Extra time needs your approval in the app before it's charged.">
            <Stepper value={Math.max(draft.hours, svc.minQty)} onChange={(v) => set("hours", v)} min={svc.minQty} max={24} step={svc.minQty % 1 ? 0.5 : 1} format={(v) => `${v} h`} />
          </Field>
        )}
        {svc && byDay(svc) && (
          <Field label="How many days?" error={errors.quantity} hint={`${ratePhrase(svc)}. If the work runs longer, the worker asks you in the app before adding a day.`}>
            <Stepper value={Math.max(Number(draft.quantity) || 0, svc.minQty)} onChange={(v) => set("quantity", String(v))} min={svc.minQty} max={MAX_DAYS} format={(v) => `${v} ${unitWord("day", v)}`} />
          </Field>
        )}
        {svc?.pricing === "per_unit" && !byDay(svc) && (
          <Input
            label={`How many ${unitWord(svc.unit, 2)}?`}
            inputMode="numeric"
            placeholder={`e.g. 50`}
            value={draft.quantity}
            onChange={(e) => set("quantity", e.target.value.replace(/[^\d.]/g, "").slice(0, 7))}
            error={errors.quantity}
            hint={`${ratePhrase(svc)}. If more turns out to be needed, the worker asks you in the app first.`}
          />
        )}
        {svc?.pricing === "shift" &&
          (svc.overtimeRate ? (
            <Field label={`Hours beyond the ${svc.shiftHours}-hour shift`} hint={`A standard shift is ${svc.shiftHours} hours. Extra hours are billed at ${kes(svc.overtimeRate)} per hour.`}>
              <Stepper value={draft.overtimeHours} onChange={(v) => set("overtimeHours", v)} min={0} max={8} format={(v) => (v ? `+${v} h` : "None")} />
            </Field>
          ) : (
            <p className="small muted">A standard {svc.shiftHours}-hour shift. For longer work, book another shift.</p>
          ))}
      </section>

      <section className="stack g-10" aria-label="Location">
        <div className="section-title">Where</div>
        <AddressPicker
          value={address}
          scope={zoned ? "kenya" : "nairobi"}
          onChange={(a) => {
            setAddress(a);
            setZoneNote(null);
            saveWhere(a);
          }}
          error={errors.address ?? zoneProblem ?? undefined}
        />
        {zoneNote && !zoneProblem && <Notice tone="ok">{zoneNote}</Notice>}
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
        Cancel free until a worker accepts. After that, fees may apply; the cancel screen always shows the amount first. Rates follow our standard schedule; contractor overhead and specialised engineering review fees aren't included and are quoted under a separate scope contract.{" "}
        <Link to="/legal/policies" className="link">Rates, fees and cancellations</Link>
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}

      <div className="sticky-foot">
        <div className="sticky-foot-inner">
          {price && (
            <div className="price-line">
              <div className="stack">
                <span className="price-detail">
                  {price.detail}
                  {svc!.pricing === "hourly" || svc!.pricing === "per_unit" || price.overtimeHours > 0 ? ` = ${kes(price.base)}` : ""} · {price.pct}% fee {kes(price.fee)}
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
              {job.priceLines.map((l) => (
                <div className="kv" key={l.label}>
                  <span>
                    {l.label}
                    {l.detail && <span className="tiny muted"> · {l.detail}</span>}
                  </span>
                  <span className="num">{kes(l.amount)}</span>
                </div>
              ))}
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
