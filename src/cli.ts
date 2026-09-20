#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { config } from "./config.js";
import { pingEs } from "./es/client.js";
import { churnHotspots, ciTimeline, fileTimeline, listCases, listCommits, searchEvidence, type EvidenceKind } from "./es/search.js";
import { ingestRepo } from "./ingest.js";
import { repoName } from "./git.js";
import { solveCase } from "./case.js";
import { generateDemo } from "./demo/generate.js";
import { hasLLM, llmLabel } from "./agent/llm.js";
import { ui } from "./ui.js";

const program = new Command();
program
  .name("whodunit")
  .description("git bisect with a brain — an Elasticsearch-backed detective that finds the commit that broke your code, cites the evidence, and fixes it.")
  .version("0.1.0")
  .option("--no-banner", "suppress the banner")
  .hook("preAction", (cmd) => {
    if (cmd.opts().banner !== false && process.stdout.isTTY) ui.banner();
  });

program
  .command("doctor")
  .description("check Elasticsearch, LLM and embedding configuration")
  .action(async () => {
    const es = await pingEs();
    if (es.ok) ui.ok(`Elasticsearch ${es.version} at ${config.esUrl}`);
    else ui.fail(`Elasticsearch unreachable at ${config.esUrl}: ${es.error}\n    start one with: npm run es:start`);
    if (hasLLM()) ui.ok(llmLabel());
    else ui.warn("GEMINI_API_KEY not set — investigation runs in heuristic mode and --test is required");
    if (config.embedProvider === "none") ui.warn("No embedding provider — BM25-only retrieval. Set GEMINI_API_KEY for hybrid search.");
    else ui.ok(`Dense vectors via ${config.embedProvider}`);
  });

program
  .command("index")
  .description("ingest a repository's history (commits, diff hunks, CI logs, issues) into Elasticsearch")
  .requiredOption("-r, --repo <path>", "path to the git repository")
  .option("--range <rev-range>", "git revision range, e.g. v1.2.0..HEAD")
  .option("-n, --limit <n>", "number of commits from HEAD (when no --range)", "200")
  .option("--ci-dir <dir>", "directory of CI log JSON files (default: <repo>/.whodunit/ci)")
  .option("--issues-dir <dir>", "directory of issue JSON files (default: <repo>/.whodunit/issues)")
  .option("--reset", "drop and recreate the indices first")
  .action(async (o) => {
    await requireEs();
    const stats = await ingestRepo({
      repoPath: path.resolve(o.repo),
      range: o.range,
      limit: Number(o.limit),
      reset: !!o.reset,
      ciDir: o.ciDir,
      issuesDir: o.issuesDir,
    });
    ui.section("INDEXED");
    ui.kv("repo", stats.repo);
    ui.kv("commits", String(stats.commits));
    ui.kv("hunks", String(stats.hunks));
    ui.kv("ci logs", String(stats.logs));
    ui.kv("issues", String(stats.issues));
    ui.kv("vectors", stats.embedded ? config.embedProvider : "none (BM25 only)");
  });

program
  .command("solve")
  .description("investigate a regression: search the evidence, reproduce, Bayesian-bisect, deliver a cited verdict, optionally fix")
  .argument("<description>", "the bug, in plain English")
  .requiredOption("-r, --repo <path>", "path to the git repository (must be indexed)")
  .option("-t, --test <command>", "oracle command run at each commit (exit 0 = good). If omitted, the agent writes one.")
  .option("--setup <command>", "command to run once per checkout before testing (e.g. 'npm ci')")
  .option("--verify <command>", "extra command a fix must pass (e.g. 'npm test')")
  .option("--fix", "after the verdict, draft a fix on a new branch and prove it with the reproduction")
  .option("--pr", "push the fix branch and open a PR with gh (implies --fix)")
  .option("--eps <p>", "assumed flake probability of the oracle", "0.01")
  .option("--confidence <p>", "posterior mass required to stop", "0.95")
  .option("--max-probes <n>", "hard cap on test runs")
  .option("--timeout <ms>", "per-run timeout", "120000")
  .option("-q, --quiet", "hide agent tool-call traces")
  .action(async (description: string, o) => {
    await requireEs();
    const result = await solveCase({
      repoPath: path.resolve(o.repo),
      description,
      test: o.test,
      setup: o.setup,
      verify: o.verify,
      fix: !!o.fix || !!o.pr,
      pr: !!o.pr,
      eps: Number(o.eps),
      confidence: Number(o.confidence),
      maxProbes: o.maxProbes ? Number(o.maxProbes) : undefined,
      timeoutMs: Number(o.timeout),
      verbose: !o.quiet,
    });
    ui.section("CLOSED");
    ui.kv("culprit", `${result.culprit.short} ${result.culprit.subject}`);
    ui.kv("probes", `${result.state.probes.filter((p) => p.durationMs > 0).length} (git bisect: ${result.uniformSteps})`);
    if (result.amends) ui.kv("fix branch", result.amends.branch);
  });

