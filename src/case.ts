import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { credibleSet, entropyBits, initState, makePrior, mostLikely, nextProbe, pBad, update, uniformProbes, type BisectState } from "./bayes.js";
import { config } from "./config.js";
import { bulkIndex, INDEX } from "./es/client.js";
import { listCiStatus, listCommits } from "./es/search.js";
import { commitHunks, gitLog, headSha, repoName, runAt, WorktreePool, type CommitInfo } from "./git.js";
import { investigate, type Investigation } from "./agent/investigate.js";
import { synthesizeRepro, validateTest, type ReproTest } from "./agent/repro.js";
import { writeVerdict } from "./agent/verdict.js";
import { makeAmends, type AmendsResult } from "./agent/amends.js";
import { hasLLM, llmLabel } from "./agent/llm.js";
import { ui } from "./ui.js";
import { publicCommit, type CaseEmitter, type ChooseProbe } from "./events.js";

export interface SolveOptions {
  repoPath: string;
  description: string;
  test?: string;
  setup?: string;
  verify?: string;
  fix?: boolean;
  pr?: boolean;
  eps?: number;
  /** Demo knob: probability that an observed probe result is flipped, to simulate a flaky oracle. */
  noise?: number;
  confidence?: number;
  maxProbes?: number;
  timeoutMs?: number;
  verbose?: boolean;
  onEvent?: CaseEmitter;
  chooseProbe?: ChooseProbe;
}

type Pub = (c: CommitInfo, extra?: { p?: number; mass?: number; probed?: "good" | "bad" }) => ReturnType<typeof publicCommit>;

export interface CaseResult {
  caseId: string;
  culprit: CommitInfo;
  state: BisectState;
  investigation: Investigation;
  test: ReproTest;
  verdict: string;
  amends?: AmendsResult;
  uniformSteps: number;
  caseFile: string;
}

/** Classic git-bisect step count for the same culprit (midpoint probing on [1, n-1]). */
export function simulateUniformBisect(n: number, culprit: number): number {
  let lo = 1; // index 0 known good
  let hi = n - 1; // known bad
  let steps = 0;
  while (hi > lo) {
    const mid = Math.floor((lo + hi) / 2);
    steps++;
    if (mid >= culprit) hi = mid;
    else lo = mid + 1;
  }
  return steps;
}

/** The whole lineup with relative heat (p) and absolute mass, so a UI can paint every commit. */
function boardOf(pub: Pub, commits: CommitInfo[], posterior: number[], probed: Map<number, "good" | "bad">) {
  const max = Math.max(...posterior, 1e-9);
  return commits.map((c, i) => pub(c, { p: posterior[i] / max, mass: posterior[i], probed: probed.get(i) }));
}

