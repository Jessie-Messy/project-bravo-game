// audio.js — sample-based SFX (CC0 packs, see sounds/LICENSE.txt) with a
// procedural Web Audio fallback for anything not yet loaded. The public
// API (snd.*, soundMuted, masterVol) is unchanged.
export let soundMuted = false;
export let masterVol  = 0.65;
export function setSoundMuted(v) { soundMuted = v; }

let _ac=null, _master=null, _revIn=null, _noiseBuf=null;

// Procedural impulse response → cheap reverb without sample files
function _makeIR(dur, decay) {
  const rate=_ac.sampleRate, len=Math.floor(rate*dur), buf=_ac.createBuffer(2,len,rate);
  for (let c=0;c<2;c++) { const d=buf.getChannelData(c);
    for (let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,decay); }
  return buf;
}

function _getAC() {
  if (!_ac) {
    _ac = new (window.AudioContext || window.webkitAudioContext)();
    // master → limiter → out
    const lim=_ac.createDynamicsCompressor();
    lim.threshold.value=-9; lim.knee.value=8; lim.ratio.value=12;
    lim.attack.value=0.002; lim.release.value=0.12;
    _master=_ac.createGain(); _master.gain.value=masterVol;
    _master.connect(lim); lim.connect(_ac.destination);
    // reverb send bus
    const conv=_ac.createConvolver(); conv.buffer=_makeIR(1.7, 2.4);
    _revIn=_ac.createGain(); _revIn.gain.value=0.9;
    _revIn.connect(conv); conv.connect(_master);
    _decodeAll();          // sample bytes may already be fetched — decode now
  }
  if (_ac.state==='suspended') _ac.resume();
  return _ac;
}

// ── Sample library ────────────────────────────────────────────────
// Event → list of files in sounds/ (one is picked at random per play).
// vol: per-event gain. rev: reverb send. rateJ: random pitch spread.
const SAMPLE_DEFS = {
  swing:    {files:['swing.ogg','swing2.ogg'],                          vol:0.55, rateJ:0.14},
  arrow:    {files:['swing3.ogg'],                                      vol:0.45, rateJ:0.18},
  hit:      {files:['metal_01.ogg','metal_02.ogg','metal_03.ogg'],      vol:0.55, rateJ:0.12},
  enemyHit: {files:['blade_01.ogg','blade_02.ogg','blade_03.ogg'],      vol:0.5,  rateJ:0.12},
  hurt:     {files:['creature_hurt_01.ogg','creature_hurt_02.ogg'],     vol:0.5,  rateJ:0.1},
  die:      {files:['giant3.ogg','giant5.ogg'],                         vol:0.7,  rev:0.35},
  enemyDie: {files:['creature_die_01.ogg','mnstr5.ogg','mnstr9.ogg'],   vol:0.55, rateJ:0.15, rev:0.15},
  pickup:   {files:['cloth.ogg','item_misc_02.ogg'],                    vol:0.5,  rateJ:0.1},
  heal:     {files:['bottle.ogg','bubble.ogg'],                         vol:0.6,  rateJ:0.08},
  cave:     {files:['magic1.ogg','spell_01.ogg'],                       vol:0.65, rev:0.4},
  craft:    {files:['wood-small.ogg','metal-small1.ogg','metal-small2.ogg'], vol:0.6, rateJ:0.1},
  gold:     {files:['coin.ogg','coin2.ogg','coin3.ogg','item_coins_01.ogg'], vol:0.6, rateJ:0.08},
  axe:      {files:['wood_01.ogg','wood_02.ogg','wood_03.ogg'],         vol:0.55, rateJ:0.14},
  quest:    {files:['item_gem_02.ogg'],                                 vol:0.7,  rev:0.35},
  // step: intentionally procedural — fires constantly; soft synth thud
};
const _bytes={}, _buffers={};
// Fetch all sample bytes immediately (decode waits for the AudioContext)
for (const def of Object.values(SAMPLE_DEFS)) for (const f of def.files) {
  if (_bytes[f]!==undefined) continue;
  _bytes[f]=null;
  fetch('sounds/'+f).then(r=>r.ok?r.arrayBuffer():null)
    .then(ab=>{ _bytes[f]=ab; if(_ac&&ab) _decodeOne(f,ab); })
    .catch(()=>{});
}
function _decodeOne(f, ab) {
  _ac.decodeAudioData(ab.slice(0), buf=>{ _buffers[f]=buf; }, ()=>{});
}
function _decodeAll() {
  for (const [f,ab] of Object.entries(_bytes)) if (ab && !_buffers[f]) _decodeOne(f, ab);
}

