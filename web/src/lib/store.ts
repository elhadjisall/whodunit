/* Reduces the case event stream (live or simulated) into UI state. */
import type { AmendsResult, AwaitingPayload, CaseEvent, CulpritPayload, Evidence, Mode, PriorPayload, ProbePayload, PublicCommit, SpanPayload, Suspect, TargetingPayload } from "../types";

export type LogKind = "sys" | "tool" | "esql" | "ok" | "warn" | "err" | "agent" | "probe" | "stamp" | "dim";

export interface LogLine {
  id: number;
  t: number;
  kind: LogKind;
  text: string;
}

export interface RadarEntry {
  id: number;
  t: number;
  name: string;
  args: Record<string, unknown>;
  /** rendered Query DSL / ES|QL */
  query: string[];
  /** BM25 · kNN · RRF · rerank legs shown as lit indicators */
  legs: ("bm25" | "knn" | "rrf" | "rerank" | "aggs" | "esql")[];
  hits?: number;
}

export type Status = "idle" | "running" | "awaiting" | "solved" | "closed" | "error";

export interface CaseState {
  status: Status;
  kind?: "live" | "mock";
  mode: Mode;
  eps: number;
  flaky: boolean;
  caseId?: string;
  repo?: string;
  description?: string;
  brain?: string;
  vectors?: string;
  range?: string;
  commits: PublicCommit[];
  phase?: { phase: string; title: string };
  radar: RadarEntry[];
  evidence: Evidence[];
  theory?: { notes: string; mode: string; queries: string[] };
  suspects: Suspect[];
  repro?: { explanation: string; command: string; headOutput: string };
  prior?: Omit<PriorPayload, "board">;
  awaiting: AwaitingPayload | null;
  /** the commit currently under interrogation (needle target) */
  targeting: TargetingPayload | null;
  probes: ProbePayload[];
  highlight?: number;
  culprit?: CulpritPayload;
  verdict?: string;
  amends?: AmendsResult;
  fixing: boolean;
  error?: string;
  log: LogLine[];
  startedAt?: number;
  solvedAt?: number;
  /** sha -> best fused/rerank score seen in evidence */
  similarity: Record<string, number>;
  /** sha -> which retrievers surfaced it */
  via: Record<string, string[]>;
  seq: number;
  /** ES kNN vs Gemini vs oracle latency */
  spans: SpanPayload[];
}

export const initialState = (mode: Mode = "auto", eps = 0.05, flaky = false): CaseState => ({
  status: "idle",
  mode,
  eps,
  flaky,
  commits: [],
  radar: [],
  evidence: [],
  suspects: [],
  awaiting: null,
  targeting: null,
  probes: [],
  fixing: false,
  log: [],
  similarity: {},
  via: {},
  seq: 0,
  spans: [],
});

export type Action =
  | { type: "event"; event: CaseEvent; t?: number }
  | { type: "start"; kind: "live" | "mock"; mode: Mode; eps: number; flaky: boolean; description: string }
  | { type: "log"; kind: LogKind; text: string }
  | { type: "fixing"; value: boolean }
  | { type: "reset"; mode: Mode; eps: number; flaky: boolean };

const short = (s: unknown) => String(s ?? "").slice(0, 7);

function line(state: CaseState, kind: LogKind, text: string, t = Date.now()): LogLine {
  return { id: ++state.seq, t, kind, text };
}

function mergeBoard(commits: PublicCommit[], board: PublicCommit[]): PublicCommit[] {
  if (!commits.length) return board;
  const byIndex = new Map(board.map((b) => [b.index, b]));
  return commits.map((c) => {
    const b = byIndex.get(c.index);
    return b ? { ...c, p: b.p, mass: b.mass, probed: b.probed ?? c.probed, ci: b.ci ?? c.ci } : { ...c, p: c.p ?? 0, mass: c.mass ?? 0 };
  });
}

