// Every setting the server reads, in one place. Secrets come from the environment
// only; nothing here has a usable default in production.

export type Env = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  /** Public origin of this deployment, used for M-Pesa callbacks and links in SMS. */
  publicUrl: string;
  corsOrigin: string[];
  databaseUrl: string | null;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** 32-byte key that encrypts admin TOTP secrets and national ID numbers at rest. */
  masterKey: Buffer;
  /** Signs short-lived links to private photos (job photos, ID documents). */
  mediaKey: string;
  /** Lets the first admin account be created at /admin/setup while none exists. */
  adminSetupToken: string | null;
  /** Vercel Cron sends it as a bearer token to /api/cron/tick. */
  cronSecret: string;
  mpesa: {
    /** "daraja" talks to Safaricom; "simulated" confirms every prompt after a few seconds. */
    driver: "daraja" | "simulated";
    env: "sandbox" | "production";
    consumerKey: string;
    consumerSecret: string;
    shortcode: string;
    passkey: string;
    /** Buy Goods till, when the shortcode is a store number rather than a Paybill. */
    till: string;
    /** Secret path segment on the callback URL; Daraja signs nothing. */
    callbackToken: string;
    /** B2C pays workers and refunds clients. Needs a B2C-enabled shortcode kept funded. */
    b2c: {
      shortcode: string;
      initiator: string;
      /** The initiator password encrypted with Safaricom's certificate (the Daraja portal generates it). */
      securityCredential: string;
      commandId: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
    };
  };
  /** Celcom Africa bulk SMS. Without credentials messages are written to the log. */
  sms: { apiKey: string; partnerId: string; shortcode: string };
  /**
   * Show sign-in codes on screen. Only for running without an SMS account: anyone could
   * sign in as any number, so it is refused once Celcom credentials are present.
   */
  otpEcho: boolean;
  maps: {
    /** Server-side Mapbox token for geocoding and drive-time ETAs. Without it: Photon and a distance estimate. */
    mapboxToken: string;
    /** Public (URL-restricted) Mapbox token for map tiles in the browser. */
    mapboxPublicToken: string;
  };
  /** "manual": every ID goes to the admin queue. Automated checks plug in here (see services/idcheck.ts). */
  idVerifyDriver: "manual";
  /** Built frontend to serve, if present. */
  webDist: string | null;
};

function masterKey(raw: string | undefined, env: Env["nodeEnv"]): Buffer {
  if (raw) {
    const b = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (b.length !== 32) throw new Error("MASTER_KEY must be 32 bytes (64 hex chars or base64)");
    return b;
  }
  if (env === "production") throw new Error("MASTER_KEY is required in production");
  return Buffer.alloc(32, 7);
}

export function loadEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = (e.NODE_ENV === "production" ? "production" : e.NODE_ENV === "test" ? "test" : "development") as Env["nodeEnv"];
  const on = (v: string | undefined, dflt: boolean) => (v == null || v === "" ? dflt : /^(1|true|on|yes)$/i.test(v));
  const smsConfigured = Boolean(e.CELCOM_API_KEY && e.CELCOM_PARTNER_ID && e.CELCOM_SHORTCODE);
  const darajaConfigured = Boolean(e.MPESA_CONSUMER_KEY && e.MPESA_CONSUMER_SECRET && e.MPESA_PASSKEY);
  const vercelUrl = e.VERCEL_PROJECT_PRODUCTION_URL ? `https://${e.VERCEL_PROJECT_PRODUCTION_URL}` : undefined;
  const publicUrl = (e.PUBLIC_URL ?? e.RENDER_EXTERNAL_URL ?? vercelUrl ?? `http://localhost:${e.PORT ?? 4000}`).replace(/\/$/, "");
  const jwtSecret = e.JWT_SECRET ?? (nodeEnv === "production" ? "" : "dev-only-secret-change-me");

  const env: Env = {
    nodeEnv,
    port: Number(e.PORT ?? 4000),
    publicUrl,
    corsOrigin: (e.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    databaseUrl: e.DATABASE_URL || null,
    jwtSecret,
    jwtExpiresIn: e.JWT_EXPIRES_IN ?? "30d",
    masterKey: masterKey(e.MASTER_KEY, nodeEnv),
    mediaKey: e.MEDIA_SIGNING_KEY || jwtSecret,
    adminSetupToken: e.ADMIN_SETUP_TOKEN || (nodeEnv === "production" ? null : "local-setup"),
    cronSecret: e.CRON_SECRET ?? "",
    mpesa: {
      driver: (e.MPESA_DRIVER as "daraja" | "simulated") || (darajaConfigured ? "daraja" : "simulated"),
      env: e.MPESA_ENV === "production" ? "production" : "sandbox",
      consumerKey: e.MPESA_CONSUMER_KEY ?? "",
      consumerSecret: e.MPESA_CONSUMER_SECRET ?? "",
      shortcode: e.MPESA_SHORTCODE ?? "174379",
      passkey: e.MPESA_PASSKEY ?? "",
      till: e.MPESA_TILL ?? "",
      callbackToken: e.MPESA_CALLBACK_TOKEN ?? (nodeEnv === "production" ? "" : "dev-callback"),
      b2c: {
        shortcode: e.MPESA_B2C_SHORTCODE ?? "",
        initiator: e.MPESA_B2C_INITIATOR ?? "",
        securityCredential: e.MPESA_B2C_SECURITY_CREDENTIAL ?? "",
        commandId: (e.MPESA_B2C_COMMAND as Env["mpesa"]["b2c"]["commandId"]) || "BusinessPayment",
      },
    },
    sms: { apiKey: e.CELCOM_API_KEY ?? "", partnerId: e.CELCOM_PARTNER_ID ?? "", shortcode: e.CELCOM_SHORTCODE ?? "" },
    otpEcho: on(e.OTP_ECHO, !smsConfigured && nodeEnv !== "production") && !smsConfigured,
    maps: { mapboxToken: e.MAPBOX_TOKEN ?? "", mapboxPublicToken: e.MAPBOX_PUBLIC_TOKEN ?? "" },
    idVerifyDriver: "manual",
    webDist: e.WEB_DIST ?? null,
  };

  if (nodeEnv === "production") {
    const missing = [
      !env.databaseUrl && "DATABASE_URL",
      env.jwtSecret.length < 32 && "JWT_SECRET (32+ chars)",
      !env.mpesa.callbackToken && "MPESA_CALLBACK_TOKEN",
    ].filter(Boolean);
    if (missing.length) throw new Error(`Missing production settings: ${missing.join(", ")}`);
    if (env.mpesa.driver === "daraja" && !darajaConfigured) throw new Error("MPESA_DRIVER=daraja needs MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET and MPESA_PASSKEY");
  }
  if (env.otpEcho) console.warn("[auth] OTP_ECHO is on: sign-in codes are shown on screen. Connect Celcom Africa before real users arrive.");
  return env;
}

export const env = loadEnv();
