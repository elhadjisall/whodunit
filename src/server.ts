import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pingEs } from "./es/client.js";
import { listCommits } from "./es/search.js";
import { ingestRepo } from "./ingest.js";
import { commitHunks, gitLog, headSha, repoName } from "./git.js";
import { generateDemo } from "./demo/generate.js";
import { solveCase } from "./case.js";
import { makeAmends } from "./agent/amends.js";
import { hasLLM, llmLabel } from "./agent/llm.js";
import { ui } from "./ui.js";
import type { CaseEvent, PublicCommit } from "./events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, "..", "web", "dist");

const DEMO_REPO = "/tmp/whodunit-demo/acme-ledger";
const DEMO_TEST = "bash /tmp/whodunit-demo/repro-credit-note.sh";
const DEMO_COMPLAINT =
  "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total. Started sometime in the last few weeks.";

interface Session {
  id: string;
  events: CaseEvent[];
  clients: Set<http.ServerResponse>;
  probeWait?: (choice: number | "auto") => void;
  /** context captured from the event stream so a fix can be requested after the verdict */
  ctx: {
    caseId?: string;
    description: string;
    culprit?: PublicCommit;
    verdict?: string;
    reproCommand?: string;
    reproOutput?: string;
    fixing?: boolean;
  };
}

const sessions = new Map<string, Session>();

function send(res: http.ServerResponse, event: CaseEvent) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
}

function push(session: Session, event: CaseEvent) {
  session.events.push(event);
  if (event.type === "opened") session.ctx.caseId = event.payload.caseId;
  if (event.type === "repro") {
    session.ctx.reproCommand = event.payload.command;
    session.ctx.reproOutput = event.payload.headOutput;
  }
  if (event.type === "culprit") session.ctx.culprit = event.payload.commit;
  if (event.type === "verdict") session.ctx.verdict = event.payload.markdown;
  for (const client of session.clients) send(client, event);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function mime(file: string) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function ensureDemoIndexed(repoPath: string) {
  const es = await pingEs();
  if (!es.ok) throw new Error(`Elasticsearch is down at ${config.esUrl}. Run: npm run es:start`);
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    ui.info("Generating the acme-ledger crime scene…");
    await generateDemo(repoPath);
  }
  const name = await repoName(repoPath);
  let n = 0;
  try {
    n = (await listCommits(name)).length;
  } catch {
    n = 0;
  }
  if (n < 3) {
    ui.info(`Indexing ${repoPath} into Elasticsearch…`);
    await ingestRepo({ repoPath, reset: true });
  }
}

const num = (v: unknown, fallback: number, lo: number, hi: number) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
};

