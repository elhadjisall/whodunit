# whodunit

**`git bisect` with a brain.** Tell it what broke in plain English. It searches your repo's messy history — diffs, commit messages, noisy CI logs, issue threads — in Elasticsearch, writes a reproduction, and runs a **Bayesian bisection** that finds the culprit commit in a fraction of the test runs `git bisect` needs. Then it explains the bug with citations and commits a verified fix on a branch.

```
$ whodunit solve --repo . "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total." --fix

 1 · INVESTIGATION
  → search_evidence {"query":"allocate remainder trunc floor negative cents","kinds":["hunk","commit"]}
  → file_timeline   {"file":"src/money.js"}
  → ci_timeline     {}
  Theory: allocate() lost a cent for negative totals after the trunc refactor; the credit-note feature commit is a red herring.
  Suspects:  90% #81 4c58cb3 refactor(money): simplify allocate() remainder distribution

 2 · REPRODUCTION
 ✔ Reproduction validated in 1 attempt(s): compares CSV TOTAL row to summarize() total for a discounted credit note

 3 · BAYESIAN BISECTION
  prior entropy 4.93 bits (uniform would be 6.74 bits ≈ 7 probes)
  #1 probe #80 cd81edd docs(tax): note provincial quirks       → GOOD  P(bad)=48%
  #2 probe #88 db32214 test: add customer fixture              → BAD   P(bad)=52%
  #3 probe #81 4c58cb3 refactor(money): simplify allocate()    → BAD   P(bad)=80%
 ✔ Culprit #81 4c58cb3 with 97.6% confidence after 3 probes (git bisect would have needed 6)

 4 · VERDICT   … cited Markdown case report …
 5 · AMENDS
 ✔ Fix committed on branch whodunit/fix-c90e75 (b6e4ae5)   verify: passed
```

## Why this is interesting

`git bisect` treats every commit as equally suspicious and probes the midpoint: ~log₂(n) builds and test runs, each of which can take minutes in a real project. But a repo is not uniformly suspicious. The bug report, the diffs, the CI warnings that started appearing, the issue someone filed three weeks ago — they all point somewhere.

whodunit turns that evidence into a **prior over commits**, then bisects the *probability mass* instead of the commit list:

- **Prior from evidence.** Hybrid search (BM25 with a code-aware analyzer + dense vectors + reciprocal-rank fusion, optional Jina reranking) over four indices — commits, diff hunks, CI logs, issues — plus aggregations (file timelines, churn hotspots) and ES|QL (CI health over time). An agent runs these as tools and outputs calibrated suspicion scores; those are softmax-ed and mixed with a uniform floor so the evidence can be wrong without breaking anything.
- **Weighted-median probing.** The next commit to test is the one whose predicted outcome is closest to a coin flip — the information-optimal probe under symmetric noise. A sharp prior means 2–3 probes instead of 7. A wrong prior costs a probe or two, no more.
- **Noise-aware updates.** Every test result is a noisy observation with flake rate ε (`--eps`). A flaky run can't permanently send the search down the wrong branch; when the posterior is pinned on a boundary that was tested once, the optimal move is to re-run that test, and whodunit does. In simulation with a 10 %-flaky oracle and `--eps 0.1` it finds the right commit 30/30 times in ~4 probes.
- **Honest stopping.** It stops when the leading suspect is *bracketed* (tested bad, parent tested good — the same evidence `git bisect` relies on) and the posterior agrees.

And it closes the loop: the reproduction it wrote proves the fix, an optional `--verify` command (your test suite) guards against collateral damage, and the case — evidence, probe log, verdict — is written to `~/.whodunit/cases/<id>/case.md` and indexed back into Elasticsearch so `whodunit cases` becomes your team's regression history.

## Architecture

```
                         ┌──────────────────────────────────────────────┐
  git history ──index──► │ Elasticsearch                                │
  .whodunit/ci/*.json    │  wd-commits   text(code analyzer)+dense_vec  │
  .whodunit/issues/*.json│  wd-hunks     text(code analyzer)+dense_vec  │
  GitHub issues (token)  │  wd-ci-logs   text (noisy, ANSI, reruns)     │
                         │  wd-issues    text+dense_vec                 │
                         │  wd-cases     solved cases                   │
                         └───────┬──────────────────────────────────────┘
                                 │ hybrid search (BM25 ⊕ kNN → RRF → rerank)
                                 │ aggregations · ES|QL
                                 ▼
   1. investigate  ── agent with tools: search_evidence · file_timeline · churn_hotspots · ci_timeline · show_commit
                      → suspects + theory  → suspicion prior over commits
   2. reproduce    ── agent with tools: read_file · run   → bash oracle; validated (fails @HEAD, passes @oldest); retries with feedback
   3. bisect       ── Bayesian: weighted-median probe, noisy update, bracket-confirmed stop; runs oracle in git worktrees
   4. verdict      ── cited Markdown case report ([hunk N], [evidence N], probe log)
   5. amends       ── fixer proposes minimal patch → applied on whodunit/fix-<case> → repro + --verify must pass → commit (→ gh pr create)
```

