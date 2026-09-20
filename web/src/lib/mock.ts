/*
 * Offline "cold case" simulation. Replays a realistic investigation over the REAL acme-ledger history
 * (snapshotted by scripts/extract-demo-commits.mjs) and then runs the actual Bayesian bisection
 * algorithm against a fake oracle. The pitch never depends on the network.
 */
import demo from "../data/demo-case.json";
import { credibleSet, entropyBits, initState, makePrior, mostLikely, nextProbe, pBad, simulateGitBisect, uniformProbes, uniformStepsFor, update } from "./bayes";
import type { AmendsResult, CaseEvent, CaseHandle, CaseOptions, Evidence, ProbeResult, PublicCommit, Suspect } from "../types";

interface DemoCommit {
  index: number;
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
  ci?: "passed" | "failed";
}

const COMMITS = demo.commits as DemoCommit[];
const L = demo.landmarks as Record<string, number>;
const N = COMMITS.length;
const C = (i: number) => COMMITS[i];
const pub = (i: number, extra: Partial<PublicCommit> = {}): PublicCommit => ({ ...C(i), ...extra });

const CULPRIT = L.culprit;
const HERRING = L.redHerring;

const sleep = (ms: number, signal: { cancelled: boolean }) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const poll = setInterval(() => {
      if (signal.cancelled) {
        clearTimeout(t);
        clearInterval(poll);
        resolve();
      }
    }, 50);
    setTimeout(() => clearInterval(poll), ms + 60);
  });

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

/* ───────────────────────── evidence corpus ───────────────────────── */

function ev(kind: Evidence["kind"], i: number, title: string, snippet: string, via: string[], score: number, file?: string): Evidence {
  const c = C(i);
  return { kind, id: `${kind}:${c.sha}${file ? ":" + file : ""}`, score, sha: c.sha, order: i, title, snippet, file, date: c.date, via };
}

const ISSUE_12: Evidence = {
  kind: "issue",
  id: "issue:12",
  score: 0.0328,
  title: "Issue #12: Credit note CSV total is off by $0.01 vs the invoice total",
  snippet:
    "Customer Globex got credit note CN-INV-1042. The invoice PDF (from summarize) says -1,249.99 but the accounting CSV export TOTAL row says -1,249.98. Finance can't reconcile. It only seems to happen on credit notes that had a discount. Started roughly three weeks ago…",
  via: ["bm25", "knn"],
};

const CI_DRIFT_IDX = Math.min(N - 1, L.report + 4);

const EVIDENCE_1: Evidence[] = [
  ISSUE_12,
  ev("commit", HERRING, `${C(HERRING).short} ${C(HERRING).subject}`, "Math.round(-0.5) is -0, not -1; use sign * round(abs) so credit notes mirror invoices. files: src/tax.js", ["bm25", "knn"], 0.0316),
  ev("hunk", L.creditNotes, `${C(L.creditNotes).short} src/invoice.js @@ -27,3 +27,14 @@ export function summarize(inv) {`, "+/** A credit note reverses an invoice: same lines, negated quantities, negated discount. */\n+export function creditNote(inv, id = `CN-${inv.id}`) {\n+    lines: inv.lines.map((l) => ({ ...l, qty: -l.qty })),\n+    discountCents: -(inv.discountCents ?? 0),", ["bm25", "knn"], 0.0301, "src/invoice.js"),
  ev("commit", L.discounts, `${C(L.discounts).short} ${C(L.discounts).subject}`, "Uses money.allocate so line nets always sum to subtotal - discount. files: src/invoice.js, src/csv.js, test/invoice.test.js", ["knn"], 0.0289),
  ev("ci-log", CI_DRIFT_IDX, `CI run #${4100 + CI_DRIFT_IDX} at ${C(CI_DRIFT_IDX).short} (passed)`, "✔ csv > csv has header and total row (1.212ms)\n(node:4821) Warning: report reconcile: CSV TOTAL differs from summarize() by 0.01 for CN-INV-1042 (ignored, see #12)\nℹ pass 5  ℹ fail 0", ["bm25"], 0.027),
  ev("hunk", L.csvPerf, `${C(L.csvPerf).short} src/csv.js @@ -18,12 +18,14 @@ export function exportInvoices(invoices) {`, "-  let out = HEADER.join(\",\") + \"\\n\";\n+  const out = [HEADER.join(\",\")];\n     const tax = taxCents(running, inv.province);\n-    out += [inv.id, \"TOTAL\", \"\", \"\", fromCents(tax), fromCents(running + tax)].map(cell).join(\",\") + \"\\n\";\n+    out.push([inv.id, \"TOTAL\", \"\", \"\", fromCents(tax), fromCents(running + tax)].map(cell).join(\",\"));", ["knn"], 0.0255, "src/csv.js"),
  ev("hunk", HERRING, `${C(HERRING).short} src/tax.js @@ -9,7 +9,8 @@ export const RATES = {`, " function roundHalfUp(x) {\n-  return Math.round(x);\n+  // Symmetric rounding so credit notes (negative) mirror invoices exactly.\n+  return Math.sign(x) * Math.round(Math.abs(x));\n }", ["bm25", "knn"], 0.0248, "src/tax.js"),
];

