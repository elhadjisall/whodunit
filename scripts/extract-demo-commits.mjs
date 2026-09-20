#!/usr/bin/env node
// Snapshot the acme-ledger demo repository into web/src/data/demo-case.json so the detective UI can
// replay a realistic case offline (mock mode) with the same commits the live backend indexes.
//
//   node scripts/extract-demo-commits.mjs [/tmp/whodunit-demo/acme-ledger]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = process.argv[2] ?? "/tmp/whodunit-demo/acme-ledger";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "web", "src", "data", "demo-case.json");

const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const SEP = "\u001e";
const raw = git(["log", "--reverse", "--date=iso-strict", `--format=${SEP}%H|%h|%an|%aI|%s`, "--name-only"]);
const commits = [];
for (const block of raw.split(SEP).slice(1)) {
  const [head, ...rest] = block.trim().split("\n");
  const [sha, short, author, date, ...subj] = head.split("|");
  const files = rest.map((l) => l.trim()).filter(Boolean);
  commits.push({ index: commits.length, sha, short, author, date, subject: subj.join("|"), files });
}

// CI status side channel written by the demo generator
const ciDir = path.join(repo, ".whodunit", "ci");
if (fs.existsSync(ciDir)) {
  for (const c of commits) {
    const f = path.join(ciDir, `${c.sha}.json`);
    if (fs.existsSync(f)) c.ci = JSON.parse(fs.readFileSync(f, "utf8")).status === "failed" ? "failed" : "passed";
  }
}

const culprit = commits.find((c) => c.subject.startsWith("refactor(money): simplify allocate()"));
if (!culprit) throw new Error("culprit commit not found — regenerate the demo repo first");
const culpritDiff = git(["show", "--format=", "--unified=3", culprit.sha, "--", "src/money.js"]);
const culpritBody = git(["show", "-s", "--format=%b", culprit.sha]).trim();

const find = (prefix) => commits.find((c) => c.subject.startsWith(prefix));
const landmarks = {
  culprit: culprit.index,
  redHerring: find("fix(tax): symmetric rounding")?.index,
  creditNotes: find("feat(invoice): support credit notes")?.index,
  discounts: find("feat(invoice): invoice-level discounts")?.index,
  allocate: find("feat(money): add allocate()")?.index,
  csvPerf: find("perf(csv): build rows")?.index,
  moneyDocs: find("docs(money): document allocate()")?.index,
  report: find("feat(report): monthly summary")?.index,
  csvQuoting: find("fix(csv): quote fields")?.index,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ repo: "acme-ledger", generatedAt: new Date().toISOString(), commits, landmarks, culpritDiff, culpritBody }, null, 1));
console.log(`wrote ${path.relative(process.cwd(), out)}: ${commits.length} commits, culprit #${culprit.index} ${culprit.short}`);
