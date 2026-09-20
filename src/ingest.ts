import fs from "node:fs/promises";
import path from "node:path";
import { bulkIndex, deleteRepo, ensureIndices, INDEX } from "./es/client.js";
import { getEmbedder } from "./embed.js";
import { commitHunks, gitLog, repoName, type CommitInfo } from "./git.js";
import { ui } from "./ui.js";

export interface IngestOptions {
  repoPath: string;
  range?: string;
  limit?: number;
  reset?: boolean;
  ciDir?: string;
  issuesDir?: string;
  github?: boolean;
}

export interface IngestStats {
  repo: string;
  commits: number;
  hunks: number;
  logs: number;
  issues: number;
  embedded: boolean;
}

interface CiLogFile {
  sha: string;
  run_id?: string;
  status?: string;
  duration_ms?: number;
  date?: string;
  text: string;
}

interface IssueFile {
  number: number;
  title: string;
  body: string;
  comments?: string[];
  author?: string;
  labels?: string[];
  created?: string;
}

export async function ingestRepo(opts: IngestOptions): Promise<IngestStats> {
  const repo = await repoName(opts.repoPath);
  const embedder = getEmbedder();
  await ensureIndices(embedder?.dims ?? null, opts.reset);
  await deleteRepo(repo);

  const spin = ui.spinner(`Reading git history for ${ui.bold(repo)}`);
  const commits = await gitLog(opts.repoPath, { range: opts.range, limit: opts.limit });
  spin.update(`Parsing diffs for ${commits.length} commits`);
  const hunkDocs: Record<string, unknown>[] = [];
  for (const c of commits) {
    const hunks = await commitHunks(opts.repoPath, c.sha);
    for (const h of hunks) {
      hunkDocs.push({
        repo,
        sha: c.sha,
        order: c.order,
        file: h.file,
        file_text: h.file,
        header: h.header,
        text: h.text,
        date: c.date,
      });
    }
  }
  spin.stop(`${commits.length} commits, ${hunkDocs.length} hunks parsed`);

  const commitDocs: Record<string, unknown>[] = commits.map((c) => ({
    repo,
    sha: c.sha,
    short: c.short,
    order: c.order,
    subject: c.subject,
    message: c.message,
    author: c.author,
    date: c.date,
    files: c.files,
    files_text: c.files.join(" "),
    insertions: c.insertions,
    deletions: c.deletions,
  }));

  // Messy side channels: CI logs and issue threads
  const ciDir = opts.ciDir ?? path.join(opts.repoPath, ".whodunit", "ci");
  const issuesDir = opts.issuesDir ?? path.join(opts.repoPath, ".whodunit", "issues");
  const logs = await readJsonDir<CiLogFile>(ciDir);
  const orderBySha = new Map(commits.map((c) => [c.sha, c.order]));
  const logDocs = logs
    .filter((l) => orderBySha.has(l.sha))
    .map((l) => ({
      repo,
      sha: l.sha,
      order: orderBySha.get(l.sha),
      run_id: l.run_id ?? l.sha.slice(0, 7),
      status: l.status ?? "unknown",
      duration_ms: l.duration_ms ?? 0,
      date: l.date ?? commits[orderBySha.get(l.sha)!].date,
      text: l.text,
    }));

  let issues = await readJsonDir<IssueFile>(issuesDir);
  if (opts.github !== false && issues.length === 0 && process.env.GITHUB_TOKEN && repo.includes("/")) {
    issues = await fetchGithubIssues(repo);
  }
  const issueDocs: Record<string, unknown>[] = issues.map((i) => ({
    repo,
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    comments: (i.comments ?? []).join("\n\n"),
    author: i.author ?? "unknown",
    labels: i.labels ?? [],
    created: i.created ?? new Date().toISOString(),
  }));

  if (embedder) {
    const spin2 = ui.spinner(`Embedding with ${embedder.name}`);
    const commitVecs = await embedder.embed(commits.map(commitText));
    commitDocs.forEach((d, i) => (d.embedding = commitVecs[i]));
    spin2.update(`Embedding ${hunkDocs.length} hunks with ${embedder.name}`);
    const hunkVecs = await embedder.embed(hunkDocs.map((h) => `${h.file} ${h.header}\n${h.text}`));
    hunkDocs.forEach((d, i) => (d.embedding = hunkVecs[i]));
    if (issueDocs.length) {
      const issueVecs = await embedder.embed(issueDocs.map((d) => `${d.title}\n${d.body}\n${d.comments}`));
      issueDocs.forEach((d, i) => (d.embedding = issueVecs[i]));
    }
    spin2.stop(`Embedded ${commits.length + hunkDocs.length + issueDocs.length} documents`);
  }

  const spin3 = ui.spinner("Indexing into Elasticsearch");
  await bulkIndex(INDEX.commits, commitDocs.map((d) => ({ ...d, _key: `${repo}@${d.sha}` })), "_key");
  await bulkIndex(INDEX.hunks, hunkDocs);
  await bulkIndex(INDEX.logs, logDocs);
  await bulkIndex(INDEX.issues, issueDocs.map((d) => ({ ...d, _key: `${repo}#${d.number}` })), "_key");
  spin3.stop("Indexed");

  return { repo, commits: commits.length, hunks: hunkDocs.length, logs: logDocs.length, issues: issueDocs.length, embedded: !!embedder };
}

function commitText(c: CommitInfo): string {
  return `${c.subject}\n${c.message}\nfiles: ${c.files.join(", ")}`;
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const out: T[] = [];
    for (const f of files) out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as T);
    return out;
  } catch {
    return [];
  }
}

async function fetchGithubIssues(repo: string): Promise<IssueFile[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return [];
  const items = (await res.json()) as {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    created_at: string;
    pull_request?: unknown;
  }[];
  return items
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      author: i.user.login,
      labels: i.labels.map((l) => l.name),
      created: i.created_at,
    }));
}
