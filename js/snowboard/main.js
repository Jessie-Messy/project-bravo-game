// main.js — boot, world assembly, camera and the frame loop.
//
// One structural decision drives this file: THE MENU AND THE GAME SHARE ONE
// WORLD. Choosing a run builds the real course, the real terrain and the real
// weather, and the menu camera simply orbits the rider standing at the start
// gate of it. Picking Niseko shows you a dusk blizzard through birch; picking
// Chamonix shows you dawn on the glacier. Nothing is a mock-up, there is no
// second lighting rig to keep in sync, and pressing DROP IN costs a camera
// change rather than a load screen.

import * as THREE from 'three';
import { getSettings, getTier, setTier, onTierChange, frameTick, PHYS } from './config.js';
import { SNOW_TYPES } from './data/runs.js';
import { deriveHandling } from './data/gear.js';
import { Course, CHUNK_LEN } from './course.js';
import { TerrainField, DISTANT_LEN } from './terrain.js';
import { Scenery } from './scenery.js';
import { createEnvironment } from './sky.js';
import { createRider } from './rider.js';
import { Ride } from './physics.js';
import { Spray, Snowfall } from './fx.js';
import { createComposer } from './post.js';
import { UI, loadSave } from './ui.js';
import { Input } from './input.js';
import * as audio from './audio.js';

const canvas = document.getElementById('gl');
const uiRoot = document.getElementById('ui');
const loader = document.getElementById('loader');
const loaderBar = document.getElementById('loaderBar');
const loaderNote = document.getElementById('loaderNote');

/** Replace the loading copy with something that explains a dead end. */
function showFatal(message) {
  if (loaderNote) loaderNote.textContent = message;
  loader?.classList.remove('is-done');
  const bar = loaderBar?.parentElement;
  if (bar) bar.style.display = 'none';
}

// ── Renderer ──────────────────────────────────────────────────────
// Guarded, because the failure mode otherwise is a black screen and no
// explanation: a phone with WebGL disabled, a browser that refuses a context
// under memory pressure, or a machine with no GPU at all. Throwing here halts
// module evaluation deliberately — there is no game without a renderer — but
// the player is told why first.
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,        // the composer's SMAA does this better where it runs
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
} catch (err) {
  showFatal('This browser could not start WebGL, so the mountain cannot be drawn. Try a different browser, or check that hardware acceleration is switched on.');
  throw err;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(64, 1, 0.35, 24000);
scene.add(camera);

let quality = getSettings();
let composer = null;

function applyQuality() {
  quality = getSettings();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
  renderer.shadowMap.enabled = !!quality.shadows;
  renderer.toneMappingExposure = world?.env?.time?.exposure ?? 0.5;
  composer?.dispose();
  composer = createComposer(renderer, scene, camera, quality);
  resize();
  world?.env?.applyQuality(quality);
  world?.terrain?.setQuality(quality);
  if (world) {
    world.spray?.setPixelRatio(renderer.getPixelRatio());
    world.snowfall?.setPixelRatio(renderer.getPixelRatio());
  }
}
onTierChange(() => applyQuality());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Phones in portrait see much less of the run ahead at a fixed horizontal
  // FOV, so widen vertically instead of letting the framing collapse.
  camera.fov = h > w ? 74 : 64;
  camera.updateProjectionMatrix();
  composer?.setSize(renderer.domElement.width, renderer.domElement.height);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 220));

// ── World ─────────────────────────────────────────────────────────
let world = null;
let building = false;         // a world build is in flight; DROP IN must wait
let state = 'boot';
let countdownEndsAt = 0;      // wall-clock, deliberately not simulation time           // boot | menu | countdown | ride | finished
let countdown = 0;
let flash = 0;
let camYaw = 0, camDist = 8, camHeight = 3.2, camFov = 64;
let orbit = 0;
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
// Scratch objects. The frame loop runs 90+ times a second and every Vector3 it
// allocates is a future GC pause in the middle of a carve.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const scratchUp = new THREE.Vector3();
const scratchQ = new THREE.Quaternion();
const scratchYawQ = new THREE.Quaternion();
const shadowTarget = new THREE.Vector3();
const stepInput = { steer: 0, jump: false, grab: false, brake: false };

