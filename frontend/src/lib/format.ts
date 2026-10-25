import type { JobStatus } from "../types";

export const kes = (n: number | null | undefined) => `KES ${Math.round(n ?? 0).toLocaleString("en-KE")}`;

const tz = "Africa/Nairobi";
export const time = (d: string | Date | number) => new Date(d).toLocaleTimeString("en-KE", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).toLowerCase();
export const day = (d: string | Date | number) => new Date(d).toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short", timeZone: tz });
export const when = (d: string | Date | number) => `${day(d)}, ${time(d)}`;
export const dateTime = (d: string | Date | number) => new Date(d).toLocaleString("en-KE", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });

export function ago(d: string | Date | number): string {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return day(d);
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

export const prettyPhone = (e164: string | null | undefined) => (e164 ? e164.replace(/^\+254(\d{3})(\d{3})(\d{3})$/, "0$1 $2 $3") : "");

export const STATUS_LABEL: Record<JobStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  SCHEDULED: "Scheduled",
  SEARCHING: "Finding a worker",
  UNASSIGNED: "No worker yet",
  ACCEPTED: "Worker assigned",
  EN_ROUTE: "On the way",
  ON_SITE: "On site",
  IN_PROGRESS: "In progress",
  COMPLETED: "Awaiting your approval",
  DISPUTED: "Under review",
  CLOSED: "Done",
  CANCELLED: "Cancelled",
  EXPIRED: "Not booked",
};

export const STATUS_TONE: Record<JobStatus, "" | "green" | "amber" | "red" | "ink"> = {
  PENDING_PAYMENT: "amber",
  SCHEDULED: "",
  SEARCHING: "green",
  UNASSIGNED: "amber",
  ACCEPTED: "green",
  EN_ROUTE: "green",
  ON_SITE: "green",
  IN_PROGRESS: "green",
  COMPLETED: "amber",
  DISPUTED: "red",
  CLOSED: "",
  CANCELLED: "",
  EXPIRED: "",
};

export const WORKER_STATUS_LABEL: Record<JobStatus, string> = {
  ...STATUS_LABEL,
  ACCEPTED: "Accepted",
  COMPLETED: "Waiting for client approval",
  CLOSED: "Paid",
  SEARCHING: "Re-dispatching",
};

export const ACTIVE: JobStatus[] = ["ACCEPTED", "EN_ROUTE", "ON_SITE", "IN_PROGRESS"];
export const OPEN: JobStatus[] = ["PENDING_PAYMENT", "SCHEDULED", "SEARCHING", "UNASSIGNED", ...ACTIVE, "COMPLETED", "DISPUTED"];

/** A per-device key so a retried booking never creates two jobs. */
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
