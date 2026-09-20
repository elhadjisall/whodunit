import { motion } from "framer-motion";
import { Bot, Newspaper, Plus, Radio, ShieldHalf, UserSearch, Volume2, VolumeX } from "lucide-react";
import { sfxKey } from "../lib/audio";
import type { Mode, ServerStatus } from "../types";
import { cx } from "../lib/ui";

export type CaseTab = "108" | "cold";

export function TopBar({
  server,
  checking,
  simulated,
  tab,
  setTab,
  mode,
  setMode,
  modeLocked,
  muted,
  setMuted,
  hasExtra,
  onOpenExtra,
}: {
  server: ServerStatus | null;
  checking: boolean;
  simulated: boolean;
  tab: CaseTab;
  setTab: (t: CaseTab) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  modeLocked: boolean;
  muted: boolean;
  setMuted: (m: boolean) => void;
  hasExtra: boolean;
  onOpenExtra: () => void;
}) {
  const live = !!server?.es;
  return (
    <header className="relative z-40 flex h-[58px] items-stretch gap-3 border-b border-black/60 bg-charcoal-2/90 px-3 shadow-[0_6px_20px_-10px_rgba(0,0,0,0.9)] backdrop-blur">
      {/* badge + title */}
      <div className="flex items-center gap-2.5">
        <div className="relative grid h-9 w-9 place-items-center rounded-full bg-gradient-to-b from-amber to-[#8a6212] text-ink shadow-[0_2px_0_#3a2a08,0_0_0_2px_#0b0b0d]">
          <ShieldHalf size={18} />
        </div>
        <div className="leading-none">
          <div className="font-type text-[13px] tracking-[0.16em] text-manila">DEPARTMENT OF CODE FORENSICS</div>
          <div className="mt-[3px] font-mono text-[9px] tracking-[0.3em] text-manila/50">
            // DIVISION 3DS-HTN · <span className="text-crime">WHODUNIT</span> · GIT BISECT WITH A BRAIN
          </div>
        </div>
      </div>

      {/* case tabs */}
      <nav className="ml-4 flex items-end gap-1">
        <button
          onClick={() => {
            sfxKey();
            setTab("108");
          }}
          className={cx("folder-tab relative px-5 pb-1.5 pt-2 font-type text-[11px] uppercase tracking-wider transition", tab === "108" ? "paper text-type" : "bg-manila-3/30 text-manila/60 hover:bg-manila-3/50")}
        >
          Case #108: The Missing Cent
        </button>
        <button
          onClick={() => {
            sfxKey();
            setTab("cold");
          }}
          className={cx("folder-tab relative flex items-center gap-1 px-4 pb-1.5 pt-2 font-type text-[11px] uppercase tracking-wider transition", tab === "cold" ? "paper text-type" : "bg-manila-3/20 text-manila/50 hover:bg-manila-3/40")}
        >
          <Plus size={11} /> Open cold case
        </button>
      </nav>

      <div className="flex-1" />

      {/* connection */}
      <div className="flex items-center">
        <div className={cx("flex items-center gap-2 rounded-sm border px-2.5 py-1 font-mono text-[10px]", live ? "border-phosphor/40 bg-phosphor/10 text-phosphor" : "border-amber/40 bg-amber/10 text-amber")}>
          <motion.span className={cx("led inline-block h-2 w-2 rounded-full", live ? "bg-phosphor" : "bg-amber")} animate={{ opacity: [1, 0.35, 1] }} transition={{ duration: live ? 1.6 : 0.7, repeat: Infinity }} />
          <Radio size={12} />
          {checking && !server ? (
            <span>DIALING 127.0.0.1:3333…</span>
          ) : live ? (
            <span>
              LIVE WIRE · ES {server?.es} · {server?.brain ?? "heuristic"} · {server?.vectors}
            </span>
          ) : (
            <span>OFFLINE · 127.0.0.1:3333 · SIMULATION MODE{simulated ? " (ACTIVE)" : ""}</span>
          )}
        </div>
      </div>

      {/* mode switch */}
      <div className="flex items-center">
        <div className="flex rounded-sm border border-manila/20 bg-ink/60 p-[2px] font-mono text-[10px]">
          {(
            [
              ["auto", "DETECTIVE AGENT", Bot, "Gemini investigates and probes autonomously"],
              ["player", "MANUAL INTERROGATION", UserSearch, "You choose which commit to interrogate"],
            ] as const
          ).map(([m, label, Icon, title]) => (
            <button
              key={m}
              disabled={modeLocked}
              title={title}
              onClick={() => {
                sfxKey();
                setMode(m);
              }}
              className={cx("flex items-center gap-1.5 rounded-[2px] px-2.5 py-1 tracking-wider transition disabled:cursor-not-allowed", mode === m ? "bg-manila text-ink shadow" : "text-manila/60 hover:text-manila")}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* extra + audio */}
      <div className="flex items-center gap-1.5">
        {hasExtra && (
          <motion.button
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            onClick={onOpenExtra}
            className="flex items-center gap-1.5 rounded-sm border border-crime bg-crime/20 px-2.5 py-1 font-poster text-[12px] tracking-widest text-white hover:bg-crime/40"
            title="Read the Daily Commit EXTRA"
          >
            <Newspaper size={13} /> EXTRA <span className="kbd">E</span>
          </motion.button>
        )}
        <button onClick={() => setMuted(!muted)} className="grid h-8 w-8 place-items-center rounded-sm border border-manila/20 text-manila/70 hover:text-manila" title={muted ? "Unmute foley" : "Mute foley"}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
      </div>
    </header>
  );
}
