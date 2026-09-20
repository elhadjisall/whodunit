import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Deterministic hash → [0,1) for stable jitter/hues. */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function authorHue(name: string): number {
  return Math.floor(hash01(name, 7) * 360);
}

/** heat 0..1 → green → amber → crime red */
export function heatColor(p: number): string {
  const x = Math.max(0, Math.min(1, p));
  const stops: [number, [number, number, number]][] = [
    [0, [42, 122, 69]],
    [0.45, [216, 179, 58]],
    [1, [230, 57, 70]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i][0] && x <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const t = (x - a[0]) / (b[0] - a[0] || 1);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
}

export function fmtTime(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
}

export function pct(x: number | undefined, digits = 0): string {
  return `${((x ?? 0) * 100).toFixed(digits)}%`;
}

export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Keeps a scrolling log pinned to the bottom unless the user scrolled up. */
export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

/** Reveals `lines` progressively, like a teletype. */
export function useTeletype(lines: string[], key: string | number, msPerLine = 55): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(0);
    let i = 0;
    const t = setInterval(() => {
      i++;
      setShown(i);
      if (i >= lines.length) clearInterval(t);
    }, msPerLine);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return Math.min(shown, lines.length);
}

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
