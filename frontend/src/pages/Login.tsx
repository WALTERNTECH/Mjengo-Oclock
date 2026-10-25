import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { Mark } from "../components/Logo";
import { Button, Input, Notice, PhoneInput, validPhone } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { prettyPhone } from "../lib/format";

// Phone number, then the six-digit code by SMS (PRD 4.1). New accounts add a name and
// agree to the terms before continuing.

export default function Login() {
  const { me, requestCode, verify, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next")?.startsWith("/") ? params.get("next")! : "/";
  const [step, setStage] = useState<"phone" | "code" | "details">("phone");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [name, setName] = useState(me?.fullName ?? "");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);

  // Signed in already: straight on, unless the account still needs a name or the terms.
  const needsDetails = Boolean(me && (!me.fullName || !me.termsAcceptedAt));
  if (me && !needsDetails && step !== "details") return <Navigate to={next} replace />;
  const stage = needsDetails ? "details" : step;

  const send = async () => {
    setError(null);
    if (!validPhone(phone)) return setError("Enter a Kenyan mobile number, like 0712 345 678");
    setBusy(true);
    try {
      const r = await requestCode(phone);
      setSentTo(r.phone);
      setDevCode(r.devCode ?? null);
      setCode("");
      setResendAt(Date.now() + 60_000);
      setStage("code");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const check = async (value = code) => {
    setError(null);
    if (!/^\d{6}$/.test(value)) return setError("Enter the 6-digit code");
    setBusy(true);
    try {
      const r = await verify(phone, value);
      if (!r.user.fullName || !r.user.termsAcceptedAt) {
        setName(r.user.fullName);
        setStage("details");
      } else nav(next, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setError(null);
    if (name.trim().length < 2) return setError("Enter your full name");
    if (!agree) return setError("Agree to the terms to continue");
    setBusy(true);
    try {
      await api.patch("/me", { fullName: name.trim(), acceptTerms: true });
      await refresh();
      nav(next, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack g-24" style={{ maxWidth: 420, margin: "12px auto 0" }}>
      <div className="stack g-12" style={{ alignItems: "flex-start" }}>
        <Mark size={44} />
        <h1>{stage === "details" ? "Welcome to Mjengo O'clock" : stage === "code" ? "Enter your code" : "Sign in or create an account"}</h1>
        <p className="muted">
          {stage === "phone" && "We'll text you a 6-digit code. No password needed."}
          {stage === "code" && `We sent a code to ${prettyPhone(sentTo)}.`}
          {stage === "details" && "Tell us your name. Workers see your first name and last initial."}
        </p>
      </div>

      {stage === "phone" && (
        <form
          className="stack g-16"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <PhoneInput value={phone} onChange={setPhone} error={error ?? undefined} autoFocus />
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Send code
          </Button>
        </form>
      )}

      {stage === "code" && (
        <form
          className="stack g-16"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          {devCode && (
            <Notice tone="warn" icon={<MessageSquare />}>
              SMS isn't connected yet, so here is your code: <b className="num">{devCode}</b>
            </Notice>
          )}
          <Input
            aria-label="6-digit code"
            className="code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            value={code}
            error={error ?? undefined}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(v);
              if (v.length === 6) void check(v);
            }}
          />
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Continue
          </Button>
          <div className="row between small">
            <button type="button" className="link" onClick={() => setStage("phone")}>
              Change number
            </button>
            <button type="button" className="link" disabled={Date.now() < resendAt || busy} onClick={send} style={Date.now() < resendAt ? { color: "var(--faint)" } : undefined}>
              Send a new code
            </button>
          </div>
        </form>
      )}

      {stage === "details" && (
        <form
          className="stack g-16"
          onSubmit={(e) => {
            e.preventDefault();
            void finish();
          }}
        >
          <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
          <label className="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              I agree to the <Link to="/legal/terms" className="link" target="_blank">terms</Link>, the <Link to="/legal/policies" className="link" target="_blank">cancellation, refund and dispute policy</Link> and the{" "}
              <Link to="/legal/privacy" className="link" target="_blank">privacy notice</Link>.
            </span>
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Continue
          </Button>
        </form>
      )}
    </div>
  );
}
