# whodunit

Tell it what broke. It searches git history in Elasticsearch, writes a test, and finds the culprit commit with a Bayesian bisect — usually in fewer runs than `git bisect`. Then Gemini writes a cited verdict and can commit a fix.

## How to run

```bash
npm install
cp .env.example .env
```

Put these in `.env`:

- `ELASTICSEARCH_URL` and `ELASTICSEARCH_API_KEY` (Elastic Cloud Serverless is fine)
- `GEMINI_API_KEY`

Then:

```bash
npm run play
```

Open **http://127.0.0.1:3333** (fullscreen, or a 1512×945 window).

| Button | What it does |
|---|---|
| **Run demo case (simulated)** | 30-second pitch. No live API calls. Use this in front of judges. |
| **Release the hounds** | Live Elasticsearch + Gemini on the same case. |

First run generates and indexes the demo repo (`acme-ledger`, 108 commits) if needed.

If Elasticsearch is down, the UI still works in simulation mode.

```bash
npm run demo:offline    # force simulation
npx whodunit doctor     # check ES + Gemini
```

### CLI (same engine, no UI)

```bash
npx whodunit demo generate
npx whodunit index --repo /tmp/whodunit-demo/acme-ledger
npx whodunit solve --repo /tmp/whodunit-demo/acme-ledger \
  "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total." \
  --fix --verify "npm test"
```

No Gemini key? Pass your own test:

```bash
npx whodunit solve --repo /tmp/whodunit-demo/acme-ledger "credit note csv total off by a cent" \
  --test "bash /tmp/whodunit-demo/repro-credit-note.sh"
```

---

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

## The game: the Interrogation Room

`npm run demo` opens **Whodunit: Git Bisect with a Brain** at `http://127.0.0.1:3333` — a noir-detective front end for the same engine, built so a judge can *watch* the evidence become a prior and the prior become a bisection.

```
┌ DEPARTMENT OF CODE FORENSICS // DIVISION 3DS-HTN ── ● LIVE WIRE · ES 9.6 ── [DETECTIVE AGENT | MANUAL INTERROGATION] ─┐
│ COMPLAINT DESK        │  CORK BOARD — polaroid mugshots of the top suspects, red yarn between commits that     │
│  manila form, the     │  touch the same file, a suspicion heat-meter per card (the Bayesian posterior),        │
│  bug report, RELEASE  │  hover for the dossier (diff summary · author · CI PASS/FAIL · ES similarity),         │
│  THE HOUNDS           │  click to INTERROGATE (runs the oracle at that ref) · stamps: CLEARED / CULPRIT        │
│                       ├──────────────────────────────────────────────────────────────────────────────────────│
│ BAYESIAN PROBE        │  FORENSIC TIMELINE — all 108 commits, heat-coloured; two needles: git bisect's        │
│ BAROMETER             │  midpoint vs whodunit's weighted-median probe                                          │
│  git bisect ≈7 probes ├──────────────────────────────────────────────────────────────────────────────────────│
│  whodunit 3 · 97 %    │  ELASTICSEARCH RADAR (hybrid BM25 ⊕ kNN → RRF, ES|QL, aggregations as they run)      │
│  ε slider · flaky sim │  RADIO DISPATCH (ANSI log: agent reasoning · repro synthesis · oracle runs)           │
└───────────────────────┴──────────────────────────────────────────────────────────────────────────────────────┘
```

When the culprit is bracketed, **THE DAILY COMMIT — EXTRA** spins onto the screen: the cited verdict, the red herring vs. the real regression side by side, the offending hunk, and **EXECUTE FIX & PUSH**, which has Gemini draft a minimal patch, proves it with the reproduction and `npm test`, and commits it on `fix/whodunit-patch` (diff shown in the paper).

- **DETECTIVE AGENT** lets Gemini pick every probe; **MANUAL INTERROGATION** hands you the board — click a mugshot to test that commit yourself (the barometer tells you what the detective would have done).
- **SIMULATE FLAKY ORACLE** makes the test lie once. Classic bisect condemns an innocent commit; the posterior absorbs the lie as ε-noise, re-interrogates the boundary, and still closes the case. The ε slider is `--eps`.
- **Offline fallback.** If the bureau (server, Elasticsearch or Gemini) is unreachable, the badge flips to `OFFLINE · SIMULATION` and **Run demo case (simulated)** replays the real acme-ledger history through the same Bayesian engine in the browser — every query, probe and stamp — so the pitch never depends on Wi-Fi. `npm run demo:offline` starts it that way on purpose.
- Foley (typewriter keys, radio chirps for every Elasticsearch call, the stamp) is synthesised with the Web Audio API; mute in the top bar. `E` reopens the EXTRA, `Esc` closes it, `⌘↵` releases the hounds.

Stack: React 19, Tailwind 4, Framer Motion, Lucide, Vite; events stream from the Node server over SSE (`/api/play`, `/api/stream/:id`, `/api/probe/:id`, `/api/fix/:id`). `npm run dev:web` gives a hot-reloading UI proxied to the bureau on 3333.

## Quickstart (local Elasticsearch instead of Cloud)

```bash
npm run es:start          # downloads Elasticsearch 9.x into ~/.whodunit
npx whodunit play
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
| `GEMINI_FALLBACK_MODELS` | tried in order when the brain is out of quota | `gemini-3.5-flash,gemini-3-flash-preview,gemini-2.5-flash` |
| `JINA_API_KEY` | `jina-embeddings-v3` dense vectors + `jina-reranker-v2` | — |
| `WHODUNIT_EMBED` | force `jina` / `openai` / `none` | auto |
| `WHODUNIT_HOME` | cases, repro scripts, local ES | `~/.whodunit` |

## Hack the North tracks

- **Elastic.** Hybrid BM25 + Gemini 768-d kNN + RRF over commits, diff hunks, CI logs and issues. Aggregations and ES|QL (`ci_timeline`, `file_suspicion`). The agent's tools are Elasticsearch queries.
- **Gemini.** Investigator, reproduction specialist, and fixer on tool calling. Embeddings for hybrid search. Quota fallback across Flash models.

## Limitations

- The oracle must be deterministic enough for ε to hold; for very flaky suites raise `--eps` and expect re-probes.
- Culprits outside the indexed range are detected (oracle fails at the oldest commit) but you must re-index a wider range.
- Merge-heavy histories are walked `--first-parent`; the culprit is then the merge, not the commit inside the branch.
- The fixer edits whole files; large files are truncated in its context.

MIT.
