# Whodunit

Git bisect with a brain. Pronounced **who-DUNN-it**.

Solo project. You type what broke. It searches git history in Elasticsearch, writes a test, and finds the culprit with a Bayesian bisect (usually fewer runs than `git bisect`). Gemini writes a cited verdict and can commit a fix.

Demo case: a credit-note CSV that is a cent off. Culprit is `4c58cb3` (`Math.floor` became `Math.trunc`). The test suite is green. The feature commit is a red herring.

## Run

```bash
npm install
cp .env.example .env
```

Put `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY`, and `GEMINI_API_KEY` in `.env`. Then:

```bash
npm run play
```

Open http://127.0.0.1:3333 (fullscreen, or 1512x945).

- **Run demo case (simulated):** 30 second pitch, no live APIs. Use this first.
- **Release the hounds:** live Elasticsearch + Gemini on the same case.

First run generates and indexes `acme-ledger` (108 commits) if needed. If Elasticsearch is down, simulation still works.

```bash
npm run demo:offline
npx whodunit doctor
```

## CLI

```bash
npx whodunit solve --repo /tmp/whodunit-demo/acme-ledger \
  "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total." \
  --fix --verify "npm test"
```

## Gallery

Judge-facing stills in `docs/devpost/`:

- `idle-desk.png`: complaint desk, LIVE WIRE, both buttons, empty cork board
- `investigation.png`: polaroids, Elasticsearch radar, Gemini dispatch
- `bisect.png`: grey git-bisect needle vs red weighted-median needle
- `newspaper.png` / `thumbnail.png`: The Daily Commit, culprit `4c58cb3`
- `newspaper.png` / `thumbnail.png`: The Daily Commit, culprit `4c58cb3`

## Stack

elasticsearch, gemini, typescript, node.js, react, vite, tailwindcss, framer-motion, git

MIT.
