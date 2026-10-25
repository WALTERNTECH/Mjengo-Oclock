import type { Response } from "express";
import { randomBytes } from "node:crypto";

// Server-sent events to signed-in browsers: job updates, offers, live worker location,
// payment results and notifications. One process, so an in-memory registry is enough.

const streams = new Map<string, Set<Response>>();
const tickets = new Map<string, { userId: string; until: number }>();

/** EventSource cannot send headers, so the page trades its token for a 60-second ticket. */
export function issueTicket(userId: string): string {
  const t = randomBytes(18).toString("base64url");
  tickets.set(t, { userId, until: Date.now() + 60_000 });
  return t;
}
export function redeemTicket(t: string): string | null {
  const v = tickets.get(t);
  tickets.delete(t);
  return v && v.until > Date.now() ? v.userId : null;
}

export function attach(userId: string, res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 4000\n\n`);
  let set = streams.get(userId);
  if (!set) streams.set(userId, (set = new Set()));
  set.add(res);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    set!.delete(res);
    if (!set!.size) streams.delete(userId);
  });
}

export function emit(userId: string, event: string, data: unknown) {
  const set = streams.get(userId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(frame);
}

export const isOnline = (userId: string) => streams.has(userId);

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of tickets) if (v.until < now) tickets.delete(t);
}, 60_000).unref();
