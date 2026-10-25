import { ChevronLeft, CircleAlert, CircleCheck, HardHat, Info, Minus, Plus, Shovel, Star, TriangleAlert, Wrench, X, Zap } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { initials, STATUS_LABEL, STATUS_TONE } from "../lib/format";
import type { JobStatus } from "../types";

// ——— Buttons ———

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ink" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
};
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "outline", size = "md", block, loading, icon, children, className = "", disabled, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn ${variant !== "outline" ? `btn-${variant}` : ""} ${size !== "md" ? `btn-${size}` : ""} ${block ? "btn-block" : ""} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
});

export function LinkButton({ to, variant = "outline", size = "md", block, icon, children, className = "" }: { to: string; variant?: BtnProps["variant"]; size?: BtnProps["size"]; block?: boolean; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={`btn ${variant !== "outline" ? `btn-${variant}` : ""} ${size !== "md" ? `btn-${size}` : ""} ${block ? "btn-block" : ""} ${className}`}>
      {icon}
      {children}
    </Link>
  );
}

export const Spinner = () => <span className="spinner" aria-label="Loading" />;

export function BackButton({ to, label = "Back" }: { to?: string; label?: string }) {
  const nav = useNavigate();
  return (
    <button className="icon-btn back" aria-label={label} onClick={() => (to ? nav(to) : window.history.length > 1 ? nav(-1) : nav("/"))}>
      <ChevronLeft />
    </button>
  );
}

export function PageHead({ title, back, right }: { title: ReactNode; back?: string | true; right?: ReactNode }) {
  return (
    <div className="page-head">
      {back && <BackButton to={back === true ? undefined : back} />}
      <h1 className="grow">{title}</h1>
      {right}
    </div>
  );
}

// ——— Fields ———

export function Field({ label, hint, error, children, className = "", htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={`field ${className}`}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: string; wrapClass?: string };
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, wrapClass, id, className = "", ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid} className={wrapClass}>
      <input ref={ref} id={fid} className={`input ${className}`} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; hint?: ReactNode; error?: string };
export function Select({ label, hint, error, id, className = "", children, ...rest }: SelectProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid}>
      <select id={fid} className={`select ${className}`} aria-invalid={error ? true : undefined} {...rest}>
        {children}
      </select>
    </Field>
  );
}

type AreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: string };
export function Textarea({ label, hint, error, id, className = "", ...rest }: AreaProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid}>
      <textarea id={fid} className={`textarea ${className}`} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

/** Kenyan mobile number with a fixed +254 prefix; the value is kept as 07XXXXXXXX. */
export function PhoneInput({ value, onChange, label = "Phone number", error, hint, autoFocus }: { value: string; onChange: (v: string) => void; label?: string; error?: string; hint?: ReactNode; autoFocus?: boolean }) {
  const id = useId();
  const local = value.replace(/^\+?254/, "0");
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id}>
      <div className="input-group">
        <span className="prefix">+254</span>
        <input
          id={id}
          className="input num"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="712 345 678"
          autoFocus={autoFocus}
          value={local.replace(/^0/, "")}
          onChange={(e) => onChange("0" + e.target.value.replace(/\D/g, "").replace(/^(254|0)+/, "").slice(0, 9))}
          aria-invalid={error ? true : undefined}
        />
      </div>
    </Field>
  );
}
export const validPhone = (v: string) => /^0[17]\d{8}$/.test(v);

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ value, onChange, min, max, step = 1, format }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string }) {
  return (
    <div className="stepper">
      <button type="button" aria-label="Less" disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>
        <Minus size={18} />
      </button>
      <span>{format ? format(value) : value}</span>
      <button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>
        <Plus size={18} />
      </button>
    </div>
  );
}

// ——— Sheet (modal) ———

export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" style={wide ? { maxWidth: 720 } : undefined}>
        <div className="sheet-grip" />
        {title && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <button className="icon-btn" aria-label="Close" onClick={onClose}>
              <X />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ——— Bits ———

export function Notice({ tone = "info", children, icon }: { tone?: "info" | "ok" | "warn" | "error"; children: ReactNode; icon?: ReactNode }) {
  const I = tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : tone === "error" ? CircleAlert : Info;
  return (
    <div className={`notice ${tone === "info" ? "" : tone}`} role={tone === "error" ? "alert" : undefined}>
      {icon ?? <I />}
      <div className="grow">{children}</div>
    </div>
  );
}

export function Badge({ tone = "", children, icon }: { tone?: "" | "green" | "amber" | "red" | "ink"; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`badge ${tone}`}>
      {icon}
      {children}
    </span>
  );
}

export const StatusBadge = ({ status, label }: { status: JobStatus; label?: string }) => <Badge tone={STATUS_TONE[status]}>{label ?? STATUS_LABEL[status]}</Badge>;

export function Stars({ value, size }: { value: number; size?: number }) {
  return (
    <span className="stars" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={i <= Math.round(value) ? "on" : ""} style={size ? { width: size, height: size } : undefined} />
      ))}
    </span>
  );
}

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="stars input" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${i} star${i > 1 ? "s" : ""}`} onClick={() => onChange(i)}>
          <Star className={i <= value ? "on" : ""} />
        </button>
      ))}
    </div>
  );
}

export function Avatar({ src, name, size }: { src?: string | null; name: string; size?: "lg" }) {
  return src ? <img className={`avatar ${size ?? ""}`} src={src} alt="" /> : <div className={`avatar ${size ?? ""}`}>{initials(name)}</div>;
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="strong" style={{ color: "var(--ink)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export function Skeleton({ h = 80 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} />;
}

export function CategoryIcon({ id, size = 24 }: { id: string; size?: number }) {
  const I = id === "plumbing" ? Wrench : id === "electrical" ? Zap : id === "site_management" ? HardHat : Shovel;
  return <I width={size} height={size} />;
}
