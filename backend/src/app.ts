import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { kickJobs, runDueJobs } from "./jobs.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { catalogRouter } from "./routes/catalog.routes.js";
import { jobsRouter } from "./routes/jobs.routes.js";
import { meRouter } from "./routes/me.routes.js";
import { invoiceRouter, mediaRouter, metricsRouter, notificationsRouter, safetyRouter } from "./routes/misc.routes.js";
import { mpesaRouter } from "./routes/mpesa.routes.js";
import { workerRouter } from "./routes/worker.routes.js";
import { notFound } from "./utils/http.js";

export function createApp() {
  const app = express();
  // Render puts Cloudflare and its own proxy in front: the visitor is three hops back.
  // Vercel's edge overwrites X-Forwarded-For with the visitor's address: one hop.
  app.set("trust proxy", process.env.VERCEL ? 1 : 3);
  app.disable("x-powered-by");

  const tileHosts = ["https://tile.openstreetmap.org", "https://api.mapbox.com"];
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:", ...tileHosts],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Location and camera are used by the app itself (tracking, ID selfies, job photos); nothing else.
  app.use((_req, res, next) => {
    res.set("Permissions-Policy", "geolocation=(self), camera=(self), microphone=(), payment=()");
    next();
  });
  app.use(cors({ origin: env.corsOrigin, credentials: false }));

  // Never write secrets from URLs (callback token, stream tickets, invoice tokens, media signatures) into the log.
  morgan.token("safe-url", (req) =>
    (req as express.Request).originalUrl
      .replace(/(\/api\/mpesa\/(?:callback|b2c\/result|b2c\/timeout)\/)[^/?]+/, "$1••••")
      .replace(/([?&])(ticket|t|s)=[^&]+/g, "$1$2=••••"),
  );
  app.use(
    morgan(env.nodeEnv === "production" ? ":remote-addr :method :safe-url :status :response-time ms" : "dev", {
      skip: (req) => req.url.startsWith("/assets/") || req.url === "/health" || req.url.startsWith("/api/worker/location") || env.nodeEnv === "test",
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use("/api/metrics", express.text({ type: "text/plain", limit: "4kb" }), (req, _res, next) => {
    // sendBeacon posts text/plain.
    if (typeof req.body === "string") {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        req.body = {};
      }
    }
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: env.nodeEnv === "test" ? 100_000 : 600,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: (req) => req.path.startsWith("/media/") || req.path.startsWith("/mpesa/callback/") || req.path.startsWith("/mpesa/b2c/") || req.path === "/notifications/events" || req.path === "/worker/location",
      message: { error: { code: "rate_limited", message: "Too many requests. Slow down for a minute." } },
    }),
  );
  app.use("/api", (_req, _res, next) => {
    kickJobs();
    next();
  });

  // Vercel Cron calls this once a day, so due work still runs on a day nobody opens the app.
  app.get("/api/cron/tick", async (req, res) => {
    const want = Buffer.from(`Bearer ${env.cronSecret}`);
    const got = Buffer.from(req.get("authorization") ?? "");
    if (!env.cronSecret || want.length !== got.length || !timingSafeEqual(want, got)) throw notFound();
    await runDueJobs();
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api", catalogRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/worker", workerRouter);
  app.use("/api/mpesa", mpesaRouter);
  app.use("/api/media", mediaRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/safety", safetyRouter);
  app.use("/api/invoice", invoiceRouter);
  app.use("/api/metrics", metricsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api", notFoundHandler);

  // The built app. Hashed assets cache forever; index.html and the service worker never do.
  const dist = env.webDist ?? path.resolve(process.cwd(), "../frontend/dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y", index: false }));
    app.get("/sw.js", (_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(dist, "sw.js")));
    app.use(express.static(dist, { index: false, maxAge: "1d" }));
    const index = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.set("Cache-Control", "no-cache").type("html").send(index);
    });
  }

  app.use(errorHandler);
  return app;
}
