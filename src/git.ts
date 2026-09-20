import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

export interface CommitInfo {
  sha: string;
  short: string;
  order: number; // 0 = oldest in range
  author: string;
  email: string;
  date: string; // ISO
  subject: string;
  message: string;
  files: string[];
  insertions: number;
  deletions: number;
}

export interface Hunk {
  file: string;
  header: string;
  text: string;
}

export async function git(repo: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd: repo, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
  return stdout;
}

export async function repoName(repo: string): Promise<string> {
  try {
    const url = (await git(repo, ["remote", "get-url", "origin"])).trim();
    const m = url.match(/([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    /* no remote */
  }
  const top = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
  return path.basename(top);
}

export async function headSha(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

/**
 * Commits in range, oldest first. `range` is a git revision range (e.g. "v1.2..HEAD");
 * when omitted, the last `limit` commits on HEAD (first-parent) are used.
 */
export async function gitLog(repo: string, opts: { range?: string; limit?: number } = {}): Promise<CommitInfo[]> {
  const SEP = "\u001e"; // record separator
  const FIELD = "\u001f";
  const fmt = ["%H", "%h", "%an", "%ae", "%aI", "%s", "%B"].join(FIELD);
  const args = ["log", "--first-parent", "--reverse", "--numstat", `--format=${SEP}${fmt}${FIELD}`];
  if (opts.range) args.push(opts.range);
  else args.push(`-n${opts.limit ?? 200}`, "HEAD");
  const out = await git(repo, args);

  const commits: CommitInfo[] = [];
  for (const rec of out.split(SEP)) {
    if (!rec.trim()) continue;
    const parts = rec.split(FIELD);
    if (parts.length < 8) continue;
    const [sha, short, author, email, date, subject, body, rest] = parts;
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of rest.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      insertions += m[1] === "-" ? 0 : Number(m[1]);
      deletions += m[2] === "-" ? 0 : Number(m[2]);
      files.push(m[3].trim());
    }
    commits.push({
      sha,
      short,
      order: commits.length,
      author,
      email,
      date,
      subject,
      message: body.trim(),
      files,
      insertions,
      deletions,
    });
  }
  return commits;
}

/** Parse `git show` output into hunks. Binary files and huge hunks are skipped/truncated. */
export async function commitHunks(repo: string, sha: string, maxHunkChars = 6000): Promise<Hunk[]> {
  const out = await git(repo, ["show", "--format=", "--unified=3", "--no-color", "--first-parent", "-m", sha]);
  const hunks: Hunk[] = [];
  let file = "";
  let header = "";
  let buf: string[] = [];
  const flush = () => {
    if (file && header && buf.length) {
      hunks.push({ file, header, text: buf.join("\n").slice(0, maxHunkChars) });
    }
    buf = [];
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      header = "";
      const m = line.match(/ b\/(.+)$/);
      file = m ? m[1] : line.slice(11);
    } else if (line.startsWith("@@")) {
      flush();
      header = line;
    } else if (line.startsWith("Binary files")) {
      buf = [];
      header = "";
    } else if (header) {
      buf.push(line);
    }
  }
  flush();
  return hunks;
}

export async function readFileAt(repo: string, sha: string, file: string): Promise<string | null> {
  try {
    return await git(repo, ["show", `${sha}:${file}`]);
  } catch {
    return null;
  }
}

export async function listTree(repo: string, sha: string): Promise<string[]> {
  const out = await git(repo, ["ls-tree", "-r", "--name-only", sha]);
  return out.split("\n").filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Worktrees + running commands at a given commit                      */
/* ------------------------------------------------------------------ */

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class WorktreePool {
  private dirs = new Map<string, string>();
  private base: string;
  constructor(private repo: string, base?: string) {
    this.base = base ?? path.join(os.tmpdir(), `whodunit-wt-${process.pid}`);
  }

  async checkout(sha: string): Promise<string> {
    const cached = this.dirs.get(sha);
    if (cached) return cached;
    await fs.mkdir(this.base, { recursive: true });
    const dir = path.join(this.base, sha.slice(0, 12));
    await fs.rm(dir, { recursive: true, force: true });
    await git(this.repo, ["worktree", "add", "--detach", "--force", dir, sha]);
    this.dirs.set(sha, dir);
    return dir;
  }

  /** Discard any scratch edits made inside a checkout (used after exploratory agent sessions). */
  async reset(sha: string): Promise<void> {
    const dir = this.dirs.get(sha);
    if (!dir) return;
    await git(dir, ["checkout", "--", "."]).catch(() => {});
    await git(dir, ["clean", "-fdq", "-e", ".whodunit-setup-done"]).catch(() => {});
  }

  async cleanup(): Promise<void> {
    for (const [, dir] of this.dirs) {
      try {
        await git(this.repo, ["worktree", "remove", "--force", dir]);
      } catch {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    this.dirs.clear();
    await git(this.repo, ["worktree", "prune"]).catch(() => {});
    await fs.rm(this.base, { recursive: true, force: true }).catch(() => {});
  }
}

export function runShell(cwd: string, command: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env, ...opts.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, add: string) => (s.length > 200_000 ? s : s + add);
    child.stdout.on("data", (d) => (stdout = cap(stdout, d.toString())));
    child.stderr.on("data", (d) => (stderr = cap(stderr, d.toString())));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
}

/** Run a script file inside a worktree at a commit; returns the result. */
export async function runAt(
  pool: WorktreePool,
  sha: string,
  command: string,
  opts: { setup?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const dir = await pool.checkout(sha);
  if (opts.setup) {
    const marker = path.join(dir, ".whodunit-setup-done");
    try {
      await fs.access(marker);
    } catch {
      const s = await runShell(dir, opts.setup, { timeoutMs: opts.timeoutMs ?? 300_000 });
      if (s.exitCode !== 0) return { ...s, stderr: `[setup failed]\n${s.stderr}` };
      await fs.writeFile(marker, "ok");
    }
  }
  return runShell(dir, command, { timeoutMs: opts.timeoutMs });
}