const EVIDENCE_2: Evidence[] = [
  ev("hunk", CULPRIT, `${C(CULPRIT).short} src/money.js @@ -22,8 +22,7 @@ export function sumCents(list) {`, "-  const shares = weights.map((w) => Math.floor((totalCents * w) / sum));\n-  // floor() always rounds toward -Infinity, so the remainder is >= 0 for any sign of total\n+  const shares = weights.map((w) => Math.trunc((totalCents * w) / sum));\n   let remainder = totalCents - shares.reduce((a, b) => a + b, 0);\n   for (let i = 0; remainder > 0; i = (i + 1) % shares.length) {", ["bm25", "knn"], 0.0325, "src/money.js"),
  ev("commit", CULPRIT, `${C(CULPRIT).short} ${C(CULPRIT).subject}`, "Use Math.trunc for the initial shares (reads clearer than floor for our positive-cents use case) and drop the sign comment. No behaviour change intended; tests green. files: src/money.js", ["knn"], 0.031),
  ev("commit", L.allocate, `${C(L.allocate).short} ${C(L.allocate).subject}`, "feat(money): add allocate() to split cents proportionally without losing pennies. files: src/money.js, test/money.test.js", ["bm25", "knn"], 0.029),
  ev("hunk", L.discounts, `${C(L.discounts).short} src/invoice.js @@ -13,6 +13,13 @@ export function subtotalCents(inv) {`, "+/** Distribute the invoice-level discount across lines, proportional to line totals. */\n+export function netLines(inv) {\n+  const gross = inv.lines.map(lineTotalCents);\n+  const discount = allocate(inv.discountCents, gross.map((g) => Math.abs(g)));", ["knn"], 0.027, "src/invoice.js"),
  ev("commit", L.moneyDocs, `${C(L.moneyDocs).short} ${C(L.moneyDocs).subject}`, "docs(money): document allocate() and toCents(). files: src/money.js", ["bm25"], 0.025),
];

function fuse(...sets: Evidence[][]): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const s of sets) for (const e of s) if (!seen.has(e.id) || (seen.get(e.id)?.score ?? 0) < e.score) seen.set(e.id, e);
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 18);
}

