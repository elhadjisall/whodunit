const $ = (sel, el = document) => el.querySelector(sel);
const stage = $("#stage");
const ticker = $("#ticker");
const statusLine = $("#statusLine");

const state = {
  status: null,
  mode: "player",
  streamId: null,
  source: null,
  commits: [],
  board: [],
  evidence: [],
  radio: [],
  awaiting: false,
  culprit: null,
  probes: [],
  verdict: "",
  stats: null,
};

function say(msg) {
  ticker.innerHTML = `<span>${msg}</span>`;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function boot() {
  try {
    state.status = await (await fetch("/api/status")).json();
    statusLine.textContent = `ES ${state.status.es ?? "down"} · ${state.status.brain ?? "heuristic"} · ${state.status.commitCount} commits · ${state.status.vectors}`;
  } catch {
    statusLine.textContent = "bureau offline — is `whodunit play` running?";
  }
  cover();
}

function cover() {
  stage.innerHTML = `
    <section class="scene cover">
      <div>
        <div class="subtitle">Hack the North · Software Crimes Unit</div>
        <h1 class="brand">WHODUNIT</h1>
        <p class="subtitle">git bisect, but make it a murder mystery</p>
        <div class="folder" id="openFolder">
          <div class="tab">CASE 9200-HTN</div>
          <h2>THE MISSING CENT</h2>
          <p>A ledger that used to balance. A credit note that doesn't. One hundred and eight suspects. Only one of them is guilty.</p>
        </div>
        <div class="row">
          <button class="btn" id="openBtn">Open the case file</button>
        </div>
      </div>
    </section>`;
  $("#openFolder").onclick = $("#openBtn").onclick = complaint;
}

function complaint() {
  const preset = state.status?.demoComplaint ?? "";
  stage.innerHTML = `
    <section class="scene">
      <div class="complaint">
        <h2>Incident report</h2>
        <p>Type the bug like you'd tell a teammate. The detective reads diffs, CI logs and issues — not just git log.</p>
        <textarea id="desc">${esc(preset)}</textarea>
        <div class="modes">
          <div class="mode on" data-mode="player">I interrogate — click commits to grill them. The detective suggests the optimal probe.</div>
          <div class="mode" data-mode="auto">Watch the detective — Bayesian agent picks every probe. Hands in pockets.</div>
        </div>
        <div class="row" style="justify-content:flex-start">
          <button class="btn" id="fileBtn">File it · start the hunt</button>
          <button class="btn ghost" id="fixBtn">…and make them write the fix</button>
        </div>
      </div>
    </section>`;
  for (const el of stage.querySelectorAll(".mode")) {
    el.onclick = () => {
      stage.querySelectorAll(".mode").forEach((m) => m.classList.remove("on"));
      el.classList.add("on");
      state.mode = el.dataset.mode;
    };
  }
  $("#fileBtn").onclick = () => startCase(false);
  $("#fixBtn").onclick = () => startCase(true);
}

async function startCase(fix) {
  const description = $("#desc").value.trim();
  say("Opening a case file…");
  $("#fileBtn") && ($("#fileBtn").disabled = true);
  const res = await fetch("/api/play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, mode: state.mode, fix }),
  });
  const { caseStream, error } = await res.json();
  if (error) {
    say(error);
    return;
  }
  state.streamId = caseStream;
  state.radio = [];
  state.evidence = [];
  state.probes = [];
  bureau();
  const src = new EventSource(`/api/stream/${caseStream}`);
  state.source = src;
  const types = [
    "opened", "phase", "tool", "evidence", "theory", "suspects", "repro",
    "prior", "awaiting_probe", "probe", "posterior", "culprit", "verdict", "amends", "closed", "error",
  ];
  for (const t of types) src.addEventListener(t, (ev) => handle(t, JSON.parse(ev.data)));
}

function bureau() {
  stage.innerHTML = `
    <section class="scene bureau">
      <div class="cork" id="cork">
        <svg class="yarn" id="yarn"></svg>
      </div>
      <div class="side">
        <div class="panel">
          <h3>Radio — Elasticsearch</h3>
          <div class="radio" id="radio"></div>
        </div>
        <div class="panel suspects" id="suspectPanel">
          <h3>Suspect board</h3>
          <div id="suspects"></div>
        </div>
      </div>
    </section>`;
}

