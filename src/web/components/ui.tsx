import type { CSSProperties, ReactNode } from "react";
import type { RoundStatus } from "@shared/api";
import { fmtNumber } from "../lib/format";
import { initial, type Tone } from "../lib/project";

/** Material Symbols Rounded glyph. Decorative by default; pass `label` when it is the only content. */
export function Icon({ name, size = 20, fill = false, weight, className, style, label }: {
  name: string;
  size?: number;
  fill?: boolean;
  weight?: number;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  const s: CSSProperties = { fontSize: size, ...style };
  if (fill || weight) s.fontVariationSettings = `'FILL' ${fill ? 1 : 0}, 'wght' ${weight ?? 500}`;
  return (
    <span className={`icon${className ? " " + className : ""}`} style={s} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}>
      {name}
    </span>
  );
}

/** The split coin: two halves, the right one dropped a little. */
export function LogoMark({ size = 20, className }: { size?: number; className?: string }) {
  const w = size / 2;
  return (
    <span className={`logo-mark${className ? " " + className : ""}`} aria-hidden="true" style={{ gap: Math.max(2, size / 10) }}>
      <span className="logo-half logo-half-l" style={{ width: w, height: size, borderRadius: `${w}px 0 0 ${w}px` }} />
      <span className="logo-half logo-half-r" style={{ width: w, height: size, borderRadius: `0 ${w}px ${w}px 0`, transform: `translateY(${Math.round(size * 0.15)}px)` }} />
    </span>
  );
}

export function Logo({ size = 20, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      {wordmark && (
        <span className="logo-word" style={{ fontSize: size * 0.95 }}>
          split<span className="logo-accent">dummy</span>
        </span>
      )}
    </span>
  );
}

/** Loading state: the coin halves rock apart and back together. */
export function Loading({ label = "Loading", inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? "loading loading-inline" : "loading"} role="status" aria-live="polite">
      <LogoMark size={inline ? 18 : 36} className="logo-mark-loading" />
      <span className={inline ? "" : "sr-only"}>{label}</span>
    </div>
  );
}

const STATUS: Record<RoundStatus | "DISPUTED", { label: string; cls: string }> = {
  COLLECTING: { label: "Collecting", cls: "pill-amber" },
  SETTLING: { label: "Settling", cls: "pill-blue" },
  SETTLED: { label: "Settled", cls: "pill-green" },
  DISPUTED: { label: "Disputed", cls: "pill-red pill-square" },
};

export function StatusPill({ status }: { status: RoundStatus | "DISPUTED" }) {
  const s = STATUS[status];
  return (
    <span className={`pill ${s.cls}`}>
      <span className="pill-dot" aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** Collecting → Settling → Settled, ending in a checkered flag. */
export function FinishTrack({ progress, size = "md", label, decorative }: {
  progress: [number, number, number];
  size?: "sm" | "md" | "lg";
  label?: string;
  decorative?: boolean;
}) {
  const done = progress[2] >= 1;
  return (
    <div
      className={`track track-${size}${done ? " track-done" : ""}`}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : (label ?? "Collecting, then Settling, then Settled")}
    >
      {progress.map((p, i) => (
        <span key={i} className="track-seg" style={{ "--fill": `${Math.round(p * 100)}%` } as CSSProperties} />
      ))}
      <span className="track-flag" />
    </div>
  );
}

/** Amount with the ISO code after the number in small caps style. */
export function Amount({ minor, code, exponent, signed, tone, className }: {
  minor: string | bigint;
  code: string;
  exponent: number;
  signed?: boolean;
  tone?: "pos" | "neg" | "auto";
  className?: string;
}) {
  const v = typeof minor === "bigint" ? minor : BigInt(minor);
  const t = tone === "auto" ? (v > 0n ? "pos" : v < 0n ? "neg" : undefined) : tone;
  return (
    <span className={`amount${t ? " amount-" + t : ""}${className ? " " + className : ""}`}>
      {fmtNumber(v, exponent, signed)}
      <span className="amount-code">{code}</span>
    </span>
  );
}

export function Avatar({ name, tone, size = 34, ready, dim }: { name: string; tone: Tone; size?: number; ready?: boolean; dim?: boolean }) {
  return (
    <span
      className={`avatar tone-${tone}${ready ? " avatar-ready" : ""}${dim ? " avatar-dim" : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37) }}
      aria-hidden="true"
    >
      {initial(name)}
      {ready && (
        <span className="avatar-check">
          <Icon name="check" size={12} weight={700} />
        </span>
      )}
    </span>
  );
}

export function Meta({ icon, children, size = 15 }: { icon: string; children: ReactNode; size?: number }) {
  return (
    <span className="meta-item">
      <Icon name={icon} size={size} />
      {children}
    </span>
  );
}

export function Banner({ tone = "blue", icon, children, action, role }: {
  tone?: "blue" | "green" | "amber" | "red" | "neutral";
  icon?: string;
  children: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={`banner banner-${tone}`} role={role}>
      {icon && <Icon name={icon} size={18} />}
      <div className="banner-body">{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} className="empty-icon" />
      <b className="empty-title">{title}</b>
      {children && <div className="empty-body">{children}</div>}
      {action}
    </div>
  );
}
