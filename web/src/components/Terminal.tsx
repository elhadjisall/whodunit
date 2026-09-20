import { AnimatePresence, motion } from "framer-motion";
import { Database, RadioTower, ScrollText } from "lucide-react";
import { useState } from "react";
import type { CaseState, LogKind, RadarEntry } from "../lib/store";
import type { PublicCommit } from "../types";
import { cx, fmtTime, useAutoScroll, useTeletype } from "../lib/ui";

/* ───────────── ANSI → spans (CI logs carry real escape codes) ───────────── */
const ANSI: Record<string, string> = { "30": "text-neutral-500", "31": "crt-red", "32": "text-phosphor", "33": "crt-amber", "34": "text-blue-300", "35": "text-fuchsia-300", "36": "crt-cyan", "37": "crt-white", "90": "crt-dim" };
export function Ansi({ text }: { text: string }) {
  const parts = text.split(/\u001b\[([0-9;]*)m/);
  const out: React.ReactNode[] = [];
  let cls = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) out.push(<span key={i} className={cls}>{parts[i]}</span>);
    } else {
      const code = parts[i].split(";").pop() ?? "0";
      cls = code === "0" ? "" : (ANSI[code] ?? "");
    }
  }
  return <>{out}</>;
}

const LEG_LABEL: Record<RadarEntry["legs"][number], string> = { bm25: "BM25", knn: "kNN·768d", rrf: "RRF k=60", rerank: "RERANK", aggs: "AGGS", esql: "ES|QL" };

function RadarEntryView({ e, latest }: { e: RadarEntry; latest: boolean }) {
  const shown = useTeletype(e.query, latest ? e.id : -1, 45);
  const lines = latest ? e.query.slice(0, shown) : e.query;
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <span className="crt-white">❯</span>
        <span className="crt-white font-semibold">{e.name}</span>
        <span className="crt-dim truncate">{Object.keys(e.args).length ? JSON.stringify(e.args).slice(0, 90) : ""}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          {e.legs.map((l) => (
            <span key={l} className={cx("rounded-[2px] border px-1 text-[8px] tracking-wider", l === "esql" ? "border-cyan-400/50 crt-cyan" : l === "aggs" ? "border-amber/50 crt-amber" : "border-phosphor/40")}>
              {LEG_LABEL[l]}
            </span>
          ))}
        </span>
      </div>
      {lines.map((l, i) => (
        <div key={i} className={cx("whitespace-pre pl-4", l.startsWith("|") || l.startsWith("FROM") ? "crt-cyan" : l.startsWith("→") ? "crt-amber" : l.startsWith("POST") || l.startsWith("GET") ? "crt-white" : "crt-dim")}>
          {l}
        </div>
      ))}
      {e.hits !== undefined && (
        <div className="pl-4 crt-amber">
          ← {e.hits} hits fused{e.legs.includes("rerank") ? " · reranked" : ""} · {Math.round(18 + (e.id % 7) * 3)} ms
        </div>
      )}
      {latest && shown < e.query.length && <span className="cursor-blink pl-4" />}
    </div>
  );
}

