import { waitUntil } from "@vercel/functions";

// Work that outlives the request: live events, the simulated M-Pesa result, last-seen updates,
// the background jobs. On a long-running server such a promise simply finishes. On Vercel the
// function may be frozen once the response is sent, so the promise goes to waitUntil, which
// keeps the function alive until it settles. Off Vercel waitUntil does nothing.

export function background(p: Promise<unknown>, label: string) {
  waitUntil(p.catch((e) => console.error(`[${label}]`, e)));
}

/** A timer the function waits for. */
export function later(fn: () => unknown, ms: number, label: string) {
  background(
    new Promise<void>((resolve, reject) => {
      setTimeout(() => Promise.resolve().then(fn).then(() => resolve(), reject), ms).unref?.();
    }),
    label,
  );
}
