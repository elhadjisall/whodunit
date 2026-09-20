import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import type { CaseState } from "../lib/store";
import { bracket } from "../lib/store";
import type { PublicCommit } from "../types";
import { cx, fmtDate, heatColor } from "../lib/ui";

/**
 * Every commit in the lineup as a heat tick, oldest → newest. Two needles: the Bayesian probe
 * (weighted median of the posterior) and a ghost of where classic git bisect would look next.
 */
export function TimelineRail({
  state,
  onInterrogate,
  setHover,
}: {
  state: CaseState;
  onInterrogate: (index: number) => void;
  setHover: (h: { commit: PublicCommit; x: number; y: number } | null) => void;
}) {
  const n = state.commits.length;
  const interactive = state.status === "awaiting";
  const { lo, hi } = bracket(state);
  const bayesIdx = state.targeting?.index ?? state.culprit?.commit.index ?? state.probes[state.probes.length - 1]?.index ?? state.awaiting?.autoIndex ?? null;
  const gitIdx = n ? Math.floor((Math.min(lo + 1, hi) + hi) / 2) : null;
  const pctOf = (i: number) => ((i + 0.5) / Math.max(1, n)) * 100;
  const probedBy = useMemo(() => {
    const m = new Map<number, "good" | "bad">();
    for (const p of state.probes) m.set(p.index, p.result);
    return m;
  }, [state.probes]);

  if (!n) {
    return (
      <div className="flex h-full items-center justify-center rounded-sm border border-dashed border-manila/20 font-mono text-[11px] text-manila/40">
        forensic timeline — the lineup appears when a case opens
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col rounded-sm bg-charcoal-2/80 px-3 pb-1 pt-1 ring-1 ring-black/40">
      {/* header labels */}
      <div className="flex items-center justify-between gap-3 overflow-hidden whitespace-nowrap font-mono text-[9px] text-manila/60">
        <div className="flex min-w-0 items-center gap-3 tracking-widest">
          <span className="tape shrink-0 px-1.5 text-[9px] font-bold">FORENSIC TIMELINE</span>
          <span className="truncate">
            #{0} {state.commits[0].short} <span className="text-emerald-400">known good</span> <span className="text-manila/30">→</span> #{n - 1} {state.commits[n - 1].short}{" "}
            <span className="text-crime">known bad (HEAD)</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rotate-45 bg-crime" /> bayes
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rotate-45 border border-manila/60" /> git bisect
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 bg-manila/10" /> possible [{lo}‥{hi}]
          </span>
        </div>
      </div>

      {/* ticks */}
      <div className="relative mt-5 flex-1">
        {/* possible bracket */}
        <motion.div
          className="absolute bottom-0 top-0 rounded-sm bg-manila/[0.07] ring-1 ring-manila/10"
          animate={{ left: `${(lo / n) * 100}%`, width: `${((hi - lo + 1) / n) * 100}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
        <div className="absolute inset-0 flex items-end gap-px">
          {state.commits.map((c) => {
            const heat = c.p ?? 0;
            const probed = probedBy.get(c.index);
            const isCulprit = state.culprit?.commit.index === c.index;
            const dead = state.prior && (c.index < lo || c.index > hi) && !probed;
            return (
              <button
                key={c.sha}
                onMouseEnter={(e) => setHover({ commit: c, x: e.clientX, y: e.clientY })}
                onMouseMove={(e) => setHover({ commit: c, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
                onClick={() => interactive && onInterrogate(c.index)}
                className={cx("group relative flex h-full flex-1 items-end", interactive ? "cursor-pointer" : "cursor-default")}
                aria-label={`#${c.index} ${c.short} ${c.subject}`}
              >
                <span
                  className={cx("rail-tick w-full rounded-t-[1px]", dead && "opacity-30")}
                  style={{
                    height: `${Math.max(8, 8 + heat * 92)}%`,
                    backgroundColor: isCulprit ? "#ff5c6a" : probed === "good" ? "#2fbf71" : probed === "bad" ? "#e63946" : heat > 0 ? heatColor(heat) : "rgba(235,220,185,0.18)",
                    boxShadow: isCulprit ? "0 0 12px #e63946" : undefined,
                  }}
                />
                {probed && !isCulprit && (
                  <span className={cx("absolute -top-3 left-1/2 -translate-x-1/2 font-mono text-[9px] font-bold", probed === "good" ? "text-emerald-400" : "text-crime")}>{probed === "good" ? "✓" : "✗"}</span>
                )}
                {isCulprit && <span className="pin absolute -top-4 left-1/2 -translate-x-1/2" />}
                <span className="pointer-events-none absolute inset-0 bg-white/0 group-hover:bg-white/10" />
              </button>
            );
          })}
        </div>

        {/* needles */}
        <AnimatePresence>
          {gitIdx !== null && !state.culprit && state.prior && (
            <motion.div
              key="git"
              className="needle-shadow pointer-events-none absolute -top-1 bottom-0 w-0 border-l border-dashed border-manila/50"
              initial={{ left: `${pctOf(gitIdx)}%`, opacity: 0 }}
              animate={{ left: `${pctOf(gitIdx)}%`, opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 90, damping: 18 }}
            >
              <span className="absolute -left-1 -top-1 h-2 w-2 rotate-45 border border-manila/70 bg-charcoal" />
              <span className="absolute -top-4 left-1.5 whitespace-nowrap font-mono text-[8px] text-manila/60">bisect #{gitIdx}</span>
            </motion.div>
          )}
          {bayesIdx !== null && (
            <motion.div
              key="bayes"
              className="needle-shadow pointer-events-none absolute -top-2 bottom-0 w-0 border-l-2 border-crime"
              initial={{ left: `${pctOf(bayesIdx)}%`, opacity: 0 }}
              animate={{ left: `${pctOf(bayesIdx)}%`, opacity: 1 }}
              transition={{ type: "spring", stiffness: 70, damping: 14 }}
            >
              <motion.span
                className="absolute -left-[5px] -top-1 h-[10px] w-[10px] rotate-45 bg-crime"
                animate={state.targeting ? { scale: [1, 1.4, 1] } : { scale: 1 }}
                transition={{ duration: 0.6, repeat: state.targeting ? Infinity : 0 }}
              />
              <span className="absolute -top-[18px] left-2 whitespace-nowrap font-mono text-[9px] font-bold text-crime">
                {state.targeting ? "PROBING" : state.culprit ? "CULPRIT" : "probe"} #{bayesIdx}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* axis */}
      <div className="mt-1 flex justify-between font-mono text-[9px] text-manila/50">
        <span>{fmtDate(state.commits[0].date)}</span>
        {[0.25, 0.5, 0.75].map((f) => {
          const i = Math.round((n - 1) * f);
          return (
            <span key={f}>
              #{i} · {fmtDate(state.commits[i].date)}
            </span>
          );
        })}
        <span>{fmtDate(state.commits[n - 1].date)}</span>
      </div>
    </div>
  );
}