function disposeWorld() {
  if (!world) return;
  scene.remove(world.root);
  world.terrain.dispose();
  world.scenery.dispose();
  world.rider.dispose();
  world.spray.dispose();
  world.snowfall.dispose();
  world.env.dispose();
  // The sky dome, lights and ridges were added straight to the scene.
  for (const o of world.envObjects) scene.remove(o);
  scene.environment = null;
  world = null;
}

async function buildWorld(sel, onProgress = () => {}) {
  building = true;
  disposeWorld();
  const run = sel.run;
  const root = new THREE.Group();
  scene.add(root);

  onProgress(0.08, `Surveying ${run.mountain}…`);
  await frame();

  const course = new Course(run);
  onProgress(0.24, 'Cutting the fall line…');
  await frame();

  const env = createEnvironment(renderer, scene, run);
  // Above the start line: you drop in from a shoulder, and the surrounding
  // summits stand higher than the lift did. Fixed in world Y, so descending the
  // run makes the skyline rise around you — the one parallax cue that sells a
  // 1,500 m vertical.
  env.ridgeBaseY = course.startY + 40;
  env.applyQuality(quality);
  renderer.toneMappingExposure = env.time.exposure;
  const envObjects = [env.sky, env.sun, env.sun.target, env.hemi, env.fill, env.ridges, env.clouds];
  onProgress(0.42, 'Waiting on the light…');
  await frame();

  const snowType = SNOW_TYPES[run.snow] || SNOW_TYPES.groomed;
  const terrain = new TerrainField(course, run, quality, snowType);
  root.add(terrain.group);
  terrain.prime(0);
  onProgress(0.66, 'Grooming the snowpack…');
  await frame();

  const scenery = new Scenery(course, run, quality);
  root.add(scenery.group);
  scenery.update(0, true);
  onProgress(0.84, 'Planting the trees…');
  await frame();

  const rider = createRider(sel.rider, sel.board, { shadows: quality.shadows });
  root.add(rider.group);

  const spray = new Spray(quality.sprayMax, snowType);
  spray.setPixelRatio(renderer.getPixelRatio());
  root.add(spray.points);

  const snowfall = new Snowfall(
    Math.round(quality.snowfall * (0.25 + env.weather.snowfall)), env.weather);
  snowfall.setPixelRatio(renderer.getPixelRatio());
  root.add(snowfall.points);

  // Fog only has to bury the far edge of the DISTANT shell, not the detail
  // window, which is what lets a bluebird day at Zermatt keep its view instead
  // of drowning the valley in haze to hide a cull line 440 m out.
  const terrainReach = quality.chunkAhead * CHUNK_LEN + DISTANT_LEN;
  scene.fog.density = Math.max(env.weather.fogDensity, 1.35 / terrainReach);

  const handling = deriveHandling(sel.board, sel.rider);
  const ride = new Ride(course, handling, run);

  world = { run, sel, root, course, env, envObjects, terrain, scenery, rider, spray, snowfall, ride, handling, snowType };
  resetRide();
  onProgress(1, 'Ready');
  await frame();
  building = false;
  return world;
}

function frame() { return new Promise(r => requestAnimationFrame(() => r())); }

function resetRide() {
  const w = world;
  w.ride = new Ride(w.course, w.handling, w.run);
  w.bestCombo = 1;
  w.terrain.update(0, 8);
  w.scenery.update(0, true);
  camYaw = 0;
  const p = w.ride.pos;
  camPos.set(p.x, p.y + 4, p.z + 10);
  camLook.set(p.x, p.y + 1.2, p.z - 6);
  flash = 0;
}

// ── UI wiring ─────────────────────────────────────────────────────
const save = loadSave();
audio.setMuted(!!save.muted);

const input = new Input(canvas, { sensitivity: 1 });

// Which picker is open decides the menu camera's framing. Declared up here
// because UI's constructor shows the home screen — and therefore calls
// onScreen — before its own `const ui` binding exists.
let menuFraming = 'wide';

