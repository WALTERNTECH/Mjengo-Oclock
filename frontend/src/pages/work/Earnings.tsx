import { Banknote, ClipboardList } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "../../api/client";
import { Badge, Empty, PageHead, Skeleton, StatusBadge } from "../../components/ui";
import { dateTime, day, kes, WORKER_STATUS_LABEL } from "../../lib/format";
import type { JobStatus } from "../../types";

type Payout = { id: string; kind: string; amount: number; status: string; method: string; reference: string | null; createdAt: string; paidAt: string | null; ref: string; service: string };

export function Earnings() {
  const { data, loading } = useApi<{ totals: { paid: number; pending: number; week: number; tips: number; inEscrow: number }; payouts: Payout[] }>("/worker/earnings", { staleMs: 10_000 });
  return (
    <div className="stack g-20">
      <PageHead title="Earnings" back="/work" />
      {loading && <Skeleton h={200} />}
      {data && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="v">{kes(data.totals.week)}</div>
              <div className="k">Paid this week</div>
            </div>
            <div className="stat">
              <div className="v">{kes(data.totals.pending)}</div>
              <div className="k">On its way</div>
            </div>
            <div className="stat">
              <div className="v">{kes(data.totals.inEscrow)}</div>
              <div className="k">Awaiting approval</div>
            </div>
          </div>
          <p className="small muted">
            All time: {kes(data.totals.paid)} paid, including {kes(data.totals.tips)} in tips. Money awaiting approval is released when the client approves, or automatically 24 hours after you finish.
          </p>
          {!data.payouts.length && <Empty icon={<Banknote />} title="No payouts yet" />}
          <div className="list">
            {data.payouts.map((p) => (
              <div key={p.id} className="list-item">
                <div className="grow stack g-4">
                  <span className="strong">
                    {p.kind === "TIP" ? "Tip · " : ""}
                    {p.service}
                  </span>
                  <span className="small muted">
                    {p.ref} · {p.paidAt ? dateTime(p.paidAt) : day(p.createdAt)}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </span>
                </div>
                <div className="stack g-4" style={{ alignItems: "flex-end" }}>
                  <span className="num strong">{kes(p.amount)}</span>
                  <Badge tone={p.status === "PAID" ? "green" : p.status === "FAILED" ? "amber" : ""}>{p.status === "PAID" ? "Paid" : p.method === "bank" ? "Bank transfer pending" : p.status === "FAILED" ? "Retrying" : "Sending"}</Badge>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type Row = { id: string; ref: string; status: JobStatus; service: string; address: string; earn: number; scheduledFor: string | null; acceptedAt: string | null; client: string };

export function WorkHistory() {
  const { data, loading } = useApi<{ jobs: Row[] }>("/worker/jobs", { staleMs: 10_000 });
  return (
    <div className="stack g-16">
      <PageHead title="Job history" back="/work" />
      {loading && <Skeleton h={200} />}
      {data && !data.jobs.length && <Empty icon={<ClipboardList />} title="No jobs yet" />}
      <div className="stack g-10">
        {data?.jobs.map((j) => (
          <Link key={j.id} to={`/work/jobs/${j.id}`} className="card card-link row g-12">
            <span className="grow stack g-4">
              <span className="strong">{j.service}</span>
              <span className="small muted">
                {j.ref} · {j.client} · {j.acceptedAt ? day(j.acceptedAt) : ""}
              </span>
            </span>
            <span className="stack g-4" style={{ alignItems: "flex-end" }}>
              <StatusBadge status={j.status} label={WORKER_STATUS_LABEL[j.status]} />
              <span className="small num">{kes(j.earn)}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
