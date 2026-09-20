import fs from "node:fs/promises";
import path from "node:path";
import { listTree, readFileAt, runAt, runShell, WorktreePool, type RunResult } from "../git.js";
import type { Evidence } from "../es/search.js";
import { runToolLoop } from "./llm.js";
import { ui } from "../ui.js";

export interface ReproTest {
  command: string; // shell command run from the repo root at each commit; exit 0 = good, non-zero = bad
  explanation: string;
  scriptPath?: string;
  attempts: number;
}

export interface ValidationOutcome {
  ok: boolean;
  newest: RunResult;
  oldest: RunResult;
  problem?: "passes_on_newest" | "fails_on_oldest" | "timeout";
}

export async function validateTest(
  pool: WorktreePool,
  command: string,
  newestSha: string,
  oldestSha: string,
  setup?: string,
  timeoutMs?: number,
): Promise<ValidationOutcome> {
  const newest = await runAt(pool, newestSha, command, { setup, timeoutMs });
  const oldest = await runAt(pool, oldestSha, command, { setup, timeoutMs });
  if (newest.timedOut || oldest.timedOut) return { ok: false, newest, oldest, problem: "timeout" };
  if (newest.exitCode === 0) return { ok: false, newest, oldest, problem: "passes_on_newest" };
  if (oldest.exitCode !== 0) return { ok: false, newest, oldest, problem: "fails_on_oldest" };
  return { ok: true, newest, oldest };
}

const tail = (s: string, n = 1500) => (s.length > n ? "…" + s.slice(-n) : s);

/**
 * Ask the model to write a reproduction script, then validate it: it must FAIL at the newest commit
 * and PASS at the oldest. Feedback from failed validations is fed back for up to `maxAttempts`.
 */
export async function synthesizeRepro(args: {
  repoPath: string;
  pool: WorktreePool;
  description: string;
  newestSha: string;
  oldestSha: string;
  evidence: Evidence[];
  notes: string;
  caseDir: string;
  setup?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  verbose?: boolean;
}): Promise<{ test: ReproTest; validation: ValidationOutcome }> {
  const headDir = await args.pool.checkout(args.newestSha);
  const tree = await listTree(args.repoPath, args.newestSha);
  const scriptPath = path.join(args.caseDir, "repro.sh");
  await fs.mkdir(args.caseDir, { recursive: true });

  const tools = [
    {
      name: "read_file",
      description: "Read a file at the newest commit (or at a given sha).",
      parameters: { type: "object", properties: { path: { type: "string" }, sha: { type: "string" } }, required: ["path"] },
      handler: async (a: { path: string; sha?: string }) => (await readFileAt(args.repoPath, a.sha ?? args.newestSha, a.path)) ?? "not found",
    },
    {
      name: "run",
      description: "Run a shell command in a scratch checkout of the newest commit (to try things out). Returns exit code and output.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      handler: async (a: { command: string }) => {
        const r = await runShell(headDir, a.command, { timeoutMs: 60_000 });
        return `exit=${r.exitCode}\nstdout:\n${tail(r.stdout)}\nstderr:\n${tail(r.stderr)}`;
      },
    },
  ];

  const system = `You are whodunit's reproduction specialist. Write a SMALL, DETERMINISTIC bash script that reproduces the reported
regression. The script will be executed with the repository root as the working directory, at MANY different historical commits,
so it must:
- exit 0 when the behaviour is CORRECT (the bug is absent), non-zero when the bug is PRESENT;
- rely only on what the repository provides at those commits (no network, no new dependencies); prefer invoking the project's own
  modules/CLI directly (e.g. node -e, python -c, a tiny inline test) over the full test suite;
- print the observed vs expected values so a human can read the failure;
- be robust to small API differences across commits where possible (but it is acceptable for it to fail when the bug is present).

Use read_file / run to inspect the code and iterate until your script FAILS at the current (newest) commit.
When confident, reply with ONLY JSON: {"script":"<bash script contents>","explanation":"<one sentence: what it checks>"}`;

  const evidenceSummary = args.evidence
    .slice(0, 10)
    .map((e) => `- [${e.kind}] ${e.title}\n  ${e.snippet.split("\n").slice(0, 6).join("\n  ")}`)
    .join("\n");

  let feedback = "";
  let attempts = 0;
  const maxAttempts = args.maxAttempts ?? 3;
  let lastValidation: ValidationOutcome | null = null;

  while (attempts < maxAttempts) {
    attempts++;
    const user = `Bug report: ${args.description}

Detective's notes: ${args.notes}

Repository files (newest commit):
${tree.slice(0, 200).join("\n")}

Relevant evidence:
${evidenceSummary}
${feedback}`;

    const res = await runToolLoop(system, user, tools as never, {
      maxTurns: 12,
      onToolCall: (name, a) => {
        if (args.verbose !== false) console.log(`  ${ui.dim("→")} ${ui.dim(name)} ${ui.dim(JSON.stringify(a).slice(0, 110))}`);
      },
    });
    let parsed: { script?: string; explanation?: string } = {};
    try {
      const m = res.finalText.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
    if (!parsed.script) {
      feedback = `\nYour previous reply did not contain valid JSON with a "script" field. Reply with ONLY the JSON object.`;
      continue;
    }
    await fs.writeFile(scriptPath, parsed.script.endsWith("\n") ? parsed.script : parsed.script + "\n");
    const command = `bash "${scriptPath}"`;
    await args.pool.reset(args.newestSha); // drop any scratch files the agent left while exploring
    const validation = await validateTest(args.pool, command, args.newestSha, args.oldestSha, args.setup, args.timeoutMs);
    lastValidation = validation;
    if (validation.ok) {
      return {
        test: { command, explanation: parsed.explanation ?? "", scriptPath, attempts },
        validation,
      };
    }
    const why =
      validation.problem === "passes_on_newest"
        ? `Your script PASSED (exit 0) at the newest commit, but the bug is supposed to be present there. It does not reproduce the bug yet.`
        : validation.problem === "fails_on_oldest"
          ? `Your script FAILED at the OLDEST commit in the range (${args.oldestSha.slice(0, 7)}), where the bug should be absent. Either the check is too strict / depends on an API that did not exist yet, or the assertion itself is wrong. Make the script work at old commits too (feature-detect, use the public API that exists in both).`
          : `Your script timed out.`;
    feedback = `\nPREVIOUS ATTEMPT (${attempts}/${maxAttempts}) REJECTED: ${why}
Newest commit run: exit=${validation.newest.exitCode}\nstdout: ${tail(validation.newest.stdout, 800)}\nstderr: ${tail(validation.newest.stderr, 800)}
Oldest commit run: exit=${validation.oldest.exitCode}\nstdout: ${tail(validation.oldest.stdout, 800)}\nstderr: ${tail(validation.oldest.stderr, 800)}
Previous script:\n${parsed.script}`;
  }
  throw new Error(
    `Could not synthesize a reproduction that fails at HEAD and passes at ${args.oldestSha.slice(0, 7)} after ${attempts} attempts` +
      (lastValidation?.problem ? ` (last problem: ${lastValidation.problem})` : "") +
      `. Provide one with --test "<command>".`,
  );
}
