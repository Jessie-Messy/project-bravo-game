// audio.js — every sound in the game is synthesised.
//
// No sample files: the ride sound has to respond continuously to speed, edge
// angle and snow type, and crossfading samples never does that convincingly.
// A filtered noise bed whose cutoff tracks slip IS the sound of a board on
// snow, and it costs one oscillator graph instead of a folder of .ogg.
//
// Nothing is created until the first user gesture, because every mobile browser
// requires that and an AudioContext built earlier just sits suspended.

let ac = null, master = null, bus = null;
let muted = false, volume = 0.7;
let ride = null;                 // the continuous ride bed
let started = false;

export function isMuted() { return muted; }
export function setMuted(v) {
  muted = v;
  if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ac.currentTime, 0.05);
}
export function setVolume(v) {
  volume = v;
  if (master && !muted) master.gain.setTargetAtTime(v, ac.currentTime, 0.05);
}

function noiseBuffer(seconds = 2) {
  const len = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Procedural impulse response for a valley-sized reverb.
function makeIR(dur, decay) {
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export function init() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return ac; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ac = new Ctx();

  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -8; limiter.knee.value = 10; limiter.ratio.value = 14;
  limiter.attack.value = 0.003; limiter.release.value = 0.15;
  limiter.connect(ac.destination);

  master = ac.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(limiter);

  const conv = ac.createConvolver();
  conv.buffer = makeIR(2.4, 2.6);
  bus = ac.createGain(); bus.gain.value = 0.28;
  bus.connect(conv); conv.connect(master);

  return ac;
}

/** Start the continuous ride bed. Safe to call more than once. */
export function startRide(snowType) {
  init();
  if (!ac || started) return;
  started = true;

  const nb = noiseBuffer(3);

  // Board on snow: broadband noise through a bandpass whose centre frequency
  // rises with slip. A carve is low and hissy; a skid is high and gritty.
  const carveSrc = ac.createBufferSource();
  carveSrc.buffer = nb; carveSrc.loop = true;
  const carveBP = ac.createBiquadFilter();
  carveBP.type = 'bandpass'; carveBP.frequency.value = 900; carveBP.Q.value = 0.7;
  const carveGain = ac.createGain(); carveGain.gain.value = 0;
  carveSrc.connect(carveBP); carveBP.connect(carveGain);
  carveGain.connect(master); carveGain.connect(bus);
  carveSrc.start();

  // Wind: separate noise through a lowpass that opens with speed, so the top
  // end only arrives when you are genuinely moving.
  const windSrc = ac.createBufferSource();
  windSrc.buffer = nb; windSrc.loop = true;
  const windLP = ac.createBiquadFilter();
  windLP.type = 'lowpass'; windLP.frequency.value = 300;
  const windGain = ac.createGain(); windGain.gain.value = 0;
  windSrc.connect(windLP); windLP.connect(windGain); windGain.connect(master);
  windSrc.start();

  // Low rumble that only appears at real speed — the body of the sound.
  const rumbleSrc = ac.createBufferSource();
  rumbleSrc.buffer = nb; rumbleSrc.loop = true;
  const rumbleLP = ac.createBiquadFilter();
  rumbleLP.type = 'lowpass'; rumbleLP.frequency.value = 140;
  const rumbleGain = ac.createGain(); rumbleGain.gain.value = 0;
  rumbleSrc.connect(rumbleLP); rumbleLP.connect(rumbleGain); rumbleGain.connect(master);
  rumbleSrc.start();

  ride = { carveBP, carveGain, windLP, windGain, rumbleLP, rumbleGain, snow: snowType,
           nodes: [carveSrc, windSrc, rumbleSrc] };
}

/**
 * @param speed01   0..1 of top speed
 * @param slip      0..1.6 sideways scrub
 * @param grounded  board in contact
 * @param edge      0..1 absolute edge angle
 */
export function updateRide(speed01, slip, grounded, edge) {
  if (!ride || !ac) return;
  const t = ac.currentTime, k = 0.06;
  const contact = grounded ? 1 : 0.06;

  // Hardpack is bright and loud; powder is a muffled whump.
  const bright = ride.snow === 'hardpack' || ride.snow === 'ice' ? 1.6 : ride.snow === 'powder' ? 0.45 : 1;
  const carveVol = contact * (0.035 + speed01 * 0.16 + slip * 0.22 * speed01) * bright;
  ride.carveGain.gain.setTargetAtTime(Math.min(0.34, carveVol), t, k);
  ride.carveBP.frequency.setTargetAtTime(
    420 + speed01 * 1500 + slip * 2600 * bright + edge * 400, t, k);
  ride.carveBP.Q.setTargetAtTime(0.6 + edge * 1.6, t, k);

  ride.windGain.gain.setTargetAtTime(0.02 + speed01 * speed01 * 0.24, t, k);
  ride.windLP.frequency.setTargetAtTime(260 + speed01 * 2400, t, k);

  ride.rumbleGain.gain.setTargetAtTime(contact * speed01 * speed01 * 0.35, t, k);
  ride.rumbleLP.frequency.setTargetAtTime(90 + speed01 * 190, t, k);
}

export function stopRide() {
  if (!ride) return;
  for (const n of ride.nodes) { try { n.stop(); } catch { /* already stopped */ } }
  ride = null; started = false;
}

// ── One-shots ─────────────────────────────────────────────────────
function env(node, gain, attack, decay, when = 0) {
  const t = ac.currentTime + when;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  node.connect(g);
  return { g, t, stop: t + attack + decay + 0.02 };
}

function burst({ freq = 200, gain = 0.3, attack = 0.005, decay = 0.25, type = 'noise', filter = 'lowpass', q = 1, sweep = 0, rev = 0.2 }) {
  if (!ac) return;
  let src;
  if (type === 'noise') {
    src = ac.createBufferSource();
    src.buffer = noiseBuffer(Math.max(0.3, attack + decay + 0.1));
  } else {
    src = ac.createOscillator();
    src.type = type;
    src.frequency.setValueAtTime(freq, ac.currentTime);
    if (sweep) src.frequency.exponentialRampToValueAtTime(Math.max(20, freq * sweep), ac.currentTime + attack + decay);
  }
  const f = ac.createBiquadFilter();
  f.type = filter; f.frequency.value = freq; f.Q.value = q;
  if (sweep && type === 'noise') {
    f.frequency.setValueAtTime(freq, ac.currentTime);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), ac.currentTime + attack + decay);
  }
  src.connect(f);
  const e = env(f, gain, attack, decay);
  e.g.connect(master);
  if (rev > 0) { const s = ac.createGain(); s.gain.value = rev; e.g.connect(s); s.connect(bus); }
  src.start(e.t);
  src.stop(e.stop);
}