export async function solveCase(opts: SolveOptions): Promise<CaseResult> {
  const repo = await repoName(opts.repoPath);
  const caseId = crypto.randomBytes(3).toString("hex");
  const caseDir = path.join(config.homeDir, "cases", caseId);
  await fs.mkdir(caseDir, { recursive: true });
  const emit: CaseEmitter = (e) => opts.onEvent?.(e);

  ui.section("CASE FILE");
  ui.kv("repo", repo);
  ui.kv("case", caseId);
  ui.kv("complaint", `"${opts.description}"`);
  ui.kv("brain", hasLLM() ? llmLabel() : ui.dim("none (heuristic mode) — set GEMINI_API_KEY"));
  ui.kv("vectors", config.embedProvider === "none" ? ui.dim("BM25 only — set GEMINI_API_KEY for hybrid") : config.embedProvider);

  // The range under investigation is whatever was indexed for this repo.
  const indexed = await listCommits(repo);
  if (indexed.length < 3) throw new Error(`Only ${indexed.length} commits indexed for ${repo}. Run: whodunit index --repo ${opts.repoPath}`);
  const gitCommits = await gitLog(opts.repoPath, { range: `${indexed[0].sha}~1..${indexed[indexed.length - 1].sha}` }).catch(() =>
    gitLog(opts.repoPath, { limit: indexed.length }),
  );
  const bySha = new Map(gitCommits.map((c) => [c.sha, c]));
  const commits: CommitInfo[] = indexed.map((c, i) => ({
    ...(bySha.get(c.sha) ?? { sha: c.sha, short: c.short, author: c.author, email: "", date: c.date, subject: c.subject, message: "", files: c.files, insertions: 0, deletions: 0, order: i }),
    order: i,
  }));
  const n = commits.length;
  const oldest = commits[0];
  const newest = commits[n - 1];
  const ciBySha = await listCiStatus(repo);
  const pub: Pub = (c, extra = {}) => publicCommit(c, { ci: ciBySha.get(c.sha), ...extra });
  ui.kv("range", `${oldest.short}..${newest.short} (${n} commits, ${oldest.date.slice(0, 10)} → ${newest.date.slice(0, 10)})`);
  emit({
    type: "opened",
    payload: {
      caseId,
      repo,
      description: opts.description,
      brain: hasLLM() ? llmLabel() : "heuristic",
      vectors: config.embedProvider,
      range: `${oldest.short}..${newest.short}`,
      commitCount: n,
      oldest: pub(oldest),
      newest: pub(newest),
      commits: commits.map((c) => pub(c)),
    },
  });

  /* 1. Investigate ------------------------------------------------------ */
  ui.section("1 · INVESTIGATION");
  emit({ type: "phase", payload: { phase: "investigate", title: "Dusting the case file" } });
  const investigation = await investigate(repo, opts.description, {
    verbose: opts.verbose,
    onToolCall: (name, args) => emit({ type: "tool", payload: { name, args } }),
    onEvidence: (items) => emit({ type: "evidence", payload: { items: items.slice(0, 18) } }),
  });
  console.log(`  ${ui.dim(`${investigation.queries.length} searches · ${investigation.evidence.length} pieces of evidence`)}`);
  if (investigation.notes) console.log(`\n  ${ui.bold("Theory:")} ${investigation.notes.trim().replace(/\n+/g, " ")}\n`);
  ui.evidence(investigation.evidence, 6);
  if (investigation.suspects.length) {
    console.log(`\n  ${ui.bold("Suspects:")}`);
    for (const s of investigation.suspects.slice(0, 6)) {
      const c = commits.find((c) => c.sha === s.sha);
      console.log(`   ${ui.bold((s.score * 100).toFixed(0).padStart(3) + "%")} ${c ? `#${c.order} ${c.short} ${c.subject.slice(0, 50)}` : s.sha.slice(0, 7)}\n        ${ui.dim(s.reason.slice(0, 120))}`);
    }
  }
  emit({ type: "evidence", payload: { items: investigation.evidence.slice(0, 18) } });
  emit({ type: "theory", payload: { notes: investigation.notes, mode: investigation.mode, queries: investigation.queries } });
  emit({
    type: "suspects",
    payload: {
      suspects: investigation.suspects.slice(0, 8).map((s) => ({
        ...s,
        commit: (() => {
          const c = commits.find((c) => c.sha === s.sha);
          return c ? pub(c) : undefined;
        })(),
      })),
    },
  });

  /* 2. Reproduce -------------------------------------------------------- */
  ui.section("2 · REPRODUCTION");
  const pool = new WorktreePool(opts.repoPath);
  let test: ReproTest;
  let reproOutputAtHead: string;
  try {
    if (opts.test) {
      const spin = ui.spinner(`Validating provided test at ${newest.short} (must fail) and ${oldest.short} (must pass)`);
      const v = await validateTest(pool, opts.test, newest.sha, oldest.sha, opts.setup, opts.timeoutMs);
      if (!v.ok) {
        spin.stop(`Test is not a valid oracle: ${v.problem}`, false);
        if (v.problem === "fails_on_oldest") throw new Error(`The test also fails at the oldest indexed commit ${oldest.short}; the culprit predates the range. Re-index with a larger --limit/--range.`);
        if (v.problem === "passes_on_newest") throw new Error(`The test passes at HEAD — it does not reproduce the bug.`);
        throw new Error("Test timed out.");
      }
      spin.stop(`Oracle validated: fails at ${newest.short}, passes at ${oldest.short}`);
      test = { command: opts.test, explanation: "user-provided test command", attempts: 0 };
      reproOutputAtHead = v.newest.stdout + v.newest.stderr;
    } else {
      if (!hasLLM()) throw new Error("No GEMINI_API_KEY: either set it so the agent can write a reproduction, or pass --test '<command>'.");
      console.log(`  ${ui.dim("Writing a reproduction script that must fail at HEAD and pass at the oldest commit…")}`);
      const r = await synthesizeRepro({
        repoPath: opts.repoPath,
        pool,
        description: opts.description,
        newestSha: newest.sha,
        oldestSha: oldest.sha,
        evidence: investigation.evidence,
        notes: investigation.notes,
        caseDir,
        setup: opts.setup,
        timeoutMs: opts.timeoutMs,
        verbose: opts.verbose,
      });
      test = r.test;
      reproOutputAtHead = r.validation.newest.stdout + r.validation.newest.stderr;
      ui.ok(`Reproduction validated in ${test.attempts} attempt(s): ${ui.dim(test.explanation)}`);
      ui.kv("script", test.scriptPath ?? test.command);
    }
    const headOut = reproOutputAtHead.trim().split("\n").slice(-3).join("\n      ");
    if (headOut) console.log(`  ${ui.dim("at HEAD:")} ${ui.dim(headOut.slice(0, 300))}`);
    emit({ type: "repro", payload: { explanation: test.explanation, command: test.command, headOutput: reproOutputAtHead.trim().slice(-400) } });

    /* 3. Bayesian bisection ------------------------------------------- */
    ui.section("3 · BAYESIAN BISECTION");
    const suspicionByIndex = new Map<number, number>();
    for (const c of commits) {
      const s = investigation.suspicion.get(c.sha);
      if (s) suspicionByIndex.set(c.order, s);
    }
    // A keyword-only prior is less trustworthy than the agent's, so keep more mass on the uniform floor.
    const prior = makePrior(n, suspicionByIndex, { floor: investigation.mode === "agent" ? 0.25 : 0.5, temperature: 0.35 });
    const state = initState(prior, opts.eps ?? 0.01);
    // Known facts from validation: oldest is good, newest is bad.
    update(state, 0, "good", 0);
    update(state, n - 1, "bad", 0);
    const priorBits = entropyBits(state.posterior);
    console.log(`  prior entropy ${ui.bold(priorBits.toFixed(2) + " bits")} ${ui.dim(`(uniform would be ${Math.log2(n - 1).toFixed(2)} bits ≈ ${uniformProbes(n - 1)} probes)`)}`);
    console.log(`  90% credible set: ${ui.bold(String(credibleSet(state, 0.9).length))} commits\n`);
    ui.posterior(state, (i) => `${commits[i].short} ${commits[i].subject}`, { maxRows: 10 });
    console.log();
    emit({
      type: "prior",
      payload: {
        entropyBits: priorBits,
        uniformBits: Math.log2(n - 1),
        uniformProbes: uniformProbes(n - 1),
        credible90: credibleSet(state, 0.9).length,
        board: boardOf(pub, commits, state.posterior, new Map([[0, "good"], [n - 1, "bad"]])),
      },
    });
    emit({ type: "phase", payload: { phase: "bisect", title: "Interrogation room" } });

    const threshold = opts.confidence ?? 0.95;
    const maxProbes = opts.maxProbes ?? Math.max(8, uniformProbes(n) + 4);
    let step = 0;
    const cache = new Map<number, "good" | "bad">([[0, "good"], [n - 1, "bad"]]);
    const noise = Math.min(0.9, Math.max(0, opts.noise ?? 0));
    const probe = async (k: number, by: "detective" | "player" = "detective") => {
      step++;
      const c = commits[k];
      const pb = pBad(state, k);
      const r = await runAt(pool, c.sha, test.command, { setup: opts.setup, timeoutMs: opts.timeoutMs });
      const truth: "good" | "bad" = r.exitCode === 0 ? "good" : "bad";
      // Simulated flaky oracle (demo): sometimes the test lies. The Bayesian update treats every
      // observation as noisy (eps), so a lie costs a probe or two instead of derailing the search.
      const flaked = noise > 0 && Math.random() < noise;
      const result: "good" | "bad" = flaked ? (truth === "good" ? "bad" : "good") : truth;
      cache.set(k, result);
      update(state, k, result, r.durationMs);
      ui.probeLine(step, k, c.short, c.subject, result, pb, r.durationMs);
      if (flaked) console.log(`  ${ui.dim("(simulated flake: the oracle lied on this run)")}`);
      emit({
        type: "probe",
        payload: {
          step,
          index: k,
          commit: pub(c, { probed: result, p: state.posterior[k], mass: state.posterior[k] }),
          result,
          pBad: pb,
          durationMs: r.durationMs,
          by,
          ...(flaked ? { flaked: true } : {}),
        },
      });
      emit({ type: "posterior", payload: { board: boardOf(pub, commits, state.posterior, cache), highlight: k } });
      return result;
    };

    // Stop when the leading suspect is *bracketed* (it tested bad, its parent tested good — the same
    // evidence git bisect stops on) AND the posterior agrees. Under the flake model a bracket alone
    // leaves ~1/(1+k·eps) confidence, so with a flaky oracle (--eps 0.1) whodunit keeps re-testing.
    const bracketed = (c: number) => cache.get(c) === "bad" && cache.get(c - 1) === "good";
    while (step < maxProbes) {
      const { index: c, p } = mostLikely(state);
      if (bracketed(c) && p >= Math.min(threshold, 0.9)) break;
      if (p >= threshold && !cache.has(c)) {
        await probe(c);
        continue;
      }
      if (p >= threshold && c > 0 && !cache.has(c - 1)) {
        await probe(c - 1);
        continue;
      }
      let k = nextProbe(state);
      if (k === null) break;
      if (opts.chooseProbe) {
        const autoIndex = k;
        emit({
          type: "awaiting_probe",
          payload: {
            step: step + 1,
            autoIndex,
            autoCommit: pub(commits[autoIndex]),
            board: boardOf(pub, commits, state.posterior, cache),
            message: "Pick a commit to interrogate — or let the detective take the information-optimal probe.",
          },
        });
        const choice = await opts.chooseProbe({
          caseId,
          step: step + 1,
          autoIndex,
          board: boardOf(pub, commits, state.posterior, cache),
        });
        if (typeof choice === "number" && choice >= 0 && choice < n) k = choice;
        await probe(k, typeof choice === "number" && choice !== autoIndex ? "player" : "detective");
      } else {
        await probe(k, "detective");
      }
    }

    const { index: culpritIdx, p: conf } = mostLikely(state);
    const culprit = commits[culpritIdx];
    const uniformSteps = simulateUniformBisect(n, culpritIdx);
    console.log();
    ui.posterior(state, (i) => `${commits[i].short} ${commits[i].subject}`, { highlight: culpritIdx, maxRows: 8 });
    console.log();
    ui.ok(
      `Culprit ${ui.bold(`#${culpritIdx} ${culprit.short}`)} with ${ui.bold((conf * 100).toFixed(1) + "%")} confidence after ${ui.bold(String(step))} probes ${ui.dim(`(git bisect would have needed ${uniformSteps})`)}`,
    );
    emit({
      type: "culprit",
      payload: { commit: pub(culprit, { p: 1, mass: conf, probed: "bad" }), confidence: conf, probes: step, uniformSteps },
    });

    /* 4. Verdict ---------------------------------------------------- */
    ui.section("4 · VERDICT");
    const hunks = await commitHunks(opts.repoPath, culprit.sha);
    const culpritRun = await runAt(pool, culprit.sha, test.command, { setup: opts.setup, timeoutMs: opts.timeoutMs });
    const spin = ui.spinner("Writing the case report");
    const verdict = await writeVerdict({
      repo,
      description: opts.description,
      culprit,
      hunks,
      evidence: investigation.evidence,
      notes: investigation.notes,
      state,
      commits,
      uniformSteps,
      reproExplanation: test.explanation,
      reproOutput: culpritRun.stdout + culpritRun.stderr,
    });
    spin.stop("Case report ready");
    console.log("\n" + indent(verdict) + "\n");
    emit({ type: "verdict", payload: { markdown: verdict } });

    /* 5. Amends ----------------------------------------------------- */
    let amends: AmendsResult | undefined;
    if (opts.fix) {
      ui.section("5 · AMENDS");
          if (!hasLLM()) ui.warn("--fix needs GEMINI_API_KEY; skipping.");
      else {
        const spinFix = ui.spinner("Drafting a minimal fix and proving it with the reproduction");
        try {
          amends = await makeAmends({
            repoPath: opts.repoPath,
            headSha: await headSha(opts.repoPath),
            culprit,
            hunks,
            description: opts.description,
            verdict,
            reproCommand: test.command,
            reproOutput: reproOutputAtHead,
            caseId,
            verify: opts.verify,
            setup: opts.setup,
            openPr: opts.pr,
          });
          spinFix.stop(`Fix committed on branch ${ui.bold(amends.branch)} (${amends.commitSha.slice(0, 7)})`);
          ui.kv("changed", amends.filesChanged.join(", "));
          ui.kv("summary", amends.summary);
          if (amends.verifyPassed !== undefined) ui.kv("verify", amends.verifyPassed ? "passed" : "failed");
          if (amends.prUrl) ui.kv("pull request", amends.prUrl);
          else console.log(`  ${ui.dim(`review with: git -C ${opts.repoPath} diff HEAD..${amends.branch}`)}`);
          emit({ type: "amends", payload: amends });
        } catch (e) {
          spinFix.stop(`No fix: ${e instanceof Error ? e.message : e}`, false);
        }
      }
    }

    /* Persist the case --------------------------------------------- */
    const caseFile = path.join(caseDir, "case.md");
    await fs.writeFile(
      caseFile,
      renderCaseFile({ caseId, repo, description: opts.description, commits, state, culprit, investigation, test, verdict, amends, uniformSteps, priorBits }),
    );
    await bulkIndex(
      INDEX.cases,
      [
        {
          _key: caseId,
          repo,
          case_id: caseId,
          description: opts.description,
          culprit: culprit.sha,
          probes: step,
          uniform_probes: uniformSteps,
          prior_entropy_bits: priorBits,
          confidence: conf,
          created: new Date().toISOString(),
          verdict,
        },
      ],
      "_key",
    ).catch(() => {});
    ui.info(`Case file written to ${caseFile}`);
    emit({ type: "closed", payload: { caseId, caseFile } });

    return { caseId, culprit, state, investigation, test, verdict, amends, uniformSteps, caseFile };
  } finally {
    await pool.cleanup();
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

function renderCaseFile(a: {
  caseId: string;
  repo: string;
  description: string;
  commits: CommitInfo[];
  state: BisectState;
  culprit: CommitInfo;
  investigation: Investigation;
  test: ReproTest;
  verdict: string;
  amends?: AmendsResult;
  uniformSteps: number;
  priorBits: number;
}): string {
  const probes = a.state.probes
    .filter((p) => p.durationMs > 0)
    .map((p, i) => `| ${i + 1} | #${p.index} \`${a.commits[p.index].short}\` | ${a.commits[p.index].subject} | ${(p.pBadBefore * 100).toFixed(0)}% | **${p.result}** | ${p.durationMs} ms |`)
    .join("\n");
  return `# whodunit case ${a.caseId} — ${a.repo}

> ${a.description}

${a.verdict}

## Bayesian bisection log

Prior entropy: ${a.priorBits.toFixed(2)} bits (uniform: ${Math.log2(a.state.n - 1).toFixed(2)}). Probes: ${a.state.probes.filter((p) => p.durationMs > 0).length} vs ${a.uniformSteps} for classic \`git bisect\`.

| # | commit | subject | P(bad) before | result | time |
|---|--------|---------|---------------|--------|------|
${probes}

## Reproduction

${a.test.explanation}

\`\`\`bash
${a.test.command}
\`\`\`

## Evidence consulted (${a.investigation.evidence.length})

${a.investigation.evidence
  .slice(0, 15)
  .map((e) => `- **${e.kind}** ${e.title} _(${e.via.join("+")})_`)
  .join("\n")}

Search queries: ${a.investigation.queries.map((q) => `"${q}"`).join(", ")}

${a.amends ? `## Amends\n\nBranch \`${a.amends.branch}\` (${a.amends.commitSha.slice(0, 7)}): ${a.amends.summary}\n${a.amends.prUrl ? `\nPR: ${a.amends.prUrl}` : ""}` : ""}
`;
}