Source map: `src/bayes.ts` (the math), `src/es/` (indices, hybrid search, aggs, ES|QL), `src/agent/` (investigate / repro / verdict / amends), `src/case.ts` (orchestration), `src/git.ts` (log/diff parsing, worktree pool), `src/demo/generate.ts` (synthetic crime scene).

## Quickstart

Requirements: Node ≥ 20, git, Java is bundled with Elasticsearch (no Docker needed).

```bash
npm install
npm run es:start                 # downloads + runs a local single-node Elasticsearch 9.x (~/.whodunit)
export GEMINI_API_KEY=...        # the brain (Gemini 3.6 Flash). Optional: JINA_API_KEY for Jina vectors
npx whodunit doctor
npx whodunit play                # noir detective game at http://127.0.0.1:3333
```

### The demo crime scene

`whodunit demo generate` fabricates `acme-ledger`: an invoicing library with 108 commits by five authors over three months, release tags, noisy CI logs (ANSI codes, registry timeouts, re-runs), six issue threads, several red herrings (the commit that *added* credit notes, a "fix tax rounding for negatives", a CSV quoting fix) and one regression the test suite doesn't catch: a `refactor(money)` commit swapped `Math.floor` for `Math.trunc` in `allocate()`, so credit notes with a discount lose a cent.

```bash
npx whodunit demo generate
npx whodunit index --repo /tmp/whodunit-demo/acme-ledger
npx whodunit solve --repo /tmp/whodunit-demo/acme-ledger \
  "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total. Started sometime in the last few weeks." \
  --fix --verify "npm test"
```

No API key? whodunit still works as a smarter bisect — bring your own oracle:

```bash
npx whodunit solve --repo /tmp/whodunit-demo/acme-ledger "credit note csv total off by a cent" \
  --test "bash /tmp/whodunit-demo/repro-credit-note.sh"
```

### On a real repository

```bash
npx whodunit index --repo ~/code/my-service --range v2.3.0..HEAD      # or -n 300
npx whodunit solve --repo ~/code/my-service "POST /export returns 500 for CSVs over 10k rows since last week" \
  --setup "npm ci" --verify "npm test" --fix --pr
```

- `--setup` runs once per checkout (dependency install); `--test` supplies your own oracle instead of letting the agent write one.
- CI logs: drop JSON files `{sha, status, duration_ms, date, text}` in `<repo>/.whodunit/ci/` (or `--ci-dir`). Issues: `<repo>/.whodunit/issues/*.json`, or set `GITHUB_TOKEN` and they're fetched from GitHub.
- Other commands: `whodunit search --repo . "<query>"`, `whodunit timeline --repo . -f src/file.ts`, `whodunit cases`.

## Configuration

| variable | purpose | default |
|---|---|---|
| `ELASTICSEARCH_URL` / `ELASTICSEARCH_API_KEY` | Elastic node (local or Cloud/Serverless) | `http://127.0.0.1:9200` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | agent brain | `gemini-3.6-flash` |
| `JINA_API_KEY` | `jina-embeddings-v3` dense vectors + `jina-reranker-v2` | — |
| `WHODUNIT_EMBED` | force `jina` / `openai` / `none` | auto |
| `WHODUNIT_HOME` | cases, repro scripts, local ES | `~/.whodunit` |

## Hack the North tracks

- **Elastic — Find the Signal.** Messy, unstructured inputs (diffs, ANSI-laden CI logs, issue threads) become an agent's context layer: hybrid BM25 + dense vectors + RRF + reranking, `word_delimiter_graph` code analyzer, terms/date-histogram aggregations, ES|QL for time-series, and an agent whose tools *are* Elasticsearch queries — and that closes the loop by committing a fix instead of answering a question.
- **Warp — Best Developer Tool.** A CLI for the debugging part of the lifecycle that replaces the most tedious ritual in git with something that reads the evidence first. No GUI for the sake of it; the terminal output *is* the UX (live posterior histogram, probe log with "surprise!" markers, case files).
- **OpenAI / Gemini.** Three specialised agents (investigator, reproduction specialist, fixer) on tool calling. Default brain is Gemini 3.6 Flash.

## Limitations

- The oracle must be deterministic enough for ε to hold; for very flaky suites raise `--eps` and expect re-probes.
- Culprits outside the indexed range are detected (oracle fails at the oldest commit) but you must re-index a wider range.
- Merge-heavy histories are walked `--first-parent`; the culprit is then the merge, not the commit inside the branch.
- The fixer edits whole files; large files are truncated in its context.

MIT.
