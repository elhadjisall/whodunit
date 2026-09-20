import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { API_BASE, fetchStatus, startLiveCase } from "./lib/api";
import { isMuted, setMuted as setMutedFx, sfxBlip, sfxBuzz, sfxChirp, sfxStamp, unlockAudio } from "./lib/audio";
import { DEMO_COMPLAINT, startMockCase } from "./lib/mock";
import { initialState, reduce } from "./lib/store";
import demo from "./data/demo-case.json";
import type { CaseEvent, CaseHandle, CaseOptions, Mode, PublicCommit, ServerStatus } from "./types";
import { Barometer } from "./components/Barometer";
import { ComplaintDesk } from "./components/ComplaintDesk";
import { CorkBoard, HoverLayer } from "./components/CorkBoard";
import { Newspaper } from "./components/Newspaper";
import { TerminalDeck } from "./components/Terminal";
import { TimelineRail } from "./components/TimelineRail";
import { TopBar, type CaseTab } from "./components/TopBar";

type Hover = { commit: PublicCommit; x: number; y: number } | null;

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const handleRef = useRef<CaseHandle | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<Mode>("auto");
  const [eps, setEps] = useState(0.05);
  const [flaky, setFlaky] = useState(false);
  const [complaint, setComplaint] = useState(DEMO_COMPLAINT);
  const [tab, setTabState] = useState<CaseTab>("108");
  const [muted, setMutedState] = useState(isMuted());
  const [extraOpen, setExtraOpen] = useState(false);
  const [hover, setHover] = useState<Hover>(null);
  const [culpritDiff, setCulpritDiff] = useState<string | undefined>();
  const kindRef = useRef<"live" | "mock">("mock");

  /* bureau heartbeat */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchStatus();
      if (!alive) return;
      setServer(s);
      setChecking(false);
    };
    void tick();
    const t = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  /* desk lamp follows the mouse; first gesture unlocks audio */
  useEffect(() => {
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        document.documentElement.style.setProperty("--lamp-x", `${(e.clientX / window.innerWidth) * 100}%`);
        document.documentElement.style.setProperty("--lamp-y", `${(e.clientY / window.innerHeight) * 100}%`);
      });
    };
    const unlock = () => unlockAudio();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const onEvent = useCallback((e: CaseEvent) => {
    dispatch({ type: "event", event: e });
    switch (e.type) {
      case "tool":
        sfxChirp();
        break;
      case "targeting":
        sfxBlip();
        break;
      case "culprit":
        sfxStamp(true);
        if (kindRef.current === "live") {
          fetch(`${API_BASE}/api/hunks?sha=${encodeURIComponent(e.payload.commit.sha)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j: { hunks?: { file: string; header: string; text: string }[] } | null) => {
              if (j?.hunks?.length) setCulpritDiff(j.hunks.map((h) => `diff --git a/${h.file} b/${h.file}\n${h.header}\n${h.text}`).join("\n"));
            })
            .catch(() => void 0);
        }
        break;
      case "verdict":
        setTimeout(() => setExtraOpen(true), 900);
        break;
      case "error":
        sfxBuzz();
        break;
    }
  }, []);

  const start = useCallback(
    async (kind: "live" | "mock") => {
      handleRef.current?.close();
      const opts: CaseOptions = { description: complaint.trim() || DEMO_COMPLAINT, mode, eps, flaky };
      setExtraOpen(false);
      setHover(null);
      kindRef.current = kind;
      setCulpritDiff(kind === "mock" ? demo.culpritDiff : undefined);
      dispatch({ type: "start", kind, mode, eps, flaky, description: opts.description });
      if (kind === "mock") {
        handleRef.current = startMockCase(opts, onEvent);
        return;
      }
      try {
        handleRef.current = await startLiveCase(opts, onEvent, () => dispatch({ type: "log", kind: "err", text: "LIVE WIRE DROPPED ▸ lost the bureau's event stream" }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        kindRef.current = "mock";
        setCulpritDiff(demo.culpritDiff);
        dispatch({ type: "start", kind: "mock", mode, eps, flaky, description: opts.description });
        dispatch({ type: "log", kind: "warn", text: `Bureau unreachable (${msg}) — falling back to the simulated cold case.` });
        handleRef.current = startMockCase(opts, onEvent);
      }
    },
    [complaint, mode, eps, flaky, onEvent],
  );

  const onRelease = useCallback(() => void start(server?.es ? "live" : "mock"), [start, server]);
  const onSimulate = useCallback(() => void start("mock"), [start]);
  const onReset = useCallback(() => {
    handleRef.current?.close();
    handleRef.current = null;
    setExtraOpen(false);
    setCulpritDiff(undefined);
    dispatch({ type: "reset", mode, eps, flaky });
  }, [mode, eps, flaky]);

  const onInterrogate = useCallback(
    (index: number) => {
      if (state.status !== "awaiting") return;
      handleRef.current?.submitProbe(index).catch((e) => dispatch({ type: "log", kind: "err", text: `probe rejected: ${e instanceof Error ? e.message : e}` }));
    },
    [state.status],
  );
  const onAuto = useCallback(() => {
    handleRef.current?.submitProbe("auto").catch(() => void 0);
  }, []);
  const onFix = useCallback(() => {
    if (!handleRef.current) return;
    dispatch({ type: "fixing", value: true });
    handleRef.current.requestFix("fix/whodunit-patch").catch((e) => {
      dispatch({ type: "event", event: { type: "error", payload: { message: `No fix: ${e instanceof Error ? e.message : e}` } } });
    });
  }, []);

  /* keyboard: A = let the detective choose · E = read the extra */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key.toLowerCase() === "a" && state.status === "awaiting") onAuto();
      if (e.key.toLowerCase() === "e" && state.verdict) setExtraOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.status, state.verdict, onAuto]);

  const setTab = (t: CaseTab) => {
    setTabState(t);
    if (t === "cold") setComplaint("");
    else if (!complaint.trim()) setComplaint(DEMO_COMPLAINT);
  };
  const setMuted = (m: boolean) => {
    setMutedFx(m);
    setMutedState(m);
  };

  const running = state.status === "running" || state.status === "awaiting";
  const caseLabel = tab === "108" ? "CASE #108" : `COLD CASE${state.caseId ? ` ${state.caseId.toUpperCase()}` : ""}`;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="lamp" />
      <div className="grain" />
      <div className="vignette" />

      <TopBar
        server={server}
        checking={checking}
        simulated={state.kind === "mock" && state.status !== "idle"}
        tab={tab}
        setTab={setTab}
        mode={mode}
        setMode={setMode}
        modeLocked={running}
        muted={muted}
        setMuted={setMuted}
        hasExtra={!!state.culprit}
        onOpenExtra={() => setExtraOpen(true)}
      />

      {/* Desktop: two columns + terminal, pinned to the window. */}
      <main className="relative z-10 grid min-h-0 flex-1 grid-cols-[372px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_232px] gap-2 overflow-hidden p-2">
        <aside className="flex min-h-0 flex-col gap-2 overflow-hidden">
          <div className="shrink-0">
            <ComplaintDesk complaint={complaint} setComplaint={setComplaint} state={state} server={server} caseLabel={caseLabel} onRelease={onRelease} onSimulate={onSimulate} onReset={onReset} />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Barometer state={state} eps={eps} setEps={setEps} flaky={flaky} setFlaky={setFlaky} locked={running} />
          </div>
        </aside>

        <section className="grid min-h-0 grid-rows-[minmax(0,1fr)_140px] gap-2 overflow-hidden">
          <CorkBoard state={state} onInterrogate={onInterrogate} onAuto={onAuto} setHover={setHover} />
          <TimelineRail state={state} onInterrogate={onInterrogate} setHover={setHover} />
        </section>

        <div className="col-span-2 min-h-0 overflow-hidden">
          <TerminalDeck state={state} setHover={setHover} />
        </div>
      </main>

      <HoverLayer hover={hover} state={state} />
      <Newspaper state={state} open={extraOpen && !!state.culprit} onClose={() => setExtraOpen(false)} onFix={onFix} culpritDiff={culpritDiff} />
    </div>
  );
}
