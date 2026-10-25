import { LogOut, MapPin, Phone, ShieldCheck, Trash2, User } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api, errorMessage, fieldErrors } from "../api/client";
import { AddressPicker, type PickedAddress } from "../components/AddressPicker";
import { Section } from "../components/Layout";
import { Button, Input, Notice, PageHead, PhoneInput, Sheet, Switch, validPhone } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/toast";
import { prettyPhone } from "../lib/format";

// Profile (PRD 4.1): name, contact, primary service location, emergency contact (PRD 5),
// location consent and account deletion (Data Protection Act, PRD 11).

export default function Account() {
  const { me, ready, logout, setMe } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [home, setHome] = useState<PickedAddress | null>(null);
  const [eName, setEName] = useState("");
  const [ePhone, setEPhone] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [del, setDel] = useState(false);

  useEffect(() => {
    if (!me) return;
    setName(me.fullName);
    setEmail(me.email ?? "");
    setHome(me.home ? { label: me.home.label, lat: me.home.lat, lng: me.home.lng } : null);
    setEName(me.emergency?.name ?? "");
    setEPhone(me.emergency?.phone?.replace(/^\+254/, "0") ?? "");
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ready && !me) return <Navigate to="/login?next=/account" replace />;
  if (!me) return null;

  const save = async (patch: Record<string, unknown>, ok = "Saved") => {
    setBusy(true);
    setErrors({});
    try {
      const r = await api.patch("/me", patch);
      setMe(r.data.user);
      toast(ok, "ok");
      return true;
    } catch (e) {
      setErrors(fieldErrors(e));
      toast(errorMessage(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack g-24">
      <PageHead title="Account" />

      <Section title="You">
        <div className="card stack g-14">
          <div className="row g-8 small muted">
            <Phone size={16} /> {prettyPhone(me.phone)} · signed in by SMS code
          </div>
          <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} error={errors.fullName} autoComplete="name" />
          <Input label="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} autoComplete="email" hint="For receipts and anything we can't send by SMS." />
          <Button variant="ink" loading={busy} onClick={() => void save({ fullName: name.trim(), email: email.trim() })}>
            Save
          </Button>
        </div>
      </Section>

      <Section title="Primary location">
        <button className="card card-link row g-12" style={{ textAlign: "left", width: "100%", cursor: "pointer" }} onClick={() => setHomeOpen(true)}>
          <MapPin className="green" />
          <span className="grow stack">
            <span className="strong">{me.home ? me.home.label : "Add your usual address"}</span>
            <span className="small muted">{me.workerStatus ? "Your base for job offers when the app isn't sharing your live location" : "Pre-filled when you book"}</span>
          </span>
        </button>
      </Section>

      <Section title="Emergency contact">
        <div className="card stack g-14">
          <p className="small muted">If you raise an emergency during a job, we text this person with where you are.</p>
          <Input label="Their name" value={eName} onChange={(e) => setEName(e.target.value)} error={errors["emergency.name"]} />
          <PhoneInput label="Their phone" value={ePhone} onChange={setEPhone} error={errors["emergency.phone"]} />
          <div className="row g-8">
            <Button
              variant="ink"
              loading={busy}
              onClick={() => {
                if (!eName.trim() || !validPhone(ePhone)) return setErrors({ "emergency.phone": "Enter their name and a Kenyan mobile number" });
                void save({ emergency: { name: eName.trim(), phone: ePhone } });
              }}
            >
              Save contact
            </Button>
            {me.emergency && (
              <Button variant="ghost" onClick={() => void save({ emergency: null }, "Removed")}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </Section>

      <Section title="Privacy">
        <div className="card stack g-14">
          <div className="row g-12">
            <ShieldCheck className="green" />
            <div className="grow stack g-4">
              <span className="strong">Share my location while working</span>
              <span className="small muted">Workers only. Used to offer you nearby jobs and shown to a client only while you're on their job.</span>
            </div>
            <Switch
              label="Share my location while working"
              checked={Boolean(me.locationConsentAt)}
              onChange={(v) => void save({ locationConsent: v }, v ? "Location sharing on" : "Location sharing off; you won't receive offers")}
            />
          </div>
          <div className="small">
            <Link to="/legal/privacy" className="link">
              Privacy notice
            </Link>{" "}
            ·{" "}
            <Link to="/legal/terms" className="link">
              Terms
            </Link>{" "}
            ·{" "}
            <Link to="/legal/policies" className="link">
              Fees and cancellations
            </Link>
          </div>
        </div>
      </Section>

      <div className="stack g-8">
        <Button
          icon={<LogOut />}
          onClick={() => {
            logout();
            nav("/");
          }}
        >
          Sign out
        </Button>
        <Button variant="ghost" icon={<Trash2 />} onClick={() => setDel(true)}>
          Delete my account
        </Button>
      </div>

      <Sheet open={homeOpen} onClose={() => setHomeOpen(false)} title="Primary location">
        <div className="stack g-16">
          <AddressPicker value={home} onChange={setHome} />
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!home}
            loading={busy}
            onClick={async () => {
              if (home && (await save({ home }))) setHomeOpen(false);
            }}
          >
            Save location
          </Button>
        </div>
      </Sheet>

      <Sheet open={del} onClose={() => setDel(false)} title="Delete your account?">
        <div className="stack g-16">
          <Notice tone="warn" icon={<User />}>
            We remove your name, email, addresses, emergency contact and any ID documents. Records of past jobs and payments are kept, without your profile, because the law requires financial records.
          </Notice>
          <Button
            variant="danger"
            size="lg"
            block
            loading={busy}
            onClick={async () => {
              try {
                await api.delete("/me");
                logout();
                nav("/");
                toast("Your account has been deleted", "ok");
              } catch (e) {
                toast(errorMessage(e), "error");
              }
            }}
          >
            Delete my account
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