const SUSPECTS: Suspect[] = [
  { sha: C(CULPRIT).sha, score: 0.6, reason: "Math.floor → Math.trunc in allocate(): for negative totals the initial shares round toward zero and the remainder loop (remainder > 0) never distributes a negative remainder. CI 'reconcile differs by 0.01' warnings start right after this commit.", commit: pub(CULPRIT) },
  { sha: C(HERRING).sha, score: 0.58, reason: "Changes rounding of negative (credit-note) tax amounts — squarely in the symptom's code path and inside the reported window. Issue #12 comments already point a finger at it.", commit: pub(HERRING) },
  { sha: C(L.creditNotes).sha, score: 0.31, reason: "Introduced creditNote(): negated quantities and a negated discount — the exact input that triggers the symptom.", commit: pub(L.creditNotes) },
  { sha: C(L.discounts).sha, score: 0.22, reason: "Discount allocation across lines feeds the CSV TOTAL row that is now off by a cent.", commit: pub(L.discounts) },
  { sha: C(L.csvPerf).sha, score: 0.18, reason: "Rewrote the CSV row builder that emits the TOTAL row (perf refactor, 'no behaviour change').", commit: pub(L.csvPerf) },
  { sha: C(L.moneyDocs).sha, score: 0.12, reason: "Touched src/money.js inside the window (documentation only, low weight).", commit: pub(L.moneyDocs) },
];

const THEORY = `Two theories fit the complaint. (A) The symmetric-rounding fix in src/tax.js (#${HERRING} ${C(HERRING).short}) changed how negative subtotals round; it touches credit notes directly and landed in the window, and the issue thread already suspects it. (B) The allocate() refactor in src/money.js (#${CULPRIT} ${C(CULPRIT).short}) swapped Math.floor for Math.trunc: for negative totals trunc rounds toward zero, so the remainder loop, which only hands out positive cents, can no longer reconcile a negative discount — exactly one cent short, and only on credit notes WITH a discount, which is precisely what Issue #12 reports. The 'reconcile differs by 0.01' CI warnings begin after #${CULPRIT}, not after #${HERRING}. Prior leans (B) but keeps (A) live; the bisection will settle it.`;

const QUERIES = [
  "credit note discount CSV TOTAL off by one cent",
  "allocate remainder rounding negative cents Math.floor Math.trunc",
  "roundHalfUp negative amounts credit note tax",
];

function verdictMarkdown(confidence: number, probes: number, uniformSteps: number, gitVerdict?: number): string {
  const c = C(CULPRIT);
  const h = C(HERRING);
  const derailed =
    gitVerdict !== undefined && gitVerdict !== CULPRIT
      ? `\n> **Flaky oracle, handled.** One test run lied. Classic \`git bisect\` trusts every answer and would have condemned **#${gitVerdict} \`${C(gitVerdict).short}\`** — an innocent \`${C(gitVerdict).subject}\`. whodunit treated the lie as an ε-noise observation, re-interrogated, and recovered.\n`
      : "";
  return `## Verdict: \`${c.short}\` — ${c.subject}

**${(confidence * 100).toFixed(1)}% confidence after ${probes} probes.** Classic \`git bisect\` needs ${uniformSteps} for this lineup.
${derailed}
### What broke

\`allocate(totalCents, weights)\` in \`src/money.js\` now computes each share with \`Math.trunc\` instead of \`Math.floor\`. For a **negative** total — every credit note's discount — \`trunc\` rounds toward zero, so the shares sum to *more* than the total and the leftover becomes **−1 cent**. The distribution loop only runs \`while (remainder > 0)\`, so that cent is never handed out. The CSV \`TOTAL\` row sums the exported line nets and lands one cent away from \`summarize()\`.

### The evidence

- **Issue #12** — "only on credit notes that had a discount … started roughly three weeks ago" *(bm25+knn)*
- **Hunk \`src/money.js\` @ ${c.short}** — \`- Math.floor(…)\` / \`+ Math.trunc(…)\`, plus the deleted comment that explained why floor was chosen *(bm25+knn)*
- **CI logs after #${CULPRIT}** — \`report reconcile: CSV TOTAL differs from summarize() by 0.01 for CN-INV-10xx\` *(bm25)*
- **Bisection** — #${HERRING} clean, #${CULPRIT - 1} clean, #${CULPRIT} fails the oracle: bracketed.

### Red herring, cleared

\`${h.short} ${h.subject}\` (#${HERRING}) looked guilty — it also rewrites negative rounding for credit notes and the issue thread names it. But it predates the last good month-end run, and **the oracle passes at #${HERRING}**. Exonerated on the first probe.

### Fix

Restore \`Math.floor\` (or distribute a signed remainder). One line, plus a regression test for negative allocation.`;
}