program
  .command("search")
  .description("hybrid-search the case file directly")
  .argument("<query>")
  .requiredOption("-r, --repo <path>")
  .option("-k, --kinds <kinds>", "comma-separated: hunk,commit,ci-log,issue")
  .option("-n, --size <n>", "results", "10")
  .action(async (query: string, o) => {
    await requireEs();
    const repo = await repoName(path.resolve(o.repo));
    const kinds = o.kinds ? (o.kinds.split(",") as EvidenceKind[]) : undefined;
    const ev = await searchEvidence(repo, query, { size: Number(o.size), kinds });
    ui.section(`EVIDENCE for "${query}"`);
    ui.evidence(ev, Number(o.size));
  });

program
  .command("timeline")
  .description("show a file's commit timeline, churn hotspots and CI health (aggregations + ES|QL)")
  .requiredOption("-r, --repo <path>")
  .option("-f, --file <path>", "file to inspect")
  .action(async (o) => {
    await requireEs();
    const repo = await repoName(path.resolve(o.repo));
    if (o.file) {
      const t = await fileTimeline(repo, o.file);
      ui.section(`TIMELINE ${o.file}`);
      for (const c of t.commits) console.log(`  #${String(c.order).padStart(3)} ${c.short} ${String(c.date).slice(0, 10)} ${String(c.author).padEnd(18)} ${c.subject}`);
      console.log(`\n  authors: ${t.authors.map((a) => `${a.author} (${a.commits})`).join(", ")}`);
    }
    const hot = await churnHotspots(repo, 10);
    ui.section("CHURN HOTSPOTS");
    for (const h of hot) console.log(`  ${String(h.commits).padStart(3)} commits · ${String(h.authors).padStart(2)} authors · ${h.file}  ${ui.dim(`last ${h.lastTouched.slice(0, 10)}`)}`);
    try {
      const ci = await ciTimeline(repo);
      if (ci.length) {
        ui.section("CI HEALTH (ES|QL)");
        for (const w of ci) console.log(`  ${w.week.slice(0, 10)}  runs ${String(w.runs).padStart(3)}  failed ${String(w.failed).padStart(2)}  p50 ${(w.p50_ms / 1000).toFixed(1)}s`);
      }
    } catch (e) {
      ui.warn(`ES|QL unavailable: ${e instanceof Error ? e.message : e}`);
    }
    const commits = await listCommits(repo);
    console.log(`\n  ${ui.dim(`${commits.length} commits indexed for ${repo}`)}`);
  });

program
  .command("cases")
  .description("list solved cases (stored in Elasticsearch)")
  .option("-r, --repo <path>", "filter by repository")
  .action(async (o) => {
    await requireEs();
    const repo = o.repo ? await repoName(path.resolve(o.repo)) : undefined;
    const cases = await listCases(repo);
    ui.section("CASES");
    if (!cases.length) console.log("  none yet");
    for (const c of cases) {
      console.log(
        `  ${c.created.slice(0, 16).replace("T", " ")}  ${ui.bold(c.case_id)}  ${c.repo.padEnd(18)} ${c.culprit.slice(0, 7)}  ${String(c.probes).padStart(2)} probes ${ui.dim(`(bisect ${c.uniform_probes})`)} ${(c.confidence * 100).toFixed(0)}%\n      ${ui.dim(c.description.slice(0, 110))}`,
      );
    }
  });

program
  .command("play")
  .description("open the interactive detective-game UI in a browser")
  .option("-p, --port <n>", "port", "3333")
  .option("-r, --repo <path>", "indexed git repo (default: demo acme-ledger)")
  .action(async (o) => {
    const { startPlayServer } = await import("./server.js");
    await startPlayServer({ port: Number(o.port), repoPath: o.repo });
  });

const demo = program.command("demo").description("generate and explore the acme-ledger demo repository");
demo
  .command("generate")
  .description("create a ~110-commit repo with a hidden regression, red herrings, noisy CI logs and issues")
  .option("-o, --out <dir>", "target directory", "/tmp/whodunit-demo/acme-ledger")
  .option("--seed <n>", "rng seed", "42")
  .option("--reveal", "print the culprit (spoiler!)")
  .action(async (o) => {
    const spin = ui.spinner("Fabricating a crime scene");
    const r = await generateDemo(path.resolve(o.out), { seed: Number(o.seed) });
    spin.stop(`Generated ${r.commits} commits at ${r.path}`);
    ui.kv("oracle", `bash ${path.join(path.dirname(r.path), "repro-credit-note.sh")}`);
    if (o.reveal) ui.kv("culprit", `#${r.culpritIndex} ${r.culpritSha.slice(0, 7)}`);
    console.log(`
  Next:
    whodunit index --repo ${r.path}
    whodunit solve --repo ${r.path} "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total. Started sometime in the last few weeks." ${hasLLM() ? "--fix" : `--test "bash ${path.join(path.dirname(r.path), "repro-credit-note.sh")}"`}
    whodunit play
`);
  });

async function requireEs() {
  const es = await pingEs();
  if (!es.ok) {
    ui.fail(`Elasticsearch unreachable at ${config.esUrl}: ${es.error}`);
    console.log(`  start a local node with ${ui.bold("npm run es:start")} or set ELASTICSEARCH_URL / ELASTICSEARCH_API_KEY`);
    process.exit(2);
  }
}

program.parseAsync(process.argv).catch((e) => {
  ui.fail(e instanceof Error ? e.message : String(e));
  if (process.env.WHODUNIT_DEBUG && e instanceof Error) console.error(e.stack);
  process.exit(1);
});
