import { CheckCircle2, FileCode2, Fingerprint, GitCommitHorizontal, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import type { CaseState } from "../lib/store";
import type { PublicCommit } from "../types";
import { cx, fmtDate, pct } from "../lib/ui";

/** The hover card: everything the bureau knows about one commit. */
export function Dossier({ commit, state }: { commit: PublicCommit; state: CaseState }) {
  const sim = state.similarity[commit.sha];
  const maxSim = Math.max(1e-9, ...Object.values(state.similarity));
  const via = state.via[commit.sha] ?? [];
  const probe = [...state.probes].reverse().find((p) => p.index === commit.index);
  const contradiction = state.probes.filter((p) => p.index === commit.index).some((p, _, all) => all.some((q) => q.result !== p.result));
  const isCulprit = state.culprit?.commit.index === commit.index;
  const files = commit.files.filter((f) => !/^(docs|fixtures|\.github)\//.test(f) && f !== "CHANGELOG.md" && f !== "README.md");
  const shown = files.length ? files : commit.files;
  return (
    <div className="tooltip-card w-[300px] rounded-sm p-3 font-mono text-[11px] leading-snug">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-type text-[13px] font-bold tracking-wide">
            No. {String(commit.index).padStart(3, "0")} · <span className="font-mono">{commit.short}</span>
          </div>
          <div className="text-[10px] text-neutral-600">
            {commit.author} · {fmtDate(commit.date)}
          </div>
        </div>
        {isCulprit ? (
          <span className="stamp stamp-red text-[9px]" style={{ transform: "rotate(-8deg)" }}>
            culprit
          </span>
        ) : probe ? (
          <span className={cx("stamp text-[9px]", probe.result === "good" ? "stamp-green" : "stamp-red")} style={{ transform: "rotate(-8deg)" }}>
            {probe.result === "good" ? "cleared" : "bad build"}
          </span>
        ) : null}
      </div>

      <p className="mt-2 font-type text-[12px] leading-tight">{commit.subject}</p>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        <dt className="flex items-center gap-1 text-neutral-500">
          <Fingerprint size={11} /> P(culprit)
        </dt>
        <dd className="tabular-nums">
          {commit.mass !== undefined && state.prior ? pct(commit.mass, 1) : commit.p ? `${pct(commit.p)} suspicion` : "—"}
          {commit.p !== undefined && commit.p > 0 && (
            <span className="ml-2 inline-block h-[6px] w-[80px] rounded-sm bg-neutral-300 align-middle">
              <span className="heat block h-full rounded-sm" style={{ width: `${Math.max(2, commit.p * 100)}%` }} />
            </span>
          )}
        </dd>

        <dt className="flex items-center gap-1 text-neutral-500">
          <GitCommitHorizontal size={11} /> CI at commit
        </dt>
        <dd>
          {commit.ci === "failed" ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-amber-200 px-1 text-[10px] font-semibold text-amber-900">
              <ShieldAlert size={10} /> FLAKY (failed, re-run passed)
            </span>
          ) : commit.ci === "passed" ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-emerald-200 px-1 text-[10px] font-semibold text-emerald-900">
              <ShieldCheck size={10} /> PASS
            </span>
          ) : (
            <span className="text-neutral-500">no log</span>
          )}
        </dd>

        <dt className="flex items-center gap-1 text-neutral-500">
          <FileCode2 size={11} /> Elastic match
        </dt>
        <dd>
          {sim ? (
            <>
              <span className="tabular-nums">{(sim / maxSim).toFixed(2)}</span>
              <span className="ml-1 text-neutral-500">rel · rrf {sim.toFixed(4)}</span>
              <div className="mt-0.5 flex gap-1">
                {["bm25", "knn", "rerank"].map((leg) => (
                  <span key={leg} className={cx("rounded-sm px-1 text-[9px] uppercase", via.includes(leg) ? "bg-neutral-800 text-emerald-300" : "bg-neutral-200 text-neutral-400")}>
                    {leg}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <span className="text-neutral-500">not surfaced by search</span>
          )}
        </dd>
      </dl>

      <div className="mt-2 border-t border-dashed border-neutral-400 pt-1.5">
        <div className="text-[9px] uppercase tracking-widest text-neutral-500">touched</div>
        <ul className="mt-0.5 max-h-[64px] overflow-hidden">
          {shown.slice(0, 5).map((f) => (
            <li key={f} className="truncate">
              {f}
            </li>
          ))}
          {shown.length > 5 && <li className="text-neutral-500">+{shown.length - 5} more</li>}
        </ul>
      </div>

      {probe && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-dashed border-neutral-400 pt-1.5">
          {probe.result === "good" ? <CheckCircle2 size={12} className="text-emerald-700" /> : <XCircle size={12} className="text-red-700" />}
          <span>
            probe {probe.step}: oracle said <b>{probe.result}</b> in {probe.durationMs} ms
            {probe.by === "player" ? " (your call)" : ""}
          </span>
        </div>
      )}
      {contradiction && <div className="mt-1 text-[10px] font-semibold text-amber-800">⚠ contradictory results — flaky run absorbed as ε-noise</div>}
    </div>
  );
}