function interrogation(payload) {
  const board = payload.board ?? state.board;
  state.board = board;
  state.awaiting = true;
  const auto = payload.autoIndex;
  stage.innerHTML = `
    <section class="scene">
      <p class="hint">${esc(payload.message || "Pick a commit. The glowing one is the detective's information-optimal probe.")}</p>
      <div class="lineup" id="lineup"></div>
      <div class="row">
        <button class="btn" id="autoBtn">Let the detective grill ${auto ?? "the next one"}</button>
      </div>
    </section>`;
  const lineup = $("#lineup");
  for (const c of board) {
    const mug = document.createElement("button");
    mug.type = "button";
    mug.className = "mug" + (c.index === auto ? " auto" : "") + (c.probed ? " " + c.probed : "");
    const h = Math.max(8, Math.round((c.p ?? 0) * 100));
    mug.innerHTML = `
      <div class="guilt"><i style="height:${h}%"></i></div>
      <div class="photo">${esc(c.short)}</div>
      <strong>#${c.index}</strong>
      <div style="font-size:11px;min-height:36px">${esc(c.subject.slice(0, 48))}</div>
      <div style="font-size:10px;color:#6b5344">${esc(c.author.split(" ")[0])} · ${esc((c.date || "").slice(0, 10))}</div>
      ${c.probed ? `<div class="stamp-mark">${c.probed === "bad" ? "GUILTY?" : "CLEAN"}</div>` : ""}`;
    mug.onclick = () => pick(c.index);
    lineup.appendChild(mug);
  }
  $("#autoBtn").onclick = () => pick("auto");
}

function newspaper() {
  const c = state.culprit;
  const s = state.stats;
  stage.innerHTML = `
    <section class="scene">
      <article class="paper-verdict reveal">
        <div class="masthead">
          <div>THE NIGHTLY DIFF · extra edition</div>
          <h1>CAUGHT.</h1>
        </div>
        <p class="lede">${c ? `#${c.index} ${esc(c.short)} — ${esc(c.subject)}` : "The case is closed."}</p>
        <div class="stats">
          <div><b>${s?.probes ?? "—"}</b> interrogations</div>
          <div><b>${s?.uniformSteps ?? "—"}</b> git bisect would need</div>
          <div><b>${s ? Math.round(s.confidence * 100) : "—"}%</b> confidence</div>
        </div>
        <div class="cols" id="verdictBody"></div>
        <div class="row" style="margin-top:24px">
          <button class="btn" id="again">File another complaint</button>
        </div>
      </article>
    </section>`;
  $("#verdictBody").innerHTML = renderMarkdown(state.verdict || "The detective is still typing the report…");
  $("#again").onclick = cover;
}

function handle(type, payload) {
  if (type === "opened") {
    state.commits = payload.commits || [];
    say(`Case ${payload.caseId} · ${payload.commitCount} suspects on the board · ${payload.brain}`);
    radio(`opened the file on ${payload.repo}`);
  }
  if (type === "phase") say(payload.title);
  if (type === "tool") {
    radio(`→ ${payload.name} ${JSON.stringify(payload.args).slice(0, 80)}`);
    say(`Agent tool: ${payload.name}`);
  }
  if (type === "evidence") {
    state.evidence = payload.items || [];
    pinEvidence(state.evidence);
  }
  if (type === "theory") {
    radio(`theory: ${payload.notes}`);
    say(payload.notes);
  }
  if (type === "suspects") renderSuspects(payload.suspects || []);
  if (type === "repro") {
    radio(`oracle: ${payload.explanation}`);
    say(`Reproduction holds. HEAD says: ${payload.headOutput.replace(/\s+/g, " ").slice(-80)}`);
  }
  if (type === "prior") {
    state.board = payload.board;
    say(`Prior entropy ${payload.entropyBits.toFixed(2)} bits vs ${payload.uniformBits.toFixed(2)} uniform. 90% credible set: ${payload.credible90} commits.`);
    if (state.mode !== "player") showBoard(payload.board);
  }
  if (type === "awaiting_probe") interrogation(payload);
  if (type === "probe") {
    state.awaiting = false;
    state.probes.push(payload);
    const stamp = payload.result === "bad" ? "BAD" : "GOOD";
    say(`#${payload.step} grilled ${payload.commit.short} → ${stamp}  (P(bad)=${Math.round(payload.pBad * 100)}%) · ${payload.by}`);
    radio(`${payload.by} probed #${payload.index} ${payload.commit.short} → ${stamp}`);
    slamStamp(payload);
  }
  if (type === "posterior" && state.mode !== "player") showBoard(payload.board);
  if (type === "culprit") {
    state.culprit = payload.commit;
    state.stats = payload;
    say(`Culprit ${payload.commit.short} · ${payload.probes} probes vs ${payload.uniformSteps} for git bisect`);
  }
  if (type === "verdict") {
    state.verdict = payload.markdown;
    newspaper();
  }
  if (type === "amends") {
    say(`Fix landed on ${payload.branch} (${payload.commitSha.slice(0, 7)})`);
    radio(`amends: ${payload.summary}`);
  }
  if (type === "closed") say("Case closed. The newspaper is on the desk.");
  if (type === "error") say("The detective hit a wall: " + payload.message);
}

