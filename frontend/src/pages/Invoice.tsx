import { Printer } from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import { errorMessage, useApi } from "../api/client";
import { Logo } from "../components/Logo";
import { Button, Notice, Skeleton } from "../components/ui";
import { dateTime, kes } from "../lib/format";
import type { Invoice as Inv } from "../types";

// The itemised invoice from the completion SMS (US-04). Opens without signing in, with the token in the link.

type Full = Inv & { client: string; worker: string | null; address: string; completedAt: string; status: string; outcome: string | null };

export default function Invoice() {
  const { ref = "" } = useParams();
  const [params] = useSearchParams();
  const { data, error } = useApi<{ invoice: Full }>(`/invoice/${encodeURIComponent(ref)}?t=${encodeURIComponent(params.get("t") ?? "")}`);
  if (error) return <Notice tone="error">{errorMessage(error)}</Notice>;
  if (!data) return <Skeleton h={400} />;
  const inv = data.invoice;
  return (
    <div className="stack g-20">
      <div className="row between">
        <Logo />
        <Button size="sm" icon={<Printer />} onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <div className="invoice">
        <div className="invoice-head">
          <div className="stack g-4">
            <span className="strong" style={{ fontSize: 18 }}>
              Invoice {inv.number}
            </span>
            <span className="small muted">Completed {dateTime(inv.completedAt)}</span>
          </div>
          <span className="badge" style={{ background: "rgba(255,255,255,.12)", color: "#fff" }}>
            {inv.status === "HELD" ? "Awaiting approval" : inv.status === "FROZEN" ? "Under review" : inv.refunded ? "Settled with refund" : "Paid"}
          </span>
        </div>
        <div className="invoice-body stack g-12">
          <div className="small">
            <div>
              <span className="muted">Client:</span> {inv.client}
            </div>
            {inv.worker && (
              <div>
                <span className="muted">Worker:</span> {inv.worker}
              </div>
            )}
            <div>
              <span className="muted">Site:</span> {inv.address}
            </div>
          </div>
          <div>
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
                <span>Tip (to the worker in full)</span>
                <span className="num">{kes(inv.tip)}</span>
              </div>
            )}
            <div className="kv total">
              <span>Total</span>
              <span className="num">{kes(inv.total)}</span>
            </div>
            <div className="kv">
              <span>Paid by M-Pesa</span>
              <span className="num">{kes(inv.paid)}</span>
            </div>
            {inv.refunded > 0 && (
              <div className="kv">
                <span>Refunded</span>
                <span className="num">−{kes(inv.refunded)}</span>
              </div>
            )}
          </div>
          <p className="tiny muted">Mjengo O'clock connects clients with independent trade professionals in Nairobi. Approved extras appear as separate lines; anything not approved in the app is not charged.</p>
        </div>
      </div>
    </div>
  );
}
