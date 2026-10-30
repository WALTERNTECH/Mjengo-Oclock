import { BadgeCheck, ChevronRight, MapPin, MapPinned, MessageSquare, ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/client";
import { AddressPicker } from "../components/AddressPicker";
import { CategoryIcon, Sheet, Skeleton, StatusBadge } from "../components/ui";
import { useAuth, useConfig } from "../context/AuthContext";
import { kes, ratePhrase } from "../lib/format";
import { saveWhere, useWhere } from "../lib/where";
import type { Category, ClientJob } from "../types";

/** Trades grouped as in the rate schedule: general labor, skilled trades, management. */
function sections(cats: Category[]): [string, Category[]][] {
  const out = new Map<string, Category[]>();
  for (const c of cats) {
    if (!c.services.length) continue;
    const k = c.section || "Trades";
    out.set(k, [...(out.get(k) ?? []), c]);
  }
  return [...out.entries()];
}

export default function Home() {
  const { me } = useAuth();
  const cfg = useConfig();
  const cats = useApi<{ categories: Category[] }>("/catalog", { staleMs: 60_000 });
  const where = useWhere(me?.home ?? null);
  const [picking, setPicking] = useState(false);
  const active = useApi<{ job: ClientJob }>(me?.activeJobId ? `/jobs/${me.activeJobId}` : null, { staleMs: 10_000 }).data?.job;

  return (
    <div className="stack g-24">
      <div className="where">
        <button className="where-btn" onClick={() => setPicking(true)}>
          <MapPin />
          <span className="grow stack">
            <span className="lbl">Where's the job?</span>
            <span className="val">{where ? where.label : "Choose an address in Nairobi"}</span>
          </span>
          <ChevronRight size={18} className="faint" />
        </button>
      </div>

      {active && (
        <Link to={`/jobs/${active.id}`} className="active-job">
          <span className="pulse" />
          <span className="grow stack">
            <span className="strong">{active.service.name}</span>
            <span className="small muted">
              {active.ref} · {active.worker ? active.worker.shortName : "Finding a worker"}
            </span>
          </span>
          <StatusBadge status={active.status} />
        </Link>
      )}

      <section className="hero">
        <h1>Book construction workers in Nairobi</h1>
        <p>General workers, plumbers, electricians, welders, fundis, painters, gypsum installers and site managers. See the rate before you book, follow your worker on the map, and pay only when you approve the work.</p>
      </section>

      {cats.data ? (
        sections(cats.data.categories).map(([section, list]) => (
          <section className="stack g-12" key={section} aria-label={section}>
            <div className="section-title">{section}</div>
            <div className="cats">
              {list.map((c) => {
                const first = c.services[0];
                return (
                  <Link key={c.id} to={`/book/${c.id}`} className="cat">
                    <span className="cat-icon">
                      <CategoryIcon id={c.id} />
                    </span>
                    <h3>{c.name}</h3>
                    <p>{c.blurb}</p>
                    {first && (
                      <span className="from">
                        {ratePhrase(first)}
                        {c.services.length > 1 ? ` · ${c.services.length} options` : ""}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </section>
        ))
      ) : (
        <div className="cats">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} h={150} />
          ))}
        </div>
      )}

      <section className="stack g-12" aria-labelledby="how">
        <div className="section-title" id="how">
          How it works
        </div>
        <div className="steps">
          <div className="step card">
            <span className="step-n">1</span>
            <div className="stack g-4">
              <h3>Book with the price upfront</h3>
              <p className="small muted">Pick the job, add photos and the address. You see the rate and our {cfg?.fees.clientPct ?? 9}% fee before you confirm.</p>
            </div>
          </div>
          <div className="step card">
            <span className="step-n">2</span>
            <div className="stack g-4">
              <h3>The nearest vetted worker accepts</h3>
              <p className="small muted">You see their verified name, photo and rating, follow them on the map, and get an SMS when they set off and arrive.</p>
            </div>
          </div>
          <div className="step card">
            <span className="step-n">3</span>
            <div className="stack g-4">
              <h3>Approve, then they're paid</h3>
              <p className="small muted">Your M-Pesa payment is held until you approve the work or raise a problem. Extras need your approval first.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="trust" aria-label="Why it's safe">
        <div className="trust-item">
          <BadgeCheck />
          <div className="stack g-4">
            <span className="strong">Every worker is vetted</span>
            <span className="small muted">National ID and selfie checked, and trade certificates for electricians and plumbers, before anyone gets a job.</span>
          </div>
        </div>
        <div className="trust-item">
          <Wallet />
          <div className="stack g-4">
            <span className="strong">Money held until you approve</span>
            <span className="small muted">Paid by M-Pesa into escrow. Cancel free before a worker accepts; every fee is shown before you confirm.</span>
          </div>
        </div>
        <div className="trust-item">
          <MessageSquare />
          <div className="stack g-4">
            <span className="strong">SMS at every step</span>
            <span className="small muted">Booking confirmed, worker on the way with an ETA, arrived, and job done with your invoice.</span>
          </div>
        </div>
      </section>

      <section className="workband">
        <div className="row g-10">
          <ShieldCheck color="var(--green-bright)" />
          <h2 style={{ color: "#fff" }}>Are you a fundi?</h2>
        </div>
        <p>Get jobs near you in Nairobi, see the pay before you accept, and get paid to M-Pesa when the client approves. We keep {100 - (cfg?.fees.workerPct ?? 9)}% of every job price for you.</p>
        <Link to="/work" className="btn btn-primary" style={{ alignSelf: "flex-start" }}>
          Apply to work
        </Link>
      </section>

      <Sheet open={picking} onClose={() => setPicking(false)} title="Where's the job?">
        <div className="stack g-16">
          <AddressPicker
            value={where}
            onChange={(a) => {
              saveWhere(a);
            }}
          />
          <button className="btn btn-primary btn-lg btn-block" disabled={!where} onClick={() => setPicking(false)}>
            <MapPinned size={18} /> Use this address
          </button>
        </div>
      </Sheet>
    </div>
  );
}