const FIX_DIFF = `diff --git a/src/money.js b/src/money.js
index 5e51904..9c1f2a7 100644
--- a/src/money.js
+++ b/src/money.js
@@ -22,7 +22,8 @@ export function sumCents(list) {
 export function allocate(totalCents, weights) {
   const sum = weights.reduce((a, b) => a + b, 0);
   if (sum === 0) return weights.map(() => 0);
-  const shares = weights.map((w) => Math.trunc((totalCents * w) / sum));
+  // floor() rounds toward -Infinity, so the remainder is >= 0 for any sign of total (credit notes!)
+  const shares = weights.map((w) => Math.floor((totalCents * w) / sum));
   let remainder = totalCents - shares.reduce((a, b) => a + b, 0);
   for (let i = 0; remainder > 0; i = (i + 1) % shares.length) {
     shares[i] += 1;
diff --git a/test/money.test.js b/test/money.test.js
index 2b1c9d0..7e4a3f1 100644
--- a/test/money.test.js
+++ b/test/money.test.js
@@ -12,3 +12,8 @@ test("allocate sums to total", () => {
   assert.equal(allocate(999, [3, 2, 1]).reduce((a, b) => a + b, 0), 999);
 });
+
+test("allocate reconciles negative totals (credit notes)", () => {
+  assert.deepEqual(allocate(-1000, [1, 1, 1]), [-333, -333, -334]);
+  assert.equal(allocate(-999, [3, 2, 1]).reduce((a, b) => a + b, 0), -999);
+});
`;

/* ───────────────────────── the simulation ───────────────────────── */

