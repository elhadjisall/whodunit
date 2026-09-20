import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pingEs } from "./es/client.js";
import { listCommits } from "./es/search.js";
import { ingestRepo } from "./ingest.js";
import { repoName } from "./git.js";
import { generateDemo } from "./demo/generate.js";
import { solveCase } from "./case.js";
import { hasLLM, llmLabel } from "./agent/llm.js";
import { ui } from "./ui.js";
import type { CaseEvent } from "./events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, "..", "web");

const DEMO_REPO = "/tmp/whodunit-demo/acme-ledger";
const DEMO_TEST = "bash /tmp/whodunit-demo/repro-credit-note.sh";
const DEMO_COMPLAINT =
  "Credit notes with a discount export to CSV with a TOTAL that is a cent off from the invoice total. Started sometime in the last few weeks.";

interface Session {
  id: string;
  events: CaseEvent[];
  clients: Set<http.ServerResponse>;
  probeWait?: (choice: number | "auto") => void;
}

const sessions = new Map<string, Session>();

function send(res: http.ServerResponse, event: CaseEvent) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
}

function push(session: Session, event: CaseEvent) {
  session.events.push(event);
  for (const client of session.clients) send(client, event);
}

function mime(file: string) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
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

export async function startPlayServer(opts: { port: number; repoPath?: string }) {
  const repoPath = path.resolve(opts.repoPath ?? DEMO_REPO);
  await ensureDemoIndexed(repoPath);
  const repo = await repoName(repoPath);
  const commitCount = (await listCommits(repo)).length;

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
          brain: hasLLM() ? llmLabel() : null,
          vectors: config.embedProvider,
          repo,
          repoPath,
          commitCount,
          demoComplaint: DEMO_COMPLAINT,
        });
        return;
      }

      if (url.pathname === "/api/play" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          description?: string;
          mode?: "auto" | "player";
          fix?: boolean;
        };
        const session: Session = { id: crypto.randomUUID(), events: [], clients: new Set() };
        sessions.set(session.id, session);
        json(res, { caseStream: session.id });
        const description = (body.description ?? DEMO_COMPLAINT).trim() || DEMO_COMPLAINT;
        const player = body.mode === "player";
        setTimeout(() => {
          solveCase({
            repoPath,
            description,
            test: fs.existsSync("/tmp/whodunit-demo/repro-credit-note.sh") ? DEMO_TEST : undefined,
            fix: !!body.fix && hasLLM(),
            verify: body.fix ? "npm test" : undefined,
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
                    }, 90_000);
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
        req.on("close", () => session.clients.delete(res));
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

      if (req.method === "GET") {
        const rel = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = path.normalize(path.join(webRoot, rel));
        if (!file.startsWith(webRoot)) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": mime(file) });
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