function Radar({ state }: { state: CaseState }) {
  const ref = useAutoScroll<HTMLDivElement>(state.radar.length + state.evidence.length);
  const last = state.radar[state.radar.length - 1];
  const searching = state.status === "running" && state.phase?.phase === "investigate";
  return (
    <div className="flex h-full min-h-0">
      {/* scope */}
      <div className="flex w-[118px] shrink-0 flex-col items-center border-r border-phosphor/15 p-2">
        <div className="relative h-[84px] w-[84px] rounded-full border border-phosphor/40 radar-rings">
          <div className={cx("radar-sweep absolute inset-[2px] rounded-full", !searching && "opacity-40")} />
          {state.evidence.slice(0, 12).map((e, i) => {
            const a = (i / 12) * Math.PI * 2 + (e.score * 1000) % 1;
            const r = 12 + ((e.order ?? i * 9) % 30);
            return <span key={e.id} className="absolute h-[3px] w-[3px] rounded-full bg-phosphor" style={{ left: 40 + Math.cos(a) * r, top: 40 + Math.sin(a) * r, boxShadow: "0 0 6px #00ff66" }} />;
          })}
        </div>
        <div className="mt-2 w-full space-y-[2px] font-mono text-[9px]">
          <div className="flex justify-between"><span className="crt-dim">queries</span><span>{state.radar.length}</span></div>
          <div className="flex justify-between"><span className="crt-dim">evidence</span><span>{state.evidence.length}</span></div>
          <div className="flex justify-between"><span className="crt-dim">vectors</span><span>768d</span></div>
          <div className="flex justify-between"><span className="crt-dim">fusion</span><span>rrf</span></div>
        </div>
        <div className="mt-auto flex flex-wrap justify-center gap-1">
          {(["bm25", "knn", "rrf", "rerank", "aggs", "esql"] as const).map((l) => (
            <span key={l} className={cx("rounded-[2px] border px-1 text-[7px] tracking-wider transition", last?.legs.includes(l) ? "border-phosphor bg-phosphor/20" : "border-phosphor/20 crt-dim")}>
              {LEG_LABEL[l]}
            </span>
          ))}
        </div>
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[10px] leading-[1.45]">
        {state.radar.length === 0 && (
          <div className="crt-dim">
            <div>whodunit radar v0.1 · elasticsearch serverless · indices wd-commits wd-hunks wd-logs wd-issues</div>
            <div>awaiting complaint<span className="cursor-blink" /></div>
          </div>
        )}
        {state.radar.map((e, i) => (
          <RadarEntryView key={e.id} e={e} latest={i === state.radar.length - 1} />
        ))}
      </div>
    </div>
  );
}

const KIND_CLS: Record<string, string> = { hunk: "border-phosphor text-phosphor", commit: "border-cyan-400 crt-cyan", "ci-log": "border-amber crt-amber", issue: "border-fuchsia-400 text-fuchsia-300" };

