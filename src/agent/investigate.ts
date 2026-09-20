import { churnHotspots, ciTimeline, fileTimeline, getCommit, getHunks, searchEvidence, type Evidence, type EvidenceKind } from "../es/search.js";
import { hasLLM, runToolLoop } from "./llm.js";
import { ui } from "../ui.js";

export interface Suspect {
  sha: string;
  score: number; // 0..1
  reason: string;
}

export interface Investigation {
  /** sha -> suspicion in [0,1] */
  suspicion: Map<string, number>;
  suspects: Suspect[];
  evidence: Evidence[];
  queries: string[];
  notes: string;
  mode: "agent" | "heuristic";
}

const KIND_WEIGHT: Record<EvidenceKind, number> = { hunk: 1.0, commit: 0.7, "ci-log": 0.3, issue: 0 };

/** Turn retrieved evidence into per-commit suspicion using RRF scores weighted by evidence kind. */
function suspicionFromEvidence(all: Evidence[]): Map<string, number> {
  const acc = new Map<string, number>();
  for (const e of all) {
    if (!e.sha) continue;
    acc.set(e.sha, (acc.get(e.sha) ?? 0) + e.score * KIND_WEIGHT[e.kind]);
  }
  const max = Math.max(...acc.values(), 1e-9);
  for (const [k, v] of acc) acc.set(k, v / max);
  return acc;
}

function keywordQueries(description: string): string[] {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  const uniq = [...new Set(words)];
  const qs = [description];
  if (uniq.length > 2) qs.push(uniq.slice(0, 6).join(" "));
  return qs;
}
const STOP = new Set(["since", "sometime", "last", "week", "month", "when", "with", "from", "that", "this", "have", "been", "started", "stopped", "after", "before", "some", "into", "than", "then", "there", "their", "about", "which", "wrong", "broken", "breaks", "bug"]);