/** Render an agent tool call as the Elasticsearch request it performs. */
export function renderTool(name: string, args: Record<string, unknown>, repo = "acme-ledger"): Pick<RadarEntry, "query" | "legs"> {
  const q = JSON.stringify(args.query ?? "");
  const kinds = Array.isArray(args.kinds) && args.kinds.length ? (args.kinds as string[]) : ["hunk", "commit", "ci-log", "issue"];
  switch (name) {
    case "search_evidence":
      return {
        legs: ["bm25", "knn", "rrf", "rerank"],
        query: [
          `POST ${kinds.map((k) => `wd-${k === "ci-log" ? "logs" : k + "s"}`).join(",")}/_search`,
          `{ "query": { "bool": { "filter": [{ "term": { "repo": "${repo}" } }],`,
          `    "must": { "multi_match": { "query": ${q},`,
          `      "fields": ["text^2", "subject^2", "message", "header", "title", "body"], "analyzer": "code" } } } } }`,
          `POST wd-hunks,wd-commits,wd-issues/_search   # dense leg`,
          `{ "knn": { "field": "embedding", "query_vector": gemini-embedding-001(${q})[768],`,
          `           "k": 40, "num_candidates": 200, "filter": { "term": { "repo": "${repo}" } } } }`,
          `→ fuse: score = Σ 1 / (60 + rank)          # Reciprocal Rank Fusion, k=60`,
          `→ rerank: jina-reranker-v2 (if JINA_API_KEY)`,
          `FROM wd-hunks, wd-commits, wd-issues`,
          `| WHERE repo == "${repo}" AND author != "bot"`,
          `| EVAL suspicion_score = bm25() + knn(embedding, 768)`,
          `| SORT suspicion_score DESC`,
          `| LIMIT 12`,
        ],
      };
    case "file_timeline":
      return {
        legs: ["aggs"],
        query: [
          `POST wd-commits/_search?size=0`,
          `{ "query": { "bool": { "filter": [{ "term": { "repo": "${repo}" } }, { "term": { "files": ${JSON.stringify(args.file)} } }] } },`,
          `  "aggs": { "by_week": { "date_histogram": { "field": "date", "calendar_interval": "week" } },`,
          `            "authors": { "terms": { "field": "author.keyword", "size": 10 } } } }`,
        ],
      };
    case "churn_hotspots":
      return {
        legs: ["aggs"],
        query: [
          `POST wd-commits/_search?size=0`,
          `{ "query": { "term": { "repo": "${repo}" } },`,
          `  "aggs": { "files": { "terms": { "field": "files", "size": 15 },`,
          `    "aggs": { "last_touched": { "max": { "field": "date" } }, "authors": { "cardinality": { "field": "author.keyword" } } } } } }`,
        ],
      };
    case "ci_timeline":
      return {
        legs: ["esql"],
        query: [
          `POST /_query   # ES|QL`,
          `FROM wd-logs`,
          `| WHERE repo == "${repo}"`,
          `| EVAL week = DATE_TRUNC(1 week, date)`,
          `| STATS runs = COUNT(*), failed = COUNT(*) WHERE status == "failed", p50_ms = PERCENTILE(duration_ms, 50) BY week`,
          `| SORT week ASC`,
        ],
      };
    case "file_suspicion":
      return {
        legs: ["esql"],
        query: [
          `POST /_query   # ES|QL — file-level suspicion`,
          `FROM wd-hunks`,
          `| WHERE repo == "${repo}" AND file LIKE "src/*"`,
          `| STATS hunks = COUNT(*), commits = COUNT_DISTINCT(sha) BY file`,
          `| EVAL suspicion_score = hunks * 1.0 + commits * 0.5`,
          `| SORT suspicion_score DESC`,
          `| LIMIT 8`,
        ],
      };
    case "show_commit":
      return {
        legs: ["bm25"],
        query: [
          `GET wd-commits/_search { "query": { "bool": { "filter": [{ "term": { "repo": "${repo}" } }, { "prefix": { "sha": "${short(args.sha)}" } }] } } }`,
          `GET wd-hunks/_search   { "query": { "term": { "sha": "${short(args.sha)}…" } }, "sort": [{ "file": "asc" }] }`,
        ],
      };
    default:
      return { legs: ["bm25"], query: [`${name} ${JSON.stringify(args)}`] };
  }
}