function tone(freq, gain, dur, type = 'sine', rev = 0.25) {
  if (!ac) return;
  const o = ac.createOscillator();
  o.type = type; o.frequency.value = freq;
  const e = env(o, gain, 0.008, dur);
  e.g.connect(master);
  if (rev) { const s = ac.createGain(); s.gain.value = rev; e.g.connect(s); s.connect(bus); }
  o.start(e.t); o.stop(e.stop);
}

export const sfx = {
  pop()      { init(); burst({ freq: 900, gain: 0.16, attack: 0.004, decay: 0.10, sweep: 0.35, rev: 0.15 }); },
  land(hard) { init(); burst({ freq: hard ? 180 : 320, gain: hard ? 0.42 : 0.24, attack: 0.004, decay: hard ? 0.4 : 0.22, sweep: 0.3, rev: 0.3 }); },
  crash()    {
    init();
    burst({ freq: 1400, gain: 0.34, attack: 0.003, decay: 0.55, sweep: 0.12, rev: 0.5 });
    burst({ freq: 120,  gain: 0.40, attack: 0.006, decay: 0.5, filter: 'lowpass', rev: 0.4 });
  },
  grind()    { init(); burst({ freq: 2600, gain: 0.12, attack: 0.02, decay: 0.5, filter: 'bandpass', q: 6, rev: 0.4 }); },
  // Trick chime rises with the size of the trick — the clearest possible
  // feedback that a 720 beat a 360 without reading a number.
  trick(step) {
    init();
    const base = 523.25;
    const notes = [0, 4, 7, 11, 14, 19];
    const n = notes[Math.min(notes.length - 1, step)];
    tone(base * Math.pow(2, n / 12), 0.16, 0.42, 'triangle', 0.35);
    tone(base * 2 * Math.pow(2, n / 12), 0.07, 0.30, 'sine', 0.4);
  },
  ui()       { init(); tone(760, 0.08, 0.07, 'square', 0.05); },
  select()   { init(); tone(520, 0.09, 0.09, 'triangle', 0.1); tone(780, 0.06, 0.12, 'sine', 0.15); },
  start()    {
    init();
    [0, 0.12, 0.24].forEach((d, i) => setTimeout(() => tone(440 * Math.pow(2, i / 3), 0.14, 0.2, 'triangle', 0.3), d * 1000));
  },
  finish(stars) {
    init();
    const seq = [0, 4, 7, 12, 16, 19];
    for (let i = 0; i < 3 + stars; i++) {
      setTimeout(() => tone(523.25 * Math.pow(2, seq[i % seq.length] / 12), 0.15, 0.5, 'triangle', 0.45), i * 130);
    }
  },
};

export function suspend() { if (ac && ac.state === 'running') ac.suspend(); }
export function resume() { if (ac && ac.state === 'suspended') ac.resume(); }