function _playSample(name) {
  if (soundMuted) return true;               // muted still counts as handled
  const def=SAMPLE_DEFS[name]; if(!def) return false;
  const ready=def.files.filter(f=>_buffers[f]);
  if (!ready.length) { _getAC(); return false; }   // not decoded yet → synth fallback
  try {
    const ac=_getAC();
    const src=ac.createBufferSource();
    src.buffer=_buffers[ready[Math.floor(Math.random()*ready.length)]];
    const j=def.rateJ||0;
    src.playbackRate.value=1+(Math.random()*2-1)*j;
    const g=ac.createGain(); g.gain.value=def.vol??0.6;
    src.connect(g); g.connect(_master);
    if (def.rev) { const s=ac.createGain(); s.gain.value=def.rev; g.connect(s); s.connect(_revIn); }
    src.start();
    return true;
  } catch(_) { return false; }
}

// ── Procedural fallback synths ────────────────────────────────────
function _out(node, rev) {
  node.connect(_master);
  if (rev>0) { const s=_ac.createGain(); s.gain.value=rev; node.connect(s); s.connect(_revIn); }
}
function _tone(freq, type, vol, atk, dur, opts={}) {
  if (soundMuted) return;
  try {
    const ac=_getAC(), t0=ac.currentTime+(opts.delay||0);
    const osc=ac.createOscillator(), g=ac.createGain();
    osc.type=type; osc.frequency.setValueAtTime(freq,t0);
    if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(opts.glideTo,10), t0+(opts.glideT||dur));
    if (opts.detune) osc.detune.value=opts.detune;
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(vol, t0+Math.max(0.001,atk));
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(g); _out(g, opts.rev||0);
    if (opts.vib) { const lfo=ac.createOscillator(), la=ac.createGain();
      lfo.frequency.value=opts.vib; la.gain.value=opts.vibDepth||6;
      lfo.connect(la); la.connect(osc.frequency); lfo.start(t0); lfo.stop(t0+dur+0.03); }
    osc.start(t0); osc.stop(t0+dur+0.04);
  } catch(_) {}
}
function _noise(vol, dur, opts={}) {
  if (soundMuted) return;
  try {
    const ac=_getAC(), t0=ac.currentTime+(opts.delay||0);
    if (!_noiseBuf) {
      const rate=ac.sampleRate, len=rate*2;
      _noiseBuf=ac.createBuffer(1,len,rate); const d=_noiseBuf.getChannelData(0);
      for (let i=0;i<len;i++) d[i]=Math.random()*2-1;
    }
    const src=ac.createBufferSource(); src.buffer=_noiseBuf;
    const flt=ac.createBiquadFilter(); flt.type=opts.type||'lowpass';
    flt.frequency.setValueAtTime(opts.freq||1000, t0);
    if (opts.sweepTo) flt.frequency.exponentialRampToValueAtTime(Math.max(opts.sweepTo,20), t0+dur);
    if (opts.q!=null) flt.Q.value=opts.q;
    const g=ac.createGain();
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(vol, t0+Math.max(0.001,opts.atk||0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    src.connect(flt); flt.connect(g); _out(g, opts.rev||0);
    src.start(t0, Math.random()); src.stop(t0+dur+0.04);
  } catch(_) {}
}
const _rand=(a,b)=>a+Math.random()*(b-a);

const _synth = {
  swing: ()=>{ _noise(0.15,0.19,{type:'bandpass',freq:480,sweepTo:2600,q:1.1,atk:0.05});
    _tone(300*_rand(0.9,1.1),'sawtooth',0.05,0.005,0.13,{glideTo:120}); },
  hit: ()=>{ _noise(0.34,0.05,{type:'highpass',freq:1900,atk:0.001});
    _tone(165,'square',0.5,0.001,0.15,{glideTo:46});
    _noise(0.24,0.13,{type:'lowpass',freq:720,sweepTo:200}); },
  hurt: ()=>{ _tone(_rand(230,260),'sawtooth',0.3,0.006,0.22,{glideTo:110,vib:26,vibDepth:14});
    _noise(0.12,0.17,{type:'lowpass',freq:520,sweepTo:190}); },
  die: ()=>{ _tone(330,'sawtooth',0.4,0.01,0.95,{glideTo:52,rev:0.45,vib:8,vibDepth:9});
    _tone(196,'triangle',0.2,0.03,1.05,{glideTo:44,rev:0.35});
    _noise(0.18,0.7,{type:'lowpass',freq:420,sweepTo:120,rev:0.3,atk:0.03}); },
  enemyHit: ()=>{ _noise(0.22,0.06,{type:'bandpass',freq:900,q:1.6});
    _tone(_rand(185,215),'square',0.17,0.001,0.08,{glideTo:88}); },
  enemyDie: ()=>{ _tone(_rand(380,430),'sawtooth',0.28,0.005,0.32,{glideTo:60,vib:32,vibDepth:20});
    _noise(0.2,0.28,{type:'lowpass',freq:620,sweepTo:150,rev:0.2}); },
  pickup: ()=>{ _tone(660,'sine',0.22,0.001,0.11,{glideTo:990});
    _tone(1320,'sine',0.11,0.02,0.12,{delay:0.04}); },
  heal: ()=>{ [523,659,784].forEach((f,i)=>_tone(f,'sine',0.13,0.05+i*0.03,0.6+i*0.06,{rev:0.4,vib:5,vibDepth:3,delay:i*0.05})); },
  arrow: ()=>{ _tone(220,'triangle',0.18,0.001,0.13,{glideTo:150});
    _noise(0.09,0.15,{type:'bandpass',freq:1600,sweepTo:3200,q:1.0,atk:0.02}); },
  cave: ()=>{ _tone(70,'sine',0.35,0.03,0.95,{glideTo:34,rev:0.5});
    _noise(0.12,0.85,{type:'lowpass',freq:230,sweepTo:80,rev:0.5,atk:0.1}); },
  craft: ()=>{ _tone(520,'triangle',0.18,0.001,0.19,{glideTo:380});
    _noise(0.11,0.1,{type:'bandpass',freq:1500,q:2.2}); },
  gold: ()=>{ for (let i=0;i<4;i++){ const f=_rand(1400,2300), d=i*0.032;
    _tone(f,'triangle',0.12,0.001,0.16,{delay:d,rev:0.25});
    _tone(f*2.76,'sine',0.05,0.001,0.12,{delay:d,rev:0.25}); } },
  axe: ()=>{ _noise(0.28,0.09,{type:'bandpass',freq:1200,sweepTo:420,q:1.5,atk:0.001});
    _tone(_rand(140,165),'sawtooth',0.16,0.001,0.11,{glideTo:60}); },
  quest: ()=>{ [523,659,784,1047].forEach((f,i)=>_tone(f,'triangle',0.15,0.005,0.34,{delay:i*0.09,rev:0.35})); },
};

// Public API: sample first, synth fallback
const _mk = name => () => { if(!_playSample(name)) (_synth[name]||(()=>{}))(); };
export const snd = {
  swing:_mk('swing'), hit:_mk('hit'), hurt:_mk('hurt'), die:_mk('die'),
  enemyHit:_mk('enemyHit'), enemyDie:_mk('enemyDie'), pickup:_mk('pickup'),
  heal:_mk('heal'), arrow:_mk('arrow'), cave:_mk('cave'), craft:_mk('craft'),
  gold:_mk('gold'), axe:_mk('axe'), quest:_mk('quest'),
  // footsteps stay procedural: they fire constantly and the soft randomized
  // thud sits better under the sampled effects than a looping file would
  step: ()=>{ const r=_rand(0.85,1.15);
    _noise(0.06*r,0.075,{type:'lowpass',freq:200*r,sweepTo:90,atk:0.002});
    _noise(0.02,0.03,{type:'highpass',freq:2600}); },
};