const ui = new UI(uiRoot, {
  onStart: () => startRun(),
  onRetry: () => { resetRide(); startRun(); },
  onQuit: () => { toMenu(); ui.show('home'); },
  onPause: (p) => {
    if (p) { input.reset(); audio.suspend(); } else { audio.resume(); }
  },
  onScreen: (id) => {
    // The menu camera framing follows which picker is open: close on the board
    // for the board rail, a portrait for the rider rail, wide for the run list.
    menuFraming = id === 'board' ? 'board' : id === 'rider' ? 'rider' : 'wide';
  },
  onPreview: async (key, sel) => {
    if (!world) return;
    if (key === 'run' && sel.run.id !== world.run.id) {
      setLoading(true, `Loading ${sel.run.mountain}…`);
      await buildWorld(sel, (p, note) => setLoadingProgress(p, note));
      setLoading(false);
    } else if (key !== 'run') {
      // Rider and board changes only need the figure rebuilt.
      world.root.remove(world.rider.group);
      world.rider.dispose();
      world.rider = createRider(sel.rider, sel.board, { shadows: quality.shadows });
      world.root.add(world.rider.group);
      world.handling = deriveHandling(sel.board, sel.rider);
      world.ride.h = world.handling;
    }
  },
  onTilt: async (want) => {
    if (!want) { input.disableTilt(); return false; }
    return await input.enableTilt();
  },
});

input.bindActionButton(ui.btnAction);
input.bindBrakeButton(ui.btnBrake);

function setLoading(on, note) {
  loader.classList.toggle('is-done', !on);
  if (note) loaderNote.textContent = note;
  if (on) loaderBar.style.width = '5%';
}
function setLoadingProgress(p, note) {
  loaderBar.style.width = Math.round(p * 100) + '%';
  if (note) loaderNote.textContent = note;
}

function startRun() {
  // The loading overlay blocks taps while a run is being built, but nothing
  // else does — and a start that lands mid-build gets silently reset by the
  // resetRide() at the end of buildWorld.
  if (building || !world) return;
  resetRide();
  ui.enterRide();
  state = 'countdown';
  // Wall clock, NOT accumulated simulation time. dt is clamped to 1/4 second so
  // a backgrounded tab cannot teleport the rider, but that clamp also means a
  // device rendering slower than 4 fps advances the countdown slower than real
  // time — and the first second of a run is the slowest there is, with shaders
  // compiling and chunks uploading. A phone could sit on "3" for ten seconds
  // and read, correctly, as a game that will not start.
  countdown = COUNTDOWN_SEC;
  countdownEndsAt = performance.now() + COUNTDOWN_SEC * 1000;
  world._lastCount = null;      // so a retry calls "3" again, not silence
  input.enabled = true;
  input.reset();
  audio.init();
  audio.startRide(world.run.snow);
  hintTimer = 5.5;
}

function toMenu() {
  state = 'menu';
  input.enabled = false;
  audio.stopRide();
  if (world) resetRide();
}

let hintTimer = 0;

