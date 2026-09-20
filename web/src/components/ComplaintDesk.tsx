import { motion } from "framer-motion";
import { Dog, FileWarning, FolderOpen, Loader2, RotateCcw, Siren } from "lucide-react";
import { sfxKey, sfxLever } from "../lib/audio";
import type { CaseState } from "../lib/store";
import type { ServerStatus } from "../types";
import { cx } from "../lib/ui";

export function ComplaintDesk({
  complaint,
  setComplaint,
  state,
  server,
  caseLabel,
  onRelease,
  onSimulate,
  onReset,
}: {
  complaint: string;
  setComplaint: (s: string) => void;
  state: CaseState;
  server: ServerStatus | null;
  caseLabel: string;
  onRelease: () => void;
  onSimulate: () => void;
  onReset: () => void;
}) {
  const running = state.status === "running" || state.status === "awaiting";
  const done = state.status === "solved" || state.status === "closed" || state.status === "error";
  const live = !!server?.es;

  return (
    <div className="paper torn-bottom relative flex flex-col p-3 pb-5">
      <div className="tape-strip -left-4 top-3" style={{ ["--r" as string]: "-6deg" }} />
      <div className="tape-strip -right-3 top-6" style={{ ["--r" as string]: "5deg", width: 70 }} />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-type text-[12px] uppercase tracking-[0.18em]">
          <FolderOpen size={14} /> Complaint desk
        </div>
        <span className="font-mono text-[9px] text-neutral-600">FORM DCF-12 · {caseLabel}</span>
      </div>

      <label className="mt-1.5 font-type text-[10px] uppercase tracking-widest text-neutral-600">Statement of the aggrieved developer</label>
      <div className="relative mt-1 h-[90px] shrink-0">
        <textarea
          value={complaint}
          disabled={running}
          onChange={(e) => {
            setComplaint(e.target.value);
            sfxKey();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !running) onRelease();
          }}
          spellCheck={false}
          className="h-full w-full resize-none bg-transparent font-type text-[12.5px] leading-[18px] text-type outline-none placeholder:text-neutral-500 disabled:opacity-70"
          style={{ backgroundImage: "repeating-linear-gradient(180deg, transparent 0 17px, rgba(0,0,0,0.12) 17px 18px)", backgroundAttachment: "local" }}
          placeholder="Describe the regression as you would to a very patient detective…"
        />
      </div>

      <div className="mt-1.5 grid grid-cols-[auto_1fr_auto_1fr] gap-x-2 gap-y-[1px] font-mono text-[9px] text-neutral-700">
        <span className="text-neutral-500">repo</span>
        <span className="truncate">{state.repo ?? server?.repo ?? "acme-ledger"}</span>
        <span className="text-neutral-500">lineup</span>
        <span className="truncate">{state.commits.length || server?.commitCount || 108} commits{state.range ? ` · ${state.range}` : ""}</span>
        <span className="text-neutral-500">brain</span>
        <span className="truncate">{state.brain ?? server?.brain ?? "gemini (simulated offline)"}</span>
        <span className="text-neutral-500">vectors</span>
        <span className="truncate">{state.vectors ?? server?.vectors ?? "gemini"} · 768d</span>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {!done ? (
          <motion.button
            whileTap={{ scale: 0.98 }}
            disabled={running || !complaint.trim()}
            onClick={() => {
              sfxLever();
              onRelease();
            }}
            className={cx(
              "flex w-full items-center justify-center gap-2 rounded-sm border-2 border-crime-2 bg-crime px-3 py-2 font-poster text-[17px] tracking-[0.12em] text-white shadow-[0_4px_0_#7d1520] transition",
              "hover:brightness-110 active:translate-y-[2px] active:shadow-[0_2px_0_#7d1520] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0",
            )}
          >
            {running ? (
              <>
                <Loader2 size={16} className="animate-spin" /> INVESTIGATING…
              </>
            ) : (
              <>
                <Dog size={18} /> RELEASE THE HOUNDS
              </>
            )}
          </motion.button>
        ) : (
          <button onClick={onReset} className="flex w-full items-center justify-center gap-2 rounded-sm border-2 border-neutral-800 bg-neutral-900 px-3 py-2 font-poster text-[16px] tracking-[0.12em] text-manila shadow-[0_4px_0_#000] hover:brightness-125 active:translate-y-[2px]">
            <RotateCcw size={16} /> REOPEN THE DESK
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <button
            disabled={running}
            onClick={() => {
              sfxLever();
              onSimulate();
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-sm border border-neutral-700/60 bg-manila-3/60 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-neutral-800 hover:bg-manila-3 disabled:opacity-50"
            title="Replays a recorded case against the real acme-ledger history — no server needed"
          >
            <Siren size={12} /> Run demo case (simulated)
          </button>
        </div>
        <div className="flex items-center justify-between font-mono text-[9px] text-neutral-600">
          <span>{live ? "Investigate uses the live bureau (Elasticsearch + Gemini)." : "Bureau offline — Investigate falls back to the simulation."}</span>
          <span className="kbd border-neutral-500 text-neutral-700">⌘↵</span>
        </div>
      </div>

      {state.error && (
        <div className="mt-2 flex items-start gap-1.5 rounded-sm bg-crime/10 p-1.5 font-mono text-[10px] text-crime-2">
          <FileWarning size={12} className="mt-[1px] shrink-0" /> {state.error}
        </div>
      )}
    </div>
  );
}
