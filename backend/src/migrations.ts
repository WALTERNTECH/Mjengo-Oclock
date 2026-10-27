// Schema migrations, applied in order at boot. Never edit one that has shipped; add a new one.
// Row level security is on for every table with no policies: the server connects as the
// schema owner, and Supabase's anon and authenticated roles see nothing.

export type Migration = { id: string; sql: string };

const rls = (tables: string[]) => tables.map((t) => `alter table ${t} enable row level security;`).join("\n");

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    sql: `
create table users (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  full_name text not null default '',
  email text,
  home_label text,
  home_lat double precision,
  home_lng double precision,
  emergency_name text,
  emergency_phone text,
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  token_version int not null default 0,
  terms_accepted_at timestamptz,
  location_consent_at timestamptz,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  purpose text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_codes_phone on otp_codes (phone, purpose, created_at desc);

create table media (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  kind text not null,
  mime text not null,
  bytes bytea not null,
  width int,
  height int,
  created_at timestamptz not null default now()
);

create table categories (
  id text primary key,
  name text not null,
  trade text not null,
  blurb text not null default '',
  requires_certificate boolean not null default false,
  sort int not null default 0,
  active boolean not null default true
);

create table services (
  id uuid primary key default gen_random_uuid(),
  category_id text not null references categories(id),
  name text not null,
  description text not null default '',
  pricing text not null check (pricing in ('flat','hourly')),
  rate_kes int not null check (rate_kes > 0),
  min_hours numeric not null default 1 check (min_hours > 0),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index services_category on services (category_id, sort);

create table worker_profiles (
  user_id uuid primary key references users(id),
  category_id text references categories(id),
  bio text not null default '',
  years_experience int not null default 0,
  national_id_last4 text,
  national_id_enc text,
  id_front_media_id uuid,
  selfie_media_id uuid,
  certificate_media_id uuid,
  id_check_status text not null default 'not_started' check (id_check_status in ('not_started','pending','verified','failed','manual_review')),
  id_check_provider text,
  id_check_detail jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','submitted','more_info','approved','rejected','suspended')),
  review_reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  submitted_at timestamptz,
  approved_at timestamptz,
  payout_method text not null default 'mpesa' check (payout_method in ('mpesa','bank')),
  payout_phone text,
  bank_name text,
  bank_branch text,
  bank_account_name text,
  bank_account_number text,
  available boolean not null default false,
  last_lat double precision,
  last_lng double precision,
  last_accuracy_m double precision,
  last_location_at timestamptz,
  jobs_completed int not null default 0,
  rating_sum int not null default 0,
  rating_count int not null default 0,
  cancellations int not null default 0,
  no_shows int not null default 0,
  flagged boolean not null default false,
  flag_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index worker_dispatch on worker_profiles (category_id, status, available);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  client_id uuid not null references users(id),
  client_key text,
  service_id uuid references services(id),
  service_name text not null,
  category_id text not null references categories(id),
  pricing text not null check (pricing in ('flat','hourly')),
  rate_kes int not null,
  hours numeric not null default 1,
  base_kes int not null,
  client_fee_pct numeric not null,
  client_fee_kes int not null,
  total_kes int not null,
  worker_fee_pct numeric not null,
  address text not null,
  lat double precision not null,
  lng double precision not null,
  address_notes text not null default '',
  description text not null default '',
  scheduled_for timestamptz,
  status text not null default 'PENDING_PAYMENT' check (status in ('PENDING_PAYMENT','SCHEDULED','SEARCHING','UNASSIGNED','ACCEPTED','EN_ROUTE','ON_SITE','IN_PROGRESS','COMPLETED','DISPUTED','CLOSED','CANCELLED','EXPIRED')),
  outcome text check (outcome in ('done','cancelled','client_no_show','refunded','split','expired')),
  worker_id uuid references users(id),
  excluded_workers uuid[] not null default '{}',
  dispatch_round int not null default 0,
  dispatch_started_at timestamptz,
  unassigned_at timestamptz,
  confirmed_at timestamptz,
  accepted_at timestamptz,
  en_route_at timestamptz,
  eta_minutes int,
  eta_at timestamptz,
  on_site_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  approved_at timestamptz,
  auto_released boolean not null default false,
  closed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  worker_no_show_at timestamptz,
  client_no_show_at timestamptz,
  extras_kes int not null default 0,
  tip_kes int not null default 0,
  paid_kes int not null default 0,
  escrow text not null default 'NONE' check (escrow in ('NONE','HELD','FROZEN','RELEASED','REFUNDED','SPLIT')),
  worker_gross_kes int,
  worker_net_kes int,
  refund_kes int,
  platform_kes int,
  probation boolean not null default false,
  probation_reviewed_at timestamptz,
  invoice_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, client_key)
);
create index jobs_client on jobs (client_id, created_at desc);
create index jobs_worker on jobs (worker_id, status);
create index jobs_status on jobs (status, created_at);

create table job_offers (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  worker_id uuid not null references users(id),
  round int not null,
  distance_km numeric not null,
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN')),
  responded_at timestamptz,
  unique (job_id, worker_id, round)
);
-- One open offer per job, and a worker holds at most one open offer at a time.
create unique index job_offers_one_per_job on job_offers (job_id) where status = 'PENDING';
create unique index job_offers_one_per_worker on job_offers (worker_id) where status = 'PENDING';

create table job_photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  media_id uuid not null references media(id),
  kind text not null check (kind in ('request','extra','dispute','completion','report','no_show')),
  ref_id uuid,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index job_photos_job on job_photos (job_id, kind);

-- The job's timeline and its audit trail: every status change, payment and override, with who did it.
create table job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  actor_type text not null check (actor_type in ('client','worker','admin','system')),
  actor_id uuid,
  kind text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index job_events_job on job_events (job_id, created_at);

create table extra_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  worker_id uuid not null references users(id),
  kind text not null check (kind in ('hours','materials')),
  hours numeric,
  amount_kes int not null check (amount_kes > 0),
  client_fee_kes int not null,
  reason text not null,
  photo_media_id uuid references media(id),
  status text not null default 'PENDING' check (status in ('PENDING','AWAITING_PAYMENT','APPROVED','DECLINED','EXPIRED')),
  responded_at timestamptz,
  created_at timestamptz not null default now()
);
create index extra_requests_job on extra_requests (job_id, created_at);

create table payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  purpose text not null check (purpose in ('JOB_HOLD','JOB_EXTRA','JOB_TIP')),
  job_id uuid not null references jobs(id),
  ref_id uuid,
  phone text not null,
  amount_kes int not null check (amount_kes > 0),
  account_ref text not null,
  description text not null,
  status text not null default 'PENDING' check (status in ('PENDING','SUCCESS','FAILED','CANCELLED')),
  driver text not null,
  mpesa_checkout_id text unique,
  merchant_request_id text,
  mpesa_receipt text,
  result_code text,
  result_desc text,
  raw_callback jsonb,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index payments_job on payments (job_id, created_at);
create index payments_pending on payments (status, created_at) where status = 'PENDING';

-- Money leaving escrow: the worker's share, tips, and refunds to clients.
create table payouts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  kind text not null check (kind in ('WORKER','TIP','REFUND')),
  user_id uuid not null references users(id),
  method text not null default 'mpesa' check (method in ('mpesa','bank')),
  phone text,
  bank jsonb,
  amount_kes int not null check (amount_kes > 0),
  status text not null default 'QUEUED' check (status in ('QUEUED','SENDING','PAID','FAILED')),
  attempts int not null default 0,
  conversation_id text,
  reference text,
  last_error text,
  recorded_by uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  paid_at timestamptz,
  unique (job_id, kind)
);
create index payouts_status on payouts (status, created_at);

create table ratings (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  rater_id uuid not null references users(id),
  ratee_id uuid not null references users(id),
  rater_role text not null check (rater_role in ('client','worker')),
  stars int not null check (stars between 1 and 5),
  review text not null default '',
  created_at timestamptz not null default now(),
  unique (job_id, rater_id)
);
create index ratings_ratee on ratings (ratee_id, created_at desc);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references jobs(id),
  raised_by uuid not null references users(id),
  reason text not null,
  details text not null default '',
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED')),
  decision text check (decision in ('RELEASE','REFUND','SPLIT')),
  worker_gross_kes int,
  note text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id),
  reporter_id uuid not null references users(id),
  reporter_role text not null check (reporter_role in ('client','worker')),
  kind text not null check (kind in ('problem','emergency')),
  category text not null,
  message text not null default '',
  lat double precision,
  lng double precision,
  contact_alerted boolean not null default false,
  status text not null default 'OPEN' check (status in ('OPEN','ACKNOWLEDGED','CLOSED')),
  handled_by uuid,
  handled_at timestamptz,
  admin_note text,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  sms_status text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on notifications (user_id, created_at desc);

-- Every text message, so failures can be retried and then shown in the app instead.
create table sms_outbox (
  id uuid primary key default gen_random_uuid(),
  to_phone text not null,
  body text not null,
  purpose text not null,
  user_id uuid,
  notification_id uuid,
  status text not null default 'QUEUED' check (status in ('QUEUED','SENT','FAILED','LOGGED')),
  attempts int not null default 0,
  provider_id text,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index sms_outbox_due on sms_outbox (status, next_attempt_at) where status = 'QUEUED';

create table admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  role text not null check (role in ('owner','admin','ops','finance')),
  password_hash text not null,
  totp_secret text,
  totp_enabled boolean not null default false,
  token_version int not null default 0,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

-- Things the operations team must look at: no worker found, no-shows, emergencies, suspensions.
create table admin_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  title text not null,
  body text not null default '',
  job_id uuid references jobs(id),
  user_id uuid references users(id),
  seen_by uuid,
  seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index admin_alerts_open on admin_alerts (created_at desc) where seen_at is null;

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_at on audit_log (created_at desc);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

${rls([
  "users", "otp_codes", "media", "categories", "services", "worker_profiles", "jobs", "job_offers", "job_photos", "job_events",
  "extra_requests", "payments", "payouts", "ratings", "disputes", "reports", "notifications", "sms_outbox", "admin_users",
  "admin_alerts", "audit_log", "settings", "schema_migrations",
])}
`,
  },
  {
    // Page-load times reported by phones, for the "under 3 seconds" target (PRD 2 and 10). No personal data.
    id: "002_perf_samples",
    sql: `
create table perf_samples (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  ms int not null check (ms between 0 and 120000),
  connection text,
  created_at timestamptz not null default now()
);
create index perf_samples_at on perf_samples (created_at desc);
alter table perf_samples enable row level security;
`,
  },
  {
    // The construction and site labour rate schedule: fixed 8-hour shifts with hourly overtime,
    // per-foot earthworks, and site visits priced by zone (Nairobi or out of station).
    id: "003_rate_schedule",
    sql: `
alter table categories add column section text not null default '';

alter table services drop constraint services_pricing_check;
alter table services add constraint services_pricing_check check (pricing in ('flat','hourly','shift','per_unit'));
-- What one rate buys: 'task', 'visit', 'shift', 'hour' or 'ft'.
alter table services add column unit_label text not null default '';
alter table services add column shift_hours numeric not null default 8 check (shift_hours > 0);
-- Hours beyond a shift are billed at this rate; null where the schedule gives none.
alter table services add column overtime_rate_kes int check (overtime_rate_kes > 0);
alter table services add column zone text not null default 'nairobi' check (zone in ('nairobi','outside'));

alter table jobs drop constraint jobs_pricing_check;
alter table jobs add constraint jobs_pricing_check check (pricing in ('flat','hourly','shift','per_unit'));
alter table jobs add column unit_label text not null default '';
alter table jobs add column quantity numeric not null default 1;
alter table jobs add column shift_hours numeric;
alter table jobs add column overtime_hours numeric not null default 0;
alter table jobs add column overtime_rate_kes int;
alter table jobs add column zone text not null default 'nairobi';

alter table extra_requests drop constraint extra_requests_kind_check;
alter table extra_requests add constraint extra_requests_kind_check check (kind in ('hours','materials','units'));
alter table extra_requests add column units numeric;
`,
  },
];