function radio(line) {
  state.radio.unshift(line);
  const el = $("#radio");
  if (!el) return;
  el.innerHTML = state.radio.slice(0, 18).map((l) => `<div><span class="t">▌</span> ${esc(l)}</div>`).join("");
}

function pinEvidence(items) {
  const cork = $("#cork");
  if (!cork) return;
  cork.querySelectorAll(".card,.pin").forEach((n) => n.remove());
  const yarn = $("#yarn");
  yarn.innerHTML = "";
  const W = cork.clientWidth - 230;
  const H = cork.clientHeight - 140;
  items.slice(0, 10).forEach((e, i) => {
    const x = 20 + ((i * 97) % Math.max(40, W));
    const y = 24 + ((i * 53) % Math.max(40, H));
    const rot = ((i * 17) % 11) - 5;
    const card = document.createElement("div");
    card.className = "card";
    card.style.left = x + "px";
    card.style.top = y + "px";
    card.style.transform = `rotate(${rot}deg)`;
    card.innerHTML = `<div class="kind">${esc(e.kind)} · ${(e.via || []).join("+")}</div><h3>${esc((e.title || "").slice(0, 64))}</h3><p>${esc((e.snippet || "").replace(/\s+/g, " ").slice(0, 140))}</p>`;
    card.onclick = () => inspect(e.title + "\n\n" + (e.snippet || ""));
    cork.appendChild(card);
    const pin = document.createElement("div");
    pin.className = "pin";
    pin.style.left = x + 96 + "px";
    pin.style.top = y - 6 + "px";
    cork.appendChild(pin);
    if (i > 0) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const prev = items[i - 1];
      void prev;
      const px = 20 + (((i - 1) * 97) % Math.max(40, W)) + 100;
      const py = 24 + (((i - 1) * 53) % Math.max(40, H)) + 20;
      line.setAttribute("x1", px);
      line.setAttribute("y1", py);
      line.setAttribute("x2", x + 100);
      line.setAttribute("y2", y + 20);
      line.setAttribute("stroke", "#c23b22");
      line.setAttribute("stroke-width", "1.6");
      line.setAttribute("stroke-opacity", "0.7");
      yarn.appendChild(line);
    }
  });
}

function renderSuspects(list) {
  const el = $("#suspects");
  if (!el) return;
  el.innerHTML = list
    .map((s) => {
      const pct = Math.round(s.score * 100);
      const c = s.commit;
      return `<div class="suspect"><div>${pct}%</div><div><strong>${esc(c ? c.short + " " + c.subject : s.sha.slice(0, 7))}</strong><div class="meter"><i style="width:${pct}%"></i></div><div style="font-size:11px;color:#bba48c">${esc(s.reason)}</div></div></div>`;
    })
    .join("");
}

function showBoard(board) {
  if ($("#cork")) {
    renderSuspects(
      board.slice()
        .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
        .slice(0, 8)
        .map((c) => ({ sha: c.sha, score: c.p ?? 0, reason: c.probed ? `already grilled: ${c.probed}` : "posterior mass", commit: c })),
    );
    return;
  }
  interrogation({ board, autoIndex: null, message: "The posterior is shifting. Highest bars are the current suspects." });
  state.awaiting = false;
  const btn = $("#autoBtn");
  if (btn) btn.remove();
}

function slamStamp(payload) {
  const mugs = [...document.querySelectorAll(".mug")];
  const mug = mugs.find((m) => m.textContent.includes(payload.commit.short));
  if (!mug) return;
  mug.classList.add(payload.result);
  const mark = document.createElement("div");
  mark.className = "stamp-mark reveal";
  mark.textContent = payload.result === "bad" ? "BAD" : "GOOD";
  mug.appendChild(mark);
}

async function pick(index) {
  if (!state.streamId) return;
  state.awaiting = false;
  say("Interrogating…");
  await fetch(`/api/probe/${state.streamId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index }),
  });
}

function inspect(text) {
  const wrap = document.createElement("div");
  wrap.className = "inspect";
  wrap.innerHTML = `<pre>${esc(text)}</pre>`;
  wrap.onclick = () => wrap.remove();
  document.body.appendChild(wrap);
}

function renderMarkdown(md) {
  return esc(md)
    .replace(/^### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^## (.*)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br/>");
}

boot();
