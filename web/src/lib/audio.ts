/* Procedural foley: typewriter keys, radio static, rubber stamps. No audio files, all synthesized. */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = localStorage.getItem("whodunit.muted") === "1";
let noiseBuffer: AudioBuffer | null = null;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(ctx.destination);
    const len = ctx.sampleRate * 1.2;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Call from a user gesture so the browser lets us make noise. */
export function unlockAudio() {
  ensure();
}

export function isMuted() {
  return muted;
}

export function setMuted(v: boolean) {
  muted = v;
  localStorage.setItem("whodunit.muted", v ? "1" : "0");
  if (master && ctx) master.gain.setTargetAtTime(v ? 0 : 0.8, ctx.currentTime, 0.02);
}

function noise(c: AudioContext, opts: { dur: number; gain: number; freq?: number; q?: number; type?: BiquadFilterType; at?: number }) {
  if (!noiseBuffer || !master) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filt = c.createBiquadFilter();
  filt.type = opts.type ?? "bandpass";
  filt.frequency.value = opts.freq ?? 2500;
  filt.Q.value = opts.q ?? 1.2;
  const g = c.createGain();
  const t0 = c.currentTime + (opts.at ?? 0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.gain, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  src.connect(filt).connect(g).connect(master);
  src.start(t0, Math.random() * 0.8);
  src.stop(t0 + opts.dur + 0.05);
}

function tone(c: AudioContext, opts: { f0: number; f1?: number; dur: number; gain: number; type?: OscillatorType; at?: number }) {
  if (!master) return;
  const o = c.createOscillator();
  o.type = opts.type ?? "sine";
  const t0 = c.currentTime + (opts.at ?? 0);
  o.frequency.setValueAtTime(opts.f0, t0);
  if (opts.f1) o.frequency.exponentialRampToValueAtTime(opts.f1, t0 + opts.dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + opts.dur + 0.05);
}

/** Mechanical typewriter key. */
export function sfxKey() {
  const c = ensure();
  if (!c || muted) return;
  noise(c, { dur: 0.035, gain: 0.35, freq: 3200 + Math.random() * 1200, q: 0.9 });
  tone(c, { f0: 1800 + Math.random() * 400, dur: 0.02, gain: 0.06, type: "triangle" });
}

/** Carriage return / lever for bigger actions. */
export function sfxLever() {
  const c = ensure();
  if (!c || muted) return;
  noise(c, { dur: 0.09, gain: 0.5, freq: 1800, q: 0.7 });
  tone(c, { f0: 900, f1: 500, dur: 0.12, gain: 0.08, type: "square" });
  tone(c, { f0: 2400, dur: 0.25, gain: 0.05, type: "sine", at: 0.06 });
}

/** Radio squelch chirp — plays when Elasticsearch is queried. */
export function sfxChirp() {
  const c = ensure();
  if (!c || muted) return;
  noise(c, { dur: 0.12, gain: 0.12, freq: 1400, q: 0.5 });
  tone(c, { f0: 700, f1: 1500, dur: 0.09, gain: 0.07, type: "sine" });
  tone(c, { f0: 1500, f1: 1100, dur: 0.07, gain: 0.05, type: "sine", at: 0.09 });
}

/** Sonar-ish blip when the probe needle lands. */
export function sfxBlip() {
  const c = ensure();
  if (!c || muted) return;
  tone(c, { f0: 1320, f1: 1180, dur: 0.14, gain: 0.09, type: "sine" });
}

/** Heavy rubber stamp. */
export function sfxStamp(heavy = false) {
  const c = ensure();
  if (!c || muted) return;
  noise(c, { dur: 0.06, gain: heavy ? 0.9 : 0.6, freq: 900, q: 0.6, type: "lowpass" });
  tone(c, { f0: heavy ? 110 : 140, f1: 45, dur: heavy ? 0.3 : 0.2, gain: heavy ? 0.5 : 0.3, type: "sine" });
  noise(c, { dur: 0.02, gain: 0.3, freq: 4000, q: 1, at: 0.005 });
}

/** Two-note brass hit for the headline. */
export function sfxHeadline() {
  const c = ensure();
  if (!c || muted) return;
  tone(c, { f0: 196, dur: 0.5, gain: 0.18, type: "sawtooth" });
  tone(c, { f0: 294, dur: 0.5, gain: 0.12, type: "sawtooth" });
  tone(c, { f0: 392, dur: 0.9, gain: 0.14, type: "sawtooth", at: 0.28 });
  tone(c, { f0: 494, dur: 0.9, gain: 0.1, type: "sawtooth", at: 0.28 });
  noise(c, { dur: 0.5, gain: 0.08, freq: 600, q: 0.4, at: 0.28 });
}

/** Alarm buzz for errors. */
export function sfxBuzz() {
  const c = ensure();
  if (!c || muted) return;
  tone(c, { f0: 140, dur: 0.25, gain: 0.15, type: "square" });
  tone(c, { f0: 140, dur: 0.25, gain: 0.15, type: "square", at: 0.32 });
}