// ── Camera ────────────────────────────────────────────────────────
function updateCamera(dt) {
  const w = world;
  const r = w.ride;
  const p = r.pos;

  if (state === 'menu' || state === 'finished') {
    // Slow orbit around the rider, framed for whatever picker is open.
    orbit += dt * (state === 'finished' ? 0.16 : 0.10);
    const cfg = menuFraming === 'board'
      ? { dist: 3.0, height: 1.05, look: 0.45 }
      : menuFraming === 'rider'
        ? { dist: 4.0, height: 1.75, look: 1.10 }
        : { dist: 6.8, height: 2.35, look: 1.15 };
    const a = orbit + (menuFraming === 'wide' ? 0 : 0.6);
    tmp.set(p.x + Math.sin(a) * cfg.dist, p.y + cfg.height, p.z + Math.cos(a) * cfg.dist);
    const gh = w.course.height(tmp.x, tmp.z) + 0.9;
    tmp.y = Math.max(tmp.y, gh);
    camPos.lerp(tmp, 1 - Math.exp(-2.6 * dt));
    tmp2.set(p.x, p.y + cfg.look, p.z);
    camLook.lerp(tmp2, 1 - Math.exp(-6 * dt));
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(camLook);
    // NO `camera.rotation.z = 0` here. lookAt already guarantees zero roll when
    // up is world-up, so it bought nothing — and it cost a great deal, because
    // reading `.rotation` decomposes the quaternion lookAt just built into an
    // XYZ Euler and writing a component rebuilds the quaternion from it. That
    // decomposition is ill-conditioned as the orbit sweeps through yaw ±90°,
    // where the yaw splits between the x and z terms; zeroing z there stood the
    // whole camera on its head, which is what put the rider upside down on the
    // picker screens.
    camFov += ((window.innerHeight > window.innerWidth ? 58 : 50) - camFov) * (1 - Math.exp(-3 * dt));
    camera.fov = camFov;
    camera.updateProjectionMatrix();
    return;
  }

  // Chase camera. It follows the VELOCITY heading, not the board heading, so a
  // 720 spins the rider in frame instead of whipping the whole world around —
  // which is both more readable and the difference between playable and
  // motion-sick on a phone.
  const gs = r.groundSpeed;
  const vYaw = gs > 1.2 ? Math.atan2(r.vel.x, -r.vel.z) : r.yaw;
  let d = vYaw - camYaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  // Lag the yaw more at speed: a twitchy camera at 90 km/h is unreadable.
  camYaw += d * (1 - Math.exp(-(6.5 - Math.min(3.2, gs * 0.09)) * dt));

  const sp01 = Math.min(1, gs / (PHYS.MAX_SPEED * 0.72));
  const targetDist = 6.5 + sp01 * 3.2 + (r.grounded ? 0 : 1.0);
  const targetHeight = 2.15 + sp01 * 0.85 + (r.grounded ? 0 : 0.7);
  camDist += (targetDist - camDist) * (1 - Math.exp(-3.2 * dt));
  camHeight += (targetHeight - camHeight) * (1 - Math.exp(-3.6 * dt));

  const fx = Math.sin(camYaw), fz = -Math.cos(camYaw);
  tmp.set(p.x - fx * camDist, p.y + camHeight, p.z - fz * camDist);

  // Never let the camera end up inside the hill — a real risk in a gully or
  // the flat bottom of the pipe.
  const gh = w.course.height(tmp.x, tmp.z) + 1.5;
  if (tmp.y < gh) tmp.y = gh;

  // Critically damped follow, stiffer when close so it never falls behind on a
  // sudden drop.
  camPos.lerp(tmp, 1 - Math.exp(-(r.crashT > 0 ? 3.0 : 8.5) * dt));

  // Look well down the run rather than at the rider's back: it puts the board
  // around 60% down the frame and shows the line you are about to take, which
  // is the whole job of a chase camera in a downhill game.
  const lookAhead = 7.0 + sp01 * 11.0;
  tmp2.set(p.x + fx * lookAhead, p.y + 1.55 - sp01 * 0.30, p.z + fz * lookAhead);
  camLook.lerp(tmp2, 1 - Math.exp(-9 * dt));

  camera.position.copy(camPos);
  camera.up.set(0, 1, 0);
  camera.lookAt(camLook);
  // A touch of roll into the turn. Small — this is seasoning, not a barrel roll.
  // Applied as a rotation about the camera's OWN forward axis rather than by
  // writing `rotation.z`, which would round-trip the orientation through an
  // Euler and hit the same gimbal problem the menu camera did whenever the
  // chase yaw passes ±90° — which a meandering course does regularly.
  camera.rotateZ(-r.edge * 0.055 - r.slip * 0.02 * Math.sign(r.edge));

  const targetFov = (window.innerHeight > window.innerWidth ? 74 : 64) + sp01 * 17 + (r.crashT > 0 ? 6 : 0);
  camFov += (targetFov - camFov) * (1 - Math.exp(-2.6 * dt));
  camera.fov = camFov;
  camera.updateProjectionMatrix();
}

// ── Rider pose from sim state ─────────────────────────────────────
const boardPos = new THREE.Vector3();

