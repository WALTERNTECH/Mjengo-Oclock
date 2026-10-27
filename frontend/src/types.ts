export type Me = {
  id: string;
  phone: string;
  fullName: string;
  email: string | null;
  home: { label: string; lat: number; lng: number } | null;
  emergency: { name: string; phone: string } | null;
  termsAcceptedAt: string | null;
  locationConsentAt: string | null;
  workerStatus: WorkerStatus | null;
  unread: number;
  activeJobId: string | null;
  createdAt: string;
};

export type WorkerStatus = "draft" | "submitted" | "more_info" | "approved" | "rejected" | "suspended";

export type Pricing = "flat" | "hourly" | "shift" | "per_unit";
export type Zone = "nairobi" | "outside";

export type Service = {
  id: string;
  name: string;
  description: string;
  pricing: Pricing;
  rate: number;
  /** "task", "visit", "shift", "hour" or "ft". */
  unit: string;
  /** "per task", "per 8-hour shift", "per foot"… */
  unitPhrase: string;
  /** Least that can be booked: hours (hourly) or units (per_unit). */
  minQty: number;
  shiftHours: number;
  overtimeRate: number | null;
  zone: Zone;
  active: boolean;
  sort: number;
};
export type Category = { id: string; name: string; trade: string; blurb: string; section: string; requiresCertificate: boolean; active: boolean; services: Service[] };

export type Config = {
  fees: { clientPct: number; workerPct: number };
  policy: {
    lateCancelFee: number;
    enRouteCancelFee: number;
    calloutFee: number;
    freeCancelMinutes: number;
    offerWindowSeconds: number;
    dispatchTimeoutMinutes: number;
    autoReleaseHours: number;
    disputeWindowHours: number;
    clientWaitMinutes: number;
    noShowGraceMinutes: number;
    locationStaleSeconds: number;
    serviceRadiusKm: number;
  };
  support: { phone: string | null; email: string | null };
  map: { tiles: string; attribution: string };
  centre: { lat: number; lng: number };
  payments: { simulated: boolean };
  sms: { connected: boolean; codesOnScreen: boolean };
};

export type Place = { label: string; detail: string; lat: number; lng: number };

export type JobStatus =
  | "PENDING_PAYMENT" | "SCHEDULED" | "SEARCHING" | "UNASSIGNED" | "ACCEPTED" | "EN_ROUTE" | "ON_SITE" | "IN_PROGRESS" | "COMPLETED" | "DISPUTED" | "CLOSED" | "CANCELLED" | "EXPIRED";

export type TimelineEvent = { kind: string; actor: string; at: string; detail: Record<string, unknown> };
export type Extra = { id: string; kind: "hours" | "materials" | "units"; hours: number | null; units: number | null; amount: number; fee: number; total: number; reason: string; photo: string | null; status: string; at: string };
export type PriceLine = { label: string; detail?: string; amount: number };
export type Invoice = {
  number: string;
  lines: PriceLine[];
  subtotal: number;
  feePct: number;
  fee: number;
  tip: number;
  total: number;
  paid: number;
  refunded: number;
  status: string;
  issuedAt: string | null;
};
export type CancelQuote = { allowed: boolean; fee: number; refund: number; rule: string; reason?: string };

type JobCommon = {
  id: string;
  ref: string;
  status: JobStatus;
  outcome: string | null;
  service: {
    id: string | null;
    name: string;
    category: string;
    pricing: Pricing;
    rate: number;
    hours: number;
    quantity: number;
    unit: string;
    unitPhrase: string;
    shiftHours: number | null;
    overtimeHours: number;
    overtimeRate: number | null;
    zone: Zone;
  };
  /** The booked work as billed: the rate, and overtime past a shift on its own line. */
  priceLines: PriceLine[];
  description: string;
  scheduledFor: string | null;
  createdAt: string;
  confirmedAt: string | null;
  acceptedAt: string | null;
  enRouteAt: string | null;
  etaMinutes: number | null;
  etaAt: string | null;
  onSiteAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  unassignedAt: string | null;
  escrow: string;
  address: string;
  lat: number;
  lng: number;
  addressNotes: string;
  photos: { url: string; kind: string; refId: string | null }[];
  extras: Extra[];
  timeline: TimelineEvent[];
};

export type WorkerCard = { id: string; name: string; shortName: string; phone: string | null; photo: string | null; rating: number | null; ratings: number; jobs: number; category: string; trade: string; years: number; verified: boolean };

export type ClientJob = JobCommon & {
  price: { base: number; clientFeePct: number; clientFee: number; total: number; extras: number; tip: number; paid: number };
  worker: WorkerCard | null;
  location: { lat: number; lng: number; at: string; stale: boolean; accuracy: number | null } | null;
  workerLate: boolean;
  cancel: CancelQuote;
  autoReleaseAt: string | null;
  disputeUntil: string | null;
  dispute: { reason: string; details: string; status: string; decision: string | null; note: string | null; created_at: string; decided_at: string | null } | null;
  myRating: { stars: number; review: string } | null;
  invoice: Invoice | null;
  invoiceUrl: string | null;
  payments: { id: string; purpose: string; amount: number; status: string; receipt: string | null; at: string }[];
  refund: { amount: number; status: string; reference: string | null } | null;
};

export type WorkerJob = JobCommon & {
  client: { name: string; phone: string | null; rating: number | null; ratings: number };
  earnings: { base: number; workerFeePct: number; baseNet: number; extras: number; extrasNet: number; expected: number; paidOut: number | null; tip: number };
  payouts: { kind: string; amount: number; status: string; reference: string | null; method: string }[];
  late: boolean;
  clientNoShowFrom: string | null;
  calloutFee: number;
  myRating: { stars: number; review: string } | null;
  theirRating: { stars: number; review: string } | null;
  dispute: { reason: string; status: string; decision: string | null; note: string | null } | null;
  probation: boolean;
  extraRates: { hourly: number | null; unit: number | null; unitLabel: string };
};

export type Offer = {
  offerId: string;
  jobId: string;
  ref: string;
  service: { name: string; category: string; pricing: Pricing; hours: number; quantity: number; unit: string; overtimeHours: number; zone: Zone };
  /** "Standard 8-hour shift + 2 h beyond the shift × KES 100", "120 feet × KES 60"… */
  summary: string;
  area: string;
  distanceKm: number;
  earn: number;
  description: string;
  scheduledFor: string | null;
  photos: { url: string }[];
  client: { rating: number | null; ratings: number };
  offeredAt: string;
  expiresAt: string;
};

export type WorkerProfile = {
  status: WorkerStatus;
  categoryId: string | null;
  category: string | null;
  requiresCertificate: boolean;
  bio: string;
  yearsExperience: number;
  nationalIdLast4: string | null;
  documents: { idFront: string | null; selfie: string | null; certificate: string | null };
  idCheck: string;
  reviewReason: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  payout: { method: "mpesa" | "bank"; phone: string | null; bankName: string | null; bankBranch: string | null; accountName: string | null; accountNumber: string | null };
  available: boolean;
  lastLocationAt: string | null;
  stats: { jobs: number; rating: number | null; ratings: number; cancellations: number; noShows: number };
  probationLeft: number;
  flagged: boolean;
};

export type Payment = { id: string; purpose: string; jobId: string; amount: number; status: "PENDING" | "SUCCESS" | "FAILED" | "CANCELLED"; receipt: string | null; message: string; simulated: boolean };
export type Started = { paymentId: string; amount: number; simulated: boolean; message: string };

export type Notification = { id: string; kind: string; title: string; body: string; link: string | null; sms_status: string | null; read_at: string | null; created_at: string };
