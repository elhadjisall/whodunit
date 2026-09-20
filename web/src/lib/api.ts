/* Live wire to the bureau server (src/server.ts): REST to open a case, Server-Sent Events to follow it. */
import { EVENT_TYPES, type AmendsResult, type CaseEvent, type CaseHandle, type CaseOptions, type ServerStatus } from "../types";

/** Same-origin when served by the bureau on :3333; absolute otherwise (Vite dev, static hosting). */
export const API_BASE = window.location.port === "3333" ? "" : "http://127.0.0.1:3333";

export async function fetchStatus(timeoutMs = 2500): Promise<ServerStatus | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/status`, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ServerStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function startLiveCase(opts: CaseOptions, onEvent: (e: CaseEvent) => void, onDrop: () => void): Promise<CaseHandle> {
  const res = await fetch(`${API_BASE}/api/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: opts.description,
      mode: opts.mode,
      eps: opts.eps,
      noise: opts.flaky ? 0.3 : 0,
    }),
  });
  if (!res.ok) throw new Error(`bureau refused the case: ${res.status}`);
  const { caseStream } = (await res.json()) as { caseStream: string };

  const source = new EventSource(`${API_BASE}/api/stream/${caseStream}`);
  let closed = false;
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (raw) => {
      try {
        const payload = JSON.parse((raw as MessageEvent).data);
        onEvent({ type, payload } as CaseEvent);
      } catch (e) {
        console.warn("bad event", type, e);
      }
    });
  }
  source.onerror = () => {
    if (!closed && source.readyState === EventSource.CLOSED) onDrop();
  };

  return {
    id: caseStream,
    kind: "live",
    async submitProbe(index) {
      const r = await fetch(`${API_BASE}/api/probe/${caseStream}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? "probe rejected");
    },
    async requestFix(branch = "fix/whodunit-patch") {
      const r = await fetch(`${API_BASE}/api/fix/${caseStream}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; amends?: AmendsResult; error?: string };
      if (!r.ok || !body.ok || !body.amends) throw new Error(body.error ?? `fix failed (${r.status})`);
      return body.amends;
    },
    close() {
      closed = true;
      source.close();
    },
  };
}
