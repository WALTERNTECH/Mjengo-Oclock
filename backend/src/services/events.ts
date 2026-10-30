import { db, many, one } from "../config/db.js";
import { background } from "../utils/background.js";

// Live updates to signed-in apps: job updates, offers, live worker location, payment results
// and notifications. Each one is a row the app picks up on its next poll, every few seconds
// while it's open, so updates reach the app whichever server or function instance raised
// them. Housekeeping deletes rows after 15 minutes.

export function emit(userId: string, event: string, data: unknown) {
  background(db().query(`insert into live_events (user_id, event, data) values ($1, $2, $3)`, [userId, event, JSON.stringify(data)]), "events");
}

export type LiveEvent = { event: string; data: unknown };

/** Events for this user after the app's cursor. Without one, just the cursor to start from. */
export async function eventsSince(userId: string, after: number | null): Promise<{ cursor: number; events: LiveEvent[] }> {
  if (after == null) return { cursor: (await one<{ id: number }>(db(), `select coalesce(max(id), 0) as id from live_events`))!.id, events: [] };
  const rows = await many<{ id: number; event: string; data: unknown }>(db(), `select id, event, data from live_events where user_id = $1 and id > $2 order by id limit 200`, [userId, after]);
  return { cursor: rows.length ? rows[rows.length - 1].id : after, events: rows.map((r) => ({ event: r.event, data: r.data })) };
}