function updateRiderVisual(dt) {
  const w = world, r = w.ride, rider = w.rider;
  const n = r.groundNormal;

  rider.group.position.set(r.pos.x, r.pos.y, r.pos.z);

  // Align the board to the surface it is on, then yaw it to the board heading.
  // Airborne, the board relaxes back toward level so a spin reads cleanly.
  scratchUp.set(n.x, n.y, n.z);
  const blend = r.grounded ? 1 : Math.max(0, 1 - r.airTime * 1.8);
  scratchUp.lerp(WORLD_UP, 1 - blend).normalize();

  scratchQ.setFromUnitVectors(WORLD_UP, scratchUp);
  scratchYawQ.setFromAxisAngle(WORLD_UP, r.yaw);
  rider.group.quaternion.copy(scratchQ).multiply(scratchYawQ);

  const sp01 = Math.min(1, r.groundSpeed / (PHYS.MAX_SPEED * 0.7));
  const p = rider.pose;
  p.edge += (r.edge - p.edge) * Math.min(1, dt * 12);
  p.crouch += ((r.grounded ? 0.30 + Math.abs(r.edge) * 0.45 + sp01 * 0.2 : 0.75) - p.crouch) * Math.min(1, dt * 8);
  p.air += ((r.grounded ? 0 : 1) - p.air) * Math.min(1, dt * 9);
  p.grab += (r.grab - p.grab) * Math.min(1, dt * 10);
  p.grabType = r.grabType;
  p.speed = sp01;
  p.crash += ((r.crashT > 0 ? 1 : 0) - p.crash) * Math.min(1, dt * (r.crashT > 0 ? 14 : 5));
  // Counter-rotation: the torso leads the turn, which is what makes a carve
  // look like a carve and not a statue on a sled.
  p.twist += ((-r.edge * 0.42 - (r.grounded ? 0 : 0.2)) - p.twist) * Math.min(1, dt * 7);
  p.lean += ((r.grounded ? -sp01 * 0.25 : 0.25) - p.lean) * Math.min(1, dt * 5);
  rider.update(dt);

  // ── Spray ───────────────────────────────────────────────────────
  if (r.grounded && r.groundSpeed > 4 && state === 'ride') {
    rider.boardWorld(boardPos);
    const snowSpray = w.snowType.spray;
    const power = Math.min(1, (r.slip * 0.75 + Math.abs(r.edge) * 0.45) * (r.groundSpeed / 22));
    let amount = power * snowSpray * 14 * dt * 60;
    // Powder throws a rooster tail even riding straight; a groomer does not.
    if (w.run.snow === 'powder') amount += (r.groundSpeed / 20) * 9 * dt * 60 * 0.5;
    amount = Math.min(26, amount);
    if (amount >= 0.5) {
      const gsInv = 1 / Math.max(0.001, r.groundSpeed);
      const dir = { x: r.vel.x * gsInv, z: r.vel.z * gsInv };
      w.spray.emit(boardPos, dir, Math.round(amount), Math.min(1, power + (w.run.snow === 'powder' ? 0.4 : 0)),
        { x: n.x, y: n.y, z: n.z });
    }
  }
}

// ── Events → HUD, audio, feel ─────────────────────────────────────
function drainEvents() {
  const w = world, r = w.ride;
  for (const e of r.events) {
    switch (e.type) {
      case 'trick': {
        const steps = Math.min(5, Math.floor(e.points / 500));
        audio.sfx.trick(steps);
        ui.callout(e.name, e.points);
        w.bestCombo = Math.max(w.bestCombo, e.combo);
        break;
      }
      case 'crash':
        audio.sfx.crash();
        ui.callout(e.reason === 'tree' ? 'TREE!' : e.reason === 'wall' ? 'WIPEOUT' : 'CRASH', 0, true);
        flash = 0.55;
        break;
      case 'pop': audio.sfx.pop(); break;
      case 'grind': audio.sfx.grind(); ui.callout('GRIND', 0); break;
      case 'finish': onFinish(); break;
    }
  }
  r.events.length = 0;
}

