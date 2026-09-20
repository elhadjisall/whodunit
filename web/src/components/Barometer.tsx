import { motion } from "framer-motion";
import { Activity, Dices, GitFork, Scale } from "lucide-react";
import type { CaseState } from "../lib/store";
import { confidence } from "../lib/store";
import { sfxKey } from "../lib/audio";
import { cx, pct } from "../lib/ui";

function Gauge({ value, max, label, tone, sub }: { value: number; max: number; label: string; tone: "grey" | "red"; sub?: string }) {
  const frac = Math.max(0, Math.min(1, value / max));
  const angle = -90 + frac * 180;
  const r = 44;
  const arc = (from: number, to: number) => {
    const a0 = (Math.PI * (from - 180)) / 180;
    const a1 = (Math.PI * (to - 180)) / 180;
    return `M${50 + r * Math.cos(a0)},${52 + r * Math.sin(a0)} A${r},${r} 0 0 1 ${50 + r * Math.cos(a1)},${52 + r * Math.sin(a1)}`;
  };
  return (
    <div className="relative">
      <svg viewBox="0 0 100 60" className="mx-auto h-[60px] w-full">
        <path d={arc(0, 180)} fill="none" stroke="rgba(235,220,185,0.15)" strokeWidth="7" strokeLinecap="round" />
        <motion.path d={arc(0, 180)} fill="none" stroke={tone === "red" ? "#e63946" : "#9a9384"} strokeWidth="7" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: frac }} transition={{ type: "spring", stiffness: 60, damping: 16 }} style={{ pathLength: frac }} />
        {Array.from({ length: 11 }).map((_, i) => {
          const a = (Math.PI * (i * 18 - 180)) / 180;
          return <line key={i} x1={50 + (r - 9) * Math.cos(a)} y1={52 + (r - 9) * Math.sin(a)} x2={50 + (r - 12) * Math.cos(a)} y2={52 + (r - 12) * Math.sin(a)} stroke="rgba(235,220,185,0.35)" strokeWidth="1" />;
        })}
        <motion.g animate={{ rotate: angle }} transition={{ type: "spring", stiffness: 60, damping: 12 }} style={{ originX: "50px", originY: "52px" }}>
          <polygon points="50,14 48,52 52,52" fill={tone === "red" ? "#ff5c6a" : "#ebdcb9"} />
          <circle cx="50" cy="52" r="3.5" fill="#0b0b0d" stroke="#ebdcb9" strokeWidth="1" />
        </motion.g>
      </svg>
      <div className="-mt-2 text-center">
        <div className={cx("font-poster text-[21px] leading-none", tone === "red" ? "text-crime" : "text-manila")}>{label}</div>
        {sub && <div className="mt-[2px] truncate font-mono text-[9px] text-manila/60">{sub}</div>}
      </div>
    </div>
  );
}

