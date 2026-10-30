import type { NextFunction, Request, Response } from "express";
import { db, one } from "../config/db.js";
import { background } from "../utils/background.js";
import { verifyToken, type AdminClaims, type UserClaims } from "../utils/security.js";
import { forbidden, unauthorized } from "../utils/http.js";

export type AuthUser = {
  id: string;
  phone: string;
  full_name: string;
  status: string;
  token_version: number;
  last_seen_at: Date;
  worker_status: string | null;
};
export type AdminRole = "owner" | "admin" | "ops" | "finance";
export type AuthAdmin = { id: string; email: string; name: string; role: AdminRole };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      admin?: AuthAdmin;
    }
  }
}

const bearer = (req: Request) => {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
};

// Account and worker standing are read on every request rather than trusted from the
// token, so a suspension takes effect immediately.
async function resolve(req: Request): Promise<AuthUser | null> {
  const token = bearer(req);
  if (!token) return null;
  const claims = verifyToken<UserClaims>(token, "user");
  if (!claims) return null;
  const u = await one<AuthUser>(
    db(),
    `select u.id, u.phone, u.full_name, u.status, u.token_version, u.last_seen_at, w.status as worker_status
       from users u left join worker_profiles w on w.user_id = u.id where u.id = $1`,
    [claims.sub],
  );
  if (!u || u.status !== "active" || u.token_version !== claims.tv) return null;
  if (Date.now() - new Date(u.last_seen_at).getTime() > 5 * 60_000) {
    background(db().query(`update users set last_seen_at = now() where id = $1`, [u.id]), "last-seen");
  }
  return u;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const u = await resolve(req);
  if (!u) throw unauthorized();
  req.user = u;
  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  req.user = (await resolve(req)) ?? undefined;
  next();
}

/** Worker routes: the person has started a worker application. */
export async function requireWorker(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, () => {});
  if (!req.user!.worker_status) throw forbidden("Apply as a worker first", "not_worker");
  next();
}

/** Job routes for workers: only approved workers receive or act on jobs (PRD 5, US-05). */
export async function requireApprovedWorker(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, () => {});
  if (req.user!.worker_status !== "approved") throw forbidden(req.user!.worker_status === "suspended" ? "Your worker account is paused for review" : "Your application hasn't been approved yet", "not_approved");
  next();
}

/** Admin routes need a token that has passed the authenticator step, and optionally a role. */
export function requireAdmin(...roles: AdminRole[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    const claims = token ? verifyToken<AdminClaims>(token, "admin") : null;
    if (!claims || !claims.mfa) throw unauthorized("Admin sign-in required");
    const a = await one<AuthAdmin & { token_version: number }>(db(), `select id, email, name, role, token_version from admin_users where id = $1`, [claims.sub]);
    if (!a || a.token_version !== claims.tv) throw unauthorized("Admin sign-in required");
    if (roles.length && a.role !== "owner" && !roles.includes(a.role)) throw forbidden("Your admin role cannot do this");
    req.admin = { id: a.id, email: a.email, name: a.name, role: a.role };
    next();
  };
}