function onFinish() {
  state = 'finished';
  input.enabled = false;
  const w = world, r = w.ride, run = w.run;

  // Time bonus, then stars off the run's own thresholds. Beating par is worth
  // real points, so a clean fast line competes with a trick-heavy one.
  const timeBonus = Math.max(0, run.parTime - r.time) * 140;
  const total = Math.round(r.score + timeBonus);
  let starCount = 0;
  for (const t of run.stars) if (total >= t) starCount++;

  const grade = starCount >= 3 ? 'Podium run. Nothing left on the hill.'
    : starCount === 2 ? 'Strong line — the podium is close.'
    : starCount === 1 ? 'Down clean. Now go find some speed.'
    : 'You made it to the bottom. Ride it again.';

  audio.stopRide();
  audio.sfx.finish(starCount);
  ui.setHudVisible(false);

  setTimeout(() => {
    ui.showResults(run, {
      time: r.time, score: total, stars: starCount, grade,
      topSpeed: r.stats.topSpeed, airTotal: r.stats.airTotal,
      biggestAir: r.stats.biggestAir, tricksLanded: r.stats.tricksLanded,
      crashes: r.stats.crashes, bestCombo: w.bestCombo, tricks: r.tricks,
    });
  }, 900);
}

// ── Frame loop ────────────────────────────────────────────────────
let last = performance.now();
const MAX_STEP = 1 / 90;
const COUNTDOWN_SEC = 2.6;
let lastFrameDt = 1 / 60;

// Errors inside the loop are reported once and then swallowed. rAF is
// re-armed on the first line, so without this a single throwing subsystem
// leaves the loop running and doing nothing for the rest of the session: the
// game is frozen, the screen is live, and there is no clue on it as to why.
//
// The report goes ON SCREEN as well as to the console, and that is the whole
// point of it. A phone has no console. The first version of this guard logged
// and nothing else, so a SecurityError from the gamepad API — thrown every
// frame, on the first frame of every run — presented to the player as a game
// that simply would not start, and took two rounds of back-and-forth to
// identify. An error the player can read is an error they can report.
let loopErrors = 0;
function reportLoopError(where, err) {
  if (loopErrors++ === 0) {
    console.error(`Frame loop error in ${where}:`, err);
    showLoopError(where, err);
  }
  if (loopErrors === 60) console.error('Frame loop still failing; further errors suppressed.');
}

function showLoopError(where, err) {
  try {
    const bar = document.createElement('div');
    bar.className = 'errbar';
    const msg = (err && (err.message || err.name)) || String(err);
    bar.innerHTML = `<b>Something broke in the ${where} loop.</b>
      <span>${msg.replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'))}</span>
      <button type="button" aria-label="Dismiss">Dismiss</button>`;
    bar.querySelector('button').onclick = () => bar.remove();
    uiRoot.appendChild(bar);
  } catch { /* the reporter must never be the thing that throws */ }
}

function tick(now) {
  requestAnimationFrame(tick);
  try {
    simulate(now);
  } catch (err) {
    reportLoopError('update', err);
  }
  try {
    present();
  } catch (err) {
    reportLoopError('render', err);
  }
}