export async function startPlayServer(opts: { port: number; repoPath?: string }) {
  const repoPath = path.resolve(opts.repoPath ?? DEMO_REPO);
  await ensureDemoIndexed(repoPath);
  const repo = await repoName(repoPath);
  const commitCount = (await listCommits(repo)).length;
  const hasDist = fs.existsSync(path.join(webRoot, "index.html"));
  if (!hasDist) ui.warn("web/dist is missing — run `npm run build:web` to build the detective UI.");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname === "/api/status" && req.method === "GET") {
        const es = await pingEs();
        json(res, {
          es: es.ok ? es.version : null,
          esUrl: config.esUrl,
          brain: hasLLM() ? llmLabel() : null,
          vectors: config.embedProvider,
          repo,
          repoPath,
          commitCount,
          demoComplaint: DEMO_COMPLAINT,
          canFix: hasLLM(),
        });
        return;
      }

      if (url.pathname === "/api/hunks" && req.method === "GET") {
        const sha = (url.searchParams.get("sha") ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 40);
        if (!sha) {
          json(res, { error: "sha required" }, 400);
          return;
        }
        const hunks = await commitHunks(repoPath, sha).catch(() => []);
        json(res, { hunks: hunks.map((h) => ({ file: h.file, header: h.header, text: h.text.slice(0, 6000) })) });
        return;
      }

      if (url.pathname === "/api/play" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          description?: string;
          mode?: "auto" | "player";
          fix?: boolean;
          eps?: number;
          noise?: number;
        };
        const description = (body.description ?? DEMO_COMPLAINT).trim() || DEMO_COMPLAINT;
        const session: Session = { id: crypto.randomUUID(), events: [], clients: new Set(), ctx: { description } };
        sessions.set(session.id, session);
        json(res, { caseStream: session.id });
        const player = body.mode === "player";
        setTimeout(() => {
          solveCase({
            repoPath,
            description,
            test: fs.existsSync("/tmp/whodunit-demo/repro-credit-note.sh") ? DEMO_TEST : undefined,
            fix: !!body.fix && hasLLM(),
            verify: body.fix ? "npm test" : undefined,
            eps: num(body.eps, 0.05, 0.001, 0.4),
            noise: num(body.noise, 0, 0, 0.9),
            verbose: true,
            onEvent: (e) => push(session, e),
            chooseProbe: player
              ? (ctx) =>
                  new Promise((resolve) => {
                    session.probeWait = resolve;
                    setTimeout(() => {
                      if (session.probeWait === resolve) {
                        session.probeWait = undefined;
                        resolve("auto");
                      }
                    }, 120_000);
                    void ctx;
                  })
              : undefined,
          }).catch((e) => {
            push(session, { type: "error", payload: { message: e instanceof Error ? e.message : String(e) } });
          });
        }, 50);
        return;
      }

      if (url.pathname.startsWith("/api/stream/") && req.method === "GET") {
        const id = url.pathname.split("/").pop() ?? "";
        const session = sessions.get(id);
        if (!session) {
          res.writeHead(404);
          res.end("unknown case");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(":\n\n");
        for (const ev of session.events) send(res, ev);
        session.clients.add(res);
        const beat = setInterval(() => res.write(":beat\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          session.clients.delete(res);
        });
        return;
      }

      if (url.pathname.startsWith("/api/probe/") && req.method === "POST") {
        const id = url.pathname.split("/").pop() ?? "";
        const session = sessions.get(id);
        const body = JSON.parse((await readBody(req)) || "{}") as { index?: number | "auto" };
        if (!session?.probeWait) {
          json(res, { ok: false, error: "not awaiting a probe" }, 409);
          return;
        }
        const wait = session.probeWait;
        session.probeWait = undefined;
        wait(body.index === undefined ? "auto" : body.index);
        json(res, { ok: true });
        return;
      }

      /* Draft, prove and commit a fix on a branch — the "EXECUTE FIX" button. */
      if (url.pathname.startsWith("/api/fix/") && req.method === "POST") {
        const id = url.pathname.split("/").pop() ?? "";
        const session = sessions.get(id);
        const body = JSON.parse((await readBody(req)) || "{}") as { branch?: string };
        if (!session) {
          json(res, { ok: false, error: "unknown case" }, 404);
          return;
        }
        if (!hasLLM()) {
          json(res, { ok: false, error: "The fixer needs GEMINI_API_KEY." }, 400);
          return;
        }
        const { culprit, verdict, reproCommand, caseId } = session.ctx;
        if (!culprit || !verdict || !reproCommand || !caseId) {
          json(res, { ok: false, error: "No verdict yet — the case is still open." }, 409);
          return;
        }
        if (session.ctx.fixing) {
          json(res, { ok: false, error: "A fix is already being drafted." }, 409);
          return;
        }
        session.ctx.fixing = true;
        push(session, { type: "phase", payload: { phase: "amends", title: "Drafting a fix and proving it with the reproduction" } });
        try {
          const [full] = await gitLog(repoPath, { range: `${culprit.sha}~1..${culprit.sha}` });
          const hunks = await commitHunks(repoPath, culprit.sha);
          const amends = await makeAmends({
            repoPath,
            headSha: await headSha(repoPath),
            culprit: full ?? {
              sha: culprit.sha,
              short: culprit.short,
              order: culprit.index,
              author: culprit.author,
              email: "",
              date: culprit.date,
              subject: culprit.subject,
              message: "",
              files: culprit.files,
              insertions: 0,
              deletions: 0,
            },
            hunks,
            description: session.ctx.description,
            verdict,
            reproCommand,
            reproOutput: session.ctx.reproOutput ?? "",
            caseId,
            verify: "npm test",
            branch: (body.branch ?? "fix/whodunit-patch").replace(/[^\w./-]/g, "-"),
          });
          push(session, { type: "amends", payload: amends });
          json(res, { ok: true, amends });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          push(session, { type: "error", payload: { message: `No fix: ${message}` } });
          json(res, { ok: false, error: message }, 500);
        } finally {
          session.ctx.fixing = false;
        }
        return;
      }

      if (req.method === "GET") {
        if (!hasDist) {
          res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><body style="background:#111;color:#ebdcb9;font:16px/1.5 ui-monospace,monospace;padding:3rem">
<h1>whodunit</h1><p>The detective UI has not been built yet.</p><pre>npm run build:web</pre><p>then reload this page.</p></body>`,
          );
          return;
        }
        let rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
        let file = path.normalize(path.join(webRoot, rel));
        if (!file.startsWith(webRoot)) {
          res.writeHead(403);
          res.end();
          return;
        }
        // SPA fallback: unknown extension-less paths serve the app shell.
        if ((!fs.existsSync(file) || fs.statSync(file).isDirectory()) && !path.extname(rel)) {
          rel = "/index.html";
          file = path.join(webRoot, "index.html");
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const headers: Record<string, string> = { "Content-Type": mime(file) };
        if (rel.startsWith("/assets/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
        else headers["Cache-Control"] = "no-cache";
        res.writeHead(200, headers);
        fs.createReadStream(file).pipe(res);
        return;
      }

      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  const href = `http://127.0.0.1:${opts.port}`;
  ui.banner();
  ui.ok(`Detective bureau open at ${ui.bold(href)}`);
  ui.kv("repo", `${repo}  (${commitCount} commits)`);
  ui.kv("brain", hasLLM() ? llmLabel() : "heuristic");
  ui.kv("vectors", config.embedProvider);
  console.log(`\n  ${ui.dim("Leave this running. Open the URL. File a complaint. Catch a commit.")}\n`);
}

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && path.resolve(process.argv[1]).includes("server.")) {
  startPlayServer({ port: Number(process.env.PORT ?? 3333) }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
