import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api, errorMessage, fieldErrors, invalidate, useApi } from "../../api/client";
import { AddressPicker, type PickedAddress } from "../../components/AddressPicker";
import { Section } from "../../components/Layout";
import { DocPicker } from "../../components/PhotoPicker";
import { Button, CategoryIcon, Input, Notice, PageHead, PhoneInput, Segmented, Skeleton, Textarea, validPhone } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/toast";
import type { Category, WorkerProfile } from "../../types";
import { Steps } from "./WorkHome";

// View 5: the worker application. ID and selfie for the identity check, a certificate for
// electricians and plumbers, a base location, and payout details (PRD 4.1 and 5).

const EDITABLE = ["draft", "more_info", "rejected"];

export default function Apply() {
  const { me, ready, refresh } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const cats = useApi<{ categories: Category[] }>("/catalog", { staleMs: 60_000 });
  const prof = useApi<{ profile: WorkerProfile | null }>(me ? "/worker/profile" : null);
  const p = prof.data?.profile ?? null;

  const [categoryId, setCategoryId] = useState("");
  const [years, setYears] = useState("");
  const [bio, setBio] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [method, setMethod] = useState<"mpesa" | "bank">("mpesa");
  const [payPhone, setPayPhone] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankBranch, setBankBranch] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [home, setHome] = useState<PickedAddress | null>(null);
  const [eName, setEName] = useState("");
  const [ePhone, setEPhone] = useState("");
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "submit" | "id-front" | "selfie" | "certificate">("");

  useEffect(() => {
    if (!me) return;
    setHome(me.home ? { label: me.home.label, lat: me.home.lat, lng: me.home.lng } : null);
    setEName(me.emergency?.name ?? "");
    setEPhone(me.emergency?.phone?.replace(/^\+254/, "0") ?? "");
    setAgree(Boolean(me.termsAcceptedAt));
    setPayPhone(me.phone.replace(/^\+254/, "0"));
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!p) return;
    setCategoryId(p.categoryId ?? "");
    setYears(p.yearsExperience ? String(p.yearsExperience) : "");
    setBio(p.bio);
    setMethod(p.payout.method);
    if (p.payout.phone) setPayPhone(p.payout.phone.replace(/^\+254/, "0"));
    setBankName(p.payout.bankName ?? "");
    setBankBranch(p.payout.bankBranch ?? "");
    setAccountName(p.payout.accountName ?? "");
  }, [p?.status, p?.categoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ready && !me) return <Navigate to="/login?next=/work/apply" replace />;
  if (!me || prof.loading || cats.loading) return <Skeleton h={400} />;
  if (p && !EDITABLE.includes(p.status)) return <Navigate to="/work" replace />;

  const cat = cats.data?.categories.find((c) => c.id === categoryId);

  const saveProfile = async () => {
    const e: Record<string, string> = {};
    if (!categoryId) e.categoryId = "Choose your trade";
    if (nationalId && !/^\d{6,10}$/.test(nationalId)) e.nationalId = "Digits only, as on your ID";
    if (method === "mpesa" && !validPhone(payPhone)) e.payoutPhone = "Enter your M-Pesa number";
    if (method === "bank" && (!bankName || !accountName || (!accountNumber && !p?.payout.accountNumber))) e.bankName = "Enter the bank, account name and number";
    setErrors(e);
    if (Object.keys(e).length) throw new Error(Object.values(e)[0]);
    await api.put("/worker/profile", {
      categoryId,
      bio,
      yearsExperience: Number(years || 0),
      nationalId: nationalId || undefined,
      payoutMethod: method,
      payoutPhone: method === "mpesa" ? payPhone : undefined,
      bankName: method === "bank" ? bankName : undefined,
      bankBranch: method === "bank" ? bankBranch : undefined,
      accountName: method === "bank" ? accountName : undefined,
      accountNumber: method === "bank" && accountNumber ? accountNumber : undefined,
    });
    const patch: Record<string, unknown> = {};
    if (home) patch.home = home;
    if (eName && validPhone(ePhone)) patch.emergency = { name: eName, phone: ePhone };
    if (agree && !me.termsAcceptedAt) patch.acceptTerms = true;
    if (Object.keys(patch).length) await api.patch("/me", patch);
    await Promise.all([prof.reload(), refresh()]);
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      await saveProfile();
      toast("Saved", "ok");
    } catch (e) {
      setError(errorMessage(e) === "Something went wrong. Try again." ? (e as Error).message : errorMessage(e));
      setErrors((x) => ({ ...x, ...fieldErrors(e) }));
    } finally {
      setBusy("");
    }
  };

  const uploadDoc = async (kind: "id-front" | "selfie" | "certificate", f: File) => {
    setBusy(kind);
    setError(null);
    try {
      if (!p) await saveProfile();
      const form = new FormData();
      form.set("file", f);
      await api.post(`/worker/documents/${kind}`, form);
      await prof.reload();
    } catch (e) {
      setError(errorMessage(e) === "Something went wrong. Try again." ? (e as Error).message : errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const submit = async () => {
    setError(null);
    if (!agree) return setError("Agree to the terms to submit");
    if (!home) return setError("Add your base location");
    setBusy("submit");
    try {
      await saveProfile();
      await api.post("/worker/submit");
      await invalidate("/worker");
      await refresh();
      toast("Application sent. We'll text you the decision.", "ok");
      nav("/work");
    } catch (e) {
      setError(errorMessage(e) === "Something went wrong. Try again." ? (e as Error).message : errorMessage(e));
      setErrors((x) => ({ ...x, ...fieldErrors(e) }));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="stack g-24">
      <PageHead title="Apply to work" back="/work" />
      {p?.status === "more_info" && (
        <Notice tone="warn">
          <b>The team asked for more information:</b> {p.reviewReason}
        </Notice>
      )}
      {p?.status === "rejected" && <Notice tone="error">Previous decision: {p.reviewReason}</Notice>}
      {p && <Steps p={p} />}

      <Section title="1 · Your trade">
        <div className="stack g-10">
          {cats.data?.categories.map((c) => (
            <button key={c.id} type="button" className="svc" aria-pressed={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
              <span className="radio-dot" />
              <span className="cat-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
                <CategoryIcon id={c.id} size={18} />
              </span>
              <span className="grow stack g-4">
                <span className="strong">{c.name}</span>
                <span className="small muted">{c.requiresCertificate ? "Certificate or reference letter required" : "Certificate optional"}</span>
              </span>
            </button>
          ))}
          {errors.categoryId && <div className="small red strong">{errors.categoryId}</div>}
          <Input label="Years of experience" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value.replace(/\D/g, "").slice(0, 2))} />
          <Textarea label="About your work (optional)" placeholder="What you're best at, tools you bring, areas you know" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={600} />
        </div>
      </Section>

      <Section title="2 · Identity">
        <div className="stack g-12">
          <Input
            label="National ID number"
            inputMode="numeric"
            placeholder={p?.nationalIdLast4 ? `Saved: ••••${p.nationalIdLast4}` : "e.g. 23456789"}
            value={nationalId}
            onChange={(e) => setNationalId(e.target.value.replace(/\D/g, "").slice(0, 10))}
            error={errors.nationalId}
            hint="Encrypted, and seen only by the verification team."
          />
          <DocPicker title="Photo of your national ID" hint="Front side, all four corners visible, no glare" current={p?.documents.idFront ?? null} busy={busy === "id-front"} capture="environment" onPick={(f) => void uploadDoc("id-front", f)} />
          <DocPicker title="Selfie" hint="Face the camera in good light. Clients see this photo." current={p?.documents.selfie ?? null} busy={busy === "selfie"} capture="user" onPick={(f) => void uploadDoc("selfie", f)} />
        </div>
      </Section>

      <Section title={`3 · Credentials${cat && !cat.requiresCertificate ? " (optional)" : ""}`}>
        <DocPicker
          title="Trade certificate or reference letter"
          hint={cat?.requiresCertificate ? `Required for ${cat.name.toLowerCase()}` : "Helps the team approve you faster"}
          current={p?.documents.certificate ?? null}
          busy={busy === "certificate"}
          capture="environment"
          onPick={(f) => void uploadDoc("certificate", f)}
        />
      </Section>

      <Section title="4 · Where you usually work from">
        <AddressPicker value={home} onChange={setHome} />
      </Section>

      <Section title="5 · How you get paid">
        <div className="stack g-12">
          <Segmented
            value={method}
            onChange={setMethod}
            options={[
              { value: "mpesa", label: "M-Pesa" },
              { value: "bank", label: "Bank account" },
            ]}
          />
          {method === "mpesa" ? (
            <PhoneInput label="M-Pesa number for payouts" value={payPhone} onChange={setPayPhone} error={errors.payoutPhone} hint="Payouts arrive here once the client approves the job." />
          ) : (
            <>
              <Input label="Bank" value={bankName} onChange={(e) => setBankName(e.target.value)} error={errors.bankName} />
              <Input label="Branch" value={bankBranch} onChange={(e) => setBankBranch(e.target.value)} />
              <Input label="Account name" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
              <Input
                label="Account number"
                inputMode="numeric"
                placeholder={p?.payout.accountNumber ? `Saved: ${p.payout.accountNumber}` : ""}
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, "").slice(0, 20))}
                error={errors.accountNumber}
                hint="Bank payouts are sent by our finance team, usually within one business day."
              />
            </>
          )}
        </div>
      </Section>

      <Section title="6 · Emergency contact (recommended)">
        <div className="stack g-12">
          <Input label="Their name" value={eName} onChange={(e) => setEName(e.target.value)} />
          <PhoneInput label="Their phone" value={ePhone} onChange={setEPhone} hint="Texted with your location if you raise an emergency on a job." />
        </div>
      </Section>

      <label className="check">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>
          I agree to the <Link to="/legal/terms" className="link" target="_blank">terms</Link> and the <Link to="/legal/privacy" className="link" target="_blank">privacy notice</Link>, and confirm the documents are mine and genuine.
        </span>
      </label>

      {error && <Notice tone="error">{error}</Notice>}
      <div className="stack g-8">
        <Button variant="primary" size="lg" block loading={busy === "submit"} onClick={submit}>
          Submit application
        </Button>
        <Button block loading={busy === "save"} onClick={save}>
          Save and finish later
        </Button>
      </div>
    </div>
  );
}