function EvidenceLocker({ state, setHover }: { state: CaseState; setHover: (h: { commit: PublicCommit; x: number; y: number } | null) => void }) {
  const max = Math.max(1e-9, ...state.evidence.map((e) => e.score));
  const byIdx = new Map(state.commits.map((c) => [c.index, c]));
  return (
    <div className="h-full overflow-auto p-2 font-mono text-[10px]">
      {state.evidence.length === 0 && <div className="crt-dim">no evidence on the desk yet</div>}
      <table className="w-full border-separate border-spacing-y-[2px]">
        <tbody>
          {state.evidence.map((e, i) => {
            const c = e.order !== undefined ? byIdx.get(e.order) : undefined;
            return (
              <motion.tr
                key={e.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.04, 0.6) }}
                className="align-top hover:bg-phosphor/5"
                onMouseEnter={(ev) => c && setHover({ commit: c, x: ev.clientX, y: ev.clientY })}
                onMouseLeave={() => setHover(null)}
              >
                <td className="w-5 pr-1 text-right crt-dim">{i + 1}</td>
                <td className="w-[52px] pr-2">
                  <span className={cx("rounded-[2px] border px-1 text-[8px] uppercase", KIND_CLS[e.kind])}>{e.kind}</span>
                </td>
                <td className="w-[52px] pr-2 crt-white">{e.sha ? e.sha.slice(0, 7) : "—"}</td>
                <td className="pr-2">
                  <div className="truncate crt-white">{e.title}</div>
                  <div className="line-clamp-1 crt-dim">{e.snippet.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ")}</div>
                </td>
                <td className="w-[90px] pr-2">
                  <div className="h-[5px] w-full rounded-sm bg-phosphor/10">
                    <div className="h-full rounded-sm bg-phosphor" style={{ width: `${(e.score / max) * 100}%`, boxShadow: "0 0 6px #00ff66" }} />
                  </div>
                  <div className="text-[8px] crt-dim">{e.score.toFixed(4)}</div>
                </td>
                <td className="w-[110px]">
                  <div className="flex gap-1">
                    {["bm25", "knn", "rerank"].map((l) => (
                      <span key={l} className={cx("rounded-[2px] border px-1 text-[7px] uppercase", e.via.includes(l) ? "border-phosphor/70" : "border-phosphor/15 crt-dim")}>
                        {l}
                      </span>
                    ))}
                  </div>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const LOG_CLS: Record<LogKind, string> = {
  sys: "crt-white",
  tool: "text-phosphor",
  esql: "crt-cyan",
  ok: "text-phosphor",
  warn: "crt-amber",
  err: "crt-red",
  agent: "text-manila/90 italic",
  probe: "crt-white",
  stamp: "crt-red font-bold",
  dim: "crt-dim",
};

function Dispatch({ state }: { state: CaseState }) {
  const ref = useAutoScroll<HTMLDivElement>(state.log.length);
  const lastKind = state.log[state.log.length - 1]?.kind;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-phosphor/15 px-2 py-1 font-mono text-[9px] crt-dim">
        <span>CH 3 · 154.845 MHz</span>
        <span className="flex h-2 flex-1 items-center gap-[2px] overflow-hidden">
          {Array.from({ length: 40 }).map((_, i) => (
            <motion.span key={i} className="block w-[3px] bg-phosphor/40" animate={{ height: state.status === "running" ? [2, 2 + Math.random() * 8, 2] : 2 }} transition={{ duration: 0.4 + (i % 5) * 0.1, repeat: Infinity }} />
          ))}
        </span>
        <span className={cx(lastKind === "err" ? "crt-red" : lastKind === "warn" ? "crt-amber" : "")}>{state.status.toUpperCase()}</span>
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[10px] leading-[1.45]">
        {state.log.length === 0 && (
          <div className="crt-dim">
            <div>[--:--:--] dispatch idle. static.</div>
            <div>[--:--:--] units on standby: investigator · reproduction · fixer</div>
          </div>
        )}
        <AnimatePresence initial={false}>
          {state.log.map((l) => (
            <motion.div key={l.id} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className={cx("whitespace-pre-wrap break-words", LOG_CLS[l.kind])}>
              <span className="crt-dim">[{fmtTime(l.t)}] </span>
              <Ansi text={l.text} />
            </motion.div>
          ))}
        </AnimatePresence>
        {(state.status === "running" || state.status === "awaiting") && <span className="cursor-blink text-phosphor" />}
      </div>
    </div>
  );
}

export function TerminalDeck({ state, setHover }: { state: CaseState; setHover: (h: { commit: PublicCommit; x: number; y: number } | null) => void }) {
  const [tab, setTab] = useState<"radar" | "evidence">("radar");
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,58fr)_minmax(0,42fr)] gap-2">
      <section className="crt flex min-h-0 flex-col rounded-sm ring-1 ring-phosphor/20">
        <header className="relative z-10 flex items-center gap-2 border-b border-phosphor/20 px-2 py-1 font-mono text-[10px]">
          <Database size={12} />
          <span className="font-semibold tracking-[0.2em]">ELASTICSEARCH RADAR</span>
          <span className="crt-dim">hybrid BM25 + kNN(gemini-embedding-001) · RRF · ES|QL · aggregations</span>
          <div className="ml-auto flex gap-1">
            {(["radar", "evidence"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cx("rounded-[2px] border px-2 py-[1px] uppercase tracking-wider", tab === t ? "border-phosphor bg-phosphor/20" : "border-phosphor/25 crt-dim hover:border-phosphor/60")}>
                {t === "radar" ? "queries" : `evidence ${state.evidence.length ? `(${state.evidence.length})` : ""}`}
              </button>
            ))}
          </div>
        </header>
        <div className="relative z-10 min-h-0 flex-1">{tab === "radar" ? <Radar state={state} /> : <EvidenceLocker state={state} setHover={setHover} />}</div>
      </section>
      <section className="crt flex min-h-0 flex-col rounded-sm ring-1 ring-phosphor/20">
        <header className="relative z-10 flex items-center gap-2 border-b border-phosphor/20 px-2 py-1 font-mono text-[10px]">
          <RadioTower size={12} />
          <span className="font-semibold tracking-[0.2em]">RADIO DISPATCH</span>
          <span className="crt-dim">agent reasoning · oracle synthesis · test runner</span>
          <ScrollText size={12} className="ml-auto crt-dim" />
        </header>
        <div className="relative z-10 min-h-0 flex-1">
          <Dispatch state={state} />
        </div>
      </section>
    </div>
  );
}
