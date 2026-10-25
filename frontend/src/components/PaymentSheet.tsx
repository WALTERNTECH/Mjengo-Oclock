import { Check, Info, Smartphone, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../api/client";
import { onLive, useAuth } from "../context/AuthContext";
import { kes, prettyPhone } from "../lib/format";
import type { Payment, Started } from "../types";
import { Button, Notice, PhoneInput, Sheet, validPhone } from "./ui";

// M-Pesa checkout: confirm the number, we send the STK prompt, the person enters their PIN
// on their phone, and the result arrives over the live stream (polled as a fallback).

export function PaymentSheet({
  open,
  onClose,
  title,
  amount,
  summary,
  start,
  onPaid,
  doneLabel = "Done",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  amount: number;
  summary?: ReactNode;
  start: (phone: string) => Promise<Started>;
  onPaid: (p: Payment) => void;
  doneLabel?: string;
}) {
  const { me } = useAuth();
  const [phone, setPhone] = useState("");
  const [stage, setStage] = useState<"form" | "sending" | "waiting" | "paid" | "failed">("form");
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [simulated, setSimulated] = useState(false);
  const [left, setLeft] = useState(90);
  const pid = useRef<string | null>(null);
  const paidRef = useRef(onPaid);
  paidRef.current = onPaid;

  useEffect(() => {
    if (open) {
      setPhone(me?.phone ? me.phone.replace(/^\+254/, "0") : "");
      setStage("form");
      setError(null);
      setPayment(null);
      pid.current = null;
    }
  }, [open, me?.phone]);

  const finish = (p: Payment) => {
    if (p.id !== pid.current || p.status === "PENDING") return;
    setPayment(p);
    setStage(p.status === "SUCCESS" ? "paid" : "failed");
    if (p.status === "SUCCESS") paidRef.current(p);
  };

  useEffect(() => {
    if (stage !== "waiting") return;
    const off = onLive("payment", (p: Payment) => finish(p));
    const poll = setInterval(async () => {
      if (!pid.current) return;
      try {
        const r = await api.get<{ payment: Payment }>(`/mpesa/payments/${pid.current}`);
        finish(r.data.payment);
      } catch {
        /* keep waiting */
      }
    }, 3000);
    const tick = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => {
      off();
      clearInterval(poll);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const send = async () => {
    setError(null);
    if (!validPhone(phone)) return setError("Enter a Safaricom number, like 0712 345 678");
    setStage("sending");
    try {
      const s = await start(phone);
      pid.current = s.paymentId;
      setSimulated(s.simulated);
      setLeft(90);
      setStage("waiting");
    } catch (e) {
      setError(errorMessage(e));
      setStage("form");
    }
  };

  const busy = stage === "sending" || stage === "waiting";
  return (
    <Sheet open={open} onClose={busy ? () => {} : onClose} title={stage === "paid" ? "Payment received" : stage === "failed" ? "Payment not completed" : title}>
      <div className="stack g-16">
        {(stage === "form" || stage === "sending") && (
          <>
            {summary}
            <div className="pay-amount">
              <span className="mpesa">
                <i /> M-Pesa
              </span>
              <span className="v">{kes(amount)}</span>
            </div>
            <PhoneInput label="M-Pesa number" value={phone} onChange={setPhone} error={error ?? undefined} hint="We'll send a payment prompt to this phone." autoFocus />
            <Button variant="primary" size="lg" block loading={stage === "sending"} onClick={send}>
              Send M-Pesa prompt
            </Button>
          </>
        )}

        {stage === "waiting" && (
          <div className="pay-wait">
            <div className="phone-icon">
              <Smartphone />
            </div>
            <h3>Check your phone</h3>
            <p className="muted small">
              Enter your M-Pesa PIN on {prettyPhone(`+254${phone.slice(1)}`)} to pay {kes(amount)} to Mjengo O'clock.
            </p>
            <div className="progress">
              <i style={{ width: `${(left / 90) * 100}%` }} />
            </div>
            {simulated && <Notice icon={<Info />}>Test mode: this confirms by itself in a few seconds and no money moves.</Notice>}
            {left === 0 && (
              <Button variant="ghost" onClick={() => setStage("form")}>
                Send a new prompt
              </Button>
            )}
          </div>
        )}

        {stage === "paid" && payment && (
          <div className="pay-wait">
            <div className="phone-icon ok">
              <Check />
            </div>
            <h2>{kes(payment.amount)}</h2>
            <p className="muted small">{payment.receipt ? `M-Pesa receipt ${payment.receipt}` : "Confirmed by M-Pesa"}</p>
            <Button variant="ink" size="lg" block onClick={onClose}>
              {doneLabel}
            </Button>
          </div>
        )}

        {stage === "failed" && (
          <div className="pay-wait">
            <div className="phone-icon fail">
              <X />
            </div>
            <p className="muted">{payment?.message ?? "M-Pesa could not complete the payment."}</p>
            <div className="row g-8" style={{ width: "100%" }}>
              <Button block onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" block onClick={() => setStage("form")}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
