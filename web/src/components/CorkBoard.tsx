import { AnimatePresence, motion } from "framer-motion";
import { Hand, Pin, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseState } from "../lib/store";
import { topSuspects } from "../lib/store";
import type { PublicCommit } from "../types";
import { cx, hash01, useElementSize } from "../lib/ui";
import { Dossier } from "./Dossier";
import { CARD_H, CARD_W, Polaroid } from "./Polaroid";

interface Hover {
  commit: PublicCommit;
  x: number;
  y: number;
}

export function HoverLayer({ hover, state }: { hover: Hover | null; state: CaseState }) {
  if (!hover) return null;
  const W = 300;
  const H = 320;
  const x = Math.min(window.innerWidth - W - 12, hover.x + 18);
  const y = hover.y + H + 20 > window.innerHeight ? hover.y - H - 12 : hover.y + 18;
  return (
    <div className="pointer-events-none fixed z-[70]" style={{ left: x, top: Math.max(8, y) }}>
      <motion.div initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.12 }}>
        <Dossier commit={hover.commit} state={state} />
      </motion.div>
    </div>
  );
}

export function CorkBoard({
  state,
  onInterrogate,
  onAuto,
  setHover,
}: {
  state: CaseState;
  onInterrogate: (index: number) => void;
  onAuto: () => void;
  setHover: (h: Hover | null) => void;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boardRef);
  const suspects = useMemo(() => topSuspects(state, 12), [state.commits, state.similarity]); // eslint-disable-line react-hooks/exhaustive-deps
  const cardEls = useRef(new Map<number, HTMLElement>());
  const [anchors, setAnchors] = useState<Record<number, { x: number; y: number }>>({});
  const interactive = state.status === "awaiting";

  // Base layout: timeline order left→right, wrapped into rows, with a little "pinned by hand" jitter.
  const layout = useMemo(() => {
    const n = suspects.length;
    if (!n || !width || !height) return new Map<number, { x: number; y: number; r: number; z: number }>();
    const pad = 22;
    const rows = n <= 6 ? 1 : n <= 10 ? 2 : 3;
    const cols = Math.ceil(n / rows);
    const cellW = (width - pad * 2) / cols;
    const cellH = (height - pad * 2 - 20) / rows;
    const m = new Map<number, { x: number; y: number; r: number; z: number }>();
    suspects.forEach((c, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const jx = (hash01(c.sha, 1) - 0.5) * Math.min(28, Math.max(0, cellW - CARD_W));
      const jy = (hash01(c.sha, 2) - 0.5) * Math.min(24, Math.max(0, cellH - CARD_H));
      const x = pad + col * cellW + (cellW - CARD_W) / 2 + jx;
      const y = pad + 18 + row * cellH + (cellH - CARD_H) / 2 + jy;
      m.set(c.index, { x: Math.max(4, Math.min(width - CARD_W - 4, x)), y: Math.max(14, Math.min(height - CARD_H - 4, y)), r: (hash01(c.sha, 3) - 0.5) * 9, z: 10 + i });
    });
    return m;
  }, [suspects, width, height]);

  // Track live card anchors (pin positions) for the yarn, through springs and drags.
  useEffect(() => {
    let raf = 0;
    let last = "";
    const loop = () => {
      const board = boardRef.current?.getBoundingClientRect();
      if (board) {
        const next: Record<number, { x: number; y: number }> = {};
        for (const [idx, wrap] of cardEls.current) {
          const el = (wrap.firstElementChild as HTMLElement | null) ?? wrap;
          const r = el.getBoundingClientRect();
          next[idx] = { x: Math.round(r.left + r.width / 2 - board.left), y: Math.round(r.top + 6 - board.top) };
        }
        const sig = JSON.stringify(next);
        if (sig !== last) {
          last = sig;
          setAnchors(next);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Yarn: chain together suspects that touched the same source file.
  const yarn = useMemo(() => {
    const byFile = new Map<string, PublicCommit[]>();
    for (const c of suspects) for (const f of c.files) if (/^src\//.test(f)) byFile.set(f, [...(byFile.get(f) ?? []), c]);
    const edges: { a: number; b: number; file: string; hot: boolean }[] = [];
    const seen = new Set<string>();
    for (const [file, list] of byFile) {
      const sorted = [...list].sort((a, b) => a.index - b.index);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i].index;
        const b = sorted[i + 1].index;
        const key = `${a}-${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a, b, file, hot: (sorted[i].p ?? 0) > 0.3 || (sorted[i + 1].p ?? 0) > 0.3 });
      }
    }
    return edges;
  }, [suspects]);

  const culpritIdx = state.culprit?.commit.index;

  return (
    <div ref={boardRef} className="cork cork-frame relative h-full w-full select-none overflow-hidden rounded-sm">
      {/* phase ribbon */}
      <div className="pointer-events-none absolute left-3 top-2 z-30 flex items-center gap-2">
        <span className="tape px-2 py-[2px] font-mono text-[10px] font-bold tracking-[0.2em]">EVIDENCE BOARD</span>
        <AnimatePresence mode="wait">
          {state.phase && (
            <motion.span key={state.phase.phase} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="paper px-2 py-[1px] font-type text-[11px] uppercase tracking-widest">
              {state.phase.title}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* legend */}
      <div className="pointer-events-none absolute bottom-2 right-3 z-30 flex items-center gap-2 font-mono text-[9px] text-manila/80">
        <span>cold</span>
        <span className="heat h-[6px] w-20 rounded-sm" />
        <span>hot</span>
        <span className="ml-2 text-manila/50">P(culprit) · drag to rearrange · hover for the dossier</span>
      </div>

      {/* yarn */}
      <svg className="pointer-events-none absolute inset-0 z-[5] h-full w-full">
        {yarn.map((e) => {
          const A = anchors[e.a];
          const B = anchors[e.b];
          if (!A || !B) return null;
          const mx = (A.x + B.x) / 2;
          const my = (A.y + B.y) / 2 + 26 + Math.abs(A.x - B.x) * 0.08;
          return (
            <g key={`${e.a}-${e.b}`}>
              <path d={`M${A.x},${A.y} Q${mx},${my} ${B.x},${B.y}`} className={e.hot || e.a === culpritIdx || e.b === culpritIdx ? "yarn" : "yarn-dim"} />
              <text x={mx} y={my - 4} textAnchor="middle" className="fill-manila/60 font-mono" fontSize="8">
                {e.file.replace(/^src\//, "")}
              </text>
            </g>
          );
        })}
      </svg>

      {/* empty state */}
      {suspects.length === 0 && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <motion.div initial={{ opacity: 0, y: 10, rotate: -3 }} animate={{ opacity: 1, y: 0, rotate: -2 }} className="paper relative w-[360px] p-5 text-center">
            <div className="pin absolute -top-1.5 left-1/2 -translate-x-1/2" />
            <Pin className="mx-auto mb-2 text-crime" size={20} />
            <div className="font-type text-lg tracking-wide">NO SUSPECTS PINNED</div>
            <p className="mt-1 font-type text-[12px] leading-snug text-neutral-700">
              File a complaint and release the hounds. The bureau will pull every commit, diff, CI log and issue thread from Elasticsearch and pin the suspects here.
            </p>
            <div className="mt-3 text-[10px] font-mono text-neutral-600">{state.commits.length ? `${state.commits.length} commits in the lineup` : "lineup pending"}</div>
          </motion.div>
        </div>
      )}

      {/* polaroids */}
      <div className="absolute inset-0 z-10">
        {suspects.map((c) => {
          const base = layout.get(c.index);
          if (!base) return null;
          return (
            <div
              key={c.sha}
              ref={(el) => {
                if (el) cardEls.current.set(c.index, el);
                else cardEls.current.delete(c.index);
              }}
              className="absolute left-0 top-0"
              style={{ width: 0, height: 0 }}
            >
              <Polaroid
                commit={c}
                state={state}
                x={base.x}
                y={base.y}
                rotate={base.r}
                z={base.z}
                interactive={interactive}
                dragRef={boardRef}
                onHover={(e) => setHover({ commit: c, x: e.clientX, y: e.clientY })}
                onLeave={() => setHover(null)}
                onClick={() => interactive && onInterrogate(c.index)}
              />
            </div>
          );
        })}
      </div>

      {/* your move banner */}
      <AnimatePresence>
        {state.awaiting && (
          <motion.div
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -40, opacity: 0 }}
            className="absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-sm bg-amber px-3 py-1.5 font-mono text-[11px] font-bold text-ink shadow-lg"
          >
            <Hand size={14} className="animate-pulse" />
            <span>
              YOUR MOVE, DETECTIVE · step {state.awaiting.step} · click a mugshot or a tick on the rail
              {state.awaiting.autoCommit && (
                <>
                  {" "}
                  · suggested <b>#{state.awaiting.autoCommit.index} {state.awaiting.autoCommit.short}</b>
                </>
              )}
            </span>
            <button onClick={onAuto} className="typewriter-key flex items-center gap-1 rounded-sm px-2 py-[3px] text-[10px] font-bold text-manila hover:text-white">
              <Sparkles size={11} /> LET THE DETECTIVE CHOOSE <span className="kbd ml-1">A</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* culprit spotlight */}
      <AnimatePresence>
        {culpritIdx !== undefined && anchors[culpritIdx] && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={cx("pointer-events-none absolute inset-0 z-[8]")}
            style={{
              background: `radial-gradient(220px 260px at ${anchors[culpritIdx].x}px ${anchors[culpritIdx].y + 80}px, rgba(230,57,70,0.22), rgba(0,0,0,0.55) 70%)`,
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
