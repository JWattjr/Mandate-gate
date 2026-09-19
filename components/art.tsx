/**
 * Inline SVG art for the "Treasury Quest" visual system: the Gatekeeper mascot,
 * the MandateGate mark, small role icons, and one-shot celebration sparkles.
 * Everything here is decorative (aria-hidden) unless a label is passed.
 */
import type { CSSProperties } from 'react';

export type Mood = 'idle' | 'waiting' | 'happy' | 'concerned';

/** The Gatekeeper: a friendly shield-bodied reviewer. */
export function Gatekeeper({ mood = 'idle', size = 96, className }: { mood?: Mood; size?: number; className?: string }) {
  const eyes =
    mood === 'happy' ? (
      <g fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinecap="square">
        <path d="M23 33l4-4 4 4" />
        <path d="M37 33l4-4 4 4" />
      </g>
    ) : mood === 'waiting' ? (
      <g fill="var(--ink)">
        <rect x="26" y="28" width="5" height="6" />
        <rect x="40" y="28" width="5" height="6" />
      </g>
    ) : (
      <g fill="var(--ink)">
        <rect x="24" y="28" width="5" height="6" />
        <rect x="38" y="28" width="5" height="6" />
      </g>
    );
  const mouth =
    mood === 'concerned' ? (
      <rect x="29" y="40" width="10" height="3" fill="var(--ink)" />
    ) : mood === 'waiting' ? (
      <rect x="31" y="40" width="6" height="3" fill="var(--ink)" />
    ) : (
      <path d="M27 39h14v3h-3v2h-8v-2h-3z" fill="var(--ink)" />
    );
  return (
    <svg
      className={`gatekeeper mood-${mood}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 68 72"
      aria-hidden="true"
    >
      {/* antenna with a small star */}
      <rect x="33" y="4" width="2" height="8" fill="var(--ink)" />
      <path className="gk-star" d="M34 0l1.6 3.2 3.4.5-2.5 2.4.6 3.4-3.1-1.6-3.1 1.6.6-3.4-2.5-2.4 3.4-.5z" fill="var(--butter)" stroke="var(--ink)" strokeWidth="1" />
      {/* shield body */}
      <path
        d="M34 11c9 5 17 6 24 6v19c0 16-10 26-24 33C20 62 10 52 10 36V17c7 0 15-1 24-6z"
        fill="var(--sky)"
        stroke="var(--ink)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* face plate */}
      <rect x="18" y="22" width="32" height="26" rx="7" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
      {eyes}
      {mouth}
      {/* cheeks */}
      <rect x="19" y="37" width="4" height="3" rx="1" fill="var(--tangerine)" opacity="0.55" />
      <rect x="45" y="37" width="4" height="3" rx="1" fill="var(--tangerine)" opacity="0.55" />
      {/* chest emblem: a tiny gate */}
      <g transform="translate(27 52)">
        <rect width="14" height="10" rx="2" fill="var(--mint)" stroke="var(--ink)" strokeWidth="1.5" />
        <path d="M4 10V5h6v5" fill="none" stroke="var(--ink)" strokeWidth="1.5" />
      </g>
      {mood === 'waiting' ? (
        <g className="gk-dots" fill="var(--ink)">
          <rect x="52" y="6" width="3" height="3" />
          <rect x="57" y="6" width="3" height="3" />
          <rect x="62" y="6" width="3" height="3" />
        </g>
      ) : null}
      {mood === 'happy' ? (
        <g fill="var(--butter)" stroke="var(--ink)" strokeWidth="1">
          <path d="M60 8l1.2 2.6 2.8.4-2 1.9.5 2.8-2.5-1.3-2.5 1.3.5-2.8-2-1.9 2.8-.4z" />
          <path d="M7 12l1 2 2 .3-1.5 1.4.4 2-1.9-1-1.9 1 .4-2L4 14.3l2-.3z" />
        </g>
      ) : null}
    </svg>
  );
}

/** The MandateGate mark: a pixel gate on a cream tile. */
export function Mark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--cream)" stroke="var(--cream)" strokeWidth="1" />
      <path d="M8 26V13h3v-3h3V7h4v3h3v3h3v13h-5v-7h-6v7z" fill="var(--tangerine)" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="miter" />
      <rect x="14" y="21" width="4" height="5" fill="var(--ink)" />
      <rect x="6" y="26" width="20" height="2" fill="var(--mint)" />
    </svg>
  );
}

export type IconName =
  | 'shield'
  | 'lock'
  | 'star'
  | 'flag'
  | 'check'
  | 'cross'
  | 'question'
  | 'scroll'
  | 'lens'
  | 'gate'
  | 'map'
  | 'log'
  | 'gear'
  | 'nodes'
  | 'undo'
  | 'target'
  | 'bolt';

const PATHS: Record<IconName, React.ReactNode> = {
  shield: <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" fill="none" />
    </>
  ),
  star: <path d="M12 2.5l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17l-5.6 2.9 1.1-6.3L2.9 9.2l6.3-.9z" />,
  flag: (
    <>
      <path d="M5 21V3" fill="none" />
      <path d="M5 4h12l-2.5 4L17 12H5z" />
    </>
  ),
  check: <path d="M4 12.5l5 5L20 6.5" fill="none" />,
  cross: <path d="M6 6l12 12M18 6L6 18" fill="none" />,
  question: (
    <>
      <path d="M8.5 9a3.5 3.5 0 116 2.4c-1.3 1-2.5 1.6-2.5 3.6" fill="none" />
      <rect x="11" y="18" width="2" height="2" />
    </>
  ),
  scroll: (
    <>
      <path d="M7 3h11v15a3 3 0 01-3 3H6a3 3 0 01-3-3v-2h4z" />
      <path d="M10 8h5M10 12h5" fill="none" />
    </>
  ),
  lens: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" fill="none" />
    </>
  ),
  gate: (
    <>
      <path d="M4 21V9l8-6 8 6v12h-5v-7H9v7z" />
    </>
  ),
  map: <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />,
  log: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" fill="none" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path
        d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"
        fill="none"
      />
    </>
  ),
  nodes: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8 7l3 9M16 7l-3 9M8.5 6h7" fill="none" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" fill="none" />
      <path d="M4 9h10a6 6 0 010 12h-3" fill="none" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
};

/** Small role icon. Filled shapes use currentColor at low weight; strokes use currentColor. */
export function Icon({ name, size = 18, label, className, style }: { name: IconName; size?: number; label?: string; className?: string; style?: CSSProperties }) {
  return (
    <svg
      className={`icon icon-${name}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillOpacity="0.18"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={style}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Deterministic 5×5 mirrored pixel avatar for a wallet address ("player badge"). */
export function PixelAvatar({ address }: { address: string }) {
  const hex = address.toLowerCase().replace(/^0x/, '').padEnd(40, '0');
  const palette = ['var(--tangerine)', 'var(--mint)', 'var(--lavender)', 'var(--butter)', 'var(--sky)'];
  const color = palette[parseInt(hex.slice(0, 2), 16) % palette.length];
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const on = parseInt(hex[y * 3 + x + 2], 16) % 2 === 0;
      if (!on) continue;
      cells.push(<rect key={`${x}-${y}`} x={x * 4 + 2} y={y * 4 + 2} width="4" height="4" fill={color} />);
      if (x < 2) cells.push(<rect key={`m${x}-${y}`} x={(4 - x) * 4 + 2} y={y * 4 + 2} width="4" height="4" fill={color} />);
    }
  }
  return (
    <svg className="pixel-avatar" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="var(--ink-2)" />
      {cells}
    </svg>
  );
}

/** Marching pixel blocks: the loading indicator. */
export function Loader({ label }: { label?: string }) {
  return (
    <span className="blocks" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** One-shot sparkle burst. Pure CSS animation, runs once on mount, hidden for reduced motion. */
export function Sparkles() {
  const bits = Array.from({ length: 14 }, (_, i) => i);
  return (
    <span className="sparkles" aria-hidden="true">
      {bits.map((i) => (
        <i key={i} style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  );
}

/** Soft decorative clouds and shapes for open page areas. */
export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <svg className="bd-cloud bd-cloud-1" viewBox="0 0 120 50">
        <path d="M20 45h80a15 15 0 000-30 22 22 0 00-40-8 18 18 0 00-30 10A14 14 0 0020 45z" />
      </svg>
      <svg className="bd-cloud bd-cloud-2" viewBox="0 0 120 50">
        <path d="M20 45h80a15 15 0 000-30 22 22 0 00-40-8 18 18 0 00-30 10A14 14 0 0020 45z" />
      </svg>
      <span className="bd-blob bd-blob-1" />
      <span className="bd-blob bd-blob-2" />
      <svg className="bd-star bd-star-1" viewBox="0 0 24 24">
        <path d="M12 2.5l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17l-5.6 2.9 1.1-6.3L2.9 9.2l6.3-.9z" />
      </svg>
      <svg className="bd-star bd-star-2" viewBox="0 0 24 24">
        <path d="M12 2.5l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17l-5.6 2.9 1.1-6.3L2.9 9.2l6.3-.9z" />
      </svg>
      <span className="bd-diamond bd-diamond-1" />
    </div>
  );
}