export function Barometer({
  state,
  eps,
  setEps,
  flaky,
  setFlaky,
  locked,
}: {
  state: CaseState;
  eps: number;
  setEps: (e: number) => void;
  flaky: boolean;
  setFlaky: (f: boolean) => void;
  locked: boolean;
}) {
  const n = state.commits.length || 108;
  const uniform = state.prior?.uniformProbes ?? Math.ceil(Math.log2(Math.max(2, n - 1)));
  const gitSteps = state.culprit?.uniformSteps ?? uniform;
  const conf = confidence(state);
  const probes = state.probes.length;
  const derailed = state.culprit?.gitVerdict !== undefined && state.culprit.gitVerdict !== state.culprit.commit.index;
  const entropyNow = (() => {
    let h = 0;
    for (const c of state.commits) if ((c.mass ?? 0) > 0) h -= (c.mass ?? 0) * Math.log2(c.mass ?? 1);
    return h;
  })();

  return (
    <div className="flex h-full flex-col overflow-y-auto rounded-sm bg-charcoal-2/80 p-2 ring-1 ring-black/40">
      <div className="flex items-center gap-2">
        <span className="tape px-1.5 py-[1px] font-mono text-[9px] font-bold tracking-[0.2em]">BAYESIAN PROBE BAROMETER</span>
        <Scale size={12} className="text-manila/60" />
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div className="rounded-sm bg-ink/50 p-1.5 ring-1 ring-manila/10">
          <div className="flex items-center gap-1 font-mono text-[9px] tracking-widest text-manila/60">
            <GitFork size={10} /> STANDARD git bisect
          </div>
          <Gauge value={gitSteps} max={10} label={`${state.culprit ? gitSteps : `≈${uniform}`} probes`} tone="grey" sub={`midpoint of ${n - 1} · blind to evidence`} />
          {derailed && (
            <div className="mt-1 text-center font-poster text-[11px] tracking-wider text-crime">
              DERAILED BY FLAKE → #{state.culprit?.gitVerdict} (INNOCENT)
            </div>
          )}
        </div>
        <div className="rounded-sm bg-ink/50 p-1.5 ring-1 ring-crime/30">
          <div className="flex items-center gap-1 font-mono text-[9px] tracking-widest text-crime">
            <Activity size={10} /> WHODUNIT weighted median
          </div>
          <Gauge value={conf} max={1} label={state.culprit ? `${probes} probes` : probes ? `${probes} probe${probes > 1 ? "s" : ""}` : "—"} tone="red" sub={state.prior ? `${pct(conf, 1)} confidence` : "posterior pending"} />
        </div>
      </div>

      {/* entropy strip */}
      <div className="mt-1.5 rounded-sm bg-ink/40 p-1.5 font-mono text-[9px] ring-1 ring-manila/10" title="Shannon entropy of the posterior over the lineup. Uniform = what git bisect knows; prior = after Elasticsearch evidence; now = after the probes so far.">
        <div className="flex justify-between text-manila/60">
          <span>
            uncertainty · uniform {state.prior ? state.prior.uniformBits.toFixed(2) : Math.log2(n - 1).toFixed(2)} → prior {state.prior ? state.prior.entropyBits.toFixed(2) : "—"} → now{" "}
            <span className="text-manila">{state.prior ? entropyNow.toFixed(2) : "—"}</span> bits
          </span>
          <span className="text-manila/50">{state.culprit ? `saved ${Math.max(0, gitSteps - probes)} test runs` : state.prior ? `90% set: ${state.prior.credible90} commits` : "each probe ≈ 1 bit"}</span>
        </div>
        <div className="mt-1 h-[6px] w-full overflow-hidden rounded-sm bg-manila/10">
          <motion.div className="h-full bg-gradient-to-r from-crime to-amber" animate={{ width: `${state.prior ? Math.max(2, (entropyNow / state.prior.uniformBits) * 100) : 100}%` }} transition={{ type: "spring", stiffness: 80, damping: 18 }} />
        </div>
      </div>

      {/* ledger */}
      <div className="mt-1.5 min-h-[44px] flex-1 overflow-auto rounded-sm bg-ink/40 p-1.5 font-mono text-[9px] ring-1 ring-manila/10">
        <div className="grid grid-cols-[18px_1fr_44px_58px] gap-x-1 text-manila/40">
          <span>#</span>
          <span>interrogated</span>
          <span className="text-right">P(bad)</span>
          <span className="text-right">verdict</span>
        </div>
        {state.probes.length === 0 && <div className="mt-1 text-manila/40">no probes yet — the ledger fills as suspects are interrogated</div>}
        {state.probes.map((p, i) => {
          const contradiction = state.probes.some((q) => q.index === p.index && q.result !== p.result);
          return (
            <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="grid grid-cols-[18px_1fr_44px_58px] items-center gap-x-1 border-t border-manila/5 py-[2px]">
              <span className="text-manila/60">{p.step}</span>
              <span className="truncate text-manila">
                #{p.index} {p.commit.short} <span className="text-manila/50">{p.commit.subject.slice(0, 26)}</span>
                {p.by === "player" && <span className="ml-1 rounded-[2px] bg-amber/30 px-1 text-[8px] text-amber">YOU</span>}
              </span>
              <span className="text-right tabular-nums text-manila/70">{pct(p.pBad)}</span>
              <span className={cx("text-right font-poster tracking-wider", p.result === "good" ? "text-emerald-400" : "text-crime")}>
                {p.flaked || contradiction ? <span className="text-amber">FLAKY·</span> : null}
                {p.result === "good" ? "CLEARED" : "BAD"}
              </span>
            </motion.div>
          );
        })}
        {state.culprit && (
          <div className="mt-1 border-t border-crime/40 pt-1 font-poster text-[11px] tracking-wider text-crime">
            CULPRIT #{state.culprit.commit.index} {state.culprit.commit.short} · {probes} vs {gitSteps} probes
          </div>
        )}
      </div>

      {/* controls */}
      <div className="mt-1.5 shrink-0 rounded-sm bg-ink/40 p-1.5 ring-1 ring-manila/10">
        <div className="flex items-center gap-2 font-mono text-[9px] text-manila/70">
          <span className="flex shrink-0 items-center gap-1">
            <Dices size={10} /> FLAKY TOLERANCE
          </span>
          <input
            type="range"
            min={0.01}
            max={0.3}
            step={0.01}
            value={eps}
            disabled={locked}
            onChange={(e) => {
              setEps(Number(e.target.value));
              sfxKey();
            }}
            className="min-w-0 flex-1 accent-crime disabled:opacity-50"
            title="How likely a single test run is to lie. Higher ε → the detective re-tests before condemning. 0.10 suits a flaky suite."
          />
          <span className="w-[52px] shrink-0 text-right tabular-nums text-manila">ε = {eps.toFixed(2)}</span>
        </div>
        <button
          disabled={locked}
          title="Every probe is a noisy observation with flake rate ε; a single lie cannot send the search down the wrong branch for good. Turn this on and the oracle will lie once during the case."
          onClick={() => {
            sfxKey();
            const next = !flaky;
            setFlaky(next);
            if (next && eps < 0.1) setEps(0.1);
          }}
          className={cx(
            "mt-1.5 flex w-full items-center justify-between rounded-sm border px-2 py-1 font-mono text-[10px] tracking-wider transition disabled:opacity-60",
            flaky ? "border-amber bg-amber/20 text-amber" : "border-manila/20 text-manila/60 hover:border-manila/40",
          )}
        >
          <span>SIMULATE FLAKY ORACLE {flaky && <span className="ml-1 text-[8px]">· ε≥0.10</span>}</span>
          <span className={cx("relative inline-block h-[14px] w-[26px] rounded-full transition", flaky ? "bg-amber" : "bg-manila/20")}>
            <span className={cx("absolute top-[2px] h-[10px] w-[10px] rounded-full bg-ink transition", flaky ? "left-[14px]" : "left-[2px]")} />
          </span>
        </button>
        {flaky && (
          <p className="mt-1 line-clamp-2 font-mono text-[8px] leading-snug text-amber/70">
            The oracle will lie once. Watch git bisect get derailed while the posterior absorbs the lie as ε-noise and re-interrogates.
          </p>
        )}
      </div>
    </div>
  );
}