export function startMockCase(opts: CaseOptions, onEvent: (e: CaseEvent) => void): CaseHandle {
  const signal = { cancelled: false };
  const caseId = hex(6);
  let probeWait: ((choice: number | "auto") => void) | null = null;
  let culpritFound = false;
  let confidenceAtEnd = 0;
  let probesAtEnd = 0;

  const emit = (e: CaseEvent) => {
    if (!signal.cancelled) onEvent(e);
  };
  const wait = (ms: number) => sleep(ms, signal);

  // The oracle: truthful, except (flaky mode) the FIRST time the culprit itself is tested it lies.
  let culpritTests = 0;
  const truth = (k: number): ProbeResult => (k >= CULPRIT ? "bad" : "good");
  const oracle = (k: number): { result: ProbeResult; flaked: boolean } => {
    const t = truth(k);
    if (opts.flaky && k === CULPRIT && culpritTests++ === 0) return { result: "good", flaked: true };
    return { result: t, flaked: false };
  };

  const run = async () => {
    emit({
      type: "opened",
      payload: {
        caseId,
        repo: demo.repo,
        description: opts.description,
        brain: "gemini-3.6-flash (simulated)",
        vectors: "gemini",
        range: `${C(0).short}..${C(N - 1).short}`,
        commitCount: N,
        oldest: pub(0),
        newest: pub(N - 1),
        commits: COMMITS.map((c) => ({ ...c })),
      },
    });
    await wait(500);

    /* 1 · investigation */
    emit({ type: "phase", payload: { phase: "investigate", title: "Dusting the case file" } });
    await wait(700);
    emit({ type: "tool", payload: { name: "search_evidence", args: { query: QUERIES[0] } } });
    await wait(1100);
    emit({ type: "evidence", payload: { items: EVIDENCE_1 } });
    await wait(900);
    emit({ type: "tool", payload: { name: "search_evidence", args: { query: QUERIES[1], kinds: ["hunk", "commit"] } } });
    await wait(1100);
    emit({ type: "evidence", payload: { items: fuse(EVIDENCE_1, EVIDENCE_2) } });
    await wait(700);
    emit({ type: "tool", payload: { name: "file_timeline", args: { file: "src/money.js" } } });
    await wait(800);
    emit({ type: "tool", payload: { name: "churn_hotspots", args: {} } });
    await wait(800);
    emit({ type: "tool", payload: { name: "ci_timeline", args: {} } });
    await wait(900);
    emit({ type: "tool", payload: { name: "file_suspicion", args: {} } });
    await wait(1000);
    emit({ type: "tool", payload: { name: "show_commit", args: { sha: C(CULPRIT).sha } } });
    await wait(900);
    emit({ type: "tool", payload: { name: "show_commit", args: { sha: C(HERRING).sha } } });
    await wait(900);
    emit({ type: "tool", payload: { name: "search_evidence", args: { query: QUERIES[2], kinds: ["hunk", "ci-log"] } } });
    await wait(1000);
    emit({ type: "evidence", payload: { items: fuse(EVIDENCE_1, EVIDENCE_2) } });
    await wait(600);
    emit({ type: "theory", payload: { notes: THEORY, mode: "agent", queries: QUERIES } });
    await wait(500);
    emit({ type: "suspects", payload: { suspects: SUSPECTS } });
    await wait(1200);

    /* 2 · reproduction */
    emit({ type: "phase", payload: { phase: "reproduce", title: "Reproducing the crime" } });
    await wait(1600);
    emit({
      type: "repro",
      payload: {
        explanation: `Oracle validated: fails at ${C(N - 1).short} (HEAD), passes at ${C(0).short}. Builds a discounted credit note and compares the CSV TOTAL row with summarize().`,
        command: "bash /tmp/whodunit-demo/repro-credit-note.sh",
        headOutput: "header total: -1249.99  csv TOTAL: -1249.98\nexit 1",
      },
    });
    await wait(900);

    /* 3 · bayesian bisection */
    const suspicion = new Map<number, number>();
    for (const s of SUSPECTS) if (s.commit) suspicion.set(s.commit.index, s.score);
    const prior = makePrior(N, suspicion, { floor: 0.25, temperature: 0.35 });
    const state = initState(prior, opts.eps);
    update(state, 0, "good");
    update(state, N - 1, "bad");
    const cache = new Map<number, ProbeResult>([
      [0, "good"],
      [N - 1, "bad"],
    ]);
    const board = () => {
      const max = Math.max(...state.posterior, 1e-9);
      return COMMITS.map((_, i) => pub(i, { p: state.posterior[i] / max, mass: state.posterior[i], probed: cache.get(i) }));
    };
    const priorBits = entropyBits(state.posterior);
    emit({
      type: "prior",
      payload: { entropyBits: priorBits, uniformBits: Math.log2(N - 1), uniformProbes: uniformProbes(N - 1), credible90: credibleSet(state, 0.9).length, board: board() },
    });
    await wait(900);
    emit({ type: "phase", payload: { phase: "bisect", title: "Interrogation room" } });
    await wait(600);

    const threshold = 0.95;
    const maxProbes = Math.max(8, uniformProbes(N) + 4);
    let step = 0;
    const probe = async (k: number, by: "detective" | "player") => {
      step++;
      const pb = pBad(state, k);
      emit({ type: "targeting", payload: { step, index: k, commit: pub(k), pBad: pb, by } });
      const dur = Math.round(rand(900, 1500));
      await wait(dur + 500);
      const { result, flaked } = oracle(k);
      cache.set(k, result);
      update(state, k, result);
      emit({
        type: "probe",
        payload: { step, index: k, commit: pub(k, { probed: result, p: state.posterior[k], mass: state.posterior[k] }), result, pBad: pb, durationMs: dur, by, ...(flaked ? { flaked: true } : {}) },
      });
      emit({ type: "posterior", payload: { board: board(), highlight: k } });
      await wait(900);
    };
    const bracketed = (c: number) => cache.get(c) === "bad" && cache.get(c - 1) === "good";

    while (step < maxProbes && !signal.cancelled) {
      const { index: c, p } = mostLikely(state);
      if (bracketed(c) && p >= Math.min(threshold, 0.9)) break;
      if (p >= threshold && !cache.has(c)) {
        await probe(c, "detective");
        continue;
      }
      if (p >= threshold && c > 0 && !cache.has(c - 1)) {
        await probe(c - 1, "detective");
        continue;
      }
      let k = nextProbe(state);
      if (k === null) break;
      if (opts.mode === "player") {
        const autoIndex = k;
        emit({
          type: "awaiting_probe",
          payload: { step: step + 1, autoIndex, autoCommit: pub(autoIndex), board: board(), message: "Pick a commit to interrogate — or let the detective take the information-optimal probe." },
        });
        const choice = await new Promise<number | "auto">((resolve) => {
          probeWait = resolve;
          const poll = setInterval(() => {
            if (signal.cancelled) {
              clearInterval(poll);
              resolve("auto");
            }
          }, 100);
        });
        probeWait = null;
        if (signal.cancelled) return;
        if (typeof choice === "number" && choice >= 0 && choice < N) k = choice;
        await probe(k, typeof choice === "number" && choice !== autoIndex ? "player" : "detective");
      } else {
        await probe(k, "detective");
      }
    }
    if (signal.cancelled) return;

    const { index: culpritIdx, p: conf } = mostLikely(state);
    const uniformSteps = uniformStepsFor(N, CULPRIT);
    // What would classic git bisect have concluded with the same oracle (including the lie)?
    let firstCulpritTest = true;
    const git = simulateGitBisect(N, (k) => {
      if (opts.flaky && k === CULPRIT && firstCulpritTest) {
        firstCulpritTest = false;
        return "good";
      }
      return truth(k);
    });
    culpritFound = true;
    confidenceAtEnd = conf;
    probesAtEnd = step;
    await wait(500);
    emit({
      type: "culprit",
      payload: {
        commit: pub(culpritIdx, { p: 1, mass: conf, probed: "bad" }),
        confidence: conf,
        probes: step,
        uniformSteps,
        ...(opts.flaky ? { gitVerdict: git.verdict, gitSteps: git.steps } : {}),
      },
    });
    await wait(1400);
    emit({ type: "verdict", payload: { markdown: verdictMarkdown(conf, step, uniformSteps, opts.flaky ? git.verdict : undefined) } });
    await wait(400);
    emit({ type: "closed", payload: { caseId, caseFile: `~/.whodunit/cases/${caseId}/case.md` } });
  };

  void run().catch((e) => emit({ type: "error", payload: { message: e instanceof Error ? e.message : String(e) } }));

  return {
    id: caseId,
    kind: "mock",
    async submitProbe(index) {
      if (!probeWait) throw new Error("not awaiting a probe");
      probeWait(index);
    },
    async requestFix(branch = "fix/whodunit-patch") {
      if (!culpritFound) throw new Error("No verdict yet — the case is still open.");
      emit({ type: "phase", payload: { phase: "amends", title: "Drafting a fix and proving it with the reproduction" } });
      await wait(2600);
      const amends: AmendsResult = {
        branch,
        commitSha: hex(40),
        summary: "Restore Math.floor in allocate() so negative totals (credit notes) round toward −∞ and the remainder loop can reconcile; add a regression test for negative allocation.",
        filesChanged: ["src/money.js", "test/money.test.js"],
        verifyPassed: true,
        diff: FIX_DIFF,
        commitMessage: `fix(money): allocate() must floor, not trunc, so negative totals reconcile\n\nCredit notes carry a negative discount. Math.trunc rounded shares toward zero, leaving a -1 cent remainder that the distribution loop never handed out. Confidence ${(confidenceAtEnd * 100).toFixed(1)}% after ${probesAtEnd} probes.`,
      };
      emit({ type: "amends", payload: amends });
      return amends;
    },
    close() {
      signal.cancelled = true;
      probeWait?.("auto");
    },
  };
}

export const DEMO_COMPLAINT = "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total. Started sometime in the last few weeks.";
export const DEMO_COMMIT_COUNT = N;
