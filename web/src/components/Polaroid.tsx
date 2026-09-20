import { motion, type PanInfo } from "framer-motion";
import { Crosshair } from "lucide-react";
import type { RefObject } from "react";
import type { CaseState } from "../lib/store";
import type { PublicCommit } from "../types";
import { authorHue, cx, heatColor, initials, pct } from "../lib/ui";
import { Stamp } from "./Stamp";

export const CARD_W = 132;
export const CARD_H = 172;

export function Mugshot({ commit, size = 84 }: { commit: PublicCommit; size?: number }) {
  const hue = authorHue(commit.author);
  return (
    <div className="photo mugshot-lines relative w-full overflow-hidden" style={{ height: size }}>
      {/* height-chart ticks */}
      <div className="absolute left-1 top-1 flex flex-col gap-[7px] opacity-40">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className="block h-px w-3 bg-white" />
        ))}
      </div>
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <defs>
          <radialGradient id={`g${hue}`} cx="50%" cy="35%" r="60%">
            <stop offset="0" stopColor={`hsl(${hue} 45% 62%)`} />
            <stop offset="1" stopColor={`hsl(${hue} 40% 32%)`} />
          </radialGradient>
        </defs>
        <ellipse cx="50" cy="118" rx="42" ry="40" fill={`hsl(${hue} 30% 22%)`} />
        <circle cx="50" cy="46" r="22" fill={`url(#g${hue})`} />
        <path d="M28 44 Q30 18 50 18 Q70 18 72 44 L66 38 Q50 26 34 38 Z" fill={`hsl(${hue} 30% 15%)`} />
        <text x="50" y="53" textAnchor="middle" fontSize="16" fontFamily="Anton, Impact, sans-serif" fill="rgba(255,255,255,.85)">
          {initials(commit.author)}
        </text>
      </svg>
      {/* booking placard */}
      <div className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded-[2px] bg-[#e9e2cf] px-1.5 py-[1px] font-mono text-[9px] font-semibold tracking-wider text-neutral-900 shadow">
        No. {String(commit.index).padStart(4, "0")} · {commit.short}
      </div>
    </div>
  );
}

export function Polaroid({
  commit,
  state,
  x,
  y,
  rotate,
  z,
  interactive,
  dragRef,
  onDrag,
  onHover,
  onLeave,
  onClick,
  compact = false,
}: {
  commit: PublicCommit;
  state: CaseState;
  x: number;
  y: number;
  rotate: number;
  z: number;
  interactive: boolean;
  dragRef?: RefObject<HTMLDivElement | null>;
  onDrag?: (info: PanInfo) => void;
  onHover?: (e: React.MouseEvent) => void;
  onLeave?: () => void;
  onClick?: () => void;
  compact?: boolean;
}) {
  const heat = commit.p ?? 0;
  const isTarget = state.targeting?.index === commit.index;
  const isCulprit = state.culprit?.commit.index === commit.index;
  const probes = state.probes.filter((p) => p.index === commit.index);
  const last = probes[probes.length - 1];
  const contradiction = probes.length > 1 && probes.some((p) => p.result !== last.result);
  const exonerated = !!state.prior && !isCulprit && !last && (commit.mass ?? 0) < 0.001 && heat < 0.02 && state.probes.length > 0;
  const suggested = state.awaiting?.autoIndex === commit.index;

  return (
    <motion.div
      drag={!!dragRef}
      dragConstraints={dragRef}
      dragElastic={0.08}
      dragMomentum={false}
      onDrag={(_, info) => onDrag?.(info)}
      layout
      initial={{ opacity: 0, y: y - 30, x, rotate: rotate - 6, scale: 0.9 }}
      animate={{ opacity: 1, x, y, rotate, scale: isTarget ? 1.06 : 1 }}
      transition={{ type: "spring", stiffness: 260, damping: 22 }}
      whileHover={{ scale: 1.08, rotate: 0, zIndex: 50 }}
      style={{ position: "absolute", left: 0, top: 0, width: CARD_W, zIndex: isTarget || isCulprit ? 40 : z }}
      className={cx("group cursor-grab active:cursor-grabbing", interactive && "cursor-pointer")}
      onMouseEnter={onHover}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      {/* pin */}
      <div className="pin absolute -top-1.5 left-1/2 z-10 -translate-x-1/2" />
      {/* targeting ring */}
      {isTarget && (
        <motion.div
          className="pointer-events-none absolute -inset-3 rounded-md border-2 border-crime"
          initial={{ opacity: 0.2, scale: 1.3 }}
          animate={{ opacity: [0.9, 0.3, 0.9], scale: [1, 1.04, 1] }}
          transition={{ duration: 0.9, repeat: Infinity }}
        />
      )}
      {suggested && !isTarget && (
        <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-amber px-1.5 py-[1px] font-mono text-[9px] font-bold text-ink shadow">
          DETECTIVE SUGGESTS
        </div>
      )}
      <div className={cx("polaroid relative p-1.5 pb-2", compact && "p-1 pb-1.5")}>
        <Mugshot commit={commit} size={compact ? 64 : 84} />
        <div className="mt-1.5 px-0.5">
          <div className="font-type text-[10px] leading-[1.15] text-neutral-900" style={{ height: compact ? 22 : 34, overflow: "hidden" }}>
            {commit.subject}
          </div>
          <div className="mt-1 flex items-center gap-1">
            <div className="h-[7px] flex-1 overflow-hidden rounded-sm bg-neutral-300/80 ring-1 ring-black/10">
              <motion.div className="h-full" animate={{ width: `${Math.max(heat > 0 ? 3 : 0, heat * 100)}%`, backgroundColor: heatColor(heat) }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
            </div>
            <span className="w-[34px] text-right font-mono text-[9px] tabular-nums text-neutral-700">
              {state.prior && commit.mass !== undefined ? pct(commit.mass, commit.mass < 0.1 ? 1 : 0) : heat > 0 ? pct(heat) : "—"}
            </span>
          </div>
        </div>
        {/* stamps */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
          {isCulprit ? (
            <Stamp text="CULPRIT" tone="red" size="lg" rotate={-18} heavy className="translate-y-2" />
          ) : contradiction ? (
            <Stamp key={`f${probes.length}`} text="FLAKY TEST" tone="amber" size="md" rotate={-14} className="translate-y-3" />
          ) : last ? (
            <Stamp key={`p${probes.length}`} text={last.result === "good" ? "CLEARED" : "BAD BUILD"} tone={last.result === "good" ? "green" : "red"} size="md" rotate={last.result === "good" ? -16 : 12} className="translate-y-3" />
          ) : exonerated ? (
            <Stamp text="EXONERATED" tone="ink" size="sm" rotate={-20} sound={false} className="translate-y-6 opacity-50" />
          ) : null}
        </div>
        {isTarget && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-crime/90 py-[2px] font-mono text-[9px] font-bold tracking-widest text-white">
            <Crosshair size={10} className="animate-spin" /> INTERROGATING
          </div>
        )}
        {commit.ci === "failed" && !last && !isCulprit && (
          <div className="tape-strip -right-3 top-2 flex items-center justify-center font-mono text-[8px] font-bold tracking-widest text-ink" style={{ ["--r" as string]: "28deg", width: 70, height: 16 }}>
            CI FLAKY
          </div>
        )}
      </div>
    </motion.div>
  );
}
