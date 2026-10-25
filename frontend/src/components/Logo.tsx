import { Link } from "react-router-dom";

/** The mark: a clock whose hands form a tick. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#0B0F0C" />
      <circle cx="32" cy="33" r="19.5" fill="none" stroke="#fff" strokeWidth="4" />
      <path d="M32 16.5v3.5M49.5 33H46M32 49.5V46M14.5 33H18" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M25 26.2 32 33 43.2 21.4" fill="none" stroke="#1DB954" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="33" r="2.6" fill="#1DB954" />
    </svg>
  );
}

export function Logo({ to = "/", suffix }: { to?: string; suffix?: string }) {
  return (
    <Link to={to} className="brand" aria-label="Mjengo O'clock home">
      <Mark />
      <span className="wordmark">
        Mjengo <b>O'clock</b>
        {suffix && <span style={{ color: "var(--muted)", fontWeight: 600, marginLeft: 8, fontSize: 15 }}>{suffix}</span>}
      </span>
    </Link>
  );
}
