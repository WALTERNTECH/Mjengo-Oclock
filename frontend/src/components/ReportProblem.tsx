import { Siren, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/toast";
import { Button, Notice, Segmented, Sheet, Textarea } from "./ui";

// Report a Problem (PRD 5, US-09): visible on the active job screen for clients and workers.
// The team is alerted at once; with an emergency, the person's emergency contact gets an SMS
// with their location.

const CATEGORIES = ["Safety concern", "Damage to property", "Behaviour", "Payment problem", "Worker or client not responding", "Something else"];

export function ReportProblem({ jobId, block }: { jobId?: string; block?: boolean }) {
  const { me } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"problem" | "emergency">("problem");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [message, setMessage] = useState("");
  const [alertContact, setAlertContact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    const pos = await new Promise<GeolocationPosition | null>((res) => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(res, () => res(null), { enableHighAccuracy: true, timeout: 6000, maximumAge: 60_000 });
    });
    try {
      const r = await api.post<{ contactAlerted: boolean }>("/safety/report", {
        jobId: jobId ?? null,
        kind,
        category: kind === "emergency" ? "Emergency" : category,
        message,
        lat: pos?.coords.latitude ?? null,
        lng: pos?.coords.longitude ?? null,
        alertContact: kind === "emergency" || alertContact,
      });
      setOpen(false);
      setMessage("");
      toast(r.data.contactAlerted ? "Sent. Our team and your emergency contact have been alerted." : "Sent. Our team has been alerted and will contact you.", "ok");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="danger" block={block} icon={<TriangleAlert />} onClick={() => setOpen(true)}>
        Report a problem
      </Button>
      <Sheet open={open} onClose={() => !busy && setOpen(false)} title="Report a problem">
        <div className="stack g-16">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "problem", label: "A problem" },
              { value: "emergency", label: "Emergency" },
            ]}
          />
          {kind === "emergency" ? (
            <Notice tone="error" icon={<Siren />}>
              If you are in danger, call <a href="tel:999"><b>999</b></a> or <a href="tel:112"><b>112</b></a> first. Sending this alerts our team now
              {me?.emergency ? ` and texts ${me.emergency.name} with your location` : ""}.
            </Notice>
          ) : (
            <div className="chips">
              {CATEGORIES.map((c) => (
                <button key={c} type="button" className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <Textarea label="What's happening?" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} placeholder="A few words help the team act quickly" />
          {kind === "problem" && me?.emergency && (
            <label className="check">
              <input type="checkbox" checked={alertContact} onChange={(e) => setAlertContact(e.target.checked)} />
              <span>Also text my emergency contact ({me.emergency.name})</span>
            </label>
          )}
          {!me?.emergency && (
            <div className="small muted">
              No emergency contact yet. <Link to="/account" className="link">Add one</Link> so we can alert them.
            </div>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <Button variant={kind === "emergency" ? "danger" : "ink"} size="lg" block loading={busy} onClick={send}>
            {kind === "emergency" ? "Send emergency alert" : "Send to the team"}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