function simulate(now) {
  const realDt = (now - last) / 1000;
  last = now;
  // Two clocks on purpose. `dt` drives the simulation and is clamped, so a
  // backgrounded tab cannot teleport the rider through the mountain on the
  // frame it comes back. `realDt` is what actually elapsed, and it is what the
  // performance watchdog has to measure — fed the clamped value, it thinks a
  // device managing one frame a second is managing four.
  const dt = Math.min(realDt, 0.25);
  if (!world) return;

  const paused = ui.isPaused;
  frameTick(realDt);

  if (!paused) {
    if (state === 'countdown') {
      countdown = (countdownEndsAt - now) / 1000;
      const n = Math.ceil(countdown);
      if (n !== world._lastCount) {
        world._lastCount = n;
        if (n > 0) { ui.callout(String(n), 0); audio.sfx.ui(); }
      }
      if (countdown <= 0) {
        state = 'ride';
        ui.callout('DROP!', 0);
        audio.sfx.select();
      }
    }

    const active = state === 'ride';
    const inp = active ? input.poll(dt) : { steer: 0, jump: false, grab: false, brake: false };

    if (state === 'ride' || state === 'finished') {
      // Fixed substeps: at 90 km/h a 60 Hz step moves the board 40 cm, and the
      // ground contact test starts missing thin features like rail tops.
      let remain = dt;
      // The ollie is edge-triggered, so it must fire on exactly one substep.
      stepInput.steer = inp.steer; stepInput.grab = inp.grab;
      stepInput.brake = inp.brake; stepInput.jump = inp.jump;
      while (remain > 0) {
        const step = Math.min(MAX_STEP, remain);
        world.ride.update(step, stepInput);
        stepInput.jump = false;
        remain -= step;
      }
      drainEvents();
    }

    updateRiderVisual(dt);
    updateCamera(dt);

    const d = world.ride.distance;
    world.terrain.update(d, state === 'menu' ? 1 : 2);
    world.scenery.update(d);
    // Particle sizes are in metres, so they need the camera's current
    // projection — and the FOV widens with speed, so this is per frame.
    const vh = renderer.domElement.height / renderer.getPixelRatio();
    world.spray.setProjection(vh, camera.fov);
    world.snowfall.setProjection(vh, camera.fov);
    world.spray.update(dt, world.env.weather.wind * 2);
    world.snowfall.update(dt, camera, world.ride.vel);
    world.env.update(camera, dt);
    // Aim the shadow camera between the rider and the eye, so its texels cover
    // what is actually on screen rather than what is behind the player.
    shadowTarget.set(world.ride.pos.x, world.ride.pos.y, world.ride.pos.z)
      .lerp(camera.position, 0.25);
    world.env.trackShadow(shadowTarget);
    world.terrain.setUniform('uSunDir', world.env.sunDir);

    // HUD
    if (state === 'ride' || state === 'countdown') {
      const r = world.ride;
      ui.updateHud(r.time, r.score, r.groundSpeed * 3.6, r.progress, r.combo);
      audio.updateRide(
        Math.min(1, r.groundSpeed / (PHYS.MAX_SPEED * 0.75)),
        Math.min(1, r.slip), r.grounded, Math.abs(r.edge));
      if (hintTimer > 0) { hintTimer -= dt; if (hintTimer <= 0) ui.hideHint(); }
    }

    flash = Math.max(0, flash - dt * 1.8);
  }

  lastFrameDt = dt;
}

/** Draw. Kept separate from the simulation so a throw in one still leaves the
 *  other running — a frozen picture and a live picture fail very differently. */
function present() {
  if (!world) return;
  const sp01 = world.ride ? Math.min(1, world.ride.groundSpeed / (PHYS.MAX_SPEED * 0.62)) : 0;
  if (composer && !window.SNOW?.noPost) {
    composer.setLook(state === 'ride' ? sp01 : 0, flash);
    composer.render(lastFrameDt);
  } else {
    renderer.render(scene, camera);
  }
}

// ── Boot ──────────────────────────────────────────────────────────
(async function boot() {
  applyQuality();
  setLoadingProgress(0.03, 'Waxing the base…');
  try {
    await buildWorld(ui.sel, setLoadingProgress);
  } catch (err) {
    console.error(err);
    showFatal('Could not build the run: ' + (err?.message || err));
    return;
  }
  toMenu();
  requestAnimationFrame(tick);
  setTimeout(() => setLoading(false), 260);
})();

// Pause the ride when the tab or app goes away — nobody wants to come back to
// a crashed run and a drained battery.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    audio.suspend();
    if (state === 'ride') ui.openPause(false);
  } else {
    last = performance.now();
    audio.resume();
  }
});

// Expose a little of the machinery for debugging without a bundler. `noPost`
// bypasses the composer, which is how you tell a grading artefact apart from a
// geometry one without editing a file.
window.SNOW = {
  get world() { return world; },
  get state() { return state; },
  get building() { return building; },
  noPost: false,
  ui, input, setTier, getTier, renderer, scene, camera,
  THREE,   // so a console (or a test) can raycast and inspect the graph
};