export async function investigate(repo: string, description: string, opts: { verbose?: boolean } = {}): Promise<Investigation> {
  const evidenceLog: Evidence[] = [];
  const queries: string[] = [];

  const search = async (q: string, kinds?: EvidenceKind[]) => {
    queries.push(q);
    const ev = await searchEvidence(repo, q, { size: 12, kinds });
    evidenceLog.push(...ev);
    return ev;
  };

  if (!hasLLM()) {
    for (const q of keywordQueries(description)) await search(q);
    const suspicion = suspicionFromEvidence(evidenceLog);
    const suspects = [...suspicion.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([sha, score]) => ({ sha, score, reason: "surfaced by hybrid search over diffs, commit messages and CI logs" }));
    return { suspicion, suspects, evidence: dedupe(evidenceLog), queries, notes: "heuristic mode (no OPENAI_API_KEY)", mode: "heuristic" };
  }

  const tools = [
    {
      name: "search_evidence",
      description:
        "Hybrid search (BM25 + dense vectors + RRF) over the repo's case file: diff hunks, commit messages, noisy CI logs and issue threads. Returns ranked evidence with commit SHAs. Use several differently-phrased queries (symptoms, suspected functions, file names, error strings).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kinds: { type: "array", items: { type: "string", enum: ["hunk", "commit", "ci-log", "issue"] } },
        },
        required: ["query"],
      },
      handler: async (a: { query: string; kinds?: EvidenceKind[] }) => {
        const ev = await search(a.query, a.kinds);
        return JSON.stringify(
          ev.map((e) => ({ kind: e.kind, sha: e.sha, order: e.order, file: e.file, title: e.title, snippet: e.snippet.slice(0, 700), via: e.via })),
          null,
          1,
        );
      },
    },
    {
      name: "file_timeline",
      description: "Commits that touched a file, oldest→newest, with weekly histogram and author breakdown (Elasticsearch aggregations).",
      parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
      handler: async (a: { file: string }) => JSON.stringify(await fileTimeline(repo, a.file)),
    },
    {
      name: "churn_hotspots",
      description: "Files with the most commits in the range, with distinct-author counts and last-touched date.",
      parameters: { type: "object", properties: {} },
      handler: async () => JSON.stringify(await churnHotspots(repo, 15)),
    },
    {
      name: "ci_timeline",
      description: "CI health per week via ES|QL: runs, failures, p50 duration. Useful for spotting when things got noisy.",
      parameters: { type: "object", properties: {} },
      handler: async () => JSON.stringify(await ciTimeline(repo).catch((e) => ({ error: String(e) }))),
    },
    {
      name: "show_commit",
      description: "Full commit metadata plus all of its diff hunks.",
      parameters: { type: "object", properties: { sha: { type: "string" } }, required: ["sha"] },
      handler: async (a: { sha: string }) => {
        const c = await getCommit(repo, a.sha);
        if (!c) return "not found";
        const hunks = await getHunks(repo, a.sha);
        return JSON.stringify({ ...c, hunks: hunks.map((h) => `${h.file} ${h.header}\n${h.text.slice(0, 1500)}`) });
      },
    },
  ];

  const system = `You are whodunit, a software detective. A developer reports a regression. Your job is to gather evidence from the
repository's case file (indexed in Elasticsearch) and produce a SUSPICION PRIOR over commits: which commits most plausibly
introduced the bug. You are NOT asked to be certain — a Bayesian bisection will test commits afterwards. A sharp prior means fewer
test runs; a wrong prior costs a couple extra runs. Be calibrated.

Method:
1. Search with several phrasings: the symptom, the domain nouns, likely function/file names, error strings. Search hunks especially.
2. Read the most suspicious commits fully (show_commit). Prefer commits whose *diff* plausibly changes the reported behaviour over
   commits whose *message* merely mentions the topic (messages lie; diffs don't). Beware red herrings: a commit that ADDED a
   feature is often innocent; a later "refactor"/"perf"/"cleanup" of the same code is a classic culprit.
3. Use file_timeline / churn_hotspots for the files involved to find every commit that touched them.
4. Use ci_timeline / ci-log evidence for hints (warnings, flaky reruns, timing changes) — CI logs are noisy, weigh them lightly.

When done (aim for 5-10 tool calls), reply with ONLY a JSON object:
{"suspects":[{"sha":"<full or short sha>","score":<0-100>,"reason":"<one sentence citing the concrete evidence>"}],
 "notes":"<2-3 sentences: your theory of the crime and what evidence you found>"}
Include 3-8 suspects. Scores are relative suspicion, not probabilities.`;

  const result = await runToolLoop(system, `Bug report: ${description}\n\nRepository: ${repo}`, tools as never, {
    maxTurns: 14,
    onToolCall: (name, args) => {
      if (opts.verbose !== false) console.log(`  ${ui.dim("→")} ${ui.dim(name)} ${ui.dim(JSON.stringify(args).slice(0, 110))}`);
    },
  });

  let parsed: { suspects?: { sha: string; score: number; reason: string }[]; notes?: string } = {};
  try {
    const m = result.finalText.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {
    /* fall back to heuristic scores */
  }

  const searchSusp = suspicionFromEvidence(evidenceLog);
  const suspicion = new Map<string, number>();
  for (const [sha, s] of searchSusp) suspicion.set(sha, 0.4 * s);
  const suspects: Suspect[] = [];
  for (const s of parsed.suspects ?? []) {
    const full = await resolveSha(repo, s.sha);
    if (!full) continue;
    const score = Math.max(0, Math.min(100, Number(s.score) || 0)) / 100;
    suspicion.set(full, (suspicion.get(full) ?? 0) + 0.6 * score);
    suspects.push({ sha: full, score, reason: s.reason });
  }
  suspects.sort((a, b) => b.score - a.score);

  return {
    suspicion,
    suspects,
    evidence: dedupe(evidenceLog),
    queries,
    notes: parsed.notes ?? result.finalText.slice(0, 500),
    mode: "agent",
  };
}

async function resolveSha(repo: string, sha: string): Promise<string | null> {
  const c = await getCommit(repo, sha.trim());
  return (c?.sha as string | undefined) ?? null;
}

function dedupe(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of list.sort((a, b) => b.score - a.score)) {
    const k = `${e.kind}/${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
