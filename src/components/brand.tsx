// Clio brand primitives. See brand/BRAND.md for specs.
// Use these everywhere the brand appears — do not inline SVG copies.
import type { CSSProperties } from "react";

type LunateProps = {
  size?: number;
  color?: string;
  dot?: boolean;
  dotColor?: string;
  style?: CSSProperties;
};

// The mark. ViewBox is fixed at 80x80; construction constants live in viewBox
// units so proportions hold at every render size. Don't override stroke/dot
// sizes unless building an outline-only marketing variant.
export function Lunate({
  size = 80,
  color = "var(--text-primary)",
  dot = true,
  dotColor = "var(--agent)",
  style,
}: LunateProps) {
  const r = 28;
  const cx = 40;
  const cy = 40;
  const x1 = cx + r * Math.cos(-Math.PI / 3);
  const y1 = cy + r * Math.sin(-Math.PI / 3);
  const x2 = cx + r * Math.cos(Math.PI / 3);
  const y2 = cy + r * Math.sin(Math.PI / 3);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      style={{ display: "block", ...style }}
      aria-hidden
    >
      <path
        d={`M ${x1} ${y1} A ${r} ${r} 0 1 0 ${x2} ${y2}`}
        fill="none"
        stroke={color}
        strokeWidth={20}
        strokeLinecap="round"
      />
      {dot && <circle cx={cx + r - 1} cy={cy} r={9} fill={dotColor} />}
    </svg>
  );
}

type ClioWordProps = {
  size?: number;
  weight?: number;
  /** When true, draws the trailing copper dot. Omit when followed by another
   *  mono token separated by `·` (title bar, status bar, breadcrumbs). */
  dot?: boolean;
  color?: string;
  style?: CSSProperties;
};

export function ClioWord({
  size = 56,
  weight = 500,
  dot = true,
  color = "var(--text-primary)",
  style,
}: ClioWordProps) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: size,
        fontWeight: weight,
        lineHeight: 1,
        letterSpacing: "-0.02em",
        color,
        display: "inline-flex",
        alignItems: "baseline",
        ...style,
      }}
    >
      clio
      {dot && (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: "0.18em",
            height: "0.18em",
            borderRadius: "50%",
            background: "var(--agent)",
            marginLeft: "0.08em",
          }}
        />
      )}
    </span>
  );
}

export type GlyphKind =
  | "open"
  | "entry"
  | "chronicle"
  | "witness"
  | "lookback"
  | "kept";

type GlyphProps = {
  kind: GlyphKind;
  size?: number;
  color?: string;
};

// Brand glyph system — extends (does not replace) the OpGlyph system that
// marks SQL operations. Brand glyphs appear in chrome and empty states.
export function Glyph({
  kind,
  size = 24,
  color = "var(--text-primary)",
}: GlyphProps) {
  const stroke = Math.max(1.6, size / 14);
  const dot = Math.max(1.4, size / 18);

  if (kind === "open") {
    return <Lunate size={size} color={color} />;
  }

  if (kind === "entry") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <line
          x1="3"
          y1="12"
          x2="21"
          y2="12"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <circle cx="6" cy="12" r={dot * 1.2} fill="var(--agent)" />
      </svg>
    );
  }

  if (kind === "chronicle") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <line x1="3" y1="7" x2="21" y2="7" stroke={color} strokeWidth={stroke} strokeLinecap="round" opacity="0.55" />
        <line x1="3" y1="12" x2="21" y2="12" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
        <line x1="3" y1="17" x2="14" y2="17" stroke={color} strokeWidth={stroke} strokeLinecap="round" opacity="0.55" />
        <circle cx="6" cy="12" r={dot * 1.2} fill="var(--agent)" />
      </svg>
    );
  }

  if (kind === "lookback") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M 20 12 A 8 8 0 1 0 12 20" />
        <polyline points="12 16 12 20 16 20" />
        <circle cx="20" cy="12" r={dot * 1.2} fill="var(--agent)" stroke="none" />
      </svg>
    );
  }

  if (kind === "witness") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
          d="M 16 5 A 9 9 0 1 0 16 19"
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        <circle cx="16" cy="12" r={dot * 1.4} fill="var(--agent)" />
      </svg>
    );
  }

  if (kind === "kept") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="4" y="4" width="16" height="16" rx="1.5" stroke={color} strokeWidth={stroke} />
        <circle cx="8" cy="8" r={dot * 1.2} fill="var(--agent)" />
        <line x1="11" y1="8" x2="17" y2="8" stroke={color} strokeWidth={stroke * 0.7} strokeLinecap="round" opacity="0.5" />
        <line x1="7" y1="13" x2="17" y2="13" stroke={color} strokeWidth={stroke * 0.7} strokeLinecap="round" opacity="0.5" />
        <line x1="7" y1="17" x2="14" y2="17" stroke={color} strokeWidth={stroke * 0.7} strokeLinecap="round" opacity="0.5" />
      </svg>
    );
  }

  return null;
}
