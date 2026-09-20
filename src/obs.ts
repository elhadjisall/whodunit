/**
 * Local timing spans so the radar can show Elasticsearch vs Gemini latency.
 * No third-party APM — keep the demo self-contained.
 */
export interface SpanRecord {
  name: string;
  op: string;
  durationMs: number;
  attrs?: Record<string, string | number | boolean | undefined>;
}

type Primitive = string | number | boolean | undefined;
type SpanFn<T> = (set: (k: string, v: Primitive) => void) => Promise<T> | T;

let spanSink: ((s: SpanRecord) => void) | null = null;

export function onSpan(fn: ((s: SpanRecord) => void) | null): void {
  spanSink = fn;
}

export async function span<T>(name: string, op: string, attrs: Record<string, Primitive>, fn: SpanFn<T>): Promise<T> {
  const extra: Record<string, Primitive> = { ...attrs };
  const set = (k: string, v: Primitive) => {
    extra[k] = v;
  };
  const t0 = Date.now();
  try {
    const result = await fn(set);
    spanSink?.({ name, op, durationMs: Date.now() - t0, attrs: { ...extra, ok: true } });
    return result;
  } catch (e) {
    spanSink?.({ name, op, durationMs: Date.now() - t0, attrs: { ...extra, ok: false } });
    throw e;
  }
}

export function captureFlakyOracle(_commitHash: string, _detail: { truth: string; observed: string; step: number }): void {
  /* UI already stamps FLAKY from the probe event. */
}

export function captureException(_err: unknown, _tags?: Record<string, string>): void {
  /* no-op */
}

export function logInfo(_message: string, _extra?: Record<string, Primitive>): void {
  /* no-op */
}

export function count(_name: string, _value = 1, _attrs: Record<string, Primitive> = {}): void {
  /* no-op */
}
