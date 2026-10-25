import { ClipboardList } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "../api/client";
import { CategoryIcon, Empty, LinkButton, PageHead, Skeleton, StatusBadge } from "../components/ui";
import { day, kes, OPEN, when } from "../lib/format";
import type { JobStatus } from "../types";

type Row = { id: string; ref: string; status: JobStatus; outcome: string | null; service: string; category: string; address: string; total: number; paid: number; scheduledFor: string | null; createdAt: string; worker: string | null };

export default function Jobs() {
  const { data, loading } = useApi<{ jobs: Row[] }>("/jobs", { staleMs: 10_000 });
  const open = data?.jobs.filter((j) => OPEN.includes(j.status)) ?? [];
  const past = data?.jobs.filter((j) => !OPEN.includes(j.status)) ?? [];
  return (
    <div className="stack g-24">
      <PageHead title="My jobs" right={<LinkButton to="/" size="sm" variant="primary">Book</LinkButton>} />
      {loading && <Skeleton h={160} />}
      {data && !data.jobs.length && (
        <Empty icon={<ClipboardList />} title="No jobs yet">
          <p className="small">Book a plumber, electrician, site manager or general worker.</p>
          <LinkButton to="/" variant="primary">
            Choose a trade
          </LinkButton>
        </Empty>
      )}
      {open.length > 0 && <JobList title="Open" rows={open} />}
      {past.length > 0 && <JobList title="Past" rows={past} />}
    </div>
  );
}

function JobList({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="stack g-10">
      <div className="section-title">{title}</div>
      <div className="stack g-10">
        {rows.map((j) => (
          <Link key={j.id} to={`/jobs/${j.id}`} className="card card-link row g-12">
            <span className="cat-icon" style={{ width: 40, height: 40, borderRadius: 10 }}>
              <CategoryIcon id={j.category} size={20} />
            </span>
            <span className="grow stack g-4">
              <span className="strong">{j.service}</span>
              <span className="small muted">
                {j.ref} · {j.scheduledFor ? when(j.scheduledFor) : day(j.createdAt)}
                {j.worker ? ` · ${j.worker.split(" ")[0]}` : ""}
              </span>
            </span>
            <span className="stack g-4" style={{ alignItems: "flex-end" }}>
              <StatusBadge status={j.status} />
              <span className="small num muted">{kes(j.paid || j.total)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
