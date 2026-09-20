import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, readFileAt, runShell, type CommitInfo, type Hunk } from "../git.js";
import { chatJSON } from "./llm.js";
import { ui } from "../ui.js";

const execFileP = promisify(execFile);

export interface AmendsResult {
  branch: string;
  commitSha: string;
  summary: string;
  filesChanged: string[];
  prUrl?: string;
  verifyPassed?: boolean;
  /** unified diff of the fix commit (HEAD..branch) */
  diff?: string;
  commitMessage?: string;
}

interface FixProposal {
  files: { path: string; content: string }[];
  commit_message: string;
  summary: string;
}

/**
 * Propose a minimal fix for the culprit, apply it on a fresh branch, and prove it with the repro test.
 */
export async function makeAmends(args: {
  repoPath: string;
  headSha: string;
  culprit: CommitInfo;
  hunks: Hunk[];
  description: string;
  verdict: string;
  reproCommand: string;
  reproOutput: string;
  caseId: string;
  verify?: string;
  setup?: string;
  openPr?: boolean;
  maxAttempts?: number;
  branch?: string;
}): Promise<AmendsResult> {
  const branch = args.branch ?? `whodunit/fix-${args.caseId}`;
  const dir = path.join(path.dirname(args.repoPath), `.whodunit-fix-${args.caseId}`);
  await fs.rm(dir, { recursive: true, force: true });
  await git(args.repoPath, ["branch", "-D", branch]).catch(() => {});
  await git(args.repoPath, ["worktree", "add", "-b", branch, dir, args.headSha]);

  try {
    if (args.setup) {
      const s = await runShell(dir, args.setup, { timeoutMs: 300_000 });
      if (s.exitCode !== 0) throw new Error(`setup failed: ${s.stderr.slice(-500)}`);
    }

    const files = [...new Set(args.hunks.map((h) => h.file))];
    const current: Record<string, string> = {};
    for (const f of files) {
      const c = await readFileAt(args.repoPath, args.headSha, f);
      if (c !== null) current[f] = c;
    }

    let feedback = "";
    let last: FixProposal | null = null;
    const maxAttempts = args.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const proposal = await chatJSON<FixProposal>(
        `You are whodunit's fixer. Given the culprit commit's diff and the CURRENT contents of the affected files (at HEAD, which may have
changed since the culprit), produce a MINIMAL fix that restores correct behaviour without reverting unrelated improvements.
Return the FULL new contents of each file you change. Reply with ONLY JSON:
{"files":[{"path":"<path>","content":"<full file content>"}],"commit_message":"<conventional commit subject + body>","summary":"<1-2 sentences>"}`,
        `Bug report: ${args.description}

Verdict:
${args.verdict}

Culprit ${args.culprit.short}: ${args.culprit.subject}
Culprit diff:
${args.hunks.map((h) => `${h.file} ${h.header}\n${h.text.slice(0, 3000)}`).join("\n\n")}

Current file contents at HEAD:
${Object.entries(current)
  .map(([p, c]) => `===== ${p} =====\n${c.slice(0, 12000)}`)
  .join("\n\n")}

Reproduction failure output at HEAD:
${args.reproOutput.slice(0, 1200)}
${feedback}`,
      );
      last = proposal;
      if (!proposal.files?.length) {
        feedback = "\nPrevious reply had no files. Return at least one file.";
        continue;
      }
      // reset any previous attempt
      await git(dir, ["checkout", "--", "."]).catch(() => {});
      for (const f of proposal.files) {
        const p = path.join(dir, f.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, f.content);
      }
      const repro = await runShell(dir, args.reproCommand, { timeoutMs: 120_000 });
      if (repro.exitCode !== 0) {
        feedback = `\nATTEMPT ${attempt} REJECTED: the reproduction test still fails after your change.\nstdout: ${repro.stdout.slice(-800)}\nstderr: ${repro.stderr.slice(-800)}`;
        console.log(`  ${ui.dim(`fix attempt ${attempt}: repro still failing`)}`);
        continue;
      }
      let verifyPassed: boolean | undefined;
      if (args.verify) {
        const v = await runShell(dir, args.verify, { timeoutMs: 600_000 });
        verifyPassed = v.exitCode === 0;
        if (!verifyPassed) {
          feedback = `\nATTEMPT ${attempt} REJECTED: repro passes but the verification command "${args.verify}" fails.\nstdout: ${v.stdout.slice(-800)}\nstderr: ${v.stderr.slice(-800)}`;
          console.log(`  ${ui.dim(`fix attempt ${attempt}: verification failing`)}`);
          continue;
        }
      }
      await git(dir, ["add", "-A"]);
      const msg = `${proposal.commit_message.trim()}\n\nFixes regression introduced in ${args.culprit.sha}.\nCase: whodunit/${args.caseId}`;
      await git(dir, ["-c", "user.name=whodunit", "-c", "user.email=whodunit@localhost", "commit", "-q", "-m", msg]);
      const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
      const diff = await git(dir, ["diff", `${args.headSha}..${sha}`]).catch(() => "");

      let prUrl: string | undefined;
      if (args.openPr) {
        try {
          await git(dir, ["push", "-u", "origin", branch]);
          const { stdout } = await execFileP(
            "gh",
            ["pr", "create", "--fill", "--title", proposal.commit_message.split("\n")[0], "--body", `${proposal.summary}\n\n---\n${args.verdict}`],
            { cwd: dir },
          );
          prUrl = stdout.trim().split("\n").pop();
        } catch (e) {
          console.log(`  ${ui.dim(`could not open PR: ${e instanceof Error ? e.message.split("\n")[0] : e}`)}`);
        }
      }
      return {
        branch,
        commitSha: sha,
        summary: proposal.summary,
        filesChanged: proposal.files.map((f) => f.path),
        prUrl,
        verifyPassed,
        diff: diff.slice(0, 20_000),
        commitMessage: proposal.commit_message.trim(),
      };
    }
    throw new Error(`Could not produce a passing fix after ${maxAttempts} attempts${last ? ` (last idea: ${last.summary})` : ""}`);
  } finally {
    await git(args.repoPath, ["worktree", "remove", "--force", dir]).catch(() => fs.rm(dir, { recursive: true, force: true }));
  }
}