export function reduce(prev: CaseState, action: Action): CaseState {
  if (action.type === "reset") return initialState(action.mode, action.eps, action.flaky);
  const state: CaseState = { ...prev, log: prev.log.slice(-400) };
  const now = Date.now();

  if (action.type === "start") {
    const s = initialState(action.mode, action.eps, action.flaky);
    s.status = "running";
    s.kind = action.kind;
    s.description = action.description;
    s.startedAt = now;
    s.log = [
      line(s, "sys", `DISPATCH ▸ Complaint received. Opening a ${action.kind === "live" ? "LIVE" : "SIMULATED"} case file.`),
      line(s, "dim", `mode=${action.mode === "auto" ? "detective-agent" : "manual-interrogation"} · ε=${action.eps.toFixed(2)}${action.flaky ? " · flaky oracle ON" : ""}`),
    ];
    return s;
  }
  if (action.type === "log") {
    state.log = [...state.log, line(state, action.kind, action.text)];
    return state;
  }
  if (action.type === "fixing") {
    state.fixing = action.value;
    return state;
  }

  const { event } = action;
  const t = action.t ?? now;
  const push = (kind: LogKind, text: string) => (state.log = [...state.log, line(state, kind, text, t)]);

  switch (event.type) {
    case "opened": {
      const p = event.payload;
      state.caseId = p.caseId;
      state.repo = p.repo;
      state.description = p.description;
      state.brain = p.brain;
      state.vectors = p.vectors;
      state.range = p.range;
      state.commits = p.commits.map((c) => ({ ...c, p: 0, mass: 0 }));
      push("sys", `CASE ${p.caseId.toUpperCase()} · ${p.repo} · ${p.commitCount} commits in the lineup (${p.range})`);
      push("dim", `brain=${p.brain} · vectors=${p.vectors}`);
      break;
    }
    case "phase":
      state.phase = event.payload;
      push("sys", `— ${event.payload.title.toUpperCase()} —`);
      break;
    case "tool": {
      const r = renderTool(event.payload.name, event.payload.args, state.repo);
      state.radar = [...state.radar, { id: ++state.seq, t, name: event.payload.name, args: event.payload.args, ...r }].slice(-40);
      const a = event.payload.args;
      const summary =
        event.payload.name === "search_evidence"
          ? `hybrid_search ${JSON.stringify(a.query)}`
          : event.payload.name === "file_timeline"
            ? `file_timeline ${a.file}`
            : event.payload.name === "show_commit"
              ? `show_commit ${short(a.sha)}`
            : event.payload.name === "file_suspicion"
            ? `ES|QL file_suspicion src/*`
            : event.payload.name;
      push(r.legs.includes("esql") ? "esql" : "tool", `ES ▸ ${summary}`);
      break;
    }
    case "evidence": {
      state.evidence = event.payload.items;
      const sim = { ...state.similarity };
      const via = { ...state.via };
      for (const e of event.payload.items) {
        if (!e.sha) continue;
        sim[e.sha] = Math.max(sim[e.sha] ?? 0, e.score);
        via[e.sha] = Array.from(new Set([...(via[e.sha] ?? []), ...e.via]));
      }
      state.similarity = sim;
      state.via = via;
      const last = state.radar[state.radar.length - 1];
      if (last && last.hits === undefined) state.radar = [...state.radar.slice(0, -1), { ...last, hits: event.payload.items.length }];
      push("dim", `${event.payload.items.length} pieces of evidence on the desk`);
      break;
    }
    case "theory":
      state.theory = event.payload;
      push("agent", `THEORY ▸ ${event.payload.notes.replace(/\s+/g, " ").slice(0, 600)}`);
      break;
    case "suspects": {
      state.suspects = event.payload.suspects;
      // Pre-heat the board from the agent's suspicion until the Bayesian prior arrives.
      if (!state.prior) {
        const byShaScore = new Map(event.payload.suspects.map((s) => [s.sha, s.score]));
        const max = Math.max(...event.payload.suspects.map((s) => s.score), 1e-9);
        state.commits = state.commits.map((c) => (byShaScore.has(c.sha) ? { ...c, p: (byShaScore.get(c.sha) ?? 0) / max } : c));
      }
      for (const s of event.payload.suspects.slice(0, 5)) {
        const c = s.commit;
        push("agent", `SUSPECT ${(s.score * 100).toFixed(0).padStart(3)}% ${c ? `#${c.index} ${c.short} ${c.subject.slice(0, 60)}` : s.sha.slice(0, 7)} — ${s.reason.slice(0, 140)}`);
      }
      break;
    }
    case "repro":
      state.repro = event.payload;
      push("ok", `ORACLE ▸ ${event.payload.explanation}`);
      push("dim", `$ ${event.payload.command}`);
      if (event.payload.headOutput) for (const l of event.payload.headOutput.split("\n").slice(-3)) push("dim", `  ${l}`);
      break;
    case "prior": {
      const { board, ...rest } = event.payload;
      state.prior = rest;
      state.commits = mergeBoard(state.commits, board);
      push(
        "ok",
        `PRIOR ▸ ${rest.entropyBits.toFixed(2)} bits of uncertainty (uniform: ${rest.uniformBits.toFixed(2)} ≈ ${rest.uniformProbes} probes) · 90% credible set = ${rest.credible90} commits`,
      );
      break;
    }
    case "awaiting_probe":
      state.status = "awaiting";
      state.awaiting = event.payload;
      state.commits = mergeBoard(state.commits, event.payload.board);
      push("warn", `YOUR MOVE ▸ step ${event.payload.step}: pick a suspect to interrogate${event.payload.autoCommit ? ` (detective suggests #${event.payload.autoCommit.index} ${event.payload.autoCommit.short})` : ""}`);
      break;
    case "targeting": {
      const p = event.payload;
      state.status = "running";
      state.awaiting = null;
      state.targeting = p;
      state.highlight = p.index;
      push("probe", `INTERROGATING ▸ #${p.index} ${p.commit.short} — P(bad) ${(p.pBad * 100).toFixed(0)}% · checking out worktree, running the oracle…`);
      break;
    }
    case "probe": {
      const p = event.payload;
      state.status = "running";
      state.awaiting = null;
      state.targeting = null;
      state.probes = [...state.probes, p];
      state.highlight = p.index;
      state.commits = state.commits.map((c) => (c.index === p.index ? { ...c, probed: p.result } : c));
      const verdict = p.result === "good" ? "CLEARED" : "BAD BUILD";
      push(
        "probe",
        `PROBE ${p.step} ▸ #${p.index} ${p.commit.short} ${p.commit.subject.slice(0, 48)} → ${verdict} (P(bad) was ${(p.pBad * 100).toFixed(0)}%, ${p.durationMs} ms${p.by === "player" ? ", your call" : ""})`,
      );
      if (p.flaked) push("warn", `⚠ the oracle lied on that run (simulated flake). Bayesian update absorbs it as an ε-noise observation.`);
      break;
    }
    case "posterior":
      state.commits = mergeBoard(state.commits, event.payload.board);
      if (event.payload.highlight !== undefined) state.highlight = event.payload.highlight;
      break;
    case "culprit": {
      const c = event.payload;
      state.culprit = c;
      state.status = "solved";
      state.solvedAt = t;
      state.commits = state.commits.map((x) => (x.index === c.commit.index ? { ...x, probed: "bad", p: 1, mass: c.confidence } : x));
      push("stamp", `CULPRIT IDENTIFIED ▸ #${c.commit.index} ${c.commit.short} — ${(c.confidence * 100).toFixed(1)}% after ${c.probes} probes (git bisect: ${c.uniformSteps})`);
      break;
    }
    case "verdict":
      state.verdict = event.payload.markdown;
      push("ok", "VERDICT ▸ case report filed. Read it in the EXTRA.");
      break;
    case "amends":
      state.amends = event.payload;
      state.fixing = false;
      push("stamp", `AMENDS ▸ fix committed on ${event.payload.branch} (${event.payload.commitSha.slice(0, 7)}) — ${event.payload.summary}`);
      break;
    case "closed":
      if (state.status !== "error") state.status = "closed";
      push("sys", `CASE CLOSED ▸ ${event.payload.caseFile}`);
      break;
    case "note":
      push(event.payload.level === "warn" ? "warn" : "sys", event.payload.text);
      break;
    case "span": {
      state.spans = [...state.spans, event.payload].slice(-80);
      const a = event.payload;
      const tag = a.op.startsWith("db.") ? "esql" : a.op.startsWith("gen_ai") ? "agent" : a.op.startsWith("test") ? "probe" : "dim";
      const who = a.op.startsWith("db.") || a.name.startsWith("elasticsearch") ? "ES" : a.op.startsWith("gen_ai") || a.name.startsWith("gemini") ? "GEMINI" : "TIMING";
      push(tag, `${who} ▸ ${a.name}  ${a.durationMs}ms${a.attrs?.["candidates.count"] != null ? ` · ${a.attrs["candidates.count"]} hits` : ""}${a.attrs?.["gen_ai.usage.input_tokens"] != null ? ` · ${a.attrs["gen_ai.usage.input_tokens"]}→${a.attrs["gen_ai.usage.output_tokens"]} tok` : ""}`);
      break;
    }
    case "error":
      state.error = event.payload.message;
      if (!state.culprit) state.status = "error";
      state.fixing = false;
      push("err", `ERROR ▸ ${event.payload.message}`);
      break;
  }
  return state;
}

/* ───────── derived helpers ───────── */

/** Who gets a mugshot on the cork board: everyone interrogated, plus the hottest remaining suspects. */
export function topSuspects(state: CaseState, n = 12): PublicCommit[] {
  const pinned = new Set<number>();
  for (const p of state.probes) pinned.add(p.index);
  if (state.targeting) pinned.add(state.targeting.index);
  if (state.culprit) pinned.add(state.culprit.commit.index);
  const must = state.commits.filter((c) => pinned.has(c.index));
  const rest = state.commits
    .filter((c) => !pinned.has(c.index) && ((c.p ?? 0) > 0 || state.similarity[c.sha]))
    .sort((a, b) => (b.p ?? 0) - (a.p ?? 0) || (state.similarity[b.sha] ?? 0) - (state.similarity[a.sha] ?? 0));
  return [...must, ...rest].slice(0, Math.max(n, must.length)).sort((a, b) => a.index - b.index);
}

export function bracket(state: CaseState): { lo: number; hi: number } {
  const n = state.commits.length;
  let lo = 0;
  let hi = Math.max(0, n - 1);
  for (const p of state.probes) {
    if (p.result === "good" && p.index > lo) lo = p.index;
    if (p.result === "bad" && p.index < hi) hi = p.index;
  }
  return { lo, hi };
}

export function confidence(state: CaseState): number {
  if (state.culprit) return state.culprit.confidence;
  return Math.max(0, ...state.commits.map((c) => c.mass ?? 0));
}
