import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, GitBranch, Hammer, Loader2, Newspaper as NewsIcon, UploadCloud, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { sfxHeadline, sfxLever } from "../lib/audio";
import type { CaseState } from "../lib/store";
import type { PublicCommit } from "../types";
import { cx, fmtDate, pct } from "../lib/ui";
import { Markdown } from "./Markdown";
import { Mugshot } from "./Polaroid";
import { Stamp } from "./Stamp";

function Diff({ text }: { text: string }) {
  return (
    <pre className="max-h-[260px] overflow-auto rounded-sm border border-black/20 bg-[#f7f2e6] p-2 font-mono text-[10px] leading-[1.35]">
      {text.split("\n").map((l, i) => (
        <div key={i} className={cx("whitespace-pre", l.startsWith("+") && !l.startsWith("+++") ? "diff-add" : l.startsWith("-") && !l.startsWith("---") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : l.startsWith("diff ") ? "font-bold" : "")}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function LineupCard({ commit, verdict, tone, note }: { commit: PublicCommit; verdict: string; tone: "red" | "green"; note: string }) {
  return (
    <div className="relative flex gap-2 border border-black/30 bg-[#f5efdf] p-2">
      <div className="w-[88px] shrink-0 bg-white p-1 shadow">
        <Mugshot commit={commit} size={70} />
      </div>
      <div className="min-w-0 flex-1 break-words font-mono text-[10px] leading-snug">
        <div className="pr-24 font-bold">
          #{commit.index} {commit.short}
        </div>
        <div className="pr-24 font-news text-[11px] italic">{commit.subject}</div>
        <div className="text-neutral-600">
          {commit.author} · {fmtDate(commit.date)}
        </div>
        <div className="mt-1 text-neutral-800">{note}</div>
      </div>
      <div className="absolute right-2 top-1">
        <Stamp text={verdict} tone={tone} size="sm" rotate={tone === "red" ? 10 : -12} sound={false} />
      </div>
    </div>
  );
}

export function Newspaper({
  state,
  open,
  onClose,
  onFix,
  culpritDiff,
}: {
  state: CaseState;
  open: boolean;
  onClose: () => void;
  onFix: () => void;
  culpritDiff?: string;
}) {
  const culprit = state.culprit;
  useEffect(() => {
    if (open) sfxHeadline();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const herring = useMemo(() => {
    if (!culprit) return null;
    const s = state.suspects.find((x) => x.commit && x.commit.index !== culprit.commit.index);
    if (!s?.commit) return null;
    const live = state.commits.find((c) => c.index === s.commit!.index) ?? s.commit;
    const probe = state.probes.find((p) => p.index === live.index);
    const why = probe
      ? `Interrogated at probe ${probe.step}: the oracle ${probe.result === "good" ? "PASSED — the bug does not exist here" : "failed, but the posterior moved on"}.`
      : `Never needed a test: the posterior left it ${pct(live.mass ?? 0, 2)} after the bracket closed.`;
    return { commit: live, reason: s.reason, why };
  }, [culprit, state.suspects, state.commits, state.probes]);

  if (!culprit) return null;
  const c = culprit.commit;
  const fixErr = state.error?.startsWith("No fix") ? state.error : undefined;

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[80] grid place-items-center bg-black/75 p-6 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.article
            onClick={(e) => e.stopPropagation()}
            initial={{ rotate: -900, scale: 0.02, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            exit={{ rotate: 30, scale: 0.6, opacity: 0, y: 400 }}
            transition={{ type: "spring", stiffness: 60, damping: 16, mass: 1.2 }}
            className="newsprint relative max-h-[92vh] w-[min(1100px,96vw)] overflow-auto px-8 pb-8 pt-5"
          >
            <button onClick={onClose} className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-black/80 text-white hover:bg-crime" title="Back to the board (Esc)">
              <X size={16} />
            </button>

            {/* masthead */}
            <div className="flex items-center justify-between font-news text-[10px] uppercase tracking-[0.3em]">
              <span>★ EXTRA ★ EXTRA ★ EXTRA</span>
              <span>Department of Code Forensics · Division 3DS-HTN</span>
              <span>Price: one cent (recovered)</span>
            </div>
            <h1 className="news-rule mt-1 pt-1 text-center font-black text-[64px] leading-[0.95] tracking-tight">The Daily Commit</h1>
            <div className="news-rule mt-1 flex items-center justify-between py-1 font-news text-[10px] uppercase tracking-[0.2em]">
              <span>Vol. CVIII · No. {c.index}</span>
              <span>{new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span>
              <span>Case {state.caseId?.toUpperCase()} · {state.repo}</span>
            </div>

            {/* headline */}
            <h2 className="mt-4 text-center font-poster text-[46px] leading-[0.95] tracking-wide">
              CAUGHT RED-HANDED: COMMIT <span className="text-crime">{c.short.toUpperCase()}</span> CONDEMNED
            </h2>
            <p className="mx-auto mt-2 max-w-[860px] text-center font-news text-[15px] italic leading-snug">
              Bug squashed after <b>{culprit.probes}</b> interrogation{culprit.probes === 1 ? "" : "s"} — classic <code className="font-mono not-italic">git bisect</code> would have needed <b>{culprit.uniformSteps}</b>
              {culprit.gitVerdict !== undefined && culprit.gitVerdict !== c.index ? (
                <>
                  {" "}
                  and, misled by a flaky run, would have condemned innocent <b>#{culprit.gitVerdict}</b>
                </>
              ) : null}
              . Posterior confidence <b>{pct(culprit.confidence, 1)}</b>. Elasticsearch evidence cited below.
            </p>

            <div className="mt-4 grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-6">
              {/* verdict */}
              <div className="min-w-0">
                <div className="flex items-center gap-2 border-b-2 border-black pb-1 font-news text-[12px] font-bold uppercase tracking-widest">
                  <NewsIcon size={13} /> The cited verdict
                </div>
                {state.verdict ? (
                  <Markdown text={state.verdict} className="mt-1 font-news text-[12.5px]" />
                ) : (
                  <p className="mt-2 flex items-center gap-2 font-mono text-[11px]">
                    <Loader2 size={12} className="animate-spin" /> The bureau is typing up the case report…
                  </p>
                )}
                {culpritDiff && (
                  <div className="mt-3">
                    <div className="font-news text-[11px] font-bold uppercase tracking-widest">Exhibit A — the offending hunk</div>
                    <Diff text={culpritDiff} />
                  </div>
                )}
              </div>

              {/* lineup + fix */}
              <div className="min-w-0 space-y-3">
                <div className="border-b-2 border-black pb-1 font-news text-[12px] font-bold uppercase tracking-widest">The lineup: red herring vs. the real regression</div>
                {herring && <LineupCard commit={herring.commit} verdict="EXONERATED" tone="green" note={`Why suspected: ${herring.reason.slice(0, 150)} — ${herring.why}`} />}
                <LineupCard commit={c} verdict="CULPRIT" tone="red" note={`Bracketed by the oracle: #${c.index - 1} passes, #${c.index} fails. Touched ${c.files.filter((f) => f.startsWith("src/")).join(", ") || c.files.join(", ")}.`} />

                <div className="halftone flex items-center justify-between border border-black/40 p-2 font-mono text-[10px]">
                  <span>
                    probes <b>{culprit.probes}</b> vs <b>{culprit.uniformSteps}</b>
                  </span>
                  <span>
                    confidence <b>{pct(culprit.confidence, 1)}</b>
                  </span>
                  <span>
                    ε = <b>{state.eps.toFixed(2)}</b>
                  </span>
                  <span>
                    mode <b>{state.kind}</b>
                  </span>
                </div>

                {/* fix */}
                <div className="border-t-2 border-black pt-2">
                  <div className="font-news text-[12px] font-bold uppercase tracking-widest">Make amends</div>
                  {!state.amends ? (
                    <>
                      <button
                        disabled={state.fixing}
                        onClick={() => {
                          sfxLever();
                          onFix();
                        }}
                        className="mt-2 flex w-full items-center justify-center gap-2 rounded-sm border-2 border-crime-2 bg-crime px-3 py-2 font-poster text-[18px] tracking-[0.12em] text-white shadow-[0_4px_0_#7d1520] hover:brightness-110 active:translate-y-[2px] active:shadow-[0_2px_0_#7d1520] disabled:opacity-70"
                      >
                        {state.fixing ? (
                          <>
                            <Loader2 size={16} className="animate-spin" /> DRAFTING FIX · PROVING WITH THE ORACLE…
                          </>
                        ) : (
                          <>
                            <Hammer size={16} /> EXECUTE FIX &amp; PUSH
                          </>
                        )}
                      </button>
                      <p className="mt-1 font-mono text-[9px] text-neutral-700">
                        Gemini drafts a minimal patch, the reproduction must pass, <code>npm test</code> must stay green, then it is committed on <code>fix/whodunit-patch</code>.
                      </p>
                      {fixErr && <p className="mt-1 font-mono text-[10px] text-crime-2">{fixErr}</p>}
                    </>
                  ) : (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
                        <span className="inline-flex items-center gap-1 rounded-sm bg-black px-1.5 py-[2px] text-phosphor">
                          <GitBranch size={11} /> git checkout -b {state.amends.branch}
                        </span>
                        <span className="text-neutral-700">{state.amends.commitSha.slice(0, 7)}</span>
                        {state.amends.verifyPassed !== undefined && (
                          <span className={cx("inline-flex items-center gap-1 rounded-sm px-1.5 py-[2px] font-bold", state.amends.verifyPassed ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900")}>
                            <CheckCircle2 size={11} /> repro passes · npm test {state.amends.verifyPassed ? "green" : "red"}
                          </span>
                        )}
                      </div>
                      <p className="font-news text-[12px] leading-snug">{state.amends.summary}</p>
                      {state.amends.diff && <Diff text={state.amends.diff} />}
                      <div className="flex items-center gap-2 font-mono text-[10px]">
                        <UploadCloud size={12} />
                        {state.amends.prUrl ? (
                          <a className="underline" href={state.amends.prUrl} target="_blank" rel="noreferrer">
                            pull request opened → {state.amends.prUrl}
                          </a>
                        ) : (
                          <span className="text-neutral-700">
                            branch committed locally · push skipped ({state.kind === "mock" ? "simulation" : "no remote configured for the demo repo"}) · <code>git push -u origin {state.amends.branch}</code>
                          </span>
                        )}
                      </div>
                    </motion.div>
                  )}
                </div>
              </div>
            </div>

            <div className="pointer-events-none absolute right-14 top-9">
              <Stamp text="CASE CLOSED" tone="red" size="lg" rotate={-14} heavy delay={1.1} />
            </div>
          </motion.article>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
