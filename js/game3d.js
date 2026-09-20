// game3d.js — Three.js 3D entry point (replaces game.js for 3D mode)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { net, initNet, netTick, netChat, netPvp, netTp, netMobHit, netSave,
  netHousePlace, netHouseUpdate, netHouseRemove,
  netDropAdd, netDropTake, netTradeReq, netTradeAccept, netTradeOffer, netTradeConfirm, netTradeCancel,
  playerName, MP_ENABLED } from './net.js';
import { TILE, MAP_W, MAP_H, T, BLOCKING, CITY,
  HARVEST_RANGE, SWORD_RANGE, SWORD_ARC, TREE_HP, STONE_HP, IRON_HP, RESPAWN_TREE, RESPAWN_STONE, RESPAWN_IRON, DAY_CYCLE_SEC,
  ENEMY_POP_CHECK_INTERVAL, WOLF_TARGET, BANDIT_TARGET,
  XP_LEVELS, TACTICS_DMG, ARCHERY_DMG, HIDING_DUR, HEAL_AMT, WRESTLE_STUN, WRESTLE_DMG,
  SKILL_PANEL_W, SKILL_PANEL_H, SKILL_PANEL_ROW,
  PANEL_W, PANEL_PAD, BTN_H, HEADER_H, BTN_GAP, fitPanelW, fitPanelH,
  TRADE_W, TRADE_PAD, TRADE_ROW_H, TRADE_HEADER, TRADE_SECT_H,
  BANK_W, BANK_H, BANK_PAD, BANK_HEADER, BANK_BTN_W, BANK_BTN_H,
  GUARD_CALL_COOLDOWN, MINIMAP_BASE,
  DUNGEON_X0, DUNGEON_Y0, DUNGEON_W, DUNGEON_H,
  TERRAIN_MAP_H, COAST_X0, COAST_Y0, COAST_W, COAST_H,
  COAST_LANDING, COAST_MAINLAND_DOCK,
  RACES, getXpForLevel,
} from './constants.js';
import { AccountManager, renderCharSelect, renderCharCreator, handleCharSelectClick, handleCharCreatorClick, openCreator, hideNameInput } from './char_creator.js';
import { addPlayerXp, generateLootDrop, getEquipmentStats, socketGem } from './loot_system.js';
import { G, map, resourceHp, respawnAt, origTile, playerPlacedWalls, player,
  enemies, guards, drops, projectiles, eProjList, placedObjects, floaters, hitFlash,
  inv, skills, bank, swordSwing, keys, stick, action, mouse, rmb, tileViewport,
  MERCHANT, BANKER, HEALER, WORLD_HEALERS,
  BLACKSMITH, MAGE, FARRIER,
  ANTIQUARIAN, CRYPTOLOGIST, CURATOR, GRAVE_ROBBER,
} from './state.js';
import { snd, soundMuted, setSoundMuted, setMasterVol, masterVol } from './audio.js';
import { prefs, setPref, resetPrefs, BIND_DEFS, binds, bindOf,
         setBind, resetBinds, keyLabel, canonKey, keyForDefault } from './settings.js';
import { CHAMP_ALTARS, DUNGEON_PORTAL_A, DUNGEON_PORTAL_B,
  DUNGEON_ENTRY_TILE, DUNGEON_CITY_EXIT,
  DUNGEON_FLOORS, DUNGEON_STAIRS, DUNGEON_BOSS_SPAWNS, WORLD_CHESTS, floorAt,
  COAST_VILLAGE, COAST_HOUSE_PLOTS, COAST_DOCK_TILES } from './world.js';
import { updateEnemy, champSpawnTick, damageEnemy, damagePlayer,
  spawnRandomEnemy, boxBlocked, populateWorld, populateDungeon, hooks,
  makeEnemy, ENEMY_CFG, extraBlocking, spawnDrops, BOSS_ABILITIES,
  bossForceCast, bossResolveNow, bossPickForTest, WADE,
} from './enemies.js';
// Render modules. These never import game3d.js — every dependency is passed in
// as an argument — which is what keeps the graph acyclic.
import { initQuality, getSettings, getTier, setTier, onTierChange, frameTick, TIERS } from './render/quality.js';
import { createSky } from './render/sky.js';
import { createWaterMaterial } from './render/water.js';
import { buildArachnidClips } from './render/spider-gait.js';
import { createComposer } from './render/composer.js';
import { createLoadingScreen } from './render/loading.js';
import { VERSION } from './build-info.js';
import { makeBladeGeometry, makeBladeTexture, makeGrassMaterial } from './render/grass.js';
import { makeConiferCanopy, makeBroadleafCanopy, makeTrunk } from './render/trees.js';
import { buildNearForest, makeBiomeSampler } from './render/tree-lod.js';
import { SPECIES } from './render/tree-species.js';
import { cameraModes, DEFAULT_MODE_ID, CAM_MODE_STORE_KEY, FP_EYE_FRAC, FP_PITCH_LIMIT,
         nearBudgetFactor, nearRadiusTiles } from './render/camera-modes.js';
import { createHeightField } from './render/terrain.js';
import { animateFire } from './render/fire.js';
import { makeTorsoGeometry, makeHeadGeometry, makeLimbGeometry,
         buildBodyDressing, buildHeadDressing } from './render/humanoid.js';

// ── Dual-canvas setup ─────────────────────────────────────────────
const glCanvas = document.getElementById('game3d');
const uiCanvas = document.getElementById('ui');
const uiCtx    = uiCanvas.getContext('2d');
G.canvas = uiCanvas;   // game logic uses G.canvas for width/height
G.ctx    = uiCtx;      // UI panels draw on the overlay

// ── Mobile detection ───────────────────────────────────────────────
// Decide up front (not just after the player's first touch) so phones
// never flash the desktop keybind legend and get the on-screen joystick
// / touch buttons from frame one. Coarse-pointer + narrow viewport avoids
// false positives on touch-capable laptops (mouse/trackpad = fine pointer).
{
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent || '');
  const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches;
  if (mobileUA || (coarsePointer && innerWidth < 900)) G.isTouch = true;
}
// The full desktop hotkey legend blocks a huge chunk of a phone screen;
// on mobile it stays hidden and players reach the same reference through
// the existing "?" touch button / T key, which opens the How To Play panel.
// ── Touch HUD mode ────────────────────────────────────────────────
// Screen space is the scarcest resource on a phone, and anything that names a
// KEY is worse than useless there: it takes room and tells you to press
// something you do not have. This strips that chrome on touch devices.
//
// `(pointer: coarse)` rather than waiting for G.isTouch, which only flips on the
// first touchstart — by then the player has already looked at a header full of
// keyboard shortcuts. A laptop with a touchscreen still reports a fine primary
// pointer, so it correctly keeps the full HUD.
function isTouchPrimary(){
  return !!G.isTouch ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
}
// The version shown in the HUD and the tab title comes from js/build-info.js, so
// bumping that one constant moves it everywhere. It used to be a literal in the
// markup that nobody remembered to change, which meant a device on stale cached
// JavaScript was indistinguishable from one running the newest build.
const VERSION_RE = /v\d+(?:\.\d+)+/;
function applyVersion(){
  const row = document.querySelector('#hud div');
  if (row) {
    // Edit the text node in place. The row also holds a <b> and the keyboard-hints
    // <span> that applyMobileHudMode() locates with querySelector('span'), so
    // rebuilding its innerHTML here would quietly break that.
    for (const node of row.childNodes) {
      if (node.nodeType === 3 && VERSION_RE.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(VERSION_RE, 'v' + VERSION);
        break;
      }
    }
  }
  if (VERSION_RE.test(document.title)) {
    document.title = document.title.replace(VERSION_RE, 'v' + VERSION);
  }
}
applyVersion();

function applyMobileHudMode(){
  const touch = isTouchPrimary();

  // The old #hint element does not exist in either page — this was a no-op for as
  // long as it has been here. The real offender is the keyboard-shortcut span in
  // the #hud header ("Shift+C characters · T help · O bag · ..."), which is markup
  // the platform page owns, so it is hidden from here rather than edited there.
  const hud = document.getElementById('hud');
  if (hud) {
    const titleRow = hud.querySelector('div');
    const keyHints = titleRow && titleRow.querySelector('span');
    if (keyHints) keyHints.style.display = touch ? 'none' : '';
    // The version banner is for us, not the player, and on a phone it is the
    // widest thing on screen. Keep it, shrink it out of the way.
    if (titleRow) titleRow.style.fontSize = touch ? '11px' : '';
  }

  // Platform chrome ("← Hub"), present only on the deployed page. Crowded on a
  // phone; nudge it down to a size that does not compete with the game HUD.
  const bar = document.getElementById('orion-bar');
  if (bar) bar.style.fontSize = touch ? '11px' : '';

  document.body.classList.toggle('touch-mode', touch);
}
applyMobileHudMode();
// A tablet can be picked up mid-session, and orientation changes re-run layout.
window.addEventListener('resize', applyMobileHudMode);

// ── Quality tier ──────────────────────────────────────────────────
// Resolved BEFORE the renderer is constructed, because `antialias` is a
// construction-time flag that cannot be changed afterwards — and MSAA is pure
// waste the moment the composer is on, since the scene then renders into a
// non-multisampled target and the multisampled default framebuffer is never
// drawn to. Only the low tier (no composer) should pay for it. A throwaway
// context is cheaper and more honest than guessing from the user agent.
// powerPreference matters enormously on a hybrid-graphics laptop. Without it
// the browser hands you the integrated GPU to save battery — this machine has
// an RTX 2050 sitting idle while an Intel UHD rendered the game at ~20fps.
// It must be passed to the PROBE context too, or detection reads the iGPU and
// picks a tier for hardware we aren't actually going to render on.
const GL_ATTRS = { powerPreference: 'high-performance' };
function _probeGL(){
  try{ const c=document.createElement('canvas');
       return c.getContext('webgl2', GL_ATTRS) || c.getContext('webgl', GL_ATTRS); }catch(_){ return null; }
}
initQuality({ isTouch: G.isTouch, gl: _probeGL() });
let QS = getSettings();

// ── Three.js renderer ─────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: !QS.composer,
  powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, QS.pixelRatio));

// ── Can this machine draw skinned characters at all? ──────────────
// three r160 skins through a shader that is GLSL ES 3.00 ONLY: getBoneMatrix
// uses textureSize(), texelFetch() and the integer % operator, none of which
// exist in GLSL ES 1.00. On a WebGL1 context that vertex shader fails to
// compile, so EVERY skinned mesh silently draws nothing — while static meshes
// are unaffected. The symptom is a headless character with their sword and
// shield still floating in mid-air, because equipment hangs off bone slots
// whose transforms are computed on the CPU.
//
// Seen in the wild on a Windows VM with no GPU driver: the browser fell back to
// the Microsoft Basic Render Driver, refused WebGL2 ("AllowWebgl2:false"), and
// every character in the game vanished while the world rendered fine.
//
// The game already carries a complete non-skinned path — makeRig() builds the
// blocky primitive avatars used before the GLBs finish loading — so the fix is
// to never leave it. Reduced art beats no characters.
const SKINNING_OK = renderer.capabilities.isWebGL2;
if (!SKINNING_OK) {
  console.warn('[gfx] WebGL1 context: three r160 cannot compile its skinning shader here, ' +
               'so animated GLB characters are disabled and the primitive rigs are used instead.');
}

renderer.shadowMap.enabled = QS.shadows;
renderer.shadowMap.type = QS.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
// Filmic response curve. Without it, bright surfaces clip to flat white and
// the whole scene reads washed out. ACES rolls highlights off instead, so
// metal and lit cloth keep their shading. It darkens the midtones a little,
// hence the >1 exposure to land back at the old overall brightness.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// 1.25 was chosen to lift ACES' darker midtones back to the old brightness in
// a scene lit only by two directional lights. With a sky and IBL feeding the
// same frame there is far more light going in, and 1.25 clipped the sky to
// flat white. Tune this with _dev.gfx({exposure:n}) — it takes effect live.
renderer.toneMappingExposure = 0.85;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2a14);
scene.fog = new THREE.Fog(0x1a2a14, 4000, 9000);

// ── PBR environment ───────────────────────────────────────────────
// Every MeshStandardMaterial in the game (props, armour, weapons, chests)
// has metalness but had nothing to reflect, so metal rendered as flat black
// — that's why loadPropGeometry had to strip the metalness/roughness maps
// off the GLB imports. A cheap procedural sky/ground gradient run through
// PMREM gives image-based lighting, so metal actually looks like metal.
// Only Standard materials are affected; the Lambert-shaded terrain, walls
// and trees are untouched, so the world's overall look doesn't shift.
function makeSkyEnvTexture(){
  const c=document.createElement('canvas'); c.width=64; c.height=256;
  const cx=c.getContext('2d'), g=cx.createLinearGradient(0,0,0,256);
  g.addColorStop(0.00,'#5b86c4');   // zenith
  g.addColorStop(0.46,'#cfe2f2');   // sky at the horizon
  g.addColorStop(0.54,'#6d6350');   // ground haze
  g.addColorStop(1.00,'#332d22');   // dirt underfoot
  cx.fillStyle=g; cx.fillRect(0,0,64,256);
  const t=new THREE.CanvasTexture(c);
  t.mapping=THREE.EquirectangularReflectionMapping;
  t.colorSpace=THREE.SRGBColorSpace;
  return t;
}
{
  const pm=new THREE.PMREMGenerator(renderer);
  pm.compileEquirectangularShader();
  const src=makeSkyEnvTexture();
  scene.environment=pm.fromEquirectangular(src).texture;
  src.dispose(); pm.dispose();
}
// IBL must fade with the sun, or props stay lit at night and the new-moon
// darkness we just tuned stops reading. Quantised so the scene walk only
// runs when the value actually moves.
let _envIntensity=1, _envApplied=-1;
function applyEnvIntensity(v){
  const q=Math.round(v*20)/20;
  if(q===_envApplied) return;
  _envApplied=q;
  scene.traverse(o=>{
    if(!o.isMesh) return;
    const mats=Array.isArray(o.material)?o.material:[o.material];
    for(const m of mats) if(m&&m.isMeshStandardMaterial&&m.envMapIntensity!==q){ m.envMapIntensity=q; }
  });
}

// near/far were 1 / 60000 — a 60,000:1 ratio that spent almost the entire depth
// buffer on the first few units in front of the lens, where nothing ever is.
// Minimum zoom still puts the camera ~390u from the player, so near can go to
// 10 safely, and fog is fully opaque by 9000 so anything past 12000 was already
// invisible. ~5000x the depth precision for two numbers, which is what makes
// screen-space ambient occlusion viable later. Deliberately NOT
// logarithmicDepthBuffer — that breaks early-Z and costs more than it saves.
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 10, 12000);
// Each camera preset carries the FOV that suits it; the player's setting is an
// OFFSET on top of that, so moving the slider keeps the relationship between the
// presets (first person wide, top-down tight) instead of flattening them to one
// number. Clamped either side of sanity: below ~50 the world reads as a
// telescope, above ~120 the edges of the frame smear.
function applyFov(m){
  const base = (m && m.fov) || 52;
  const want = Math.max(50, Math.min(120, base + (prefs.fov || 0)));
  if (camera.fov !== want) { camera.fov = want; camera.updateProjectionMatrix(); camModeDirty = true; }
}
const CAM_H = 1100, CAM_D = 700; // height above ground, depth behind player
const CAM_R = Math.hypot(CAM_D, CAM_H);        // orbit radius (kept constant while tilting)
const CAM_PITCH0 = Math.atan2(CAM_H, CAM_D);   // default tilt (~57°) — matches old framing
// Minimum air between the camera and whatever ground is under it. Has to exceed
// the terrain mesh's own vertical error: the ground is one segment per 2 tiles,
// so between vertices the drawn surface can sit above the sampled height field
// by a few units on a steep face. 30 covers that with room to spare and is
// small enough that the lift is not noticeable when it happens.
const CAM_CLEAR = 30;
// Six samples over a boom that is at most ~3900 units is one per ~650 — finer
// than the terrain's own 96-unit segments would justify going.
const CAM_BOOM_SAMPLES = 6;
// The lowest the camera may sit at (cx,cz), accounting for everything the boom
// passes over on the way there. heightAt() is a lookup into a baked grid, not
// noise evaluation, so this is six array reads per frame.
function camBoomFloor(cx, cz){
  let floor = -Infinity;
  for(let s = 1; s <= CAM_BOOM_SAMPLES; s++){
    const f = s / CAM_BOOM_SAMPLES;
    const gx = player.x + (cx - player.x) * f;
    const gz = player.y + (cz - player.y) * f;
    let g = heightAt(gx, gz);
    // A riverbed is carved below the water plane, so clearing the BED still
    // leaves the camera under the surface — the same shot with a blue tint.
    // Keyed off the tile being water rather than off the height, so dry ground
    // that happens to sit below WATER_SURFACE_Y is not pushed up for nothing.
    if(!G.inDungeon){
      const tx = Math.floor(gx/TILE), ty = Math.floor(gz/TILE);
      if(map[ty] && map[ty][tx] === T.WATER && g < WATER_SURFACE_Y) g = WATER_SURFACE_Y;
    }
    if(g > floor) floor = g;
  }
  return floor + CAM_CLEAR;
}
// Closer default so the world reads big (esp. on phones); pinch / scroll /
// Ctrl+ +/- still adjust freely within 0.3 (close) … 3.0 (far).
let camZoom = (typeof innerWidth==='number' && innerWidth<600) ? 0.55 : 0.72;
let camAngle = 0;
let camPitch = CAM_PITCH0;   // 0.06 (ground level) … 1.54 (straight overhead)
let camOrbit = null;         // middle-mouse drag state {lx,ly,dist,moved}

// ── Camera presets ────────────────────────────────────────────────
// Named stops on the same orbit, cycled with [ and ]. Middle-drag still works
// after picking one, so a preset is a starting point, not a cage. First person
// is the one entry that leaves the orbit entirely — see the camera block in the
// frame update.
const CAM_MODES = cameraModes(CAM_PITCH0);
let camModeIdx = (() => {
  try {
    const i = CAM_MODES.findIndex(m => m.id === localStorage.getItem(CAM_MODE_STORE_KEY));
    if (i >= 0) return i;
  } catch (_) { /* private mode */ }
  return Math.max(0, CAM_MODES.findIndex(m => m.id === DEFAULT_MODE_ID));
})();
let fpPitch = 0;             // first-person look elevation, 0 = horizon
// Its own flag rather than reusing treeDirty: treeDirty is declared much later
// in this file, and setCamMode runs once at boot to apply the stored mode.
let camModeDirty = false;
function camMode(){ return CAM_MODES[camModeIdx]; }
function setCamMode(i, announce = true){
  camModeIdx = ((i % CAM_MODES.length) + CAM_MODES.length) % CAM_MODES.length;
  const m = camMode();
  // Snap the orbit to the preset. First person keeps its own pitch, and
  // leaving camPitch/camZoom untouched means stepping back out of first person
  // returns you to the framing you had.
  if (!m.fp) { camPitch = m.pitch; camZoom = m.zoom; }
  // Field of view per preset: wide enough in first person to feel like eyes
  // rather than a telescope, tightening as the camera pulls back and up, where
  // a wide angle only adds distortion at the frame edges. The view-cone cull
  // reads camera.fov directly, so it follows this without further work.
  applyFov(m);
  // The near/far split depends on the angle, so it has to be recomputed now
  // rather than waiting for the player to walk far enough to slide the window.
  camModeDirty = true;
  try { localStorage.setItem(CAM_MODE_STORE_KEY, m.id); } catch (_) {}
  if (announce && typeof addFloater === 'function') addFloater(player.x, player.y - 40, m.label);
  updateFpChrome();
  // Pointer lock has to be asked for from inside a user gesture, and the
  // keypress that got us here is one. Esc gives the cursor back without
  // leaving first person — middle-drag still aims.
  if (m.fp) requestLook();
}

// Do we currently own the mouse? Kept in sync by the pointerlockchange listener
// below rather than read ad hoc, so the crosshair hint and the click-to-retake
// path can never disagree about it.
let _lookLocked = false;
function requestLook(){
  if (!G.canvas || document.pointerLockElement === G.canvas) return;
  // Returns a promise in current browsers and rejects when there is no user
  // gesture -- notably at boot, where setCamMode() applies the stored mode. Both
  // forms are swallowed: failing to get the lock is normal and recoverable now,
  // and the on-screen hint tells the player how to recover it.
  try {
    const r = G.canvas.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch((err) => { _lookDenied = String(err && err.message || err); });
  } catch (err) { _lookDenied = String(err); }
}
// Why the last request failed, if it did. This used to be swallowed outright,
// which meant a browser that refuses pointer lock produced a first-person view
// you could not aim and no way at all to find out why. Read it with _dev.look().
let _lookDenied = null;
document.addEventListener('pointerlockerror', () => {
  _lookDenied = _lookDenied || 'pointerlockerror (no detail)';
  console.warn('[look] pointer lock refused — first person is using bare-mouse look instead:', _lookDenied);
});
document.addEventListener('pointerlockchange', () => {
  _lookLocked = document.pointerLockElement === G.canvas;
  updateFpChrome();
});
// A panel you cannot point at is worse than no panel. Whenever the UI wants the cursor,
// give it back; the world re-takes it on the next click in the world (see mousedown).
// Checked per frame rather than hooked into each of the ~25 panel flags, so a panel added
// later cannot forget to do it.
function releaseLookForUI(){
  if (document.pointerLockElement === G.canvas && modalOpen()) document.exitPointerLock();
}

// ── First-person look without Pointer Lock ────────────────────────
// Pointer Lock needs a user gesture to enter and can be refused outright, so it
// cannot be the only way to look around. This turns the view from plain cursor
// motion with no button held.
//
// The one thing the lock gives that this cannot is an unbounded cursor: without
// it the pointer stops at the window edge and stops producing deltas, which
// would cap a turn at one screen-width. Hence the margin — sit the cursor in the
// outer band and the view keeps turning by itself, at a rate set by how deep
// into the band it is.
let _flX = null, _flY = null;        // last cursor position, or null if unknown
let _flOutside = false;              // pointer has left the window (still steering)
const FL_EDGE = 110;                 // px of window edge that keeps turning
const FL_EDGE_RATE = 3.2;            // rad/sec at the very edge
function fpFreeLookActive(){
  return camMode().fp
      && document.pointerLockElement !== G.canvas
      && !modalOpen() && !uiDrag && !G.buildMode && !G.editorOpen && !G.housePlacementMode;
}
function fpFreeLookMove(e){
  if(_flX !== null){
    // Same 0.0022 rad/px and the same preferences as the locked path, so the
    // two cannot feel like different games.
    const s = 0.0022*(prefs.lookSens||1), iy = prefs.invertY?-1:1;
    camAngle = (camAngle - (e.clientX-_flX)*s + Math.PI*2) % (Math.PI*2);
    fpPitch  = Math.max(-FP_PITCH_LIMIT, Math.min(FP_PITCH_LIMIT, fpPitch - (e.clientY-_flY)*s*iy));
  }
  _flX = e.clientX; _flY = e.clientY;
}
let _flCursorHidden = false;
// Vertical steering is gentler than horizontal on purpose: pitch is clamped to
// +/-88 degrees, so the band only has to carry the cursor the last part of the
// way rather than turn indefinitely, and a fast vertical creep reads as the view
// sliding out from under you.
const FL_EDGE_RATE_Y = 1.5;
function fpFreeLookEdge(dt){
  // Under Pointer Lock the cursor stops existing. Free-look cannot do that, but
  // it can hide it — otherwise you get a visible arrow sliding into a corner
  // while the world turns, which reads as a stuck UI rather than as looking
  // around. Toggled rather than assigned every frame so it is not a style write
  // per frame forever.
  const want = fpFreeLookActive();
  if(want !== _flCursorHidden){
    G.canvas.style.cursor = want ? 'none' : '';
    _flCursorHidden = want;
  }
  if(_flX === null || !want) return;
  // Off-window is still playing -- the cursor sitting over the browser's own
  // chrome should keep steering, or running off the top edge stops the view
  // dead. Focus is the line: click into another tab or window and this stops,
  // because then you are not playing.
  if(_flOutside && !document.hasFocus()) return;
  let r = 0;
  if(_flX < FL_EDGE)                    r = -(FL_EDGE-_flX)/FL_EDGE;
  else if(_flX > innerWidth-FL_EDGE)    r =  (_flX-(innerWidth-FL_EDGE))/FL_EDGE;
  // Same sign convention as the delta above: cursor to the right turns right.
  if(r) camAngle = (camAngle - r*FL_EDGE_RATE*dt + Math.PI*2) % (Math.PI*2);

  let ry = 0;
  if(_flY < FL_EDGE)                    ry = -(FL_EDGE-_flY)/FL_EDGE;
  else if(_flY > innerHeight-FL_EDGE)   ry =  (_flY-(innerHeight-FL_EDGE))/FL_EDGE;
  if(ry){
    const iy = prefs.invertY ? -1 : 1;
    fpPitch = Math.max(-FP_PITCH_LIMIT,
              Math.min(FP_PITCH_LIMIT, fpPitch - ry*FL_EDGE_RATE_Y*dt*iy));
  }
}
// CAPTURE on `window`, not on the canvas. The platform's own BOARDS button and
// HUB link sit above the canvas in the top strip with pointer-events enabled, so
// a canvas-bound listener stops receiving anything the moment the cursor crosses
// them — the view freezes at exactly the edge of the screen you were steering
// toward. Capture on the window sees the move first, whatever it is over.
addEventListener('mousemove', (e) => {
  if(!fpFreeLookActive()){ _flX = _flY = null; return; }
  _flOutside = false;
  fpFreeLookMove(e);
  // Aim stays pinned to the crosshair, exactly as it is under Pointer Lock.
  mouse.sx = innerWidth*0.5; mouse.sy = innerHeight*0.5; mouse.hasPos = true;
}, true);
// Left the window entirely (relatedTarget is null for the document boundary).
// The position is DELIBERATELY kept: the edge band above needs it to keep
// steering while the cursor is parked over the browser's chrome.
addEventListener('mouseout', (e) => { if(!e.relatedTarget) _flOutside = true; });
addEventListener('mouseover', () => { _flOutside = false; });
// Coming back into the window must not apply the whole excursion as one jump,
// so drop the delta reference — the next move re-establishes it.
addEventListener('blur', () => { _flX = _flY = null; _flOutside = false; });

// First-person chrome: a crosshair, because with the cursor locked to the
// centre there is otherwise nothing showing where an attack will land.
let _fpCross = null;
function updateFpChrome(){
  const fp = camMode().fp;
  if (fp && !_fpCross) {
    _fpCross = document.createElement('div');
    _fpCross.id = 'fp-cross';
    _fpCross.style.cssText =
      'position:fixed;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;' +
      'background:#e8dcc0;border-radius:50%;opacity:.8;pointer-events:none;z-index:4;' +
      'box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 0 6px rgba(0,0,0,.4);';
    document.body.appendChild(_fpCross);
  }
  if (_fpCross) _fpCross.style.display = fp ? 'block' : 'none';
  // The "click to look around" hint used to live here. It was needed when pointer lock
  // was requested once and never re-acquired, so losing it left you stuck with no way
  // back. Any click in the world now re-takes the mouse, so the hint was telling you to
  // do the thing you were already about to do.
  if (!fp && G.canvas && document.pointerLockElement === G.canvas) document.exitPointerLock();
}
// Apply the stored mode once at boot: fov, crosshair and LOD all have to match
// the mode we are actually starting in, not the default we happen to declare.
setCamMode(camModeIdx, false);
setMasterVol(prefs.volume);


// The composer is created late (it's async), so everything here is guarded —
// resize() runs once at boot before `rndr` exists.
let rndr = null;
let _lastRenderT = 0;
function resize() {
  const w = innerWidth, h = innerHeight;
  const pr = Math.min(devicePixelRatio, QS.pixelRatio);
  renderer.setSize(w, h);          // handles glCanvas size internally
  renderer.setPixelRatio(pr);
  uiCanvas.width  = w; uiCanvas.height  = h;
  G.canvas.width  = w; G.canvas.height  = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // BOTH calls. Resizing without re-applying the pixel ratio is the classic
  // "post-processing renders at the wrong scale after a window drag" bug.
  if(rndr){ rndr.setPixelRatio(pr); rndr.setSize(w, h); }
}
addEventListener('resize', resize); resize();

// #headless swaps rAF for a 33ms setTimeout so the loop keeps running in a
// hidden tab. That's above the auto-demote threshold, so the quality watchdog
// reads the test harness as a slow GPU and drops the tier — which silently
// turned shadows off mid-test. Frame timings are meaningless here anyway.
const HEADLESS = typeof location !== 'undefined' && location.hash === '#headless';

// ── Frame-time sampler ────────────────────────────────────────────
// Median, not mean: one 300ms hitch from a terrain re-bake drags a mean far
// enough to make a good build look bad. The median ignores it, which is what
// you want when the question is "does this hold framerate".
const _perf = (() => {
  const N = 300, buf = new Float32Array(N);
  let n = 0, i = 0;
  const sorted = new Float32Array(N);
  return {
    push(ms){ if(!(ms > 0) || ms > 1000) return;   // drop tab-switch gaps
              buf[i] = ms; i = (i+1)%N; if(n<N) n++; },
    median(){ if(!n) return 0;
              sorted.set(buf.subarray(0,n)); const a = sorted.subarray(0,n).sort();
              return +a[n>>1].toFixed(2); },
    fps(){ const m = this.median(); return m ? +(1000/m).toFixed(1) : 0; },
    samples(){ return n; },
    reset(){ n = 0; i = 0; },
    report(){ return {fps:this.fps(), medianMs:this.median(), samples:n}; },
  };
})();

// ── Lighting ──────────────────────────────────────────────────────
const ambientLight = new THREE.AmbientLight(0xffeedd, 0.65);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfffde0, 0.85);
sun.castShadow = true;
sun.shadow.mapSize.set(QS.shadowMapSize || 2048, QS.shadowMapSize || 2048);
sun.shadow.bias = -0.0005;
// normalBias is in WORLD UNITS, and this scene is 48u per tile — the ~0.02 you
// see in most three.js examples is meaningless at this scale and does nothing.
// 2.0 is roughly a twentieth of a tile: enough to kill the shadow acne that
// shows up on the terrain once it's lit as a Standard surface, without the
// silhouette detaching from the caster's feet.
sun.shadow.normalBias = 2.0;
const sc = sun.shadow.camera;
sc.near = 1; sc.far = 8000;
sc.left = sc.bottom = -1200; sc.right = sc.top = 1200;
sun.position.set(3000, 4000, 2000);
scene.add(sun);
scene.add(sun.target);

// ── Shadow frustum fitting ────────────────────────────────────────
// The box above is a fixed +/-1200 around the player. That was a compromise:
// at close zoom it wastes most of the 2048 map on ground you cannot see, and
// zoomed out the view is wider than the box so shadows simply stop partway to
// the horizon. Fitting the box to the camera's actual frustum each frame
// spends every texel on visible ground, which is most of the sharpness win
// without paying for cascades.
//
// Two details matter more than the fit itself:
//   * far is capped at SHADOW_DIST — fog is fully opaque by 9000, so shadows
//     past a few thousand units are invisible and would only dilute texels.
//   * the box is SNAPPED to texel increments. Without that, the projection
//     slides by sub-texel amounts as you walk and every shadow edge crawls;
//     it's the single most obvious artefact of a fitted frustum.
// Sized off camera DISTANCE, not a frustum fit. The frustum-corner approach
// looks more principled but doesn't work here: this camera always looks at the
// player from a bounded orbit, so the corner AABB out to a fixed depth is
// almost the same size at every zoom — measured 2775x1514 at zoom 0.35, 1.5 and
// 3.0 alike, i.e. it adapted to nothing. Worse, at max zoom the camera sits
// ~3900u out, past any sane shadow depth, so the player fell outside the box
// entirely. Distance-driven sizing tracks what you can actually see, in three
// lines, and can't produce that failure.
const SHADOW_HALF_MIN = 900, SHADOW_HALF_MAX = 2200;
const _sLightM = new THREE.Matrix4();
const _sUp = new THREE.Vector3(0,1,0);
const _sCentre = new THREE.Vector3();
const _sFwd = new THREE.Vector3();
const _sFitDbg = {};
let _shadowFitOn = true;
function fitSunShadow(){
  if(!renderer.shadowMap.enabled) return;
  if(!_shadowFitOn){   // A/B against the original fixed box, via _dev.shadowFit(false)
    sc.left = sc.bottom = -1200; sc.right = sc.top = 1200;
    sc.near = 1; sc.far = 8000; sc.updateProjectionMatrix();
    return;
  }
  const camDist = Math.hypot(camera.position.x-player.x, camera.position.z-player.y);
  const half = Math.min(SHADOW_HALF_MAX, Math.max(SHADOW_HALF_MIN, camDist*1.25));

  // Centred on the light's own view axis — i.e. left/right and bottom/top stay
  // symmetric about 0 — because sun.target already tracks the player, so (0,0)
  // in light space IS the player.
  //
  // An earlier version tried to be cleverer: transform a point biased toward
  // the camera's look direction into light space, snap it to texels, and derive
  // `far` from its depth. That produced numbers that all looked correct in
  // isolation (half 1247, centre [-15.8, 336.2], near 1, far 5946, 1.22
  // units/texel) and yet killed cast shadows completely and silently —
  // confirmed by A/B against the original fixed box, which shadows correctly.
  // Verified working beats theoretically tighter, so only the zoom adaptivity
  // survives; the offset centre, the texel snap and the computed `far` are all
  // gone. If you reinstate any of them, A/B it with _dev.shadowFit(false)
  // against a wall at 10:00 and confirm the shadow is still there.
  sc.left = -half; sc.right = half;
  sc.bottom = -half; sc.top = half;
  sc.near = 1; sc.far = 8000;
  sc.updateProjectionMatrix();
  _sFitDbg.half=half; _sFitDbg.camDist=camDist; _sFitDbg.centreZ=0;
}

// ── Surviving a lost GPU context ──────────────────────────────────
// The browser can take the WebGL context away at any time — GPU memory
// pressure, a driver reset, some backgrounding paths. It is routine on phones.
// Unhandled, the canvas keeps being presented empty forever while the 2D HUD
// draws over it, which is indistinguishable from the game crashing.
let _ctxOverlay = null;
function showContextLost(restoring){
  if (!_ctxOverlay) {
    _ctxOverlay = document.createElement('div');
    _ctxOverlay.id = 'ctx-lost';
    _ctxOverlay.style.cssText =
      'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:14px;background:#0d0f0e;' +
      "color:#e8dcc0;font:14px 'Trebuchet MS',Verdana,sans-serif;text-align:center;padding:24px";
    _ctxOverlay.innerHTML =
      '<div style="font-size:1.1rem;letter-spacing:.14em;text-transform:uppercase;color:#d8c9a3">' +
      'Graphics restarting</div>' +
      '<div id="ctx-lost-msg" style="color:#8b968f;max-width:34ch;line-height:1.5"></div>' +
      '<button id="ctx-lost-btn" style="font:inherit;color:#0d0f0e;background:#d8c9a3;' +
      'border:0;padding:9px 18px;cursor:pointer">Reload</button>';
    document.body.appendChild(_ctxOverlay);
    _ctxOverlay.querySelector('#ctx-lost-btn').onclick = () => location.reload();
  }
  _ctxOverlay.querySelector('#ctx-lost-msg').textContent = restoring
    ? 'The device reclaimed the graphics context. Reloading to rebuild the world.'
    : 'The device ran out of graphics memory. Reload to continue — your progress is saved on the server.';
  _ctxOverlay.style.display = 'flex';
}
G.canvas3d = renderer.domElement;
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  // Without preventDefault the browser never fires 'webglcontextrestored' — the
  // default action is to abandon the context for good. This single line is what
  // makes recovery possible at all.
  e.preventDefault();
  console.warn('[gfx] WebGL context lost');
  showContextLost(false);
}, false);
renderer.domElement.addEventListener('webglcontextrestored', () => {
  // Three.js can re-upload its own GL objects, but this module builds a great deal
  // of scene state once at load that a partial restore would leave inconsistent.
  // A reload returns to a known-good frame, which is worth more than saving a few
  // seconds after an event this rare.
  console.warn('[gfx] WebGL context restored — reloading for a clean scene');
  showContextLost(true);
  setTimeout(() => location.reload(), 1200);
}, false);

// Moon light for night cycles (shadows disabled for performance)
const moon = new THREE.DirectionalLight(0x7799cc, 0.0);
moon.castShadow = false;
scene.add(moon);
// A DirectionalLight shines from its position toward its TARGET, and an
// unparented target sits at the world origin. The sun adds and tracks its own
// (see scene.add(sun.target) plus the per-frame update); the moon never did —
// so while the moon's position was moved to follow the player each frame, the
// direction it actually lit from was still "toward 0,0,0", tens of thousands of
// units away across the map. Moonlight therefore raked the world at a wrong,
// near-constant angle instead of coming down from the moon, which is a large
// part of why a full-moon night read as black rather than "navigable".
scene.add(moon.target);

// Player local light source (lantern) for caves and night cycles.
// decay 0 — see placementLights: physical falloff kills legacy intensities.
const playerLight = new THREE.PointLight(0xffbbaa, 0.0, TILE * 10, 0);
scene.add(playerLight);

// ── Sky + dynamic environment ─────────────────────────────────────
// Replaces the flat clear colour AND the one-shot 64x256 gradient env map.
// The gradient above stays as a boot placeholder so materials have something
// to reflect during load; createSky disposes it on its first bake.
const sky = createSky({ THREE, renderer, scene, settings: QS });
const _sunDir = new THREE.Vector3();
// Sampled once per frame in updateEnvironmentCycle and read by the water
// shader in render3D, which runs after it.
const _envSunCol = new THREE.Color();
let _envDayF = 1;

// ── World edits (map editor / mob editor persistence) ────────────
// Three layers, applied in order BEFORE terrain/mesh building:
//   1. world_edits.json next to the game on the server (ships the
//      designed world to every player; optional file)
//   2. this browser's localStorage (the editor's autosave)
// Shape: { map:{"tx,ty":tileId}, spawns:[{id,t,x,y}], mobs:{type:{stat:val}},
//          tiles:[{id,name,color,blocking,boxH}],
//          customMobs:[{id,name,base,tint,scale,cave,stats}] }
const EDITS_KEY='bravoWorldEdits_v1';
const worldEdits={ map:{}, spawns:[], mobs:{}, tiles:[], customMobs:[], skins:{} };
function _mergeEdits(src){
  if(!src) return;
  Object.assign(worldEdits.map, src.map||{});
  for(const s of src.spawns||[]) if(!worldEdits.spawns.some(o=>o.id===s.id)) worldEdits.spawns.push(s);
  for(const [k,v] of Object.entries(src.mobs||{})) worldEdits.mobs[k]=Object.assign(worldEdits.mobs[k]||{},v);
  for(const t of src.tiles||[]) if(!worldEdits.tiles.some(o=>o.id===t.id)) worldEdits.tiles.push(t);
  for(const m of src.customMobs||[]) if(!worldEdits.customMobs.some(o=>o.id===m.id)) worldEdits.customMobs.push(m);
  Object.assign(worldEdits.skins, src.skins||{});
}
try{ _mergeEdits(await fetch('world_edits.json').then(r=>r.ok?r.json():null).catch(()=>null)); }catch(_){}
try{ _mergeEdits(JSON.parse(localStorage.getItem(EDITS_KEY)||'null')); }catch(_){}
function saveEdits(){ try{ localStorage.setItem(EDITS_KEY,JSON.stringify(worldEdits)); }catch(_){} }
// ── Pending-respawn tracker (avoids full-map scan every frame) ─────
const pendingRespawns = new Set();   // entries are "x,y" strings
// apply map tile overrides + mob stat overrides now
for(const [k,t] of Object.entries(worldEdits.map)){
  const [tx,ty]=k.split(',').map(Number);
  if(map[ty]&&map[ty][tx]!==undefined){
    map[ty][tx]=t; origTile[ty][tx]=t; respawnAt[ty][tx]=null;
    if(t===T.TREE)  resourceHp[ty][tx]=TREE_HP;
    if(t===T.STONE) resourceHp[ty][tx]=STONE_HP;
  }
}
for(const [type,vals] of Object.entries(worldEdits.mobs))
  if(ENEMY_CFG[type]) Object.assign(ENEMY_CFG[type], vals);

// ── Terrain texture (1 px per tile → canvas texture) ─────────────
const TILE_COLORS = {
  [T.GRASS]:        [79,122,58],  [T.PATH]:   [156,123,79], [T.WATER]:        [18,42,82],
  [T.TREE]:         [30,75,25],   [T.STONE]:  [111,106,99], [T.WALL]:         [138,127,110],
  [T.BRIDGE]:       [122,80,48],  [T.CAVE_FLOOR]:[26,20,18],[T.CAVE_WALL]:    [13,12,11],
  [T.CAVE_ENTRANCE]:[96,78,52],   [T.TELEPORT]:[120,80,200],  [T.STAINED_GLASS]:[142,34,48],
  // ORE_IRON had no entry, so every lookup hit the [0,0,0] fallback — a black
  // dot on the minimap. Matches ironMesh's 0x6a564d.
  [T.ORE_IRON]:     [106,86,77],
  // Saltmere coast. SHALLOWS is deliberately much lighter than WATER: it is the
  // colour you see THROUGH the water surface, and the surface shader is drawn
  // over it, so painting it near-WATER made the wadeable strip indistinguishable
  // from the drop-off and there was no visual cue for where you could walk.
  [T.SAND]:         [201,178,133], [T.SHALLOWS]: [86,128,146],
  [T.DOCK]:         [122,80,48],   [T.CLIFF]:    [124,116,104],
};

// Custom tiles (world editor): ids >= 100. Register their ground color,
// blocking, and 3D box lookup before the terrain canvas is built.
const customTileDefs={};
// Declared up here (populated much later by the skin loader) so the warp helpers
// below can ask whether a tile carries custom pixel art — those must not warp.
const groundStamps={};                 // tileId → TERR_PX canvas
function registerCustomTile(def){
  customTileDefs[def.id]=def;
  TILE_COLORS[def.id]=def.color;
  if(def.blocking) extraBlocking.add(def.id); else extraBlocking.delete(def.id);
}
for(const ct of worldEdits.tiles) registerCustomTile(ct);
// Pixels per tile — higher = sharper terrain texture.
//
// ⚠ THIS IS NOT A FREE CONSTANT. The ENTIRE map is one canvas, MAP_W*TERR_PX by
// MAP_H*TERR_PX, uploaded as a single texture. At 8 that is 3840 x 4432 and
// ~65 MB of VRAM, and nothing ever checked it against the hardware: the limit
// was read in _dev.gpu() and acted on nowhere. WebGL1-era GPUs and plenty of
// phones cap MAX_TEXTURE_SIZE at 4096 — and 4432 is ALREADY over that, so on
// those devices the upload fails and the ground comes back blank or black, with
// no error that points at the texture.
//
// So it is chosen at boot instead of assumed: start at 8 and halve until the
// canvas fits. That trades sharpness on exactly the devices that could not
// display the sharp version at all. Everything downstream derives its
// coordinates from TERR_PX, so nothing else has to know.
const TERR_PX = (() => {
  const max = renderer.capabilities.maxTextureSize || 4096;
  let px = 8;
  while (px > 1 && (MAP_W * px > max || MAP_H * px > max)) px >>= 1;
  if (px !== 8)
    console.warn('[gfx] terrain texture reduced to ' + px + 'px/tile: MAX_TEXTURE_SIZE is ' +
                 max + ', so the full-detail ' + (MAP_W*8) + 'x' + (MAP_H*8) + ' canvas would not upload.');
  return px;
})();
// ⚠ TERRAIN_MAP_H, NOT MAP_H. This canvas covers the overworld and the dungeon
// only. Regions added below that band bring their own surface (see
// ensureCoastSurface) precisely so this texture never grows again — it is
// already ~65 MB and already larger than some devices can upload.
const terrCanvas = document.createElement('canvas');
terrCanvas.width = MAP_W * TERR_PX; terrCanvas.height = TERRAIN_MAP_H * TERR_PX;
const terrCtx = terrCanvas.getContext('2d');

// A ground SURFACE: a canvas, plus the tile rect it covers. The shared one
// covers the overworld and the dungeon; see ensureCoastSurface for the other.
const _mainSurface = { ctx: terrCtx, tx0: 0, ty0: 0,
                       tx1: MAP_W - 1, ty1: TERRAIN_MAP_H - 1, tex: null, mesh: null };

// Seeded noise for stable per-pixel terrain variation
function _terrNoise(x, y) { let n=(x*374761393+y*668265263)^((x^y)*1274126177); n=(n^(n>>>15))*2246822519; n=(n^(n>>>13))*3266489917; return ((n^(n>>>16))>>>0)/4294967296; }
// Same hash, raw. The bake needs two decorrelated values per pixel; taking the
// two 16-bit halves of one hash costs half what two _terrNoise calls do.
function _terrHash32(x, y){ let n=(x*374761393+y*668265263)^((x^y)*1274126177); n=(n^(n>>>15))*2246822519; n=(n^(n>>>13))*3266489917; return (n^(n>>>16))>>>0; }

// Flat RGB palette indexed by tile id. TILE_COLORS is a numeric-keyed object, so
// V8 runs it in dictionary mode — fine for the odd lookup, but the bake does
// millions. Rebuilt before each bake since custom tiles and skins can add entries.
// The ground canvas paints the BED under water, not water. The water surface is
// its own lit, transparent mesh drawn on top, and wherever its coverage mask
// falls short of the painted contour -- which it always does a little, because
// the mask is built from a blurred field that erodes inward at every bank --
// whatever is underneath shows through. Painted the water's own blue, that
// leftover read as a vivid cobalt collar around every pool; painted as bed, it
// reads as the wet gravel you would expect at a waterline, and it agrees with
// what the water shader thinks it is refracting.
//
// TILE_COLORS keeps its blue, so the minimap is unchanged -- the same split
// documented above GROUND_TILE, where the minimap wants a symbol and the ground
// wants a material.
const GROUND_WATER_RGB = [72, 64, 52];
// The same argument applies to SHALLOWS, and it is easy to miss because the
// tile is a different colour on the minimap. The water surface covers shallows
// too (see _isWaterTile), so painting the ground under it the shallows' own
// blue would stack blue on blue and put the exact cobalt fringe described above
// along every beach — the one place in the game where the waterline is the
// thing you are looking at. This is wet sand: the SAND colour pulled toward the
// bed, so the beach darkens as it goes under rather than changing hue.
const GROUND_SHALLOWS_RGB = [138, 129, 105];
let _pal=new Uint8Array(3);
function _buildPalette(){
  let max=0; for(const k in TILE_COLORS){ const n=+k; if(n>max) max=n; }
  _pal=new Uint8Array((max+1)*3);
  for(const k in TILE_COLORS){ const n=+k, c=TILE_COLORS[k]; if(!c) continue;
    _pal[n*3]=c[0]; _pal[n*3+1]=c[1]; _pal[n*3+2]=c[2]; }
  const w=T.WATER*3;
  _pal[w]=GROUND_WATER_RGB[0]; _pal[w+1]=GROUND_WATER_RGB[1]; _pal[w+2]=GROUND_WATER_RGB[2];
  const sh=T.SHALLOWS*3;
  _pal[sh]=GROUND_SHALLOWS_RGB[0]; _pal[sh+1]=GROUND_SHALLOWS_RGB[1]; _pal[sh+2]=GROUND_SHALLOWS_RGB[2];
}

// ── Organic tile boundaries (kills the "Minecraft" stair-stepping) ─────
// The world is a tile grid, so every path edge and river bank is a run of
// axis-aligned 90° steps. Rather than paint tile squares, we displace the
// *lookup*: each output pixel asks which tile sits at its own position pushed a
// fraction of a tile by a smooth noise field. Straight runs become wandering
// edges and the stair-step corners dissolve. The water mask samples the same
// field, so a river's painted bank and its 3D surface agree exactly.
//
// ── What colour is the GROUND under each tile? ────────────────────
// TILE_COLORS does double duty: it drives the minimap (where a green blob for a
// tree is exactly right) and it drove the 3D ground canvas (where it is not).
// An obstacle's mesh doesn't cover its whole tile, so its tile colour showed
// around the base as a hard square — a dark-green square under every tree, grey
// under every boulder, and near-black under iron ore, which has no TILE_COLORS
// entry at all and fell through to [0,0,0].
//
// A tree stands ON grass. So the canvas paints what *surrounds* the obstacle:
// a multi-source BFS out from every walkable tile fills each obstacle tile with
// its nearest ground type. TILE_COLORS is left alone, so the minimap is unchanged.
//
// This also frees the warp. Previously structural tiles were excluded from it so
// wall colour couldn't smear into grass — but now no tile carries a structural
// colour on the ground at all, so boundaries can bend everywhere and obstacles
// no longer punch square holes in the terrain.
// Tiles whose own colour is painted on the ground. Everything else takes the
// colour of its NEAREST ground tile, so no obstacle leaves a square under it.
// SAND/SHALLOWS/DOCK are ground; CLIFF is an obstacle and is deliberately not
// here (and not in FULL_COVER either) — ground shows around its base exactly as
// it does around a boulder.
const GROUND_TILE = new Set([T.GRASS, T.PATH, T.WATER, T.BRIDGE, T.CAVE_FLOOR,
                             T.CAVE_ENTRANCE, T.TELEPORT,
                             T.SAND, T.SHALLOWS, T.DOCK]);
function _isGroundType(t){
  if(GROUND_TILE.has(t)) return true;
  const d = customTileDefs[t];
  return !!(d && !d.blocking);          // custom walkable tiles behave like ground
}
// Tiles whose 3D mesh completely hides the ground beneath them.
const FULL_COVER = new Set([T.WALL, T.CAVE_WALL, T.STAINED_GLASS]);
function _isFullCover(t){
  if(FULL_COVER.has(t)) return true;
  const d=customTileDefs[t];
  return !!(d && d.blocking && d.boxH);   // custom obstacle boxes fill their tile too
}
const _NO_GROUND = 65535;
let groundUnder = null;                 // Uint16Array, one ground tile id per map tile
// Cached for the whole map. The answer depends only on groundUnder, which
// changes when the terrain is edited and at no other time — but the grass field
// is re-laid every few tiles of movement, and each re-lay was asking the
// question twice per tile over a 5x5 neighbourhood: ~5.5 million reads to
// recompute something that had not changed since boot.
//
// Declared HERE, above buildGroundUnder, because that runs during module load
// and clears this. A `let` declared further down would be in the temporal dead
// zone at that moment and throw before the world ever drew.
let _grassClassMap = null;
function buildGroundUnder(){
  const N = MAP_W*MAP_H;
  const g = new Uint16Array(N).fill(_NO_GROUND);
  const q = new Int32Array(N); let qh=0, qt=0;
  for(let y=0;y<MAP_H;y++) for(let x=0;x<MAP_W;x++){
    const t=map[y][x];
    if(_isGroundType(t)){ const i=y*MAP_W+x; g[i]=t; q[qt++]=i; }
  }
  if(qt===0){ g.fill(T.GRASS); groundUnder=g; _grassClassMap=null; return; }   // no ground anywhere → grass
  while(qh<qt){                                            // multi-source BFS = nearest ground
    const i=q[qh++], x=i%MAP_W, y=(i/MAP_W)|0, v=g[i];
    if(x>0)        { const j=i-1;     if(g[j]===_NO_GROUND){ g[j]=v; q[qt++]=j; } }
    if(x<MAP_W-1)  { const j=i+1;     if(g[j]===_NO_GROUND){ g[j]=v; q[qt++]=j; } }
    if(y>0)        { const j=i-MAP_W; if(g[j]===_NO_GROUND){ g[j]=v; q[qt++]=j; } }
    if(y<MAP_H-1)  { const j=i+MAP_W; if(g[j]===_NO_GROUND){ g[j]=v; q[qt++]=j; } }
  }
  groundUnder=g;
  _grassClassMap = null;      // derived from groundUnder — see _grassClassAt
}
// Two octaves: a broad one that gives a river its lazy meander, and a tighter one
// that keeps the bank from looking like a smooth spline. A single octave reads as
// a uniform ripple — recognisably procedural.
// Raised from 0.55/0.34/0.10. At those values the displacement was under one
// tile, which is not enough to disguise the grid on something as narrow and as
// relentlessly axis-aligned as a path: the edge wandered, but in long straight
// runs joined by right angles. These push the reach to two tiles, so a path
// meanders rather than steps.
//
// The cost is the terrain bake, and it was measured rather than assumed: the
// reach going from 1 to 2 widens the interior fast-path check from 3x3 to 5x5,
// and a full rebake went 686ms -> 789ms. That is once, at boot.
let WARP_CELL_C = 9, WARP_AMP_C = 0.85;   // broad meander:  cell size (tiles), amplitude (tiles)
let WARP_CELL_F = 3, WARP_AMP_F = 0.52;   // fine wander
let WARP_HASH   = 0.14;                   // per-pixel raggedness, in tiles
// WARP_R is the furthest a lookup can travel, in tiles: ceil(sum of amplitudes).
// The interior fast path checks a (2*WARP_R+1)² neighbourhood, so this MUST stay
// >= the real reach or interiors would be misclassified and boundaries would clip.
let WARP_R = 2;
function _mkWarpGrid(salt, cell){
  const w = Math.ceil(MAP_W/cell)+4, h = Math.ceil(MAP_H/cell)+4;
  const g = new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) g[y*w+x] = _terrNoise(x+salt*7919, y+salt*104729);
  return {g,w,h,cell};
}
let _wgCX, _wgCY, _wgFX, _wgFY;
// The smooth part of the warp varies over 3+ tiles, so evaluating it per pixel
// (64× per tile at TERR_PX=8) was pure waste and dominated the bake. Resolve it
// once per tile corner and bilerp; the per-pixel hash still supplies the fine
// raggedness, which is the only part that genuinely needs pixel resolution.
// Bilerp can't exceed its corner values, so the WARP_R reach bound still holds.
let _wdX=null, _wdY=null, _wdW=0;
function _buildWarpOffsetGrid(){
  const w=MAP_W+1, h=MAP_H+1;
  _wdW=w; _wdX=new Float32Array(w*h); _wdY=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=y*w+x;
    _wdX[i]=_warpSample(_wgCX,x,y)*2*WARP_AMP_C + _warpSample(_wgFX,x,y)*2*WARP_AMP_F;
    _wdY[i]=_warpSample(_wgCY,x,y)*2*WARP_AMP_C + _warpSample(_wgFY,x,y)*2*WARP_AMP_F;
  }
}
function _buildWarpGrids(){
  _wgCX=_mkWarpGrid(1,WARP_CELL_C); _wgCY=_mkWarpGrid(2,WARP_CELL_C);
  _wgFX=_mkWarpGrid(3,WARP_CELL_F); _wgFY=_mkWarpGrid(4,WARP_CELL_F);
  WARP_R = Math.max(1, Math.ceil(WARP_AMP_C+WARP_AMP_F+WARP_HASH));
  _buildWarpOffsetGrid();
}
_buildWarpGrids();
function _warpSample(G, fx, fy){         // fx,fy in tiles; smoothstep bilinear
  const x=fx/G.cell+1, y=fy/G.cell+1;
  const x0=x|0, y0=y|0, ax=x-x0, ay=y-y0;
  const sx=ax*ax*(3-2*ax), sy=ay*ay*(3-2*ay);
  const g=G.g, i0=y0*G.w+x0, i1=i0+G.w;
  const a=g[i0]+(g[i0+1]-g[i0])*sx, b=g[i1]+(g[i1+1]-g[i1])*sx;
  return a+(b-a)*sy - 0.5;               // centred on 0
}
// Ground type at (fx,fy) in tile units, displaced by the warp field. Reads
// groundUnder, not map, so a boundary bends straight through trees and boulders
// instead of stopping dead at them. `g0` is the unwarped ground type, used as the
// fallback when the warp would land on custom pixel art (which must stay crisp).
// px,py are canvas pixel coords, used only for the fine per-pixel raggedness.
const _wOff=[0,0];
function _warpOffset(fx, fy, px, py){
  let x0=fx|0, y0=fy|0;
  if(x0<0)x0=0; else if(x0>MAP_W-1)x0=MAP_W-1;
  if(y0<0)y0=0; else if(y0>MAP_H-1)y0=MAP_H-1;
  const ax=fx-x0, ay=fy-y0, i0=y0*_wdW+x0, i1=i0+_wdW;
  const a0=_wdX[i0], a1=_wdX[i0+1], a2=_wdX[i1], a3=_wdX[i1+1];
  const b0=_wdY[i0], b1=_wdY[i0+1], b2=_wdY[i1], b3=_wdY[i1+1];
  const dx0=a0+(a1-a0)*ax, dx1=a2+(a3-a2)*ax;
  const dy0=b0+(b1-b0)*ax, dy1=b2+(b3-b2)*ax;
  const n=_terrHash32(px,py);                        // one hash, two halves
  _wOff[0] = dx0+(dx1-dx0)*ay + ((n&0xffff)/65536-0.5)*2*WARP_HASH;
  _wOff[1] = dy0+(dy1-dy0)*ay + ((n>>>16)/65536-0.5)*2*WARP_HASH;
  return _wOff;
}
function _warpedTileAt(fx, fy, px, py, g0){
  const o = _warpOffset(fx,fy,px,py), dx=o[0], dy=o[1];
  let tx = Math.floor(fx+dx), ty = Math.floor(fy+dy);
  if(tx<0) tx=0; else if(tx>=MAP_W) tx=MAP_W-1;
  if(ty<0) ty=0; else if(ty>=MAP_H) ty=MAP_H-1;
  const g = groundUnder[ty*MAP_W+tx];
  return groundStamps[g] ? g0 : g;      // never warp into custom pixel art
}
// True when a warped lookup anywhere inside this tile is guaranteed to return g0
// — i.e. the whole reachable neighbourhood shares one ground type. Lets the bulk
// of the map take a flat fill and skip the warp entirely.
function _tileIsInterior(tx, ty, g0){
  // A wall's mesh covers its whole tile, so no ground shows and it can take the
  // flat fill whatever surrounds it. That matters for speed: the nearest-ground
  // BFS partitions solid rock into Voronoi regions, and the seams between them
  // run through the middle of the dungeon's stone — invisible, but they'd
  // otherwise be treated as boundaries and cost the full per-pixel warp.
  // Trees/rocks/ore are deliberately NOT full-cover: ground shows around them,
  // which is the entire reason groundUnder exists.
  if(_isFullCover(map[ty][tx])) return true;
  if(tx<WARP_R || ty<WARP_R || tx>=MAP_W-WARP_R || ty>=MAP_H-WARP_R) return false;  // border → slow path
  for(let oy=-WARP_R; oy<=WARP_R; oy++){
    const row=(ty+oy)*MAP_W;
    for(let ox=-WARP_R; ox<=WARP_R; ox++) if(groundUnder[row+tx+ox]!==g0) return false;
  }
  return true;
}

// Repaint a tile rect of the ground. Region-capable so an editor edit repaints a
// 3×3 patch (its own tile plus the neighbours whose warp it changes) instead of
// stamping a hard square into terrain that everything around it has bent.
// `surface` says WHICH canvas to paint into and where its origin sits in tile
// space. It defaults to the shared overworld+dungeon surface, so every existing
// caller is unchanged. A region with its own ground passes its own.
//
// ⚠ gx/gy stay GLOBAL tile-pixel coordinates inside the loop even when the
// target canvas starts elsewhere. The noise and the warp are both functions of
// those coordinates, so making them surface-local would give the coast a
// different grain from the mainland at the same world position — and would make
// an edit near a surface boundary repaint one side with a different pattern.
// Only the destination offset is surface-relative.
function paintTerrainRegion(tx0, ty0, tx1, ty1, surface) {
  const sf = surface || _mainSurface;
  tx0=Math.max(sf.tx0,tx0); ty0=Math.max(sf.ty0,ty0);
  tx1=Math.min(sf.tx1,tx1); ty1=Math.min(sf.ty1,ty1);
  if(tx1<tx0||ty1<ty0) return;
  _buildPalette();                     // custom tiles / skins can have added colours
  const W=(tx1-tx0+1)*TERR_PX, H=(ty1-ty0+1)*TERR_PX;
  const tctx = sf.ctx;
  const img = tctx.createImageData(W,H), d = img.data;
  const ox=tx0*TERR_PX, oy=ty0*TERR_PX;
  const dox=(tx0-sf.tx0)*TERR_PX, doy=(ty0-sf.ty0)*TERR_PX;
  const stamped=[];                    // drawn after putImageData, which would overwrite them
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    // Paint the GROUND here, not the tile — an obstacle tile takes the colour of
    // whatever surrounds it, so no square shows around a trunk or a boulder.
    const g0 = groundUnder[ty*MAP_W+tx];
    if (groundStamps[g0]) { stamped.push([tx,ty,g0]); continue; }   // custom art: verbatim, never warped
    const p0=g0*3, br=_pal[p0], bg=_pal[p0+1], bb=_pal[p0+2];
    const isWater0 = g0===T.WATER||g0===T.BRIDGE||g0===T.SHALLOWS;
    // Interior tiles can't be changed by the warp, so skip it for the bulk of
    // the map and only pay for the boundary pixels that actually bend.
    const interior = _tileIsInterior(tx, ty, g0);
    for (let py = 0; py < TERR_PX; py++) for (let px = 0; px < TERR_PX; px++) {
      const gx = tx*TERR_PX+px, gy = ty*TERR_PX+py;    // global — keeps the noise stable
      let cr=br, cg=bg, cb=bb, isWater=isWater0;
      if(!interior){
        const t = _warpedTileAt(gx/TERR_PX, gy/TERR_PX, gx, gy, g0);
        if(t!==g0){ const p=t*3; cr=_pal[p]; cg=_pal[p+1]; cb=_pal[p+2]; isWater = t===T.WATER||t===T.BRIDGE||t===T.SHALLOWS; }
      }
      // Water used to be exempt so the sheet stayed flat and read as water.
      // It is a riverbed now, and a bed wants grain like every other surface.
      const noise = (_terrNoise(gx, gy) - 0.5) * (isWater ? 10 : 18);
      const i = ((gy-oy)*W + (gx-ox)) * 4;
      let v;
      v=cr+noise; d[i]  = v<0?0:v>255?255:v;
      v=cg+noise; d[i+1]= v<0?0:v>255?255:v;
      v=cb+noise; d[i+2]= v<0?0:v>255?255:v;
      d[i+3] = 255;   // createImageData is transparent black — without this the whole ground samples as black
    }
  }
  tctx.putImageData(img, dox, doy);
  if(stamped.length){
    tctx.imageSmoothingEnabled=false;
    for(const [tx,ty,t0] of stamped)
      tctx.drawImage(groundStamps[t0], (tx-sf.tx0)*TERR_PX, (ty-sf.ty0)*TERR_PX);
  }
}
// The shared surface only. Regions below TERRAIN_MAP_H paint themselves when
// they are first entered.
function buildTerrainImage(){ paintTerrainRegion(0,0,MAP_W-1,TERRAIN_MAP_H-1,_mainSurface); }
// ── Widen the rivers ──────────────────────────────────────────────
// Done on the TILE MAP, and before the ground bake, so it lands ahead of every
// consumer. Widening the render mask instead only stretches the painted
// silhouette: water gets drawn over tiles the game still calls grass, so you
// sprint through the shallows at full speed and grass grows up through the
// river. The terrain bake, the coverage mask, riverDepth, wadeableAt, grass
// placement and the minimap all read `map`, so doing it here keeps them in
// agreement by construction.
//
// Only GRASS and PATH flood. Walls, trees, ore, bridges and cave mouths are
// left alone — a river that swallows a bridge is worse than a narrow one — and
// the city and dungeon strip are excluded outright.
const RIVER_WIDEN_R = 3;      // tiles added to each bank (~6 tiles wider overall)
{
  const src = [];
  for(let ty = 0; ty < MAP_H; ty++) src.push(map[ty].slice());
  const floodable = new Set([T.GRASS, T.PATH]);
  let widened = 0;
  for(let ty = 0; ty < MAP_H; ty++){
    if(ty >= DUNGEON_Y0 - 6) continue;
    for(let tx = 0; tx < MAP_W; tx++){
      if(!floodable.has(src[ty][tx])) continue;
      if(tx >= CITY.x1-2 && tx <= CITY.x2+2 && ty >= CITY.y1-2 && ty <= CITY.y2+2) continue;
      let near = false;
      for(let oy = -RIVER_WIDEN_R; oy <= RIVER_WIDEN_R && !near; oy++){
        const row = src[ty+oy]; if(!row) continue;
        for(let ox = -RIVER_WIDEN_R; ox <= RIVER_WIDEN_R; ox++){
          // Circular, not square: a square kernel bulges at the corners and
          // leaves the river visibly octagonal.
          if(ox*ox + oy*oy > RIVER_WIDEN_R*RIVER_WIDEN_R) continue;
          if(row[tx+ox] === T.WATER){ near = true; break; }
        }
      }
      if(near){ map[ty][tx] = T.WATER; widened++; }
    }
  }
  console.log('[world] rivers widened by', RIVER_WIDEN_R, 'tiles —', widened, 'tiles flooded');
}

buildGroundUnder();          // must precede the first bake — the painter reads it
buildTerrainImage();

const terrTex = new THREE.CanvasTexture(terrCanvas);
terrTex.magFilter = THREE.LinearFilter;
terrTex.minFilter = THREE.LinearMipMapLinearFilter;
terrTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
// _mainSurface is declared before this texture exists, so it is wired up here.
// Every surface must carry its own texture: code that walks surfaces and marks
// `sf.tex` dirty would otherwise silently do nothing for the overworld.
_mainSurface.tex = terrTex;

// Standard, not Lambert. The ground was the single largest surface in the game
// and the only one still excluded from image-based lighting — walls, rocks and
// trees all moved to Standard when the env map landed, and the terrain not
// matching is why the ground read as flat paint next to lit masonry.
// applyEnvIntensity() only walks isMeshStandardMaterial, so this also enrols
// the terrain in the day/night IBL fade for free.
// ── Height field ──────────────────────────────────────────────────
// Elevation is a purely VISUAL displacement. Collision, `boxBlocked`, the
// server's walkB64 walkability bitmap and every multiplayer position check stay
// strictly 2D and are untouched — the field is deterministic from a fixed seed,
// so two clients derive identical ground without syncing anything.
//
// Which tiles must stay flat, and why:
//   * water/bridge — the river is one flat quad at y=2. Slope under it and the
//     plane clips through its own banks.
//   * the city — buildings are axis-aligned boxes; on a slope they hover at one
//     corner and bury the opposite one.
//   * caves and the dungeon strip — interiors, and their floors are drawn flat.
// Each fades out over a few tiles so the boundary reads as a valley or a
// plateau rather than a terrace.
const FLAT_R = 3, CITY_MARGIN = 7;
const _flatSet = new Set([T.WATER, T.BRIDGE, T.CAVE_FLOOR, T.CAVE_ENTRANCE, T.CAVE_WALL,
                          T.SHALLOWS, T.DOCK]);
function terrainFlatAt(tx, ty){
  if(ty >= DUNGEON_Y0 - 6) return 0;                       // dungeon strip
  if(tx >= CITY.x1-CITY_MARGIN && tx <= CITY.x2+CITY_MARGIN &&
     ty >= CITY.y1-CITY_MARGIN && ty <= CITY.y2+CITY_MARGIN){
    const dx = Math.max(0, CITY.x1-tx, tx-CITY.x2);
    const dy = Math.max(0, CITY.y1-ty, ty-CITY.y2);
    const d  = Math.max(dx, dy);
    if(d === 0) return 0;
    return Math.min(1, d / CITY_MARGIN);
  }
  let near = Infinity;
  for(let oy = -FLAT_R; oy <= FLAT_R; oy++){
    const row = map[ty+oy]; if(!row) continue;
    for(let ox = -FLAT_R; ox <= FLAT_R; ox++){
      if(_flatSet.has(row[tx+ox])){
        const d = Math.max(Math.abs(ox), Math.abs(oy));
        if(d < near) near = d;
      }
    }
  }
  return near <= FLAT_R ? Math.min(1, (near / FLAT_R) * 0.92) : 1;
}
// 96 over a 46-tile wavelength produced gradients so gentle the surface normal
// never left vertical — the ground moved but read as flat, and the slope-based
// rock blending never triggered anywhere. Relief is amplitude ÷ wavelength, so
// both had to change together.
const TERRAIN_AMP = 210;
// How deep the bed is cut at this tile: 0 at the bank, rising toward mid-river.
// Distance to the nearest NON-water tile, which is the same "distance from
// bank" idea the coverage mask uses, so the carved bed and the painted
// silhouette agree by construction.
const RIVER_MAX_DEPTH = 130;  // world units below the surface at the deepest
function riverDepth(tx, ty){
  const here = map[ty] && map[ty][tx];
  if(here !== T.WATER) return 0;
  let dry = Infinity;
  const R = 5;
  for(let oy = -R; oy <= R; oy++){
    const row = map[ty+oy];
    for(let ox = -R; ox <= R; ox++){
      const t = row ? row[tx+ox] : undefined;
      if(t === undefined || (t !== T.WATER && t !== T.BRIDGE)){
        const d = Math.max(Math.abs(ox), Math.abs(oy));
        if(d < dry) dry = d;
      }
    }
  }
  if(!isFinite(dry)) dry = R;
  // Smoothstep so the bed shelves in rather than cratering.
  // Divisor tuned to the map's actual rivers. `dry` is a Chebyshev distance,
  // so a channel that is wide in x but only 2-3 tiles in y still reports 1-2 —
  // dividing by 4 left every river a uniform 9 units deep, too shallow to wade
  // in let alone drown. At 2.5 a narrow crossing is wadeable and a broad one
  // goes over your head.
  const u = Math.min(1, dry / 2.5);
  return RIVER_MAX_DEPTH * (u*u*(3-2*u));
}
const terrain = createHeightField({
  TILE, MAP_W, MAP_H, amplitude: TERRAIN_AMP, seed: 0x8EAD10,
  flatAt: terrainFlatAt,
  bedAt: riverDepth,
});
const heightAt = terrain.heightAt;

// ── Water depth & wading ──────────────────────────────────────────
// The water plane sits at y=2 and the bed is carved below it, so depth is just
// the difference. One source of truth for the visual surface, the wade speed
// and the drowning check.
const WATER_SURFACE_Y = 2;
const WADE_KNEE = 26;        // shallows: barely slows you
const WADE_HEAD = 62;        // above this the head goes under
const DROWN_TICK_SEC = 1.0;
const DROWN_TICKS = 5;       // ticks of damage before it kills
const DROWN_FRAC = 0.14;     // fraction of max HP per tick
function waterDepthAt(wx, wz){
  const tx = Math.floor(wx/TILE), ty = Math.floor(wz/TILE);
  const t = map[ty] && map[ty][tx];
  if(t !== T.WATER) return 0;
  return Math.max(0, WATER_SURFACE_Y - heightAt(wx, wz));
}
// True where the player may wade through what boxBlocked calls solid.
//
// ⚠ RIVERS ONLY. This was written when every T.WATER tile in the game was a
// river a few tiles wide, where wading across is the point. The Saltmere coast
// reuses T.WATER for open SEA, and the coast is flat — terrainFlatAt returns 0
// for everything at ty >= DUNGEON_Y0-6, so riverDepth never carves a bed there
// and the drowning check can never fire. Left as it was, you could stroll off
// the beach and keep walking to the edge of the ocean, which makes the boat
// pointless. SHALLOWS is the wadeable water on the coast; deep water is not.
function wadeableAt(wx, wz){
  const tx = Math.floor(wx/TILE), ty = Math.floor(wz/TILE);
  const t = map[ty] && map[ty][tx];
  if(t === T.SHALLOWS) return true;
  return t === T.WATER && ty < COAST_Y0;
}

// One segment per 2 tiles. The broad swells have a ~46-tile wavelength, so this
// is far finer than the signal; going per-tile would quadruple the vertex count
// for detail the height field doesn't contain.
// ⚠ TERRAIN_MAP_H again: the mesh must match the canvas it is textured with, or
// the UVs stretch the whole map. It stops where the shared texture stops.
const terrMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(MAP_W * TILE, TERRAIN_MAP_H * TILE, MAP_W >> 1, TERRAIN_MAP_H >> 1),
  new THREE.MeshStandardMaterial({ map: terrTex, roughness: 0.97, metalness: 0.0 })
);
terrMesh.rotation.x = -Math.PI / 2;
terrMesh.position.set(MAP_W*TILE/2, 0, TERRAIN_MAP_H*TILE/2);
terrain.displacePlane(terrMesh.geometry, MAP_W*TILE/2, TERRAIN_MAP_H*TILE/2);
terrMesh.receiveShadow = true;
scene.add(terrMesh);

// ── The Saltmere coast's ground ─────────────────────────────────────────────
//
// Its own canvas and its own mesh, 1600 x 960 — about 6 MB against the shared
// surface's 65 MB — and neither exists until somebody sails there. That is the
// whole reason the region did not simply extend MAP_H: the shared texture is
// one upload for every player on every device, and it is already too large for
// the 4096 cap that older phones report. A region nobody has visited should
// cost nothing, and this one costs nothing.
//
// Built once and KEPT, rather than disposed on leaving. Re-baking 24 000 tiles
// every trip to save 6 MB is the wrong trade — the bake is the expensive half,
// not the memory.
let coastSurface = null;
function ensureCoastSurface(){
  if(coastSurface) return coastSurface;
  const cv = document.createElement('canvas');
  cv.width = COAST_W * TERR_PX; cv.height = COAST_H * TERR_PX;
  coastSurface = { ctx: cv.getContext('2d'), canvas: cv,
                   tx0: COAST_X0, ty0: COAST_Y0,
                   tx1: COAST_X0 + COAST_W - 1, ty1: COAST_Y0 + COAST_H - 1,
                   tex: null, mesh: null };
  const t0 = performance.now();
  paintTerrainRegion(coastSurface.tx0, coastSurface.ty0, coastSurface.tx1, coastSurface.ty1, coastSurface);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  coastSurface.tex = tex;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(COAST_W * TILE, COAST_H * TILE, COAST_W >> 1, COAST_H >> 1),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.97, metalness: 0.0 })
  );
  mesh.rotation.x = -Math.PI / 2;
  const cx = (COAST_X0 + COAST_W / 2) * TILE, cz = (COAST_Y0 + COAST_H / 2) * TILE;
  mesh.position.set(cx, 0, cz);
  terrain.displacePlane(mesh.geometry, cx, cz);
  mesh.receiveShadow = true;
  coastSurface.mesh = mesh;
  scene.add(mesh);
  console.log('[world] Saltmere ground built: ' + cv.width + 'x' + cv.height +
              ' (' + ((cv.width*cv.height*4)/1048576).toFixed(1) + ' MB) in ' +
              (performance.now()-t0).toFixed(0) + ' ms');
  return coastSurface;
}
// Which surface owns this tile — so an edit repaints the canvas it is actually
// drawn on. Returns null for tiles no surface covers (the band separators),
// where there is nothing to repaint.
// ⚠ KNOWN EDGE, deliberately not fixed. The warp lookup inside the painter
// samples groundUnder from neighbouring TILES, and it does not know about
// surface boundaries — so the coast's first row (ty 560) can pull a colour from
// the separator row above it, which belongs to no surface at all. Today that is
// invisible: the top 4-7 rows of the coast are CLIFF, the band is sealed, and
// no player can stand there to see the fringe. Making the warp surface-aware
// would mean threading the surface through _warpedTileAt and _tileIsInterior
// for a seam nobody can reach. WORTH REVISITING the day a region puts walkable
// ground hard against a band edge — that is when it becomes visible.
function _surfaceAt(tx, ty){
  if(ty >= COAST_Y0 && ty < COAST_Y0 + COAST_H && tx >= COAST_X0 && tx < COAST_X0 + COAST_W)
    return coastSurface;                       // null until it has been visited
  if(ty < TERRAIN_MAP_H) return _mainSurface;
  return null;
}

function updateTerrPx(tx, ty) {
  // Repaint the 3×3 block: the warp reaches one tile, so editing this tile also
  // changes where its neighbours' boundaries bend. Painting only (tx,ty) would
  // leave a hard square sitting in terrain that curves around it.
  // Placing or clearing an obstacle changes which ground shows under it, and the
  // nearest-ground fill is a BFS with no cheap local update — but it's only a
  // couple of ms over the whole map, so just re-derive it.
  buildGroundUnder();
  // ⚠ SKIP ONLY THE PAINT, NOT THE REST. _surfaceAt returns null for the band
  // separators and for a region whose surface has not been built yet — and an
  // early return here would take the water field and the mask with it, leaving
  // the water disagreeing with the tile map exactly as the river-widening note
  // above warns. There is no ground canvas to paint; everything else still has
  // to happen.
  const sf = _surfaceAt(tx, ty);
  if(sf) paintTerrainRegion(tx-WARP_R-1, ty-WARP_R-1, tx+WARP_R+1, ty+WARP_R+1, sf);
  // The mask reads through the blur field as well as the warp, so an edit
  // perturbs a wider patch — and the field itself has to be re-derived first.
  buildWaterField();
  const R = WARP_R + WFIELD_R + 2;
  paintWaterMask(tx-R, ty-R, tx+R, ty+R);
  wMaskTex.needsUpdate = true;
  if(sf && sf.tex) sf.tex.needsUpdate = true;
}

// ── Minimap canvas (exactly 1 px per tile, like the original 2D map) ──
// Keeping this separate from terrCanvas (which is TERR_PX px/tile) lets the
// minimap use tile-unit source coords for correct, undistorted sampling.
const miniCanvas = document.createElement('canvas');
miniCanvas.width = MAP_W; miniCanvas.height = MAP_H;
const miniCtx = miniCanvas.getContext('2d');
(function buildMiniImage(){
  const img = miniCtx.createImageData(MAP_W, MAP_H), d = img.data;
  for (let y=0;y<MAP_H;y++) for (let x=0;x<MAP_W;x++){
    const c = TILE_COLORS[map[y][x]] || [0,0,0], i=(y*MAP_W+x)*4;
    d[i]=c[0]; d[i+1]=c[1]; d[i+2]=c[2]; d[i+3]=255;
  }
  miniCtx.putImageData(img,0,0);
})();
function updateMiniPx(tx, ty){
  const c = TILE_COLORS[map[ty][tx]] || [0,0,0];
  miniCtx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  miniCtx.fillRect(tx, ty, 1, 1);
}

// ── Obstacle instanced meshes ─────────────────────────────────────
const _m4  = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _qId = new THREE.Quaternion();
const _sc1 = new THREE.Vector3(1,1,1);
const _q1  = new THREE.Quaternion();     // scratch: per-instance rotation
const _eul = new THREE.Euler();

// count initial tiles
let nWall=0, nTree=0, nStone=0, nCave=0;
for (let ty=0;ty<MAP_H;ty++) for (let tx=0;tx<MAP_W;tx++) {
  const t=map[ty][tx];
  if(t===T.WALL) nWall++; else if(t===T.TREE) nTree++;
  else if(t===T.STONE) nStone++; else if(t===T.CAVE_WALL) nCave++;
}

// ── Global object scale ───────────────────────────────────────────
// One knob that scales every visible object (hero, mobs, NPCs, trees,
// walls, rocks) without touching the tile grid, movement, or combat
// ranges. Bump this to make the whole world chunkier.
const OBJ_SCALE = 2;                 // 2× the previous sizes
const CHAR_H    = 63 * OBJ_SCALE;    // main character height (was 63u) → 126u
const TREE_H    = CHAR_H * 2;        // trees stand twice as tall as the hero → 252u

// Walls used to be 91u against a 126u character — you looked straight over
// every building, so the city read as a maze of low boxes. Now a storey and a
// half (168u), comfortably above head height. Player-placed walls share this,
// so a wall you build is actually a wall.
const WALL_H   = TILE * 1.75 * OBJ_SCALE;
const TRUNKH   = TREE_H * 0.42;      // trunk portion of the tree
const TOPH     = TREE_H * 0.58;      // canopy portion (trunk + canopy = TREE_H)
const STONE_R  = TILE * 0.28 * OBJ_SCALE;
// Dungeon walls were TILE*0.9*OBJ_SCALE = 86u — below the 126u character, so you
// looked straight over them and a cave read as floor pattern rather than rock.
// Same mistake the city walls had before they went to 168; now they share it.
const CAVEH    = WALL_H;

// ── Procedural obstacle textures (no asset files) ─────────────────
// Generated at 256² (was 64²) with fBm weathering, bevelled edges and a
// matching normal map derived from each texture's own luminance — so with
// scene.environment in play the stone actually catches light instead of
// reading as flat wallpaper.
const TEX_SIZE = 256;
function makeCanvasTex(w, h, draw) {
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  draw(c.getContext('2d'), w, h);
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.colorSpace=THREE.SRGBColorSpace;
  t.canvas=c;                        // kept so a normal map can be derived
  return t;
}
// Sobel the luminance into a tangent-space normal map. Cheap, runs once at
// boot, and gives every surface real relief under the directional lights.
function normalFromTex(tex, strength=2.2){
  const src=tex.canvas, w=src.width, h=src.height;
  const d=src.getContext('2d').getImageData(0,0,w,h).data;
  const lum=new Float32Array(w*h);
  for(let i=0;i<w*h;i++) lum[i]=(d[i*4]*0.299+d[i*4+1]*0.587+d[i*4+2]*0.114)/255;
  const at=(x,y)=>lum[((y%h)+h)%h*w+(((x%w)+w)%w)];
  const out=document.createElement('canvas'); out.width=w; out.height=h;
  const oc=out.getContext('2d'), img=oc.createImageData(w,h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const dx=(at(x-1,y)-at(x+1,y))*strength;
    const dy=(at(x,y-1)-at(x,y+1))*strength;
    const l=Math.hypot(dx,dy,1), i=(y*w+x)*4;
    img.data[i]=(dx/l*0.5+0.5)*255; img.data[i+1]=(dy/l*0.5+0.5)*255;
    img.data[i+2]=(1/l*0.5+0.5)*255; img.data[i+3]=255;
  }
  oc.putImageData(img,0,0);
  const t=new THREE.CanvasTexture(out);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  return t;
}
// Tiling value-noise / fBm — the organic variation the old flat fills lacked.
function _vnoise(x,y,per){ const xi=((x%per)+per)%per|0, yi=((y%per)+per)%per|0;
  return _terrNoise(xi*57+1, yi*131+7); }
function fbm(x,y,per,oct=4){
  let v=0,a=0.5,f=1;
  for(let o=0;o<oct;o++){
    const xf=x*f, yf=y*f, x0=Math.floor(xf), y0=Math.floor(yf);
    const fx=xf-x0, fy=yf-y0, sx=fx*fx*(3-2*fx), sy=fy*fy*(3-2*fy);
    const p=per*f;
    const n00=_vnoise(x0,y0,p), n10=_vnoise(x0+1,y0,p);
    const n01=_vnoise(x0,y0+1,p), n11=_vnoise(x0+1,y0+1,p);
    v += a*((n00*(1-sx)+n10*sx)*(1-sy) + (n01*(1-sx)+n11*sx)*sy);
    a*=0.5; f*=2;
  }
  return v;
}
// Paint tiling fBm over a canvas as translucent light/dark grain.
function grain(x,w,h,cells,amt,oct=4){
  const img=x.getImageData(0,0,w,h), d=img.data;
  for(let py=0;py<h;py++) for(let px=0;px<w;px++){
    const n=(fbm(px/w*cells, py/h*cells, cells, oct)-0.5)*2*amt;
    const i=(py*w+px)*4;
    d[i]=Math.max(0,Math.min(255,d[i]+n*255));
    d[i+1]=Math.max(0,Math.min(255,d[i+1]+n*255));
    d[i+2]=Math.max(0,Math.min(255,d[i+2]+n*255));
  }
  x.putImageData(img,0,0);
}
// Cut ashlar masonry for city/player walls. Bevelled block edges (bright top
// & left, shadowed bottom & right) are what make it read as carved stone
// rather than a painted grid.
const wallTex = makeCanvasTex(TEX_SIZE,TEX_SIZE,(x,w,h)=>{
  x.fillStyle='#3b352c'; x.fillRect(0,0,w,h);                 // deep mortar
  const rows=6, bh=h/rows;
  for(let r=0;r<rows;r++){
    // Irregular coursing: each row is split into 2-4 stones of differing
    // widths with a random phase, so no two rows line up. A rigid grid of
    // identical blocks is what made this read as tiling, not masonry.
    const seed=r*17.3;
    let bx=-fbm(seed,0,8,2)*70;
    const by=r*bh;
    while(bx<w+10){
      const bw=44+fbm(bx/23+seed,seed,8,2)*62;
      const tone=0.80+fbm(bx/17+seed*3, r*2.3, 8, 3)*0.42;
      // Warm limestone rather than cold grey, and every stone a different value
      const base=[132,120,99].map(v=>Math.max(0,Math.min(255,v*tone))|0);
      const inset=2.5, jx=(fbm(bx/9,seed,8,2)-0.5)*2;          // slight ragged edges
      x.fillStyle=`rgb(${base[0]},${base[1]},${base[2]})`;
      x.beginPath();
      x.moveTo(bx+inset+jx, by+inset);
      x.lineTo(bx+bw-inset+jx*0.5, by+inset+jx*0.6);
      x.lineTo(bx+bw-inset, by+bh-inset);
      x.lineTo(bx+inset-jx*0.4, by+bh-inset+jx*0.5);
      x.closePath(); x.fill();
      // Soft top light / bottom shade — a hint of relief, not a plastic bevel
      x.fillStyle='rgba(255,248,230,.085)';
      x.fillRect(bx+inset, by+inset, bw-inset*2, 2.2);
      x.fillStyle='rgba(0,0,0,.14)';
      x.fillRect(bx+inset, by+bh-inset-2.2, bw-inset*2, 2.2);
      // Occasional chipped corner so the silhouette isn't machine-perfect
      if(fbm(bx/31+seed,seed*2,8,2)>0.62){
        x.fillStyle='rgba(59,53,44,.75)';
        const cs=3+fbm(bx/7,seed,8,2)*5;
        x.beginPath(); x.moveTo(bx+bw-inset-cs,by+inset); x.lineTo(bx+bw-inset,by+inset);
        x.lineTo(bx+bw-inset,by+inset+cs); x.closePath(); x.fill();
      }
      bx+=bw;
    }
  }
  grain(x,w,h,9,0.075,4);
  grain(x,w,h,26,0.045,3);                                    // fine pitting
  for(let i=0;i<22;i++){                                      // damp streaks
    x.strokeStyle='rgba(44,38,30,'+(0.04+Math.random()*0.07).toFixed(2)+')';
    x.lineWidth=2+Math.random()*5; x.beginPath();
    const sx=Math.random()*w; x.moveTo(sx,0);
    x.bezierCurveTo(sx+9,h*0.4,sx-9,h*0.7,sx+(Math.random()-0.5)*14,h); x.stroke();
  }
});
// Rough dark stone for cave walls — clustered lumps, high contrast.
const caveTex = makeCanvasTex(TEX_SIZE,TEX_SIZE,(x,w,h)=>{
  x.fillStyle='#191510'; x.fillRect(0,0,w,h);
  for(let i=0;i<150;i++){
    const rx=Math.random()*w, ry=Math.random()*h, rr=6+Math.random()*26;
    const t=0.75+fbm(rx/13,ry/13,12,2)*0.6;
    x.fillStyle=`rgb(${(56*t)|0},${(47*t)|0},${(38*t)|0})`;
    x.beginPath(); x.ellipse(rx,ry,rr,rr*(0.55+Math.random()*0.4),Math.random()*3,0,Math.PI*2); x.fill();
    x.strokeStyle='rgba(0,0,0,.5)'; x.lineWidth=1.5; x.stroke();
    x.fillStyle='rgba(255,240,215,.07)';                       // top-lit lip
    x.beginPath(); x.ellipse(rx,ry-rr*0.22,rr*0.8,rr*0.28,0,0,Math.PI*2); x.fill();
  }
  grain(x,w,h,14,0.08);
});
// Weathered granite for mineable rocks — mottled, mineral speckle, cracks.
const rockTex = makeCanvasTex(TEX_SIZE,TEX_SIZE,(x,w,h)=>{
  x.fillStyle='#6e6961'; x.fillRect(0,0,w,h);
  grain(x,w,h,6,0.10,5);
  for(let i=0;i<1400;i++){                                     // quartz / mica flecks
    const v=Math.random(), s=1+Math.random()*3.5;
    x.fillStyle = v<0.42?'rgba(38,34,29,.30)' : v<0.72?'rgba(255,252,244,.16)' : 'rgba(120,112,100,.26)';
    x.fillRect(Math.random()*w,Math.random()*h,s,s);
  }
  x.lineCap='round';
  for(let i=0;i<9;i++){                                        // fissures, with a lit lower lip
    let px=Math.random()*w, py=Math.random()*h;
    const pts=[[px,py]];
    for(let s2=0;s2<6;s2++){ px+=(Math.random()-0.5)*70; py+=(Math.random()-0.5)*70; pts.push([px,py]); }
    x.strokeStyle='rgba(26,22,18,.55)'; x.lineWidth=1+Math.random()*2.5;
    x.beginPath(); x.moveTo(pts[0][0],pts[0][1]); for(const p of pts.slice(1)) x.lineTo(p[0],p[1]); x.stroke();
    x.strokeStyle='rgba(255,250,240,.10)'; x.lineWidth=1;
    x.beginPath(); x.moveTo(pts[0][0],pts[0][1]+1.5); for(const p of pts.slice(1)) x.lineTo(p[0],p[1]+1.5); x.stroke();
  }
});
// Keep these gentle. A strong normal map on a near-flat wall throws hard
// specular glints off every block edge, which is what made the first pass
// look like glazed bathroom tile rather than stone.
const wallNrm = normalFromTex(wallTex, 1.1);
const caveNrm = normalFromTex(caveTex, 1.6);
const rockNrm = normalFromTex(rockTex, 1.4);
// A wall box is 48 wide but 168 tall, so the 0-1 UV would stretch each course
// into a tall smear. Repeat vertically to keep the blocks roughly square
// (6 rows × 1.75 ≈ 10.5 courses over 168u ≈ 16u each, matching the 16u width).
for(const t of [wallTex, wallNrm]) t.repeat.set(1, 1.75);

// Bark — vertical fissured ridges. Trees were flat brown/green cylinders and
// cones with no texture at all, which is what made the forest read as plastic.
const barkTex = makeCanvasTex(128,256,(x,w,h)=>{
  x.fillStyle='#4a3220'; x.fillRect(0,0,w,h);
  for(let i=0;i<160;i++){                                   // ridges running with the grain
    const cx=Math.random()*w, wd=2+Math.random()*9;
    const t=0.62+fbm(cx/9,0,16,3)*0.75;
    x.fillStyle=`rgb(${(104*t)|0},${(72*t)|0},${(44*t)|0})`;
    x.beginPath(); x.moveTo(cx,0);
    let px=cx; for(let y=0;y<=h;y+=16){ px+=(Math.random()-0.5)*5; x.lineTo(px,y); }
    for(let y=h;y>=0;y-=16){ px+=(Math.random()-0.5)*3; x.lineTo(px+wd,y); }
    x.closePath(); x.fill();
  }
  grain(x,w,h,8,0.10,4);
  for(let i=0;i<40;i++){                                    // deep cracks
    x.strokeStyle='rgba(18,12,7,.5)'; x.lineWidth=1+Math.random()*2;
    let px=Math.random()*w; x.beginPath(); x.moveTo(px,0);
    for(let y=0;y<=h;y+=22){ px+=(Math.random()-0.5)*7; x.lineTo(px,y); } x.stroke();
  }
});
// Foliage — clumped needle masses so the canopy has depth instead of a flat cone.
const leafTex = makeCanvasTex(256,256,(x,w,h)=>{
  x.fillStyle='#24471f'; x.fillRect(0,0,w,h);
  for(let i=0;i<520;i++){
    const cx=Math.random()*w, cy=Math.random()*h, r=5+Math.random()*17;
    const t=0.55+fbm(cx/16,cy/16,12,3)*0.95;
    x.fillStyle=`rgba(${(58*t)|0},${(112*t)|0},${(46*t)|0},.85)`;
    x.beginPath(); x.ellipse(cx,cy,r,r*(0.5+Math.random()*0.45),Math.random()*3,0,Math.PI*2); x.fill();
  }
  for(let i=0;i<180;i++){                                   // sunlit tips
    const cx=Math.random()*w, cy=Math.random()*h;
    x.fillStyle='rgba(168,210,120,.20)';
    x.beginPath(); x.ellipse(cx,cy,3+Math.random()*7,2+Math.random()*4,Math.random()*3,0,Math.PI*2); x.fill();
  }
  grain(x,w,h,10,0.09);
});
const barkNrm = normalFromTex(barkTex, 2.4);
const leafNrm = normalFromTex(leafTex, 1.8);
barkTex.repeat.set(2,1); barkNrm.repeat.set(2,1);   // wrap the trunk twice so ridges stay fine

// Ground detail. The terrain colour is one big baked canvas (8px per tile,
// already ~3840² — too big to re-bake at higher resolution), so instead of
// touching it we lay a fine tiling normal map over the top. Costs one small
// texture and gives the ground actual grain under the sun instead of reading
// as flat paint. Three keeps a per-texture matrix, so this repeats
// independently of the terrain map's single full-map UV.
const groundDetail = makeCanvasTex(128,128,(x,w,h)=>{
  x.fillStyle='#808080'; x.fillRect(0,0,w,h);
  grain(x,w,h,7,0.34,5);
  for(let i=0;i<900;i++){                                   // pebbles & tufts
    const v=Math.random(), s=1+Math.random()*3;
    x.fillStyle=v<0.5?'rgba(58,58,58,.5)':'rgba(216,216,216,.4)';
    x.fillRect(Math.random()*w,Math.random()*h,s,s);
  }
});
// ── Ground cover ──────────────────────────────────────────────────
// Blades are pooled and re-windowed around the player, exactly like the trees
// and walls above — cost is bounded by the pool, never by the 480x554 map.
// The plan originally cut grass outright as the likeliest framerate killer;
// that judgement was made against an integrated GPU, and it re-entered scope
// once the discrete card was actually being used.
// Density is the whole ballgame. At 34 blades/tile this read as scattered weeds
// on a lawn — you could see individual blades with gaps between them, which is
// worse than no grass at all because it draws attention to the flat ground it
// fails to hide. Grass only starts reading as ground cover once blades overlap
// and the eye stops resolving them individually. A tile is 48x48 units, so 120
// blades/tile is roughly one every 4.4 units — dense enough to merge.
// Measured 6.9ms/frame at the old density on an RTX 2050, so the headroom for
// this was already there.
// Radii roughly doubled once grass became cone-culled and distance-banded.
// Both changes free budget in the same direction: the wedge stops paying for
// the half of the circle behind the camera, and the bands stop paying full
// density for ground that's only a few pixels tall on screen.
// Radius is how far the field REACHES; perTile is its density in the near band
// only (see GRASS_BANDS -- everything past ~10 tiles is a fraction of it).
// Because the bands are keyed to absolute distance, these two numbers are now
// independent: raising the radius appends outer rings at 8-15% density and
// costs a small fraction of what the same increase used to.
// low is 0 on purpose -- phones do not draw grass at all.
const GRASS_CFG = {
  low:    { radius: 0,  perTile: 0   },
  medium: { radius: 30, perTile: 60  },
  high:   { radius: 52, perTile: 105 },
  ultra:  { radius: 64, perTile: 165 },
};
// Density by DISTANCE IN TILES, not by fraction of the radius. Perspective
// already thins the far field for free -- a ring at 50 tiles covers many times
// the ground per blade that a ring at 10 does -- so these fall much more slowly
// than they look like they should. The last entry is the open-ended tail.
const GRASS_BANDS = [
  [ 12, 1.00 ],   // foreground: blades read individually
  [ 22, 0.70 ],   // midground: continuous sward
  [ 32, 0.44 ],   // distance: still reads as grass
  [ 44, 0.24 ],   // far: texture on the ground
  [ 999, 0.13 ],  // horizon: a tint, carrying into the fog
];
function grassBand(dTiles){
  for(let b = 0; b < GRASS_BANDS.length; b++)
    if(dTiles < GRASS_BANDS[b][0]) return GRASS_BANDS[b][1];
  return 0;
}
// _grassOverride lets a session A/B radius/perTile against the tier table
// without a rebuild — set it from _dev.grass({radius, perTile}).
let _grassOverride = null;
const _grassCfg = () => Object.assign({}, GRASS_CFG[getTier()] || GRASS_CFG.medium, _grassOverride || {});

// Grass gets its own view test rather than sharing tileInView().
//
// tileInView keeps VIEW_NEAR_TILES (11) resident around the player at every
// angle, because an obstacle behind the camera still casts a shadow into the
// frame. Grass does not: grassMesh.castShadow is false, deliberately and for
// good reason (see grass.js). So a blade outside the wedge contributes exactly
// nothing, and at full density that bubble is ~450 tiles — about a third of the
// entire field, composed and uploaded every rebuild to be drawn nowhere.
//
// A small bubble stays, sized to cover the ~0.20 rad of camera turn that
// triggers a re-window plus the blades directly underfoot, which are the ones a
// first-person view looks straight down at.
// How a tile relates to the grass boundary:
//   2  every tile the warp could reach is grass  -> no per-blade test needed
//   1  a boundary tile (either grass with a non-grass neighbour, or non-grass
//      with a grass one) -> each blade must be tested against the warped edge
//   0  nowhere near grass -> skip the tile entirely
//
// Reads groundUnder, not map, for the same reason the painter does: the ground
// beneath a tree is still grass, and a boundary should bend through obstacles
// rather than stop at them.
function _grassClassAt(tx, ty){
  if(!_grassClassMap){
    _grassClassMap = new Int8Array(MAP_W*MAP_H);
    for(let y=0;y<MAP_H;y++) for(let x=0;x<MAP_W;x++)
      _grassClassMap[y*MAP_W+x] = _grassTileClass(x,y);
  }
  return _grassClassMap[ty*MAP_W+tx];
}
function _grassTileClass(tx, ty){
  const R = WARP_R;
  let all = true, any = false;
  for(let oy=-R; oy<=R; oy++){
    const yy = ty+oy; if(yy<0||yy>=MAP_H){ all=false; continue; }
    for(let ox=-R; ox<=R; ox++){
      const xx = tx+ox; if(xx<0||xx>=MAP_W){ all=false; continue; }
      if(groundUnder[yy*MAP_W+xx] === T.GRASS) any = true; else all = false;
    }
  }
  return all ? 2 : (any ? 1 : 0);
}
// Does a blade at this world position stand on grass, once the boundary has been
// bent by the same warp field the texture uses? px/py are canvas pixel coords —
// they only feed the per-pixel raggedness term, and using the same ones the
// painter would use is what keeps the two edges on top of each other.
function _bladeOnGrass(gx, gz){
  const fx = gx/TILE, fy = gz/TILE;
  let tx = fx|0, ty = fy|0;
  if(tx<0) tx=0; else if(tx>=MAP_W) tx=MAP_W-1;
  if(ty<0) ty=0; else if(ty>=MAP_H) ty=MAP_H-1;
  const g0 = groundUnder[ty*MAP_W+tx];
  return _warpedTileAt(fx, fy, (fx*TERR_PX)|0, (fy*TERR_PX)|0, g0) === T.GRASS;
}

// _dev.grass({warpEdge:false}) turns the warped boundary off, so its effect can
// be measured against the old behaviour with everything else held fixed.
let _grassWarpEdge = true;
const GRASS_NEAR_TILES = 4;
// VIEW_MARGIN (0.42 rad) is slack so that terrain relief cannot pop an obstacle
// in late at the edge of frame — a tree appearing over a crest is very visible.
// A blade of grass is a few pixels tall out there, so grass can buy the same
// insurance far more cheaply, and the narrower wedge is ~15% of the field.
const GRASS_MARGIN = 0.16;
function grassTileInView(tx, ty){
  const wx = tx*TILE + TILE/2, wz = ty*TILE + TILE/2;
  const px = wx - _view.px, pz = wz - _view.pz;
  const pd2 = px*px + pz*pz;
  if(pd2 <= (GRASS_NEAR_TILES*TILE)*(GRASS_NEAR_TILES*TILE)) return true;
  const dx = wx - _view.cx, dz = wz - _view.cz;
  const d2 = dx*dx + dz*dz;
  if(d2 > _view.far*_view.far) return false;
  const d = Math.sqrt(d2);
  if(d < 1e-3) return true;
  return (dx*_view.fx + dz*_view.fz) / d >= _view.grassCosHalf;
}
// Sized empirically, NOT as radius² × perTile. That worst case assumes every
// tile is grass, all of it in view, all at full density — with the cone and the
// distance bands the real figure is under a fifth of it, and allocating the
// theoretical bound would reserve ~90MB of instance buffers for slots that can
// never be filled. The placement loop hard-stops at this cap, so an
// unusually open vista just thins slightly rather than breaking.
const GRASS_MAX = 260000;
// What a single re-lay may cost, in blades. Measured, not guessed: ~120k blades
// rebuild in 12-16ms and ~228k in 36ms, and the field is re-laid every few tiles
// of movement, so the second figure is a stutter you can feel while running.
const GRASS_BUDGET = 130000;

const grassGeo = makeBladeGeometry(THREE, { height: 1, width: 0.22, curve: 0.24 });
const _grassMat = makeGrassMaterial(THREE, { map: makeBladeTexture(THREE), windAmount: 4.0 });
const grassMesh = new THREE.InstancedMesh(grassGeo, _grassMat.material, GRASS_MAX);
grassMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GRASS_MAX*3), 3);
grassMesh.castShadow = false;      // see grass.js — deliberate, not an oversight
grassMesh.receiveShadow = true;
grassMesh.frustumCulled = false;   // re-windowed each move, so the auto sphere goes stale
grassMesh.count = 0;
scene.add(grassMesh);

// Deterministic per-blade jitter. Rebuilding the window must reproduce exactly
// the same field or the whole sward visibly reshuffles every time you cross a
// tile boundary.
// Must be a GOOD hash, not just any hash. The first version multiplied by large
// constants in float arithmetic and only then applied 32-bit bitwise ops, which
// truncated away most of the entropy. Consecutive blade indices came out
// correlated, so blades piled up on top of each other and the field rendered as
// discrete tufts on a visible lattice instead of a continuous sward.
// Math.imul keeps the multiplies in 32-bit the whole way through.
// Three jitter values from ONE mix. _gHash was being called three times per
// blade for what is ultimately a scatter pattern; 10 bits each is ~1000 levels,
// which is finer than a blade's position can be told apart at any distance.
// Blade yaw, as a lookup rather than two transcendentals per blade. A field is
// ~95,000 blades and each was calling Math.cos and Math.sin, so a re-lay spent
// 190,000 trig evaluations deciding which way blades point. 256 steps is 1.4
// degrees apart — finer than a blade's rotation can be told apart at any
// distance, and the table is 4KB built once.
let _grassFastH = true;   // _dev.grass({fastH:false}) -> exact per-blade heightAt
const _GROT = 256;
const _gCos = new Float32Array(_GROT), _gSin = new Float32Array(_GROT);
for(let i=0;i<_GROT;i++){ const a=i/_GROT*Math.PI*2; _gCos[i]=Math.cos(a); _gSin[i]=Math.sin(a); }
const _g3 = [0, 0, 0];
function _gHash3(a, b, c){
  let h = (Math.imul(a|0, 73856093) ^ Math.imul(b|0, 19349663) ^ Math.imul(c|0, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16; h >>>= 0;
  _g3[0] = (h & 1023) / 1024;
  _g3[1] = ((h >>> 10) & 1023) / 1024;
  _g3[2] = ((h >>> 20) & 1023) / 1024;
  return _g3;
}
function _gHash(a, b, c){
  let h = (Math.imul(a|0, 73856093) ^ Math.imul(b|0, 19349663) ^ Math.imul(c|0, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// The instance arrays, written directly — see the inner loop of rebuildGrass.
const _gArr  = grassMesh.instanceMatrix.array;
const _gCArr = grassMesh.instanceColor.array;
const _gUp = new THREE.Vector3(0,1,0);
let _grassTx = -9999, _grassTy = -9999, _grassDirty = true;
// The view the current field was built against — see updateGrass().
let _grassFx = 0, _grassFz = 0, _grassFar = -1;

// Rolling cost of the last rebuild, in ms. The field is re-laid whenever the
// player crosses the hysteresis below, which at a sprint is often -- so this is
// the number that decides whether the radius above is affordable. Read it with
// _dev.grass().
let _grassMs = 0;
const _gStat = {};   // last rebuild's internals, surfaced through _dev.grass()

function rebuildGrass(){
  const t0 = (typeof performance!=='undefined') ? performance.now() : 0;
  const { radius, perTile } = _grassCfg();
  if(!radius){ grassMesh.count = 0; return; }
  const ptx = Math.floor(player.x/TILE), pty = Math.floor(player.y/TILE);
  const cap = GRASS_MAX;

  // ── Pass 1: how much field is there? ──
  // Costs one cheap loop over tiles (no per-blade work) and buys a cap that
  // degrades by DENSITY rather than by position. The old `i < cap` break cut
  // the loop mid-scan, and because the scan runs north to south that sliced the
  // sward along a line of latitude — a straight edge across the world with no
  // relation to where the player was standing. Now an unusually open vista
  // thins evenly everywhere, which is invisible; the old failure was not.
  let want = 0; _gStat.tiles = 0; _gStat.cls0=0; _gStat.cls1=0; _gStat.cls2=0; _gStat.warpRejected=0;
  for(let ty = pty-radius; ty <= pty+radius; ty++){
    const row = map[ty]; if(!row) continue;
    for(let tx = ptx-radius; tx <= ptx+radius; tx++){
      const c0=_grassClassAt(tx, ty);
      if(c0===0) _gStat.cls0++; else if(c0===1) _gStat.cls1++; else _gStat.cls2++;
      if(c0 === 0) continue;
      if(!grassTileInView(tx, ty)) continue;
      const dt = Math.hypot(tx-ptx, ty-pty);
      if(dt > radius) continue;
      want += grassBand(dt); _gStat.tiles++;
    }
  }
  // Two different limits, and conflating them is what let a top-down camera cost
  // 36ms. `cap` is the POOL — how many instances the buffers physically hold.
  // GRASS_BUDGET is what we are willing to SPEND re-laying the field, and it is
  // much smaller. Opening the cone to a full disc overhead quadruples the
  // visible area, and scaling density against the pool let the blade count
  // quadruple with it; scaling against a cost budget thins the field instead,
  // which is invisible from that height and keeps the rebuild bounded whatever
  // the camera is doing.
  const budget = Math.min(cap, GRASS_BUDGET);
  const densityScale = want*perTile > budget ? budget/(want*perTile) : 1;
  _gStat.want = want; _gStat.scale = densityScale;
  _gStat.cosHalf = _view.cosHalf; _gStat.far = _view.far;
  _gStat.cam = [Math.round(_view.cx), Math.round(_view.cz)];
  _gStat.plr = [Math.round(_view.px), Math.round(_view.pz)];

  // ── Pass 2: place ──
  let i = 0;
  for(let ty = pty-radius; ty <= pty+radius && i < cap; ty++){
    const row = map[ty]; if(!row) continue;
    for(let tx = ptx-radius; tx <= ptx+radius && i < cap; tx++){
      const gCls = _grassClassAt(tx, ty);
      if(gCls === 0) continue;
      if(!grassTileInView(tx, ty)) continue;     // cone-culled, minus the shadow bubble
      const d = Math.hypot(tx-ptx, ty-pty);
      if(d > radius) continue;
      const dr = d/radius;
      // Density comes from the absolute distance in tiles — see GRASS_BANDS.
      // Keying it to dr instead is what tied the width of the foreground band
      // to the radius, so that reaching further also made the near field more
      // expensive for nothing.
      const band = grassBand(d);
      // Height falloff stays out of the way until the very edge, then drops
      // fast so the last blades sink into the ground instead of ending on a
      // line. Squared for a softer knee.
      const rimT = Math.max(0, (dr - 0.86)) / 0.14;
      const rimH = 1 - rimT * rimT;
      const n = Math.max(0, Math.round(perTile * band * densityScale));
      // The height field is per TILE and bilinear, so the four corners of this
      // tile determine every blade inside it. Sampling them once here replaces
      // one heightAt() call per blade with one lerp — see the header note on
      // why the tiny interpolation error does not matter.
      const hx0 = tx*TILE, hz0 = ty*TILE, hx1 = hx0+TILE, hz1 = hz0+TILE;
      const h00 = heightAt(hx0,hz0), h10 = heightAt(hx1,hz0);
      const h01 = heightAt(hx0,hz1), h11 = heightAt(hx1,hz1);
      // Tint is per PATCH (tx>>2), not per blade, so it is hoisted out of the
      // inner loop — it was being recomputed identically up to 190 times a tile.
      // ── Patch variation ──
      // Two octaves of tile-scale noise. The broad one lays out the drifts; the
      // fine one stops their edges being blobby. Smoothstepped so a drift has a
      // core and a fade rather than a hard rim.
      const dBroad = _gHash(tx>>3, ty>>3, 31);
      const dFine  = _gHash(tx>>1, ty>>1, 37);
      let dry = dBroad*0.72 + dFine*0.28;
      dry = dry*dry*(3 - 2*dry);                  // smoothstep: flatten the middle
      // A little per-patch tone on top of the dry/green axis, so two dry drifts
      // are not the same dry.
      const tp = _gHash(tx>>2, ty>>2, 7);
      // Green end and straw end. The straw is NOT just brighter — its blue
      // collapses, which is what makes it read as dead rather than as sunlit.
      const gR = 0.74 + tp*0.22, gG = 0.90 + tp*0.16, gB = 0.66 + tp*0.18;
      const sR = 1.42 + tp*0.18, sG = 1.16 + tp*0.14, sB = 0.42 + tp*0.10;
      const cr = gR + (sR-gR)*dry, cg = gG + (sG-gG)*dry, cb = gB + (sB-gB)*dry;
      // Dry drifts stand taller. Colour alone reads as paint; it is the height
      // that makes a drift look like a different plant.
      const patchH = 0.82 + dry*0.85;
      for(let k = 0; k < n && i < cap; k++){
        const r3 = _gHash3(tx, ty, k);
        const rx = r3[0], rz = r3[1], rr = r3[2];
        const gx = (tx+rx)*TILE, gz = (ty+rz)*TILE;
        // Boundary tiles only: interior grass cannot be moved off grass by a
        // warp that cannot reach past its own neighbourhood.
        if(_grassWarpEdge && gCls === 1 && !_bladeOnGrass(gx, gz)){ _gStat.warpRejected++; continue; }
        // Height variety is what stops a field reading as mown turf. The cubic
        // bias keeps most blades short with a few tall ones standing proud.
        const hv = (0.62 + rr*rr*rr*1.05) * patchH * Math.max(0.05, rimH);
        const s  = TILE*0.26*hv;
        // A blade only ever spins about Y and scales uniformly, so the whole
        // TRS matrix is these four numbers. Matrix4.compose() solves the general
        // case — build a quaternion, expand it to a 3x3 — and then setMatrixAt
        // copies all sixteen elements again. At six figures of blades that
        // arithmetic is most of the rebuild.
        const ri = (rr*_GROT)|0, ca = _gCos[ri]*s, sa = _gSin[ri]*s;
        const o = i*16;
        _gArr[o   ] =  ca; _gArr[o+1 ] = 0; _gArr[o+2 ] = -sa; _gArr[o+3 ] = 0;
        _gArr[o+4 ] =   0; _gArr[o+5 ] = s; _gArr[o+6 ] =   0; _gArr[o+7 ] = 0;
        _gArr[o+8 ] =  sa; _gArr[o+9 ] = 0; _gArr[o+10] =  ca; _gArr[o+11] = 0;
        // Sunk very slightly so the blade's base is buried rather than resting
        // exactly on the surface — at a grazing camera angle a blade sitting
        // flush shows a hairline of ground between it and its own root.
        let by;
        if(_grassFastH){ const hA = h00 + (h10-h00)*rx, hB = h01 + (h11-h01)*rx; by = hA + (hB-hA)*rz; }
        else by = heightAt(gx, gz);
        _gArr[o+12] =  gx; _gArr[o+13] = by - 1.0; _gArr[o+14] = gz; _gArr[o+15] = 1;
        // Tint follows the same low-frequency idea as the terrain macro noise,
        // so patches of grass agree with the ground they stand in instead of
        // floating over it as a separate green.
        const c = i*3;
        _gCArr[c] = cr; _gCArr[c+1] = cg; _gCArr[c+2] = cb;
        i++;
      }
    }
  }
  grassMesh.count = i;
  grassMesh.instanceMatrix.needsUpdate = true;
  if(grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
  _grassTx = ptx; _grassTy = pty; _grassDirty = false;
  _grassFx = _view.fx; _grassFz = _view.fz; _grassFar = _view.far;
  if(t0) _grassMs = performance.now() - t0;
}
// Re-lay only after the player has crossed GRASS_HYST tiles, not every single
// one. At a sprint (2800 units/s, a 48-unit tile) one tile per rebuild is ~58
// rebuilds a second, and the field is now several times larger than it was. The
// field is deterministic per tile, so a window that is a few tiles stale is not
// visible — the blades that would be added are at the far rim, 52 tiles out,
// where the density is 13% and the height taper has already sunk them. This
// number is the direct lever on how often the rebuild cost is paid at all.
const GRASS_HYST = 4;
// Grass watches the view cone ITSELF rather than trusting the shared obstacle
// re-window flags. It has to: the first rebuild can land on a frame where
// _view is still its initial all-zero state (far = 0), which passes nothing but
// the near bubble — and with the hysteresis above, a player who spawns and does
// not immediately walk two tiles would stand in a bald world until they did.
// The old code hid that by re-laying the whole field on every single tile
// crossed, which is exactly the cost this pass set out to remove. Comparing the
// heading and reach the field was actually built against fixes the class of
// bug rather than that one instance of it.
function updateGrass(){
  const ptx = Math.floor(player.x/TILE), pty = Math.floor(player.y/TILE);
  const turned = (_grassFx*_view.fx + _grassFz*_view.fz) < 0.985;   // ~10 degrees
  const reach  = Math.abs(_view.far - _grassFar) > _grassFar*0.05 + 1;
  if(_grassDirty || turned || reach
     || Math.abs(ptx - _grassTx) >= GRASS_HYST
     || Math.abs(pty - _grassTy) >= GRASS_HYST) rebuildGrass();
}

// ── Windows ───────────────────────────────────────────────────────
// A bare wall face is a "doom wall". These panels sit proud of any exterior
// wall face and give the city architecture: a stone surround, a recessed
// mullioned opening, and a sill. The glow mask lets them light up warm after
// dark (see updateEnvironmentCycle), so a night city reads as inhabited.
const groundNrm = normalFromTex(groundDetail, 1.5);
groundNrm.repeat.set(MAP_W/3, MAP_H/3);                     // ~3 tiles per detail tile
terrMesh.material.normalMap = groundNrm;
terrMesh.material.needsUpdate = true;

// ── Terrain macro variation ───────────────────────────────────────
// The ground colour is one baked canvas at 8px per tile. At that density it
// carries tile-scale colour but nothing at LANDSCAPE scale, so a field reads as
// one flat green with fine grain over it — felt, not ground. The eye has
// nothing large to track, which is also why distance doesn't read.
//
// Re-baking the canvas bigger isn't an option (it's already ~3840x4432). So
// instead: modulate the albedo in the shader with low-frequency noise. Costs
// one texture-free noise evaluation per pixel and no memory at all.
//
// The hue swing is the part that actually sells it. Pure value variation still
// reads as noise laid over flat paint; pushing the lit patches warm and the
// dips cool reads as dry grass against damp ground.
//
// vMapUv spans 0..1 across the WHOLE map (the terrain is one PlaneGeometry), so
// a frequency of ~12 is about one cycle per 40 tiles — the scale you notice
// while walking, not while standing still.
// 0.17 was invisible at play distance; 0.45 reads well in open country but goes
// blotchy close up. Tune live with _dev.macro(n).
const _macroU = { value: 0.35 };
const _slopeU = { value: 1.0 };
terrMesh.material.onBeforeCompile = (shader) => {
  shader.uniforms.uMacroAmt = _macroU;
  shader.uniforms.uSlopeAmt = _slopeU;
  // World-space normal and height, passed explicitly. three's own `vNormal` is
  // in VIEW space, so its Y component swings with the camera and is useless as
  // a slope test — using it makes hillsides change material as you orbit.
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      varying vec3 vWNrm;
      varying float vWY;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      vWNrm = normalize(mat3(modelMatrix) * normal);
      vWY   = (modelMatrix * vec4(transformed, 1.0)).y;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform float uMacroAmt;
      uniform float uSlopeAmt;
      varying vec3 vWNrm;
      varying float vWY;
      float _th(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float _vn(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(_th(i), _th(i + vec2(1.0, 0.0)), f.x),
                   mix(_th(i + vec2(0.0, 1.0)), _th(i + vec2(1.0, 1.0)), f.x), f.y);
      }`)
    .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float m = _vn(vMapUv * vec2(11.0, 12.7)) * 0.60
                + _vn(vMapUv * vec2(31.0, 35.9)) * 0.28
                + _vn(vMapUv * vec2(83.0, 91.0)) * 0.12;
        float v = (m - 0.5) * 2.0;
        diffuseColor.rgb *= 1.0 + v * uMacroAmt;
        diffuseColor.r   *= 1.0 + v * uMacroAmt * 0.40;
        diffuseColor.b   *= 1.0 - v * uMacroAmt * 0.30;

        // ── Slope + height blending ──
        // Grass cannot hold a steep face; on real hills the soil washes off and
        // rock shows through. Keying material off the world normal is what
        // separates "hills" from "a green sheet draped over hills", and it also
        // makes the elevation readable at distance where the shading alone is
        // too soft to show form.
        float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
        // Threshold high: the height field is gentle, so a low cut would smear
        // rock across ground that is barely tilted.
        float rockF = smoothstep(0.16, 0.42, slope) * uSlopeAmt;
        // Break the boundary with the same noise field, or the rock arrives on
        // a clean contour line that reads as a printed band.
        rockF = clamp(rockF * (0.72 + m * 0.75), 0.0, 1.0);
        vec3 rockCol = vec3(0.40, 0.365, 0.335) * (0.80 + m * 0.42);
        diffuseColor.rgb = mix(diffuseColor.rgb, rockCol, rockF * 0.82);

        // Height tint: hollows stay lush and damp, tops dry out and pale off.
        // Subtle on purpose — this is a depth cue, not a biome.
        float alt = clamp(vWY / ${TERRAIN_AMP.toFixed(1)}, 0.0, 1.0);
        diffuseColor.rgb *= mix(vec3(0.94, 1.00, 0.92), vec3(1.06, 1.02, 0.90), alt);
      }`);
};
// Wooden planks for bridge decks
const bridgeTex = makeCanvasTex(64,64,(x,w,h)=>{
  x.fillStyle='#4a2e10'; x.fillRect(0,0,w,h);              // gaps
  const planks=4, shades=['#7a5030','#83572f','#6f4a28','#7d5433'];
  for(let p=0;p<planks;p++){
    const pw=w/planks;
    x.fillStyle=shades[p%4];
    x.fillRect(p*pw+1.5, 0, pw-3, h);
    x.strokeStyle='rgba(0,0,0,.18)';
    for(let g=0;g<3;g++){ x.beginPath(); const gx=p*pw+3+Math.random()*(pw-6);
      x.moveTo(gx,0); x.bezierCurveTo(gx+2,h*0.3,gx-2,h*0.7,gx+1,h); x.stroke(); }
    x.fillStyle='#3a250e';
    x.beginPath();x.arc(p*pw+pw/2,6,1.6,0,Math.PI*2);x.fill();
    x.beginPath();x.arc(p*pw+pw/2,h-6,1.6,0,Math.PI*2);x.fill();
  }
});

function makeMesh(geo, mat, count) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.castShadow = true; m.receiveShadow = true; m.count = 0;
  // Instances are re-windowed around the player each move, so the auto
  // bounding sphere goes stale and wrongly frustum-culls the whole mesh
  // (trees vanish when zoomed in). The window always surrounds the camera,
  // so skip whole-mesh culling entirely.
  m.frustumCulled = false;
  scene.add(m); return m;
}

// Generous headroom so the map editor can paint far more obstacles at
// runtime than the map started with, without overflowing the buffers.
const wallMesh  = makeMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({map:wallTex, normalMap:wallNrm, roughness:0.99, metalness:0.0}), nWall+4000);
// Stacked-skirt canopy and flared trunk instead of a bare cone on a cylinder.
// Both merge down to ONE geometry each, so this is the same two draw calls the
// primitives cost — the tier count is free.
const _canopyGeo = makeConiferCanopy(THREE, { height:TOPH, radius:TILE*0.72, tiers:4, seed:20260801 });
const _trunkGeo  = makeTrunk(THREE, { height:TRUNKH, top:9, bottom:12, seed:4242 });
const trunkMesh = makeMesh(_trunkGeo,  new THREE.MeshStandardMaterial({map:barkTex, normalMap:barkNrm, roughness:0.94, metalness:0.0}), nTree+4000);
const _canopyMat = new THREE.MeshStandardMaterial({map:leafTex, normalMap:leafNrm, roughness:0.88, metalness:0.0});
const topMesh   = makeMesh(_canopyGeo, _canopyMat, nTree+4000);
// A broadleaf crown for the species that are not conifers. SHARES the material
// with the cone above on purpose: the canopy wind patch and the leaf texture
// live there, so sharing is what stops the two halves of the forest drifting
// apart in everything except the shape they are supposed to differ in.
const _canopyBroadGeo = makeBroadleafCanopy(THREE, { height:TOPH, radius:TILE*0.80, lobes:5, seed:20260902 });
const topBroadMesh = makeMesh(_canopyBroadGeo, _canopyMat, nTree+4000);
// three defines USE_INSTANCING_COLOR from the presence of this buffer alone and
// multiplies it into the diffuse — no material flag needed. Same mechanism the
// grass field uses for its per-patch tint.
topMesh.instanceColor      = new THREE.InstancedBufferAttribute(new Float32Array((nTree+4000)*3), 3);
topBroadMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((nTree+4000)*3), 3);
// ── Canopy wind ───────────────────────────────────────────────────
// A forest of perfectly still cones reads as scenery, not as a place. This is
// the cheapest possible fix: a vertex-shader sway, no CPU cost per tree and no
// extra draw calls.
//
// Two details do the actual work. The sway is weighted by hFrac SQUARED, so the
// base of the cone barely moves and the tip travels — a tree that slides
// rigidly at the trunk looks like it's on wheels. And the phase comes from the
// instance's world position, so neighbouring trees are out of step; a forest
// swaying in unison is worse than one not swaying at all.
//
// begin_vertex runs BEFORE project_vertex applies instanceMatrix, so
// `transformed` here is in the cone's own local space — which is exactly what
// we want to bend, and it keeps leaning (felled) trees correct for free.
const _windU = { value: 0 };
const WIND_AMP = 7.0;   // world units of tip travel at full sway
topMesh.material.onBeforeCompile = (shader) => {
  shader.uniforms.uWindTime = _windU;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 wInst = instanceMatrix[3].xyz;
        #else
          vec3 wInst = vec3(0.0);
        #endif
        float hFrac = clamp((transformed.y + ${(TOPH*0.5).toFixed(2)}) / ${TOPH.toFixed(2)}, 0.0, 1.0);
        float phase = (wInst.x + wInst.z) * 0.0035;
        float sway  = sin(uWindTime * 1.30 + phase) * 0.60
                    + sin(uWindTime * 2.10 + phase * 1.7) * 0.25;
        float w = hFrac * hFrac * ${WIND_AMP.toFixed(1)};
        transformed.x += sway * w;
        transformed.z += sway * w * 0.6;
      }`);
};

// ── Near-LOD forest (procedural branch geometry) ──────────────────
// The cone canopy above is the FAR LOD and still draws most of the forest.
// This is the near half: real branches and foliage cards, one mesh pair per
// species, spent on the closest `QS.nearTrees` trees only. On the low tier
// that budget is 0, none of this is built, and the forest is exactly what it
// was before — which is the point of doing it as a budget rather than a radius.
const NEAR_TREES_CAP = 128;          // per-species instance capacity
const nearForest = QS.nearTrees > 0
  ? buildNearForest(THREE, {
      makeMesh,
      targetHeight: TREE_H,          // near and far MUST match, or trees pop
      capacity: NEAR_TREES_CAP,
      windUniform: _windU,
      anisotropy: QS.anisotropy || 4,
    })
  : null;

// Is there open water within a couple of tiles? Cheap enough to call per tree
// during a window rebuild, and it is what puts birch on the riverbanks.
function _waterNear(tx, ty){
  for(let dy=-2; dy<=2; dy++){
    const row = map[ty+dy];
    if(!row) continue;
    for(let dx=-2; dx<=2; dx++){
      if(row[tx+dx] === T.WATER) return true;
    }
  }
  return false;
}
const biomeAt = makeBiomeSampler({
  heightAt,
  isWaterNear: _waterNear,
  noise: _terrNoise,
  TILE,
  amplitude: terrain.amplitude,
});
// Which species stands on this tile. Hashed from the TILE so it survives window
// rebuilds unchanged — a forest that reshuffled its species as you walked would
// be far worse than one with no species at all.
// Biome → the species indices available in it, built ONCE. The first version
// of this called .filter() per tree per window rebuild, which is exactly the
// per-frame allocation churn the rest of this file goes out of its way to
// avoid.
const _speciesByBiome = (() => {
  if(!nearForest) return null;
  const m = Object.create(null);
  nearForest.species.forEach((s, i) => {
    (m[s.def.biome] || (m[s.def.biome] = [])).push(i);
  });
  // Every index, as the fallback for a biome no species claims.
  m.__all = nearForest.species.map((_, i) => i);
  return m;
})();
function speciesIndexFor(tx, ty, biome){
  if(!_speciesByBiome) return -1;
  const list = _speciesByBiome[biome] || _speciesByBiome.__all;
  return list[Math.floor(_gHash(tx, ty, 21) * list.length) % list.length];
}

// ── Far-canopy tint ───────────────────────────────────────────────
// The far LOD is ONE geometry in ONE green for the whole world, so a hillside
// of it reads as a repeated stamp however much the per-tile jitter varies size
// and position. Tinting each instance toward the leaf colour of the species it
// would be if it were near costs one instanceColor buffer and no draw calls.
//
// Built from SPECIES directly rather than from nearForest, which is null on the
// low tier — the tier that most needs distant forest to carry itself, since it
// never draws branch geometry at all. Same grouping and the same hash 21 as
// speciesIndexFor above, so near and far agree on which tree is which and a
// tree crossing the budget while you walk toward it does not change colour.
const _farTint = (() => {
  let mr=0, mg=0, mb=0;
  for(const s of SPECIES){
    mr += (s.leafColor>>16)&255; mg += (s.leafColor>>8)&255; mb += s.leafColor&255;
  }
  mr/=SPECIES.length; mg/=SPECIES.length; mb/=SPECIES.length;
  // Normalised against the mean, so the tints redistribute hue without moving
  // the forest's overall brightness — the leaf TEXTURE already carries that.
  return SPECIES.map(s => [ ((s.leafColor>>16)&255)/mr, ((s.leafColor>>8)&255)/mg, (s.leafColor&255)/mb ]);
})();
const _farByBiome = (() => {
  const m = Object.create(null);
  SPECIES.forEach((s, i) => { (m[s.biome] || (m[s.biome] = [])).push(i); });
  m.__all = SPECIES.map((_, i) => i);
  return m;
})();
// Which SPECIES a far tree is. Hash 21 and the same biome grouping the near
// LOD uses, so a tree that is an oak up close is an oak at distance — that
// agreement is the entire point of both this and the tint below.
function farSpeciesIdx(tx, ty){
  const list = _farByBiome[biomeAt(tx, ty)] || _farByBiome.__all;
  return list[Math.floor(_gHash(tx, ty, 21) * list.length) % list.length];
}
// Needle species get the cone, everything else the broadleaf crown.
function farIsBroadleaf(tx, ty){
  const sp = SPECIES[farSpeciesIdx(tx, ty)];
  return !!sp && sp.leafKind !== 'needle';
}
function farTintFor(tx, ty, out){
  const t = _farTint[farSpeciesIdx(tx, ty)];
  // Per-tree jitter on top, so two of the same species side by side are still
  // not identical — which matters, because biomeAt returns ONE biome over a
  // wide area and a lowland stand is therefore entirely oak. Species tint is
  // what separates a highland ridge from a riverbank; this is what stops the
  // trees inside one stand reading as a repeated stamp.
  //
  // Value alone was not enough. The terrain macro noise a few hundred lines up
  // found the same thing and says so: "Pure value variation still reads as
  // noise laid over flat paint; pushing the lit patches warm and the dips cool
  // reads as dry grass against damp ground." Opposing red and blue does the
  // same job here for the price of one more hash.
  const v = 0.86 + _gHash(tx, ty, 22) * 0.28;
  const w = (_gHash(tx, ty, 23) - 0.5) * 0.16;
  out[0] = t[0]*v*(1+w); out[1] = t[1]*v; out[2] = t[2]*v*(1-w);
  return out;
}
const _farTintTmp = [1,1,1];

const treeInstTile = [];   // instance index → packed ty*MAP_W+tx, so a canopy raycast maps back to a tile
const wallInstTile = [];   // same idea for walls, so clicking a wall FACE finds its tile
const caveInstTile = [];

// ── Tree chopping: lean → topple ──────────────────────────────────
// Trees no longer shrink or drop wood per hit. Each chop leans the standing
// tree a little further (rebuildTrees), and the felling blow hands over the
// whole log and spawns a toppling actor here. Each tree falls in a fixed
// per-tile direction so the lean and the topple stay continuous.
const TREE_WOOD = 4;                 // logs per felled tree (was 1/hit × 4 hits)
const TREE_MAX_LEAN = 0.34;          // how far a near-dead standing tree tilts (rad)
const TREE_FALL_ANGLE = Math.PI * 0.5;   // flat on the ground
const _leanQ = new THREE.Quaternion(), _leanAxis = new THREE.Vector3(), _leanOff = new THREE.Vector3();
const _yQ = new THREE.Quaternion();   // per-tree spin, see rebuildTrees
function treeFallAngleFor(tx,ty){ return _terrNoise(tx*13+1, ty*7+3) * Math.PI * 2; }
function treeLeanAxis(tx,ty,out){
  const a=treeFallAngleFor(tx,ty);
  return out.set(Math.sin(a), 0, -Math.cos(a)).normalize();   // ⟂ to the fall direction, so the top tips toward it
}
function makeTreeActor(){
  // Same maps as the standing trees, so a felled trunk matches the forest.
  const tMat=new THREE.MeshStandardMaterial({map:barkTex, normalMap:barkNrm, roughness:0.94, metalness:0.0, transparent:true});
  const cMat=new THREE.MeshStandardMaterial({map:leafTex, normalMap:leafNrm, roughness:0.88, metalness:0.0, transparent:true});
  // Shares the standing forest's merged geometry, so a tree doesn't change
  // shape at the moment it topples.
  const trunk=new THREE.Mesh(_trunkGeo, tMat); trunk.position.y=TRUNKH/2; trunk.castShadow=true;
  const canopy=new THREE.Mesh(_canopyGeo, cMat); canopy.position.y=TRUNKH+TOPH/2; canopy.castShadow=true;
  const grp=new THREE.Group(); grp.add(trunk,canopy); grp.visible=false; grp.frustumCulled=false; scene.add(grp);
  return {grp, tMat, cMat, active:false, t:0, dur:0.8, startLean:0, axis:new THREE.Vector3(), tint:null};
}
const _treeActors = Array.from({length:10}, makeTreeActor);
function spawnFallingTree(tx,ty,tint){
  const a=_treeActors.find(x=>!x.active) || _treeActors[0];
  a.active=true; a.t=0; a.dur=0.8;
  a.grp.position.set(tx*TILE+TILE/2, 0, ty*TILE+TILE/2);
  treeLeanAxis(tx,ty,a.axis);
  a.startLean=(1 - 1/TREE_HP) * TREE_MAX_LEAN;        // continue from the hp=1 standing lean
  // White = show the bark/leaf maps unmodified; colour here multiplies them.
  a.tMat.color.setHex(0xffffff); a.cMat.color.setHex(0xffffff);
  if(tint) a.cMat.color.multiply(new THREE.Color(tint));
  a.tMat.opacity=1; a.cMat.opacity=1;
  a.grp.quaternion.setFromAxisAngle(a.axis, a.startLean);
  a.grp.visible=true;
  snd.axe && snd.axe();          // the felling "crack"
}
function updateFallingTrees(dt){
  for(const a of _treeActors){
    if(!a.active) continue;
    a.t+=dt;
    const p=Math.min(1, a.t/a.dur), eased=p*p;         // accelerate like gravity
    a.grp.quaternion.setFromAxisAngle(a.axis, a.startLean + (TREE_FALL_ANGLE-a.startLean)*eased);
    if(a.t > a.dur+0.3){                                // rest on the ground, then fade out
      const f=Math.min(1,(a.t-a.dur-0.3)/0.45);
      a.tMat.opacity=1-f; a.cMat.opacity=1-f;
      if(f>=1){ a.active=false; a.grp.visible=false; }
    }
  }
}
// Window panels removed for performance. Stained glass is now custom tiles.
const stoneMesh = makeMesh(new THREE.DodecahedronGeometry(STONE_R),      new THREE.MeshStandardMaterial({map:rockTex, normalMap:rockNrm, roughness:0.92, metalness:0.0}), nStone+4000);
const caveMesh  = makeMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({map:caveTex, normalMap:caveNrm, roughness:0.95, metalness:0.0}), nCave+8000);
// Custom-tile boxes: one mesh for all custom obstacle tiles, per-instance color. transparent for glass aesthetics.
const customMesh = makeMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:0xffffff, roughness:0.6, metalness:0.0, transparent:true, opacity:0.85}), 4000);
const ironMesh = makeMesh(new THREE.DodecahedronGeometry(STONE_R), new THREE.MeshStandardMaterial({color:0x6a564d, roughness:0.42, metalness:0.88, map:rockTex}), 1500);
const campfireMesh = makeMesh(new THREE.BoxGeometry(20, 6, 20), new THREE.MeshStandardMaterial({color:0x5c3c24, roughness:0.9, metalness:0.0}), 500);
const workbenchMesh = makeMesh(new THREE.BoxGeometry(32, 14, 20), new THREE.MeshStandardMaterial({color:0x8b5a2b, roughness:0.85, metalness:0.0}), 500);
const forgeMesh = makeMesh(new THREE.CylinderGeometry(14, 16, 24, 8), new THREE.MeshStandardMaterial({color:0x505050, roughness:0.7, metalness:0.1}), 500);
const secureChestMesh = makeMesh(new THREE.BoxGeometry(22, 12, 16), new THREE.MeshStandardMaterial({color:0x5c3c24, roughness:0.65, metalness:0.1}), 500);
// World treasure chests — brass-banded so they read as loot, not as the
// player's own storage. Body + lid are separate instanced meshes.
const lootChestMesh = makeMesh(new THREE.BoxGeometry(24, 13, 17), new THREE.MeshStandardMaterial({color:0x8a6a2a, roughness:0.5, metalness:0.45}), 400);
const lootChestLidMesh = makeMesh(new THREE.BoxGeometry(25, 4, 18), new THREE.MeshStandardMaterial({color:0xd8b24a, roughness:0.35, metalness:0.7, emissive:0x2a1e06}), 400);
const torchMesh = makeMesh(new THREE.CylinderGeometry(1.5, 2, 28, 6), new THREE.MeshStandardMaterial({color:0x6b4226, roughness:0.8, metalness:0.0}), 2000);
const hearthMesh = makeMesh(new THREE.BoxGeometry(24, 20, 24), new THREE.MeshStandardMaterial({color:0x555555, roughness:0.9, map:rockTex}), 500);
const anvilMesh = makeMesh(new THREE.BoxGeometry(18, 10, 10), new THREE.MeshStandardMaterial({color:0x333333, metalness:0.8, roughness:0.3}), 500);
const placedLanternMesh = makeMesh(new THREE.CylinderGeometry(2.5, 2.5, 8, 6), new THREE.MeshStandardMaterial({color:0x1a1a1a, metalness:0.9, roughness:0.1}), 1000);
// Glowing flame blobs on torches / campfires / lanterns so every placed light
// source visibly reads as one (the actual PointLights come from the pool below).
const placedFlameMesh = makeMesh(new THREE.SphereGeometry(4, 7, 6), new THREE.MeshBasicMaterial({
  color:0xffa040, transparent:true, opacity:0.85, blending:THREE.AdditiveBlending, depthWrite:false}), 3000);

// ── HDR glow ──────────────────────────────────────────────────────
// A colour like 0xffa040 converts to roughly (1.0, 0.36, 0.05) in linear, so
// its brightest channel lands right ON the bloom threshold (0.9 at high) and
// flames barely glowed at all — a lit torch at midnight looked like an orange
// sticker. The scene renders into a half-float target, so values above 1 are
// perfectly legal; pushing emitters past the threshold is what makes bloom do
// anything. This is exactly what "emissive" means in an HDR pipeline and is
// not a hack.
// Only ever apply to ADDITIVE emitters — doing it to a lit surface would just
// blow the surface out.
// Shared clock for the flame shader. One uniform object handed to every fire
// material, so they all advance together and there is a single place to stop
// them from.
const _fireU = { value: 0 };
const FLAME_GAIN = 2.6, PORTAL_GAIN = 1.9;
function hdrGlow(m, gain){
  if(m && m.color && !m.userData._hdrBoosted){
    m.color.multiplyScalar(gain);
    m.userData._hdrBoosted = true;
  }
  return m;
}
hdrGlow(placedFlameMesh.material, FLAME_GAIN);
// This blob is deliberately STEADY. It briefly pulsed and lifted in the vertex
// shader, which made every torch and campfire throb — the fire looked like it
// was breathing rather than burning. A flame's apparent brightness barely moves;
// what moves is the light it throws on everything around it, and that is what
// flameFlicker() drives on the PointLight instead.

// ── Boss ability telegraphs ───────────────────────────────────────
// The danger zone a boss is winding up into, painted flat on the ground. It
// FILLS IN as the cast completes, so the opacity is the countdown — you read
// how long you have without needing a number. Plain meshes rather than an
// InstancedMesh because opacity has to vary per zone, and there are only ever
// one or two up at once.
const TG_POOL = 4;
const tgCircles = [], tgLines = [];
for (let i=0;i<TG_POOL;i++){
  const cg = new THREE.CircleGeometry(1, 40); cg.rotateX(-Math.PI/2);
  const mk = () => new THREE.MeshBasicMaterial({ color:0xff3a20, transparent:true,
    opacity:0, depthWrite:false, side:THREE.DoubleSide });
  const c = new THREE.Mesh(cg, mk());
  c.visible=false; c.renderOrder=2; c.frustumCulled=false; scene.add(c); tgCircles.push(c);
  // Lane geometry runs 0..1 along +X so it can be anchored at the boss and
  // simply scaled to length; width lies along Z.
  const lg = new THREE.PlaneGeometry(1, 1); lg.rotateX(-Math.PI/2); lg.translate(0.5, 0, 0);
  const l = new THREE.Mesh(lg, mk());
  l.visible=false; l.renderOrder=2; l.frustumCulled=false; scene.add(l); tgLines.push(l);
}
function updateBossTelegraphs(){
  let ci=0, li=0;
  for(const e of enemies){
    const c=e.cast; if(!c) continue;
    const p=Math.min(1, c.t/c.dur);
    const op=0.16+0.44*p;                       // fills in = the countdown
    if(c.shape==='circle' && ci<TG_POOL){
      const m=tgCircles[ci++];
      // 'follow' zones ride the boss; locked ones stay where you were standing.
      m.position.set(c.follow?e.x:c.x, 3, c.follow?e.y:c.y);
      m.scale.set(c.r,1,c.r);
      m.material.opacity=op; m.visible=true;
    } else if(c.shape==='line' && li<TG_POOL){
      const m=tgLines[li++];
      m.position.set(c.x, heightAt(c.x,c.y) + 3, c.y);
      m.rotation.y=-c.ang;                      // rotation.y=θ sends +X to (cosθ,0,-sinθ)
      m.scale.set(c.len,1,c.w);
      m.material.opacity=op; m.visible=true;
    }
  }
  for(let i=ci;i<TG_POOL;i++) tgCircles[i].visible=false;
  for(let i=li;i<TG_POOL;i++) tgLines[i].visible=false;
}

// ── Placeable registry ────────────────────────────────────────────
// One row per placeable object. Before this, every item was special-cased in six
// separate places — the craft handler, tryPlace, two copy-pasted right-click
// blocks, rebuildPlacedObjects' if/else chain, the lighting filter, and
// removePlacedObject — so adding an item meant six edits and coverage drifted
// apart (torches could be right-click placed, nothing else could; removing a
// forge refunded nothing). Everything now reads from here.
//
//   mesh    instanced mesh to draw into
//   y       centre height of the mesh, in world units, BEFORE scale
//   scale   per-item size multiplier. Props predate OBJ_SCALE=2 and were never
//           swept up by it, so they read as shin-high against a 126u character.
//           Sized individually (owner's call — no blanket multiply) against the
//           scale the character establishes: 126u = a ~1.8m person, so 1m ~ 70u.
//           The comment on each row is the real-world size it's aiming at.
//           y and the flame offset ride this number, so it's the only edit
//           needed — tune live with _dev.placeScale('torch', 2).
//   flame   {y,s} glowing blob for anything that burns, or null
//   light   true if it feeds the placed-light pool
//   invKey  inventory key it is stored under — every placeable is a pack item now
//   emoji   pack / hotbar icon
//   surfaces  where it may sit: 'ground' (grass/path/cave floor) or 'house'
//             (a house floor you may build in). Phase 3 will add 'wall'.
//
// Picking a thing up returns the THING, not its materials. That keeps
// place/remove lossless without making it a crafting exploit — you can't cycle a
// forge for stone. Craft cost stays a one-way spend, as it was.
const PLACEABLES = {
  // scale ↓  mesh 20×6×20 → 60×18×60 ≈ 0.85m across, ankle height. A fire ring.
  campfire:     { label:'Campfire',     emoji:'🔥', invKey:'campfire',     mesh:()=>campfireMesh,      y:3,  scale:3.0, flame:{y:10,s:1.5}, light:true,  surfaces:['ground'],
                  burn:{ fuelSec:DAY_CYCLE_SEC, spent:'douse', relight:{wood:1} } },
  // 32×14×20 → 112×49×70 ≈ 1.6m wide, 0.7m high. Waist-high bench.
  workbench:    { label:'Workbench',    emoji:'🛠', invKey:'workbench',    mesh:()=>workbenchMesh,     y:7,  scale:3.5, flame:null,         light:false, surfaces:['ground'] },
  // r14/16 h24 → r42/48 h72 ≈ 1.35m wide, 1m tall. Chest-high stone forge.
  forge:        { label:'Forge',        emoji:'🏭', invKey:'forge',        mesh:()=>forgeMesh,         y:12, scale:3.0, flame:null,         light:true,  surfaces:['ground'] },
  // 22×12×16 → 66×36×48 ≈ 0.95m wide, 0.5m tall. Knee-high strongbox.
  secure_chest: { label:'Secure Chest', emoji:'🧰', invKey:'secure_chest', mesh:()=>secureChestMesh,   y:6,  scale:3.0, flame:null,         light:false, surfaces:['house'] },
  // h28 → h45 ≈ 0.65m. Held torch was tuned separately (WEAPON_ADJUST); this is
  // the PLACED mesh, and it's what mounts on walls — 45u against a 168u wall.
  torch:        { label:'Torch',        emoji:'🔥', invKey:'torch',        mesh:()=>torchMesh,         y:14, scale:1.6, flame:{y:30,s:1.0}, light:true,  surfaces:['ground','wall'], wallY:WALL_H*0.62,
                  burn:{ fuelSec:DAY_CYCLE_SEC, spent:'consume' } },
  // 24×20×24 → 84×70×84 ≈ 1.2m across, 1m tall. A proper stone hearth.
  hearth:       { label:'Hearth',       emoji:'🔥', invKey:'hearth',       mesh:()=>hearthMesh,        y:10, scale:3.5, flame:null,         light:true,  surfaces:['ground'] },
  // 18×10×10 → 40×22×22 ≈ 0.57m long, 0.3m tall. Anvil on its own, no stump.
  anvil:        { label:'Anvil',        emoji:'⚒',  invKey:'anvil',        mesh:()=>anvilMesh,         y:5,  scale:2.2, flame:null,         light:false, surfaces:['ground'] },
  // h8 → h24 ≈ 0.35m. Carried lantern was tuned separately; this is the placed one.
  lantern:      { label:'Lantern',      emoji:'🏮', invKey:'lantern',      mesh:()=>placedLanternMesh, y:4,  scale:3.0, flame:{y:8,s:0.7},  light:true,  surfaces:['ground','wall'], wallY:WALL_H*0.58 },
};
// ── Burning down ──────────────────────────────────────────────────
// Fuel is DERIVED, never ticked: an object records `litAt` from worldNow() and
// its remaining life is fuelSec - (worldNow() - litAt). worldNow() is absolute
// and server-synced, so every client independently computes the same answer,
// it survives a reload, it works offline, and a torch lit twenty minutes ago is
// correctly dead when you come back rather than politely waiting for you.
//   spent:'consume' → gone for good (torch)
//   spent:'douse'   → goes dark, relightable for `relight` cost (campfire)
//   no burn field   → burns forever (lantern, forge, hearth)
const BURN_SWEEP_SEC = 2;                 // how often expiry is checked
let _burnClock = 0;
function burnRemaining(o){                // seconds of fuel left, or Infinity
  const def=PLACEABLES[o.type];
  if(!def||!def.burn||o.spent) return o.spent?0:Infinity;
  if(!(o.litAt>0)) return Infinity;       // pre-burnout saves: treat as eternal
  return def.burn.fuelSec - (worldNow()-o.litAt);
}
function isLit(o){
  const def=PLACEABLES[o.type];
  if(!def) return false;
  if(!def.burn) return !!def.light;       // never burns out
  return !o.spent && burnRemaining(o)>0 && !!def.light;
}
// A wall mount leans out of the face by this much (radians) so it reads as a
// bracket rather than a torch buried in the stone.
const WALL_TILT = 0.45;
// Outward direction per face, in tile units.
const FACE_DIR = { e:[1,0], w:[-1,0], s:[0,1], n:[0,-1] };
// Tiles a 'ground' placeable may stand on. CAVE_FLOOR is new — you could not put
// a torch down in a dungeon before, which was most of where you'd want one.
const PLACE_GROUND = new Set([T.GRASS, T.PATH, T.CAVE_FLOOR, T.CAVE_ENTRANCE]);
const PLACEABLE_LIGHTS = new Set(Object.keys(PLACEABLES).filter(k=>PLACEABLES[k].light));

let wallDirty=true, treeDirty=true, stoneDirty=true, ironDirty=true, caveDirty=true, customDirty=true, placedObjectsDirty=true;
const _custCol=new THREE.Color();

// ── Obstacle render window ────────────────────────────────────────
// Only push instances within a window around the player to the GPU, so we
// never process e.g. all ~13k dungeon walls while out in the overworld. Fog
// hides the window edge; it re-centres as the player moves.
const OBS_WIN = (typeof innerWidth==='number'&&innerWidth<600) ? 28 : 32; // radius, tiles (> vision)
let _obsCx=1e12, _obsCy=1e12;   // last rebuild centre (huge → forces build on frame 1)
let _obsAngle=1e12, _obsZoom=-1;   // camera heading/zoom at last re-window
// ── View-cone culling ─────────────────────────────────────────────
// The window used to be a circle centred on the player, which spent roughly
// half its instance budget on ground BEHIND the camera that is never drawn.
// This replaces it with a wedge aligned to where the camera actually looks, and
// spends the recovered budget on reaching much further forward — the direction
// you're travelling and the only one you can see.
//
// A cone test, not the full six frustum planes. This camera always looks at the
// player across near-flat ground, so a horizontal angle test plus a distance
// cap captures the same set for a fraction of the arithmetic, and it degrades
// safely: the margin below is generous enough that terrain relief pushing a
// hilltop into view can't pop it in late.
//
// A near radius around the PLAYER is always included regardless of angle.
// Without it, spinning the camera would strip the props you're standing next to
// — and things directly behind you still cast shadows into the frame.
const VIEW_MARGIN = 0.42;        // radians of slack either side of the frustum
const VIEW_NEAR_TILES = 11;      // always-resident bubble around the player
const _view = { cx:0, cz:0, px:0, pz:0, fx:0, fz:1, cosHalf:-1, grassCosHalf:-1, far:0, nearR:0 };
function updateViewCone(){
  // The cone's apex is the camera — but the camera is repositioned LATER in the
  // frame, after the obstacle and grass windows have already been rebuilt from
  // it. In every ordinary frame the player moves a few units and one frame of
  // lag is invisible. When the player jumps — a teleport, a portal, a respawn,
  // the first frame out of character select — camera.position still holds a
  // point that can be a hundred tiles away, and then EVERY tile fails the
  // `d2 > far*far` test below. The window collapses to the near bubble: bald
  // ground with the player standing in a small patch of grass.
  //
  // Clamping the apex to a physically possible boom length fixes it exactly and
  // is a no-op the rest of the time, because the camera never legitimately sits
  // further from the player than its own orbit radius. The heading is still one
  // frame stale on that frame; updateGrass()'s turn check re-lays the field on
  // the next one, by which point the camera has caught up.
  const _boom = CAM_R * camZoom + TILE * 2;
  let _ax = camera.position.x - player.x, _az = camera.position.z - player.y;
  const _al = Math.hypot(_ax, _az);
  if(_al > _boom){ const k = _boom / _al; _ax *= k; _az *= k; }
  _view.cx = player.x + _ax;    _view.cz = player.y + _az;
  _view.px = player.x;          _view.pz = player.y;
  if(camMode().fp){
    // In first person the camera IS the player, so player - camera is the zero
    // vector and the code below would silently keep whatever heading it last
    // had — culling the world to the direction you were facing when you entered
    // first person. Take the heading from camAngle instead; -(sin, cos) is the
    // same forward the camera looks along and the same one W moves you in.
    _view.fx = -Math.sin(camAngle); _view.fz = -Math.cos(camAngle);
  } else {
    let fx = player.x - camera.position.x, fz = player.y - camera.position.z;
    const l = Math.hypot(fx, fz);
    if(l > 1e-3){ _view.fx = fx/l; _view.fz = fz/l; }   // else keep last heading
  }
  // Horizontal half-FOV. camera.fov is VERTICAL, so it has to go through the
  // aspect ratio — using it directly gives a wedge far too narrow on a wide
  // window and clips scenery at the screen edges.
  const vHalf = camera.fov * 0.5 * Math.PI / 180;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  // A CONE IS THE WRONG SHAPE WHEN THE CAMERA IS OVERHEAD. The wedge is built
  // from the horizontal direction camera->player, and as the camera tilts toward
  // straight down that direction shrinks to nothing and its angle becomes
  // meaningless — so top-down culled the world to a narrow strip pointing in
  // some arbitrary compass direction while the player could plainly see a disc
  // all around themselves. That is the missing grass in a top-down screenshot.
  //
  // `overhead` is the honest measure of it: how the camera's horizontal offset
  // compares with its height above the player. Level with the player it is 0 and
  // nothing changes; directly above it is 1 and the half-angle opens to a full
  // circle, which is exactly what that camera can see.
  const _camH = Math.max(1, camera.position.y - heightAt(player.x, player.y));
  const _overhead = 1 - Math.min(1, _al / _camH);
  const _open = (m) => {
    const half = hHalf + m;
    return Math.cos(Math.min(Math.PI * 0.999, half + _overhead * (Math.PI - half)));
  };
  _view.cosHalf      = _open(VIEW_MARGIN);
  _view.grassCosHalf = _open(GRASS_MARGIN);
  // Reach scales with zoom: pulling the camera back shows more ground, and the
  // wedge has the budget to cover it because it isn't paying for the half
  // behind you.
  const _reachZoom = camMode().fp ? 1.0 : camZoom;   // fp keeps a stale camZoom
  const farTiles = Math.min(96, (QS.obsWindow || 32) * (1.35 + _reachZoom * 0.75));
  _view.far   = farTiles * TILE;
  _view.nearR = VIEW_NEAR_TILES * TILE;
}
function tileInView(tx, ty){
  const wx = tx*TILE + TILE/2, wz = ty*TILE + TILE/2;
  const px = wx - _view.px, pz = wz - _view.pz;
  if(px*px + pz*pz <= _view.nearR*_view.nearR) return true;
  const dx = wx - _view.cx, dz = wz - _view.cz;
  const d2 = dx*dx + dz*dz;
  if(d2 > _view.far*_view.far) return false;
  const d = Math.sqrt(d2);
  if(d < 1e-3) return true;
  return (dx*_view.fx + dz*_view.fz) / d >= _view.cosHalf;
}
// Tile AABB enclosing the wedge plus the near bubble. Only the loop bounds —
// tileInView still rejects the corners this leaves in.
// farOverride lets one caller reach further than the shared window. Only cave
// walls use it, and only because they are the one thing with no far-LOD behind
// the window -- see the note on rebuildCave.
function _obsBounds(farOverride){
  const pad = TILE * 2;
  const far = farOverride || _view.far;
  const ang = Math.acos(Math.max(-1, Math.min(1, _view.cosHalf)));
  let minX = Math.min(_view.cx, _view.px - _view.nearR);
  let maxX = Math.max(_view.cx, _view.px + _view.nearR);
  let minZ = Math.min(_view.cz, _view.pz - _view.nearR);
  let maxZ = Math.max(_view.cz, _view.pz + _view.nearR);
  // Cone apex plus its two edges and its centreline; the arc between the edges
  // can bulge past the chord, which `pad` absorbs.
  for(const a of [-ang, 0, ang]){
    const ca = Math.cos(a), sa = Math.sin(a);
    const ex = _view.cx + (_view.fx*ca - _view.fz*sa) * far;
    const ez = _view.cz + (_view.fx*sa + _view.fz*ca) * far;
    if(ex < minX) minX = ex; if(ex > maxX) maxX = ex;
    if(ez < minZ) minZ = ez; if(ez > maxZ) maxZ = ez;
  }
  return {
    tx0: Math.max(0, Math.floor((minX-pad)/TILE)), tx1: Math.min(MAP_W-1, Math.ceil((maxX+pad)/TILE)),
    ty0: Math.max(0, Math.floor((minZ-pad)/TILE)), ty1: Math.min(MAP_H-1, Math.ceil((maxZ+pad)/TILE)),
  };
}
// Upload only the used slice of an instanced attribute. Plain needsUpdate
// re-sends the WHOLE buffer at capacity (the cave mesh alone is ~21k
// instances ≈ 1.4MB) on every re-window — even when the window holds 0
// instances — which is what caused the movement stutter.
function _markAttr(attr, items){
  if(!attr || items<=0) return;                 // count=0 → nothing to draw or upload
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, items);
  attr.needsUpdate=true;
}
function markInst(mesh, used){
  mesh.count=used;
  _markAttr(mesh.instanceMatrix, used*16);      // 16 floats per matrix
}
function rebuildCustomTiles(){
  let i=0; const cap=4000, b=_obsBounds();
  for(let ty=b.ty0;ty<=b.ty1&&i<cap;ty++) for(let tx=b.tx0;tx<=b.tx1&&i<cap;tx++){
    const t=map[ty][tx];
    if (t === T.STAINED_GLASS) {
      // 3D Stained Glass block: a wall material, so it stands a full wall tall.
      // Was hardcoded 41u — a pre-OBJ_SCALE value, knee-high on a 126u character.
      setBoxInst(customMesh, i, tx*TILE+TILE/2, ty*TILE+TILE/2, TILE*0.98, WALL_H, TILE*0.98);
      customMesh.setColorAt(i, _custCol.setRGB(142/255, 34/255, 48/255));
      i++;
      continue;
    }
    if(t<100) continue;
    const ct=customTileDefs[t]; if(!ct||!ct.boxH) continue;   // flat customs = ground color only
    setBoxInst(customMesh, i, tx*TILE+TILE/2, ty*TILE+TILE/2, TILE*0.98, ct.boxH, TILE*0.98);
    customMesh.setColorAt(i, _custCol.setRGB(ct.color[0]/255, ct.color[1]/255, ct.color[2]/255));
    i++;
  }
  markInst(customMesh,i);
  _markAttr(customMesh.instanceColor, i*3);     // 3 floats per color
}

function setBoxInst(mesh, idx, cx, cz, w, h, d) {
  _pos.set(cx, h/2, cz); _sc1.set(w,h,d);
  _m4.compose(_pos, _qId, _sc1); mesh.setMatrixAt(idx, _m4);
}
function setPlaceInst(mesh, idx, cx, y, cz) {
  _pos.set(cx,y,cz); _sc1.set(1,1,1);
  _m4.compose(_pos, _qId, _sc1); mesh.setMatrixAt(idx, _m4);
}

function rebuildWalls() {
  let i=0; const cap=wallMesh.instanceMatrix.count, b=_obsBounds();
  const q=new THREE.Quaternion(), eul=new THREE.Euler();
  for(let ty=b.ty0;ty<=b.ty1&&i<cap;ty++) for(let tx=b.tx0;tx<=b.tx1&&i<cap;tx++) {
    if(map[ty][tx]!==T.WALL) continue;
    const n1=_terrNoise(tx*13, ty*17), n2=_terrNoise(tx*29, ty*5);
    const varH = WALL_H + (n1 - 0.5) * 5;
    eul.set((n1-0.5)*0.03, (n2-0.5)*0.08, (n2-0.5)*0.03);
    q.setFromEuler(eul);
    _pos.set(tx*TILE+TILE/2 + (n1-0.5)*2, heightAt(tx*TILE+TILE/2, ty*TILE+TILE/2) + varH/2, ty*TILE+TILE/2 + (n2-0.5)*2);
    _sc1.set(TILE*0.98, varH, TILE*0.98);
    _m4.compose(_pos, q, _sc1); wallMesh.setMatrixAt(i, _m4);
    wallInstTile[i]=ty*MAP_W+tx;
    i++;
  }
  wallInstTile.length=i;
  markInst(wallMesh,i);
  wallMesh.computeBoundingSphere();   // raycast early-outs on this; stale = missed clicks
}
// ── Tree placement ────────────────────────────────────────────────
// Two levels of detail, split by a BUDGET rather than a radius. The closest
// QS.nearTrees trees draw full procedural branch geometry; everything else
// draws the merged cone canopy, exactly as the whole forest used to. Cost is
// therefore bounded by a number in the tier table instead of by how much forest
// happens to be on screen, and on the low tier the budget is 0 so none of the
// near path is built or run.
//
// Both paths share the same per-tile hashes, so a tree keeps its jitter, girth,
// height and spin when it crosses between them — only its geometry changes.

// Selection scratch, allocated once. rebuildTrees runs on every window slide
// and this file deliberately avoids per-rebuild allocation.
const _nearCandT = new Int32Array(2048);
const _nearCandD = new Float32Array(2048);
const _nearOrder = [];

function _treePlace(tx, ty, atBase){
  // Shared transform for both LODs. `atBase` is true for the generated trees,
  // whose origin is the foot of the trunk; the cone canopy needs its trunk and
  // canopy placed separately by the caller.
  const hp=(resourceHp[ty]&&resourceHp[ty][tx])||TREE_HP;
  const leanFrac=1 - hp/TREE_HP;
  const jx=(_gHash(tx,ty,11)-0.5)*TILE*0.34;
  const jz=(_gHash(tx,ty,12)-0.5)*TILE*0.34;
  const cx=tx*TILE+TILE/2+jx, cz=ty*TILE+TILE/2+jz;
  const gy=heightAt(cx,cz);
  const sw=0.80+_gHash(tx,ty,13)*0.46;
  const sh=0.76+_gHash(tx,ty,14)*0.58;
  _sc1.set(sw,sh,sw);
  _yQ.setFromAxisAngle(_gUp, _gHash(tx,ty,15)*Math.PI*2);
  return { cx, cz, gy, sw, sh, leanFrac };
}

// Per-canopy fill counters, reset by rebuildTrees. The trunk index and the
// canopy index are no longer the same number: a trunk always goes to trunkMesh,
// but its canopy goes to whichever of the two meshes its species calls for.
let _farNeedleN = 0, _farBroadN = 0;
function _placeFarTree(tx, ty, i){
  const P=_treePlace(tx,ty,false);
  const th=TRUNKH*P.sh, oh=TOPH*P.sh;
  const broad = farIsBroadleaf(tx,ty);
  const top = broad ? topBroadMesh : topMesh;
  const ti  = broad ? _farBroadN++ : _farNeedleN++;
  if(ti >= top.instanceMatrix.count){ if(broad) _farBroadN--; else _farNeedleN--; return; }
  if(P.leanFrac>0.001){
    treeLeanAxis(tx,ty,_leanAxis);
    _leanQ.setFromAxisAngle(_leanAxis, P.leanFrac*TREE_MAX_LEAN);
    _leanQ.multiply(_yQ);                  // spin first, then topple
    _leanOff.set(0,th/2,0).applyQuaternion(_leanQ);
    _pos.set(P.cx+_leanOff.x,P.gy+_leanOff.y,P.cz+_leanOff.z);
    _m4.compose(_pos,_leanQ,_sc1); trunkMesh.setMatrixAt(i,_m4);
    _leanOff.set(0,th+oh/2,0).applyQuaternion(_leanQ);
    _pos.set(P.cx+_leanOff.x,P.gy+_leanOff.y,P.cz+_leanOff.z);
    _m4.compose(_pos,_leanQ,_sc1); top.setMatrixAt(ti,_m4);
  } else {
    // Sunk a little: the flared trunk base must bury itself in the slope or
    // an uphill tree shows daylight under its upper side.
    _pos.set(P.cx,P.gy+th/2-3,P.cz);
    _m4.compose(_pos,_yQ,_sc1); trunkMesh.setMatrixAt(i,_m4);
    _pos.set(P.cx,P.gy+th+oh/2-3,P.cz);
    _m4.compose(_pos,_yQ,_sc1); top.setMatrixAt(ti,_m4);
  }
  const c=farTintFor(tx,ty,_farTintTmp), ci=ti*3;
  top.instanceColor.array[ci]=c[0];
  top.instanceColor.array[ci+1]=c[1];
  top.instanceColor.array[ci+2]=c[2];
  const packed=ty*MAP_W+tx;
  top.userData.instTile[ti]=packed;   // chopping maps a canopy hit back to a tile
  treeInstTile[i]=packed;             // packed int: no per-rebuild object churn
}

function _placeNearTree(tx, ty){
  const sp=nearForest.species[speciesIndexFor(tx,ty,biomeAt(tx,ty))];
  const n=sp._n|0;
  if(n>=NEAR_TREES_CAP) return false;
  const P=_treePlace(tx,ty,true);
  // The generated tree's origin IS its base, so a lean about the origin is
  // already a lean about the stump — no offset to keep in sync.
  if(P.leanFrac>0.001){
    treeLeanAxis(tx,ty,_leanAxis);
    _leanQ.setFromAxisAngle(_leanAxis, P.leanFrac*TREE_MAX_LEAN);
    _leanQ.multiply(_yQ);
    _pos.set(P.cx,P.gy-3,P.cz);
    _m4.compose(_pos,_leanQ,_sc1);
  } else {
    _pos.set(P.cx,P.gy-3,P.cz);
    _m4.compose(_pos,_yQ,_sc1);
  }
  sp.bark.setMatrixAt(n,_m4); sp.leaf.setMatrixAt(n,_m4);
  const packed=ty*MAP_W+tx;
  sp.bark.userData.instTile[n]=packed;
  sp.leaf.userData.instTile[n]=packed;
  sp._n=n+1;
  return true;
}

function rebuildTrees() {
  const b=_obsBounds();
  const farCap=trunkMesh.instanceMatrix.count;
  // Budget and radius both scale with where the camera actually is, not with
  // which preset is selected — middle-drag moves you off a preset without
  // changing the mode. Overhead views get almost nothing, because from directly
  // above a canopy the branch structure underneath it is not visible at all.
  const _fp=camMode().fp;
  const nearBudget=nearForest
    ? Math.min(NEAR_TREES_CAP, Math.round((QS.nearTrees|0) * nearBudgetFactor(_fp, camPitch, camZoom)))
    : 0;
  // Only trees inside this radius are even considered for branch geometry, so
  // the candidate list stays short enough to sort cheaply.
  const NEAR_R=TILE*nearRadiusTiles(_fp, camPitch), NEAR_R2=NEAR_R*NEAR_R;

  let far=0, nCand=0;
  _farNeedleN = 0; _farBroadN = 0;
  if(nearForest) for(const sp of nearForest.species) sp._n=0;

  // Pass 1 — anything beyond the near radius goes straight to the far meshes.
  for(let ty=b.ty0;ty<=b.ty1;ty++) for(let tx=b.tx0;tx<=b.tx1;tx++) {
    if(map[ty][tx]!==T.TREE) continue;
    if(!tileInView(tx,ty)) continue;
    if(nearBudget>0 && nCand<_nearCandT.length){
      const ccx=tx*TILE+TILE/2, ccz=ty*TILE+TILE/2;
      const dx=ccx-player.x, dz=ccz-player.y;
      const d2=dx*dx+dz*dz;
      if(d2<NEAR_R2){ _nearCandT[nCand]=ty*MAP_W+tx; _nearCandD[nCand]=d2; nCand++; continue; }
    }
    if(far<farCap){ _placeFarTree(tx,ty,far); far++; }
  }

  // Pass 2 — spend the branch budget on the closest candidates, and demote the
  // rest to the cone canopy.
  if(nCand){
    _nearOrder.length=nCand;
    for(let k=0;k<nCand;k++) _nearOrder[k]=k;
    _nearOrder.sort((a,c)=>_nearCandD[a]-_nearCandD[c]);
    for(let k=0;k<nCand;k++){
      const packed=_nearCandT[_nearOrder[k]];
      const tx=packed%MAP_W, ty=(packed/MAP_W)|0;
      let placed=false;
      if(k<nearBudget) placed=_placeNearTree(tx,ty);
      if(!placed && far<farCap){ _placeFarTree(tx,ty,far); far++; }
    }
  }

  treeInstTile.length=far;
  markInst(trunkMesh,far);
  markInst(topMesh,_farNeedleN); markInst(topBroadMesh,_farBroadN);
  topMesh.instanceColor.needsUpdate=true;
  topBroadMesh.instanceColor.needsUpdate=true;
  topMesh.userData.instTile.length=_farNeedleN;
  topBroadMesh.userData.instTile.length=_farBroadN;
  // canopy-chop raycast early-outs on the bounding sphere — refresh it so it
  // matches the new windowed instances (else chopping misses after moving).
  trunkMesh.computeBoundingSphere();
  topMesh.computeBoundingSphere(); topBroadMesh.computeBoundingSphere();
  if(nearForest) for(const sp of nearForest.species){
    markInst(sp.bark,sp._n); markInst(sp.leaf,sp._n);
    sp.bark.userData.instTile.length=sp._n;
    sp.leaf.userData.instTile.length=sp._n;
    sp.bark.computeBoundingSphere(); sp.leaf.computeBoundingSphere();
  }
}
function rebuildStones() {
  let i=0; const cap=stoneMesh.instanceMatrix.count, b=_obsBounds();
  const q=new THREE.Quaternion(), eul=new THREE.Euler();
  for(let ty=b.ty0;ty<=b.ty1&&i<cap;ty++) for(let tx=b.tx0;tx<=b.tx1&&i<cap;tx++) {
    if(map[ty][tx]!==T.STONE) continue;
    if(!tileInView(tx,ty)) continue;
    // deterministic per-tile rotation + size so boulders don't look stamped
    const h1=_terrNoise(tx*7,ty*13), h2=_terrNoise(tx*31,ty*3);
    eul.set((h1-0.5)*0.4, h1*Math.PI*2, (h2-0.5)*0.35);
    q.setFromEuler(eul);
    _pos.set(tx*TILE+TILE/2, heightAt(tx*TILE+TILE/2, ty*TILE+TILE/2)+STONE_R*0.55, ty*TILE+TILE/2);
    _sc1.set(0.85+h1*0.4, 0.7+h2*0.55, 0.85+h2*0.4);
    _m4.compose(_pos,q,_sc1); stoneMesh.setMatrixAt(i++,_m4);
  }
  markInst(stoneMesh,i);
}
function rebuildIron() {
  let i=0; const cap=ironMesh.instanceMatrix.count, b=_obsBounds();
  const q=new THREE.Quaternion(), eul=new THREE.Euler();
  for(let ty=b.ty0;ty<=b.ty1&&i<cap;ty++) for(let tx=b.tx0;tx<=b.tx1&&i<cap;tx++) {
    if(map[ty][tx]!==T.ORE_IRON) continue;
    if(!tileInView(tx,ty)) continue;
    const h1=_terrNoise(tx*7,ty*13), h2=_terrNoise(tx*31,ty*3);
    eul.set((h1-0.5)*0.4, h1*Math.PI*2, (h2-0.5)*0.35);
    q.setFromEuler(eul);
    _pos.set(tx*TILE+TILE/2, heightAt(tx*TILE+TILE/2, ty*TILE+TILE/2)+STONE_R*0.55, ty*TILE+TILE/2);
    _sc1.set(0.85+h1*0.4, 0.7+h2*0.55, 0.85+h2*0.4);
    _m4.compose(_pos,q,_sc1); ironMesh.setMatrixAt(i++,_m4);
  }
  markInst(ironMesh,i);
}
const _placedCount = new Map();          // mesh → instances written this rebuild
function rebuildPlacedObjects() {
  let nFlame=0;
  const capFlame=placedFlameMesh.instanceMatrix.count;
  const addFlame=(x,y,z,s)=>{
    if(nFlame>=capFlame) return;
    _pos.set(x,y,z); _sc1.set(s,s,s); _m4.compose(_pos,_qId,_sc1);
    placedFlameMesh.setMatrixAt(nFlame++,_m4);
  };
  _placedCount.clear();
  const b=_obsBounds();
  for(const o of placedObjects){
    const def=PLACEABLES[o.type]; if(!def) continue;
    const tx=Math.floor(o.x/TILE), ty=Math.floor(o.y/TILE);
    if(tx<b.tx0||tx>b.tx1||ty<b.ty0||ty>b.ty1) continue;
    const mesh=def.mesh(), n=_placedCount.get(mesh)||0;
    if(n>=mesh.instanceMatrix.count) continue;
    const s=def.scale;
    // Flame only while lit, and it gutters through the last tenth of its fuel
    // so a fire visibly warns you before it dies.
    let fscale=0;
    if(def.flame && isLit(o)){
      const rem=burnRemaining(o), full=def.burn?def.burn.fuelSec:Infinity;
      fscale = def.flame.s * s * (rem<full*0.1 ? 0.45+0.55*(rem/(full*0.1)) : 1);
    }
    if(o.face && FACE_DIR[o.face]){
      // Wall mount: sit at the face height and lean out of the stone.
      const [ox,oy]=FACE_DIR[o.face];
      _eul.set(oy*WALL_TILT, 0, -ox*WALL_TILT);
      _q1.setFromEuler(_eul);
      const wGY = heightAt(o.x, o.y);
      _pos.set(o.x, wGY + o.mountY, o.y); _sc1.set(s,s,s);
      _m4.compose(_pos,_q1,_sc1); mesh.setMatrixAt(n,_m4);
      _placedCount.set(mesh, n+1);
      if(fscale>0){
        // Carry the flame along the tilted axis so it stays at the torch's head.
        const fl=(def.flame.y-def.y)*s, si=Math.sin(WALL_TILT), co=Math.cos(WALL_TILT);
        addFlame(o.x+ox*fl*si, wGY+o.mountY+fl*co, o.y+oy*fl*si, fscale);
      }
      continue;
    }
    // Ground height under the object. Wall-mounted pieces above use mountY,
    // which is measured from the wall they hang on, and the wall instances
    // already ride the terrain — so only the free-standing branch needs this.
    const oGY = heightAt(o.x, o.y);
    _pos.set(o.x, oGY + def.y*s, o.y); _sc1.set(s,s,s);
    _m4.compose(_pos,_qId,_sc1); mesh.setMatrixAt(n,_m4);
    _placedCount.set(mesh, n+1);
    if(fscale>0) addFlame(o.x, oGY + def.flame.y*s, o.y, fscale);
  }
  // Every registry mesh must be marked, including ones that drew nothing this
  // pass — otherwise a mesh keeps last window's count and ghosts stay on screen.
  for(const k in PLACEABLES){ const m=PLACEABLES[k].mesh(); markInst(m, _placedCount.get(m)||0); }
  markInst(placedFlameMesh,nFlame);
  rebuildWorldChests();
}
// World treasure chests are map features, not placed objects — drawn straight
// from WORLD_CHESTS, minus any the player has already emptied.
function rebuildWorldChests(){
  let n=0; const cap=lootChestMesh.instanceMatrix.count, b=_obsBounds();
  const looted=G.chestsLooted||{};
  for(const c of WORLD_CHESTS){
    if(n>=cap) break;
    if(looted[c.x+','+c.y]) continue;
    if(c.x<b.tx0||c.x>b.tx1||c.y<b.ty0||c.y>b.ty1) continue;
    const wx=c.x*TILE+TILE/2, wz=c.y*TILE+TILE/2;
    // World chests aren't in PLACEABLES (they're map features, not player-placed)
    // so they need their own scale — same pre-OBJ_SCALE problem, 24u wide against
    // a 126u character. ×2.6 → ~0.9m, a chest you'd actually stoop to open.
    const s=(c.hoard?1.35:1)*2.6;
    _pos.set(wx,7*s,wz); _sc1.set(s,s,s); _m4.compose(_pos,_qId,_sc1);
    lootChestMesh.setMatrixAt(n,_m4);
    _pos.set(wx,14.5*s,wz); _m4.compose(_pos,_qId,_sc1);
    lootChestLidMesh.setMatrixAt(n,_m4);
    n++;
  }
  markInst(lootChestMesh,n); markInst(lootChestLidMesh,n);
}
// Every CAVE_WALL tile on the map, packed, built once. Cave walls are static --
// only the editor ever paints one -- so rescanning the window for them each
// rebuild was work that could be done a single time instead.
//
// This is what makes the fog-reach window below affordable. Scanning a
// fog-sized rectangle would be ~131k tile reads per re-window against ~11k for
// the old short one; walking a known list is O(number of walls) and does not
// care how far the window reaches at all.
let _caveTiles = null;
function _buildCaveList(){
  const out=[];
  for(let ty=0;ty<MAP_H;ty++){ const row=map[ty];
    for(let tx=0;tx<MAP_W;tx++) if(row[tx]===T.CAVE_WALL) out.push(ty*MAP_W+tx); }
  _caveTiles = Int32Array.from(out);
}
function rebuildCave() {
  if(!_caveTiles) _buildCaveList();
  let i=0; const cap=caveMesh.instanceMatrix.count;
  // REACH THE FOG, not the shared obstacle window. A cave wall has no far-LOD
  // standing behind the window the way distant terrain and blocky far trees do
  // outdoors, so if it is culled while still unfogged it just disappears and
  // leaves open sky. Measured before this: walls ended at 4793 units with fog
  // only starting at 4578 -- a 5% fade, i.e. none. Reading fog.far live rather
  // than copying the number is the point: the two cannot drift apart again.
  const _fogFar = scene.fog ? scene.fog.far : 0;
  const b=_obsBounds(Math.max(_view.far, _fogFar));
  const q=new THREE.Quaternion(), eul=new THREE.Euler();
  for(let k=0;k<_caveTiles.length && i<cap;k++){
    const packed=_caveTiles[k], ty=(packed/MAP_W)|0, tx=packed-ty*MAP_W;
    if(tx<b.tx0||tx>b.tx1||ty<b.ty0||ty>b.ty1) continue;
    const n1=_terrNoise(tx*11, ty*19), n2=_terrNoise(tx*23, ty*7);
    const varH = CAVEH + (n1 - 0.5) * 8;
    eul.set((n1-0.5)*0.05, n2*Math.PI*2, (n2-0.5)*0.05);
    q.setFromEuler(eul);
    _pos.set(tx*TILE+TILE/2 + (n1-0.5)*3, heightAt(tx*TILE+TILE/2, ty*TILE+TILE/2) + varH/2, ty*TILE+TILE/2 + (n2-0.5)*3);
    _sc1.set(TILE*(0.96+n1*0.08), varH, TILE*(0.96+n2*0.08));
    _m4.compose(_pos, q, _sc1); caveMesh.setMatrixAt(i, _m4);
    caveInstTile[i]=packed;
    i++;
  }
  caveInstTile.length=i;
  markInst(caveMesh,i);
  caveMesh.computeBoundingSphere();
}
function updateObstacles() {
  // Re-window instances when the player crosses into a new area (or on the
  // first frame, when the centre is still 1e12 away).
  updateViewCone();
  // The window now depends on where the camera LOOKS, not just where the player
  // stands, so turning must re-window too — otherwise you spin on the spot and
  // the world stays culled to the heading you arrived on. Threshold is coarse
  // (~11 degrees) because the wedge carries VIEW_MARGIN of slack; rebuilding on
  // every mouse tremor would restore the stutter the staggering below exists to
  // avoid.
  const camMoved = Math.abs(player.x-_obsCx)>TILE*4 || Math.abs(player.y-_obsCy)>TILE*4;
  const camTurned = Math.abs(((camAngle-_obsAngle+Math.PI*3)%(Math.PI*2))-Math.PI) > 0.20;
  const camZoomed = Math.abs(camZoom-_obsZoom) > 0.18;
  if(camMoved || camTurned || camZoomed || camModeDirty){
    camModeDirty=false;
    _obsCx=player.x; _obsCy=player.y; _obsAngle=camAngle; _obsZoom=camZoom;
    wallDirty=treeDirty=stoneDirty=ironDirty=caveDirty=customDirty=waterDirty=bridgeDirty=placedObjectsDirty=true;
    _grassDirty=true;
  }
  // Rebuild at most one obstacle type per frame. Re-windowing all seven at
  // once (esp. thousands of cave/tree instances) caused a stutter every few
  // tiles of movement; staggering spreads it over ~7 frames (~0.1s), and the
  // old instances stay valid meanwhile since the window only shifted a little.
  if(wallDirty)       { rebuildWalls();      wallDirty=false;   }
  else if(treeDirty)  { rebuildTrees();      treeDirty=false;   }
  else if(stoneDirty) { rebuildStones();     stoneDirty=false;  }
  else if(ironDirty)  { rebuildIron();       ironDirty=false;   }
  else if(caveDirty)  { rebuildCave();       caveDirty=false;   }
  else if(waterDirty) { rebuildWater();      waterDirty=false;  }
  else if(bridgeDirty){ rebuildBridges();    bridgeDirty=false; }
  else if(customDirty){ rebuildCustomTiles();customDirty=false; }
  else if(placedObjectsDirty){ rebuildPlacedObjects();placedObjectsDirty=false; }
}

// Local lights pool for nearby campfires/forges/torches/lanterns/arches.
// decay 0: three r155+ uses physical (1/d^decay) falloff where legacy
// intensities vanish within a few units — decay 0 gives a full-strength
// pool that fades smoothly to zero at the light's `distance` cutoff.
// How a flame's brightness actually behaves, as a function of TIME rather than
// of frames. Three sines whose frequencies share no common factor never line up
// into an audible-looking beat, and summing them costs a few multiplies.
//
// `ph` is derived from the light's own position, so a given torch flickers the
// same way from frame to frame and two torches side by side are out of step —
// which is what stops a lit corridor pulsing as one object.
function flameFlicker(t, ph){
  const base = 0.80
             + 0.11 * Math.sin(t *  7.3 + ph)
             + 0.07 * Math.sin(t * 11.9 + ph * 1.7)
             + 0.05 * Math.sin(t * 19.1 + ph * 0.6);
  // The gutter: a slow term that mostly sits at zero and occasionally dips the
  // flame hard, as though a draught caught it. This is the part that reads as
  // fire rather than as a dimmer being wobbled.
  const g = Math.sin(t * 1.7 + ph * 2.3) * Math.sin(t * 0.9 + ph);
  const gutter = g > 0.62 ? (g - 0.62) / 0.38 : 0;
  return base * (1 - 0.34 * gutter);
}
const placementLights = [];
const MAX_PLACEMENT_LIGHTS = 16;
for (let i = 0; i < MAX_PLACEMENT_LIGHTS; i++) {
  const pl = new THREE.PointLight(0xff7722, 0.0, TILE * 6, 0);
  scene.add(pl);
  placementLights.push(pl);
}

// ── Shared world clock ────────────────────────────────────────────
// gameTime used to be a per-session counter starting at 0, so every browser
// began its own day at 00:00 on load and no two players saw the same sky.
// It's now derived from wall-clock seconds — identical on every client, and
// nudged onto the server's clock when online. Epoch seconds tick at exactly
// the rate the cycle expects (DAY_CYCLE_SEC real seconds = one game day), and
// because it's absolute the moon phase agrees for everyone too.
// `_timeShift` holds dev-panel skips so they survive the per-frame refresh.
let worldTimeOffset = 0;     // serverNow - localNow, set from the server on join
let _timeShift = 0;          // manual offset from the dev day/night + moon buttons
// Screenshot support (_dev.freezeTime). The clock is derived from Date.now(),
// so a capture session that takes 30s moves the sun between the "before" and
// "after" shot and the comparison is worthless. Frozen, worldNow() returns a
// fixed instant; the dev time controls below shift THAT value instead of
// _timeShift, so setHour/toggleTime/advanceMoon still work while frozen.
let _timeFrozen = null;
function worldNow(){
  return _timeFrozen !== null ? _timeFrozen
                              : Date.now()/1000 + worldTimeOffset + _timeShift;
}
// One entry point for every dev control that moves the clock, so none of them
// have to know whether time is frozen.
function shiftWorldTime(sec){
  if(_timeFrozen !== null) _timeFrozen += sec; else _timeShift += sec;
  G.gameTime = worldNow();
}
function setServerWorldTime(t){
  if(!(t>0)) return;
  worldTimeOffset = t - Date.now()/1000;
  G.gameTime = worldNow();
}

function updateEnvironmentCycle(dt) {
  // `time` is 0 at midnight and 0.5 at noon — the same mapping drawTimeClock
  // uses. Keep the light windows below in agreement with the clock, or you
  // get daylight at 3am (which is exactly what this used to do).
  //   night 20:00-04:00 · dawn 04:00-07:00 · day 07:00-18:00 · dusk 18:00-20:00
  const time = (G.gameTime % DAY_CYCLE_SEC) / DAY_CYCLE_SEC;
  const DAWN0=4/24, DAWN1=7/24, DUSK0=18/24, DUSK1=20/24;
  let dayF;                                   // 1 = full daylight, 0 = full night
  if (time < DAWN0)      dayF = 0;
  else if (time < DAWN1) dayF = (time - DAWN0) / (DAWN1 - DAWN0);
  else if (time < DUSK0) dayF = 1;
  else if (time < DUSK1) dayF = 1 - (time - DUSK0) / (DUSK1 - DUSK0);
  else                   dayF = 0;
  const nightFactor = 1 - dayF;

  // ── Moon phase cycle (8 phases over 8 day/night cycles) ──
  // Phase 0=New, 1=Waxing Crescent, 2=First Quarter, 3=Waxing Gibbous,
  // 4=Full, 5=Waning Gibbous, 6=Last Quarter, 7=Waning Crescent
  // 4 in-game days per lunar cycle, i.e. a phase every half-day (~12 real
  // minutes). At 8 days the full cycle took 3.2 real hours, so a session only
  // ever saw one phase — land on a new moon and *every* night was pitch black
  // with no sign the other phases existed.
  const MOON_CYCLE = DAY_CYCLE_SEC * 4;
  const moonProgress = (G.gameTime % MOON_CYCLE) / MOON_CYCLE;
  const moonPhaseIdx = Math.floor(moonProgress * 8) % 8;
  G.moonPhase = moonPhaseIdx;
  const phaseBright = [0.0, 0.25, 0.5, 0.75, 1.0, 0.75, 0.5, 0.25][moonPhaseIdx];
  G.moonBright = phaseBright;

  // Night brightness is driven almost entirely by the moon: a new moon really
  // is pitch black, a full moon is comfortably navigable. (Previously every
  // phase clamped to ~0.15 ambient, so they all looked identically black.)
  // New moon stays the "bring a torch" night, but 0.05 rendered as an
  // unreadable black screen; 0.09 still reads as pitch dark while leaving
  // enough shape to walk by. Full moon is comfortably navigable.
  const NIGHT_AMB_NEW = 0.09, NIGHT_AMB_FULL = 0.34;
  const nightAmb = NIGHT_AMB_NEW + (NIGHT_AMB_FULL - NIGHT_AMB_NEW) * phaseBright;
  // Was 0.65, which existed to fake skylight back when nothing received image-
  // based lighting. A real sky env map now supplies that from the correct
  // direction and colour, so keeping 0.65 on top of it double-counted the sky
  // and blew the whole daylit scene out to near-white.
  // Only the DAY end moves: at night dayF is 0, so the carefully tuned
  // new-moon 0.09 / full-moon 0.34 values below are reached unchanged.
  const DAY_AMB = 0.20;
  const nightCol = new THREE.Color(0x0c102b), dayCol = new THREE.Color(0xffeedd);

  const ambientCol = new THREE.Color().lerpColors(nightCol, dayCol, dayF);
  const ambientInt = nightAmb + (DAY_AMB - nightAmb) * dayF;
  ambientLight.color.copy(ambientCol);
  ambientLight.intensity = ambientInt;

  // Sun fades through a warm horizon colour at dawn/dusk
  const horizon = new THREE.Color(0xff8844), noonCol = new THREE.Color(0xfffde0);
  const sunCol = new THREE.Color().lerpColors(horizon, noonCol, Math.min(1, dayF * 1.6));
  sun.color.copy(sunCol);
  sun.intensity = 0.85 * dayF;

  // Moonlight scales straight off the phase — none at all on a new moon.
  moon.intensity = nightFactor * (0.05 + 0.60 * phaseBright);

  // Windows light up after dark removed (performance optimization).

  // Image-based lighting follows the sky: full by day, a faint moonlit sheen
  // at night (scaled by phase) so metal still catches a highlight without
  // lifting the darkness.
  // Scaled back alongside DAY_AMB. The Preetham sky is a far brighter source
  // than the old 64x256 canvas gradient this replaced, so the same intensity
  // number means considerably more light than it used to.
  _envIntensity = 0.10 + 0.42*dayF + (1-dayF)*0.12*phaseBright;
  applyEnvIntensity(_envIntensity);

  // Sun peaks at noon, is below the horizon at midnight; moon opposes it.
  const angle = (time - 0.25) * Math.PI * 2;
  sun.position.set(player.x + Math.cos(angle) * 2000, Math.sin(angle) * 2000 + 1000, player.y + Math.sin(angle) * 1000);
  sun.target.position.set(player.x, heightAt(player.x,player.y), player.y);
  sun.target.updateMatrixWorld();
  moon.position.set(player.x - Math.cos(angle) * 2000, -Math.sin(angle) * 2000 + 1000, player.y - Math.sin(angle) * 1000);
  // Aim it at the player, exactly as the sun does above. Without this the target
  // stays at the world origin and the moon lights from the wrong direction.
  moon.target.position.set(player.x, heightAt(player.x, player.y), player.y);
  moon.target.updateMatrixWorld();

  // Drive the sky from the same angle the sun light uses, so the sun disc is
  // never somewhere the shadows disagree with.
  _sunDir.set(sun.position.x-player.x, sun.position.y, sun.position.z-player.y).normalize();
  _envSunCol.copy(sunCol); _envDayF = dayF;
  sky.update({ sunDir:_sunDir, dayF, moonPhase:moonPhaseIdx, moonBright:phaseBright,
               cameraPos:camera.position, gameTime:G.gameTime, dt });

  // Fog colour is now SAMPLED from the sky rather than hand-lerped between two
  // constants. That's what makes the horizon seam invisible: terrain fades out
  // into exactly the colour the sky is painting behind it, at every hour,
  // instead of into a fixed green that only matched at noon.
  const fogCol = sky.horizonColor();
  scene.fog.color.copy(fogCol);
  if(scene.background && scene.background.isColor) scene.background.copy(fogCol);
  renderer.setClearColor(fogCol);
  
  const curTile = map[Math.floor(player.y/TILE)]?.[Math.floor(player.x/TILE)];
  const inCave = curTile === T.CAVE_FLOOR || curTile === T.CAVE_ENTRANCE || curTile === T.CAVE_WALL || player.y >= DUNGEON_Y0 * TILE;
  const inHouse = isInsidePlacedHouse(Math.floor(player.x/TILE), Math.floor(player.y/TILE));
  
  const hasTorch = player.weapon === 'torch' && (inv.torch || 0) > 0;
  const hasLantern = player.weapon === 'lantern' && (inv.lantern || 0) > 0;

  if (player.race === 'Vampire' && (inCave || inHouse || nightFactor > 0.01)) {
    // Vampire Night Vision: Sees in the dark with a glowing crimson/violet aura
    playerLight.intensity = 0.85;
    playerLight.color.setHex(0xe06075);
    playerLight.distance = TILE * 14;
    if (nightFactor > 0.01) {
      ambientLight.intensity = Math.max(ambientLight.intensity, 0.45);
    }
  } else if (hasLantern) {
    playerLight.intensity = 1.0;
    playerLight.color.setHex(0xffeedd);
    playerLight.distance = TILE * 14;
  } else if (hasTorch) {
    // Was `0.85 + Math.random() * 0.3`, re-rolled every frame. The placed-light
    // pool was moved off that; this one was missed, so the torch in your own
    // hand — the light you spend the whole night looking at — was the only one
    // still flickering at the frame rate, which is to say not visibly at all.
    const flicker = flameFlicker(_fireU.value, 11.7);
    playerLight.intensity = 0.9 * flicker;
    playerLight.color.setHex(0xffaa44);
    playerLight.distance = TILE * 9;
  } else if (inCave || inHouse || nightFactor > 0.01) {
    // Dim fallback so players aren't completely blinded but need a light source
    playerLight.intensity = 0.35;
    playerLight.color.setHex(0xaaaaaa);
    playerLight.distance = TILE * 2.5;
  } else {
    playerLight.intensity = 0.0;
  }
  playerLight.position.set(player.x, heightAt(player.x,player.y) + 18, player.y);
  
  // Placed lights: campfires, forges, torches, hearths, lanterns
  // isLit(), not just "is a light type" — a doused campfire has to go dark.
  const lightSources = placedObjects.filter(o => PLACEABLE_LIGHTS.has(o.type) && isLit(o))
    .map(o => ({ type: o.type, x: o.x, y: o.y }));

  // Cave-mouth arch torches glow too (one light per archway)
  for (const a of archLightSrcs) lightSources.push({ type: 'arch', x: a.x, y: a.y });

  // House interior light sources at night
  if (G.placedHouses) {
    for (const h of G.placedHouses) {
      const hcx = (h.x0 + h.size/2) * TILE;
      const hcy = (h.y0 + h.size/2) * TILE;
      lightSources.push({ type: 'house_light', x: hcx, y: hcy });
    }
  }

  lightSources.forEach(o => {
    o.dist = Math.hypot(o.x - player.x, o.y - player.y);
  });
  lightSources.sort((a,b) => a.dist - b.dist);
  
  for (let i = 0; i < MAX_PLACEMENT_LIGHTS; i++) {
    const pl = placementLights[i];
    const src = lightSources[i];
    if (src && src.dist < TILE * 24) {
      const type = src.type;
      const isTorch = type === 'torch' || type === 'arch';
      const isHearth = type === 'hearth';
      const isLantern = type === 'lantern';
      const isHouseLight = type === 'house_light';

      let baseY = 12;
      let baseInt = 1.2;
      let colorHex = 0xff7722;
      let dist = TILE * 6;

      if (type === 'arch') {
        baseY = 62; baseInt = 1.0; colorHex = 0xffa040; dist = TILE * 7;
      } else if (isTorch) {
        baseY = 28; baseInt = 1.1; colorHex = 0xff9944; dist = TILE * 7;
      } else if (isHearth) {
        baseY = 14; baseInt = 1.4; colorHex = 0xff6622; dist = TILE * 8;
      } else if (isLantern) {
        baseY = 8; baseInt = 1.2; colorHex = 0xffeedd; dist = TILE * 10;
      } else if (isHouseLight) {
        baseY = 24; baseInt = 1.2 * nightFactor; colorHex = 0xffeedd; dist = TILE * 8;
      } else if (type === 'campfire') {
        baseY = 6; baseInt = 1.3; colorHex = 0xff7722; dist = TILE * 7;
      }

      pl.position.set(src.x, baseY, src.y);
      pl.color.setHex(colorHex);
      pl.distance = dist;

      if (isTorch || isHearth || type === 'campfire') {
        // Was `0.85 + Math.random() * 0.3`, re-rolled every frame — see
        // flameFlicker's note. Phase comes from the source position so it is
        // stable per torch and different between neighbours.
        const flicker = flameFlicker(_fireU.value, (src.x * 0.013 + src.y * 0.021));
        if (inCave || inHouse || isHearth || type === 'arch') {
          pl.intensity = baseInt * flicker;
        } else {
          pl.intensity = baseInt * flicker * (nightFactor > 0.3 ? 1.0 : Math.max(0.35, nightFactor));
        }
      } else if (isHouseLight) {
        pl.intensity = baseInt;
      } else if (inCave || inHouse) {
        pl.intensity = baseInt;
      } else {
        pl.intensity = baseInt * (nightFactor > 0.4 ? nightFactor : nightFactor * 0.5);
      }
    } else {
      pl.intensity = 0.0;
    }
  }
}

// ── Animated water ────────────────────────────────────────────────
// Japanese woodblock-print waves (loaded from water_texture.png):
// Deep navy base with beige and cream foam-capped waves in Hokusai style.
// Loads asynchronously and updates the canvas-backed texture for compatibility.
const waterTex = (() => {
  const S = 512;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  
  // Solid placeholder color while the image loads
  x.fillStyle = '#0f2447'; x.fillRect(0,0,S,S);
  
  const img = new Image();
  img.src = 'water_texture.png';
  img.onload = () => {
    // If the editor has cloned default skins, update the default copy too so resetting works correctly
    if (typeof _skinDefaults !== 'undefined' && _skinDefaults.water) {
      const sdx = _skinDefaults.water.getContext('2d');
      sdx.drawImage(img, 0, 0, _skinDefaults.water.width, _skinDefaults.water.height);
    }
    // Only paint over the active texture if the player hasn't custom-painted it
    if (typeof worldEdits === 'undefined' || !worldEdits.skins.water) {
      x.drawImage(img, 0, 0, S, S);
      tex.needsUpdate = true;
    }
  };
  
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;   // render the true navy, not linear-brightened
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.5,0.5);   // one pattern spans 2×2 tiles → chunkier waves
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
})();
// ── Water surface ─────────────────────────────────────────────────
// A grid of square quads can only ever have square banks — the old 1.32×
// shore scale just overlapped the corners without removing them. Instead the
// river is ONE quad covering the render window, and its shape comes entirely
// from a coverage mask sampled through the same warp field as the ground. The
// bank is wherever the mask crosses 0.5, so it wanders and curves freely, and
// the painted bank underneath lines up because it used the identical field.
// What the water SURFACE covers. SHALLOWS and DOCK are wet: a pier stands in
// the sea and the sea has to be drawn under it, and shallows that the surface
// skipped would read as a dry blue-grey stripe along every beach.
const _isWaterTile = t => t===T.WATER||t===T.BRIDGE||t===T.SHALLOWS||t===T.DOCK;
const WMASK_PX = 4;    // mask texels per tile (12 world units each)
const wMaskCanvas = document.createElement('canvas');
wMaskCanvas.width = MAP_W*WMASK_PX; wMaskCanvas.height = MAP_H*WMASK_PX;
const wMaskCtx = wMaskCanvas.getContext('2d');
// A 45° river in the source map is a run of whole-tile steps. Noise warping can
// wobble a step but cannot remove one that large, so the mask is not read off the
// tile grid directly — it is read off a *blurred* water field. Blurring turns the
// staircase into a ramp whose 0.5 contour is a smooth diagonal; the warp then
// bends that contour so it reads as a natural bank rather than a drafted curve.
//
// Blur-then-threshold normally erodes thin features. Measured on this map only
// 0.6% of water tiles (41 of 6405) sit below the 0.5 contour, so rather than
// weaken the blur, real water tiles get floored at WFIELD_KEEP: corners still
// round off, but a tile that IS water can never render dry. That matters beyond
// looks — `map` and collision are untouched here, so a gap would be water you
// still cannot walk through.
const WFIELD_R = 2;          // wider blur -> broader, softer banks
const WIDEN = 1.10;         // slight, just softens the bank; width comes from RIVER_WIDEN_R         // blur radius, tiles
const WFIELD_KEEP = 0.52;   // floor for real water tiles — just above the contour
const WEDGE = 0.16;         // contour softness → antialiased bank
let _wField = null;
// Distance from each water tile to the nearest dry tile, in tiles. Chamfer
// transform: two sweeps, forward then backward, propagating a running minimum
// through the eight neighbours. Exact Euclidean distance would need a much more
// elaborate algorithm for a result that differs by a few percent on the
// diagonals -- and this feeds a smoothstep, so a few percent is nothing.
//
// Dry tiles seed at 0 and water starts at infinity. Map-edge water never gets
// seeded from outside the map, so it stays large and reads as deep, which is
// the right answer for a river running off the edge of the world.
let _wShore = null;
const SHORE_TILES = 3.0;   // distance over which "at the bank" becomes "deep"
function buildShoreDist(bin){
  const N = MAP_W*MAP_H, D = new Float32Array(N), BIG = 1e9;
  for(let i=0;i<N;i++) D[i] = bin[i] ? BIG : 0;
  const A = 1.0, B = 1.4142136;   // orthogonal and diagonal step costs
  for(let y=0;y<MAP_H;y++){ const r=y*MAP_W, rm=r-MAP_W;
    for(let x=0;x<MAP_W;x++){ const i=r+x; let v=D[i]; if(v===0) continue;
      if(x>0) v=Math.min(v, D[i-1]+A);
      if(y>0){ v=Math.min(v, D[rm+x]+A);
        if(x>0)       v=Math.min(v, D[rm+x-1]+B);
        if(x<MAP_W-1) v=Math.min(v, D[rm+x+1]+B); }
      D[i]=v; } }
  for(let y=MAP_H-1;y>=0;y--){ const r=y*MAP_W, rp=r+MAP_W;
    for(let x=MAP_W-1;x>=0;x--){ const i=r+x; let v=D[i]; if(v===0) continue;
      if(x<MAP_W-1) v=Math.min(v, D[i+1]+A);
      if(y<MAP_H-1){ v=Math.min(v, D[rp+x]+A);
        if(x>0)       v=Math.min(v, D[rp+x-1]+B);
        if(x<MAP_W-1) v=Math.min(v, D[rp+x+1]+B); }
      D[i]=v; } }
  _wShore = D;
}
// Bilinear, tile centres at +0.5 -- the same convention as _sampleWField, so
// depth and coverage are read off the same grid alignment.
function _sampleShore(fx, fy){
  const x=fx-0.5, y=fy-0.5;
  let x0=Math.floor(x), y0=Math.floor(y);
  const ax=x-x0, ay=y-y0;
  let x1=x0+1, y1=y0+1;
  if(x0<0)x0=0; else if(x0>MAP_W-1)x0=MAP_W-1;
  if(x1<0)x1=0; else if(x1>MAP_W-1)x1=MAP_W-1;
  if(y0<0)y0=0; else if(y0>MAP_H-1)y0=MAP_H-1;
  if(y1<0)y1=0; else if(y1>MAP_H-1)y1=MAP_H-1;
  const f=_wShore, r0=y0*MAP_W, r1=y1*MAP_W;
  const v0=f[r0+x0]+(f[r0+x1]-f[r0+x0])*ax;
  const v1=f[r1+x0]+(f[r1+x1]-f[r1+x0])*ax;
  const d=v0+(v1-v0)*ay;
  return d >= SHORE_TILES ? 1 : d/SHORE_TILES;
}
function buildWaterField(){
  const N=MAP_W*MAP_H;
  const bin=new Float32Array(N), tmp=new Float32Array(N), out=new Float32Array(N);
  for(let y=0;y<MAP_H;y++) for(let x=0;x<MAP_W;x++) bin[y*MAP_W+x]=_isWaterTile(map[y][x])?1:0;
  for(let y=0;y<MAP_H;y++){ const r=y*MAP_W;          // horizontal pass
    for(let x=0;x<MAP_W;x++){ let s=0,n=0;
      for(let d=-WFIELD_R;d<=WFIELD_R;d++){ const xx=x+d; if(xx<0||xx>=MAP_W) continue; s+=bin[r+xx]; n++; }
      tmp[r+x]=s/n; } }
  for(let y=0;y<MAP_H;y++) for(let x=0;x<MAP_W;x++){   // vertical pass
    let s=0,n=0;
    for(let d=-WFIELD_R;d<=WFIELD_R;d++){ const yy=y+d; if(yy<0||yy>=MAP_H) continue; s+=tmp[yy*MAP_W+x]; n++; }
    const i=y*MAP_W+x;
    // WIDEN pushes the 0.5 contour outward, which is what actually broadens
    // the river — the mask contour IS the bank, for both the visual silhouette
    // and the wading logic that reads the same field.
    out[i] = bin[i] ? Math.max(s/n * WIDEN, WFIELD_KEEP) : s/n * WIDEN;
  }
  _wField=out;
  // Same binary field, so depth and coverage can never disagree about which
  // tiles are water.
  buildShoreDist(bin);
}
function _sampleWField(fx, fy){          // bilinear; tile centres sit at +0.5
  const x=fx-0.5, y=fy-0.5;
  let x0=Math.floor(x), y0=Math.floor(y);
  const ax=x-x0, ay=y-y0;
  let x1=x0+1, y1=y0+1;
  if(x0<0)x0=0; else if(x0>MAP_W-1)x0=MAP_W-1;
  if(x1<0)x1=0; else if(x1>MAP_W-1)x1=MAP_W-1;
  if(y0<0)y0=0; else if(y0>MAP_H-1)y0=MAP_H-1;
  if(y1<0)y1=0; else if(y1>MAP_H-1)y1=MAP_H-1;
  const f=_wField, r0=y0*MAP_W, r1=y1*MAP_W;
  const v0=f[r0+x0]+(f[r0+x1]-f[r0+x0])*ax;
  const v1=f[r1+x0]+(f[r1+x1]-f[r1+x0])*ax;
  return v0+(v1-v0)*ay;
}
// The mask reads through both the blur (WFIELD_R) and the warp (WARP_R), so its
// interior test has to clear a wider neighbourhood than the ground's.
function _maskInterior(tx, ty){
  const R = WARP_R + WFIELD_R + 1;
  const w0 = _isWaterTile(map[ty][tx]);
  for(let oy=-R;oy<=R;oy++){
    const row=map[ty+oy]; if(!row) return false;
    for(let ox=-R;ox<=R;ox++) if(_isWaterTile(row[tx+ox])!==w0) return false;
  }
  return true;
}
// Repaint a tile rect of the mask. Region-capable so a live editor edit costs a
// small patch instead of re-baking 4M texels.
function paintWaterMask(tx0, ty0, tx1, ty1){
  tx0=Math.max(0,tx0); ty0=Math.max(0,ty0);
  tx1=Math.min(MAP_W-1,tx1); ty1=Math.min(MAP_H-1,ty1);
  if(tx1<tx0||ty1<ty0) return;
  const w=(tx1-tx0+1)*WMASK_PX, h=(ty1-ty0+1)*WMASK_PX;
  const img = wMaskCtx.createImageData(w,h), d = img.data;
  for(let ty=ty0;ty<=ty1;ty++) for(let tx=tx0;tx<=tx1;tx++){
    const w0 = _isWaterTile(map[ty][tx]);
    const interior = _maskInterior(tx,ty);
    for(let py=0;py<WMASK_PX;py++) for(let px=0;px<WMASK_PX;px++){
      const gx = tx*WMASK_PX+px, gy = ty*WMASK_PX+py;      // global — keeps noise stable
      let a, sh;
      if(interior){
        a = w0?255:0;
        // Provably saturated -- see the note on SHORE_TILES. Skipping the warp
        // here is what keeps the interior fast path fast, and it cannot open a
        // seam because both branches land on the same 1.0.
        sh = w0?255:0;
      } else{
        const fx=(gx+0.5)/WMASK_PX, fy=(gy+0.5)/WMASK_PX;
        const o=_warpOffset(fx,fy,gx,gy);
        const cov=_sampleWField(fx+o[0], fy+o[1]);
        let v=(cov-0.5)/WEDGE+0.5;                        // soften the contour
        a = v<=0 ? 0 : v>=1 ? 255 : v*255;
        // Depth is sampled through the SAME warp offset as coverage, so the
        // shore ramp stays registered with the ragged bank it belongs to.
        sh = _sampleShore(fx+o[0], fy+o[1])*255;
      }
      const i=((gy-ty0*WMASK_PX)*w + (gx-tx0*WMASK_PX))*4;
      // RED   = distance from the bank: 0 at the contour, 1 three tiles in.
      // GREEN = coverage, the silhouette. Unchanged, and it must stay that way:
      //         the painted bank and the wading test both read this channel.
      d[i]=sh; d[i+1]=d[i+2]=a; d[i+3]=255;
    }
  }
  wMaskCtx.putImageData(img, tx0*WMASK_PX, ty0*WMASK_PX);
}
buildWaterField();
paintWaterMask(0,0,MAP_W-1,MAP_H-1);
const wMaskTex = new THREE.CanvasTexture(wMaskCanvas);
wMaskTex.flipY = false;                  // row 0 of the canvas is tile row 0
wMaskTex.magFilter = THREE.LinearFilter;  // smooth the quarter-tile texels into a soft bank
wMaskTex.minFilter = THREE.LinearMipMapLinearFilter;
wMaskTex.wrapS = wMaskTex.wrapT = THREE.ClampToEdgeWrapping;
wMaskTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

// Was an unlit MeshBasicMaterial — the river took no light at all, which is
// why it stayed the same flat navy at noon and at midnight. The replacement is
// a lit ShaderMaterial; the coverage mask contract is unchanged, so the
// silhouette still agrees with the painted bank and with collision.
const water = createWaterMaterial({ THREE, renderer, waterTex, maskTex:wMaskTex, settings:QS });
const waterMat = water.material;
// UVs are global map coords (0..1 across the whole world), so the wave pattern
// keeps a fixed world scale no matter where the window sits — no offset juggling.
waterTex.repeat.set(MAP_W*0.5, MAP_H*0.5);

const _wGeo = new THREE.BufferGeometry();
_wGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12),3));
_wGeo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(8),2));
_wGeo.setIndex([0,1,2, 2,1,3]);
const waterMesh = new THREE.Mesh(_wGeo, waterMat);
waterMesh.renderOrder = 1;
waterMesh.frustumCulled = false;   // corners rewritten per rebuild → stale auto sphere
scene.add(waterMesh);
let waterDirty = true;
function rebuildWater() {
  const b=_obsBounds();
  // Cover the render window only — a full-map plane would cost a transparent
  // full-screen pass everywhere, including deserts with no water in sight.
  const x0=b.tx0*TILE, x1=(b.tx1+1)*TILE, z0=b.ty0*TILE, z1=(b.ty1+1)*TILE;
  const p=_wGeo.attributes.position, u=_wGeo.attributes.uv;
  const MW=MAP_W*TILE, MH=MAP_H*TILE;
  const set=(i,x,z)=>{ p.array[i*3]=x; p.array[i*3+1]=2; p.array[i*3+2]=z;
                       u.array[i*2]=x/MW; u.array[i*2+1]=z/MH; };
  set(0,x0,z0); set(1,x1,z0); set(2,x0,z1); set(3,x1,z1);
  p.needsUpdate=true; u.needsUpdate=true;
  _wGeo.computeBoundingSphere();
}

// ── Bridge decks + rails ──────────────────────────────────────────
// Bridges used to be just a tinted tile *under* the animated water plane,
// making them nearly invisible. Now each BRIDGE tile gets a raised plank
// deck, with wooden rails along every edge that borders open water.
let nBridge=0;
// DOCK counts here too: a pier is a bridge over the sea by another name, and
// without a raised deck it would be a tinted tile UNDER the water surface —
// which is exactly how bridges used to be nearly invisible.
for (let ty=0;ty<MAP_H;ty++) for (let tx=0;tx<MAP_W;tx++)
  if(map[ty][tx]===T.BRIDGE||map[ty][tx]===T.DOCK) nBridge++;
const deckMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(TILE,4,TILE),
  new THREE.MeshStandardMaterial({map:bridgeTex, roughness:0.85, metalness:0.0}), nBridge+800);
const railMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(TILE,9,4),
  new THREE.MeshStandardMaterial({color:0x5a3818, roughness:0.8, metalness:0.0}), (nBridge+800)*4);
deckMesh.receiveShadow=true; railMesh.castShadow=true;
deckMesh.frustumCulled=false; railMesh.frustumCulled=false;   // windowed → skip whole-mesh cull
scene.add(deckMesh, railMesh);
let bridgeDirty = true;
function rebuildBridges() {
  const q0=new THREE.Quaternion();
  const q90=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2);
  let di=0, ri=0;
  const dCap=deckMesh.instanceMatrix.count, rCap=railMesh.instanceMatrix.count, b=_obsBounds();
  const rail=(x,z,q)=>{ if(ri>=rCap)return; _pos.set(x,8.5,z); _sc1.set(1,1,1); _m4.compose(_pos,q,_sc1); railMesh.setMatrixAt(ri++,_m4); };
  for (let ty=b.ty0;ty<=b.ty1&&di<dCap;ty++) for (let tx=b.tx0;tx<=b.tx1&&di<dCap;tx++) {
    const dt=map[ty][tx];
    if(dt!==T.BRIDGE&&dt!==T.DOCK) continue;
    const cx=tx*TILE+TILE/2, cz=ty*TILE+TILE/2;
    _pos.set(cx,2.5,cz); _sc1.set(1,1,1); _m4.compose(_pos,q0,_sc1); deckMesh.setMatrixAt(di++,_m4);
    // rails only on edges facing water — works for any width/orientation.
    // SHALLOWS counts: a pier runs out across the wadeable strip before it ever
    // reaches deep water, and railing only the deep end leaves the first half of
    // every pier bare.
    const wet = t => t===T.WATER||t===T.SHALLOWS;
    if(wet(map[ty][tx-1])) rail(tx*TILE+2.5,      cz, q90);
    if(wet(map[ty][tx+1])) rail(tx*TILE+TILE-2.5, cz, q90);
    if(wet(map[ty-1]?.[tx])) rail(cx, ty*TILE+2.5,      q0);
    if(wet(map[ty+1]?.[tx])) rail(cx, ty*TILE+TILE-2.5, q0);
  }
  markInst(deckMesh,di); markInst(railMesh,ri);
}

// ── Skins (pixel-editor output) ───────────────────────────────────
// A "skin" is a hand-painted texture replacing a default: 64×64 skins
// retexture the 3D meshes (wall/cave/rock/bridge/water); TERR_PX-sized
// ground stamps repaint the terrain per tile type. Stored as PNG data
// URLs in worldEdits.skins so they export/import/ship like everything.
const SKIN_TARGETS={
  wall:  {label:'Wall (3D)',       tex:wallTex},
  cave:  {label:'Cave wall (3D)',  tex:caveTex},
  rock:  {label:'Rock (3D)',       tex:rockTex},
  bridge:{label:'Bridge deck (3D)',tex:bridgeTex},
  water: {label:'Water (3D)',      tex:waterTex},
};
const _skinDefaults={};                // key → pristine canvas clone
function _cloneCanvas(src,w,h){
  const c=document.createElement('canvas'); c.width=w||src.width; c.height=h||src.height;
  const x=c.getContext('2d'); x.imageSmoothingEnabled=false;
  x.drawImage(src,0,0,c.width,c.height); return c;
}
for(const [k,t] of Object.entries(SKIN_TARGETS)) _skinDefaults[k]=_cloneCanvas(t.tex.image);
const _defaultTileColors=JSON.parse(JSON.stringify(TILE_COLORS));
function _avgColor(c){
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let r=0,g=0,b=0,n=d.length/4;
  for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}
  return [Math.round(r/n),Math.round(g/n),Math.round(b/n)];
}
// Repaint every tile of one type on the terrain + minimap canvases
function repaintGroundType(t){
  const c=TILE_COLORS[t]||[0,0,0];
  miniCtx.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';
  for(let ty=0;ty<MAP_H;ty++)for(let tx=0;tx<MAP_W;tx++)
    if(map[ty][tx]===t) miniCtx.fillRect(tx,ty,1,1);
  // Gaining or losing a stamp flips whether this type warps at all (_isSoft), so
  // every boundary it touches has to be re-derived — cheaper to re-bake than to
  // track them. Rare: only fires when a skin is painted or reset.
  buildTerrainImage();
  terrTex.needsUpdate=true;
}
// Apply a painted canvas (64×64 for 3D, TERR_PX for ground) to its target
function applySkin(key,canvas,save){
  const tgt=SKIN_TARGETS[key];
  if(tgt){
    const img=tgt.tex.image, x=img.getContext('2d');
    x.imageSmoothingEnabled=false;
    x.drawImage(canvas,0,0,img.width,img.height);
    tgt.tex.needsUpdate=true;
  }else if(key[0]==='g'){
    const tid=+key.slice(1);
    groundStamps[tid]=_cloneCanvas(canvas,TERR_PX,TERR_PX);
    TILE_COLORS[tid]=_avgColor(canvas);
    repaintGroundType(tid);
  }
  if(save){ worldEdits.skins[key]=canvas.toDataURL(); saveEdits(); }
}
function resetSkin(key){
  delete worldEdits.skins[key]; saveEdits();
  const tgt=SKIN_TARGETS[key];
  if(tgt){
    const img=tgt.tex.image, x=img.getContext('2d');
    x.drawImage(_skinDefaults[key],0,0);
    tgt.tex.needsUpdate=true;
  }else if(key[0]==='g'){
    const tid=+key.slice(1);
    delete groundStamps[tid];
    TILE_COLORS[tid]=(customTileDefs[tid]&&customTileDefs[tid].color)||_defaultTileColors[tid]||[0,0,0];
    repaintGroundType(tid);
  }
}
function applySavedSkins(){
  for(const [k,url] of Object.entries(worldEdits.skins)){
    const im=new Image();
    im.onload=()=>{
      const s=SKIN_TARGETS[k]?64:TERR_PX;
      const c=document.createElement('canvas'); c.width=c.height=s;
      const x=c.getContext('2d'); x.imageSmoothingEnabled=false;
      x.drawImage(im,0,0,s,s);
      applySkin(k,c,false);
    };
    im.src=url;
  }
}
applySavedSkins();

// Called wherever game.js would call bakeStaticTile / minimapUpdateTile.
// oldT: pass the previous tile when the caller has already overwritten
// origTile (the editor does) so removed obstacles still trigger rebuilds.
function bakeStaticTile(tx, ty, oldT) {
  updateTerrPx(tx, ty);
  const t=map[ty][tx], ot=oldT!==undefined?oldT:origTile[ty]?.[tx];
  if(t===T.WALL||ot===T.WALL)   wallDirty=true;
  if(t===T.TREE||ot===T.TREE)   treeDirty=true;
  if(t===T.STONE||ot===T.STONE) stoneDirty=true;
  if(t===T.ORE_IRON||ot===T.ORE_IRON) ironDirty=true;
  // The packed cave list is a cache of the map, so an edit has to drop it or
  // the editor can paint a wall that never appears (or erase one that never
  // leaves) until the next reload.
  if(t===T.CAVE_WALL||ot===T.CAVE_WALL){ caveDirty=true; _caveTiles=null; }
  // customMesh draws ids >=100 AND stained glass (12) — both have to mark it dirty,
  // or painting glass leaves it invisible until the window happens to re-centre.
  if(t>=100||ot>=100||t===T.STAINED_GLASS||ot===T.STAINED_GLASS) customDirty=true;
  if(t===T.WATER||t===T.BRIDGE||ot===T.WATER||ot===T.BRIDGE){waterDirty=true;bridgeDirty=true;}
}
function minimapUpdateTile(tx, ty) { updateTerrPx(tx, ty); updateMiniPx(tx, ty); }
function resizeTileViewport() {}   // no-op — Three.js resizes via renderer

// ── Entity meshes ─────────────────────────────────────────────────
// Per-type visual: [hex color, body-w, body-h, body-d, head-r, shape]
// shape: 0 = humanoid (2 arms + 2 legs), 1 = quadruped (4 legs + snout), 2 = blob
const EVIS = {
  wolf:          [0x8b6955, 16,26,40, 0, 1],
  bandit:        [0x4a3530, 16,36,11, 6, 0],
  goblin:        [0x406030, 13,26, 9, 5, 0],
  troll:         [0x7a5040, 28,52,18, 9, 0],
  spider:        [0x2a1a30, 30,16,30, 0, 1],
  goblin_k:      [0x508050, 18,34,11, 6, 0],
  troll_l:       [0x9a6040, 36,64,24,11, 0],
  spider_q:      [0x5a1a5a, 40,22,40, 0, 1],
  slime:         [0x30aa40, 24,20,24, 0, 2],
  slime_mini:    [0x40bb50, 14,12,14, 0, 2],
  ratman:        [0x7a6050, 13,30, 9, 5, 0],
  ratman_wiz:    [0x5a4070, 13,30, 9, 5, 0],
  ratman_archer: [0x6a5040, 13,30, 9, 5, 0],
  giant_rat:     [0x8a7060, 18,22,34, 0, 1],
  hellhound:     [0x881a10, 18,26,40, 0, 1],
  silver_serp:   [0xb0b8c0, 12,12,52, 0, 2],
  piper:         [0x9a6820, 14,34, 9, 6, 0],
};
const EVIS_DEF = [0x555555, 14,30,10, 6, 0];

// Shared unit geometries — every rig scales these per-frame (cheap, GPU-friendly)
const UNIT_BOX  = new THREE.BoxGeometry(1,1,1);      // still the weapon prop
// The body parts were a box, a sphere and three more boxes. They are now shaped
// like a person — same unit spaces to the millimetre, so every scale() and
// position() in configureRig/applyProp/animateRig means exactly what it did.
// See render/humanoid.js for why the spaces are load-bearing.
const UNIT_TORSO = makeTorsoGeometry(THREE);          // -0.5..0.5 on every axis
const UNIT_SPH   = makeHeadGeometry(THREE);           // -1..1, was SphereGeometry(1,8,6)
// Limbs pivot at their TOP (shoulder/hip) so rotation.x swings them naturally
const UNIT_LIMB  = makeLimbGeometry(THREE);           // -1..0 in Y

// ── Who everyone in this town IS ────────────────────────────────────────────
//
// This table used to be outfits alone, and every figure wearing them was
// spawned with the SAME call: configureRig(g, color, 15,48,10, 4.3, ...). One
// height, one width, one head size, one skin tone, eleven people. Dressing a
// blacksmith and a cryptologist differently does not help much when they are
// the same body underneath — from across a courtyard the outfit is a colour and
// the BUILD is the silhouette, and the silhouette is what you actually read.
//
// So a style now carries three things:
//   build  {bw,bh,bd,hr}  body width / height / depth / head radius. Threaded
//                         into configureRig AND applyProp, which must agree or
//                         the held prop ends up beside the hand instead of in
//                         it. Omitted = the old 15/48/10/4.3.
//   skin   hex            face colour.
//   ...    dressing flags consumed by render/humanoid.js. Their colours are
//                         picked to survive the tinting configureRig does to
//                         the body underneath — a guard's steel has to read as
//                         steel whatever colour their tabard is.
//
// The builds are deliberately spread wide. A smith at 19 wide / 50 tall next to
// a grave robber at 13 / 44 is a difference you can see before you can make out
// either face, which is the whole point.
const RIG_STYLES = {
  // The garrison. Tall and broad, and the only figures in livery — the tabard
  // is what says "these two answer to someone" from any distance.
  guard:    { build:{bw:17,bh:51,bd:11,hr:4.3}, skin:0xc39a6b,
              helm:0x8e949c, plume:0x8c2f2f, coif:0x70757c, gorget:0x9aa1aa,
              pauldron:0x9aa1aa, tabard:0x243352, tabardTrim:0xd8c060,
              belt:0x4a3524, buckle:0xd8c060, cloak:0x243352 },

  // Stout, and carrying stock on both hips so he is asymmetric from either side.
  merchant: { build:{bw:16,bh:46,bd:12,hr:4.5}, skin:0xd8b48c,
              cap:0x6b3f2a, plume:0x7a5a30, belt:0x4a3524, satchel:0x6b4a2a,
              pouch:0x5a4020, robe:0x8a4030, robeShort:true, hair:0x3a2a1a,
              mustache:0x3a2a1a },

  // Gold chain of office and a fur collar: the two pieces that read as money.
  banker:   { build:{bw:15,bh:47,bd:10,hr:4.4}, skin:0xe3c4a0,
              cap:0x4a4038, belt:0x3a2a1c, robe:0xd0a020, robeShort:true,
              collar:0x4a3a2a, medallion:0xd8c060, chain:0xd8c060, hair:0x2a2018 },

  // The widest body in the game, and bare-headed — he works over a fire.
  smith:    { build:{bw:19,bh:50,bd:13,hr:4.4}, skin:0xb07a4e,
              apron:0x5c4028, belt:0x4a3524, toolLoop:0x4a4a50,
              hair:0x2a1c12, beard:0x2a1c12 },

  // Slight and tall. Full robe, so the legs are hidden and the whole figure is
  // one falling line.
  healer:   { build:{bw:13,bh:48,bd:9,hr:4.2}, skin:0xd8b48c,
              hat:0x2f5c3a, hatBand:0xc8a25a, robe:0x40a060, belt:0x4a3524,
              beard:0xe8e4dc, pouch:0x3a5c40 },

  mage:     { build:{bw:13,bh:50,bd:9,hr:4.3}, skin:0xe3c4a0,
              hat:0x2a2f5c, hatBand:0xc8a25a, robe:0x4040a0, belt:0x4a3524,
              beard:0xe0dcd4, scrollCase:0x5a4a8a },

  // The antiquarian. Short, stooped, spectacles — a reader, not a fighter.
  scholar:  { build:{bw:13,bh:45,bd:9,hr:4.5}, skin:0xc9a274,
              hood:0x4a3a6a, robe:0x6a4a9a, belt:0x3a2a1c, beard:0xd8d0c4,
              spectacles:0xb8a878, scrollCase:0x4a3a6a },

  // The cryptologist. Masked to the eyes, and carries her work on her back.
  cipher:   { build:{bw:13,bh:46,bd:9,hr:4.2}, skin:0x8d5f3c,
              hood:0x24485e, maskScarf:0x1e3a4a, robe:0x2a5a7a, belt:0x3a2a1c,
              backpack:0x24485e, strap:0x3a2a1c },

  // The grave robber. The smallest and the darkest: wiry, hooded, scarfed, and
  // eyes:false — the one face in town that should stay in shadow.
  robber:   { build:{bw:13,bh:44,bd:9,hr:4.0}, skin:0x8d5f3c,
              hood:0x24242a, maskScarf:0x1a1a1e, cloak:0x1e1e22, belt:0x3a2a1c,
              pouch:0x2a2a30, eyes:false },

  // Broad like the smith but shorter, and the only figure with a working belt
  // AND a pack — he travels to the horses.
  farrier:  { build:{bw:17,bh:47,bd:12,hr:4.3}, skin:0xb07a4e,
              apron:0x5c4028, belt:0x4a3524, cap:0x6b5a3a, toolLoop:0x4a4a50,
              mustache:0x4a3418 },

  // Short and stout, with a circlet: the museum's authority, not the crown's.
  curator:  { build:{bw:16,bh:44,bd:11,hr:4.6}, skin:0xe3c4a0,
              cap:0x7a5a20, plume:0xb08030, robe:0xb08030, robeShort:true,
              belt:0x4a3524, beard:0xd0c8b8, medallion:0xb87333, chain:0xb87333,
              circlet:0xb87333 },

  // Enemies. Wiry and mean; the sash is so a bandit is not mistaken for a
  // townsperson who wandered out of the gate.
  //
  // NO `build` HERE ON PURPOSE. Enemy proportions come from EVIS, which is
  // where every other mob's size already lives; a `build` key would be a second
  // source for the same number and the two would eventually disagree. `skin` is
  // still read, because EVIS has no equivalent.
  //
  // Worth knowing: bandit is the ONLY enemy type with no entry in MOB_MODELS,
  // so unlike every other mob it is never replaced by a GLB. This outfit is
  // what a bandit looks like, always, on all hardware.
  bandit:   { skin:0xb07a4e,
              hood:0x3a2f28, maskScarf:0x2a221c, sash:0x6a2a24, belt:0x3a2a1c },

  // The fletcher's stand-in. He has a GLB, but it only loads on hardware that
  // can skin — this is what the rest see, and a bowyer with no quiver is just a
  // man in a hat.
  fletcher: { build:{bw:15,bh:48,bd:10,hr:4.3}, skin:0xc39a6b,
              cap:0x4a5c34, belt:0x4a3524, quiver:0x5a3a20, fletching:0xe4e0d4,
              hair:0x6a5030 },
  // ⚠ There is deliberately no bracer/vambrace/glove piece in this vocabulary.
  // Body dressing is ONE mesh parented to the group, and the arms and legs
  // SWING — anything built here for a limb would hang in the air while the limb
  // walked out of it. Limb-worn detail has to be baked into UNIT_LIMB's vertex
  // colours instead, which is exactly what the boot/glove ramp in
  // makeLimbGeometry already does.
};
// Fallback build, and the numbers every NPC used to share.
const RIG_BUILD_DEFAULT = { bw:15, bh:48, bd:10, hr:4.3 };
const rigBuild = (styleName) =>
  (RIG_STYLES[styleName] && RIG_STYLES[styleName].build) || RIG_BUILD_DEFAULT;
// Dressing geometry is shared: every guard is wearing the same helmet mesh, and
// building it once per guard would be twenty identical buffers. Keyed by style
// AND body size, because the body pieces are built in rig-local units.
const _dressCache = new Map();
let _devRigs = [];   // rigs parked by _dev.rig(), so the next call can clear them
function dressGeo(styleName, which, dims){
  const key = styleName+'|'+which+'|'+(which==='head' ? '' : dims.bw+','+dims.bh+','+dims.bd);
  if(_dressCache.has(key)) return _dressCache.get(key);
  const S = RIG_STYLES[styleName];
  const g = !S ? null
          : which==='head' ? buildHeadDressing(THREE, S)
                           : buildBodyDressing(THREE, S, dims);
  _dressCache.set(key, g);
  return g;
}
const _cWhite  = new THREE.Color(0xffffff);

// A rig: [0]body [1]head [2]armL [3]armR [4]legL [5]legR [6]prop(weapon)
function makeRig() {
  const g = new THREE.Group();
  // Standard, so the blocky fallback rigs sit in the same light as the GLB
  // characters standing next to them. On Lambert they ignored the env map
  // entirely and read noticeably flatter than a modelled NPC in the same frame.
  // Roughness is high across the board — cloth and skin, no gloss.
  const bodyMat = new THREE.MeshStandardMaterial({color:0xffffff, roughness:0.85, metalness:0.0, transparent:false});
  const headMat = new THREE.MeshStandardMaterial({color:0xcaa472, roughness:0.80, metalness:0.0, transparent:false});
  // vertexColors so the boot/glove ramp baked into UNIT_LIMB multiplies through
  // — material.color still drives the overall tint.
  const limbMat = new THREE.MeshStandardMaterial({color:0x888888, roughness:0.85, metalness:0.0, transparent:false, vertexColors:true});
  // Legs get their OWN material. Arms and legs sharing one colour is most of
  // why an undressed rig reads as a single flat slab: there is no line anywhere
  // between the shoulder and the floor for the eye to catch on. Four limb
  // meshes either way, so this is a second material and not a second draw call.
  const legMat  = new THREE.MeshStandardMaterial({color:0x666666, roughness:0.88, metalness:0.0, transparent:false, vertexColors:true});
  const propMat = new THREE.MeshStandardMaterial({color:0xc8c8a0, roughness:0.70, metalness:0.0, transparent:false});
  // vertexColors, so one mesh and one material can carry a steel helmet, a
  // leather belt and a brass buckle at once.
  const dressMat = new THREE.MeshStandardMaterial({vertexColors:true, roughness:0.82, metalness:0.0, transparent:false});
  const body = new THREE.Mesh(UNIT_TORSO, bodyMat); body.castShadow = true;
  const head = new THREE.Mesh(UNIT_SPH, headMat); head.castShadow = true;
  const armL = new THREE.Mesh(UNIT_LIMB, limbMat); armL.castShadow = true;
  const armR = new THREE.Mesh(UNIT_LIMB, limbMat); armR.castShadow = true;
  const legL = new THREE.Mesh(UNIT_LIMB, legMat);
  const legR = new THREE.Mesh(UNIT_LIMB, legMat);
  const prop = new THREE.Mesh(UNIT_BOX, propMat); prop.visible = false;
  // Index 7. animateRig destructures the first SEVEN children and ignores the
  // rest, so the body dressing can live here without touching the contract.
  const dress = new THREE.Mesh(UNIT_BOX, dressMat); dress.visible = false; dress.castShadow = true;
  // The head's dressing is a child of the HEAD, not of the group — that is what
  // makes a hat bob and turn with the head it is on instead of hovering beside
  // it. It inherits the head's scale too, so it is authored in head-local units.
  const hdress = new THREE.Mesh(UNIT_BOX, dressMat); hdress.visible = false; hdress.castShadow = true;
  head.add(hdress);
  g.add(body, head, armL, armR, legL, legR, prop, dress);
  g.userData.mats = [bodyMat, headMat, limbMat, propMat, dressMat, legMat];
  return g;
}
// Put a role's outfit on a rig. Call AFTER configureRig — it needs the body
// dimensions that call worked out.
function dressRig(g, styleName){
  const dress = g.children[7], head = g.children[1], hdress = head.children[0];
  const ud = g.userData;
  if(!styleName || ud.shape !== 0){ dress.visible = hdress.visible = false; return; }
  const dims = { bw:ud.dw, bh:ud.dh, bd:ud.dd, legH:ud.dlegH, torso:ud.dtorso };
  // A floor-length robe covers the legs completely, so drawing them inside it
  // is two draw calls spent on geometry nobody can see — and any z-fighting or
  // sorting mistake shows up as legs walking through the cloth. Short robes and
  // tunics keep theirs.
  const S = RIG_STYLES[styleName];
  const hideLegs = !!(S && S.robe && !S.robeShort);
  g.children[4].visible = g.children[5].visible = !hideLegs;
  const bg = dressGeo(styleName, 'body', dims);
  const hg = dressGeo(styleName, 'head', dims);
  if(bg){ dress.geometry = bg; dress.visible = true; } else dress.visible = false;
  if(hg){ hdress.geometry = hg; hdress.visible = true; } else hdress.visible = false;
  ud.style = styleName;
}

// Fade a rig, for the hiding skill and for remote-player ghosting. Flipping
// `transparent` with the opacity is the point: see the note in makeRig.
function setRigOpacity(mats, op){
  const t = op < 0.999;
  for(const m of mats){
    m.opacity = op;
    if(m.transparent !== t){ m.transparent = t; m.needsUpdate = true; }
  }
}

// Where the legs stop and the torso starts, as a fraction of body height. Was
// 0.42 written out twice — here and in applyProp, which derives the hand height
// from it. A human is closer to half legs; 0.46 lengthens the stance without
// making the torso look stunted, and having ONE constant means the held weapon
// cannot drift away from the hand that holds it.
const RIG_LEG_FRAC = 0.46;

// Position/scale a rig's parts for a given size + shape
function configureRig(g, color, bw, bh, bd, hr, shape, headSkin) {
  const [body,head,armL,armR,legL,legR] = g.children;
  const [bodyMat,headMat,limbMat,,,legMat] = g.userData.mats;
  const ud = g.userData;
  bw*=OBJ_SCALE; bh*=OBJ_SCALE; bd*=OBJ_SCALE; hr*=OBJ_SCALE;   // global object scale
  ud.shape = shape; ud.bh = bh;
  bodyMat.color.setHex(color);
  limbMat.color.setHex(color).multiplyScalar(0.62);
  // Darker again than the arms, so trousers separate from sleeves and the two
  // legs separate from each other. 0.62 vs 0.40 is a visible step at any
  // distance where the figure is more than a few pixels tall.
  if(legMat) legMat.color.setHex(color).multiplyScalar(0.40);
  if (shape === 2) {                       // blob — body only
    body.scale.set(bw,bh,bd); body.position.set(0,bh*0.5,0);
    head.visible=armL.visible=armR.visible=legL.visible=legR.visible=false;
    return;
  }
  if (shape === 1) {                       // quadruped
    const legH=bh*0.5, torso=bh*0.5, lt=Math.max(2,bw*0.22);
    body.scale.set(bw,torso,bd); body.position.set(0,legH+torso*0.5,0);
    ud.baseBodyY = legH+torso*0.5; ud.baseHeadY = legH+torso*0.55;
    const hs=Math.max(4,bh*0.5);
    head.visible=true; head.scale.setScalar(hs);
    head.position.set(0, ud.baseHeadY, -(bd*0.5+hs*0.35));
    headMat.color.setHex(color).lerp(_cWhite,0.18);
    const fx=bw*0.34, fz=bd*0.32;
    // Legs hang from the body's underside (top-pivot geometry)
    armL.scale.set(lt,legH,lt); armL.position.set(-fx,legH,-fz);
    armR.scale.set(lt,legH,lt); armR.position.set( fx,legH,-fz);
    legL.scale.set(lt,legH,lt); legL.position.set(-fx,legH, fz);
    legR.scale.set(lt,legH,lt); legR.position.set( fx,legH, fz);
    armL.visible=armR.visible=legL.visible=legR.visible=true;
    return;
  }
  // humanoid (shape 0)
  const legH=bh*RIG_LEG_FRAC, torso=bh-legH;
  // Kept for dressRig, which is built in these same units and cannot recompute
  // them without repeating this arithmetic and eventually disagreeing with it.
  ud.dw=bw; ud.dh=bh; ud.dd=bd; ud.dlegH=legH; ud.dtorso=torso;
  body.scale.set(bw,torso,bd); body.position.set(0, legH+torso*0.5, 0);
  ud.baseBodyY = legH+torso*0.5;
  const r=Math.max(3,hr);
  head.visible=true; head.scale.setScalar(r);
  // 0.55 put the head's chin BELOW the top of the torso — the head sat inside
  // the shoulders with no neck at all, which is why a beard was mostly buried
  // in the chest and why the jaw never read. 0.88 lifts the chin clear; the
  // torso's own neck stub fills the gap.
  ud.baseHeadY = legH+torso+r*0.88;
  head.position.set(0, ud.baseHeadY, 0);
  // headSkin: `true` keeps the original single tone; a NUMBER is that skin
  // colour. Every townsperson sharing one face colour was a quiet part of why
  // they read as copies — the outfits differed and the people did not.
  if (typeof headSkin === 'number') headMat.color.setHex(headSkin);
  else if (headSkin)                headMat.color.setHex(0xcaa472);
  else                              headMat.color.setHex(color).lerp(_cWhite,0.22);
  // az was bd*0.7 — DEEPER than the arm is wide, which turned each arm into a
  // flat panel seen edge-on from the side and wing-like from behind. An arm is
  // round: width and depth close together, and both well under the old values
  // now that the geometry has a taper of its own to show.
  const at=Math.max(2,bw*0.21), az=Math.max(2,bd*0.34), ah=torso*0.92;
  // Arms hang from the shoulders, legs from the hips (top-pivot geometry)
  armL.scale.set(at,ah,az); armL.position.set(-(bw*0.5+at*0.5), legH+torso*0.96, 0);
  armR.scale.set(at,ah,az); armR.position.set( (bw*0.5+at*0.5), legH+torso*0.96, 0);
  const lt=Math.max(2,bw*0.27), lz=Math.max(2,bd*0.42);
  legL.scale.set(lt,legH,lz); legL.position.set(-bw*0.22, legH, 0);
  legR.scale.set(lt,legH,lz); legR.position.set( bw*0.22, legH, 0);
  armL.visible=armR.visible=legL.visible=legR.visible=true;
  // Pool slots are reused across types, so anything dressRig hid for a previous
  // occupant is restored here — dressRig runs after this and hides them again
  // if the new outfit calls for it.
  g.children[7].visible = false;
  if(head.children[0]) head.children[0].visible = false;
  ud.style = null;
}

// ── Procedural rig animation ──────────────────────────────────────
// Distance-driven walk cycles (stride matches ground speed), idle
// breathing, blob squash-and-stretch, attack swings, and smooth turning
// toward the movement direction. Runs after configureRig/applyProp.
// ── How anything in this game turns ─────────────────────────────────────────
// Two properties, and the old code had neither.
//
// FRAME-RATE INDEPENDENT. The step is 1 - exp(-k*dt), so it converges on the
// same curve in the same wall-clock time at 30Hz and at 144Hz. Every site this
// replaces took a flat fraction of the error per FRAME, which made turn speed a
// function of the machine.
//
// RATE-CAPPED. An exponential still steps proportionally to the error, so a
// target that jumps 60 degrees still snaps. The cap is what removes the smear:
// measured on a spider before this, peak yaw was 1806 deg/s -- five rotations a
// second -- and a wide silhouette spun that hard does not read as turning, it
// reads as a blur.
const TURN_RATES = {
  mob:    { k: 9,  max: 4.5 },   // ~258 deg/s — an animal turning
  player: { k: 16, max: 12  },   // ~690 deg/s — snappy under the cursor, bounded
  npc:    { k: 5,  max: 3   },   // ~170 deg/s — noticing you, not snapping to it
  remote: { k: 10, max: 6   },   // ~345 deg/s — tracking a server-synced heading
};
// Hysteresis on "is this thing moving". One threshold cannot work: the per-frame
// step of a wandering mob straddles any single value — measured median 0.35 and
// p90 0.69 against the old 0.6 gate — so the heading flipped between "the way I
// am walking" and "face the player" 3.2 times a second.
const MOVE_ON = 18, MOVE_OFF = 8;
// Long deltas are CLAMPED, and that is not the same as clamping the frame time.
// A mob that has been outside animation range has a stale clock, so its first
// delta back can be a tenth of a second; integrating the ceiling over that
// permits a 26-degree step in a single frame, which pops. Measured on a bandit
// coming back into range: 465 deg/s against a 258 deg/s ceiling.
//
// Capping the integration step at 1/30s bounds any single frame to max/30 — about
// 8.6 degrees for a mob — and the turn simply finishes over the next few frames.
// Below 30fps this makes things turn slightly slower than the nominal rate, which
// is the right way round: a slideshow should not also be a place where models
// snap through 26 degrees between frames.
const TURN_DT_MAX = 1 / 30;
function turnToward(obj, tgt, adt, cls){
  if(!(adt > 0)) return;
  const dt = adt > TURN_DT_MAX ? TURN_DT_MAX : adt;
  const r = TURN_RATES[cls] || TURN_RATES.mob;
  let d = tgt - obj.rotation.y;
  d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const step = d * (1 - Math.exp(-r.k * dt));
  const lim = r.max * dt;
  obj.rotation.y += step < -lim ? -lim : step > lim ? lim : step;
}
function animateRig(g, wx, wz, t, opts={}) {
  const ud=g.userData;
  const dx=wx-(ud.lx??wx), dz=wz-(ud.lz??wz);
  ud.lx=wx; ud.lz=wz;
  const dist=Math.hypot(dx,dz);
  const moving = dist>0.3 && dist<TILE*3;          // ignore teleports
  // Own frame delta: this function is handed a clock, not a delta.
  const _adt = ud.lt==null ? 0 : Math.min(0.1, Math.max(0, t-ud.lt));
  ud.lt = t;
  // Smoothed velocity, for the same reason animModel needs one: a heading taken
  // from a single frame's delta is a heading taken from pathing noise.
  if(_adt>0 && dist<TILE*3){
    const sp=dist/_adt;
    ud.spd = ud.spd==null ? sp : ud.spd + (sp-ud.spd)*0.25;
    const vx=dx/_adt, vz=dz/_adt;
    ud.vx = ud.vx==null ? vx : ud.vx + (vx-ud.vx)*0.25;
    ud.vz = ud.vz==null ? vz : ud.vz + (vz-ud.vz)*0.25;
  }
  if(ud.mv){ if((ud.spd??0) < MOVE_OFF) ud.mv=false; }
  else     { if((ud.spd??0) > MOVE_ON)  ud.mv=true;  }
  if(ud.amp===undefined){ud.amp=0;ud.phase=Math.random()*7;}
  ud.amp+=((moving?1:0)-ud.amp)*0.18;              // ease swing in/out
  ud.phase+=dist*0.11;                             // stride tied to distance
  const s=Math.sin(ud.phase), a=ud.amp;
  const [body,head,armL,armR,legL,legR,prop]=g.children;
  // Turn smoothly toward movement; face the given target when idle
  if(opts.turn){
    let tgt=null;
    if(ud.mv && (ud.vx*ud.vx + ud.vz*ud.vz) > 1) tgt=Math.atan2(-ud.vx,-ud.vz);
    else if(opts.faceX!=null){const fx=opts.faceX-wx,fz=opts.faceZ-wz;
      if(Math.hypot(fx,fz)<TILE*7) tgt=Math.atan2(-fx,-fz);}
    if(tgt!==null) turnToward(g, tgt, _adt, 'mob');
  }
  if(ud.shape===2){                                // blob: squash & stretch
    const f=1+0.11*Math.sin(t*5+ud.phase)*(0.35+0.65*a);
    body.scale.y*=f; body.position.y=body.scale.y/2;
    return;
  }
  const idle=Math.sin(t*2.1+ud.phase)*0.5;
  if(ud.shape===1){                                // quadruped: diagonal gait
    const sw=s*0.65*a;
    armL.rotation.x=sw;  legR.rotation.x=sw;
    armR.rotation.x=-sw; legL.rotation.x=-sw;
    body.position.y=ud.baseBodyY+Math.abs(Math.cos(ud.phase))*1.1*a+idle*0.6;
    return;
  }
  // humanoid: arms/legs counter-swing + bob + breathing
  armL.rotation.x=s*0.75*a; armR.rotation.x=-s*0.75*a;
  legL.rotation.x=-s*0.85*a; legR.rotation.x=s*0.85*a;
  body.position.y=ud.baseBodyY+Math.abs(Math.cos(ud.phase))*1.3*a+idle;
  head.position.y=ud.baseHeadY+idle;
  const atk=opts.attack||0;
  if(atk>0){ armR.rotation.x=-2.3*atk+0.3; }       // overhead chop
  if(prop.visible) prop.rotation.x=(ud.propRotX||0)+(atk>0?-1.9*atk:0);
}

// Give a humanoid rig a held weapon/tool in its right hand
function applyProp(g, kind, bw, bh, bd) {
  const prop = g.children[6], mat = g.userData.mats[3];
  if (!kind) { prop.visible=false; return; }
  bw*=OBJ_SCALE; bh*=OBJ_SCALE; bd*=OBJ_SCALE;   // match the scaled rig
  prop.visible = true; prop.rotation.set(0,0,0);
  const legH=bh*RIG_LEG_FRAC, torso=bh-legH, handY=legH+torso*0.55;
  const handX = bw*0.5 + Math.max(2,bw*0.26);
  switch (kind) {
    case 'sword':   mat.color.setHex(0xd8d8e0); prop.scale.set(3,bh*0.55,3); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.5; break;
    case 'dagger':  mat.color.setHex(0xc8c8d0); prop.scale.set(2.5,bh*0.30,2.5); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.5; break;
    case 'club':    mat.color.setHex(0x6b4a2a); prop.scale.set(5,bh*0.5,5); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.4; break;
    case 'axe':     mat.color.setHex(0xbfc2c8); prop.scale.set(4,bh*0.5,4); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.4; break;
    case 'pickaxe': mat.color.setHex(0x9aa0a8); prop.scale.set(3.5,bh*0.5,3.5); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.4; break;
    case 'bow':     mat.color.setHex(0x8a5a2a); prop.scale.set(2,bh*0.6,2); prop.position.set(handX,handY,0); break;
    case 'staff':   mat.color.setHex(0x9a7a40); prop.scale.set(2.5,bh*0.85,2.5); prop.position.set(handX,handY+bh*0.18,0); break;
    case 'hammer':  mat.color.setHex(0x5a5a60); prop.scale.set(5,bh*0.45,5); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.4; break;
    case 'flute':   mat.color.setHex(0xe8d8a0); prop.scale.set(2,2,bh*0.3); prop.position.set(handX,handY,-bd*0.4); break;
    case 'torch':   mat.color.setHex(0xa67046); prop.scale.set(2,bh*0.4,2); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.4; break;
    case 'lantern': mat.color.setHex(0x555555); prop.scale.set(3,bh*0.3,3); prop.position.set(handX,handY,-bd*0.3); prop.rotation.x=0.4; break;
    default:        prop.visible=false;
  }
  g.userData.propRotX = prop.rotation.x;   // base pose for attack-swing anim
}

// Per-type outfit for enemies, parallel to PROP below.
//
// Only `bandit` for now, and that is not an oversight: every other enemy type
// has a GLB in MOB_MODELS and so only ever shows its procedural rig on hardware
// that cannot skin, or for the instant before the file lands. Bandit has no
// model at all, so this is the one mob whose stand-in IS the mob.
//
// dressRig() no-ops on anything that is not shape 0, so adding a quadruped here
// costs nothing but also does nothing — the dressing vocabulary is built in
// humanoid rig-local space and has no meaning on a wolf.
const ESTYLE = {
  bandit: 'bandit',
};

// Per-type held weapon for enemies
const PROP = {
  bandit:'sword', goblin:'dagger', goblin_k:'sword', troll:'club', troll_l:'club',
  ratman:'dagger', ratman_archer:'bow', ratman_wiz:'staff', piper:'flute',
};

// ── GLTF mob models (CC0, Quaternius) ─────────────────────────────
// Animated GLB per mob type; procedural rigs remain the instant-loading
// fallback (and stay for types without a model, e.g. bandit).
// h = target world height; tint multiplies the model's materials.
const MOB_MODELS = {
  wolf:          {file:'wolf.glb',      h:34},
  hellhound:     {file:'wolf.glb',      h:36, tint:0xff5540},
  spider:        {file:'spider_rigged.glb',  h:24},
  // The queen wears the second skin rather than a tint of the first. Both are
  // the same creature rigged the same way, so they share every generated clip.
  spider_q:      {file:'spider_rigged2.glb', h:38},
  giant_rat:     {file:'rat.glb',       h:24},
  goblin:        {file:'orc_enemy.glb', h:32},
  goblin_k:      {file:'orc_enemy.glb', h:46, tint:0x99ffaa},
  ratman:        {file:'orc.glb',       h:36, tint:0xbb9977},
  ratman_archer: {file:'orc.glb',       h:36, tint:0xaa8866},
  ratman_wiz:    {file:'wizard.glb',    h:38, tint:0xbb88ee},
  piper:         {file:'wizard.glb',    h:54, tint:0xffcc66},
  troll:         {file:'yeti.glb',      h:48, tint:0xccaa77},
  troll_l:       {file:'yeti.glb',      h:66, tint:0xddbb66},
  slime:         {file:'slime.glb',     h:24, tint:0x55ee66},
  slime_mini:    {file:'slime.glb',     h:14, tint:0x88ff88},
  silver_serp:   {file:'snake.glb',     h:18, tint:0xdde2ea},
};
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
// KTX2 (Basis) GPU textures keep textures compressed in VRAM; Meshopt is an
// alternative geometry codec. Both coexist with Draco, so the current models
// and any future gltfpack-optimized ones (Meshopt + KTX2) all load.
const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/');
ktx2Loader.detectSupport(renderer);
// The boot screen holds the first frame until the protagonist is in hand, and lets
// everything else stream in behind it. Its manager is wired into the GLTFLoader below
// so progress covers every model request without any call site having to report in.
// On a WebGL1 context none of the skinned models are downloaded at all, so there is
// nothing to wait for -- dismissed immediately just below.
const bootScreen = createLoadingScreen({
  bootFiles: ['Protag_animations_basic.glb'],
  LoadingManager: THREE.LoadingManager,
});

const gltfLoader = new GLTFLoader(bootScreen.manager);
gltfLoader.setDRACOLoader(dracoLoader);
gltfLoader.setKTX2Loader(ktx2Loader);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

if (!SKINNING_OK) bootScreen.dismiss();

// Models that arrive RIGGED BUT UNANIMATED, and the generator that fills in for
// them. Deliberately a per-file table and not a blanket "no clips? generate
// something": a humanoid whose clips failed to export should fall through to the
// primitive fallback that already exists, not be handed a spider's gait. Listing
// the file here is the decision to treat it as an arachnid.
const SYNTH_CLIPS = {
  'spider_rigged.glb':  buildArachnidClips,
  'spider_rigged2.glb': buildArachnidClips,
};
// Live tuning for the generated gait, so it can be iterated in the running game
// the way authored clips would be iterated in Blender — _dev.spiderGait({...}).
const _gaitTune = {};
const loadedModels = {};   // file → {template, clips, natH, yOff}
// SKIPPED ENTIRELY on a WebGL1 context: these are skinned, three r160 cannot
// compile a skinning shader there, and every consumer below already falls back
// to a primitive rig when the template is missing. Not downloading them is a
// second win — the machines that land here are the ones least able to afford
// megabytes of character models they could never draw.
if (SKINNING_OK) {
  const gl = gltfLoader;
  const files = [...new Set(Object.values(MOB_MODELS).map(m=>m.file))];
  for (const f of files) {
    gl.load('models/'+f, gltf => {
      // Measure the TRUE rendered size by sampling skinned vertices —
      // Box3.setFromObject ignores skinning and can be off by 100x when
      // the armature scale is compensated by the inverse bind matrices.
      gltf.scene.updateMatrixWorld(true);
      let minY=1e9, maxY=-1e9;
      const v = new THREE.Vector3();
      gltf.scene.traverse(o => {
        if (!o.isSkinnedMesh) return;
        const pos = o.geometry.attributes.position;
        const step = Math.max(1, Math.floor(pos.count/400));
        for (let i=0;i<pos.count;i+=step) {
          v.fromBufferAttribute(pos,i);
          o.applyBoneTransform(i,v); o.localToWorld(v);
          if (v.y<minY) minY=v.y; if (v.y>maxY) maxY=v.y;
        }
      });
      if (maxY<=minY) {   // no skinned meshes — fall back to static bounds
        const box = new THREE.Box3().setFromObject(gltf.scene);
        minY=box.min.y; maxY=box.max.y;
      }
      let clips = gltf.animations;
      // Generated AFTER the natH measurement above, which reads the bind pose.
      // The generator poses the skeleton while solving and restores it when it
      // is done, but measuring first means that guarantee is never load-bearing.
      if (!clips.length && SYNTH_CLIPS[f]) {
        try { clips = SYNTH_CLIPS[f](THREE, gltf.scene, _gaitTune) || []; }
        catch (err) { console.warn('gait synthesis failed for', f, err); clips = []; }
      }
      loadedModels[f] = { template:gltf.scene, clips,
        natH:Math.max(0.01, maxY-minY), yOff:-minY };
    }, undefined, err => console.warn('model load failed', f, err));
  }
}
function pickClip(clips, res){ return clips.find(c=>res.test(c.name)) || null; }

// ── GLB prop art swaps ────────────────────────────────────────────
// The new prop models (campfire/torch/lantern/quiver/backpack/armor) are
// single-mesh GLBs normalized to a ~1.9u cube centered at the origin. Bake
// scale + ground offset into the geometry so the existing instance matrices
// and pool transforms keep working unchanged.
// The AI-generated prop exports carry metalness/roughness/normal maps that
// render near-black under this game's simple direct lighting (no envmap).
// Keep albedo + emissive (the campfire/torch flames glow via emissiveMap),
// drop the rest, and settle on a stylized matte response.
// The GLB imports ship full PBR map sets. These used to be stripped because
// metal surfaces rendered black — there was no scene.environment for them to
// reflect. Now that IBL exists the maps can stay, which is what gives the
// armour and weapons their surface detail. metalness is held below 1 so a
// fully-metal texel still picks up diffuse light rather than going pure
// mirror; tune live with _dev.gfx({metalness, roughness}).
const PROP_PBR={ metalness:0.70, roughness:0.62, normalScale:1.0 };
const _propMats=new Set();
function simplifyPropMaterial(m){
  _propMats.add(m);
  m.metalness=PROP_PBR.metalness;
  if(!m.roughnessMap) m.roughness=PROP_PBR.roughness;
  if(m.normalMap&&m.normalScale) m.normalScale.set(PROP_PBR.normalScale,PROP_PBR.normalScale);
  m.envMapIntensity=_envIntensity;
  // Kill emissive that has no map behind it. These GLBs ship emissive=#ffffff
  // at full intensity, and this function strips the emissiveMap that was
  // supposed to mask it — so the whole model became 100% self-lit. That's why
  // NPCs stood at full daylight saturation in a pitch-black midnight city while
  // the world around them went properly dark: they weren't being lit at all,
  // they were emitting.
  //
  // Keeping emissive was originally a workaround for these exports rendering
  // near-black under the old two-light rig. There's a real sky and IBL now, so
  // the workaround costs more than it buys. Materials that genuinely glow keep
  // their emissiveMap and are untouched.
  if(m.emissive && !m.emissiveMap && m.emissive.getHex()!==0){
    m.userData._emissiveWas = m.emissive.getHex();
    m.emissive.setHex(0x000000);
  }
  m.needsUpdate=true;
  return m;
}
function loadPropGeometry(file, opts, cb){
  gltfLoader.load(file, gltf=>{
    let mesh=null; gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(o=>{ if(!mesh&&o.isMesh) mesh=o; });
    if(!mesh){ console.warn('prop GLB has no mesh:', file); return; }
    const geo=mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingBox();
    const bb=geo.boundingBox, sx=bb.max.x-bb.min.x, sy=bb.max.y-bb.min.y, sz=bb.max.z-bb.min.z;
    const s = opts.h!==undefined ? opts.h/(sy||1) : opts.w/(Math.max(sx,sz)||1);
    geo.translate(-(bb.min.x+bb.max.x)/2, -bb.min.y, -(bb.min.z+bb.max.z)/2);
    geo.scale(s,s,s);
    geo.translate(0, opts.baseY||0, 0);   // geometry bottom lands at baseY
    cb(geo, simplifyPropMaterial(mesh.material));
  }, undefined, err=>console.warn('prop load failed', file, err));
}
// Swap an InstancedMesh's placeholder box/cylinder art for real GLB art.
// rebuildPlacedObjects places instance origins at a fixed +Y offset, so the
// baked geometry puts its bottom at -thatOffset (baseY) → model sits on the
// ground without touching any matrix code.
function swapPlacedArt(inst, file, opts){
  loadPropGeometry(file, opts, (geo, mat)=>{
    inst.geometry.dispose(); inst.geometry=geo;
    if(Array.isArray(inst.material)) inst.material.forEach(m=>m.dispose()); else inst.material.dispose();
    inst.material=mat;
    // The taper needs to know how tall this particular model is, and the only
    // place that is known is right here, after loadPropGeometry has normalised
    // and scaled it. Passing a constant would make the flame move correctly on
    // one model and wrongly on the next.
    if(opts.fire){
      geo.computeBoundingBox();
      animateFire(mat, { uFireTime:_fireU, topY:geo.boundingBox.max.y, sway:opts.fire.sway });
    }
  });
}
// sway is in the model's own local units, so it scales with the model: a
// campfire's flame is a foot across and a lantern's is an inch.
// How far the flame LICKS, in each model's own local units. Only the shape
// moves — brightness is the PointLight's job, see flameFlicker().
//
// Tuned conservatively on purpose. These were raised hard in one pass on the
// reasoning that 0.9 units on a ~7-unit flame is invisible, but that was never
// actually watched: the browser they were checked in was running at about a
// frame a second, where no amount of motion looks like anything. These sit
// between the original timid values and that unverified bump — a flame that
// licks rather than one that waves. One number each if it wants more or less.
swapPlacedArt(campfireMesh,      'models/campfire.glb', {w:36, baseY:-3,  fire:{sway:2.0}});
swapPlacedArt(torchMesh,         'models/torch.glb',    {h:36, baseY:-14, fire:{sway:1.6}});
swapPlacedArt(placedLanternMesh, 'models/lantern.glb',  {h:18, baseY:-4,  fire:{sway:0.45}});

// Shared template cache for armor pieces / quiver (cloned per attachment)
const propModelCache={};   // file → {tpl, waiters[]}
function withPropModel(file, cb){
  const c=propModelCache[file];
  if(c&&c.tpl){ cb(c.tpl); return; }
  if(c){ c.waiters.push(cb); return; }
  const entry=propModelCache[file]={tpl:null, waiters:[cb]};
  gltfLoader.load(file, g=>{
    entry.tpl=g.scene;
    entry.waiters.splice(0).forEach(fn=>fn(g.scene));
  }, undefined, err=>console.warn('model load failed', file, err));
}
function applyAdjust(o, adj){
  o.position.fromArray(adj.pos);
  o.rotation.set(adj.rot[0], adj.rot[1], adj.rot[2]);
  o.scale.setScalar(adj.scale);
}
// Put a cached prop model into a bone slot, replacing whatever's there.
// `adjust` is a live {pos,rot,scale} object (mutated by the tuner). A
// per-slot token guards against a stale async load clobbering a newer one.
function setSlotModel(slot, file, adjust, tint){
  if(!slot) return;
  slot._token=(slot._token||0)+1; const token=slot._token;
  slot._adjust=adjust;
  while(slot.children.length>0) slot.remove(slot.children[0]);
  withPropModel(file, tpl=>{
    if(slot._token!==token) return;        // superseded while loading
    const m=tpl.clone();
    m.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.frustumCulled=false;
      o.material=simplifyPropMaterial(o.material.clone()); o.material.transparent=true;
      if(tint) o.material.color.multiply(new THREE.Color(tint)); }});
    slot.add(m); applyAdjust(m, adjust);
  });
}
function clearSlot(slot){
  if(!slot) return; slot._token=(slot._token||0)+1; slot._adjust=null;
  while(slot.children.length>0) slot.remove(slot.children[0]);
}

// ── Custom mobs (world editor) ────────────────────────────────────
// A custom mob clones an existing type: AI behavior and any unset stats
// come from the base; name, tint, and size are its own. Registered into
// ENEMY_CFG / EVIS / MOB_MODELS / PROP so every system treats it natively.
const customMobDefs={};
function registerCustomMob(def){
  if(!ENEMY_CFG[def.base]) return;
  customMobDefs[def.id]=def;
  ENEMY_CFG[def.id]={...ENEMY_CFG[def.base], ...(def.stats||{}), ...(worldEdits.mobs[def.id]||{}), spawnCave:!!def.cave};
  const bv=EVIS[def.base]||EVIS_DEF, sc=def.scale||1;
  EVIS[def.id]=[def.tint, Math.round(bv[1]*sc), Math.round(bv[2]*sc), Math.round(bv[3]*sc), Math.round(bv[4]*sc), bv[5]||0];
  if(MOB_MODELS[def.base]) MOB_MODELS[def.id]={...MOB_MODELS[def.base], h:Math.round(MOB_MODELS[def.base].h*sc), tint:def.tint};
  if(PROP[def.base]) PROP[def.id]=PROP[def.base];
}
function unregisterCustomMob(id){
  delete customMobDefs[id]; delete ENEMY_CFG[id]; delete EVIS[id];
  delete MOB_MODELS[id]; delete PROP[id]; delete worldEdits.mobs[id];
  worldEdits.customMobs=worldEdits.customMobs.filter(m=>m.id!==id);
  worldEdits.spawns=worldEdits.spawns.filter(s=>s.t!==id);
  for(let i=enemies.length-1;i>=0;i--) if(enemies[i].type===id) enemies.splice(i,1);
}
for(const cm of worldEdits.customMobs) registerCustomMob(cm);

// ── Player model: Protag_animations_basic ────────────────────────
// Replaces the procedural player rig while alive; the spectral box-rig
// still serves ghost form and the rat curse. Clips: Alert=idle,
// Running/Run_03=move (Run_03 on horseback), Attack=swing,
// Charged_Slash/Archery_Shot_1=melee/bow specials, Alert=revival (fallback).
let protag=null, protagSkillCue=0;
let protagTemplate=null, protagClips=null;   // for cloning remote players' models
let horseTemplate=null, horseClip=null;      // for remote riders' / standing horses

// Loaded weapon templates cache
const weaponTemplates = {};
const WEAPON_FILES = {
  sword: 'models/Sword_Basic.glb',
  axe: 'models/Double_Axe.glb',
  pickaxe: 'models/Pickaxe Basic.glb',
  bow: 'models/heavy crossbow.glb',
  shield: 'models/Coat Of Arms Shield Metal.glb'
};

// Initial position, rotation (Euler), and scale adjustments for the weapons on hand bones
// pos in world units (slots are normalized to world scale); rot in radians;
// scale multiplies the weapon's native size (~1.9 units), so scale≈30 → ~57u.
let WEAPON_ADJUST = {
  sword:   { pos: [1.7, 8.7, -20],   rot: [1.62840734641021, -1.07159265358979, -0.061592653589793],  scale: 33 },
  axe:     { pos: [0.4, 6.6, -6],    rot: [-0.151592653589793, 1.70840734641021, -1.41159265358979],  scale: 27.5 },
  pickaxe: { pos: [0.7, 4.2, 0],     rot: [-1.37159265358979, -1.62159265358979, 0.108407346410207],  scale: 24 },
  bow:     { pos: [0.9, 6.8, -16.2], rot: [-0.311592653589793, 1.62840734641021, -2.89159265358979],  scale: 38 },
  shield:  { pos: [0.9, -0.9, -5.8], rot: [0.188407346410207, 1.62840734641021, 2.71840734641021],    scale: 30 },
  // torch/lantern are the procedural objects built just below, not GLB imports,
  // so their scales are ~1-3 rather than the ~20-40 the models use.
  torch:   { pos: [2, 6, 0],      rot: [1.61840734641021, -0.021592653589793, -1.78159265358979], scale: 1.5 },
  lantern: { pos: [2, 16.9, 0.4], rot: [0, 0, -3.14159265358979],                                 scale: 3 },
  quiver:  { pos: [1.2, 16.9, -3.5], rot: [0.308407346410207, 0.428407346410207, -0.551592653589793], scale: 31 }   // arrows on the back with the bow
};

// ── Armor pieces ──────────────────────────────────────────────────
// Every armor model, one entry per distinct mesh. `purpose` picks the
// body anchor (a bone slot built on the player rig); pieces that share a
// purpose (the three helms) never show together — only the equipped tier.
// Each has its own ARMOR_ADJUST entry because every mesh fits differently;
// tune them live with the P panel (armor pieces listed in its dropdown).
const ARMOR_PIECES = {
  leather_helm:   { file:'models/Leather_Helm_Armor.glb',   purpose:'head',  label:'Leather Helm' },
  bone_helm:      { file:'models/Bone_Helm_Armor.glb',      purpose:'head',  label:'Bone Helm' },
  iron_helm:      { file:'models/Iron Helm.glb',            purpose:'head',  label:'Iron Helm' },
  leather_gorget: { file:'models/Leather_Gorget_Armor.glb', purpose:'neck',  label:'Leather Gorget' },
  iron_gorget:    { file:'models/Iron_Gorget_Armor.glb',    purpose:'neck',  label:'Iron Gorget' },
  bone_chest:     { file:'models/Bone_Chest_Armor.glb',     purpose:'chest', label:'Bone Chest' },
  iron_chest:     { file:'models/Iron_Chest_Armor.glb',     purpose:'chest', label:'Iron Chest' },
};
// Per-piece placement (world units in the anchor slot). Tuned in the P panel.
const ARMOR_ADJUST = {
  leather_helm:   { pos:[-2, 7.5, -2.7], rot:[-0.391592653589793, 0, 0],                                     scale:12.5 },
  bone_helm:      { pos:[0, 6.5, -2.7],  rot:[-0.311592653589793, -0.061592653589793, -0.061592653589793],  scale:15.5 },
  iron_helm:      { pos:[0.4, 6.7, -4.3],rot:[-0.761592653589793, 0.018407346410207, 0.058407346410207],    scale:15.5 },
  leather_gorget: { pos:[0, 1, 0],       rot:[0, 0, 0],                                                      scale:12 },
  iron_gorget:    { pos:[0, 1, 0],       rot:[0, 0, 0],                                                      scale:13 },
  bone_chest:     { pos:[-1.2, 5.1, 3.5],rot:[0.308407346410207, 0.098407346410207, 0],                     scale:29.5 },
  iron_chest:     { pos:[-0.4, 12.9, 6.7],rot:[0.348407346410207, 0, -0.021592653589793],                   scale:24.5 },
};

// Build procedural objects for torch and lantern
{
  const torchGrp = new THREE.Group();
  const stick = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 18, 6),
    new THREE.MeshStandardMaterial({color: 0x5c3c24, roughness: 0.8})
  );
  stick.rotation.z = Math.PI / 2;
  stick.position.set(0, 0, 0);
  stick.castShadow = true;
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(2.5, 6, 6),
    new THREE.MeshBasicMaterial({color: 0xffaa00})
  );
  flame.position.set(9, 0, 0);
  flame.rotation.z = -Math.PI / 2;
  torchGrp.add(stick, flame);
  weaponTemplates['torch'] = torchGrp;

  const lanternGrp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(6, 10, 6),
    new THREE.MeshStandardMaterial({color: 0x1a1a1a, metalness: 0.9, roughness: 0.1})
  );
  body.castShadow = true;
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(2, 2, 6, 8),
    new THREE.MeshBasicMaterial({color: 0xffeedd})
  );
  core.position.set(0, 0, 0);
  lanternGrp.add(body, core);
  weaponTemplates['lantern'] = lanternGrp;
}

// Re-resolve the held prop (weapon/torch/lantern + shield/quiver) from the
// current player state. force=true rebuilds even if the kind didn't change
// (used after an async template swap or a tuner edit).
function refreshHeldProp(force){
  if (!protag) return;
  if (force) { protag.propKind = null; protag.showShield = null; protag.showQuiver = null; }
  protagProp(player.weapon==='sword'&&player.hasSword?'sword':
    player.weapon==='bow'&&player.hasBow?'bow':
    player.weapon==='axe'&&player.hasAxe?'axe':
    player.weapon==='pickaxe'&&player.hasPickaxe?'pickaxe':
    player.weapon==='torch'?'torch':
    player.weapon==='lantern'?'lantern':null,
    player.weapon==='sword'?(player.swordTier||1):player.weapon==='bow'?(player.bowTier||1):1);
}

// Load weapon assets asynchronously
{
  const gl = gltfLoader;
  for (const [key, file] of Object.entries(WEAPON_FILES)) {
    gl.load(file, gltf => {
      weaponTemplates[key] = gltf.scene;
      refreshHeldProp(true);   // refresh current weapon model if protag is already loaded
    }, undefined, err => console.warn(`Failed to load weapon: ${key}`, err));
  }
}

// Held torch / lantern: swap the procedural stand-ins for the real GLB art.
// The groups mimic the old stand-in layout (torch lying along +X, lantern
// hanging at the grip) so the existing WEAPON_ADJUST values keep working.
loadPropGeometry('models/torch.glb', {h:26, baseY:0}, (geo, mat)=>{
  const grp=new THREE.Group();
  const m=new THREE.Mesh(geo, mat); m.castShadow=true;
  m.rotation.z=-Math.PI/2; m.position.x=-13;   // lay along +X, grip at the middle
  // The HELD torch was the one fire in the game that never moved. Placed fires
  // get animateFire through swapPlacedArt, but this loads through
  // loadPropGeometry, which has no such hook — so the torch you actually carry
  // and look at all night was a photograph while every torch on a wall licked.
  //
  // The sway is in MODEL space, and the model's own +Y is up the shaft, so it
  // stays correct through the -90 degrees of Z above and through whatever the
  // hand bone does with it afterwards.
  geo.computeBoundingBox();
  animateFire(mat, { uFireTime:_fireU, topY:geo.boundingBox.max.y, sway:1.5 });
  grp.add(m);
  const flame=new THREE.Mesh(new THREE.SphereGeometry(3.2,7,6),
    new THREE.MeshBasicMaterial({color:0xffa040, transparent:true, opacity:0.85,
      blending:THREE.AdditiveBlending, depthWrite:false}));
  flame.position.set(13,0,0);                  // glow at the head end
  grp.add(flame);
  weaponTemplates['torch']=grp; refreshHeldProp(true);
});
loadPropGeometry('models/lantern.glb', {h:12, baseY:0}, (geo, mat)=>{
  const grp=new THREE.Group();
  const m=new THREE.Mesh(geo, mat); m.castShadow=true;
  m.position.y=-8;                             // hang below the grip by its ring
  grp.add(m);
  const core=new THREE.Mesh(new THREE.SphereGeometry(2.2,8,6),
    new THREE.MeshBasicMaterial({color:0xffeedd, transparent:true, opacity:0.9,
      blending:THREE.AdditiveBlending, depthWrite:false}));
  core.position.y=-3;                          // warm glow in the glass
  grp.add(core);
  weaponTemplates['lantern']=grp; refreshHeldProp(true);
});

if (SKINNING_OK) gltfLoader.load('models/Protag_animations_basic.glb', gltf=>{
  // Boot set satisfied: the player has a body. Everything still in flight keeps
  // loading behind the game rather than in front of it.
  bootScreen.settle('models/Protag_animations_basic.glb');
  const inner=gltf.scene;
  inner.updateMatrixWorld(true);
  let minY=1e9,maxY=-1e9; const v=new THREE.Vector3();
  inner.traverse(o=>{ if(!o.isSkinnedMesh)return;
    const pos=o.geometry.attributes.position, step=Math.max(1,Math.floor(pos.count/400));
    for(let i=0;i<pos.count;i+=step){ v.fromBufferAttribute(pos,i); o.applyBoneTransform(i,v); o.localToWorld(v);
      if(v.y<minY)minY=v.y; if(v.y>maxY)maxY=v.y; } });
  const natH=Math.max(0.01,maxY-minY), sc=CHAR_H/natH;   // scaled to the global CHAR_H
  inner.scale.setScalar(sc); inner.position.y=-minY*sc; inner.rotation.y=Math.PI;
  inner.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.frustumCulled=false; o.material.transparent=true; } });
  const obj=new THREE.Group(); obj.add(inner); scene.add(obj); obj.visible=false;
  inner.updateMatrixWorld(true);
  const mixer=new THREE.AnimationMixer(inner);
  const clip=n=>gltf.animations.find(c=>c.name===n);
  const mk=c=>c?mixer.clipAction(c):null;
  const actions={
    idle: mk(clip('Alert')),
    walk: mk(clip('Running') || clip('Walking')),
    fast: mk(clip('Run_03') || clip('Running')),
    attack: mk(clip('Attack') || clip('Left_Slash')),
    skill1: mk(clip('Charged_Slash') || clip('Reaping_Swing')),
    skill2: mk(clip('Archery_Shot_1') || clip('Archery_Shot_2')),
    arise: mk(clip('Arise') || clip('Alert'))
  };
  for(const k of ['attack','skill1','skill2','arise']) if(actions[k]) actions[k].setLoop(THREE.LoopOnce);
  
  // Setup bone slots for weapon and shield
  let handBone=null, leftHandBone=null;
  inner.traverse(o=>{
    if(!handBone&&o.isBone&&/RightHand$/i.test(o.name)) handBone=o;
    if(!leftHandBone&&o.isBone&&/LeftHand$/i.test(o.name)) leftHandBone=o;
  });
  
  // The hand bones inherit a strange world scale from this rig (~0.75 even
  // though the model is scaled ~75×). Counter-scale each slot so its interior
  // is world-space: 1 local unit = 1 world unit. Weapon adjust values below
  // are then intuitive world units and survive a future model/scale swap.
  inner.updateMatrixWorld(true);
  const _v=new THREE.Vector3();
  const weaponSlot = new THREE.Group();
  if(handBone){ handBone.getWorldScale(_v); weaponSlot.scale.setScalar(1/(_v.x||1)); handBone.add(weaponSlot); }

  const shieldSlot = new THREE.Group();
  if(leftHandBone){ leftHandBone.getWorldScale(_v); shieldSlot.scale.setScalar(1/(_v.x||1)); leftHandBone.add(shieldSlot); }

  // Armor + quiver anchor points — one world-unit slot per body "purpose".
  // Each armor piece declares which purpose it attaches to (ARMOR_PIECES):
  // helm→head, gorget→neck, breastplate→chest. All tunable via the P panel.
  const bones={};
  inner.traverse(o=>{ if(o.isBone) bones[o.name]=o; });
  const findBone=re=>{ for(const n in bones) if(re.test(n)) return bones[n]; return null; };
  const mkSlot=b=>{ if(!b) return null; const g=new THREE.Group();
    b.getWorldScale(_v); g.scale.setScalar(1/(_v.x||1)); b.add(g); return g; };
  const headB =bones['Head']    || findBone(/head$/i);
  const neckB =bones['neck']    || findBone(/neck/i) || headB;
  const chestB=bones['Spine01'] || findBone(/spine01/i) || findBone(/spine/i);
  const slots={
    head:  mkSlot(headB),
    neck:  mkSlot(neckB),
    chest: mkSlot(chestB),
    quiver:mkSlot(chestB),
  };

  protag={obj,inner,mixer,actions,cur:null,busyUntil:0,lx:null,lz:null,
    handBone,leftHandBone,weaponSlot,shieldSlot,slots,
    propKind:null,showShield:null,showQuiver:null,wasGhost:false};
  protagTemplate=inner; protagClips=gltf.animations;   // remote players clone this
  updateArmorVisuals();                                // show already-equipped armor
}, undefined, err=>console.warn('protag load failed',err));

function protagPlay(name){
  const P=protag; if(!P||P.cur===name||!P.actions[name])return;
  if(P.cur&&P.actions[P.cur])P.actions[P.cur].fadeOut(0.18);
  P.actions[name].reset().fadeIn(0.18).play();
  P.cur=name;
}
function protagOnce(name,t){
  const P=protag; if(!P||!P.actions[name])return;
  if(P.cur&&P.actions[P.cur])P.actions[P.cur].fadeOut(0.08);
  P.actions[name].reset().fadeIn(0.08).play();
  P.cur=name;
  P.busyUntil=t+Math.min(P.actions[name].getClip().duration*0.85,1.4);
}
function protagProp(kind,tier){
  const P=protag; if(!P||!P.weaponSlot)return;
  
  // 1. Update weapon
  if(P.propKind!==kind){
    P.propKind=kind;
    while(P.weaponSlot.children.length>0) P.weaponSlot.remove(P.weaponSlot.children[0]);
    
    if(kind && weaponTemplates[kind]){
      const wModel = weaponTemplates[kind].clone();
      wModel.traverse(o=>{
        if(o.isMesh){
          o.castShadow=true; o.frustumCulled=false;
          const src=o.material;
          o.material=src.clone(); o.material.transparent=true;
          // Material.clone() copies a FIXED LIST of material parameters, and
          // onBeforeCompile / customProgramCacheKey are not on it — three has no
          // way to know a patch exists. So every shader patch on a weapon
          // material was silently discarded the moment the prop was built, which
          // is why the held torch stayed a photograph while the animateFire call
          // on its template looked perfectly correct. Carry them across.
          if(Object.prototype.hasOwnProperty.call(src,'onBeforeCompile')){
            o.material.onBeforeCompile = src.onBeforeCompile;
            if(Object.prototype.hasOwnProperty.call(src,'customProgramCacheKey'))
              o.material.customProgramCacheKey = src.customProgramCacheKey;
            o.material.needsUpdate = true;
          }
        }
      });
      P.weaponSlot.add(wModel);
      
      const adj = WEAPON_ADJUST[kind] || {pos:[0,0,0], rot:[0,0,0], scale:1};
      wModel.position.fromArray(adj.pos);
      wModel.rotation.set(adj.rot[0], adj.rot[1], adj.rot[2]);
      wModel.scale.setScalar(adj.scale);
    }
  }
  
  if(kind && P.weaponSlot.children.length>0){
    const wModel = P.weaponSlot.children[0];
    // Per-tier finish: iron pale, steel icy, mithril cyan-glow, runic violet-glow
    const TINT={2:[0xc8ccd4,0x000000], 3:[0x9fd0ff,0x1a3a5a],
                4:[0x40e0ff,0x0d5a72], 5:[0xdf80ff,0x4a1a6a]};
    const [col,emis]=TINT[tier]||[0xffffff,0x000000];
    wModel.traverse(o=>{
      if(o.isMesh && o.material){
        o.material.color.setHex(col);
        if(o.material.emissive) o.material.emissive.setHex(emis);
      }
    });
  }

  // 2. Update shield (equipped automatically with 1H weapons)
  const showShield = (kind==='sword' || kind==='axe');
  if(P.showShield!==showShield){
    P.showShield=showShield;
    while(P.shieldSlot.children.length>0) P.shieldSlot.remove(P.shieldSlot.children[0]);
    
    if(showShield && weaponTemplates['shield']){
      const sModel = weaponTemplates['shield'].clone();
      sModel.traverse(o=>{
        if(o.isMesh){
          o.castShadow=true; o.frustumCulled=false;
          o.material=o.material.clone(); o.material.transparent=true;
        }
      });
      P.shieldSlot.add(sModel);
      
      const adj = WEAPON_ADJUST['shield'] || {pos:[0,0,0], rot:[0,0,0], scale:1};
      sModel.position.fromArray(adj.pos);
      sModel.rotation.set(adj.rot[0], adj.rot[1], adj.rot[2]);
      sModel.scale.setScalar(adj.scale);
    }
  }

  // 3. Quiver on the back whenever the crossbow is in hand
  const showQuiver = kind==='bow';
  if(P.showQuiver!==showQuiver && P.slots && P.slots.quiver){
    P.showQuiver=showQuiver;
    if(!showQuiver) clearSlot(P.slots.quiver);
    else setSlotModel(P.slots.quiver, 'models/Arrows.glb', WEAPON_ADJUST.quiver, 0);
  }
}

// ── 3D armor on the player ────────────────────────────────────────
// Attach one armor piece to its anchor slot with its own tuned placement.
// `tint` recolors the mesh (steel reuses iron art with the tier-3 blue).
// A signature guards against needless rebuilds every equip/frame.
function showArmorPiece(pieceId, tint){
  const P=protag; if(!P||!P.slots) return;
  const piece=ARMOR_PIECES[pieceId]; if(!piece) return;
  const slot=P.slots[piece.purpose]; if(!slot) return;
  const sig=pieceId+'#'+(tint||0);
  if(slot._sig===sig){
    if(slot.children[0]) applyAdjust(slot.children[0], ARMOR_ADJUST[pieceId]);   // adjust may have changed
    return;
  }
  slot._sig=sig; slot._piece=pieceId;
  setSlotModel(slot, piece.file, ARMOR_ADJUST[pieceId], tint);
}
function hideArmorPurpose(purpose){
  const P=protag; if(!P||!P.slots) return; const slot=P.slots[purpose]; if(!slot) return;
  slot._sig=null; slot._piece=null; clearSlot(slot);
}
// Worn armor shows three visible pieces on the player: a helm (head slot),
// a breastplate (chest slot), and a matching gorget at the throat (paired
// with the chest tier). Legs/boots still give defense but aren't rendered.
// Material tiers: 1 leather · 2 bone · 3 bronze · 4 steel (steel = iron art
// with the icy tier-4 tint). Bronze/steel reuse the iron models.
function updateArmorVisuals(){
  const P=protag; if(!P||!P.slots) return;
  const headMat  = (player.armor&&player.armor.head)  || 0;
  const chestMat = (player.armor&&player.armor.chest) || 0;

  // Material tint: steel icy, mithril cyan, runic violet (lower tiers untinted)
  const matTint = m => m===4 ? 0x9fd0ff : m===5 ? 0x40e0ff : m===6 ? 0xdf80ff : 0;

  // Helm
  if(headMat>0){
    showArmorPiece(headMat===1?'leather_helm':headMat===2?'bone_helm':'iron_helm', matTint(headMat));
  } else hideArmorPurpose('head');

  // Breastplate + matching gorget (leather/bone → leather set, bronze+ → iron set)
  if(chestMat>0){
    const tint=matTint(chestMat);
    showArmorPiece(chestMat<=2 ? 'bone_chest'     : 'iron_chest',     tint);
    showArmorPiece(chestMat<=2 ? 'leather_gorget' : 'iron_gorget',    tint);
  } else { hideArmorPurpose('chest'); hideArmorPurpose('neck'); }
}

// ── Interactive Gear Tuner (Press 'P' to Toggle) ────────────────────
// Live editor for where every held/worn model sits on the character:
// weapons, torch/lantern, quiver, and each armor piece — position,
// rotation, scale. Armor pieces preview on the player as you select them
// (and stack, so you can dial in a full matching set), then "Copy Config
// JSON" exports both WEAPON_ADJUST and ARMOR_ADJUST to paste back here.
let tunerPanel=null, activeTuningTarget='sword';
const TUNER_TARGETS=[
  {group:'Weapons', items:[
    {key:'sword',label:'Sword'},{key:'axe',label:'Axe'},{key:'pickaxe',label:'Pickaxe'},
    {key:'bow',label:'Crossbow (Bow)'},{key:'shield',label:'Shield'}]},
  {group:'Held / Back', items:[
    {key:'torch',label:'Torch'},{key:'lantern',label:'Lantern'},{key:'quiver',label:'Quiver'}]},
  {group:'Armor', items:Object.keys(ARMOR_PIECES).map(id=>({key:id,label:ARMOR_PIECES[id].label}))},
];
// The tuner edits whichever adjust table owns the key (armor vs weapon/held).
function adjustFor(key){ return ARMOR_PIECES[key] ? ARMOR_ADJUST[key] : WEAPON_ADJUST[key]; }
// Make the selected target visible on the player so there's something to tune.
function selectTunerTarget(key){
  if(ARMOR_PIECES[key]){ showArmorPiece(key, 0); return; }   // preview armor uncolored
  if(key==='shield'){ if(player.weapon!=='sword'&&player.weapon!=='axe'){player.weapon='sword'; player.hasSword=true;} refreshHeldProp(true); return; }
  if(key==='quiver'){ player.weapon='bow'; player.hasBow=true; refreshHeldProp(true); return; }
  if(key==='torch'||key==='lantern'){ player.weapon=key; refreshHeldProp(true); return; }
  player.weapon=key; player['has'+key.charAt(0).toUpperCase()+key.slice(1)]=true; refreshHeldProp(true);
}
function initTuner(){
  if(tunerPanel)return;
  tunerPanel=document.createElement('div');
  tunerPanel.style.position='fixed'; tunerPanel.style.top='10px'; tunerPanel.style.right='10px';
  tunerPanel.style.backgroundColor='rgba(20,16,12,0.92)'; tunerPanel.style.color='#e8dcc0';
  tunerPanel.style.border='2px solid #c8a25a'; tunerPanel.style.padding='12px';
  tunerPanel.style.zIndex='9999'; tunerPanel.style.fontFamily='monospace';
  tunerPanel.style.fontSize='12px'; tunerPanel.style.width='280px'; tunerPanel.style.borderRadius='6px';
  tunerPanel.style.boxShadow='0 4px 15px rgba(0,0,0,0.6)';
  tunerPanel.style.maxHeight='94vh'; tunerPanel.style.overflowY='auto';

  const options=TUNER_TARGETS.map(g=>
    `<optgroup label="${g.group}">`+g.items.map(it=>`<option value="${it.key}">${it.label}</option>`).join('')+`</optgroup>`).join('');
  let html=`<div style="text-align:center;font-weight:bold;margin-bottom:8px;border-bottom:1px solid #c8a25a;padding-bottom:4px;color:#c8a25a;">GEAR TUNER</div>`;
  html+=`<div style="margin-bottom:8px;"><label>Target: </label><select id="tuneTarget" style="background:#2d251e;color:#fff;border:1px solid #c8a25a;padding:2px;max-width:200px;">${options}</select></div>`;
  // pos/scale are world-space units (slots are normalized to world scale)
  const sliders=[
    {name:'pos.x',key:'px',min:-60,max:60,step:0.1},
    {name:'pos.y',key:'py',min:-60,max:60,step:0.1},
    {name:'pos.z',key:'pz',min:-60,max:60,step:0.1},
    {name:'rot.x',key:'rx',min:-Math.PI,max:Math.PI,step:0.01},
    {name:'rot.y',key:'ry',min:-Math.PI,max:Math.PI,step:0.01},
    {name:'rot.z',key:'rz',min:-Math.PI,max:Math.PI,step:0.01},
    {name:'scale',key:'sc',min:0.5,max:80,step:0.5}
  ];
  sliders.forEach(s=>{
    html+=`<div style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
      <span style="width:50px;">${s.name}</span>
      <input type="range" id="tune_${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" style="flex:1;margin:0 8px;">
      <span id="val_${s.key}" style="width:45px;text-align:right;">0</span>
    </div>`;
  });
  html+=`<button id="tuneCopy" style="width:100%;margin-top:10px;background:#c8a25a;color:#1a1005;font-weight:bold;border:none;padding:6px;cursor:pointer;border-radius:3px;">Copy Config JSON</button>`;
  html+=`<button id="tuneClear" style="width:100%;margin-top:6px;background:#3a2f22;color:#e8dcc0;border:1px solid #c8a25a;padding:5px;cursor:pointer;border-radius:3px;">Clear Armor Preview</button>`;
  tunerPanel.innerHTML=html; document.body.appendChild(tunerPanel);

  const sel=document.getElementById('tuneTarget');
  sel.addEventListener('change',e=>{
    activeTuningTarget=e.target.value; updateSlidersFromConfig(); selectTunerTarget(activeTuningTarget);
  });
  sliders.forEach(s=>{
    const el=document.getElementById(`tune_${s.key}`);
    el.addEventListener('input',e=>{
      const v=parseFloat(e.target.value); document.getElementById(`val_${s.key}`).innerText=v.toFixed(2);
      const adj=adjustFor(activeTuningTarget); if(!adj)return;
      if(s.key==='px')adj.pos[0]=v; if(s.key==='py')adj.pos[1]=v; if(s.key==='pz')adj.pos[2]=v;
      if(s.key==='rx')adj.rot[0]=v; if(s.key==='ry')adj.rot[1]=v; if(s.key==='rz')adj.rot[2]=v;
      if(s.key==='sc')adj.scale=v;
      applyActiveTuning();
    });
  });
  document.getElementById('tuneCopy').addEventListener('click',()=>{
    const jsonStr='WEAPON_ADJUST = '+JSON.stringify(WEAPON_ADJUST,null,2)+'\n\nARMOR_ADJUST = '+JSON.stringify(ARMOR_ADJUST,null,2);
    navigator.clipboard.writeText(jsonStr).then(()=>alert("Gear tuning JSON copied to clipboard!"));
    console.log(jsonStr);
  });
  document.getElementById('tuneClear').addEventListener('click',()=>{
    for(const p of ['head','neck','chest']) hideArmorPurpose(p);
  });
  updateSlidersFromConfig(); selectTunerTarget(activeTuningTarget);
}
// Re-apply the active target's adjust to whatever it's controlling: armor
// pieces and the quiver re-transform in place; weapons/held rebuild.
function applyActiveTuning(){
  const P=protag;
  if(ARMOR_PIECES[activeTuningTarget]){
    const slot=P&&P.slots&&P.slots[ARMOR_PIECES[activeTuningTarget].purpose];
    if(slot) slot.children.forEach(c=>applyAdjust(c, ARMOR_ADJUST[activeTuningTarget]));
  } else if(activeTuningTarget==='quiver'){
    const slot=P&&P.slots&&P.slots.quiver;
    if(slot) slot.children.forEach(c=>applyAdjust(c, WEAPON_ADJUST.quiver));
  } else refreshHeldProp(true);
}
// Console handles for dev/debug: game state + armor refresh
window._dev={player, inv, G, skills, placedObjects, drops, map, T, resourceHp, enemies, guards,
  blocked:(x,y,r)=>boxBlocked(x,y,r),
  mineOnce(tx,ty){ const tt=map[ty][tx]; depleteNode(tx,ty,tt,tx*TILE+24,ty*TILE+24); return tt; },
  fallingTrees:()=>_treeActors.filter(a=>a.active).map(a=>({t:+a.t.toFixed(2), lean:+a.grp.quaternion.angleTo(new THREE.Quaternion()).toFixed(2), opacity:+a.cMat.opacity.toFixed(2)})),
  findTree(){ for(let ty=0;ty<map.length;ty++)for(let tx=0;tx<(map[ty]||[]).length;tx++)if(map[ty][tx]===T.TREE)return[tx,ty]; return null; },
  stepFalls(dt){ updateFallingTrees(dt); return this.fallingTrees(); },
  probeFall(){ const a=_treeActors.find(x=>x.active); if(!a)return null;
    a.grp.updateMatrixWorld(true);
    const base=new THREE.Vector3(), tip=new THREE.Vector3(a.grp.position.x,0,a.grp.position.z);
    a.grp.getWorldPosition(base);
    const canopy=a.grp.children[1];    // cone
    const wp=new THREE.Vector3(); canopy.getWorldPosition(wp);
    return {leanRad:+a.grp.quaternion.angleTo(new THREE.Quaternion()).toFixed(2),
      baseXZ:[+base.x.toFixed(0),+base.z.toFixed(0)], baseY:+base.y.toFixed(1),
      canopyY:+wp.y.toFixed(1), canopyHorizFromBase:+Math.hypot(wp.x-base.x,wp.z-base.z).toFixed(1)}; },
  fellTree(){ const t=this.findTree(); if(!t)return 'none'; for(let i=0;i<TREE_HP;i++)depleteNode(t[0],t[1],T.TREE,t[0]*TILE+24,t[1]*TILE+24); return 'felled '+t; },
  get protag(){return protag;},
  updateArmorVisuals, refreshHeldProp,
  showArmorPiece, hideArmorPurpose,
  armorPieces:()=>Object.keys(ARMOR_PIECES),
  lootGear:()=>LOOT_GEAR,
  bagKeys:()=>BAG_ITEMS.map(b=>b.k),
  packItemLabels:()=>packItems().map(it=>it.lab+(it.n!=null?' x'+it.n:'')),
  lootThumbsReady:()=>Object.keys(lootThumbs),
  lootThumb:(k)=>lootThumbs[k],
  lootGeoReady:()=>Object.keys(_lootGeo),
  spawnLoot(key,dx=0,dy=0){ drops.push({type:key,x:player.x+dx,y:player.y+dy,lifetime:600}); return 'spawned '+key; },
  simulateKill(type='wolf',opts={}){ hooks.onKill({type,x:player.x,y:player.y,...opts}); return 'killed '+type; },
  resetForNewCharacter,
  // gameTime is re-derived from the shared world clock every frame, so
  // assigning _dev.G.gameTime does nothing. Shift the clock instead.
  setHour(h){
    const D=DAY_CYCLE_SEC, cur=((worldNow()%D)+D)%D;
    shiftWorldTime((h/24)*D - cur);
    return this.hhmm();
  },
  hhmm(){
    const D=DAY_CYCLE_SEC, f=((G.gameTime%D)+D)%D/D;
    return String(Math.floor(f*24)).padStart(2,'0')+':'+String(Math.floor(f*1440%60)).padStart(2,'0');
  },
  // ── Screenshot rig ──────────────────────────────────────────────
  // Three hooks that exist purely so before/after comparison shots are
  // reproducible. Without freezeTime the sun drifts mid-session; without cam()
  // the framing is hand-done and the two shots don't line up.
  freezeTime(on=true){
    _timeFrozen = on ? worldNow() : null;
    if(!on) _timeShift = 0;   // resume on the real shared clock, not a stale offset
    G.gameTime = worldNow();
    return _timeFrozen===null ? 'time running' : 'time frozen at '+this.hhmm();
  },
  // camAngle/camPitch/camZoom are module-scoped and were the only camera
  // levers with no console handle, so framing couldn't be scripted at all.
  cam(o){
    if(o){
      if(o.angle!==undefined) camAngle=o.angle;
      if(o.pitch!==undefined) camPitch=Math.max(0.06, Math.min(1.54, o.pitch));
      if(o.zoom !==undefined) camZoom =Math.max(0.30, Math.min(3.00, o.zoom));
    }
    return {angle:+camAngle.toFixed(3), pitch:+camPitch.toFixed(3), zoom:+camZoom.toFixed(3)};
  },
  // Stamps every screenshot with the state that produced it, so a folder of
  // PNGs stays interpretable after the fact.
  shot(){
    const r=renderer.info.render;
    return JSON.stringify({
      hour:this.hhmm(), frozen:_timeFrozen!==null,
      tile:[Math.floor(player.x/TILE), Math.floor(player.y/TILE)],
      cam:this.cam(), moonPhase:G.moonPhase, moonBright:+(G.moonBright||0).toFixed(2),
      fps:_perf.fps(), medianMs:_perf.median(),
      calls:r.calls, tris:r.triangles,
      exposure:renderer.toneMappingExposure, envIntensity:_envApplied,
      shadows:renderer.shadowMap.enabled,
    });
  },
  perf:()=>JSON.stringify(_perf.report()),
  get scene(){ return scene; }, get sky(){ return sky; }, get camera(){ return camera; },
  // Live sky exposure. Forces a PMREM re-bake, so the env map and the visible
  // dome never disagree while you're tuning.
  skyGain:(v)=>sky.setGain(v),
  clouds:(v)=>sky.setClouds(v),
  shadowFit(b){ if(b!==undefined) _shadowFitOn=!!b; return _shadowFitOn; },
  macro(v){ if(v!==undefined) _macroU.value=v; return _macroU.value; },
  slope(v){ if(v!==undefined) _slopeU.value=v; return _slopeU.value; },
  terrain(wx,wz){ const x=wx??player.x, z=wz??player.y;
    return JSON.stringify({ h:+heightAt(x,z).toFixed(1), amplitude:terrain.amplitude,
      slope:terrain.slopeAt(x,z) }); },
  fx(){ return JSON.stringify({ excluded:refreshFxList(), visible:fxGroup.visible }); },
  // Which look path is live, and why. Pointer lock failing used to be entirely
  // invisible from inside the game; this makes "the mouse does not turn the
  // view" answerable in one call instead of an afternoon.
  look(){
    return JSON.stringify({
      fp: camMode().fp,
      pointerLock: document.pointerLockElement === G.canvas,
      deniedReason: _lookDenied,
      path: camMode().fp ? (document.pointerLockElement===G.canvas ? 'pointer-lock' : 'free-look') : 'n/a',
      freeLookActive: fpFreeLookActive(),
      cursor: _flX===null ? null : [_flX,_flY],
      pointerOutsideWindow: _flOutside, windowFocused: document.hasFocus(),
      sens: prefs.lookSens, invertY: !!prefs.invertY,
      runModeEngaged: keyboardRunning(), actuallyRunning: !!player.running,
      dtapLatched: _dtapRun, dtap: _dtapDbg, dtapWindowMs: DTAP_MS,
      fireClock: +_fireU.value.toFixed(3),
      flickerNow: +flameFlicker(_fireU.value, 0).toFixed(3),
      sprintKeyHeld: !!keys['shift'], speedMult: (touchSprinting()||keyboardRunning())?SPRINT_MULT:1,
      camAngle:+camAngle.toFixed(3), fpPitch:+fpPitch.toFixed(3),
    });
  },
  // Stand a dressed stand-in rig in front of the player, for looking at.
  // Outfits are the kind of thing that can only be judged by eye, and hunting
  // down a wandering guard every time you move a belt is not a workflow.
  //   _dev.rig()            one of every style, in a row
  //   _dev.rig('guard')     just that one
  //   _dev.rig(null)        clear them
  //
  // ⚠ IT SHOWS EACH ROLE AT ITS REAL BUILD, and that is the whole point. This
  // used to hard-code 16/36/11 with a 6.5 head for everyone. Body dressing is
  // built FROM the dimensions (`buildBodyDressing(three, S, dims)`), so the
  // geometry on screen was a genuinely different buffer from the one the town
  // gets — tune a tabard against a 36-tall preview and it lands somewhere else
  // on a 52-tall guard. It also forced one skin tone across thirteen roles that
  // now ship five. Pass `opts` to override for a deliberate close-up:
  //   _dev.rig('guard', 0, -3, {bh:70, hr:9})
  rig(style, dtx=0, dty=-3, opts=null){
    for(const g of (_devRigs||[])){ scene.remove(g); }
    _devRigs = [];
    if(style===null) return 'cleared';
    const list = style ? [style] : Object.keys(RIG_STYLES);
    list.forEach((s,i)=>{
      const g = makeRig();
      const b = Object.assign({}, rigBuild(s), opts||{});
      const st = RIG_STYLES[s];
      const skin = (st && typeof st.skin === 'number') ? st.skin : true;
      configureRig(g, 0x8a8a8a, b.bw, b.bh, b.bd, b.hr, 0, skin);
      dressRig(g, s);
      const x = player.x + (dtx + (i - (list.length-1)/2) * 1.1) * TILE;
      const z = player.y + dty*TILE;
      g.position.set(x, heightAt(x,z), z);
      // The default camera sits at +Z and looks toward -Z, and the rig's own
      // front is -Z, so an unrotated rig faces AWAY. PI turns it around.
      g.rotation.y = Math.PI;
      scene.add(g); _devRigs.push(g);
    });
    return list.join(', ');
  },
  // Sail to the Saltmere coast, or come back. The boat is the in-game route;
  // this is for looking at the place without one.
  coast(where){
    if(where==='home'||where==='back'){
      player.x = COAST_MAINLAND_DOCK.x*TILE+TILE/2; player.y = COAST_MAINLAND_DOCK.y*TILE+TILE/2;
      return 'mainland dock';
    }
    ensureCoastSurface();
    const L = (where==='village') ? {x:COAST_VILLAGE.x+13,y:COAST_VILLAGE.y+7} : COAST_LANDING;
    player.x = L.x*TILE+TILE/2; player.y = L.y*TILE+TILE/2;
    return JSON.stringify({at:[L.x,L.y], tile:map[L.y][L.x],
      surface: coastSurface ? coastSurface.canvas.width+'x'+coastSurface.canvas.height : 'none',
      plots: COAST_HOUSE_PLOTS.length, piers: COAST_DOCK_TILES.length});
  },
  grass(o){
    if(o){
      if(o.wind!==undefined) _grassMat.uniforms.uWindAmt.value=o.wind;
      if(o.gust!==undefined) _grassMat.uniforms.uGustFreq.value=o.gust;
      if(o.radius!==undefined || o.perTile!==undefined){
        _grassOverride = Object.assign({}, _grassOverride);
        if(o.radius!==undefined)  _grassOverride.radius  = o.radius;
        if(o.perTile!==undefined) _grassOverride.perTile = o.perTile;
        _grassDirty = true;
      }
      if(o.warpEdge!==undefined){ _grassWarpEdge = !!o.warpEdge; _grassDirty = true; }
      if(o.fastH!==undefined){ _grassFastH = !!o.fastH; _grassDirty = true; }
      if(o.reset){ _grassOverride = null; _grassWarpEdge = true; _grassDirty = true; }
      if(o.rebuild) _grassDirty=true;
    }
    return JSON.stringify({ blades:grassMesh.count, pool:GRASS_MAX, cfg:_grassCfg(),
      rebuildMs:+_grassMs.toFixed(2), warpEdge:_grassWarpEdge,
      stat:_gStat,
      builtFar:+(_grassFar/TILE).toFixed(1), viewFar:+(_view.far/TILE).toFixed(1),
      builtHeading:[+_grassFx.toFixed(3),+_grassFz.toFixed(3)],
      viewHeading:[+_view.fx.toFixed(3),+_view.fz.toFixed(3)],
      builtAt:[_grassTx,_grassTy], playerAt:[Math.floor(player.x/TILE),Math.floor(player.y/TILE)],
      wind:_grassMat.uniforms.uWindAmt.value, gust:_grassMat.uniforms.uGustFreq.value });
  },
  // Which GPU are we ACTUALLY on? On a hybrid laptop this is the difference
  // between the discrete card and the iGPU, and every perf number is
  // meaningless until you know which one answered.
  gpu(){
    const gl = renderer.getContext();
    let r='(blocked)', v='(blocked)';
    try{ const e=gl.getExtension('WEBGL_debug_renderer_info');
         if(e){ r=gl.getParameter(e.UNMASKED_RENDERER_WEBGL); v=gl.getParameter(e.UNMASKED_VENDOR_WEBGL); } }catch(_){}
    return JSON.stringify({ renderer:r, vendor:v, tier:getTier(),
      maxTexture:gl.getParameter(gl.MAX_TEXTURE_SIZE),
      webgl2:renderer.capabilities.isWebGL2,
      anisotropy:renderer.capabilities.getMaxAnisotropy() });
  },
  sunInfo:()=>JSON.stringify({ pos:sun.position.toArray().map(v=>+v.toFixed(0)),
    target:sun.target.position.toArray().map(v=>+v.toFixed(0)),
    intensity:+sun.intensity.toFixed(2), castShadow:sun.castShadow,
    bias:sun.shadow.bias, normalBias:sun.shadow.normalBias,
    mapAllocated:!!sun.shadow.map, autoUpdate:renderer.shadowMap.autoUpdate,
    type:renderer.shadowMap.type }),
  // What the sky is actually feeding the frame. The horizon colour also drives
  // fog and the clear colour, so if it reads white the whole distance washes
  // out and it looks like a fog bug rather than a sky one.
  skyProbe(){
    const h=sky.horizonColor();
    let u=null;
    scene.traverse(o=>{ const m=o.material;
      if(!u && m && m.uniforms && m.uniforms.sunPosition){
        u={ sun:m.uniforms.sunPosition.value.toArray().map(v=>+v.toFixed(3)),
            turbidity:+m.uniforms.turbidity.value.toFixed(2),
            rayleigh:+m.uniforms.rayleigh.value.toFixed(2),
            mieCoefficient:+m.uniforms.mieCoefficient.value.toFixed(4),
            mieG:+m.uniforms.mieDirectionalG.value.toFixed(3),
            scale:o.scale.x, visible:o.visible, toneMapped:m.toneMapped }; }});
    return JSON.stringify({ skyUniforms:u,
      horizonLinear:[+h.r.toFixed(3), +h.g.toFixed(3), +h.b.toFixed(3)],
      fog:[+scene.fog.color.r.toFixed(3), +scene.fog.color.g.toFixed(3), +scene.fog.color.b.toFixed(3)],
      fogNear:scene.fog.near, fogFar:scene.fog.far, sunDir:_sunDir.toArray().map(v=>+v.toFixed(3)) });
  },
  // NOT setTier — that name is already the weapon-tier command.
  gfxTier(name){ if(name) setTier(name);
    return JSON.stringify({tier:getTier(), passes:rndr?rndr.passes():['(passthrough)'],
      pixelRatio:renderer.getPixelRatio(), size:renderer.getSize(new THREE.Vector2()).toArray()}); },
  // Shadow frustum readout — the fit is invisible in a screenshot until it's
  // wrong, so this is how you confirm it's tracking zoom instead of sitting at
  // the old fixed +/-1200.
  shadowBox:()=>JSON.stringify({
    halfWidth:+((sc.right-sc.left)/2).toFixed(1),
    centre:[+((sc.left+sc.right)/2).toFixed(1), +((sc.bottom+sc.top)/2).toFixed(1)],
    near:+sc.near.toFixed(1), far:+sc.far.toFixed(1),
    mapSize:sun.shadow.mapSize.x, normalBias:sun.shadow.normalBias,
    unitsPerTexel:+(((sc.right-sc.left)/sun.shadow.mapSize.x)).toFixed(2),
    enabled:renderer.shadowMap.enabled, zoom:+camZoom.toFixed(2),
    camDist:+(_sFitDbg.camDist||0).toFixed(0), centreZ:+(_sFitDbg.centreZ||0).toFixed(0),
  }),
  texProbe(){
    const stat=(cv)=>{ const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
      let s=0,s2=0,n=cv.width*cv.height,bMean=0;
      for(let i=0;i<n;i++){ const l=(d[i*4]*0.299+d[i*4+1]*0.587+d[i*4+2]*0.114); s+=l; s2+=l*l; bMean+=d[i*4+2]; }
      const m=s/n; return {size:cv.width+'x'+cv.height, meanLum:+m.toFixed(1),
        stdDev:+Math.sqrt(Math.max(0,s2/n-m*m)).toFixed(1), meanBlue:+(bMean/n).toFixed(1)}; };
    return {wall:stat(wallTex.canvas), cave:stat(caveTex.canvas), rock:stat(rockTex.canvas),
      wallRepeat:[wallTex.repeat.x,wallTex.repeat.y], WALL_H, CHAR_H};
  },
  sceneEnv:()=>scene.environment?{isTexture:!!scene.environment.isTexture, w:scene.environment.image?.width, h:scene.environment.image?.height, mapping:scene.environment.mapping}:null,
  // Which materials are actually in the scene, by type. The graphics pass moved
  // several surfaces off Lambert (which ignores the env map entirely) onto
  // Standard, and "did that one actually take?" is otherwise unanswerable from
  // the console. Also flags transparent/additive meshes, which is the set that
  // has to be excluded from any depth/normal prepass.
  // Aggregated, never a per-mesh list — the scene holds thousands of pooled
  // meshes and dumping one entry each is unreadable. Lambert survivors are
  // bucketed by "who owns them" (parent name + geometry) so the answer is
  // actionable: it tells you which pool to convert, not that 2000 anonymous
  // Meshes exist.
  matAudit(){
    const byType={}, lambertBuckets={}, addBuckets={};
    let transparent=0, additive=0, visibleMeshes=0;
    const bucket=(o,m)=>((o.parent&&o.parent.name)||o.parent?.type||'-')+' / '+
                        (o.geometry?.type||'?')+(m.map?' +map':'');
    scene.traverse(o=>{
      if(!o.isMesh && !o.isPoints && !o.isSprite) return;
      if(o.visible) visibleMeshes++;
      for(const m of (Array.isArray(o.material)?o.material:[o.material])){
        if(!m) continue;
        byType[m.type]=(byType[m.type]||0)+1;
        if(m.type==='MeshLambertMaterial'){ const k=bucket(o,m); lambertBuckets[k]=(lambertBuckets[k]||0)+1; }
        if(m.transparent) transparent++;
        if(m.blending===THREE.AdditiveBlending){ additive++; const k=bucket(o,m); addBuckets[k]=(addBuckets[k]||0)+1; }
      }
    });
    const top=(o,n)=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,n);
    return JSON.stringify({byType, visibleMeshes, transparent, additive,
      lambertTop:top(lambertBuckets,10), additiveTop:top(addBuckets,10),
      envIntensity:_envApplied, envPresent:!!scene.environment});
  },
  // Live visual tuning: _dev.gfx({exposure:1.4, metalness:0.5, roughness:0.7})
  gfx(o){
    o=o||{};
    if(o.exposure!==undefined) renderer.toneMappingExposure=o.exposure;
    if(o.toneMapping==='none') renderer.toneMapping=THREE.NoToneMapping;
    if(o.toneMapping==='aces') renderer.toneMapping=THREE.ACESFilmicToneMapping;
    if(o.env!==undefined){ _envApplied=-1; applyEnvIntensity(o.env); }
    let touched=0;
    for(const k of ['metalness','roughness','normalScale']) if(o[k]!==undefined) PROP_PBR[k]=o[k];
    if(o.metalness!==undefined||o.roughness!==undefined||o.normalScale!==undefined){
      for(const m of _propMats){
        if(o.metalness!==undefined) m.metalness=PROP_PBR.metalness;
        if(o.roughness!==undefined&&!m.roughnessMap) m.roughness=PROP_PBR.roughness;
        if(o.normalScale!==undefined&&m.normalMap&&m.normalScale) m.normalScale.set(PROP_PBR.normalScale,PROP_PBR.normalScale);
        m.needsUpdate=true; touched++;
      }
    }
    return JSON.stringify({exposure:renderer.toneMappingExposure, envIntensity:_envApplied,
      pbr:PROP_PBR, propMaterials:_propMats.size, updated:touched});
  },
  // Placeable registry: _dev.placeables() lists every row and what's on the map.
  // _dev.placeScale('torch', 2) resizes one item live (mesh, height and flame all
  // ride the same number) so a prop can be judged on screen before committing it.
  placeables(){
    const rows=Object.entries(PLACEABLES).map(([k,d])=>({type:k, label:d.label, scale:d.scale,
      y:d.y, light:!!d.light, invKey:d.invKey, surfaces:d.surfaces, inPack:inv[d.invKey]||0,
      onMap:placedObjects.filter(o=>o.type===k).length}));
    return JSON.stringify({rows, totalPlaced:placedObjects.length,
      unknownTypesOnMap:[...new Set(placedObjects.filter(o=>!PLACEABLES[o.type]).map(o=>o.type))]});
  },
  // Place / pick up without a mouse, through the SAME functions the right-click
  // handler and build mode call — so a green test here means the real path works.
  craft(id){ const before=JSON.stringify(inv); doCraft(id);
    return JSON.stringify({id, buildMode:G.buildMode, buildItem:G.buildItem,
      gained:Object.keys(inv).filter(k=>inv[k]!==JSON.parse(before)[k])
        .map(k=>k+': '+(JSON.parse(before)[k]||0)+'→'+inv[k])}); },
  hold(type){
    const def=PLACEABLES[type]; if(!def) return 'no such placeable: '+type;
    player.weapon=def.invKey; refreshHeldProp(true);
    return JSON.stringify({holding:player.weapon, have:inv[def.invKey]||0, heldPlaceable:heldPlaceable()});
  },
  placeAt(type, dtx=0, dty=1){
    if(!PLACEABLES[type]) return 'no such placeable: '+type;
    const tx=Math.floor(player.x/TILE)+dtx, ty=Math.floor(player.y/TILE)+dty;
    const why=placementBlocker(type,tx,ty);
    const ok=placePlaceable(type,tx,ty,true);
    return JSON.stringify({type, tile:[tx,ty], blocker:why, placed:ok,
      have:inv[PLACEABLES[type].invKey]||0, onMap:placedObjects.length});
  },
  // Boss fights: _dev.boss('gravebinder') spawns one beside you, _dev.cast()
  // reports the live telegraph, _dev.bossHp(0.2) drives it into enrage.
  boss(which='gravebinder', dtx=4, dty=0){
    const def=FLOOR_BOSSES[which];
    if(!def) return 'no such boss — try '+Object.keys(FLOOR_BOSSES).join('/');
    for(let i=enemies.length-1;i>=0;i--) if(enemies[i].floorBoss) enemies.splice(i,1);
    const tx=Math.floor(player.x/TILE)+dtx, ty=Math.floor(player.y/TILE)+dty;
    const e=makeEnemy(def.base, tx, ty); if(!e) return 'could not spawn at '+tx+','+ty;
    e.maxHp=Math.round(e.maxHp*def.hp); e.hp=e.maxHp;
    e.damage=Math.round(e.damage*def.dmg);
    e.floorBoss=which; e.bossName=def.name; e.isChampBoss=true; e.state='aggro';
    e._openDelay=0;                                    // skip the polite opening pause
    enemies.push(e);
    return JSON.stringify({spawned:def.name, hp:e.hp, dmg:e.damage,
      abilities:(BOSS_ABILITIES[which]||[]).map(a=>a.id)});
  },
  cast(){
    const b=enemies.find(e=>e.floorBoss);
    if(!b) return 'no boss alive';
    const c=b.cast;
    return JSON.stringify({boss:b.bossName, hpPct:+(b.hp/b.maxHp).toFixed(2),
      casting: c ? { name:c.name, shape:c.shape, dur:c.dur,
        progress:+(c.t/c.dur).toFixed(2),
        zone: c.shape==='circle'
          ? {x:Math.round(c.follow?b.x:c.x), y:Math.round(c.follow?b.y:c.y), r:Math.round(c.r), follow:!!c.follow}
          : {x:Math.round(c.x), y:Math.round(c.y), len:c.len, w:c.w, angDeg:Math.round(c.ang*57.3)} } : null,
      cooldowns:b._cd||{}});
  },
  // Force one ability and hold its telegraph up, so a specific zone can be read
  // (or screenshotted) without waiting on the random picker.
  forceCast(id, hold){
    const b=enemies.find(e=>e.floorBoss); if(!b) return 'no boss alive';
    b.cast=null; b._openDelay=0;
    if(!bossForceCast(b,id)) return 'no such ability — '+(BOSS_ABILITIES[b.floorBoss]||[]).map(a=>a.id).join('/');
    if(hold){ b.cast.dur=600; b.cast.t=300; }
    return _dev.cast();
  },
  // Resolve the held telegraph right now and report whether it connected.
  resolveCast(){
    const b=enemies.find(e=>e.floorBoss); if(!b||!b.cast) return 'no cast up';
    const hpBefore=player.hp, name=b.cast.name;
    bossResolveNow(b);
    return JSON.stringify({ability:name, playerHpBefore:hpBefore, playerHpAfter:player.hp,
      damageTaken:hpBefore-player.hp, stunned:+player.stunTimer.toFixed(1),
      webbed:+(player.webTimer||0).toFixed(1), poisoned:+(player.poisonTimer||0).toFixed(1)});
  },
  // Which abilities can the picker actually choose at a given HP fraction?
  // Proves the phase gates without re-implementing them in the test.
  bossPicks(frac=1, n=400){
    const b=enemies.find(e=>e.floorBoss); if(!b) return 'no boss alive';
    const hp=b.hp, cast=b.cast, cds=b._cd;
    b.hp=Math.round(b.maxHp*frac); b.cast=null;
    const seen={};
    for(let i=0;i<n;i++){ b._cd={}; const id=bossPickForTest(b); if(id) seen[id]=(seen[id]||0)+1; }
    b.hp=hp; b.cast=cast; b._cd=cds;
    return JSON.stringify({atHpPct:frac, enraged:frac<0.25, picked:seen});
  },
  bossHp(frac){ const b=enemies.find(e=>e.floorBoss); if(!b) return 'no boss alive';
    b.hp=Math.max(1,Math.round(b.maxHp*frac));
    return JSON.stringify({hpPct:+(b.hp/b.maxHp).toFixed(2), enraged:b.hp/b.maxHp<0.25}); },
  // Burnout state for everything on the map. _dev.burn(i, sec) back-dates one
  // object's litAt so it expires `sec` from now (negative = already overdue),
  // which beats waiting out a 24-minute day to test it.
  burns(){
    return JSON.stringify(placedObjects.map((o,i)=>{
      const def=PLACEABLES[o.type], r=burnRemaining(o);
      return {i, type:o.type, burns:!!(def&&def.burn), onSpent:def&&def.burn?def.burn.spent:null,
        spent:!!o.spent, lit:isLit(o), remainingSec: r===Infinity?'never':Math.round(r)};
    }));
  },
  burn(i, sec=-1){
    const o=placedObjects[i]; if(!o) return 'nothing at index '+i;
    const def=PLACEABLES[o.type];
    if(!def||!def.burn) return o.type+' never burns out';
    o.litAt = worldNow() - (def.burn.fuelSec - sec);
    return JSON.stringify({type:o.type, remainingSec:Math.round(burnRemaining(o))});
  },
  sweep(){ _burnClock=0; sweepBurnouts(0); return _dev.burns(); },
  relight(i=0){ const o=placedObjects[i]; if(!o) return 'nothing at index '+i;
    const wood=inv.wood||0, handled=relightPlaced(o);
    return JSON.stringify({type:o.type, handled, woodBefore:wood, woodAfter:inv.wood||0,
      spent:!!o.spent, lit:isLit(o), remainingSec:Math.round(burnRemaining(o))}); },
  // Aim at a placed object's own screen position and see what the picker returns.
  // Also reports what the old ground-plane test would have found, which is how
  // you can see a wall mount being unreachable the old way.
  pickTest(i=0){
    const o=placedObjects[i]; if(!o) return 'nothing at index '+i;
    const def=PLACEABLES[o.type];
    const h=o.face?o.mountY:(def?def.y*def.scale:10);
    const s=worldToScreen(o.x,o.y,h);
    const got=pickPlacedObject(s.x,s.y);
    const ground=screenToWorld(s.x,s.y);
    const oldHit=placedObjects.find(q=>Math.hypot(q.x-ground.x,q.y-ground.y)<TILE*1.1);
    return JSON.stringify({type:o.type, face:o.face||null, mountY:o.mountY?Math.round(o.mountY):0,
      screen:[Math.round(s.x),Math.round(s.y)],
      screenPickHit: got===o, groundRayLandsAt:[Math.round(ground.x),Math.round(ground.y)],
      groundRayOffBy: Math.round(Math.hypot(ground.x-o.x, ground.y-o.y)),
      oldMethodWouldFind: oldHit? oldHit.type : null});
  },
  // Where would a torch mount on the wall at this tile offset, and how does that
  // compare to the old flat TILE/2-3 assumption that buried it?
  wallMount(dtx=0, dty=1){
    const tx=Math.floor(player.x/TILE)+dtx, ty=Math.floor(player.y/TILE)+dty;
    const t=map[ty]&&map[ty][tx];
    if(!_isFullCover(t)) return JSON.stringify({tile:[tx,ty], tileType:t, isWall:false});
    const out={};
    for(const f of ['n','s','e','w']){
      const [ox,oy]=FACE_DIR[f];
      const s=wallSurfaceOffset(tx,ty, ox!==0?'x':'z');
      out[f]={surfaceExt:+s.ext.toFixed(1), jitter:+s.jit.toFixed(1),
              mountDist:+(s.ext+WALL_GAP).toFixed(1)};
    }
    return JSON.stringify({tile:[tx,ty], tileType:t, halfTile:TILE/2, oldFlatOffset:TILE/2-3, faces:out});
  },
  // Aim at a point on the wall's FACE (up in the air) and check the raycast finds
  // that tile — and report what the old ground-plane click would have resolved to.
  wallPickTest(dtx=0, dty=-1, face='s'){
    const tx=Math.floor(player.x/TILE)+dtx, ty=Math.floor(player.y/TILE)+dty;
    if(!_isFullCover(map[ty]&&map[ty][tx])) return 'tile '+tx+','+ty+' is not a wall';
    const [ox,oy]=FACE_DIR[face], s=wallSurfaceOffset(tx,ty, ox!==0?'x':'z');
    const px=tx*TILE+TILE/2 + (ox!==0? s.jit+ox*s.ext : 0);
    const pz=ty*TILE+TILE/2 + (oy!==0? s.jit+oy*s.ext : 0);
    const scr=worldToScreen(px,pz,WALL_H*0.62);       // a point ON the face
    const hit=pickWallTile(scr.x,scr.y);
    const ground=screenToWorld(scr.x,scr.y);
    const gt=[Math.floor(ground.x/TILE),Math.floor(ground.y/TILE)];
    return JSON.stringify({wallTile:[tx,ty], aimedAtScreen:[Math.round(scr.x),Math.round(scr.y)],
      raycastFound: hit?[hit.tx,hit.ty]:null, raycastCorrect: !!hit&&hit.tx===tx&&hit.ty===ty,
      oldGroundClickWouldHit: gt, oldWasCorrect: gt[0]===tx&&gt[1]===ty});
  },
  placeBlocker(type, dtx=0, dty=1){
    const tx=Math.floor(player.x/TILE)+dtx, ty=Math.floor(player.y/TILE)+dty;
    return JSON.stringify({tile:[tx,ty], tileType:map[ty]?.[tx], blocker:placementBlocker(type,tx,ty)});
  },
  removePlaced(i=0, returnItem=true){
    const o=placedObjects[i]; if(!o) return 'nothing at index '+i;
    const def=PLACEABLES[o.type], key=def&&def.invKey;
    const before=key?(inv[key]||0):null;
    removePlacedObject(o, returnItem);
    return JSON.stringify({removed:o.type, invKey:key, before, after:key?(inv[key]||0):null});
  },
  placeScale(type, s){
    const d=PLACEABLES[type]; if(!d) return 'no such placeable: '+type;
    if(s!==undefined){ d.scale=s; placedObjectsDirty=true; }
    return JSON.stringify({type, scale:d.scale, meshCentreY:d.y*d.scale, charH:CHAR_H});
  },
  // Terrain de-blockifying. _dev.warp({ampC:0.8, ampF:0.4, cellC:12, cellF:3, hash:0.1})
  // re-bakes the ground + water mask in place so the look can be dialled in live.
  // Bigger amplitudes wander further but will start to break up 1-tile features
  // (thin paths especially) — watch a narrow path while raising them.
  warp(o){
    o=o||{};
    if(o.ampC!==undefined) WARP_AMP_C=o.ampC;
    if(o.ampF!==undefined) WARP_AMP_F=o.ampF;
    if(o.cellC!==undefined) WARP_CELL_C=o.cellC;
    if(o.cellF!==undefined) WARP_CELL_F=o.cellF;
    if(o.hash!==undefined) WARP_HASH=o.hash;
    const t0=performance.now();
    _buildWarpGrids();
    buildGroundUnder();
    buildTerrainImage();       terrTex.needsUpdate=true;
    buildWaterField();
    paintWaterMask(0,0,MAP_W-1,MAP_H-1); wMaskTex.needsUpdate=true;
    return JSON.stringify({ampC:WARP_AMP_C, ampF:WARP_AMP_F, cellC:WARP_CELL_C,
      cellF:WARP_CELL_F, hash:WARP_HASH, reachTiles:WARP_R, rebakeMs:+(performance.now()-t0).toFixed(0)});
  },
  // Regenerate a synthesised gait with new parameters and rebuild every model
  // instance using it, without a reload. The clips are procedural, so the tuning
  // loop that an authored animation gets in Blender has to live here instead.
  //   _dev.spiderGait()                    report the current tuning
  //   _dev.spiderGait({stride:0.55})       change it and re-bake the clips
  //   _dev.spiderGait(null)                back to defaults
  spiderGait(tune){
    if(tune !== undefined){
      if(tune === null) for(const k of Object.keys(_gaitTune)) delete _gaitTune[k];
      else Object.assign(_gaitTune, tune);
      for(const [file, gen] of Object.entries(SYNTH_CLIPS)){
        const asset = loadedModels[file]; if(!asset) continue;
        asset.clips = gen(THREE, asset.template, _gaitTune) || [];
      }
      // Slot models cached an AnimationMixer bound to the old clips, so they
      // have to be dropped or the change is invisible until a mob changes type.
      for(let i=0;i<slotModel.length;i++){
        const inst = slotModel[i]; if(!inst) continue;
        if(!SYNTH_CLIPS[(MOB_MODELS[inst.type]||{}).file]) continue;
        scene.remove(inst.obj); inst.mixer.stopAllAction(); slotModel[i]=null;
      }
    }
    const out = {};
    for(const file of Object.keys(SYNTH_CLIPS)){
      const asset = loadedModels[file];
      out[file] = asset ? asset.clips.map(c=>c.name+' '+c.duration.toFixed(2)+'s') : 'not loaded';
    }
    return JSON.stringify({ tune:_gaitTune, generated:out });
  },
  // Mob turning. _dev.turn({k:9, max:4.5}) tunes the convergence rate and the
  // angular-velocity ceiling live; _dev.turn() just reports.
  //   _dev.turn()                          report every class
  //   _dev.turn({mob:{k:9, max:4.5}})       retune one
  turn(v){
    if(v) for(const cls of Object.keys(v)){
      if(!TURN_RATES[cls]) continue;
      if(v[cls].k != null) TURN_RATES[cls].k = v[cls].k;
      if(v[cls].max != null) TURN_RATES[cls].max = v[cls].max;
    }
    const out = {};
    for(const [cls, r] of Object.entries(TURN_RATES))
      out[cls] = { k:r.k, maxRadPerSec:r.max, maxDegPerSec:+(r.max*180/Math.PI).toFixed(0) };
    return JSON.stringify({ rates:out, moveOn:MOVE_ON, moveOff:MOVE_OFF });
  },
  // Walk-clip rate matching: _dev.gait(110) raises the speed that plays at 1.0x
  // (slower legs); _dev.gait() just reports. Live per-mob readout for eyeballing it.
  gait(ref){
    if(ref!==undefined) GAIT_REF=ref;
    const near=enemies.filter(e=>e._spd!=null&&Math.hypot(e.x-player.x,e.y-player.y)<TILE*14)
      .map(e=>({type:e.type, maxSpeed:e.speed, actual:+e._spd.toFixed(1),
                timeScale:+Math.max(0.35,Math.min(2.2,e._spd/GAIT_REF)).toFixed(2)}));
    return JSON.stringify({GAIT_REF, nearby:near.slice(0,8)});
  },
  get horse(){return horse;},
  setRideH(v){ if(horse){horse.rideH=v; return 'rideH='+v;} return 'no horse'; },
  worldChests:()=>WORLD_CHESTS,
  peekChest:(c)=>JSON.parse(JSON.stringify(rollChestLoot(c))),
  takeChest:()=>takeAllChest(),
  equipStats:()=>getEquipmentStats(player),
  meleeDmg:()=>meleeDmg(),
  arrowDmg:()=>arrowDmg(),
  armorDR:()=>armorDR(),
  setSkillXp(key, xp){ if(skills[key]) { skills[key].xp = xp; return key+' xp set to '+xp; } },
  setTier(sword, bow, pick){ player.swordTier=sword; player.bowTier=bow; player.pickaxeTier=pick; refreshHeldProp(true); return 'tiers updated'; },
  equipFullArmor(mat){ equipArmorPiece(mat); equipArmorPiece(mat); equipArmorPiece(mat); equipArmorPiece(mat); return 'equipped armor mat '+mat; },
  equipBagItem(i){ const it=player.equipmentItems[i]; if(!it)return 'no item';
    const prev=player.equippedItems[it.slot]; player.equipmentItems.splice(i,1);
    if(prev)player.equipmentItems.push(prev); player.equippedItems[it.slot]=it;
    refreshEquipStats(); return 'equipped '+it.name; },
  socketFirst(slot,gem){ const it=player.equippedItems[slot]; if(!it)return 'nothing equipped';
    const idx=it.sockets.findIndex(s=>!s.gem); if(idx<0)return 'no open socket';
    const ok=socketGem(it,idx,gem); refreshEquipStats(); return ok?('socketed '+gem):'socket failed'; },
  markPlacedDirty(){placedObjectsDirty=true;}};
// Console hook for quick placement tuning without the panel, e.g.
//   _tune('iron_helm', {pos:[0,6,1], rot:[0,0,0], scale:16})
window._tune=(key,patch)=>{ const adj=adjustFor(key); if(!adj)return 'unknown key';
  Object.assign(adj, patch);
  if(ARMOR_PIECES[key]) showArmorPiece(key, 0);
  const prev=activeTuningTarget; activeTuningTarget=key; applyActiveTuning(); activeTuningTarget=prev;
  return JSON.stringify(adj); };
function updateSlidersFromConfig(){
  const adj=adjustFor(activeTuningTarget); if(!adj)return;
  const mappings=[
    {key:'px',val:adj.pos[0]},{key:'py',val:adj.pos[1]},{key:'pz',val:adj.pos[2]},
    {key:'rx',val:adj.rot[0]},{key:'ry',val:adj.rot[1]},{key:'rz',val:adj.rot[2]},{key:'sc',val:adj.scale}
  ];
  mappings.forEach(m=>{
    const s=document.getElementById(`tune_${m.key}`),t=document.getElementById(`val_${m.key}`);
    if(s&&t){s.value=m.val;t.innerText=m.val.toFixed(2);}
  });
}
window.addEventListener('keydown',e=>{
  if(e.code==='KeyP'){
    if(!tunerPanel)initTuner();
    else tunerPanel.style.display=tunerPanel.style.display==='none'?'block':'none';
  }
});


// One model instance per enemy pool slot (built lazily, rebuilt on type change)
const slotModel = [];
function buildSlotModel(i, type){
  const old = slotModel[i];
  if (old) { scene.remove(old.obj); old.mixer.stopAllAction(); }
  const mm = MOB_MODELS[type], asset = loadedModels[mm.file];
  const inner = SkeletonUtils.clone(asset.template);
  const s = mm.h * OBJ_SCALE / asset.natH;
  inner.scale.setScalar(s);
  inner.position.y = asset.yOff * s;
  inner.rotation.y = Math.PI;             // Quaternius models face +Z; game forward is -Z
  if (mm.tint) inner.traverse(o=>{ if(o.isMesh){ o.material=o.material.clone(); o.material.color.multiply(new THREE.Color(mm.tint)); } });
  // Skinned vertices move far from the static bounding sphere — never cull
  inner.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.frustumCulled=false; } });
  const obj = new THREE.Group(); obj.add(inner); scene.add(obj);
  const mixer = new THREE.AnimationMixer(inner);
  const mk = c => c ? mixer.clipAction(c) : null;
  const actions = {
    idle:   mk(pickClip(asset.clips, /(^|\|)idle$/i) || pickClip(asset.clips, /(^|\|)idle(_2)?$/i) || pickClip(asset.clips, /idle/i)),
    walk:   mk(pickClip(asset.clips, /gallop|run/i) || pickClip(asset.clips, /walk/i)),
    attack: mk(pickClip(asset.clips, /attack|punch|bite/i)),
  };
  if (actions.attack) { actions.attack.setLoop(THREE.LoopOnce); actions.attack.clampWhenFinished=false; }
  // A new Group starts at yaw 0, which is not where the mob is facing. That was
  // invisible while turning snapped in ~25ms; with an angular-velocity ceiling it
  // becomes a visible spin every time a mob spawns, respawns or is re-slotted.
  // `fresh` makes the first frame snap instead of turn.
  const inst = { type, obj, mixer, actions, cur:null, atkUntil:0, lx:null, lz:null, fresh:true };
  slotModel[i]=inst; return inst;
}
function setModelAnim(inst, name){
  if (inst.cur===name || !inst.actions[name]) return;
  if (inst.cur && inst.actions[inst.cur]) inst.actions[inst.cur].fadeOut(0.18);
  inst.actions[name].reset().fadeIn(0.18).play();
  inst.cur=name;
}
// Ground speed (world units/sec) at which a walk/gallop clip plays at 1.0x and the
// feet look planted. Raise it if legs still outrun the ground. _dev.gait() tunes live.
let GAIT_REF = 80;
// Turning lives in turnToward() / TURN_RATES, declared above animateRig so every
// yaw in the game — mobs, the player, NPCs and remote players — shares one
// implementation instead of five copies that drifted apart.
// Drive one model instance from its enemy: position, smooth turn, clips.
// animate=false (distant mob) keeps it placed but freezes the skinning mixer.
function animModel(inst, e, t, adt, animate){
  inst.obj.visible=true;
  inst.obj.position.set(e.x,heightAt(e.x,e.y),e.y);
  const dx = e.x - (e._lx ?? e.x), dz = e.y - (e._lz ?? e.y);
  e._lx = e.x; e._lz = e.y;
  const dist = Math.hypot(dx,dz);
  // Actual ground speed (world units/sec), smoothed. The walk clip is rate-matched
  // to this so the feet keep up with the ground — scaling off e.speed alone (a
  // constant max) made a wandering mob sprint its legs while barely moving.
  // Skip the frame after a cull/teleport (dist >= TILE*3) so it can't read as a sprint.
  //
  // The VELOCITY is smoothed the same way and for a stronger reason: a heading
  // taken from one frame's delta is a heading taken from pathing noise. At 144Hz
  // a wandering mob moves ~0.35 units a frame, so atan2 of that delta swings
  // wildly while the mob is plainly walking in a straight line.
  if(adt > 0 && dist < TILE * 3){
    const spdNow = dist / adt;
    e._spd = e._spd == null ? spdNow : e._spd + (spdNow - e._spd) * 0.25;
    const vxNow = dx / adt, vzNow = dz / adt;
    e._vx = e._vx == null ? vxNow : e._vx + (vxNow - e._vx) * 0.25;
    e._vz = e._vz == null ? vzNow : e._vz + (vzNow - e._vz) * 0.25;
  }
  // Latched, not thresholded. Measured per-frame movement for a wanderer is
  // median 0.35 / p90 0.69 against the old 0.6 gate, so it sat exactly where it
  // would chatter — 69% of frames on one side, 31% on the other, flipping the
  // heading 3.2 times a second. Two thresholds with a gap cannot do that.
  const _spd = e._spd ?? 0;
  if(e._mv) { if(_spd < MOVE_OFF) e._mv = false; }
  else      { if(_spd > MOVE_ON)  e._mv = true;  }
  const moving = !!e._mv && dist < TILE * 3;

  let tgt = null;
  if(moving && (e._vx * e._vx + e._vz * e._vz) > 1) tgt = Math.atan2(-e._vx, -e._vz);
  else { const fx = player.x - e.x, fz = player.y - e.y;
    if(Math.hypot(fx,fz) < TILE * 7) tgt = Math.atan2(-fx,-fz); }
  if(tgt !== null && inst.fresh){ inst.obj.rotation.y = tgt; inst.fresh = false; }
  else if(tgt !== null) turnToward(inst.obj, tgt, adt, 'mob');
  if(!animate) return;                 // animation-LOD: skip clips + skinning when far
  const isAttacking = e.attackTimer > (e.attackCooldown - 0.5);
  if(isAttacking && t > (e._atkUntil || 0) && inst.actions.attack){
    const clipDur = inst.actions.attack.getClip().duration;
    e._atkUntil = t + Math.min(clipDur, 1.2);
    inst.actions.attack.reset().fadeIn(0.06).play();
    if(inst.cur && inst.cur !== 'attack' && inst.actions[inst.cur]) inst.actions[inst.cur].fadeOut(0.06);
    inst.cur = 'attack';
  }
  if(t >= (e._atkUntil || 0)){
    if(inst.actions.walk) inst.actions.walk.timeScale =
      Math.max(0.35, Math.min(2.2, (e._spd ?? e.speed ?? 90) / GAIT_REF));
    setModelAnim(inst, moving ? 'walk' : 'idle');
  }
  inst.mixer.update(adt);
}

const POOL = 300;
const ePool = Array.from({length:POOL}, () => {
  const g = makeRig(); g.visible = false; scene.add(g); return g;
});
const enemyPool = ePool;  // alias used in syncEntities

// Player — humanoid rig; weapon prop updated per frame to match player.weapon
const PLR = [0x7d4a2e, 18,34,11, 7];
const plrGrp = makeRig();
configureRig(plrGrp, PLR[0], PLR[1],PLR[2],PLR[3],PLR[4], 0, true);
scene.add(plrGrp);

// Guards pool — humanoid rigs with sword, configured once.
//
// Twenty guards used to be twenty byte-identical figures, which is most obvious
// exactly where guards stand: several of them together, at a gate. They now
// vary, but within a hard budget.
//
// THE BUDGET IS THE INTERESTING PART. dressGeo() caches the merged dressing by
// style AND body size, so continuous per-guard jitter would mint twenty
// separate helmet+tabard+cloak buffers — the cache exists precisely to stop
// that. So size varies across exactly THREE discrete builds (three cache
// entries, shared by roughly seven guards each) while SKIN varies freely per
// guard, because skin is a material colour and costs nothing at all. Three
// heights and five faces read as twenty different men; twenty of each would
// look no better and cost twenty buffers.
const GPOOL = 20;
const GUARD_BUILDS = [
  { bw:16, bh:45, bd:10, hr:4.3 },   // short and stocky
  { bw:17, bh:48, bd:11, hr:4.2 },   // the middle, and the old figure
  { bw:18, bh:52, bd:11, hr:4.1 },   // tall, smaller head — reads as the big one
];
const GUARD_SKINS = [0xc39a6b, 0xd8b48c, 0xb07a4e, 0x8d5f3c, 0xe3c4a0];
const gPool = Array.from({length:GPOOL}, (_, i) => {
  const g = makeRig();
  const b = GUARD_BUILDS[i % GUARD_BUILDS.length];
  configureRig(g, 0x4a5870, b.bw, b.bh, b.bd, b.hr, 0, GUARD_SKINS[i % GUARD_SKINS.length]);
  dressRig(g, 'guard');            // helm, coif, plume, gorget, pauldrons, tabard, belt, cloak
  applyProp(g, 'sword', b.bw, b.bh, b.bd);
  g.visible=false; scene.add(g); return g;
});
const guardPool = gPool;  // alias used in syncEntities

// NPC builder — humanoid rig with optional tool/weapon
const npcs = [];
function spawnNPC(color, x, y, prop, style) {
  const g = makeRig();
  // The build comes from the style, so a smith is actually built like a smith.
  // configureRig and applyProp MUST be handed the same numbers: applyProp
  // derives the hand position from bw/bh/bd itself, so feeding it the old
  // 15/48/10 while the body is 19/50/13 leaves the hammer floating beside the
  // arm rather than in the hand.
  const b = rigBuild(style);
  const st = RIG_STYLES[style];
  const skin = (st && typeof st.skin === 'number') ? st.skin : true;
  configureRig(g, color, b.bw, b.bh, b.bd, b.hr, 0, skin);
  if (style) dressRig(g, style);
  if (prop) applyProp(g, prop, b.bw, b.bh, b.bd);
  g.position.set(x,heightAt(x,y),y); scene.add(g); npcs.push(g); return g;
}
// Every one of these is a STAND-IN now — each has a GLB in NPC_MODELS below
// that hides it once the file has loaded. They still exist because loading is
// async and a town with nobody in it for two seconds is worse than a town with
// blocks in it, and because SKINNING_OK is false on hardware that cannot skin,
// where the stand-in is all there is.
const _merchantRig = spawnNPC(0x8a4030, MERCHANT.x,   MERCHANT.y,   null,     'merchant');
const _bankerRig   = spawnNPC(0xd0a020, BANKER.x,     BANKER.y,     null,     'banker');
const _healerRig   = spawnNPC(0x40a060, HEALER.x,     HEALER.y,     'staff',  'healer');
const _smithRig    = spawnNPC(0x703020, BLACKSMITH.x, BLACKSMITH.y, 'hammer', 'smith');
const _mageRig     = spawnNPC(0x4040a0, MAGE.x,       MAGE.y,       'staff',  'mage');
const _farrierRig  = spawnNPC(0x907040, FARRIER.x,    FARRIER.y,    'hammer', 'farrier');
const _worldHealerRigs = WORLD_HEALERS.map(wh => spawnNPC(0x40a060, wh.x, wh.y, 'staff', 'healer'));
const _antiqRig    = spawnNPC(0x6a4a9a, ANTIQUARIAN.x,  ANTIQUARIAN.y,  'staff',  'scholar');
const _cryptRig    = spawnNPC(0x2a5a7a, CRYPTOLOGIST.x, CRYPTOLOGIST.y, 'dagger', 'cipher');
const _curatorRig  = spawnNPC(0xb08030, CURATOR.x,      CURATOR.y,      null,     'curator');
const _robberRig   = spawnNPC(0x3a3a3a, GRAVE_ROBBER.x, GRAVE_ROBBER.y, 'dagger', 'robber');

// Decorative fletcher (bowyer) between the merchant and the smith — model
// plus an [E] label, no shop yet.
const FLETCHER = { x:313*48+24, y:354*48+24, r:13 };
// ...and his stand-in. He had none: NPC_MODELS listed `fallback:null`, so on
// hardware where SKINNING_OK is false — which is the whole reason stand-ins
// exist — his corner of the market was simply empty, and for the first second
// or two of every load on every device it was empty for everyone.
const _fletcherRig = spawnNPC(0x4a5c34, FLETCHER.x, FLETCHER.y, 'bow', 'fletcher');

// ── GLB town NPCs (banker, smith, fletcher) ───────────────────────
// Static skinned character models — no animation, facing south (toward
// the camera). Loaded async; each hides its procedural stand-in once
// ready. h = target world height (hero is 126u); face = model Y-rotation.
const glbNpcs = [];
// Inner Y-correction: these models face +Z natively (like the hero), so π
// flips them to the -Z standard the facing math assumes. Flip to 0 if an NPC
// ever renders backwards. Rest facing is south (obj.rotation.y = π).
const NPC_YAW = Math.PI;
// The jester busks in the courtyard just west of the bank's south doors,
// cycling dance clips while he waits for an audience.
const JESTER = { x:306*48+24, y:367*48+24, r:13 };
// ONLY roles that have a model OF THEIR OWN. Dressing a merchant in the
// banker's model was borrowing, not modelling: it put the same three faces on
// eleven people and it meant the procedural figures never had to be good.
// Everyone not listed here is built by render/humanoid.js and has to earn it.
const NPC_MODELS = {
  banker:   {file:'models/Banker.glb',   pos:BANKER,     h:116, idle:'Agree_Gesture', fallback:_bankerRig},
  smith:    {file:'models/Smithy.glb',   pos:BLACKSMITH, h:118, idle:'Alert',          fallback:_smithRig},
  fletcher: {file:'models/Fletcher.glb', pos:FLETCHER,   h:114, idle:'Agree_Gesture', fallback:_fletcherRig},
  mage:     {file:'models/Wizzard.glb',  pos:MAGE,       h:118, idle:'Idle_9',        fallback:_mageRig},
  jester:   {file:'models/Jester.glb',   pos:JESTER,     h:112, idle:'Step_Hip_Hop_Dance', fallback:null,
             idles:['Breakdance_1990','Hip_Hop_Dance_3','Step_Hip_Hop_Dance','Backflip_and_Rise']},
};
function setNpcAnim(n,name){
  if(n.cur===name||!n.actions[name])return;
  if(n.cur&&n.actions[n.cur])n.actions[n.cur].fadeOut(0.25);
  n.actions[name].reset().fadeIn(0.25).play(); n.cur=name;
}
function npcWalkable(x,y){
  const tx=Math.floor(x/TILE), ty=Math.floor(y/TILE);
  if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return false;
  const tt=map[ty][tx];
  return tt===T.GRASS||tt===T.PATH||tt===T.BRIDGE||tt===T.CAVE_FLOOR||
         tt===T.SAND||tt===T.DOCK||tt===T.SHALLOWS;
}
// Measure the true rendered height of a skinned model. A Box3 is wrong here:
// it measures the BIND pose, and these characters are posed by their skeleton,
// so the box can be a head taller than what actually draws.
function measureSkinned(inner){
  inner.updateMatrixWorld(true);
  let minY=1e9,maxY=-1e9; const v=new THREE.Vector3();
  inner.traverse(o=>{ if(!o.isSkinnedMesh)return;
    const p=o.geometry.attributes.position, step=Math.max(1,Math.floor(p.count/400));
    for(let i=0;i<p.count;i+=step){ v.fromBufferAttribute(p,i); o.applyBoneTransform(i,v); o.localToWorld(v);
      if(v.y<minY)minY=v.y; if(v.y>maxY)maxY=v.y; } });
  if(!(maxY-minY>0.05)){ const b=new THREE.Box3().setFromObject(inner); minY=b.min.y; maxY=b.max.y; }
  return { minY, natH: Math.max(0.01, maxY-minY) };
}
// SkeletonUtils.clone shares MATERIALS with the original, which is what makes
// it cheap and also what makes an untreated tint colour every NPC wearing the
// same file. Give this one its own copies before touching any colour.
function tintNpc(inner, hex){
  const c = new THREE.Color(hex);
  inner.traverse(o=>{
    if(!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const copies = mats.map(m=>{
      const n = m.clone();
      // 0.34, not a multiply. These textures carry the face and hands in the
      // same map as the cloth: multiplying by a dark colour makes a shadow
      // puppet, and lerping keeps the shading while moving the hue.
      if(n.color) n.color.lerp(c, 0.34);
      return n;
    });
    o.material = Array.isArray(o.material) ? copies : copies[0];
  });
}
function buildGlbNpc(key, cfg, inner, animations, measured){
  const sc = cfg.h / measured.natH;
  inner.scale.setScalar(sc); inner.position.y = -measured.minY*sc; inner.rotation.y = NPC_YAW;
  inner.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.frustumCulled=false; } });
  if(cfg.tint) tintNpc(inner, cfg.tint);
  const obj=new THREE.Group(); obj.add(inner);
  obj.position.set(cfg.pos.x,0,cfg.pos.y); obj.rotation.y=Math.PI;   // rest: face south
  scene.add(obj);
  const mixer=new THREE.AnimationMixer(inner);
  const find=nm=>animations.find(c=>c.name===nm);
  const mk=c=>c?mixer.clipAction(c):null;
  const actions={ idle:mk(find(cfg.idle))||mk(find('Walking')), walk:mk(find('Walking')) };
  // Optional idle variety pool (the jester's dances): each wander pause
  // picks a random clip from this list instead of the single idle.
  let idleNames=null;
  if(cfg.idles){ idleNames=[];
    for(const nm of cfg.idles){ const a=mk(find(nm)); if(a){ actions[nm]=a; idleNames.push(nm); } }
    if(!idleNames.length) idleNames=null; }
  // Stagger the start so a shared clip does not play in lockstep across every
  // NPC wearing the same model — ten wizards breathing in unison is worse than
  // ten wizards.
  if(actions.idle){ actions.idle.play(); actions.idle.time = Math.random()*actions.idle.getClip().duration; }
  glbNpcs.push({obj,mixer,actions,cur:actions.idle?'idle':null,idleNames,curIdle:null,
    hx:cfg.pos.x,hz:cfg.pos.y,tx:null,tz:null,pause:1+Math.random()*3});
  // RETIRE the stand-in, do not merely hide it. The rig-NPC loop sets
  // `n.visible = true` for everything within render distance on every frame, so
  // a hidden rig reappears next frame and stands inside the model that replaced
  // it. Taking it out of the scene and out of `npcs` is the only thing that
  // makes it stay gone — and it stops costing a draw call too.
  if(cfg.fallback){
    cfg.fallback.visible=false;
    scene.remove(cfg.fallback);
    const i=npcs.indexOf(cfg.fallback); if(i>=0) npcs.splice(i,1);
  }
}
if (SKINNING_OK) {
  // Grouped by FILE, not by NPC. Wizzard.glb dresses ten of these; ten separate
  // loads would fetch, parse and hold ten copies of the same skinned mesh.
  // Load each file once and clone per NPC — SkeletonUtils.clone shares the
  // geometry, so the tenth wizard costs a node tree and a skeleton, not a mesh.
  const byFile = new Map();
  for(const [key,cfg] of Object.entries(NPC_MODELS)){
    if(!byFile.has(cfg.file)) byFile.set(cfg.file, []);
    byFile.get(cfg.file).push([key,cfg]);
  }
  for(const [file, entries] of byFile){
    gltfLoader.load(file, gltf=>{
      // Measured once off the source. Every clone is the same mesh in the same
      // bind pose, so re-walking the vertices per NPC would buy nothing.
      const measured = measureSkinned(gltf.scene);
      for(const [key,cfg] of entries){
        try {
          // Cloned even for the first user, so there is one code path and the
          // loaded scene is never mutated by whoever happens to be first.
          buildGlbNpc(key, cfg, SkeletonUtils.clone(gltf.scene), gltf.animations, measured);
        } catch(err){ console.warn('NPC build failed:', key, err); }
      }
    }, undefined, err=>console.warn('NPC model load failed:',file,err));
  }
}

// ── Mount: horse rendered under the player while riding ───────────
let horse=null;
if (SKINNING_OK) gltfLoader.load('models/Horse.glb', gltf=>{
  const inner=gltf.scene; inner.updateMatrixWorld(true);
  let minY=1e9,maxY=-1e9; const v=new THREE.Vector3();
  inner.traverse(o=>{ if(!o.isSkinnedMesh)return;
    const p=o.geometry.attributes.position, step=Math.max(1,Math.floor(p.count/500));
    for(let i=0;i<p.count;i+=step){ v.fromBufferAttribute(p,i); o.applyBoneTransform(i,v); o.localToWorld(v);
      if(v.y<minY)minY=v.y; if(v.y>maxY)maxY=v.y; } });
  if(!(maxY-minY>0.05)){ const b=new THREE.Box3().setFromObject(inner); minY=b.min.y; maxY=b.max.y; }
  const natH=Math.max(0.01,maxY-minY), HORSE_H=120, sc=HORSE_H/natH;
  inner.scale.setScalar(sc); inner.position.y=-minY*sc; inner.rotation.y=Math.PI;
  inner.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.frustumCulled=false; } });
  const obj=new THREE.Group(); obj.add(inner); obj.visible=false; scene.add(obj);
  const mixer=new THREE.AnimationMixer(inner);
  const clip=gltf.animations[0]; if(clip) mixer.clipAction(clip).play();
  // Measured on this model: the topline dips to ~95-100u across the seat (the
  // 120u figure is the head), and the hero's Hips bone is 66.2u above their
  // feet. Seating hips a touch *into* the back lets the legs hang straight
  // down and clip through the barrel, which reads as actually riding — much
  // better than perching him on top. Nudge live with _dev.setRideH(n).
  horse={obj,mixer,rideH:30};
  horseTemplate=inner; horseClip=clip;   // remote riders clone this
}, undefined, err=>console.warn('horse load failed',err));

// ── Mount / dismount / whistle ─────────────────────────────────────
// Dismounting leaves the horse standing in the world (synced to everyone);
// R near it (or double-click/tap it) remounts; R far away whistles it to
// you on a 30s cooldown. The horse persists in the save.
function horseAction(){
  if(!player.hasHorse){ addFloater(player.x,player.y-30,'no horse! buy one from the Farrier'); return; }
  if(player.onHorse){
    player.onHorse=false; player.horseDown=true;
    player.horseX=player.x; player.horseY=player.y;
    addFloater(player.x,player.y-30,'dismounted — your horse waits here');
    return;
  }
  if(player.horseDown){
    if(Math.hypot(player.horseX-player.x,player.horseY-player.y)<TILE*2.5){ mountHorse(); return; }
    const now=performance.now(), left=30000-(now-(G.horseWhistleAt||0));
    if(left>0&&G.horseWhistleAt){ addFloater(player.x,player.y-30,'🐴 whistle cooling down ('+Math.ceil(left/1000)+'s)'); return; }
    G.horseWhistleAt=now;
    player.horseX=player.x+TILE; player.horseY=player.y;
    addFloater(player.x,player.y-30,'🐴 your horse gallops to you!');
    return;
  }
  mountHorse();   // freshly bought horse appears under you
}
function mountHorse(){
  if(player.isRat){ addFloater(player.x,player.y-30,'rats cannot ride!'); return; }
  const th=map[Math.floor(player.y/TILE)]?.[Math.floor(player.x/TILE)];
  if(th===T.CAVE_FLOOR||th===T.CAVE_ENTRANCE){ addFloater(player.x,player.y-30,'no riding in caves'); return; }
  player.onHorse=true; player.horseDown=false;
  addFloater(player.x,player.y-30,'mounted up!');
}
// desktop: double-click your standing horse to mount
G.canvas.addEventListener('dblclick',e=>{
  if(player.dead)return;
  const w=screenToWorld(e.clientX,e.clientY);
  if(G.corpse && Math.hypot(w.x-G.corpse.x,w.y-G.corpse.y)<TILE*1.5){
    if(Math.hypot(G.corpse.x-player.x,G.corpse.y-player.y)<TILE*2.5){
      takeAllCorpse();
    } else {
      addFloater(G.corpse.x,G.corpse.y-30,'walk closer to loot');
    }
    return;
  }
  if(!player.hasHorse||!player.horseDown||player.onHorse)return;
  if(Math.hypot(w.x-player.horseX,w.y-player.horseY)<TILE*1.6){
    if(Math.hypot(player.horseX-player.x,player.horseY-player.y)<TILE*2.5) mountHorse();
    else addFloater(player.horseX,player.horseY-30,'walk closer (or press R to whistle)');
  }
});
// Arrow / drop pools
const APOOL = 30, DPOOL = 100;
const arrowPool = Array.from({length:APOOL}, () => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(1,1,16,4),
    new THREE.MeshLambertMaterial({color:0xc8a050}));
  m.visible=false; scene.add(m); return m;
});
const dropPool = Array.from({length:DPOOL}, () => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(5,6,4),
    new THREE.MeshLambertMaterial({color:0xf0d020}));
  m.visible=false; scene.add(m); return m;
});

// ── Lootable gear ─────────────────────────────────────────────────
// The armor models that don't animate well worn on the player live on as
// treasure instead: they drop from enemies, sit in your pack, store in
// chests, ride along on your corpse, and sell to the merchant for gold. On
// the ground each renders as its real 3D model; in the 2D panels it shows a
// thumbnail rendered from that same model.
const LOOT_GEAR = {
  loot_arms:      { file:'models/Bone_Arms_Armor.glb',      lab:'Bone Arm Guards', ic:'🦴', value:18 },
  loot_gloves:    { file:'models/Leather_Gloves_Armor.glb', lab:'Leather Gloves',  ic:'🧤', value:10 },
  loot_bgloves:   { file:'models/Bone_Gloves_Armor.glb',    lab:'Bone Gloves',     ic:'🧤', value:15 },
  loot_gauntlets: { file:'models/Iron_Gauntlets_Armor.glb', lab:'Iron Gauntlets',  ic:'🛡️', value:28 },
  loot_greaves:   { file:'models/Bone_Leggings_Armor.glb',  lab:'Bone Greaves',    ic:'🦴', value:20 },
  loot_boots:     { file:'models/Iron_Boots_Armor.glb',     lab:'Iron Boots',      ic:'🥾', value:24 },
};
const LOOT_KEYS = Object.keys(LOOT_GEAR);
const isLootGear = k => !!LOOT_GEAR[k];
function itemLabel(k){ return (LOOT_GEAR[k]&&LOOT_GEAR[k].lab) || (typeof BAG_BY_KEY!=='undefined'&&BAG_BY_KEY[k]&&BAG_BY_KEY[k].lab) || k; }

// Baked ground geometry/material (shared per type) + a rendered 2D thumbnail.
const _lootGeo={}, _lootMat={}, lootThumbs={};
const _thumbRT=new THREE.WebGLRenderTarget(128,128);
const _thumbScene=new THREE.Scene();
_thumbScene.environment=scene.environment;   // same IBL, so icons match the in-world look
const _thumbCam=new THREE.PerspectiveCamera(32,1,0.05,200);
_thumbScene.add(new THREE.AmbientLight(0xffffff,2.2));
{ const dl=new THREE.DirectionalLight(0xfff4e6,2.6); dl.position.set(1.5,3,2.5); _thumbScene.add(dl);
  const fill=new THREE.DirectionalLight(0xdfe8ff,1.6); fill.position.set(-2,1,-1.5); _thumbScene.add(fill); }
function _bakeLootThumb(key, geo, mat){
  // Icon-legible clone: drop the (often dark) emissive map and lift shadows a
  // touch so dark iron/leather pieces read clearly on the dark UI panels.
  const tmat=mat.clone(); tmat.emissiveMap=null; tmat.emissive=new THREE.Color(0x2a2a2a); tmat.emissiveIntensity=1;
  const m=new THREE.Mesh(geo, tmat); _thumbScene.add(m);
  const box=new THREE.Box3().setFromObject(m), sz=box.getSize(new THREE.Vector3()), ctr=box.getCenter(new THREE.Vector3());
  const r=Math.max(sz.x,sz.y,sz.z)||1;
  _thumbCam.position.set(ctr.x+r*0.9, ctr.y+r*0.7, ctr.z+r*1.7); _thumbCam.lookAt(ctr);
  const prevRT=renderer.getRenderTarget();
  const prevColor=new THREE.Color(); renderer.getClearColor(prevColor); const prevA=renderer.getClearAlpha();
  renderer.setRenderTarget(_thumbRT); renderer.setClearColor(0x000000,0); renderer.clear();
  renderer.render(_thumbScene,_thumbCam);
  const buf=new Uint8Array(128*128*4);
  renderer.readRenderTargetPixels(_thumbRT,0,0,128,128,buf);
  renderer.setRenderTarget(prevRT); renderer.setClearColor(prevColor, prevA);
  _thumbScene.remove(m);
  const cv=document.createElement('canvas'); cv.width=cv.height=128;
  const c2=cv.getContext('2d'), img=c2.createImageData(128,128);
  for(let y=0;y<128;y++){ const sy=127-y; for(let x=0;x<128;x++){ const si=(sy*128+x)*4, di=(y*128+x)*4;
    img.data[di]=buf[si]; img.data[di+1]=buf[si+1]; img.data[di+2]=buf[si+2]; img.data[di+3]=buf[si+3]; } }
  c2.putImageData(img,0,0); lootThumbs[key]=cv;
}
for(const key of LOOT_KEYS){
  loadPropGeometry(LOOT_GEAR[key].file, {h:16, baseY:0}, (geo, mat)=>{
    _lootGeo[key]=geo; _lootMat[key]=mat; _bakeLootThumb(key, geo, mat);
  });
}
// Draw a gear thumbnail into a 2D panel cell; false if it hasn't baked yet.
function drawLootThumb(key, dx, dy, dw, dh, alpha=1){
  const cv=lootThumbs[key]; if(!cv) return false;
  const ctx=G.ctx; if(alpha!==1){ctx.save();ctx.globalAlpha=alpha;}
  ctx.drawImage(cv,dx,dy,dw,dh); if(alpha!==1)ctx.restore();
  return true;
}
// Ground-drop model holders, aligned 1:1 with dropPool indices.
const lootDropPool = Array.from({length:DPOOL}, () => {
  const g=new THREE.Group(); g.visible=false; scene.add(g); return g;
});

// Campfire dynamic meshes
const cfMeshes = [], cfLights = [];

// Build-mode highlight plane
const hlGeo = new THREE.PlaneGeometry(TILE,TILE);
hlGeo.rotateX(-Math.PI/2);
const hlMesh = new THREE.Mesh(hlGeo,
  new THREE.MeshBasicMaterial({color:0x50d050,transparent:true,opacity:0.45,depthWrite:false}));
hlMesh.position.y=1; hlMesh.visible=false; scene.add(hlMesh);
const buildHighlight = hlMesh;  // alias used in renderBuildOverlay

// ── Champion altars + candle rings ────────────────────────────────
// Each altar: a stone platform + shrine block, ringed by white candles
// (progress toward the next tier) and outer red candles (current tier).
// Lit state is driven from altar.whiteCandles each frame by animateAltars.
const _candleGeo = new THREE.CylinderGeometry(2, 2.6, 11, 6);
const _flameGeo  = new THREE.SphereGeometry(3.4, 7, 6);
const altarVisuals = CHAMP_ALTARS.map(a => {
  const shrine = new THREE.Mesh(new THREE.BoxGeometry(TILE*0.7,TILE*0.4,TILE*0.7),
    new THREE.MeshLambertMaterial({color:0x4a3860, emissive:0x200820}));
  shrine.position.set(a.x, heightAt(a.x,a.y) + TILE*0.2, a.y); scene.add(shrine);
  const maxWhite = a.dungeon ? 24 : 16;
  const maxRed   = a.dungeon ? 6  : 4;
  const mkCandle = (ang, r, flameCol) => {
    const body = new THREE.Mesh(_candleGeo,
      new THREE.MeshLambertMaterial({color:0xe8e0c8, emissive:0x000000}));
    body.position.set(a.x+Math.cos(ang)*r, heightAt(a.x,a.y) + 5.5, a.y+Math.sin(ang)*r);
    const flame = new THREE.Mesh(_flameGeo, hdrGlow(new THREE.MeshBasicMaterial({
      color:flameCol, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false }), FLAME_GAIN));
    flame.position.set(a.x+Math.cos(ang)*r, heightAt(a.x,a.y) + 13, a.y+Math.sin(ang)*r);
    flame.visible = false;
    scene.add(body, flame);
    return { body, flame };
  };
  const whites=[], reds=[];
  for (let i=0;i<maxWhite;i++) whites.push(mkCandle((i/maxWhite)*Math.PI*2-Math.PI/2, TILE*0.72, 0xfff0b0));
  for (let i=0;i<maxRed;i++)   reds.push(  mkCandle((i/maxRed)  *Math.PI*2-Math.PI/2, TILE*0.96, 0xff5030));
  return { altar:a, shrine, whites, reds, maxWhite, maxRed };
});

function animateAltars(t) {
  const pulse = 0.5 + 0.5*Math.sin(t*2.5);
  for (const av of altarVisuals) {
    const a = av.altar, active = a.state!=='idle';
    // Shrine block glows by state: dim idle → gold active → red boss
    av.shrine.material.emissive.setHex(
      a.state==='boss' ? 0x000000 : active ? 0x201004 : 0x200820);
    if (a.state==='boss')      av.shrine.material.emissive.setRGB(0.4+0.4*pulse, 0.05, 0.02);
    else if (active)           av.shrine.material.emissive.setRGB(0.20+0.15*pulse, 0.15+0.1*pulse, 0.03);
    // White candles: lit up to whiteCandles
    for (let i=0;i<av.whites.length;i++) {
      const c=av.whites[i], lit = active && i<a.whiteCandles;
      c.flame.visible = lit;
      if (lit) { c.flame.material.opacity = 0.55+0.45*pulse; c.body.material.emissive.setHex(0x4a3a1e); }
      else c.body.material.emissive.setHex(0x000000);
    }
    // Red candles: one per completed tier (all lit at boss)
    const redCount = a.state==='boss' ? av.maxRed
      : active ? Math.min(av.maxRed, Math.floor(a.whiteCandles/4)+1) : 0;
    for (let i=0;i<av.reds.length;i++) {
      const c=av.reds[i], lit = i<redCount;
      c.flame.visible = lit;
      if (lit) { c.flame.material.opacity = 0.55+0.45*pulse; c.body.material.emissive.setHex(0x501515); }
      else c.body.material.emissive.setHex(0x000000);
    }
  }
}

// ── Player corpse ─────────────────────────────────────────────────
// Shown at G.corpse (dropped on death). After resurrecting, the player
// walks back to it and presses E to reclaim the items it holds.
const corpseGrp = new THREE.Group();
{
  const fallback = new THREE.Group();
  const b = new THREE.Mesh(new THREE.BoxGeometry(22,7,13),
    new THREE.MeshLambertMaterial({color:0x7d4a2e}));
  b.position.y = 4; b.rotation.z = 0.14; b.castShadow = true;
  const h = new THREE.Mesh(new THREE.SphereGeometry(6,8,6),
    new THREE.MeshLambertMaterial({color:0xcaa472}));
  h.position.set(11,5,2);
  fallback.add(b, h);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(15,16),
    new THREE.MeshBasicMaterial({color:0x5a1010, transparent:true, opacity:0.5, depthWrite:false}));
  pool.rotation.x = -Math.PI/2; pool.position.y = 0.5;
  corpseGrp.add(pool, fallback);
  // Real art: the dropped backpack holds the corpse's items. Leaned back so
  // the gridded pockets face up toward the camera.
  loadPropGeometry('models/Backpack_Inventory.glb', {h:26, baseY:0}, (geo, mat)=>{
    fallback.visible=false;
    const bp=new THREE.Mesh(geo, mat); bp.castShadow=true;
    bp.rotation.set(-1.1, 0.4, 0);
    corpseGrp.add(bp);
  });
}
corpseGrp.visible = false; scene.add(corpseGrp);

// ── Cave entrance arches ──────────────────────────────────────────
// The generator carves a walkable CAVE_ENTRANCE tile at each cave mouth,
// but dark floor between dark wall boxes is invisible in 3D. Mark every
// mouth with a stone arch + flickering torches so it reads as a doorway.
const archFlames = [];
const archLightSrcs = [];   // world positions of arch flames → fed to the light pool
{
  const pillarGeo = new THREE.BoxGeometry(7, 56, 10);
  const lintelGeo = new THREE.BoxGeometry(TILE+18, 9, 12);
  const flameGeo  = new THREE.SphereGeometry(4, 7, 6);
  const stoneMat  = new THREE.MeshLambertMaterial({color:0x7a7264});
  for (let ty=0; ty<480; ty++) for (let tx=0; tx<MAP_W; tx++) {
    if (map[ty][tx]!==T.CAVE_ENTRANCE) continue;
    const cx=tx*TILE+TILE/2, cz=ty*TILE+TILE/2;
    const pl=new THREE.Mesh(pillarGeo,stoneMat), pr=new THREE.Mesh(pillarGeo,stoneMat);
    pl.position.set(cx-TILE/2-4, 28, cz); pr.position.set(cx+TILE/2+4, 28, cz);
    pl.castShadow=pr.castShadow=true;
    const lintel=new THREE.Mesh(lintelGeo,stoneMat);
    lintel.position.set(cx, 58, cz); lintel.castShadow=true;
    const fl=new THREE.Mesh(flameGeo,hdrGlow(new THREE.MeshBasicMaterial({
      color:0xffa040, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false}), FLAME_GAIN));
    const fr=fl.clone(); fr.material=fl.material.clone();
    fl.position.set(cx-TILE/2-4, 62, cz); fr.position.set(cx+TILE/2+4, 62, cz);
    scene.add(pl,pr,lintel,fl,fr); archFlames.push(fl,fr);
    archLightSrcs.push({x:cx, y:cz});
  }
}
function animateArches(t) {
  for (let i=0;i<archFlames.length;i++) {
    const f=archFlames[i];
    f.material.opacity = 0.55+0.4*Math.sin(t*7+i*2.1);
    f.scale.setScalar(0.85+0.25*Math.sin(t*9+i*1.4));
  }
}

// ── Animated teleport portals ("sparklies") ───────────────────────
// One glowing swirl + orbiting sparkle motes per T.TELEPORT tile.
const portals = [];
const _sparkGeo = new THREE.SphereGeometry(2.6, 6, 5);
function makePortal(cx, cz) {
  const g = new THREE.Group(); g.position.set(cx, heightAt(cx,cz), cz);
  const discGeo = new THREE.CircleGeometry(TILE*0.5, 22); discGeo.rotateX(-Math.PI/2);
  const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
    color:0xb060ff, transparent:true, opacity:0.5, blending:THREE.AdditiveBlending,
    depthWrite:false, side:THREE.DoubleSide }));
  disc.position.y = 3;
  const colGeo = new THREE.CylinderGeometry(TILE*0.26, TILE*0.4, TILE*2.4, 14, 1, true);
  const col = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({
    color:0x9040ff, transparent:true, opacity:0.22, blending:THREE.AdditiveBlending,
    depthWrite:false, side:THREE.DoubleSide }));
  col.position.y = TILE*1.2;
  const sparks = new THREE.Group();
  for (let i=0;i<9;i++) {
    const s = new THREE.Mesh(_sparkGeo, new THREE.MeshBasicMaterial({
      color:0xe0b0ff, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false }));
    s.userData.phase = i/9 * Math.PI*2;
    sparks.add(s);
  }
  g.add(disc, col, sparks);
  g.userData = { disc, col, sparks };
  scene.add(g); portals.push(g); return g;
}
for (let ty=0;ty<MAP_H;ty++) for (let tx=0;tx<MAP_W;tx++)
  if (map[ty][tx]===T.TELEPORT) makePortal(tx*TILE+TILE/2, ty*TILE+TILE/2);

// Advance every portal's animation (called from render3D each frame)
function animatePortals(t) {
  for (const p of portals) {
    const { disc, col, sparks } = p.userData;
    const pulse = 0.5 + 0.35*Math.sin(t*3.2);
    disc.material.opacity = 0.30 + pulse*0.45; disc.rotation.y = t*0.6;
    col.material.opacity  = 0.12 + pulse*0.22; col.rotation.y  = -t*0.4;
    sparks.rotation.y = t*1.6;
    const kids = sparks.children;
    for (let i=0;i<kids.length;i++) {
      const s = kids[i], ph = s.userData.phase;
      const r = TILE*0.34 + Math.sin(t*2 + ph)*4;
      s.position.set(Math.cos(ph)*r, TILE*0.35 + (0.5+0.5*Math.sin(t*1.8+ph))*TILE, Math.sin(ph)*r);
      s.material.opacity = 0.35 + 0.6*Math.abs(Math.sin(t*3 + ph));
    }
  }
}

// ── Raycaster — mouse→world (y=0 plane) ──────────────────────────
const _ray  = new THREE.Raycaster();
const _gPl  = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
const _rTgt = new THREE.Vector3();
const _ndc  = new THREE.Vector2();
const _prj  = new THREE.Vector3();

let worldMouseX = 0, worldMouseY = 0;

function screenToWorld(sx, sy) {
  _ndc.set((sx/innerWidth)*2-1, -(sy/innerHeight)*2+1);
  _ray.setFromCamera(_ndc, camera);
  return _ray.ray.intersectPlane(_gPl, _rTgt)
    ? {x:_rTgt.x, y:_rTgt.z}
    : {x:sx+G.camX, y:sy+G.camY};
}
function updateWorldMouse() {
  if(!mouse.hasPos) return;
  const w=screenToWorld(mouse.sx,mouse.sy);
  worldMouseX=w.x; worldMouseY=w.y;
}
function worldToScreen(wx, wy, wh=20) {
  _prj.set(wx,wh,wy); _prj.project(camera);
  return {x:(_prj.x+1)/2*innerWidth, y:-(_prj.y-1)/2*innerHeight};
}
// Which tree is the pointer actually over? Raycasts the trunk+canopy meshes
// so tapping the tall leafy top counts as hitting that tree, not the empty
// ground its silhouette overlaps. Returns {tx,ty} or null.
// One instTile array PER MESH. instanceId is an index into the mesh it came
// from, so with a mesh pair per species a single shared array would be read
// with another mesh's index and chopping would fell the wrong tree.
trunkMesh.userData.instTile = treeInstTile;
// The two canopies fill independently, so their instance indices are their own
// and they cannot share the trunk's map — a chop would otherwise read one
// mesh's index into another mesh's array and fell the wrong tree.
topMesh.userData.instTile      = [];
topBroadMesh.userData.instTile = [];
// Every mesh a tree can be hit on. topBroadMesh has to be here too — leave it
// out and clicking the crown of any broadleaf does nothing, because the ray
// never tests the mesh that is actually drawing it.
const _treeRayMeshes = [topMesh, topBroadMesh, trunkMesh]
  .concat(nearForest ? nearForest.meshes : []);
function pickTreeTile(sx, sy) {
  _ndc.set((sx/innerWidth)*2-1, -(sy/innerHeight)*2+1);
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(_treeRayMeshes, false);
  for (const h of hits) {
    if (h.instanceId==null) continue;
    const tileMap = h.object.userData && h.object.userData.instTile;
    if (!tileMap) continue;
    const packed = tileMap[h.instanceId];
    if (packed==null) continue;
    const tx=packed%MAP_W, ty=(packed/MAP_W)|0;   // unpack int → tile
    if (map[ty] && map[ty][tx]===T.TREE) return {tx,ty};
  }
  return null;
}

// Which wall is the pointer over? Same trick as pickTreeTile: raycast the
// instanced wall meshes and map instanceId back to a tile. Without this you had
// to aim at a wall's GROUND FOOTPRINT to mount a torch, because the click was
// only ever intersected with the y=0 plane — so clicking the visible face (which
// is metres up in the air) resolved to whatever tile lay behind the wall.
// Returns {tx,ty,point} or null.
function pickWallTile(sx, sy) {
  _ndc.set((sx/innerWidth)*2-1, -(sy/innerHeight)*2+1);
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects([wallMesh, caveMesh, customMesh], false);
  for (const h of hits) {
    if (h.instanceId==null) continue;
    const packed = h.object===wallMesh ? wallInstTile[h.instanceId]
                 : h.object===caveMesh ? caveInstTile[h.instanceId] : null;
    if (packed==null) {                       // customMesh (glass): fall back to the hit point
      const tx=Math.floor(h.point.x/TILE), ty=Math.floor(h.point.z/TILE);
      if(map[ty] && _isFullCover(map[ty][tx])) return {tx,ty,point:h.point};
      continue;
    }
    const tx=packed%MAP_W, ty=(packed/MAP_W)|0;
    if (map[ty] && _isFullCover(map[ty][tx])) return {tx,ty,point:h.point};
  }
  return null;
}
// How far the wall's surface actually sits from its tile centre, along one axis.
// Mirrors the jitter/scale/yaw that rebuildWalls and rebuildCave apply, because
// a flat TILE/2 assumption buries the torch: cave blocks are randomly YAWED, so
// a corner can reach ~35u from centre when half a tile is only 24.
function wallSurfaceOffset(tx, ty, axis){
  const t = map[ty] && map[ty][tx];
  if(t===T.CAVE_WALL){
    const n1=_terrNoise(tx*11,ty*19), n2=_terrNoise(tx*23,ty*7);
    const hx=TILE*(0.96+n1*0.08)/2, hz=TILE*(0.96+n2*0.08)/2;
    const yaw=n2*Math.PI*2, c=Math.abs(Math.cos(yaw)), s=Math.abs(Math.sin(yaw));
    return { ext: axis==='x' ? hx*c+hz*s : hx*s+hz*c,
             jit: axis==='x' ? (n1-0.5)*3 : (n2-0.5)*3 };
  }
  if(t===T.WALL){
    const n1=_terrNoise(tx*13,ty*17), n2=_terrNoise(tx*29,ty*5);
    const h=TILE*0.98/2, yaw=(n2-0.5)*0.08;
    const c=Math.abs(Math.cos(yaw)), s=Math.abs(Math.sin(yaw));
    return { ext: h*c+h*s, jit: axis==='x' ? (n1-0.5)*2 : (n2-0.5)*2 };
  }
  return { ext: TILE*0.49, jit: 0 };          // glass / custom boxes: axis-aligned
}

// ── Focus helper ──────────────────────────────────────────────────
function grabFocus() { try { window.focus(); G.canvas.focus(); } catch(_){} }
window.addEventListener('load', grabFocus);
G.canvas.addEventListener('pointerdown', grabFocus);
G.canvas.addEventListener('mousedown', grabFocus);
grabFocus();

// ── Skill helpers ─────────────────────────────────────────────────
function skillLv(sk) {
  let lv=1;
  for(let i=1;i<XP_LEVELS.length;i++) if(sk.xp>=XP_LEVELS[i]) lv=i+1;
  return Math.min(lv,10);
}
function skillXpPrev(sk){const lv=skillLv(sk);return lv<=1?0:XP_LEVELS[lv-1];}
function skillXpMax(sk) {const lv=skillLv(sk);return lv>=10?XP_LEVELS[9]:XP_LEVELS[lv];}
function addSkillXp(sk,amt){
  if(skillLv(sk)>=10)return;
  sk.xp+=amt*(1+artifactBonus('xpMult'));
  if(skillLv(sk)>=10) grantAchiev('skill_max');   // "Master Artisan"
}
function tacticsLv()  {return skillLv(skills.tactics);}
function archeryLv()  {return skillLv(skills.archery);}
function hidingLv()   {return skillLv(skills.hiding);}
function healingLv()  {return skillLv(skills.healing);}
function wrestlingLv(){return skillLv(skills.wrestling);}

// ── Utilities ─────────────────────────────────────────────────────
function addFloater(x,y,text){floaters.push({x,y,text,life:0.9});}
// A one-second rolling frame counter. It lives in the status line rather than as
// its own canvas overlay because that corner of the screen is already spoken for
// (BOARDS / ? / HUB) and the status line is the place transient readouts go.
let _fpsN=0, _fpsT=0, _fpsVal=0;
function fpsSample(t){
  _fpsN++;
  if(!_fpsT){_fpsT=t;return;}
  if(t-_fpsT>=1000){ _fpsVal=Math.round(_fpsN*1000/(t-_fpsT)); _fpsN=0; _fpsT=t; }
}
function tileAt(px,py){
  const tx=Math.floor(px/TILE),ty=Math.floor(py/TILE);
  if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return T.STONE;
  return map[ty][tx];
}
function nearbyObject(type,tileRadius){
  const r2=(tileRadius*TILE)**2;
  return placedObjects.some(o=>o.type===type&&(o.x-player.x)**2+(o.y-player.y)**2<r2);
}
function findClearSpawn(){
  const stx=Math.floor(player.x/TILE),sty=Math.floor(player.y/TILE);
  for(let radius=0;radius<Math.max(MAP_W,MAP_H);radius++)
    for(let dy=-radius;dy<=radius;dy++)
      for(let dx=-radius;dx<=radius;dx++){
        if(Math.max(Math.abs(dx),Math.abs(dy))!==radius) continue;
        const tx=stx+dx,ty=sty+dy;
        if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) continue;
        const cx=tx*TILE+TILE/2,cy=ty*TILE+TILE/2;
        if(!boxBlocked(cx,cy,player.r)){player.x=cx;player.y=cy;return;}
      }
}
findClearSpawn();
function respawnPlayer(){
  player.hp=Math.round(player.maxHp*0.3);
  player.dead=false;player.ghost=false;player.iframes=2;
  G.corpseLootOpen=false;
  for(const e of enemies) if(e.state!=='dead'&&e.state!=='respawning'){e.state='idle';e.attackTimer=1;}
}

// ── Crafting ──────────────────────────────────────────────────────
const RECIPES=[
  {id:'planks',   top:'3 wood → 1 plank',           adv:false,sub:()=>'have: '+inv.wood+' wood'},
  {id:'arrows',   top:'1 wood → 3 arrows',          adv:false,sub:()=>'have: '+inv.wood+' wood'},
  {id:'wall',     top:'1 plank → place wall',       adv:false,sub:()=>'have: '+inv.planks+' planks'},
  {id:'pickaxe',  top:'3 planks → pickaxe',         adv:false,sub:()=>player.hasPickaxe?'OWNED':'have: '+inv.planks+' planks'},
  {id:'sword',    top:'5 planks → sword',           adv:false,sub:()=>player.hasSword?'OWNED':'have: '+inv.planks+' planks'},
  {id:'bow',      top:'4 planks → bow',             adv:false,sub:()=>player.hasBow?'OWNED':'have: '+inv.planks+' planks'},
  {id:'campfire', top:'2 wood + 2 stone → campfire',adv:false,sub:()=>'have: '+inv.wood+'w  '+inv.stone+'s'},
  {id:'workbench',top:'5 planks + 3 stone → bench', adv:false,sub:()=>'have: '+inv.planks+'p  '+inv.stone+'s'},
  {id:'larmor',   top:'2 hide → leather armor piece',adv:false,sub:()=>'have: '+inv.hide+' hide  ('+Math.round((typeof armorDR==='function'?armorDR():0)*100)+'% armor)'},
  {id:'barmor',   top:'2 hide + 2 bone → bone piece ★',adv:true,sub:()=>nearbyObject('workbench',3)?'have: '+inv.hide+'h '+(inv.bone||0)+'b  ✓':'need: workbench nearby'},
  {id:'bandage',  top:'2 hide → 1 bandage',         adv:false,sub:()=>'have: '+inv.hide+' hide  bandag: '+inv.bandages},
  {id:'forge',    top:'6 stone + 4 wood → forge',   adv:false,sub:()=>'have: '+inv.stone+'s  '+inv.wood+'w'},
  {id:'iron_ingot',top:'3 iron ore → 1 iron ingot', adv:true,sub:()=>(nearbyObject('forge',3)||Math.hypot(BLACKSMITH.x-player.x,BLACKSMITH.y-player.y)<TILE*2.5)?'have: '+(inv.iron_ore||0)+' ore':'need: forge nearby'},
  {id:'mithril_ingot',top:'3 mithril ore → 1 mithril ingot', adv:true,sub:()=>(nearbyObject('forge',3)||Math.hypot(BLACKSMITH.x-player.x,BLACKSMITH.y-player.y)<TILE*2.5)?'have: '+(inv.mithril_ore||0)+' ore':'need: forge nearby'},
  {id:'runic_ingot',top:'3 runic ore → 1 runic ingot', adv:true,sub:()=>(nearbyObject('forge',3)||Math.hypot(BLACKSMITH.x-player.x,BLACKSMITH.y-player.y)<TILE*2.5)?'have: '+(inv.runic_ore||0)+' ore':'need: forge nearby'},
  {id:'iron_pick',top:'3 iron ingots + 2 planks → iron pick',adv:true,sub:()=>player.pickaxeTier>=2?'OWNED':(nearbyObject('workbench',3)?'have: '+(inv.iron_ingot||0)+'i  '+inv.planks+'p':'need: workbench nearby')},
  {id:'iron_sword',top:'4 iron ingots + 2 planks → iron sword',adv:true,sub:()=>player.swordTier>=2?'OWNED':(nearbyObject('workbench',3)?'have: '+(inv.iron_ingot||0)+'i  '+inv.planks+'p':'need: workbench nearby')},
  {id:'steel_sword',top:'3 steel ingots + iron sword → steel sword',adv:true,sub:()=>player.swordTier>=3?'OWNED':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.steel_ingot||0)+' steel':'need: forge/bench nearby')},
  {id:'steel_bow',top:'3 steel ingots + iron bow → steel bow',adv:true,sub:()=>player.bowTier>=3?'OWNED':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.steel_ingot||0)+' steel':'need: forge/bench nearby')},
  {id:'mithril_pick',top:'3 mithril ingots → mithril pick',adv:true,sub:()=>player.pickaxeTier>=4?'OWNED':(nearbyObject('workbench',3)?'have: '+(inv.mithril_ingot||0)+' m-ingots':'need: workbench nearby')},
  {id:'mithril_sword',top:'3 mithril ingots → mithril sword',adv:true,sub:()=>player.swordTier>=4?'OWNED':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.mithril_ingot||0)+' m-ingots':'need: forge/bench nearby')},
  {id:'mithril_bow',top:'3 mithril ingots → mithril bow',adv:true,sub:()=>player.bowTier>=4?'OWNED':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.mithril_ingot||0)+' m-ingots':'need: forge/bench nearby')},
  {id:'runic_pick',top:'3 runic ingots → runic pick',adv:true,sub:()=>player.pickaxeTier>=5?'OWNED':(nearbyObject('workbench',3)?'have: '+(inv.runic_ingot||0)+' r-ingots':'need: workbench nearby')},
  {id:'runic_sword',top:'3 runic ingots → runic sword',adv:true,sub:()=>player.swordTier>=5?'OWNED':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.runic_ingot||0)+' r-ingots':'need: forge/bench nearby')},
  {id:'runic_bow',top:'3 runic ingots → runic bow',adv:true,sub:()=>player.bowTier>=5?'OWNED':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.runic_ingot||0)+' r-ingots':'need: forge/bench nearby')},
  {id:'bronze_arm',top:'3 iron ingots + 2 hide → bronze armor',adv:true,sub:()=>!hasUpgradeSlot(3)?'FULL SET':(nearbyObject('workbench',3)?'have: '+(inv.iron_ingot||0)+'i  '+inv.hide+'h':'need: workbench nearby')},
  {id:'steel_arm',top:'2 steel ingots + hide + bone → steel armor',adv:true,sub:()=>!hasUpgradeSlot(4)?'FULL SET':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.steel_ingot||0)+'s  '+inv.hide+'h':'need: forge/bench nearby')},
  {id:'mithril_arm',top:'3 mithril ingots + hide → mithril armor',adv:true,sub:()=>!hasUpgradeSlot(5)?'FULL SET':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.mithril_ingot||0)+'m  '+inv.hide+'h':'need: forge/bench nearby')},
  {id:'runic_arm',top:'3 runic ingots + hide → runic armor',adv:true,sub:()=>!hasUpgradeSlot(6)?'FULL SET':((nearbyObject('forge',3)||nearbyObject('workbench',3))?'have: '+(inv.runic_ingot||0)+'r  '+inv.hide+'h':'need: forge/bench nearby')},
  {id:'secure_chest',top:'5 planks + 4 iron ingots → secure chest',adv:true,sub:()=>nearbyObject('workbench',3)?'have: '+inv.planks+'p  '+(inv.iron_ingot||0)+'i':'need: workbench nearby'},
  {id:'siege_ram',top:'10 wood + 3 iron ingots → siege ram',adv:true,sub:()=>nearbyObject('workbench',3)?'have: '+inv.wood+'w  '+(inv.iron_ingot||0)+'i':'need: workbench nearby'},
  {id:'torch',top:'1 wood + 1 hide → 3 torches',adv:false,sub:()=>'have: '+inv.wood+'w  '+inv.hide+'h  ('+inv.torch+' held)'},
  {id:'hearth',   top:'8 stone + 4 wood → hearth',    adv:true,sub:()=>nearbyObject('workbench',3)?'have: '+inv.stone+'s  '+inv.wood+'w':'need: workbench nearby'},
  {id:'anvil',    top:'5 iron ingots → anvil',        adv:true,sub:()=>nearbyObject('workbench',3)&&nearbyObject('forge',3)?'have: '+(inv.iron_ingot||0)+' ingots':'need: workbench & forge'},
  {id:'lantern',  top:'2 iron ingots + 1 hide → lantern',adv:true,sub:()=>nearbyObject('workbench',3)?'have: '+(inv.iron_ingot||0)+'i  '+inv.hide+'h':'need: workbench'},
];
// 35 recipes over two columns is 18 rows = 700px, taller than the usable height on a
// phone once the HUD is accounted for. Clamped so the panel cannot run off the bottom;
// the rows that no longer fit need scrolling, which the backpack already implements.
const PANEL_H=fitPanelH(HEADER_H+PANEL_PAD+Math.ceil(RECIPES.length/2)*(BTN_H+BTN_GAP)-BTN_GAP+PANEL_PAD);
// ── Draggable panels ──────────────────────────────────────────────
// Every panel position runs through panelAt(): default spot + a saved
// per-panel offset. Grab any panel by its header (top strip) to move it;
// positions persist in localStorage and clamp to the screen on resize.
const PANEL_POS_KEY='bravoPanelPos_v1';
let panelOfs={};
try{ panelOfs=JSON.parse(localStorage.getItem(PANEL_POS_KEY)||'{}')||{}; }catch(_){ panelOfs={}; }
const panelRects={};      // name → {x,y,w,h}, registered by each render pass
let panelDrag=null;       // {name, sx, sy, ox, oy}
const PANEL_GRIP=26;      // draggable header strip height
function panelAt(name, bx, by, w, h){
  const o=panelOfs[name]||{x:0,y:0};
  const px=Math.round(Math.max(0,Math.min(G.canvas.width-w,  bx+o.x)));
  const py=Math.round(Math.max(0,Math.min(G.canvas.height-40, by+o.y)));
  panelRects[name]={x:px,y:py,w,h,t:G.gameTime};
  return {px,py};
}
// Panels remember where they were dragged and how far they were resized. That is
// a good default until a window resize or a device change strands one half off
// screen, so the settings menu offers a way back to centre.
function resetPanelPositions(){
  for(const k in panelOfs) delete panelOfs[k];
  try{ localStorage.removeItem(PANEL_POS_KEY); }catch(_){}
}
function panelDragStart(x,y){
  for(const [name,r] of Object.entries(panelRects)){
    if(G.gameTime-(r.t||0)>0.25)continue;   // stale rect: that panel isn't on screen anymore
    if(x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+Math.min(PANEL_GRIP,r.h)){
      const o=panelOfs[name]||{x:0,y:0};
      panelDrag={name,sx:x,sy:y,ox:o.x,oy:o.y};
      return true;
    }
  }
  return false;
}
function panelDragMove(x,y){
  if(!panelDrag)return false;
  panelOfs[panelDrag.name]={x:panelDrag.ox+(x-panelDrag.sx), y:panelDrag.oy+(y-panelDrag.sy)};
  return true;
}
function panelDragEnd(){
  if(!panelDrag)return;
  panelDrag=null;
  try{ localStorage.setItem(PANEL_POS_KEY,JSON.stringify(panelOfs)); }catch(_){}
}

function panelXY(){return panelAt('craft', G.canvas.width-PANEL_W-12, Math.round(G.canvas.height/2-PANEL_H/2), PANEL_W, PANEL_H);}
// Two columns need ~290px each for the longest recipe strings. Below this the panel
// goes single-column instead of overlapping its own text.
const CRAFT_MIN_2COL = 420;
function craftCols(){ return PANEL_W < CRAFT_MIN_2COL ? 1 : 2; }
function craftRowsVisible(){
  // The 34px is the scroll-arrow strip below the header; subtract it unconditionally so
  // this and craftMaxScroll() cannot disagree (craftMaxScroll calls this, so it must not
  // call craftMaxScroll back).
  return Math.max(1, Math.floor((PANEL_H - HEADER_H - PANEL_PAD*2 - 34) / (BTN_H + BTN_GAP)));
}
function craftMaxScroll(){
  return Math.max(0, Math.ceil(RECIPES.length / craftCols()) - craftRowsVisible());
}
// 30px targets, comfortably over the 24px WCAG minimum and close to the 44px that
// halves mis-taps in practice. Two of them, in the header, out of the recipe rows.
function craftScrollBtns(){
  const {px,py}=panelXY(), s=30, gap=4;
  // BELOW the header, not in it. panelDragStart() owns the top PANEL_GRIP (26px) of
  // every panel and is tested before any panel's own handler, so a control placed in
  // the header can never be clicked — the click begins a drag instead. Sitting them
  // just under the divider keeps them reachable and still out of the recipe rows.
  const y=py+HEADER_H+2;
  return {
    up:   {x:px+PANEL_W-PANEL_PAD-s*2-gap, y, w:s, h:s},
    down: {x:px+PANEL_W-PANEL_PAD-s,       y, w:s, h:s},
  };
}
function recipeRects(){
  const {px,py}=panelXY();
  // Leave room for the scroll strip when there is one to show.
  const top=py+HEADER_H+PANEL_PAD+(craftMaxScroll()>0?34:0);
  const cols=craftCols();
  const colW = (PANEL_W - PANEL_PAD*2 - (cols-1)*8) / cols;
  const maxS=craftMaxScroll();
  if(G.craftScroll===undefined) G.craftScroll=0;
  if(G.craftScroll>maxS) G.craftScroll=maxS;
  if(G.craftScroll<0) G.craftScroll=0;
  const rowsVis=craftRowsVisible();
  return RECIPES.map((r,i)=>{
    const col = i % cols;
    const row = Math.floor(i / cols) - G.craftScroll;
    return {
      x: px + PANEL_PAD + col * (colW + 8),
      y: top + row * (BTN_H + BTN_GAP),
      w: colW,
      h: BTN_H,
      // Scrolled out of view: still returned so the two consumers can stay index-free,
      // but never drawn and never clickable.
      vis: row >= 0 && row < rowsVis,
      rec: r,
      id: r.id
    };
  });
}
function canCraft(id){
  const wb = nearbyObject('workbench', 3);
  const fg = nearbyObject('forge', 3) || Math.hypot(BLACKSMITH.x-player.x, BLACKSMITH.y-player.y) < TILE*2.5;
  if(id==='planks')    return inv.wood>=3;
  if(id==='arrows')    return inv.wood>=1;
  if(id==='wall')      return inv.planks>=1;
  if(id==='pickaxe')   return inv.planks>=3&&!player.hasPickaxe;
  if(id==='sword')     return inv.planks>=5&&!player.hasSword;
  if(id==='bow')       return inv.planks>=4&&!player.hasBow;
  if(id==='campfire')  return inv.wood>=2&&inv.stone>=2;
  if(id==='workbench') return inv.planks>=5&&inv.stone>=3;
  if(id==='larmor')    return inv.hide>=2&&hasUpgradeSlot(1);
  if(id==='barmor')    return inv.hide>=2&&(inv.bone||0)>=2&&wb&&hasUpgradeSlot(2);
  if(id==='bandage')   return inv.hide>=2;
  if(id==='forge')     return inv.stone>=6&&inv.wood>=4;
  if(id==='iron_ingot') return (inv.iron_ore||0)>=3&&fg;
  if(id==='mithril_ingot') return (inv.mithril_ore||0)>=3&&fg;
  if(id==='runic_ingot') return (inv.runic_ore||0)>=3&&fg;
  if(id==='iron_pick') return (inv.iron_ingot||0)>=3&&inv.planks>=2&&wb;
  if(id==='iron_sword') return (inv.iron_ingot||0)>=4&&inv.planks>=2&&(player.swordTier||1)<2&&wb;
  if(id==='steel_sword') return (inv.steel_ingot||0)>=3&&player.hasSword&&(player.swordTier||1)<3&&(wb||fg);
  if(id==='steel_bow') return (inv.steel_ingot||0)>=3&&player.hasBow&&(player.bowTier||1)<3&&(wb||fg);
  if(id==='mithril_pick') return (inv.mithril_ingot||0)>=3&&(player.pickaxeTier||1)<4&&wb;
  if(id==='mithril_sword') return (inv.mithril_ingot||0)>=3&&(player.swordTier||1)<4&&(wb||fg);
  if(id==='mithril_bow') return (inv.mithril_ingot||0)>=3&&(player.bowTier||1)<4&&(wb||fg);
  if(id==='runic_pick') return (inv.runic_ingot||0)>=3&&(player.pickaxeTier||1)<5&&wb;
  if(id==='runic_sword') return (inv.runic_ingot||0)>=3&&(player.swordTier||1)<5&&(wb||fg);
  if(id==='runic_bow') return (inv.runic_ingot||0)>=3&&(player.bowTier||1)<5&&(wb||fg);
  if(id==='bronze_arm') return (inv.iron_ingot||0)>=3&&inv.hide>=2&&wb&&hasUpgradeSlot(3);
  if(id==='steel_arm') return (inv.steel_ingot||0)>=2&&inv.hide>=2&&(inv.bone||0)>=2&&(wb||fg)&&hasUpgradeSlot(4);
  if(id==='mithril_arm') return (inv.mithril_ingot||0)>=3&&inv.hide>=2&&(wb||fg)&&hasUpgradeSlot(5);
  if(id==='runic_arm') return (inv.runic_ingot||0)>=3&&inv.hide>=2&&(wb||fg)&&hasUpgradeSlot(6);
  if(id==='secure_chest') return inv.planks>=5&&(inv.iron_ingot||0)>=4&&wb;
  if(id==='siege_ram') return inv.wood>=10&&(inv.iron_ingot||0)>=3&&wb;
  if(id==='torch') return inv.wood>=1&&inv.hide>=1;
  if(id==='hearth') return inv.stone>=8&&inv.wood>=4&&wb;
  if(id==='anvil') return (inv.iron_ingot||0)>=5&&wb&&fg;
  if(id==='lantern') return (inv.iron_ingot||0)>=2&&inv.hide>=1&&wb;
  return false;
}
function doCraft(id){
  if(!canCraft(id)) return; snd.craft();
  questEvent('craft', id);
  if(id==='planks')   {inv.wood-=3;inv.planks+=1;addFloater(player.x,player.y-20,'+1 plank');}
  if(id==='arrows')   {inv.wood-=1;inv.arrows+=3;addFloater(player.x,player.y-20,'+3 arrows');}
  if(id==='wall')     {G.craftOpen=false;G.buildMode=true;G.buildItem='wall';}
  if(id==='pickaxe')  {inv.planks-=3;player.hasPickaxe=true;player.pickaxeTier=1;addFloater(player.x,player.y-20,'pickaxe!');}
  if(id==='sword')    {inv.planks-=5;player.hasSword=true;player.weapon='sword';addFloater(player.x,player.y-20,'sword!');}
  if(id==='bow')      {inv.planks-=4;player.hasBow=true;if(!player.hasSword)player.weapon='bow';addFloater(player.x,player.y-20,'bow!');}
  // Placeables go into the pack, not straight into build mode. Crafting a
  // workbench and pressing ESC used to destroy the 5 planks + 3 stone outright:
  // the cost was spent, build mode cancelled, and nothing was ever placed.
  if(id==='campfire') {inv.wood-=2;inv.stone-=2;gainPlaceable('campfire');}
  if(id==='workbench'){inv.planks-=5;inv.stone-=3;gainPlaceable('workbench');}
  if(id==='larmor')   {inv.hide-=2;equipArmorPiece(1);}
  if(id==='barmor')   {inv.hide-=2;inv.bone-=2;equipArmorPiece(2);}
  if(id==='bandage')  {inv.hide-=2;inv.bandages+=1;addFloater(player.x,player.y-20,'+1 bandage');}
  if(id==='forge')     {inv.stone-=6;inv.wood-=4;gainPlaceable('forge');}
  if(id==='iron_ingot'){inv.iron_ore-=3;inv.iron_ingot=(inv.iron_ingot||0)+1;addFloater(player.x,player.y-20,'+1 iron ingot');}
  if(id==='mithril_ingot'){inv.mithril_ore-=3;inv.mithril_ingot=(inv.mithril_ingot||0)+1;addFloater(player.x,player.y-20,'+1 mithril ingot');}
  if(id==='runic_ingot'){inv.runic_ore-=3;inv.runic_ingot=(inv.runic_ingot||0)+1;addFloater(player.x,player.y-20,'+1 runic ingot');}
  if(id==='iron_pick') {inv.iron_ingot-=3;inv.planks-=2;player.pickaxeTier=2;player.hasPickaxe=true;addFloater(player.x,player.y-20,'Iron Pickaxe!');}
  if(id==='iron_sword'){inv.iron_ingot-=4;inv.planks-=2;player.swordTier=2;player.hasSword=true;player.weapon='sword';addFloater(player.x,player.y-20,'Iron Sword!');}
  if(id==='steel_sword'){inv.steel_ingot-=3;player.swordTier=3;player.hasSword=true;player.weapon='sword';addFloater(player.x,player.y-20,'Steel Sword!');}
  if(id==='steel_bow') {inv.steel_ingot-=3;player.bowTier=3;player.hasBow=true;player.weapon='bow';addFloater(player.x,player.y-20,'Steel Bow!');}
  if(id==='mithril_pick') {inv.mithril_ingot-=3;player.pickaxeTier=4;player.hasPickaxe=true;addFloater(player.x,player.y-20,'Mithril Pickaxe!');}
  if(id==='mithril_sword'){inv.mithril_ingot-=3;player.swordTier=4;player.hasSword=true;player.weapon='sword';addFloater(player.x,player.y-20,'Mithril Sword!');}
  if(id==='mithril_bow') {inv.mithril_ingot-=3;player.bowTier=4;player.hasBow=true;player.weapon='bow';addFloater(player.x,player.y-20,'Mithril Bow!');}
  if(id==='runic_pick') {inv.runic_ingot-=3;player.pickaxeTier=5;player.hasPickaxe=true;addFloater(player.x,player.y-20,'Runic Pickaxe!');}
  if(id==='runic_sword'){inv.runic_ingot-=3;player.swordTier=5;player.hasSword=true;player.weapon='sword';addFloater(player.x,player.y-20,'Runic Sword!');}
  if(id==='runic_bow') {inv.runic_ingot-=3;player.bowTier=5;player.hasBow=true;player.weapon='bow';addFloater(player.x,player.y-20,'Runic Bow!');}
  if(id==='bronze_arm'){inv.iron_ingot-=3;inv.hide-=2;equipArmorPiece(3);}
  if(id==='steel_arm') {inv.steel_ingot-=2;inv.hide-=2;inv.bone-=2;equipArmorPiece(4);}
  if(id==='mithril_arm'){inv.mithril_ingot-=3;inv.hide-=2;equipArmorPiece(5);}
  if(id==='runic_arm') {inv.runic_ingot-=3;inv.hide-=2;equipArmorPiece(6);}
  if(id==='secure_chest') {inv.planks-=5;inv.iron_ingot-=4;gainPlaceable('secure_chest');}
  if(id==='siege_ram') {inv.wood-=10;inv.iron_ingot-=3;inv.siege_ram=(inv.siege_ram||0)+1;addFloater(player.x,player.y-20,'Siege Ram crafted!');}
  if(id==='torch') {inv.wood-=1;inv.hide-=1;gainPlaceable('torch',3);}
  if(id==='hearth') {inv.stone-=8;inv.wood-=4;gainPlaceable('hearth');}
  if(id==='anvil') {inv.iron_ingot-=5;gainPlaceable('anvil');}
  if(id==='lantern') {inv.iron_ingot-=2;inv.hide-=1;gainPlaceable('lantern');}
}
// Craft a placeable into the pack. Selecting it on the hotbar puts it in hand;
// right-click then places it.
function gainPlaceable(type, n=1){
  const def=PLACEABLES[type]; if(!def) return;
  inv[def.invKey]=(inv[def.invKey]||0)+n;
  addFloater(player.x,player.y-20,'+'+n+' '+def.label.toLowerCase()+(n>1?'s':'')+' — select it to place');
}

// ── Combat ────────────────────────────────────────────────────────
function angleDiff(a,b){let d=Math.abs(a-b)%(Math.PI*2);return d>Math.PI?Math.PI*2-d:d;}
function depleteNode(tx,ty,tt,cx,cy){
  hitFlash[tx+','+ty]=0.18;
  // Pickaxe tier scales mining speed: wood 1× · iron 2× · steel 3× · mithril 4× · runic 5×.
  // Yield scales with it too — a node holds the same total ore, you just pull it
  // out in fewer swings. (Scaling only the node damage would make better picks
  // strictly worse, since ore is granted per swing.)
  const isOre = (tt===T.STONE||tt===T.ORE_IRON);
  const dmgAmt = isOre ? Math.max(1, Math.min(5, player.pickaxeTier||1)) : 1;
  // Ore still yields per swing; trees give nothing until the whole thing falls.
  if(tt===T.STONE){
    inv.stone+=dmgAmt; for(let i=0;i<dmgAmt;i++)questEvent('stone'); addFloater(cx,cy-12,'+'+dmgAmt+' stone');
  } else if(tt===T.ORE_IRON){
    inv.iron_ore=(inv.iron_ore||0)+dmgAmt; addFloater(cx,cy-12,'+'+dmgAmt+' iron ore');
  }
  resourceHp[ty][tx]-=dmgAmt;
  const felled = resourceHp[ty][tx]<=0;
  if(tt===T.TREE){
    if(!felled){ addFloater(cx,cy-12,'🪓'); }         // chips fly; the log comes when it falls
    else {
      inv.wood+=TREE_WOOD; for(let w=0;w<TREE_WOOD;w++) questEvent('wood');
      addFloater(cx,cy-18,'🌲 TIMBER!  +'+TREE_WOOD+' wood');
      spawnFallingTree(tx,ty);
    }
  }
  if(felled){
    if(origTile[ty][tx]===T.TREE||origTile[ty][tx]===T.STONE||origTile[ty][tx]===T.ORE_IRON){
      const delay=tt===T.TREE?RESPAWN_TREE:tt===T.STONE?RESPAWN_STONE:RESPAWN_IRON;
      respawnAt[ty][tx]={time:G.gameTime+delay,tile:tt,hp:tt===T.TREE?TREE_HP:tt===T.STONE?STONE_HP:IRON_HP};
      pendingRespawns.add(tx+','+ty);
    }
    map[ty][tx]=T.GRASS;resourceHp[ty][tx]=0;
  }
  bakeStaticTile(tx,ty);minimapUpdateTile(tx,ty);
}
// ── Weapon tiers & specials ───────────────────────────────────────
// Tiers multiply skill damage: wooden ×1, iron ×1.3, steel ×1.6.
// Iron is sold by the blacksmith; steel is tribute from champion bosses.
// Tier 4 = mithril (+100%), tier 5 = runic (+150%) — these MUST stay in sync
// with the crafting recipes / blacksmith shop, which set swordTier/bowTier up
// to 5. A short array here silently yields NaN damage on endgame weapons.
const TIER_NAMES=['','wooden','iron','steel','mithril','runic'];
const TIER_MULT=[0,1,1.3,1.6,2.0,2.5];
function swordTier(){return player.swordTier||1;}
function bowTier(){return player.bowTier||1;}
// Aggregated affix + socketed-gem bonuses from equipped ARPG gear.
// Recomputed on equip/socket rather than per-hit (see refreshEquipStats).
let _eqStats=getEquipmentStats(player);
function refreshEquipStats(){ _eqStats=getEquipmentStats(player); recomputeDerivedStats(); }
function eqStat(k){ return _eqStats[k]||0; }
// Flat weapon damage from the equipped ARPG weapon's base roll.
function eqWeaponDmg(){ const w=player.equippedItems&&player.equippedItems.weapon; return (w&&w.baseStat&&w.baseStat.dmg)||0; }
function meleeDmg(){
  const raceData = RACES[player.race] || RACES.Human;
  const str = (player.stats?.str || 10) + (raceData.bonus.str || 0) + eqStat('str');
  const strMult = 1 + (str - 10) * 0.03 + (player.race === 'Gargoyle' ? 0.10 : 0);
  const gear = 1 + eqStat('allDmg')/100;
  const tLv = tacticsLv();
  const weaponmaster = tLv >= 10 ? 1.25 : 1.0;
  return Math.round((TACTICS_DMG[tLv-1]+eqWeaponDmg())*TIER_MULT[swordTier()]*strMult*gear*weaponmaster*(1+artifactBonus('swordDmg')+artifactBonus('allDmg')));
}
function arrowDmg(){
  const raceData = RACES[player.race] || RACES.Human;
  const dex = (player.stats?.dex || 10) + (raceData.bonus.dex || 0) + eqStat('dex');
  const dexMult = 1 + (dex - 10) * 0.03 + (player.race === 'Centaur' ? 0.10 : 0);
  const gear = 1 + eqStat('allDmg')/100;
  const aLv = archeryLv();
  return Math.round((ARCHERY_DMG[aLv-1]+eqWeaponDmg())*TIER_MULT[bowTier()]*dexMult*gear*(1+artifactBonus('arrowDmg')+artifactBonus('allDmg')));
}
// Skill-gated special attacks on SPACE, 8s shared cooldown (4s at Tactics 9):
//   sword + Tactics 2 → Power Strike (Whirlwind at Tactics 4, Whirlwind Mastery at Tactics 9)
//   bow + Archery 2 → Multishot: 3-arrow fan (5 arrows at Archery 4)
let specialCd=0, aggroBtnRect=null;
function doSpecial(){
  if(player.dead||player.ghost||player.isRat||G.editorOpen) return;
  if(specialCd>0){addFloater(player.x,player.y-30,'special ready in '+Math.ceil(specialCd)+'s');return;}
  if(player.weapon==='sword'&&player.hasSword){
    const lv=tacticsLv();
    if(lv<2){addFloater(player.x,player.y-30,'Power Strike unlocks at Tactics 2');return;}
    const dmg=Math.round(meleeDmg()*(1.6+0.3*(lv-2)));
    let hits=0;
    const reachMult = lv >= 9 ? 2.2 : 1.4;
    for(const e of enemies){
      if(e.state==='dead'||e.state==='respawning')continue;
      if(Math.hypot(e.x-player.x,e.y-player.y)>SWORD_RANGE*reachMult)continue;
      damageEnemy(e,dmg);addSkillXp(skills.tactics,10);hits++;
    }
    swordSwing.active=true;swordSwing.angle=Math.atan2(worldMouseY-player.y,worldMouseX-player.x);swordSwing.lifetime=swordSwing.duration;
    G.swingTimer=0.5;snd.swing();snd.hit();
    addFloater(player.x,player.y-36,(lv>=9?'🌀 WHIRLWIND MASTERY!':lv>=4?'⚔ WHIRLWIND!':'⚔ POWER STRIKE!')+(hits?' ×'+hits:' (no targets)'));
    specialCd=lv>=9?4:8;protagSkillCue=1;
  } else if(player.weapon==='bow'&&player.hasBow){
    const lv=archeryLv();
    if(lv<2){addFloater(player.x,player.y-30,'Multishot unlocks at Archery 2');return;}
    const n=lv>=4?5:3;
    if(inv.arrows<n){addFloater(player.x,player.y-30,'need '+n+' arrows');return;}
    inv.arrows-=n;
    const base=Math.atan2(worldMouseY-player.y,worldMouseX-player.x);
    const spdMult = lv >= 7 ? 1.3 : 1.0;
    const spd=(460+60*(bowTier()-1)) * spdMult, spread=0.21;
    const maxRange = TILE*(12+2*bowTier()) * (lv >= 7 ? 1.3 : 1.0);
    const pierceCnt = lv >= 8 ? 3 : (bowTier()>=3?1:0);
    for(let i=0;i<n;i++){
      const ang=base+(i-(n-1)/2)*spread;
      let dmg = arrowDmg();
      if(lv>=6 && Math.random()<0.15) dmg = Math.round(dmg * (lv>=10 ? 2.5 : 1.5));
      projectiles.push({x:player.x,y:player.y,vx:Math.cos(ang)*spd,vy:Math.sin(ang)*spd,
        dist:0,dmg:dmg,pierce:pierceCnt,maxDist:maxRange});
    }
    snd.arrow();snd.arrow();
    addFloater(player.x,player.y-36,'🏹 MULTISHOT ×'+n);
    G.bowCooldown=0.5;specialCd=8;protagSkillCue=2;
  } else addFloater(player.x,player.y-30,'equip sword or bow (Q) for specials');
}
// ── Armor slots (paper doll) ──────────────────────────────────────
// Four slots, each holding a material tier. Damage reduction stacks
// per piece: leather 3% · bone 5% · bronze 7% · steel 10% (full steel
// set = 40%). Pieces auto-equip into the weakest upgradeable slot.
const ARMOR_SLOTS=['head','chest','legs','boots'];
// Mats 5/6 = mithril/runic. Kept in sync with the mithril_arm / runic_arm
// recipes and the blacksmith's apiece entries, which call equipArmorPiece(5|6).
const ARMOR_MATS=['—','leather','bone','bronze','steel','mithril','runic'];
const ARMOR_DR=[0,0.03,0.05,0.07,0.10,0.14,0.18];
const ARMOR_COLS=['#3a3630','#8a6a4a','#d8ccb8','#b0824a','#9fb6c4','#40e0ff','#df80ff'];
if(!player.armor)player.armor={head:0,chest:0,legs:0,boots:0};
if(inv.bone===undefined)inv.bone=0;
function armorDR(){let d=0;for(const sl of ARMOR_SLOTS)d+=ARMOR_DR[player.armor[sl]||0];return d;}
hooks.playerDR=armorDR;
function hasUpgradeSlot(mat){return ARMOR_SLOTS.some(sl=>(player.armor[sl]||0)<mat);}
function equipArmorPiece(mat){
  let pick=null;
  for(const sl of ARMOR_SLOTS)if(!(player.armor[sl]||0)){pick=sl;break;}          // empty first
  if(!pick){let low=99;for(const sl of ARMOR_SLOTS){const v=player.armor[sl]||0;if(v<mat&&v<low){low=v;pick=sl;}}}
  if(!pick)return false;
  player.armor[pick]=mat;
  updateArmorVisuals();
  addFloater(player.x,player.y-30,ARMOR_MATS[mat]+' '+pick+' equipped!  ('+Math.round(armorDR()*100)+'% armor)');
  snd.craft();
  return true;
}

// ── Artifacts ───────────────────────────────────────────────────────
// 12 relic-tier trinkets (T1/T2/T3) worn in 5 jewelry slots on the
// paper doll: 1 neck, 2 rings, 2 bracelets. Stat values are tuned for
// multi-equip (~60% of the old single-slot numbers). Bosses/champions
// drop relics (currency) and a chance at an unidentified artifact; the
// Antiquarian/Cryptologist/Curator/Grave Robber NPCs below turn those
// into a full economy around them.
const BASE_MAX_HP=100;
const ARTIFACT_SLOTS=['neck','ring1','ring2','brac1','brac2'];
const ARTIFACT_SLOT_TYPE={neck:'neck',ring1:'ring',ring2:'ring',brac1:'brac',brac2:'brac'};
const ARTIFACT_SLOT_LABEL={neck:'Neck',ring1:'Ring',ring2:'Ring',brac1:'Bracelet',brac2:'Bracelet'};
const ARTIFACT_DEFS=[
  {id:'worn_pendant',   name:'Worn Pendant',        tier:1, slot:'neck', icon:'📿', stats:{maxHp:12},              value:40,  desc:'+12 Max HP'},
  {id:'rusted_ring',    name:'Rusted Ring',         tier:1, slot:'ring', icon:'💍', stats:{swordDmg:0.06},         value:40,  desc:'+6% sword damage'},
  {id:'cracked_charm',  name:'Cracked Bow Charm',   tier:1, slot:'brac', icon:'🏹', stats:{arrowDmg:0.06},         value:40,  desc:'+6% arrow damage'},
  {id:'faded_charm',    name:'Faded Charm',         tier:1, slot:'brac', icon:'🍀', stats:{xpMult:0.06},           value:40,  desc:'+6% skill XP'},
  {id:'silver_locket',  name:'Silver Locket',       tier:2, slot:'neck', icon:'📿', stats:{maxHp:30},              value:150, desc:'+30 Max HP'},
  {id:'knights_signet', name:"Knight's Signet",     tier:2, slot:'ring', icon:'💍', stats:{swordDmg:0.12},         value:150, desc:'+12% sword damage'},
  {id:'hawks_talisman', name:"Hawk's Eye Talisman", tier:2, slot:'brac', icon:'🏹', stats:{arrowDmg:0.12},         value:150, desc:'+12% arrow damage'},
  {id:'sage_medallion', name:"Sage's Medallion",    tier:2, slot:'neck', icon:'🍀', stats:{xpMult:0.15},           value:150, desc:'+15% skill XP'},
  {id:'titans_heart',   name:"Titan's Heart",       tier:3, slot:'neck', icon:'❤', stats:{maxHp:70},               value:400, desc:'+70 Max HP'},
  {id:'berserkers_fang',name:"Berserker's Fang",    tier:3, slot:'brac', icon:'⚔', stats:{allDmg:0.15},            value:400, desc:'+15% all damage'},
  {id:'phoenix_down',   name:'Phoenix Down',        tier:3, slot:'brac', icon:'☥', stats:{autoRevive:1},           value:400, desc:'Revives you once at 30% HP, then crumbles to dust'},
  {id:'crown_of_kings', name:'Crown of Kings',      tier:3, slot:'ring', icon:'👑', stats:{allDmg:0.09,xpMult:0.09},value:400, desc:'+9% all damage, +9% skill XP'},
];
function artifactDef(id){return ARTIFACT_DEFS.find(d=>d.id===id);}
function artifactsOfTier(tier){return ARTIFACT_DEFS.filter(d=>d.tier===tier);}
function artifactBonus(key){return (player.artifactBonus&&player.artifactBonus[key])||0;}
function recomputeArtifactBonus(){
  const b={};
  for(const sk of ARTIFACT_SLOTS){
    const def=player.equippedArtifacts[sk]&&artifactDef(player.equippedArtifacts[sk]);
    if(def)for(const[k,v]of Object.entries(def.stats))b[k]=(b[k]||0)+v;
  }
  player.artifactBonus=b;
  player.maxHp=BASE_MAX_HP+(b.maxHp||0);
  if(player.hp>player.maxHp)player.hp=player.maxHp;
}
hooks.playerAutoRevive=()=>{
  const hLv = healingLv();
  if(hLv>=4 && inv.bandages>0 && !(player.deathWardCd>0)){
    inv.bandages-=1;
    player.deathWardCd=hLv>=10 ? 45 : 180;
    player.hp=hLv>=10 ? 60 : 40;
    if(hLv>=10) player.iframes = 3.0;
    addFloater(player.x,player.y-40,(hLv>=10?'✨ DIVINE GRACE! Death Warded!':'🩹 Death Warded! — you live!'));
    snd.heal();
    return true;
  }
  if(!artifactBonus('autoRevive'))return false;
  for(const sk of ARTIFACT_SLOTS){                      // consume the revive artifact
    const def=player.equippedArtifacts[sk]&&artifactDef(player.equippedArtifacts[sk]);
    if(def&&def.stats.autoRevive){player.equippedArtifacts[sk]=null;break;}
  }
  recomputeArtifactBonus();
  player.hp=Math.round(player.maxHp*0.3);
  addFloater(player.x,player.y-40,'☥ the Phoenix Down crumbles to dust — you live!');
  snd.heal();
  return true;
};
// Equip inventory item idx. Prefers slotKey if given; else first empty
// matching slot; else swaps with the first matching slot.
function equipArtifact(idx,slotKey){
  const item=player.artifactInv[idx];
  if(!item||!item.identified)return;
  const def=artifactDef(item.defId);if(!def)return;
  const matching=ARTIFACT_SLOTS.filter(sk=>ARTIFACT_SLOT_TYPE[sk]===def.slot);
  let target=slotKey&&matching.includes(slotKey)?slotKey:null;
  if(!target)target=matching.find(sk=>!player.equippedArtifacts[sk])||matching[0];
  player.artifactInv.splice(idx,1);
  if(player.equippedArtifacts[target])player.artifactInv.push({defId:player.equippedArtifacts[target],identified:true});
  player.equippedArtifacts[target]=item.defId;
  recomputeArtifactBonus();
  addFloater(player.x,player.y-30,def.name+' equipped!');
  snd.craft();
}
function unequipArtifact(slotKey){
  if(!player.equippedArtifacts[slotKey])return;
  player.artifactInv.push({defId:player.equippedArtifacts[slotKey],identified:true});
  player.equippedArtifacts[slotKey]=null;
  recomputeArtifactBonus();
  addFloater(player.x,player.y-30,'artifact unequipped');
}

// AGGRO MODE — UO-style war mode. On: you automatically attack any
// living enemy that comes into reach (superset of auto-defend).
function toggleAggro(){
  G.aggroMode=!G.aggroMode;
  addFloater(player.x,player.y-30,G.aggroMode?'⚔ AGGRO MODE — attacking anything in reach':'aggro mode off — defend only');
  snd.swing();
}

const TREE_REACH = TILE*2;   // axe reach for trees: 2 tiles
function harvestNode(wx,wy,sx,sy){
  if(G.swingTimer>0) return;
  let tx,ty,tt;
  const picked = (sx!=null) ? pickTreeTile(sx,sy) : null;
  if(picked){ tx=picked.tx; ty=picked.ty; tt=T.TREE; }
  else {
    tx=Math.floor(wx/TILE); ty=Math.floor(wy/TILE);
    if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return;
    tt=map[ty][tx];
  }
  if(tt!==T.TREE&&tt!==T.STONE&&tt!==T.ORE_IRON) return;
  const cx=tx*TILE+TILE/2,cy=ty*TILE+TILE/2;
  const reach = tt===T.TREE ? TREE_REACH : HARVEST_RANGE;
  if(Math.hypot(cx-player.x,cy-player.y)>reach) return;
  if(tt===T.TREE&&player.weapon!=='axe'&&player.weapon!=='sword'){addFloater(cx,cy-12,'equip axe!');G.swingTimer=0.28;return;}
  if(tt===T.STONE&&player.weapon!=='pickaxe'&&player.weapon!=='sword'){addFloater(cx,cy-12,'equip pickaxe!');G.swingTimer=0.28;return;}
  if(tt===T.ORE_IRON&&player.weapon!=='pickaxe'){addFloater(cx,cy-12,'equip pickaxe!');G.swingTimer=0.28;return;}
  if(tt===T.TREE) snd.axe(); else snd.hit();
  G.swingTimer=0.28;depleteNode(tx,ty,tt,cx,cy);
}
function swordSwingAttack(wx,wy,sx,sy){
  if(G.swingTimer>0) return;
  G.swingTimer=0.5;snd.swing();
  const lv=tacticsLv(),swingArc=SWORD_ARC*(1+(lv-1)*(lv>=7?0.25:0.12));
  const rangeMult = lv >= 7 ? 1.25 : 1.0;
  swordSwing.active=true;swordSwing.angle=Math.atan2(wy-player.y,wx-player.x);swordSwing.lifetime=swordSwing.duration;
  let isAmbush = false;
  if(skills.hiding.active && hidingLv()>=7){
    isAmbush = true;
    skills.hiding.active = false;
    skills.hiding.cooldown = hidingLv()>=8 ? 10 : 15;
    addFloater(player.x,player.y-30,'💥 AMBUSH CRIT!');
  }
  for(const e of enemies){
    if(e.state==='dead'||e.state==='respawning') continue;
    const edx=e.x-player.x,edy=e.y-player.y;
    if(Math.hypot(edx,edy)>SWORD_RANGE*rangeMult) continue;
    if(angleDiff(Math.atan2(edy,edx),swordSwing.angle)>swingArc/2) continue;
    let dmg = meleeDmg();
    if(isAmbush) dmg = Math.round(dmg * 2.0);
    if(lv>=6 && Math.random()<0.10) dmg = Math.round(dmg * 1.5);
    if(lv>=8 && e.hp / (e.maxHp||1) < 0.3) dmg = Math.round(dmg * 1.5);
    damageEnemy(e,dmg);addSkillXp(skills.tactics,8);
  }
  // PvP: remote players caught in the swing arc — the server referees the hit
  for(const [rid,st] of net.remotes){
    if(st.dead||st.ghost) continue;
    const rdx=st.x-player.x,rdy=st.y-player.y;
    if(Math.hypot(rdx,rdy)>SWORD_RANGE*1.15) continue;
    if(angleDiff(Math.atan2(rdy,rdx),swordSwing.angle)>swingArc/2) continue;
    netPvp(rid,'sword');
  }
  // harvest a tree the pointer is over (canopy included), else the ground tile
  let htx,hty,htt=null;
  const picked=(sx!=null)?pickTreeTile(sx,sy):null;
  if(picked){htx=picked.tx;hty=picked.ty;htt=T.TREE;}
  else{htx=Math.floor(wx/TILE);hty=Math.floor(wy/TILE);
       if(htx>=0&&hty>=0&&htx<MAP_W&&hty<MAP_H)htt=map[hty][htx];}
  if(htt===T.TREE||htt===T.STONE||htt===T.ORE_IRON){
    const cx=htx*TILE+TILE/2,cy=hty*TILE+TILE/2;
    const reach=htt===T.TREE?TREE_REACH:HARVEST_RANGE;
    if(Math.hypot(cx-player.x,cy-player.y)<=reach){
      if(htt===T.ORE_IRON&&player.weapon!=='pickaxe'){
        addFloater(cx,cy-12,'equip pickaxe!');
      } else {
        depleteNode(htx,hty,htt,cx,cy);
      }
    }
  }
}
function fireArrow(wx,wy){
  if(G.bowCooldown>0||inv.arrows<=0||player.dead) return;
  const aLv = archeryLv();
  inv.arrows-=1;
  const cdMult = aLv >= 9 ? 0.6 : 1.0;
  G.bowCooldown=(0.8-0.1*(bowTier()-1)) * cdMult;snd.arrow();
  let isAmbush = false;
  if(skills.hiding.active && hidingLv()>=7){
    isAmbush = true;
    skills.hiding.active = false;
    skills.hiding.cooldown = hidingLv()>=8 ? 10 : 15;
    addFloater(player.x,player.y-30,'💥 AMBUSH CRIT!');
  }
  const ang=Math.atan2(wy-player.y,wx-player.x);
  const spdMult = aLv >= 7 ? 1.3 : 1.0;
  const spd=(460+60*(bowTier()-1)) * spdMult;
  let dmg = arrowDmg();
  if(isAmbush) dmg = Math.round(dmg * 2.0);
  if(aLv>=6 && Math.random()<0.15) dmg = Math.round(dmg * (aLv>=10 ? 2.5 : 1.5));
  const maxRange = TILE*(12+2*bowTier()) * (aLv >= 7 ? 1.3 : 1.0);
  const pierceCnt = aLv >= 8 ? 3 : (bowTier()>=3?1:0);
  projectiles.push({x:player.x,y:player.y,vx:Math.cos(ang)*spd,vy:Math.sin(ang)*spd,
    dist:0,dmg:dmg,pierce:pierceCnt,maxDist:maxRange});
}
function doAttack(wx,wy,sx,sy){
  if(player.dead) return;
  if(skills.hiding.active){
    skills.hiding.active=false;
    skills.hiding.cooldown=30;
    addFloater(player.x,player.y-30,'stealth broken (action)');
  }
  if(!inCity()){
    const doorHouseIdx = getHouseDoorAt(wx, wy);
    if(doorHouseIdx !== -1) {
      const h = G.placedHouses[doorHouseIdx];
      const myName = playerName();
      const isLocked = net.status === 'online' && h.owner && h.owner !== myName && !h.isPublic && !(h.friends||[]).includes(myName);
      if(isLocked) {
        const d = houseDoorTile(h);
        const dcx = d.tx * TILE + TILE/2;
        const dcy = d.ty * TILE + TILE/2;
        if(Math.hypot(dcx - player.x, dcy - player.y) < TILE * 2.8) {
          attackStructure('door', doorHouseIdx, dcx, dcy);
          return;
        }
      }
    }
    const targetChest = placedObjects.find(o => o.type === 'secure_chest' && Math.hypot(o.x - wx, o.y - wy) < TILE * 1.1);
    if(targetChest) {
      const myName = playerName();
      const tx = Math.floor(targetChest.x/TILE), ty = Math.floor(targetChest.y/TILE);
      const h = getHouseContaining(tx, ty);
      const isLocked = net.status === 'online' && targetChest.owner && targetChest.owner !== myName && !(h && (h.owner === myName || (h.friends||[]).includes(myName)));
      if(isLocked) {
        if(Math.hypot(targetChest.x - player.x, targetChest.y - player.y) < TILE * 2.8) {
          attackStructure('chest', targetChest, targetChest.x, targetChest.y);
          return;
        }
      }
    }
  }
  if(player.isRat){if(G.swingTimer>0)return;G.swingTimer=0.4;snd.swing();for(const e of enemies){if(e.state==='dead'||e.state==='respawning')continue;if(Math.hypot(e.x-player.x,e.y-player.y)<TILE*1.1)damageEnemy(e,2);}return;}
  if(player.weapon==='sword'&&player.hasSword)  swordSwingAttack(wx,wy,sx,sy);
  else if(player.weapon==='bow'&&player.hasBow) fireArrow(wx,wy);
  else {
    // no combat weapon equipped (axe/pickaxe/none): if a mob is in reach,
    // auto-wrestle it so new players can always fight; else harvest as normal
    if(skills.wrestling.cooldown<=0 && nearestEnemy(TILE*2.2)) { doWrestling(); return; }
    harvestNode(wx,wy,sx,sy);
  }
}
function getHouseContaining(tx, ty) {
  if (!G.placedHouses) return null;
  for (const h of G.placedHouses) {
    if (tx >= h.x0 && tx < h.x0 + h.size && ty >= h.y0 && ty < h.y0 + h.size) {
      return h;
    }
  }
  return null;
}
// Owner + friends may build inside a house (offline / unowned houses: anyone)
function canBuildInHouse(h){
  if(!h) return false;
  if(net.status!=='online'||!h.owner) return true;
  const myName=playerName();
  return h.owner===myName||(h.friends||[]).includes(myName);
}
// Why this tile won't take `type`, or null if it will. One rule set, shared by
// build mode and right-click — they used to disagree, which is how torches ended
// up placeable on path while a workbench wasn't.
// Where an object actually ends up on this tile. Ground placements sit at the
// tile centre; a wall mount sits on the face nearest the player, just proud of
// the stone. Face is chosen from the player's position rather than from where
// the click landed — the click ray hits the ground plane, not the wall, so the
// clicked point can't distinguish faces anyway.
const WALL_GAP = 2.5;      // how far proud of the stone the bracket sits
function placementSpot(type, tx, ty, hit){
  const cx=tx*TILE+TILE/2, cy=ty*TILE+TILE/2;
  const def=PLACEABLES[type];
  if(!def || !_isFullCover(map[ty]?.[tx])) return {x:cx, y:cy, face:null, mountY:0};
  // Face from the clicked point when we have one (you get the face you aimed at),
  // otherwise from where the player stands.
  const rx = hit ? hit.x-cx : player.x-cx;
  const ry = hit ? hit.z-cy : player.y-cy;
  const face = Math.abs(rx)>Math.abs(ry) ? (rx>0?'e':'w') : (ry>0?'s':'n');
  const [ox,oy]=FACE_DIR[face];
  // Sit on the actual surface of THIS block, not on a nominal half-tile.
  const s = wallSurfaceOffset(tx, ty, ox!==0 ? 'x' : 'z');
  const out = s.ext + WALL_GAP;
  return { x: cx + (ox!==0 ? s.jit + ox*out : 0),
           y: cy + (oy!==0 ? s.jit + oy*out : 0),
           face, mountY:(def.wallY||WALL_H*0.6) };
}
function placementBlocker(type, tx, ty, hit){
  const def=PLACEABLES[type];
  if(!def) return 'unknown item';
  if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return 'off the map';
  const t=map[ty][tx], house=getHouseContaining(tx,ty);
  if(house&&!canBuildInHouse(house)) return 'owner or friends only!';
  if(_isFullCover(t)){
    if(!def.surfaces.includes('wall')) return 'cannot mount that on a wall';
  } else if(def.surfaces.includes('house')){
    if(!house||t!==T.PATH) return 'must place inside a house';
  } else if(!PLACE_GROUND.has(t)) return 'cannot place there';
  const m=placementSpot(type,tx,ty,hit);
  if(Math.hypot(m.x-player.x,m.y-player.y)>HARVEST_RANGE) return 'too far away';
  // One object per spot. Without this you could stack an unbounded pile on a
  // single tile and pickup could only ever return the first. The half-extent is
  // under half a tile so a wall can still carry one mount per face (opposite
  // faces are ~42u apart, adjacent ones ~21u on each axis).
  if(placedObjects.some(o=>Math.abs(o.x-m.x)<TILE*0.4&&Math.abs(o.y-m.y)<TILE*0.4)) return 'something is already there';
  return null;
}
// Spend one from the pack and put it in the world. The single commit point —
// inventory, world list, net sync and save all happen here or not at all.
function placePlaceable(type, tx, ty, quiet, hit){
  const def=PLACEABLES[type]; if(!def) return false;
  const m=placementSpot(type,tx,ty,hit);
  const why=placementBlocker(type,tx,ty,hit);
  if(why){ if(!quiet) addFloater(m.x,m.y-12,why); return false; }
  if((inv[def.invKey]||0)<=0){ if(!quiet) addFloater(m.x,m.y-12,'no '+def.label.toLowerCase()+' in pack'); return false; }
  inv[def.invKey]--;
  const o={type,x:m.x,y:m.y};
  if(def.burn) o.litAt=worldNow();                       // fuel is derived from this
  if(m.face){ o.face=m.face; o.mountY=m.mountY; }        // wall mount
  if(type==='secure_chest'){ o.owner=playerName(); o.items={}; o.hp=150; o.maxHp=150; }
  placedObjects.push(o); placedObjectsDirty=true;
  netObjectPlace(o);
  addFloater(m.x,m.y-12,def.emoji+' '+def.label+(m.face?' mounted':' placed'));
  snd.craft();
  // Quiet: the "placed" floater above is the feedback. A loud save would stack a
  // second "💾 saved!" on top of every single placement.
  if(typeof saveGame==='function')saveGame(true);
  return true;
}
// The placeable currently in hand, or null. Selecting one on the hotbar sets
// player.weapon (ITEM_EQUIP), so "holding it" and "about to place it" are the
// same state — no separate placement mode to get stuck in.
// Which placed object is under the cursor? The old test compared the object's
// world x/y against the click's GROUND-PLANE hit point, which can't work for a
// wall mount 100+ units up — the ray passes through the torch and lands well
// past it. Project each candidate to the screen instead and pick the nearest.
function pickPlacedObject(sx, sy){
  let best=null, bestD=1e9;
  for(const o of placedObjects){
    if(Math.hypot(o.x-player.x, o.y-player.y) > HARVEST_RANGE) continue;
    const def=PLACEABLES[o.type];
    const h = o.face ? o.mountY : (def ? def.y*def.scale : 10);
    const p = worldToScreen(o.x, o.y, h);
    const d = Math.hypot(p.x-sx, p.y-sy);
    if(d < bestD){ bestD=d; best=o; }
  }
  return bestD <= 40 ? best : null;      // generous: these are small props
}
// Expire anything whose fuel has run out. Cheap sweep — the check is arithmetic
// on a timestamp, so this is just "has it crossed the line yet".
function sweepBurnouts(dt){
  _burnClock -= dt;
  if(_burnClock>0) return;
  _burnClock = BURN_SWEEP_SEC;
  let changed=false;
  for(let i=placedObjects.length-1;i>=0;i--){
    const o=placedObjects[i], def=PLACEABLES[o.type];
    if(!def||!def.burn||o.spent) continue;
    if(burnRemaining(o)>0) continue;
    changed=true;
    if(def.burn.spent==='consume'){
      // Gone for good — no pickup, no refund. Every client reaches this
      // independently from the shared clock; the server dedupes the removal.
      placedObjects.splice(i,1);
      netObjectRemove(o.x,o.y);
      addFloater(o.x,o.y-12,def.emoji+' '+def.label.toLowerCase()+' burnt out');
    } else {
      o.spent=true;                       // dark, but still standing
      addFloater(o.x,o.y-12,'🌑 '+def.label.toLowerCase()+' burnt out');
    }
    placedObjectsDirty=true;
  }
  // Only when something actually expired, and quietly — this fires every 2s in
  // the background, so an unconditional loud save spammed "💾 saved!" on the
  // player forever.
  if(changed && typeof saveGame==='function') saveGame(true);
}
// Put a doused object back to work. Returns true if it consumed the fuel.
function relightPlaced(o){
  const def=PLACEABLES[o.type];
  if(!def||!def.burn||!def.burn.relight||!o.spent) return false;
  for(const k in def.burn.relight) if((inv[k]||0)<def.burn.relight[k]){
    addFloater(o.x,o.y-12,'need '+def.burn.relight[k]+' '+k+' to relight');
    return true;                          // handled: don't fall through to pickup
  }
  for(const k in def.burn.relight) inv[k]-=def.burn.relight[k];
  o.spent=false; o.litAt=worldNow();
  placedObjectsDirty=true;
  addFloater(o.x,o.y-12,'🔥 '+def.label.toLowerCase()+' relit');
  snd.craft();
  if(typeof saveGame==='function')saveGame(true);   // "relit" floater is the feedback
  return true;
}
function heldPlaceable(){
  const t=player.weapon;
  return (PLACEABLES[t] && (inv[PLACEABLES[t].invKey]||0)>0) ? t : null;
}
function placeItem(wx,wy){
  const tx=Math.floor(wx/TILE),ty=Math.floor(wy/TILE);
  if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return false;
  if(G.buildItem==='wall'){
    // Walls are map tiles, not placed objects, so they keep their own path.
    const houseHere=getHouseContaining(tx,ty);
    if(houseHere&&!canBuildInHouse(houseHere)){ addFloater(wx,wy-12,'owner or friends only!'); return false; }
    if(map[ty][tx]!==T.GRASS&&!(houseHere&&map[ty][tx]===T.PATH)) return false;
    const cx=tx*TILE+TILE/2,cy=ty*TILE+TILE/2;
    if(Math.hypot(cx-player.x,cy-player.y)>HARVEST_RANGE) return false;
    if(player.x+player.r>tx*TILE&&player.x-player.r<(tx+1)*TILE&&player.y+player.r>ty*TILE&&player.y-player.r<(ty+1)*TILE) return false;
    inv.planks-=1;map[ty][tx]=T.WALL;origTile[ty][tx]=T.WALL;respawnAt[ty][tx]=null;
    playerPlacedWalls[ty][tx]=true;bakeStaticTile(tx,ty);minimapUpdateTile(tx,ty);
    questEvent('wall');
    addFloater(cx,cy-12,'wall placed');G.buildMode=inv.planks>0;
    if(typeof saveGame==='function')saveGame();
    return true;
  }
  if(!placePlaceable(G.buildItem,tx,ty)) return false;
  G.buildMode=(inv[PLACEABLES[G.buildItem].invKey]||0)>0;   // keep going while you hold more
  return true;
}

// Send the whole object, not just type/x/y — a wall mount's `face` has to
// survive the wire or it comes back from the server lying flat on the floor.
// (The server whitelists what it stores; see bravo-room.js object_place.)
function netObjectPlace(o) {
  if (net.status === 'online' && net.room) {
    net.room.send('object_place', { type:o.type, x:o.x, y:o.y, face:o.face||null, litAt:o.litAt||0 });
  }
}
function netObjectRemove(x, y) {
  if (net.status === 'online' && net.room) {
    net.room.send('object_remove', { x, y });
  }
}
function removePlacedObject(obj, returnItem = true) {
  const idx = placedObjects.indexOf(obj);
  if (idx !== -1) {
    placedObjects.splice(idx, 1);
    placedObjectsDirty = true;
  }
  netObjectRemove(obj.x, obj.y);
  if (returnItem) {
    // You get the object back, not its materials — so place/remove is lossless
    // but can't be cycled for a crafting profit. Workbench/forge/chest/hearth/
    // anvil previously fell through to a bare floater and were destroyed.
    const def = PLACEABLES[obj.type];
    if (def) {
      inv[def.invKey] = (inv[def.invKey] || 0) + 1;
      addFloater(obj.x, obj.y - 12, def.emoji + ' ' + def.label + ' picked up');
    } else if (obj.type === 'plank') { inv.planks = (inv.planks || 0) + 1; addFloater(obj.x, obj.y - 12, '+1 plank'); }
    else { addFloater(obj.x, obj.y - 12, '📦 ' + (obj.type || 'item') + ' picked up'); }
    snd.pickup();
  }
  if (typeof saveGame === 'function') saveGame(true);   // "picked up" floater is the feedback
}

function attackStructure(type, target, cx, cy) {
  let dmg = 0;
  if (player.weapon === 'siege_ram') dmg = 20;
  else if (player.weapon === 'axe') dmg = 2;
  else if (player.weapon === 'pickaxe') dmg = 2;
  else if (player.weapon === 'sword') dmg = 1;
  if (dmg <= 0) {
    addFloater(player.x, player.y - 30, 'requires structural weapon!');
    snd.hurt();
    return;
  }
  snd.swing();
  if (type === 'door') {
    const h = G.placedHouses[target];
    if (!h) return;
    h.doorHp = h.doorHp === undefined ? 200 : h.doorHp;
    h.doorHp = Math.max(0, h.doorHp - dmg);
    if (h.doorHp <= 0) {
      h.doorHp = 0;
      h.doorOpen = true;
      addFloater(cx, cy - 16, '💥 DOOR BREACHED!');
      netHouseUpdate(target, { doorHp: 0, doorOpen: true });
    } else {
      addFloater(cx, cy - 16, `🚪 Door HP: ${h.doorHp}/200`);
      netHouseUpdate(target, { doorHp: h.doorHp });
    }
  } else if (type === 'chest') {
    const chest = target;
    chest.hp = chest.hp === undefined ? 150 : chest.hp;
    chest.hp = Math.max(0, chest.hp - dmg);
    if (chest.hp <= 0) {
      chest.hp = 0;
      addFloater(cx, cy - 16, '💥 CHEST DESTROYED!');
      destroyChest(chest);
    } else {
      addFloater(cx, cy - 16, `🧳 Chest HP: ${chest.hp}/150`);
    }
  } else if (type === 'object' || (target && target.type)) {
    const obj = target;
    obj.hp = obj.hp === undefined ? 30 : obj.hp;
    obj.hp = Math.max(0, obj.hp - dmg);
    if (obj.hp <= 0) {
      addFloater(cx, cy - 16, '💥 ' + (obj.type || 'OBJECT').toUpperCase() + ' BROKEN!');
      removePlacedObject(obj, true);
    } else {
      addFloater(cx, cy - 16, `🔨 ${obj.type} HP: ${obj.hp}/30`);
    }
  }
  if (typeof saveGame === 'function') saveGame();
}
function destroyChest(chest) {
  removePlacedObject(chest, false);
  for (const k in chest.items) {
    const n = chest.items[k] || 0;
    if (n <= 0) continue;
    if (net.status === 'online') {
      netDropAdd(k, n);
    } else {
      for (let i = 0; i < Math.min(n, 12); i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 5 + Math.random() * 12;
        drops.push({ type: k, x: chest.x + Math.cos(a) * d, y: chest.y + Math.sin(a) * d, lifetime: 120 });
      }
    }
  }
  snd.craft();
}

// ── Skill actions ─────────────────────────────────────────────────
function useBandage(){
  if(player.dead||inv.bandages<=0||player.bandageTimer>0){addFloater(player.x,player.y-30,inv.bandages<=0?'no bandages!':'already healing!');return;}
  const hLv = healingLv();
  inv.bandages-=1;
  player.bandageTimer = hLv >= 6 ? 2.0 : 3.0;
  addSkillXp(skills.healing,15);
  questEvent('bandage');
  if(hLv >= 7){
    const instantHeal = Math.round(player.maxHp * 0.25);
    player.hp = Math.min(player.maxHp, player.hp + instantHeal);
    addFloater(player.x, player.y-44, '💚 Rejuvenation +'+instantHeal+' HP!');
  }
  addFloater(player.x,player.y-30,'bandaging... +'+HEAL_AMT[hLv-1]+' HP');
  if(hLv>=2 && player.poisonTimer>0){
    player.poisonTimer=0; player.poisonDmg=0; player.poisonTick=0;
    addFloater(player.x,player.y-44,'☠ Poison cleansed!');
  }
  if(hLv>=8){
    player.stunTimer=0; player.webTimer=0;
  }
}
function doHiding(){
  if(player.dead) return;
  const sk=skills.hiding, hLv = hidingLv();
  const cdTime = hLv >= 8 ? 10 : 15;
  if(sk.cooldown>0){addFloater(player.x,player.y-30,'hide cd '+Math.ceil(sk.cooldown)+'s');return;}
  if(sk.active){sk.active=false;sk.cooldown=cdTime;return;}
  sk.active=true;sk.timer=HIDING_DUR[hLv-1];sk.cooldown=0;
  if(hLv >= 10) player._ghostShield = true;
  addFloater(player.x,player.y-30,'hiding... '+HIDING_DUR[hLv-1]+'s');
  if(hLv >= 9){
    let stunned = 0;
    for(const e of enemies){
      if(e.state==='dead'||e.state==='respawning') continue;
      if(Math.hypot(e.x-player.x, e.y-player.y) <= TILE * 2.5){
        e.stunTimer = 1.5;
        stunned++;
      }
    }
    if(stunned > 0) addFloater(player.x, player.y-44, '💨 SMOKE SCREEN! Stunned '+stunned+' foes');
  }
}
function doWrestling(){
  if(player.dead) return;
  const sk=skills.wrestling, wLv = wrestlingLv();
  if(sk.cooldown>0){addFloater(player.x,player.y-30,'wrestle cd '+Math.ceil(sk.cooldown)+'s');return;}
  let target=null,best=TILE*2.5;
  for(const e of enemies){if(e.state==='dead'||e.state==='respawning')continue;const d=Math.hypot(e.x-player.x,e.y-player.y);if(d<best){best=d;target=e;}}
  if(!target){addFloater(player.x,player.y-30,'no target!');return;}
  sk.cooldown = wLv >= 10 ? 6 : 15;
  const stunDur = WRESTLE_STUN[wLv-1] + (wLv >= 7 ? 1.5 : 0);
  const dmg = Math.round(WRESTLE_DMG[wLv-1] * (wLv >= 6 ? 1.25 : 1.0));
  target.stunTimer = stunDur;
  damageEnemy(target, dmg);
  if(wLv >= 2){
    let slamCount=0;
    for(const e of enemies){
      if(e===target||e.state==='dead'||e.state==='respawning')continue;
      if(Math.hypot(e.x-target.x,e.y-target.y)<TILE*2.5){
        e.stunTimer = stunDur;
        damageEnemy(e,Math.round(dmg*0.6));
        slamCount++;
      }
    }
    addFloater(player.x,player.y-30,(wLv>=9?'💥 GROUND SLAM!':'BODY SLAM!')+' Stunned '+(slamCount+1)+' foes');
  } else {
    addFloater(player.x,player.y-30,'GRAPPLE! '+stunDur.toFixed(1)+'s stun');
  }
  addSkillXp(skills.wrestling,20);
}
function usePotion(){
  if(player.dead){return;}
  if(inv.potions<=0){addFloater(player.x,player.y-30,'no potions!');return;}
  const ha=Math.min(player.maxHp-player.hp,50);
  if(ha<=0){addFloater(player.x,player.y-30,'already full HP!');return;}
  inv.potions--;player.hp+=ha;snd.heal();addFloater(player.x,player.y-30,'potion! +'+ha+' HP');
}
// nearest living enemy within range (world units), or null
function nearestEnemy(range){
  let best=range||1e9, tgt=null;
  for(const e of enemies){
    if(e.state==='dead'||e.state==='respawning')continue;
    const d=Math.hypot(e.x-player.x,e.y-player.y);
    if(d<best){best=d;tgt=e;}
  }
  return tgt;
}
function attackNearest(){
  const bowReach=TILE*8, e=nearestEnemy(player.weapon==='bow'?bowReach:SWORD_RANGE*1.1);
  if(e)doAttack(e.x,e.y);
}

// ── Unified combat-action registry ────────────────────────────────
// Both the radial menu and the gambit engine trigger actions by id.
// can(): is the action usable right now (skip in gambits / grey in wheel).
const COMBAT_ACTIONS={
  attack:  {label:'Attack', icon:'⚔', run:attackNearest, can:()=>!!nearestEnemy(player.weapon==='bow'?TILE*8:SWORD_RANGE*1.1)},
  special: {label:'Special',icon:'⚡', run:doSpecial,     can:()=>specialCd<=0&&((player.weapon==='sword'&&player.hasSword&&tacticsLv()>=2)||(player.weapon==='bow'&&player.hasBow&&archeryLv()>=2))},
  potion:  {label:'Potion', icon:'🧪', run:usePotion,     can:()=>inv.potions>0&&player.hp<player.maxHp},
  bandage: {label:'Bandage',icon:'✚', run:useBandage,    can:()=>inv.bandages>0&&player.bandageTimer<=0&&player.hp<player.maxHp},
  hide:    {label:'Hide',   icon:'👤', run:doHiding,      can:()=>!skills.hiding.active&&skills.hiding.cooldown<=0},
  wrestle: {label:'Wrestle',icon:'🤼', run:doWrestling,   can:()=>skills.wrestling.cooldown<=0&&!!nearestEnemy(TILE*2.5)},
  warmode: {label:'War Mode',icon:'🛡', run:()=>{if(!G.aggroMode)toggleAggro();}, can:()=>!G.aggroMode},
  swapweap:{label:'Swap',   icon:'🔁', run:toggleWeapon,  can:()=>true},
};

// ── GUI artwork ─────────────────────────────────────────────────────
// Source art lives in "Images for GUI/"; img/gui/*.webp are the half-res
// web builds (ffmpeg). All rects below are frame interiors measured by
// pixel analysis in 1408×768 space — rescale before editing them.
const GUI={};
// bump the ?v= when replacing an image — Cloudflare caches these for 30 days
for(const[k,src]of Object.entries({dollM:'img/gui/doll_male.webp',dollF:'img/gui/doll_female.webp',pack:'img/gui/backpack.webp?v=2',icons1:'img/gui/icons1.webp',icons2:'img/gui/icons2.webp'})){
  const img=new Image();GUI[k]={img,ok:false};img.onload=()=>{GUI[k].ok=true;};img.src=src;
}
// sprite atlas: name -> [sheet, x, y, w, h]
const SPR={
  dagger:['icons1',69,52,138,141], pickaxe:['icons1',295,52,138,141], shovel:['icons1',522,52,138,141],
  axe:['icons1',750,52,138,141], sword:['icons1',978,52,138,141], axe_magic:['icons1',1205,52,138,141],
  halberd:['icons1',69,232,138,138], potion:['icons1',295,232,138,138], bandage:['icons1',522,232,138,138],
  portal:['icons1',750,232,138,138], sigil:['icons1',522,409,138,138], fireball:['icons1',750,409,138,138],
  heal:['icons1',978,409,138,138], rogue:['icons1',1205,409,138,138],
  flask:['icons1',69,588,138,137], house:['icons1',295,588,138,137], flask2:['icons1',522,588,138,137],
  torch:['icons1',750,588,138,137], vial:['icons1',978,588,138,137], key:['icons1',1205,588,138,137],
  bow:['icons2',906,52,139,141], shield:['icons2',1061,52,141,141], crossbow:['icons2',1204,52,138,141],
  potion_red:['icons2',750,206,138,119], potion_blue:['icons2',906,206,139,119],
  potion_green:['icons2',1061,206,141,119], potion_yellow:['icons2',1204,206,138,119],
  lightning:['icons2',750,330,138,110], crystals:['icons2',906,330,139,110],
  orb:['icons2',1061,330,141,110], scroll:['icons2',1204,330,138,110],
  mortar:['icons2',750,445,138,111], magnify:['icons2',906,445,139,111],
  anvil:['icons2',1061,445,141,111], tongs:['icons2',1204,445,138,111],
  chest:['icons2',69,590,138,134], medallion:['icons2',295,590,138,134], hidepile:['icons2',522,590,138,134],
  tent:['icons2',750,590,138,134], rope:['icons2',906,590,139,134], trap:['icons2',1061,590,141,134],
  compass:['icons2',1204,590,138,134],
};
// draw a named sprite; false if its sheet hasn't loaded (caller draws emoji instead)
function drawSprite(name,dx,dy,dw,dh,alpha=1){
  const s=SPR[name];if(!s)return false;
  const g=GUI[s[0]];if(!g.ok)return false;
  const sc=g.img.width/1408, IN=7*sc;                    // inset past the metal frame
  const ctx=G.ctx;
  if(alpha!==1){ctx.save();ctx.globalAlpha=alpha;}
  ctx.drawImage(g.img,s[1]*sc+IN,s[2]*sc+IN,s[3]*sc-IN*2,s[4]*sc-IN*2,dx,dy,dw,dh);
  if(alpha!==1)ctx.restore();
  return true;
}
const WEAPON_SPR={axe:'axe',pickaxe:'pickaxe',sword:'sword',bow:'bow',house_tool:'house'};
const ACTION_SPR={attack:'dagger',special:'lightning',potion:'potion_red',bandage:'bandage',hide:'rogue',warmode:'shield'};

// ── Hotbar ─────────────────────────────────────────────────────────
// 8 slots, bottom-center. A slot holds a weapon, a combat action, or a
// macro (an ordered chain of combat actions, UOSteam-style). Wheel or
// D-pad-style cycling selects; number keys / clicks / Z fire. Built
// controller-ready: cycle+fire semantics map 1:1 onto a gamepad later.
const HOTBAR_SLOTS=8, HOTBAR_SZ=44, HOTBAR_GAP=6;
const HOTBAR_WEAPONS={
  axe:       {label:'Axe',         icon:'🪓', pkey:'hasAxe'},
  pickaxe:   {label:'Pickaxe',     icon:'⛏',  pkey:'hasPickaxe'},
  sword:     {label:'Sword',       icon:'⚔',  pkey:'hasSword'},
  bow:       {label:'Bow',         icon:'🏹', pkey:'hasBow'},
  house_tool:{label:'Housing Tool',icon:'🏠', pkey:'hasHouseTool'},
};
// remaining-cooldown getters per action id → [left, max] for sweep overlays
const HOTBAR_CD={
  special: ()=>[specialCd,8],
  bandage: ()=>[player.bandageTimer,3],
  hide:    ()=>[skills.hiding.cooldown,30],
  wrestle: ()=>[skills.wrestling.cooldown,15],
};
const HOTBAR_BADGE={ potion:()=>inv.potions, bandage:()=>inv.bandages, bow:()=>inv.arrows };
let hotbar=[
  {k:'weapon',id:'axe'},{k:'weapon',id:'sword'},{k:'weapon',id:'bow'},{k:'weapon',id:'pickaxe'},
  {k:'act',id:'bandage'},{k:'act',id:'potion'},{k:'act',id:'special'},null,
];
let macros=[];        // {name, steps:[combatActionIds]}
let macroQueue=null;  // {steps, idx, t} — one macro runs at a time
function hotbarSlotDef(s){
  if(!s)return null;
  if(s.k==='weapon')return HOTBAR_WEAPONS[s.id]||null;
  if(s.k==='act')return COMBAT_ACTIONS[s.id]||null;
  if(s.k==='macro')return macros[s.id]?{label:macros[s.id].name,icon:'📜'}:null;
  if(s.k==='item'){const b=BAG_BY_KEY[s.id];return b?{label:b.lab,icon:b.ic}:null;}
  return null;
}
function hotbarRect(){
  const w=HOTBAR_SLOTS*HOTBAR_SZ+(HOTBAR_SLOTS-1)*HOTBAR_GAP;
  return {x:Math.round(G.canvas.width/2-w/2), y:G.canvas.height-44-16-HOTBAR_SZ-12, w, h:HOTBAR_SZ};
}
function hotbarSlotAt(sx,sy){
  const r=hotbarRect();
  if(sy<r.y-4||sy>r.y+r.h+4)return -1;
  for(let i=0;i<HOTBAR_SLOTS;i++){
    const x=r.x+i*(HOTBAR_SZ+HOTBAR_GAP);
    if(sx>=x&&sx<=x+HOTBAR_SZ)return i;
  }
  return -1;
}
function selectHotbarSlot(i){
  G.hotbarSel=((i%HOTBAR_SLOTS)+HOTBAR_SLOTS)%HOTBAR_SLOTS;
  const s=hotbar[G.hotbarSel];
  // landing on an owned weapon equips it immediately (Valheim-style)
  if(s&&s.k==='weapon'&&player[HOTBAR_WEAPONS[s.id].pkey]&&!player.dead)player.weapon=s.id;
  if(s&&s.k==='item'&&ITEM_EQUIP[s.id]&&(inv[s.id]||0)>0&&!player.dead)player.weapon=s.id;
}
function cycleHotbar(dir){ selectHotbarSlot(G.hotbarSel+dir); }
function fireHotbarSlot(i){
  G.hotbarSel=i;
  const s=hotbar[i];
  if(!s||player.dead||player.ghost||player.isRat||G.editorOpen)return;
  if(s.k==='weapon'){
    const w=HOTBAR_WEAPONS[s.id];
    if(!w)return;
    if(player[w.pkey])player.weapon=s.id;
    else addFloater(player.x,player.y-30,'no '+w.label.toLowerCase()+'!');
  } else if(s.k==='act'){
    const a=COMBAT_ACTIONS[s.id];
    if(!a)return;
    if(a.can())a.run(); else addFloater(player.x,player.y-30,a.label+' not ready');
  } else if(s.k==='macro'){
    const m=macros[s.id];
    if(!m||!m.steps.length)return;
    if(macroQueue){addFloater(player.x,player.y-30,'macro already running');return;}
    macroQueue={steps:[...m.steps],idx:0,t:0};
    addFloater(player.x,player.y-30,'📜 '+m.name);
  } else if(s.k==='item'){
    const b=BAG_BY_KEY[s.id];
    if(!b)return;
    if((inv[s.id]||0)<=0){addFloater(player.x,player.y-30,'no '+b.lab.toLowerCase()+' left!');return;}
    if(ITEM_EQUIP[s.id]){player.weapon=s.id;}
    else if(ITEM_ACT[s.id]){
      const a=COMBAT_ACTIONS[ITEM_ACT[s.id]];
      if(a){ if(a.can())a.run(); else addFloater(player.x,player.y-30,a.label+' not ready'); }
    } else {
      // plain resources: open the pack with the item selected
      G.backpackOpen=true;
      const idx=packItems().findIndex(x=>x.kind==='res'&&x.k===s.id);
      G.packSel=idx>=0?idx:null;
    }
  }
}
// steps fire 0.35s apart; unusable steps are skipped (UOSteam-tolerant)
function runMacroQueue(dt){
  if(!macroQueue)return;
  if(player.dead||player.ghost){macroQueue=null;return;}
  macroQueue.t-=dt;
  if(macroQueue.t>0)return;
  while(macroQueue.idx<macroQueue.steps.length){
    const a=COMBAT_ACTIONS[macroQueue.steps[macroQueue.idx]];
    macroQueue.idx++;
    if(a&&a.can()){a.run();macroQueue.t=0.35;break;}
  }
  if(macroQueue.idx>=macroQueue.steps.length&&macroQueue.t<=0)macroQueue=null;
}
function drawHotbar(){
  const ctx=G.ctx,r=hotbarRect();
  for(let i=0;i<HOTBAR_SLOTS;i++){
    const x=r.x+i*(HOTBAR_SZ+HOTBAR_GAP),s=hotbar[i],sel=i===G.hotbarSel;
    const isEquipped=s&&(s.k==='weapon'||(s.k==='item'&&ITEM_EQUIP[s.id]))&&player.weapon===s.id;
    ctx.fillStyle=isEquipped?'rgba(60,45,18,.92)':'rgba(18,13,8,.85)';
    ctx.fillRect(x,r.y,HOTBAR_SZ,HOTBAR_SZ);
    // slot content
    if(s){
      const def=hotbarSlotDef(s);
      // An unowned binding renders as an EMPTY slot rather than a ghosted icon.
      // Showing a pickaxe you have never found is just clutter that has to be
      // visually filtered every time you glance down. The binding is kept, so the
      // icon reappears on its own the moment you pick one up.
      const owned=!s?false:s.k==='weapon'?!!player[HOTBAR_WEAPONS[s.id].pkey]:s.k==='item'?(inv[s.id]||0)>0:true;
      if(def&&owned){
        const sprName=s.k==='weapon'?WEAPON_SPR[s.id]:s.k==='act'?ACTION_SPR[s.id]:s.k==='item'?(BAG_BY_KEY[s.id]||{}).spr:s.k==='macro'?'scroll':null;
        if(!(sprName&&drawSprite(sprName,x+4,r.y+4,HOTBAR_SZ-8,HOTBAR_SZ-8,1))){
          ctx.font='20px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
          ctx.fillText(def.icon,x+HOTBAR_SZ/2,r.y+HOTBAR_SZ/2+7);
        }
        // count badge (potions / bandages / arrows / bound items)
        const badge=s.k==='item'?()=>inv[s.id]||0:s.k==='act'?HOTBAR_BADGE[s.id]:s.k==='weapon'?HOTBAR_BADGE[s.id]:null;
        if(badge){
          const n=badge();
          ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='right';
          ctx.fillStyle='rgba(0,0,0,.7)';ctx.fillText(n,x+HOTBAR_SZ-3,r.y+HOTBAR_SZ-3);
          ctx.fillStyle=n>0?'#f0d060':'#e06060';ctx.fillText(n,x+HOTBAR_SZ-4,r.y+HOTBAR_SZ-4);
        }
        // cooldown sweep: dark overlay rises from the bottom + seconds left
        const cd=s.k==='act'&&HOTBAR_CD[s.id]?HOTBAR_CD[s.id]():null;
        if(cd&&cd[0]>0){
          const frac=Math.min(1,cd[0]/cd[1]);
          ctx.fillStyle='rgba(0,0,0,.62)';
          ctx.fillRect(x,r.y+HOTBAR_SZ*(1-frac),HOTBAR_SZ,HOTBAR_SZ*frac);
          ctx.fillStyle='#f0d060';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
          ctx.fillText(Math.ceil(cd[0]),x+HOTBAR_SZ/2,r.y+HOTBAR_SZ/2+4);
        }
      }
    }
    // number label
    ctx.font='9px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='left';
    ctx.fillStyle='rgba(200,180,140,.6)';ctx.fillText(String(i+1),x+3,r.y+10);
    // border: gold when selected, warm when equipped weapon, dim otherwise
    ctx.strokeStyle=sel?'#f0d060':isEquipped?'#c8a25a':'rgba(200,162,90,.35)';
    ctx.lineWidth=sel?2:1;
    ctx.strokeRect(x,r.y,HOTBAR_SZ,HOTBAR_SZ);
  }
  ctx.textAlign='left';
}


// Close every shop/trade panel (used before opening one, so only one is ever up).
function closeShopPanels(){
  G.bankOpen=G.tradeOpen=G.craftOpen=G.skillOpen=G.smithOpen=G.mageOpen=G.farrierOpen=
    G.antiqOpen=G.cryptoOpen=G.curatorOpen=G.robberOpen=G.chestOpen=G.contractsOpen=false;
}
// Is any full-screen panel/menu open (suppresses gambits + radial)?
function uiBlocking(){
  return G.charSelectOpen||G.charCreatorOpen||G.craftOpen||G.tradeOpen||G.bankOpen||G.smithOpen||G.mageOpen||G.farrierOpen||
    G.skillOpen||G.questOpen||G.editorOpen||G.dollOpen||G.tutorialOpen||G.corpseLootOpen||G.charOpen||G.contractsOpen||G.worldChestOpen||
    G.gambitOpen||G.buildMode||G.housePlacementMode||G.houseMenuOpen||G.houseSettingsOpen||G.devGuiOpen||
    G.settingsOpen||G.backpackOpen||!!G.trade||G.chestOpen||
    G.antiqOpen||G.cryptoOpen||G.curatorOpen||G.robberOpen;
}
// A tappable/clickable modal panel is open (routes touch taps → mouse
// handlers so every panel button works on mobile). Excludes build/place
// modes, where the joystick must stay live for movement.
function modalOpen(){
  return G.charSelectOpen||G.charCreatorOpen||G.craftOpen||G.tradeOpen||G.bankOpen||G.smithOpen||G.mageOpen||G.farrierOpen||
    G.skillOpen||G.questOpen||G.editorOpen||G.dollOpen||G.tutorialOpen||G.corpseLootOpen||G.charOpen||G.contractsOpen||G.worldChestOpen||
    G.gambitOpen||G.houseMenuOpen||G.houseSettingsOpen||G.devGuiOpen||G.settingsOpen||G.backpackOpen||!!G.trade||!!G.tradeInvite||
    G.antiqOpen||G.cryptoOpen||G.curatorOpen||G.robberOpen;
}

// ── Gambit engine (rule-based conditional actions) ────────────────
// A prioritized stack of IF condition -> THEN action, evaluated each
// frame; the first matching, currently-usable rule fires (one per tick).
const GAMBIT_CONDS=[
  {id:'always',     label:'Always',         arg:false, test:()=>true},
  {id:'hpBelow',    label:'HP below',        arg:true, unit:'%', def:40, step:5, min:5,  max:95, test:a=>player.hp/player.maxHp*100<a},
  {id:'poisoned',   label:'Poisoned',        arg:false,test:()=>player.poisonTimer>0},
  {id:'enemyNear',  label:'Enemy within',    arg:true, unit:'t', def:6, step:1, min:1,  max:12, test:a=>!!nearestEnemy(TILE*a)},
  {id:'enemyMelee', label:'Enemy in melee',  arg:false,test:()=>!!nearestEnemy(TILE*1.6)},
  {id:'arrowsBelow',label:'Arrows below',    arg:true, unit:'', def:5, step:1, min:1,  max:40, test:a=>inv.arrows<a},
  {id:'notHidden',  label:'Not hidden',      arg:false,test:()=>!skills.hiding.active},
];
const GAMBIT_ACTS=['bandage','potion','special','wrestle','warmode','hide','attack','swapweap'];
function gambitCond(id){return GAMBIT_CONDS.find(c=>c.id===id)||GAMBIT_CONDS[0];}
// sensible starter rules
let gambits=[
  {on:true,  cond:'hpBelow',   arg:35, act:'potion'},
  {on:true,  cond:'hpBelow',   arg:60, act:'bandage'},
  {on:true,  cond:'poisoned',  arg:0,  act:'bandage'},
  {on:true,  cond:'enemyNear', arg:8,  act:'warmode'},
  {on:false, cond:'enemyNear', arg:6,  act:'special'},
];
let gambitCd=0;
function runGambits(dt){
  gambitCd=Math.max(0,gambitCd-dt);
  if(!G.gambitsOn||player.dead||player.ghost||player.isRat||uiBlocking())return;
  if(gambitCd>0)return;
  for(const g of gambits){
    if(!g.on)continue;
    const c=gambitCond(g.cond);
    if(!c.test(g.arg))continue;
    const a=COMBAT_ACTIONS[g.act];
    if(!a||!a.can())continue;
    a.run(); gambitCd=0.5; G.gambitFlash={act:g.act,t:0.8}; return;
  }
}

// ── Radial "hotwell" menu (press-hold-flick-release) ──────────────
// Hold the wheel button, drag toward a wedge, release to trigger.
// Works with touch and mouse. Wedges are configurable action ids.
let radialWedges=['attack','special','potion','bandage','hide','warmode'];
const radial={open:false, cx:0, cy:0, sel:-1, r:118, id:null};
// ── Flick control placement ───────────────────────────────────────
// The radial button used to be pinned to one spot, which crowds a phone
// screen. It can now be long-pressed and dragged anywhere, or hidden
// outright (handy once controller support lands). Position persists.
const RADIAL_POS_KEY='bravoRadialPos_v1';
// `hidden` starts as null = "not chosen yet", which resolves to hidden on a mouse and
// shown on a touch device. It is a thumb control and was being drawn on desktop, where it
// sits over the play area doing nothing. An explicit choice from the settings menu wins.
let radialCfg={x:null, y:null, hidden:null};
try{ radialCfg={...radialCfg, ...(JSON.parse(localStorage.getItem(RADIAL_POS_KEY)||'{}')||{})}; }catch(_){}
function saveRadialCfg(){ try{ localStorage.setItem(RADIAL_POS_KEY,JSON.stringify(radialCfg)); }catch(_){} }
function radialBtn(){
  const r=30;
  const defX=G.canvas.width-210, defY=G.canvas.height-84;
  const clamp=(v,d,max)=> v==null ? d : Math.max(r+4, Math.min(max-r-4, v));
  return { x:clamp(radialCfg.x,defX,G.canvas.width), y:clamp(radialCfg.y,defY,G.canvas.height), r };
}
function radialHidden(){
  if(radialCfg.hidden===null||radialCfg.hidden===undefined) return !isTouchPrimary();
  return !!radialCfg.hidden;
}
function setRadialHidden(v){ radialCfg.hidden=!!v; saveRadialCfg(); }
function resetRadialPos(){ radialCfg.x=null; radialCfg.y=null; saveRadialCfg(); }
// Long-press on the button switches from "cast" to "reposition".
let radialDrag=null, radialHoldTimer=null;
function beginRadialHold(id){
  clearTimeout(radialHoldTimer);
  radialHoldTimer=setTimeout(()=>{
    radial.open=false; radial.sel=-1; radial.id=null;      // cancel the cast
    radialDrag={id};
    addFloater(player.x,player.y-30,'✥ drag to move the flick control');
  }, 450);
}
function endRadialHold(){ clearTimeout(radialHoldTimer); radialHoldTimer=null; }
function moveRadialTo(x,y){ radialCfg.x=x; radialCfg.y=y; }
function finishRadialDrag(){ if(radialDrag){ radialDrag=null; saveRadialCfg(); } }
function openRadial(){
  const b=radialBtn();
  radial.open=true; radial.cx=b.x; radial.cy=b.y; radial.sel=-1;
}
function updateRadial(sx,sy){
  if(!radial.open)return;
  const dx=sx-radial.cx, dy=sy-radial.cy, dist=Math.hypot(dx,dy);
  if(dist<26){radial.sel=-1;return;}                       // dead zone = cancel
  let ang=Math.atan2(dy,dx); if(ang<0)ang+=Math.PI*2;
  const n=radialWedges.length;
  // wedge 0 centered at top (-90°); go clockwise
  radial.sel=Math.floor(((ang+Math.PI/2+Math.PI/n)%(Math.PI*2))/(Math.PI*2/n));
}
function triggerRadial(){
  if(radial.open&&radial.sel>=0){
    const id=radialWedges[radial.sel], a=COMBAT_ACTIONS[id];
    if(a){ if(a.can())a.run(); else addFloater(player.x,player.y-30,a.label+' not ready'); }
  }
  radial.open=false; radial.sel=-1; radial.id=null;
}

function toggleWeapon(){
  const cycle=[];
  if(player.hasAxe)       cycle.push('axe');
  if(player.hasPickaxe)   cycle.push('pickaxe');
  if(player.hasSword)     cycle.push('sword');
  if(player.hasBow)       cycle.push('bow');
  if(player.hasHouseTool) cycle.push('house_tool');
  if((inv.siege_ram||0)>0) cycle.push('siege_ram');
  if((inv.torch||0)>0)    cycle.push('torch');
  if((inv.lantern||0)>0)  cycle.push('lantern');
  if(!cycle.length) return;
  const cur=cycle.indexOf(player.weapon);
  player.weapon=cycle[(cur+1)%cycle.length];
}

// ── Trade ─────────────────────────────────────────────────────────
const TRADE_ITEMS=[
  {id:'wood',   label:'Wood',      buy:3, sell:1, kind:'res', key:'wood',       amt:1,sellAmt:1},
  {id:'stone',  label:'Stone',     buy:5, sell:2, kind:'res', key:'stone',      amt:1,sellAmt:1},
  {id:'planks', label:'Planks',    buy:7, sell:3, kind:'res', key:'planks',     amt:1,sellAmt:1},
  {id:'arrows', label:'Arrows ×3', buy:5, sell:1, kind:'res', key:'arrows',     amt:3,sellAmt:1},
  {id:'hide',   label:'Hide',      buy:10,sell:4, kind:'res', key:'hide',       amt:1,sellAmt:1},
  {id:'pickaxe',label:'Pickaxe',   buy:20,sell:8, kind:'tool',pkey:'hasPickaxe',wpn:'pickaxe'},
  {id:'sword',  label:'Sword',     buy:30,sell:12,kind:'tool',pkey:'hasSword',  wpn:'sword'},
  {id:'bow',    label:'Bow',       buy:25,sell:10,kind:'tool',pkey:'hasBow',    wpn:'bow'},
  {id:'bone',   label:'Bone',      buy:6, sell:2, kind:'res', key:'bone',       amt:1,sellAmt:1},
  {id:'bandage',label:'Bandage',   buy:8, sell:3, kind:'res', key:'bandages',   amt:1,sellAmt:1},
  {id:'house_tool',label:'Housing Tool',buy:50,sell:20,kind:'tool',pkey:'hasHouseTool',wpn:'house_tool'},
];
const TRADE_H=TRADE_HEADER+TRADE_PAD+TRADE_ITEMS.length*TRADE_ROW_H+TRADE_SECT_H+TRADE_PAD;
function tradePanelXY(){return panelAt('trade', Math.round(G.canvas.width/2-TRADE_W/2), Math.round(G.canvas.height/2-TRADE_H/2), TRADE_W, TRADE_H);}
function tradeRects(){
  const{px,py}=tradePanelXY(),top=py+TRADE_HEADER+TRADE_PAD;
  return TRADE_ITEMS.map((item,i)=>{
    const extra=i>=5?TRADE_SECT_H:0,rowY=top+i*TRADE_ROW_H+extra;
    return{y:rowY,x:px+TRADE_PAD,w:TRADE_W-TRADE_PAD*2,h:TRADE_ROW_H-2,buyX:px+TRADE_W-170,sellX:px+TRADE_W-116,sellAllX:px+TRADE_W-62,btnW:48,btnH:TRADE_ROW_H-10,item};
  });
}
function canBuy(it){return it.kind==='res'?inv.gold>=it.buy:inv.gold>=it.buy&&!player[it.pkey];}
function canSell(it){return it.kind==='res'?(inv[it.key]||0)>=it.sellAmt:!!player[it.pkey];}
function doBuy(it){
  if(!canBuy(it)) return; snd.gold();inv.gold-=it.buy;
  questEvent('trade');
  if(it.kind==='res'){inv[it.key]+=it.amt;addFloater(player.x,player.y-20,'+'+it.amt+' '+it.label);}
  if(it.kind==='tool'){player[it.pkey]=true;if(it.wpn)player.weapon=it.wpn;addFloater(player.x,player.y-20,it.label+'!');}
}
function doSell(it){
  if(!canSell(it)) return; snd.gold();inv.gold+=it.sell;
  questEvent('trade');
  if(it.kind==='res'){inv[it.key]-=it.sellAmt;addFloater(player.x,player.y-20,'+'+it.sell+'g');}
  if(it.kind==='tool'){player[it.pkey]=false;if(it.wpn&&player.weapon===it.wpn)player.weapon='axe';addFloater(player.x,player.y-20,'+'+it.sell+'g');}
}
function doSellAll(it){
  if(!canSell(it)) return;
  if(it.kind==='res'){
    const count=Math.floor((inv[it.key]||0)/it.sellAmt);
    if(count<=0)return;
    const gain=count*it.sell;
    const cost=count*it.sellAmt;
    snd.gold();
    inv.gold+=gain;
    inv[it.key]-=cost;
    addFloater(player.x,player.y-20,'+'+gain+'g');
    questEvent('trade');
  }
}

// ── Bank ──────────────────────────────────────────────────────────
function bankPanelXY(){return panelAt('bank', Math.round(G.canvas.width/2-BANK_W/2), Math.round(G.canvas.height/2-BANK_H/2), BANK_W, BANK_H);}
function bankDeposit(amt){const a=amt==='all'?inv.gold:Math.min(amt,inv.gold);if(a<=0){addFloater(BANKER.x,BANKER.y-30,'no gold on hand!');return;}inv.gold-=a;bank.gold+=a;addFloater(player.x,player.y-24,'deposited '+a+'g');}
function bankWithdraw(amt){const a=amt==='all'?bank.gold:Math.min(amt,bank.gold);if(a<=0){addFloater(BANKER.x,BANKER.y-30,'vault is empty!');return;}bank.gold-=a;inv.gold+=a;addFloater(player.x,player.y-24,'withdrew '+a+'g');}
function handleBankClick(e){
  const{px,py}=bankPanelXY();
  const dA=[10,50,'all'];
  for(let i=0;i<3;i++){const bx=px+BANK_PAD+i*(BANK_BTN_W+6),by=py+138;if(e.clientX>=bx&&e.clientX<=bx+BANK_BTN_W&&e.clientY>=by&&e.clientY<=by+BANK_BTN_H){bankDeposit(dA[i]);return true;}}
  const wA=[10,50,'all'];
  for(let i=0;i<3;i++){const bx=px+BANK_PAD+i*(BANK_BTN_W+6),by=py+200;if(e.clientX>=bx&&e.clientX<=bx+BANK_BTN_W&&e.clientY>=by&&e.clientY<=by+BANK_BTN_H){bankWithdraw(wA[i]);return true;}}
  return false;
}

// ── Guards ────────────────────────────────────────────────────────
function findOpenTileNear(stx,sty,entityR){
  entityR=entityR||13;
  for(let r=0;r<12;r++) for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){
    if(Math.max(Math.abs(dx),Math.abs(dy))!==r) continue;
    const tx=stx+dx,ty=sty+dy;
    if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) continue;
    const cx=tx*TILE+TILE/2,cy=ty*TILE+TILE/2;
    if(!boxBlocked(cx,cy,entityR)) return{x:cx,y:cy};
  }
  return{x:stx*TILE+TILE/2,y:sty*TILE+TILE/2};
}
function inCity(){const tx=Math.floor(player.x/TILE),ty=Math.floor(player.y/TILE);return tx>=CITY.x1&&tx<=CITY.x2&&ty>=CITY.y1&&ty<=CITY.y2;}
function callGuards(){
  if(!inCity()){addFloater(player.x,player.y-30,'not in city!');return;}
  if(G.guardCallCooldown>0){addFloater(player.x,player.y-30,'cooldown: '+Math.ceil(G.guardCallCooldown)+'s');return;}
  const threats=enemies.filter(e=>e.state!=='dead'&&e.state!=='respawning'&&Math.hypot(e.x-player.x,e.y-player.y)<TILE*12);
  if(!threats.length){addFloater(player.x,player.y-30,'no threat nearby!');return;}
  G.guardCallCooldown=GUARD_CALL_COOLDOWN;
  // Guards muster next to whoever called them — they used to spawn at a fixed
  // city-centre tile and jog across town, arriving long after the fight.
  // Each picks a passable tile a few paces off, on the side facing the threat.
  const ptx=Math.floor(player.x/TILE), pty=Math.floor(player.y/TILE);
  const t0=threats[0];
  const toThreat=Math.atan2(t0.y-player.y, t0.x-player.x);
  for(let i=0;i<2;i++){
    // fan out either side of the line to the nearest threat, ~3 tiles away
    const ang=toThreat + (i===0 ? 0.6 : -0.6);
    let tx=ptx+Math.round(Math.cos(ang)*3), ty=pty+Math.round(Math.sin(ang)*3);
    tx=Math.max(0,Math.min(MAP_W-1,tx)); ty=Math.max(0,Math.min(MAP_H-1,ty));
    let sp=findOpenTileNear(tx,ty,13);
    // findOpenTileNear widens up to 12 tiles; keep them within 10 of the caller
    if(Math.hypot(sp.x-player.x,sp.y-player.y)>TILE*10) sp=findOpenTileNear(ptx,pty,13);
    guards.push({x:sp.x,y:sp.y,hp:80,maxHp:80,r:13,speed:170,damage:22,attackRange:TILE*1.5,attackCooldown:1.0,attackTimer:0.3+i*0.3,iframes:0,lifetime:50,dead:false});
  }
  addFloater(player.x,player.y-30,'Guards incoming!');
}
function updateGuard(g,dt){
  if(g.dead) return;
  g.lifetime-=dt;if(g.lifetime<=0){g.dead=true;return;}
  if(g.iframes>0)g.iframes-=dt;if(g.attackTimer>0)g.attackTimer-=dt;
  let target=null,best=TILE*16;
  for(const e of enemies){if(e.state==='dead'||e.state==='respawning')continue;const d=Math.hypot(e.x-g.x,e.y-g.y);if(d<best){best=d;target=e;}}
  if(target){
    const dx=target.x-g.x,dy=target.y-g.y,dist=Math.hypot(dx,dy);
    if(dist>g.attackRange*0.8){const nx=g.x+(dx/dist)*g.speed*dt;if(!boxBlocked(nx,g.y,g.r))g.x=nx;const ny=g.y+(dy/dist)*g.speed*dt;if(!boxBlocked(g.x,ny,g.r))g.y=ny;}
    if(dist<=g.attackRange&&g.attackTimer<=0){g.attackTimer=g.attackCooldown;damageEnemy(target,g.damage);}
  }
}

// ── Corpse loot ───────────────────────────────────────────────────
function takeAllCorpse(){
  if(!G.corpse) return;
  Object.keys(G.corpse.inv).forEach(k=>{inv[k]=(inv[k]||0)+G.corpse.inv[k];});
  addFloater(player.x,player.y-30,'looted corpse');G.corpse=null;G.corpseLootOpen=false;
}

// ── Achievement system ────────────────────────────────────────────
// Permanent per-character milestones stored in G.achiev (a Set serialised
// as an array in the save). grantAchiev(id) is idempotent — calling it
// twice for the same id is harmless. The toast queues so back-to-back
// grants don't overlap on screen.
const ACHIEVEMENTS = [
  // Combat
  {id:'first_blood', title:'First Blood',        desc:'Slay your first enemy.'},
  {id:'centurion',   title:'Centurion',           desc:'Slay 100 enemies.'},
  {id:'warlord',     title:'Warlord',             desc:'Slay 500 enemies.'},
  {id:'champ_slay',  title:'Champion Slayer',     desc:'Defeat a dungeon champion.'},
  {id:'gravebinder', title:'Gravebinder Felled',  desc:'Slay The Gravebinder on Floor 3.'},
  {id:'molloch_dead',title:'Molloch Slain',        desc:'Slay Ratking Molloch on Floor 5.'},
  // Progression
  {id:'level10',     title:'Journeyman',           desc:'Reach level 10.'},
  {id:'level25',     title:'Veteran',              desc:'Reach level 25.'},
  {id:'level50',     title:'Legend',               desc:'Reach the level cap.'},
  // Dungeon
  {id:'dungeon',     title:'Into the Dark',        desc:'Enter the dungeon.'},
  {id:'dungeon5',    title:'Deep Delver',          desc:'Reach dungeon floor 5.'},
  // World / Economy
  {id:'relic',       title:'Relic Seeker',         desc:'Spend a relic at the Antiquarian.'},
  {id:'curator',     title:"Curator's Favor",      desc:'Fulfill a museum bounty.'},
  {id:'house',       title:'Homesteader',          desc:'Place your first house.'},
  {id:'skill_max',   title:'Master Artisan',       desc:'Max any skill to level 10.'},
];
const _achievQueue = [];
let _achievToast = null;   // {title, desc, startMs, durationMs}

function grantAchiev(id) {
  if (!G.achiev) G.achiev = new Set();
  if (G.achiev.has(id)) return;
  const def = ACHIEVEMENTS.find(a => a.id === id);
  if (!def) return;
  G.achiev.add(id);
  saveGame(true);
  try { snd.quest(); } catch(_){}
  _achievQueue.push({title: def.title, desc: def.desc});
}

function drawAchievToast() {
  // Advance queue when previous toast has expired
  if (!_achievToast && _achievQueue.length)
    _achievToast = { ..._achievQueue.shift(), startMs: performance.now(), durationMs: 4400 };
  if (!_achievToast) return;
  const age = performance.now() - _achievToast.startMs;
  if (age >= _achievToast.durationMs) { _achievToast = null; return; }

  const dur = _achievToast.durationMs, fadeIn = 350, fadeOut = 700;
  let alpha = age < fadeIn ? age/fadeIn : age > dur-fadeOut ? (dur-age)/fadeOut : 1;
  alpha = Math.max(0, Math.min(1, alpha));

  const ctx = G.ctx;
  const W = G.canvas.width, TW = 288, TH = 64, TX = W - TW - 14, TY = 14;

  ctx.save();
  ctx.globalAlpha = alpha;
  // Panel background
  ctx.fillStyle = 'rgba(10,6,2,0.90)';
  ctx.fillRect(TX, TY, TW, TH);
  // Gold top border accent
  ctx.fillStyle = '#c8a440';
  ctx.fillRect(TX, TY, TW, 2);
  // Left accent bar
  ctx.fillStyle = '#c8a440';
  ctx.fillRect(TX, TY, 3, TH);
  // Header text
  ctx.textAlign = 'left';
  ctx.font = 'bold 10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillStyle = '#c8a440';
  ctx.fillText('\u{1F3C6}  ACHIEVEMENT UNLOCKED', TX + 10, TY + 15);
  // Title
  ctx.font = 'bold 14px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillStyle = '#f0dca0';
  ctx.fillText(_achievToast.title, TX + 10, TY + 34);
  // Description
  ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillStyle = 'rgba(220,200,160,0.80)';
  ctx.fillText(_achievToast.desc, TX + 10, TY + 52);
  ctx.restore();
}

// ── Quest system ──────────────────────────────────────────────────
// A linear tutorial chain: each quest teaches one mechanic and pays a
// reward. questEvent(ev, id) is called from the gameplay hooks below;
// only the current quest advances. J toggles the journal panel.
const QUESTS=[
  {id:'wood',    title:'Woodcutter',       desc:'Chop trees for wood: press Q until the axe is equipped, then hold LMB on a tree.',            goal:{ev:'wood',n:5},              reward:{gold:15}},
  {id:'planks',  title:'Carpenter',        desc:'Open crafting with C and craft planks (3 wood each).',                                        goal:{ev:'craft',id:'planks',n:2}, reward:{gold:10}},
  {id:'sword',   title:'Blade Apprentice', desc:'Craft a sword (5 planks) from the crafting menu.',                                            goal:{ev:'craft',id:'sword',n:1},  reward:{potions:1}},
  {id:'wolves',  title:'First Blood',      desc:'Hunt 3 wolves — LMB attacks toward the cursor. Wolves roam the grasslands.',                  goal:{ev:'kill',id:'wolf',n:3},    reward:{bandages:3}},
  {id:'bandage', title:'Field Medic',      desc:'Heal your wounds: press B to apply a bandage after taking damage.',                           goal:{ev:'bandage',n:1},           reward:{potions:2}},
  {id:'pickaxe', title:'Toolsmith',        desc:'Craft a pickaxe (3 planks) so you can mine stone.',                                           goal:{ev:'craft',id:'pickaxe',n:1},reward:{gold:10}},
  {id:'stone',   title:'Stonemason',       desc:'Mine 3 stone: switch to the pickaxe with Q and hold LMB on grey rocks.',                      goal:{ev:'stone',n:3},             reward:{gold:20}},
  {id:'bow',     title:'Fletcher',         desc:'Craft a bow (4 planks). Arrows craft from wood: 1 wood makes 3 arrows.',                      goal:{ev:'craft',id:'bow',n:1},    reward:{arrows:20}},
  {id:'hunter',  title:'Hunter',           desc:'Slay any 5 monsters. Try the bow — switch weapons with Q.',                                   goal:{ev:'kill',n:5},              reward:{gold:30}},
  {id:'trade',   title:'Merchant Friend',  desc:'Trade in Lunar city: walk to the merchant, press E, then buy or sell anything.',              goal:{ev:'trade',n:1},             reward:{gold:25}},
  {id:'wall',    title:'Homesteader',      desc:'Craft a wall (1 plank) and place it — the first stone of your future home.',                  goal:{ev:'wall',n:1},              reward:{planks:5}},
  {id:'altar',   title:'Shrine Seeker',    desc:'Awaken a champion altar: find a purple shrine (M map) and stand near it. Survive the waves!', goal:{ev:'altar',n:1},             reward:{gold:50}},
  {id:'dungeon', title:'Into the Depths',  desc:'Brave the Rat Dungeon: enter the glowing portal at the cave mouth on the main road south of the crossroads.', goal:{ev:'dungeon',n:1}, reward:{gold:100,potions:3}},
  {id:'antiq_intro', title:'Relic Seeker', desc:'Visit the Antiquarian in Lunar City (purple ♦ on the M map) and spend a champion relic to claim your first artifact.', goal:{ev:'relic',n:1}, reward:{gold:75}},
];
const questState={idx:0, prog:0};
function questEvent(ev, id){
  contractEvent(ev, id);          // contracts run forever, independent of the finite quest chain
  if(ev==='relic')  grantAchiev('relic');     // "Relic Seeker"
  if(ev==='bounty') grantAchiev('curator');   // "Curator's Favor"
  if(questState.idx>=QUESTS.length) return;
  const q=QUESTS[questState.idx], g=q.goal;
  if(g.ev!==ev || (g.id&&g.id!==id)) return;
  questState.prog++;
  const n=g.n||1;
  if(questState.prog<n){
    addFloater(player.x,player.y-42,'◆ '+q.title+': '+questState.prog+'/'+n);
    return;
  }
  const parts=[];
  for(const[k,v]of Object.entries(q.reward)){inv[k]=(inv[k]||0)+v;parts.push('+'+v+' '+k);}
  addFloater(player.x,player.y-52,'✔ QUEST COMPLETE: '+q.title);
  addFloater(player.x,player.y-32,parts.join('  '));
  snd.quest();
  questState.idx++; questState.prog=0;
  if(questState.idx<QUESTS.length)
    addFloater(player.x,player.y-72,'⚑ New quest: '+QUESTS[questState.idx].title+'  [J]');
  else
    addFloater(player.x,player.y-72,'⚑ All quests complete — check the Contract Board [E] for endless work!');
}
function grantRandomArtifact(w1,w2,w3){
  const r=Math.random(),tier=r<w1?1:(r<w1+w2?2:3);
  const pool=artifactsOfTier(tier),def=pool[Math.floor(Math.random()*pool.length)];
  player.artifactInv.push({defId:def.id,identified:false});
  addFloater(player.x,player.y-50,'✨ found an unidentified T'+tier+' artifact!');
  snd.quest();
}
// ── ARPG loot rolls ───────────────────────────────────────────────
// Tougher kills roll a better source table (see loot_system.rollRarity) and
// drop more often. Items land on the ground carrying their full instance;
// gems drop as ordinary stackable currency.
const GEM_KEYS=['ruby','sapphire','emerald','diamond'];
function lootSourceFor(e){
  if(e.isChampBoss) return 'boss';
  if(e.isChamp) return 'champ';
  if(e.type==='goblin_k'||e.type==='troll_l'||e.type==='spider_q'||e.type==='piper') return 'elite';
  // Depth upgrades the table: the deeper you fight, the better trash drops.
  const d=G.dungeonFloor||0;
  if(d>=4) return 'champ';
  if(d>=2) return 'elite';
  return 'basic';
}
const ARPG_DROP_CHANCE={boss:1.0, champ:0.6, elite:0.45, basic:0.08};
const GEM_DROP_CHANCE ={boss:0.40, champ:0.15, elite:0.08, basic:0.02};
function rollArpgLoot(e){
  const src=lootSourceFor(e);
  if(Math.random()<ARPG_DROP_CHANCE[src]){
    const item=generateLootDrop(src, player.level||1);
    drops.push({type:'arpg_item', item, x:e.x+(Math.random()-0.5)*20, y:e.y+(Math.random()-0.5)*20, lifetime:180});
  }
  if(Math.random()<GEM_DROP_CHANCE[src]){
    const g=GEM_KEYS[Math.floor(Math.random()*GEM_KEYS.length)];
    drops.push({type:g, x:e.x+(Math.random()-0.5)*20, y:e.y+(Math.random()-0.5)*20, lifetime:150});
  }
}

// Character XP per kill, scaled off the enemy's own toughness so tougher
// foes are always worth more, plus a champion/boss multiplier.
function killXp(e){
  const cfg=ENEMY_CFG[e.type]||{};
  const base=Math.max(4, Math.round((cfg.maxHp||30)*0.45 + (cfg.damage||8)*0.8));
  return Math.round(base * (e.isChampBoss?6 : e.isChamp?2.2 : 1));
}
hooks.onKill = e => {
  questEvent('kill', e.type);
  // First-time gambit hint: after 5th career kill, nudge the player toward Y.
  G.totalKills = (G.totalKills||0)+1;
  if(G.totalKills===5&&!G.gambitHinted){
    G.gambitHinted=true;
    setTimeout(()=>addFloater(player.x,player.y-84,'⚙ Tip: press Y to automate combat with Gambits!'),2500);
  }
  // Kill-count achievements (idempotent)
  if(G.totalKills>=1)   grantAchiev('first_blood');
  if(G.totalKills>=100) grantAchiev('centurion');
  if(G.totalKills>=500) grantAchiev('warlord');
  if(e.isChamp || e.isChampBoss) grantAchiev('champ_slay');
  if(e.floorBoss){                                  // named floor boss felled
    if(!G.floorBossesDown)G.floorBossesDown={};
    G.floorBossesDown[G.dungeonFloor]=true;
    addFloater(player.x,player.y-70,'☠ '+e.bossName+' has fallen!');
    questEvent('floorboss', e.floorBoss);
    inv.gold+=250; addFloater(player.x,player.y-52,'+250g bounty');
    grantRandomArtifact(0.2,0.4,0.4);               // bosses skew to high-tier artifacts
    if(e.floorBoss==='gravebinder') grantAchiev('gravebinder');
    if(e.floorBoss==='molloch')     grantAchiev('molloch_dead');
  }
  // ── character progression: XP → levels → stat points
  const xp=killXp(e);
  const before=player.level;
  addPlayerXp(xp);
  addFloater(player.x,player.y-20,'+'+xp+' xp');
  if(player.level>before){
    recomputeDerivedStats(); snd.quest();
    if(player.level>=10) grantAchiev('level10');
    if(player.level>=25) grantAchiev('level25');
    if(player.level>=50) grantAchiev('level50');
  }
  // ── ARPG loot: rarity/affix/socketed gear from tougher kills
  rollArpgLoot(e);
  if(e.isChampBoss){
    inv.relics+=1;addFloater(player.x,player.y-58,'💎 +1 relic');
    if(Math.random()<0.15)grantRandomArtifact(0.6,0.3,0.1);
    inv.gold+=100;addFloater(player.x,player.y-44,'👑 champion tribute: +100g');snd.gold();
  } else if(e.isChamp&&Math.random()<0.05){
    inv.relics+=1;addFloater(player.x,player.y-44,'💎 +1 relic');snd.gold();
  }
};
// Altar awakening + dungeon entry are detected by transition polling
let _qAltarWas=false,_qDunWas=false;
function questPoll(){
  const anyAltar=CHAMP_ALTARS.some(a=>a.state!=='idle');
  if(anyAltar&&!_qAltarWas)questEvent('altar');
  _qAltarWas=anyAltar;
  if(G.inDungeon&&!_qDunWas){
    questEvent('dungeon');
    grantAchiev('dungeon');                             // "Into the Dark"
  }
  _qDunWas=G.inDungeon;
  if(G.dungeonFloor>=5) grantAchiev('dungeon5');        // "Deep Delver"
}
// ── Dungeon floors & named bosses ─────────────────────────────────
// Floor bosses reuse existing enemy AI/models with buffed stats, a name and
// a tint — a distinct silhouette without a bespoke AI system. Each is a
// one-time kill per save (floorBossesDown), and guards the way down.
const FLOOR_BOSSES={
  gravebinder:{ base:'troll_l', name:'The Gravebinder', hp:2.4, dmg:1.5, tint:0x9effc0 },
  molloch:    { base:'piper',   name:'Ratking Molloch', hp:3.0, dmg:1.8, tint:0xffcc66 },
};
function spawnFloorBoss(floorN){
  const spec=DUNGEON_BOSS_SPAWNS.find(b=>b.floor===floorN); if(!spec) return;
  if(G.floorBossesDown&&G.floorBossesDown[floorN]) return;          // already slain
  if(enemies.some(e=>e.floorBoss===spec.boss&&e.state!=='dead')) return;
  const def=FLOOR_BOSSES[spec.boss]; if(!def) return;
  const e=makeEnemy(def.base, spec.x, spec.y);
  e.maxHp=Math.round(e.maxHp*def.hp); e.hp=e.maxHp;
  e.damage=Math.round(e.damage*def.dmg);
  e.floorBoss=spec.boss; e.bossName=def.name; e.isChampBoss=true;   // boss-tier loot + XP
  enemies.push(e);
  addFloater(player.x,player.y-64,'⚠ '+def.name+' stirs in the dark...');
  snd.quest();
}
// Announce a floor, track the deepest reached, and wake its boss.
function enterFloor(n){
  G.dungeonFloor=n;
  G.dungeonBest=Math.max(G.dungeonBest||1,n);
  const f=DUNGEON_FLOORS.find(x=>x.n===n);
  snd.cave();
  addFloater(player.x,player.y-30,'▼ Floor '+n+' — '+(f?f.name:'the deep'));
  questEvent('dungeon');            // feeds the tutorial quest + delve contracts
  questEvent('delve', String(n));   // depth-specific contract objective
  spawnFloorBoss(n);
}

// ── World treasure chests ─────────────────────────────────────────
// Contents are rolled lazily on first open, so a chest you find at level 30
// pays out for level 30 rather than whatever level you were when the world
// generated. Rolled contents are cached until taken.
const _chestLoot={};                       // "x,y" -> {gold, res:{}, gear:[], arpg:[]}
function chestKey(c){ return c.x+','+c.y; }
function rollChestLoot(c){
  const k=chestKey(c);
  if(_chestLoot[k]) return _chestLoot[k];
  const t=c.tier||1, R=(a,b)=>a+Math.floor(Math.random()*(b-a+1));
  const loot={gold:R(30+t*25, 70+t*55), res:{}, gear:[], arpg:[]};
  const add=(key,n)=>{ if(n>0) loot.res[key]=(loot.res[key]||0)+n; };
  add('bandages', R(0,1+t));
  add('potions',  R(0,t));
  if(t>=2) add('iron_ingot',  R(1,2+t));
  if(t>=3) add('steel_ingot', R(0,t));
  if(t>=5) add('mithril_ingot', R(0,2));
  if(t>=6) add('runic_ingot',   R(0,2));
  // gems + wearable-looking treasure
  if(Math.random()<0.25+t*0.10) add(GEM_KEYS[Math.floor(Math.random()*GEM_KEYS.length)], 1);
  if(Math.random()<0.35+t*0.08) loot.gear.push(LOOT_KEYS[Math.floor(Math.random()*LOOT_KEYS.length)]);
  // rolled ARPG equipment — richer tables the deeper the chest
  const src = t>=6?'boss' : t>=4?'champ' : t>=2?'elite' : 'basic';
  const rolls = c.hoard?2:1;
  for(let i=0;i<rolls;i++) if(c.hoard||Math.random()<0.45+t*0.07)
    loot.arpg.push(generateLootDrop(src, player.level||1));
  _chestLoot[k]=loot; return loot;
}
function chestIsEmpty(l){
  return !l || (l.gold<=0 && !Object.keys(l.res).length && !l.gear.length && !l.arpg.length);
}
// Closest unlooted chest in reach (not merely the first in the array — chests
// can sit near each other, and grabbing the wrong one is confusing).
function nearbyWorldChest(){
  const looted=G.chestsLooted||{};
  let best=null, bestD=TILE*1.6;
  for(const c of WORLD_CHESTS){
    if(looted[chestKey(c)]) continue;
    const d=Math.hypot(c.x*TILE+TILE/2-player.x, c.y*TILE+TILE/2-player.y);
    if(d<bestD){ bestD=d; best=c; }
  }
  return best;
}
function takeAllChest(){
  const c=G.activeWorldChest; if(!c) return;
  const l=rollChestLoot(c);
  if(l.gold>0){ inv.gold+=l.gold; addFloater(player.x,player.y-52,'+'+l.gold+'g'); l.gold=0; }
  for(const k in l.res){ inv[k]=(inv[k]||0)+l.res[k]; }
  l.res={};
  for(const g of l.gear){ inv[g]=(inv[g]||0)+1; }
  l.gear=[];
  for(const it of l.arpg){ player.equipmentItems.push(it); addFloater(player.x,player.y-34,'📦 '+it.rarityName+': '+it.name); }
  l.arpg=[];
  if(!G.chestsLooted)G.chestsLooted={};
  G.chestsLooted[chestKey(c)]=true;
  placedObjectsDirty=true;                 // chest disappears from the world
  G.worldChestOpen=false; G.activeWorldChest=null;
  addFloater(player.x,player.y-22,'chest emptied');
  snd.gold(); questEvent('chest');          // feeds "loot N chests" contracts
  if(typeof saveGame==='function')saveGame(true);
}
const WCHEST_W=fitPanelW(300);
function worldChestXY(){
  const l=G.activeWorldChest?rollChestLoot(G.activeWorldChest):null;
  const rows=l?(1+Object.keys(l.res).length+l.gear.length+l.arpg.length):0;
  const H=64+rows*20+52;
  return {...panelAt('worldchest', Math.round(G.canvas.width/2-WCHEST_W/2), Math.round(G.canvas.height/2-H/2), WCHEST_W, H), H};
}
function renderWorldChest(){
  const c=G.activeWorldChest; if(!c){ G.worldChestOpen=false; return; }
  const ctx=G.ctx, l=rollChestLoot(c), {px,py,H}=worldChestXY();
  ctx.fillStyle='rgba(22,17,6,.97)';ctx.fillRect(px,py,WCHEST_W,H);
  ctx.strokeStyle=c.hoard?'#f0c040':'#c8a25a';ctx.lineWidth=2;ctx.strokeRect(px,py,WCHEST_W,H);
  ctx.fillStyle=c.hoard?'#ffd76a':'#f0d878';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText((c.hoard?'👑 HOARD':'🧰 TREASURE CHEST')+'  ·  E to close',px+WCHEST_W/2,py+22);
  ctx.fillStyle='rgba(220,205,170,.8)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('floor '+c.floor+'  ·  tier '+(c.tier||1),px+WCHEST_W/2,py+38);
  ctx.textAlign='left';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
  let y=py+58;
  const line=(txt,col)=>{ ctx.fillStyle=col||'#e8dcc0'; ctx.fillText(txt,px+14,y); y+=20; };
  if(chestIsEmpty(l)) line('(empty)','rgba(180,170,150,.6)');
  else{
    if(l.gold>0) line('🪙 '+l.gold+' gold','#f0d060');
    for(const k in l.res) line('• '+itemLabel(k)+' ×'+l.res[k]);
    for(const g of l.gear) line('• '+itemLabel(g),'#cfe4ff');
    for(const it of l.arpg) line('📦 '+it.name+'  ('+it.rarityName+')', it.color||'#fff');
  }
  const b={x:px+14,y:py+H-40,w:WCHEST_W-28,h:28};
  const can=!chestIsEmpty(l);
  ctx.fillStyle=can?'rgba(120,90,25,.95)':'rgba(40,34,26,.7)';ctx.fillRect(b.x,b.y,b.w,b.h);
  ctx.strokeStyle=can?'#e0b850':'rgba(120,100,70,.4)';ctx.lineWidth=1;ctx.strokeRect(b.x,b.y,b.w,b.h);
  ctx.fillStyle=can?'#ffe9b0':'#665';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText(can?'Take All':'nothing left',b.x+b.w/2,b.y+18);ctx.textAlign='left';
}
function handleWorldChestClick(e){
  const {px,py,H}=worldChestXY();
  if(e.clientX<px||e.clientX>px+WCHEST_W||e.clientY<py||e.clientY>py+H)return false;
  const b={x:px+14,y:py+H-40,w:WCHEST_W-28,h:28};
  if(e.clientX>=b.x&&e.clientX<=b.x+b.w&&e.clientY>=b.y&&e.clientY<=b.y+b.h) takeAllChest();
  return true;
}

// ── Endless contract board ────────────────────────────────────────
// The quest chain is a finite tutorial; contracts are the forever-loop that
// replaces it. Three jobs are always live, each rerolls the instant it's
// turned in, and the difficulty tier climbs with your completed rank — so
// there is never a point where the board runs dry.
const CONTRACT_BOARD = { x:313*48+24, y:368*48+24, r:13 };
const CONTRACT_MOBS=[
  {t:'wolf',n:'Wolves'},{t:'spider',n:'Spiders'},{t:'giant_rat',n:'Giant Rats'},
  {t:'goblin',n:'Goblins'},{t:'ratman',n:'Ratmen'},{t:'hellhound',n:'Hellhounds'},
  {t:'troll',n:'Trolls'},{t:'silver_serp',n:'Silver Serpents'},{t:'slime',n:'Slimes'},
];
const _cRnd=n=>Math.floor(Math.random()*n);
const CONTRACT_TEMPLATES=[
  {id:'hunt',  gen:tier=>{const m=CONTRACT_MOBS[_cRnd(CONTRACT_MOBS.length)],need=3+tier*2+_cRnd(3);
    return {title:'Cull the '+m.n, desc:'Slay '+need+' '+m.n.toLowerCase(), ev:'kill', evId:m.t, need};}},
  {id:'cull',  gen:tier=>{const need=6+tier*4+_cRnd(5);
    return {title:'Thin the Wilds', desc:'Slay '+need+' monsters of any kind', ev:'kill', evId:null, need};}},
  {id:'timber',gen:tier=>{const need=8+tier*6+_cRnd(6);
    return {title:'Timber Order', desc:'Gather '+need+' wood', ev:'wood', evId:null, need};}},
  {id:'quarry',gen:tier=>{const need=6+tier*5+_cRnd(5);
    return {title:'Quarry Order', desc:'Mine '+need+' stone', ev:'stone', evId:null, need};}},
  {id:'delve', gen:()=>({title:'Into the Depths', desc:'Descend into the dungeon', ev:'dungeon', evId:null, need:1})},
  {id:'altar', gen:()=>({title:"Champion's Call", desc:'Awaken a champion altar', ev:'altar', evId:null, need:1})},
  // Depth runs — the deeper tiers push you toward the floor bosses
  {id:'depth', gen:tier=>{const n=Math.min(5,2+Math.floor(tier/2)); const f=DUNGEON_FLOORS.find(x=>x.n===n);
    return {title:'Delve: '+(f?f.name:'Floor '+n), desc:'Reach dungeon floor '+n, ev:'delve', evId:String(n), need:1};}},
  {id:'looter',gen:tier=>{const need=1+Math.floor(tier/2);
    return {title:'Tomb Robber', desc:'Loot '+need+' treasure chest'+(need>1?'s':'')+' underground', ev:'chest', evId:null, need};}},
  {id:'slayer',gen:tier=>{const which=tier>=4?'molloch':'gravebinder';
    const nm=FLOOR_BOSSES[which].name;
    return {title:'Slay '+nm, desc:'Destroy '+nm+' in the deep', ev:'floorboss', evId:which, need:1};}},
  // Discovery contracts — guide players toward hidden systems
  {id:'antiq', gen:tier=>{const need=1+Math.floor(tier/3);
    return {title:'Relic Exchange', desc:'Spend '+need+' relic'+(need>1?'s':'')+' at the Antiquarian (💜 on map, [E] to browse)', ev:'relic', evId:null, need};}},
  {id:'bounty', gen:()=>({title:'Museum Commission', desc:'Fulfill a bounty at the Museum Curator (★ on map, [E] to view)', ev:'bounty', evId:null, need:1})},
];
function contractTier(){ return Math.min(6, 1+Math.floor((G.contractRank||0)/3)); }
function makeContract(tier){
  const tpl=CONTRACT_TEMPLATES[_cRnd(CONTRACT_TEMPLATES.length)];
  const c=tpl.gen(tier);
  c.tpl=tpl.id; c.tier=tier; c.prog=0;
  c.gold=Math.round(30+tier*28+c.need*2);
  c.xp  =Math.round(45+tier*40);
  c.bonus = (tier>=3&&Math.random()<0.5) ? 'gear' : (tier>=2&&Math.random()<0.4 ? 'gem' : null);
  return c;
}
// Draw a contract whose objective isn't already live on the board, so the
// three slots always read as three distinct jobs.
function makeDistinctContract(tier, avoid){
  let c;
  for(let tries=0; tries<12; tries++){
    c=makeContract(tier);
    const key=c.title+'|'+(c.evId||'');
    if(!avoid.has(key)){ avoid.add(key); return c; }
  }
  return c;   // gave up avoiding a dupe — still valid
}
function ensureContracts(){
  if(!Array.isArray(G.contracts))G.contracts=[];
  // Rebuild to exactly three distinct jobs, healing any duplicates carried in
  // from an older save (keep the first occurrence, reroll the rest).
  const seen=new Set(), kept=[];
  for(const c of G.contracts){
    if(!c)continue;
    const key=c.title+'|'+(c.evId||'');
    if(seen.has(key))continue;
    seen.add(key); kept.push(c);
  }
  G.contracts=kept;
  while(G.contracts.length<3)G.contracts.push(makeDistinctContract(contractTier(), seen));
  G.contracts.length=3;
}
function completeContract(i){
  const c=G.contracts[i]; if(!c)return;
  inv.gold+=c.gold;
  const _lvBefore=player.level;
  addPlayerXp(c.xp); recomputeDerivedStats();
  if(player.level>_lvBefore){
    if(player.level>=10) grantAchiev('level10');
    if(player.level>=25) grantAchiev('level25');
    if(player.level>=50) grantAchiev('level50');
  }
  addFloater(player.x,player.y-58,'✔ CONTRACT DONE: '+c.title);
  addFloater(player.x,player.y-40,'+'+c.gold+'g   +'+c.xp+' xp');
  if(c.bonus==='gear'){
    const item=generateLootDrop(c.tier>=5?'champ':'elite', player.level||1);
    player.equipmentItems.push(item);
    addFloater(player.x,player.y-22,'📦 '+item.rarityName+': '+item.name+'  [L]');
  } else if(c.bonus==='gem'){
    const g=GEM_KEYS[_cRnd(GEM_KEYS.length)];
    inv[g]=(inv[g]||0)+1; addFloater(player.x,player.y-22,'💎 +1 '+g);
  }
  G.contractRank=(G.contractRank||0)+1;
  const live=new Set(G.contracts.filter((c,j)=>c&&j!==i).map(c=>c.title+'|'+(c.evId||'')));
  G.contracts[i]=makeDistinctContract(contractTier(), live);   // instant reroll → endless board
  snd.quest();
}
function contractEvent(ev,id){
  if(!Array.isArray(G.contracts))return;
  for(let i=0;i<G.contracts.length;i++){
    const c=G.contracts[i];
    if(!c||c.ev!==ev)continue;
    if(c.evId&&c.evId!==id)continue;
    c.prog++;
    if(c.prog>=c.need){ completeContract(i); continue; }
    const step=Math.max(1,Math.floor(c.need/4));
    if(c.prog%step===0)addFloater(player.x,player.y-46,'📜 '+c.title+': '+c.prog+'/'+c.need);
  }
}
// Reroll a job you don't want — free only before you've made progress on it.
function rerollContract(i){
  const c=G.contracts[i]; if(!c)return;
  if(c.prog>0){ addFloater(player.x,player.y-30,'already underway — finish or abandon by completing'); return; }
  const live=new Set(G.contracts.filter((x,j)=>x&&j!==i).map(x=>x.title+'|'+(x.evId||'')));
  G.contracts[i]=makeDistinctContract(contractTier(), live);
  snd.pickup();
}
const CONTRACT_W=fitPanelW(430), CONTRACT_ROW_H=74, CONTRACT_HEADER=52;
function contractPanelXY(){
  const H=CONTRACT_HEADER+3*CONTRACT_ROW_H+20;
  return {...panelAt('contracts', Math.round(G.canvas.width/2-CONTRACT_W/2), Math.round(G.canvas.height/2-H/2), CONTRACT_W, H), H};
}
function contractRows(){
  const{px,py}=contractPanelXY();
  return (G.contracts||[]).map((c,i)=>({i,c,x:px+12,y:py+CONTRACT_HEADER+i*CONTRACT_ROW_H,
    w:CONTRACT_W-24,h:CONTRACT_ROW_H-8,
    reroll:{x:px+CONTRACT_W-74,y:py+CONTRACT_HEADER+i*CONTRACT_ROW_H+6,w:60,h:20}}));
}
function renderContractPanel(){
  ensureContracts();
  const ctx=G.ctx,{px,py,H}=contractPanelXY();
  ctx.fillStyle='rgba(18,14,8,.97)';ctx.fillRect(px,py,CONTRACT_W,H);
  ctx.strokeStyle='#c8a25a';ctx.lineWidth=2;ctx.strokeRect(px,py,CONTRACT_W,H);
  ctx.fillStyle='#f0d878';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('📜 CONTRACT BOARD  ·  E to close',px+CONTRACT_W/2,py+22);
  ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='rgba(220,205,170,.85)';
  ctx.fillText('completed: '+(G.contractRank||0)+'    ·    difficulty tier '+contractTier()+'/6',px+CONTRACT_W/2,py+40);
  ctx.textAlign='left';
  for(const r of contractRows()){
    const c=r.c;
    ctx.fillStyle='rgba(255,255,255,.04)';ctx.fillRect(r.x,r.y,r.w,r.h);
    ctx.strokeStyle='rgba(200,162,90,.35)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
    ctx.fillStyle='#f0e0b8';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(c.title,r.x+8,r.y+17);
    ctx.fillStyle='rgba(210,200,175,.85)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(c.desc,r.x+8,r.y+33);
    // progress bar
    const bw=r.w-16,frac=Math.max(0,Math.min(1,c.prog/c.need));
    ctx.fillStyle='rgba(0,0,0,.45)';ctx.fillRect(r.x+8,r.y+40,bw,9);
    ctx.fillStyle=frac>=1?'#80e880':'#c8a25a';ctx.fillRect(r.x+8,r.y+40,Math.round(bw*frac),9);
    ctx.strokeStyle='rgba(255,255,255,.15)';ctx.strokeRect(r.x+8,r.y+40,bw,9);
    ctx.fillStyle='#e8dcc0';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(c.prog+' / '+c.need,r.x+8,r.y+60);
    // rewards
    ctx.textAlign='right';ctx.fillStyle='#f0d060';
    const bonus=c.bonus==='gear'?'  📦 gear':c.bonus==='gem'?'  💎 gem':'';
    ctx.fillText(c.gold+'g   +'+c.xp+' xp'+bonus,r.x+r.w-8,r.y+60);ctx.textAlign='left';
    // reroll (only meaningful before progress)
    const can=c.prog===0;
    ctx.fillStyle=can?'rgba(70,55,30,.95)':'rgba(40,34,26,.6)';ctx.fillRect(r.reroll.x,r.reroll.y,r.reroll.w,r.reroll.h);
    ctx.strokeStyle=can?'#c8a25a':'rgba(120,100,70,.35)';ctx.strokeRect(r.reroll.x,r.reroll.y,r.reroll.w,r.reroll.h);
    ctx.fillStyle=can?'#f0d878':'#665';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText('reroll',r.reroll.x+r.reroll.w/2,r.reroll.y+14);ctx.textAlign='left';
  }
}
function handleContractClick(e){
  const{px,py,H}=contractPanelXY();
  if(e.clientX<px||e.clientX>px+CONTRACT_W||e.clientY<py||e.clientY>py+H)return false;
  for(const r of contractRows()){
    const b=r.reroll;
    if(e.clientX>=b.x&&e.clientX<=b.x+b.w&&e.clientY>=b.y&&e.clientY<=b.y+b.h){rerollContract(r.i);return true;}
  }
  return true;
}
// The board itself — a plank sign in the courtyard south-east of the bank.
{
  const g=new THREE.Group();
  const post=new THREE.MeshLambertMaterial({color:0x5c3c24});
  const l=new THREE.Mesh(new THREE.BoxGeometry(3,34,3),post); l.position.set(-11,17,0);
  const rp=new THREE.Mesh(new THREE.BoxGeometry(3,34,3),post); rp.position.set(11,17,0);
  const board=new THREE.Mesh(new THREE.BoxGeometry(30,22,2.5),new THREE.MeshLambertMaterial({color:0x7a5330}));
  board.position.set(0,30,0);
  const paper=new THREE.Mesh(new THREE.PlaneGeometry(22,15),new THREE.MeshLambertMaterial({color:0xe8dcc0}));
  paper.position.set(0,30,1.6);
  g.add(l,rp,board,paper);
  g.position.set(CONTRACT_BOARD.x,0,CONTRACT_BOARD.y);
  [l,rp,board].forEach(m=>{m.castShadow=true;});
  scene.add(g);
}
ensureContracts();   // fresh games start with three jobs already posted

// Journal panel
const QUEST_W=fitPanelW(320);
function renderQuestPanel(){
  ensureContracts();
  const ctx=G.ctx,rowH=30,headH=34;
  const earnedN=(G.achiev||new Set()).size;
  const achievH=20+(earnedN>0?earnedN*14:0)+14;  // section header + earned list + margin
  const H=headH+QUESTS.length*rowH+58+22+(G.contracts||[]).length*16+achievH;
  const {px,py}=panelAt('quests', Math.round(G.canvas.width/2-QUEST_W/2), Math.max(8,Math.round(G.canvas.height/2-H/2)), QUEST_W, H);
  ctx.fillStyle='rgba(18,13,8,.94)';ctx.fillRect(px,py,QUEST_W,H);
  ctx.strokeStyle='#c8a25a';ctx.lineWidth=1.5;ctx.strokeRect(px,py,QUEST_W,H);
  ctx.fillStyle='#c8a25a';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('QUEST JOURNAL  ·  J to close',px+QUEST_W/2,py+22);
  ctx.textAlign='left';
  let y=py+headH+16;
  QUESTS.forEach((q,i)=>{
    const done=i<questState.idx,cur=i===questState.idx,n=q.goal.n||1;
    ctx.font=(cur?'bold ':'')+'12px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillStyle=done?'#6fbf6f':cur?'#ffd97a':'rgba(200,190,170,.35)';
    const mark=done?'✔':cur?'►':'○';
    const prog=cur&&n>1?'  '+questState.prog+'/'+n:'';
    ctx.fillText(mark+' '+q.title+prog,px+14,y);
    if(cur){
      // word-wrap the active quest's description
      ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='rgba(232,220,192,.85)';
      const words=q.desc.split(' ');let line='',ly=y+15;
      for(const w of words){
        if(ctx.measureText(line+w).width>QUEST_W-40){ctx.fillText(line,px+24,ly);line=w+' ';ly+=13;}
        else line+=w+' ';
      }
      if(line)ctx.fillText(line,px+24,ly);
      const rw=Object.entries(q.reward).map(([k,v])=>'+'+v+' '+k).join('  ');
      ctx.fillStyle='#c8a25a';ctx.fillText('reward: '+rw,px+24,ly+14);
      y=ly+14;
    }
    y+=rowH;
  });
  // Active contracts — the endless loop that outlives the quest chain
  y+=4;
  ctx.fillStyle='#c8a25a';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('📜 CONTRACTS  (board in town)  ·  rank '+(G.contractRank||0),px+14,y);
  y+=16;
  for(const c of (G.contracts||[])){
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='rgba(232,220,192,.9)';
    ctx.fillText('• '+c.title+'  '+c.prog+'/'+c.need,px+18,y);
    ctx.textAlign='right';ctx.fillStyle='#f0d060';
    ctx.fillText(c.gold+'g',px+QUEST_W-14,y);ctx.textAlign='left';
    y+=16;
  }
  // Achievements section
  y+=6;
  const earned=G.achiev||new Set();
  ctx.fillStyle='#c8a440';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('\u{1F3C6} ACHIEVEMENTS  '+earned.size+' / '+ACHIEVEMENTS.length,px+14,y);
  y+=14;
  if(earned.size===0){
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='rgba(200,190,170,.35)';
    ctx.fillText('  none earned yet — explore, fight, build!',px+14,y);
    y+=14;
  } else {
    for(const a of ACHIEVEMENTS){
      if(!earned.has(a.id)) continue;
      ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='#f0dca0';
      ctx.fillText('✔ '+a.title+'  —  '+a.desc,px+18,y);
      y+=14;
    }
  }
}
// HUD tracker — bottom-left, always visible while quests remain
function drawQuestTracker(){
  const ctx=G.ctx;
  if(questState.idx>=QUESTS.length)return;
  const q=QUESTS[questState.idx],n=q.goal.n||1;
  const txt='◆ '+q.title+(n>1?'  '+questState.prog+'/'+n:'')+'  [J]';
  ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';
  const w=ctx.measureText(txt).width;
  const bx=10,by=G.canvas.height-64;
  ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(bx-4,by-15,w+12,22);
  ctx.fillStyle='#ffd97a';ctx.fillText(txt,bx,by);
}
function drawTimeClock(){
  const ctx = G.ctx;
  const time = (G.gameTime % DAY_CYCLE_SEC) / DAY_CYCLE_SEC;
  const totalMinutes = Math.floor(time * 1440);
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = Math.floor(totalMinutes % 60);
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const timeStr = `⏰ ${hour12.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')} ${ampm}`;
  const isNight = hour24 < 6 || hour24 >= 18;
  const moonIcons = ['🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘'];
  const moonNames = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  const mp = G.moonPhase || 0;
  const phaseStr = isNight ? `${moonIcons[mp]} ${moonNames[mp]}` : '☀ Day';
  const text = `${timeStr} · ${phaseStr}`;
  ctx.font = 'bold 12px ui-monospace,Menlo,Consolas,monospace';
  const w = ctx.measureText(text).width;
  const bx = 12, by = 46;   // second row: below the HTML title line, above status/offline
  ctx.fillStyle = 'rgba(15, 10, 5, 0.72)';
  ctx.fillRect(bx - 6, by - 14, w + 12, 20);
  ctx.strokeStyle = isNight ? 'rgba(120, 140, 200, 0.5)' : 'rgba(200, 162, 90, 0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx - 6, by - 14, w + 12, 20);
  ctx.fillStyle = isNight ? '#c8d8ff' : '#fbe5b8';
  ctx.fillText(text, bx, by);
}

// ── World editor (F2): map painting + mob spawns + stat tuning ────
const ED_TILES=[
  [T.GRASS,'grass'],[T.PATH,'path'],[T.WATER,'water'],[T.TREE,'tree'],
  [T.STONE,'rock'],[T.WALL,'wall'],[T.BRIDGE,'bridge'],[T.CAVE_FLOOR,'cave floor'],
  [T.CAVE_WALL,'cave wall'],[T.CAVE_ENTRANCE,'cave mouth'],[T.TELEPORT,'teleport'],
  [T.STAINED_GLASS,'stained glass'],
];
const ED_STATS=[['maxHp','HP',10,5],['speed','Speed',10,10],['damage','Dmg',2,1],
  ['aggroRange','Aggro',TILE/2,TILE/2],['attackCooldown','Atk CD',0.1,0.2]];
// Shared color palette for the tile/mob creation wizards
const ED_COLORS=[[200,60,50],[220,130,40],[230,200,60],[120,190,60],[40,150,70],[60,200,180],
  [50,120,220],[90,60,200],[170,60,200],[220,80,150],[140,90,50],[90,60,30],
  [235,235,220],[150,150,150],[80,80,80],[25,25,30]];
const ED_SIZES=[['S',0.7],['M',1],['L',1.4],['XL',2]];
const ED_HEIGHTS=[['flat',0],['low',19],['tall',41]];
function edTileList(){ return ED_TILES.concat(worldEdits.tiles.map(ct=>[ct.id,ct.name])); }
function edMobList(){ return Object.keys(ENEMY_CFG); }
function edMobLabel(id){ return customMobDefs[id]?customMobDefs[id].name:id; }
const edState={tab:'map', tile:T.TREE, brush:1, mobMode:'place', mobType:'wolf', resetArmed:false,
  wiz:null, wt:{ci:14, blocking:true, hi:2}, wm:{base:'wolf', ci:0, si:1, cave:false}};
let edHit=[], edSaveT=0, edDirtySave=false, _edIdSeq=0;
const ED_PANEL={x:10,y:150,w:200};

function edSetTile(tx,ty,t){
  if(tx<0||ty<0||tx>=MAP_W||ty>=MAP_H||map[ty][tx]===t) return;
  const old=map[ty][tx];
  map[ty][tx]=t; origTile[ty][tx]=t; respawnAt[ty][tx]=null;
  resourceHp[ty][tx]=t===T.TREE?TREE_HP:t===T.STONE?STONE_HP:0;
  worldEdits.map[tx+','+ty]=t;
  bakeStaticTile(tx,ty,old); minimapUpdateTile(tx,ty);
  edDirtySave=true;
}
function edPaint(wx,wy,erase){
  const tx=Math.floor(wx/TILE), ty=Math.floor(wy/TILE), r=edState.brush-1;
  const t=erase?T.GRASS:edState.tile;
  for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++)edSetTile(tx+dx,ty+dy,t);
}
function edPlaceMob(wx,wy){
  const tx=Math.floor(wx/TILE), ty=Math.floor(wy/TILE);
  const e=makeEnemy(edState.mobType,tx,ty);
  if(!e){addFloater(wx,wy-20,'no valid tile here ('+edState.mobType+' needs '+(['goblin','troll','spider'].includes(edState.mobType)?'cave':'grass/cave')+' floor)');return;}
  const id=Date.now()+'_'+(_edIdSeq++);
  e.customId=id; enemies.push(e);
  worldEdits.spawns.push({id, t:edState.mobType, x:tx, y:ty});
  addFloater(e.x,e.y-24,'spawn: '+edState.mobType); saveEdits();
}
function edRemoveMob(wx,wy){
  let best=null,bd=TILE*2.5;
  for(const e of enemies){ if(!e.customId)continue;
    const d=Math.hypot(e.x-wx,e.y-wy); if(d<bd){bd=d;best=e;} }
  if(!best){addFloater(wx,wy-20,'no custom spawn here');return;}
  worldEdits.spawns=worldEdits.spawns.filter(s=>s.id!==best.customId);
  enemies.splice(enemies.indexOf(best),1);
  addFloater(wx,wy-20,'spawn removed'); saveEdits();
}
function edTuneStat(stat,delta,min){
  const cfg=ENEMY_CFG[edState.mobType]; if(!cfg)return;
  cfg[stat]=Math.round(Math.max(min,cfg[stat]+delta)*100)/100;
  (worldEdits.mobs[edState.mobType]??={})[stat]=cfg[stat];
  for(const e of enemies){ if(e.type!==edState.mobType)continue;   // live-update
    if(stat==='maxHp'){e.maxHp=cfg.maxHp;e.hp=Math.min(e.hp,e.maxHp);}
    else if(e[stat]!==undefined)e[stat]=cfg[stat]; }
  saveEdits();
}
function edCreateTile(){
  const name=(prompt('Name for the new tile?')||'').trim();
  if(!name) return;
  const id=Math.max(99, ...worldEdits.tiles.map(t=>t.id))+1;
  const def={id, name:name.slice(0,12), color:ED_COLORS[edState.wt.ci],
    blocking:edState.wt.blocking, boxH:ED_HEIGHTS[edState.wt.hi][1]};
  worldEdits.tiles.push(def); registerCustomTile(def); saveEdits();
  edState.tile=id; edState.wiz=null;
  addFloater(player.x,player.y-30,'new tile: '+def.name);
}
function edCreateMob(){
  const name=(prompt('Name for the new mob?')||'').trim();
  if(!name) return;
  const c=ED_COLORS[edState.wm.ci];
  const def={id:'c'+Date.now(), name:name.slice(0,12), base:edState.wm.base,
    tint:(c[0]<<16)|(c[1]<<8)|c[2], scale:ED_SIZES[edState.wm.si][1], cave:edState.wm.cave, stats:{}};
  worldEdits.customMobs.push(def); registerCustomMob(def); saveEdits();
  edState.mobType=def.id; edState.mobMode='place'; edState.wiz=null;
  addFloater(player.x,player.y-30,'new mob: '+def.name+' (based on '+def.base+') — click to place spawns');
}
function edDeleteMob(id){
  const def=customMobDefs[id]; if(!def) return;
  unregisterCustomMob(id); saveEdits();
  edState.mobType='wolf';
  addFloater(player.x,player.y-30,'deleted custom mob: '+def.name);
}
function edExport(){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(worldEdits,null,1)],{type:'application/json'}));
  a.download='world_edits.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  addFloater(player.x,player.y-30,'exported world_edits.json — put it next to the game on the VPS to ship it');
}
function edImport(){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange=()=>{ const f=inp.files&&inp.files[0]; if(!f)return;
    f.text().then(txt=>{ JSON.parse(txt); localStorage.setItem(EDITS_KEY,txt); location.reload(); })
      .catch(()=>addFloater(player.x,player.y-30,'import failed: not valid JSON')); };
  inp.click();
}
function edOverPanel(sx,sy){
  return G.editorOpen&&sx>=ED_PANEL.x&&sx<=ED_PANEL.x+ED_PANEL.w&&sy>=ED_PANEL.y&&sy<=ED_PANEL.y+(ED_PANEL.h||300);
}
function editorUpdate(dt){
  updateWorldMouse();
  // free flight — no collision, fast; shift doubles speed
  const sp=(keys['shift']?2800:1400)*dt;
  let dx=0,dy=0;
  if(keys['w']||keys['arrowup'])dy-=1; if(keys['s']||keys['arrowdown'])dy+=1;
  if(keys['a']||keys['arrowleft'])dx-=1; if(keys['d']||keys['arrowright'])dx+=1;
  if (camAngle !== 0) {
    const rx = dx * Math.cos(camAngle) + dy * Math.sin(camAngle);
    const ry = dy * Math.cos(camAngle) - dx * Math.sin(camAngle);
    dx = rx; dy = ry;
  }
  if(dx||dy){const l=Math.hypot(dx,dy);player.x=Math.max(0,Math.min(MAP_W*TILE,player.x+dx/l*sp));player.y=Math.max(0,Math.min(MAP_H*TILE,player.y+dy/l*sp));}
  // pixel studio pen-drag (world painting pauses while it's open)
  if(G.pixelOpen&&mouse.down&&psTool==='pen'&&mouse.hasPos){
    const c=psPixelAt(mouse.sx,mouse.sy);
    if(c)psPen(c[0],c[1]);
  }
  // drag painting (map tab only; mob placement is click-by-click)
  const canPaint=edState.tab==='map'&&!edState.wiz&&!G.pixelOpen&&mouse.hasPos&&!edOverPanel(mouse.sx,mouse.sy);
  if(canPaint){
    if(mouse.down)edPaint(worldMouseX,worldMouseY,false);
    else if(rmb.down)edPaint(worldMouseX,worldMouseY,true);
  }
  // brush cursor: highlights exactly the tiles the brush will hit
  if(canPaint){
    const tx=Math.floor(worldMouseX/TILE), ty=Math.floor(worldMouseY/TILE);
    buildHighlight.position.set(tx*TILE+TILE/2, 1.5, ty*TILE+TILE/2);
    buildHighlight.scale.setScalar(edState.brush*2-1);
    const col=TILE_COLORS[edState.tile]||[255,255,255];
    buildHighlight.material.color.setRGB(col[0]/255,col[1]/255,col[2]/255);
    buildHighlight.material.opacity=0.5;
    buildHighlight.visible=true;
  } else buildHighlight.visible=false;
  edSaveT+=dt;
  if(edDirtySave&&edSaveT>0.8){saveEdits();edDirtySave=false;edSaveT=0;}
}
// ── Pixel Studio (Piskel-style texture editor) ────────────────────
// Edits the real production surfaces: 64×64 skins for the 3D meshes
// (wall/cave/rock/bridge/water) and TERR_PX ground stamps per tile type.
// Tools: pen, flood fill, eyedropper (RMB is always a quick dropper),
// brush size, 32-color palette, undo, copy-default, live apply.
const PS_PALETTE=[
  [230,57,70],[244,140,66],[249,220,92],[144,190,109],[67,160,71],[38,166,154],[41,128,185],[63,81,181],
  [142,68,173],[214,93,177],[236,240,241],[189,195,199],[127,140,141],[87,101,116],[45,52,54],[0,0,0],
  [79,122,58],[104,159,56],[156,123,79],[121,85,72],[93,64,55],[62,39,35],[111,106,99],[84,80,74],
  [54,48,44],[18,42,82],[44,91,138],[122,80,48],[74,46,16],[233,228,207],[201,178,127],[26,20,18],
];
let psKey=null, psSize=64, psCanvas=null, psColor=[79,122,58], psTool='pen', psBrush=1;
let psUndo=[], psHit=[], psGrid=null;
function skinKeys(){
  const ks=Object.entries(SKIN_TARGETS).map(([k,t])=>[k,t.label]);
  ks.push(['g'+T.GRASS,'Grass ground'],['g'+T.PATH,'Path ground'],['g'+T.CAVE_FLOOR,'Cave floor']);
  for(const ct of worldEdits.tiles) if(!ct.boxH) ks.push(['g'+ct.id,'✱'+ct.name+' ground']);
  return ks;
}
function skinLabel(key){ const f=skinKeys().find(k=>k[0]===key); return f?f[1]:key; }
function psLoadCurrent(){
  const x=psCanvas.getContext('2d'); x.imageSmoothingEnabled=false;
  if(SKIN_TARGETS[psKey]) x.drawImage(SKIN_TARGETS[psKey].tex.image,0,0,psSize,psSize);
  else{
    const tid=+psKey.slice(1);
    if(groundStamps[tid]) x.drawImage(groundStamps[tid],0,0);
    else{const c=TILE_COLORS[tid]||[0,0,0];x.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';x.fillRect(0,0,psSize,psSize);}
  }
}
function psLoadDefault(){
  const x=psCanvas.getContext('2d'); x.imageSmoothingEnabled=false;
  if(SKIN_TARGETS[psKey]) x.drawImage(_skinDefaults[psKey],0,0,psSize,psSize);
  else{
    const tid=+psKey.slice(1);
    const c=(customTileDefs[tid]&&customTileDefs[tid].color)||_defaultTileColors[tid]||[0,0,0];
    x.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';x.fillRect(0,0,psSize,psSize);
  }
}
function openPixelStudio(key){
  psKey=key; psSize=SKIN_TARGETS[key]?64:TERR_PX;
  psCanvas=document.createElement('canvas'); psCanvas.width=psCanvas.height=psSize;
  psLoadCurrent();
  psUndo=[]; psTool='pen'; psBrush=1; G.pixelOpen=true;
}
function psPushUndo(){
  psUndo.push(psCanvas.getContext('2d').getImageData(0,0,psSize,psSize));
  if(psUndo.length>30)psUndo.shift();
}
function psDoUndo(){ const id=psUndo.pop(); if(id)psCanvas.getContext('2d').putImageData(id,0,0); }
function psPixelAt(sx,sy){
  if(!psGrid)return null;
  const cx=Math.floor((sx-psGrid.x)/psGrid.cell), cy=Math.floor((sy-psGrid.y)/psGrid.cell);
  return (cx>=0&&cy>=0&&cx<psSize&&cy<psSize)?[cx,cy]:null;
}
function psPen(cx,cy){
  const x=psCanvas.getContext('2d');
  x.fillStyle='rgb('+psColor[0]+','+psColor[1]+','+psColor[2]+')';
  x.fillRect(cx-(psBrush>1?1:0),cy-(psBrush>1?1:0),psBrush,psBrush);
}
function psFill(cx,cy){
  const x=psCanvas.getContext('2d'),id=x.getImageData(0,0,psSize,psSize),d=id.data,s=psSize;
  const i0=(cy*s+cx)*4,tr=d[i0],tg=d[i0+1],tb=d[i0+2];
  if(tr===psColor[0]&&tg===psColor[1]&&tb===psColor[2])return;
  const st=[[cx,cy]];
  while(st.length){
    const[qx,qy]=st.pop();
    if(qx<0||qy<0||qx>=s||qy>=s)continue;
    const i=(qy*s+qx)*4;
    if(d[i]!==tr||d[i+1]!==tg||d[i+2]!==tb)continue;
    d[i]=psColor[0];d[i+1]=psColor[1];d[i+2]=psColor[2];d[i+3]=255;
    st.push([qx+1,qy],[qx-1,qy],[qx,qy+1],[qx,qy-1]);
  }
  x.putImageData(id,0,0);
}
function psPick(cx,cy){
  const d=psCanvas.getContext('2d').getImageData(cx,cy,1,1).data;
  psColor=[d[0],d[1],d[2]]; psTool='pen';
}
function renderPixelStudio(){
  const ctx=G.ctx, W=352, pad2=16;
  const gridPx=320, cell=Math.floor(gridPx/psSize), gw=cell*psSize;
  const H=30+30+gw+10+48+34+14;
  const {px,py}=panelAt('pixel', G.canvas.width-W-14, 90, W, H);
  psHit=[];
  const pbtn=(x,y2,w,h,label,active,fn)=>{
    ctx.fillStyle=active?'rgba(200,162,90,.9)':'rgba(55,45,28,.9)';
    ctx.fillRect(x,y2,w,h);
    ctx.strokeStyle='rgba(200,162,90,.5)';ctx.lineWidth=1;ctx.strokeRect(x,y2,w,h);
    ctx.fillStyle=active?'#1a1208':'#e8dcc0';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign='center';ctx.fillText(label,x+w/2,y2+h/2+4);ctx.textAlign='left';
    psHit.push({x,y:y2,w,h,fn});
  };
  ctx.fillStyle='rgba(16,12,8,.96)';ctx.fillRect(px,py,W,H);
  ctx.strokeStyle='#c8a25a';ctx.lineWidth=1.5;ctx.strokeRect(px,py,W,H);
  ctx.fillStyle='#c8a25a';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('PIXEL STUDIO — '+skinLabel(psKey),px+W/2,py+19);ctx.textAlign='left';
  let y=py+30;
  pbtn(px+pad2,y,44,20,'pen',psTool==='pen',()=>psTool='pen');
  pbtn(px+pad2+48,y,44,20,'fill',psTool==='fill',()=>psTool='fill');
  pbtn(px+pad2+96,y,44,20,'pick',psTool==='pick',()=>psTool='pick');
  if(psSize>=32){
    pbtn(px+pad2+148,y,30,20,'1px',psBrush===1,()=>psBrush=1);
    pbtn(px+pad2+182,y,30,20,'2px',psBrush===2,()=>psBrush=2);
  }
  pbtn(px+W-pad2-52,y,52,20,'undo',false,psDoUndo);
  // current color chip
  ctx.fillStyle='rgb('+psColor[0]+','+psColor[1]+','+psColor[2]+')';
  ctx.fillRect(px+W-pad2-80,y,22,20);
  ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.strokeRect(px+W-pad2-80,y,22,20);
  y+=30;
  // grid
  const gx=px+pad2, gy=y;
  psGrid={x:gx,y:gy,cell};
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(psCanvas,gx,gy,gw,gw);
  ctx.imageSmoothingEnabled=true;
  ctx.strokeStyle='rgba(200,162,90,.6)';ctx.lineWidth=1;ctx.strokeRect(gx-1,gy-1,gw+2,gw+2);
  ctx.strokeStyle='rgba(0,0,0,.25)';
  const step=psSize>=32?8:1;
  for(let i=step;i<psSize;i+=step){
    ctx.beginPath();ctx.moveTo(gx+i*cell,gy);ctx.lineTo(gx+i*cell,gy+gw);ctx.stroke();
    ctx.beginPath();ctx.moveTo(gx,gy+i*cell);ctx.lineTo(gx+gw,gy+i*cell);ctx.stroke();
  }
  y+=gw+10;
  // palette 2×16
  for(let i=0;i<PS_PALETTE.length;i++){
    const c=PS_PALETTE[i], sx2=px+pad2+(i%16)*20, sy2=y+Math.floor(i/16)*22;
    ctx.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';ctx.fillRect(sx2,sy2,18,19);
    const sel=psColor[0]===c[0]&&psColor[1]===c[1]&&psColor[2]===c[2];
    ctx.strokeStyle=sel?'#ffe866':'rgba(0,0,0,.6)';ctx.lineWidth=sel?2:1;ctx.strokeRect(sx2,sy2,18,19);
    psHit.push({x:sx2,y:sy2,w:18,h:19,fn:()=>{psColor=c.slice();if(psTool==='pick')psTool='pen';}});
  }
  y+=48;
  pbtn(px+pad2,y,92,22,'copy default',false,()=>{psPushUndo();psLoadDefault();});
  pbtn(px+pad2+98,y,72,22,'apply ✔',true,()=>{applySkin(psKey,psCanvas,true);addFloater(player.x,player.y-30,'skin applied: '+skinLabel(psKey));});
  pbtn(px+pad2+176,y,64,22,'reset',false,()=>{resetSkin(psKey);psLoadCurrent();psUndo=[];});
  pbtn(px+W-pad2-56,y,56,22,'close',false,()=>G.pixelOpen=false);
  ctx.fillStyle='rgba(232,220,192,.55)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(psSize+'×'+psSize+' · RMB = eyedropper · apply → live in world',px+pad2,y+34);
}

function renderEditorPanel(){
  const ctx=G.ctx,P=ED_PANEL,pad=8;
  edHit=[];
  const btn=(x,y,w,h,label,active,fn,col)=>{
    ctx.fillStyle=active?'rgba(200,162,90,.85)':'rgba(60,48,30,.85)';
    ctx.fillRect(x,y,w,h);
    ctx.strokeStyle='rgba(200,162,90,.5)';ctx.lineWidth=1;ctx.strokeRect(x,y,w,h);
    ctx.fillStyle=active?'#1a1208':(col||'#e8dcc0');
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText(label,x+w/2,y+h/2+4);ctx.textAlign='left';
    edHit.push({x,y,w,h,fn});
  };
  // measure height first
  const tiles=edTileList(), mobs=edMobList();
  const tileRows=Math.ceil(tiles.length/2), mobRows=Math.ceil(mobs.length/2);
  const isCustomSel=!!customMobDefs[edState.mobType];
  let H=30+24+8;                                     // header + tabs
  if(edState.wiz==='tile') H+=16+2*22+26+26+26+10;
  else if(edState.wiz==='mob') H+=16+mobRows*20+10+2*22+26+26+26+10;
  else if(edState.tab==='map') H+=tileRows*22+8+26+30+20;
  else if(edState.tab==='skins') H+=skinKeys().length*20+26;
  else H+=24+mobRows*20+26+(edState.mobMode==='stats'?ED_STATS.length*22+(isCustomSel?24:0)+8:26)+8;
  H+=30+24+34;                                          // footer + standalone button + info
  P.h=H;
  const edPos=panelAt('editor', 10, 150, P.w, H);    // draggable like all panels
  P.x=edPos.px; P.y=edPos.py;
  ctx.fillStyle='rgba(18,13,8,.94)';ctx.fillRect(P.x,P.y,P.w,H);
  ctx.strokeStyle='#c8a25a';ctx.lineWidth=1.5;ctx.strokeRect(P.x,P.y,P.w,H);
  ctx.fillStyle='#c8a25a';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('WORLD EDITOR  ·  F2',P.x+P.w/2,P.y+18);ctx.textAlign='left';
  let y=P.y+30;
  btn(P.x+pad,y,58,20,'Map',edState.tab==='map'&&!edState.wiz,()=>{edState.tab='map';edState.wiz=null;});
  btn(P.x+pad+62,y,58,20,'Mobs',edState.tab==='mobs'&&!edState.wiz,()=>{edState.tab='mobs';edState.wiz=null;});
  btn(P.x+pad+124,y,58,20,'Skins',edState.tab==='skins'&&!edState.wiz,()=>{edState.tab='skins';edState.wiz=null;});
  y+=30;
  const label=(txt,dy)=>{ctx.fillStyle='#c8a25a';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(txt,P.x+pad,y+dy);};
  const palette=(sel,setFn)=>{           // 8×2 color swatch grid, returns rows height
    for(let i=0;i<ED_COLORS.length;i++){
      const c=ED_COLORS[i], bx=P.x+pad+(i%8)*23, by=y+Math.floor(i/8)*22;
      ctx.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';ctx.fillRect(bx,by,20,19);
      ctx.strokeStyle=sel===i?'#ffe866':'rgba(0,0,0,.6)';ctx.lineWidth=sel===i?2:1;
      ctx.strokeRect(bx,by,20,19);
      edHit.push({x:bx,y:by,w:20,h:19,fn:()=>setFn(i)});
    }
    return 2*22;
  };
  if(edState.wiz==='tile'){
    label('NEW TILE — pick a color',12); y+=16;
    y+=palette(edState.wt.ci,i=>edState.wt.ci=i);
    btn(P.x+pad,y,88,20,'blocks: '+(edState.wt.blocking?'yes':'no'),edState.wt.blocking,()=>edState.wt.blocking=!edState.wt.blocking);
    y+=26;
    ED_HEIGHTS.forEach(([hn],i)=>btn(P.x+pad+i*62,y,58,20,hn,edState.wt.hi===i,()=>edState.wt.hi=i));
    y+=26;
    btn(P.x+pad,y,88,20,'✔ Create',true,edCreateTile);
    btn(P.x+P.w-pad-88,y,88,20,'Cancel',false,()=>edState.wiz=null);
    y+=36;
  } else if(edState.wiz==='mob'){
    label('NEW MOB — pick a base (AI + model)',12); y+=16;
    for(let i=0;i<mobs.length;i++){
      const m=mobs[i], bx=P.x+pad+(i%2)*94, by=y+Math.floor(i/2)*20;
      btn(bx,by,90,17,edMobLabel(m).slice(0,11),edState.wm.base===m,()=>edState.wm.base=m);
    }
    y+=mobRows*20+10;
    y+=palette(edState.wm.ci,i=>edState.wm.ci=i);
    ED_SIZES.forEach(([sn],i)=>btn(P.x+pad+i*47,y,43,20,sn,edState.wm.si===i,()=>edState.wm.si=i));
    y+=26;
    btn(P.x+pad,y,120,20,'spawns in: '+(edState.wm.cave?'caves':'grass'),edState.wm.cave,()=>edState.wm.cave=!edState.wm.cave);
    y+=26;
    btn(P.x+pad,y,88,20,'✔ Create',true,edCreateMob);
    btn(P.x+P.w-pad-88,y,88,20,'Cancel',false,()=>edState.wiz=null);
    y+=36;
  } else if(edState.tab==='map'){
    for(let i=0;i<tiles.length;i++){
      const [t,name]=tiles[i], col=TILE_COLORS[t]||[0,0,0];
      const bx=P.x+pad+(i%2)*94, by=y+Math.floor(i/2)*22;
      const active=edState.tile===t;
      ctx.fillStyle=active?'rgba(200,162,90,.85)':'rgba(60,48,30,.85)';
      ctx.fillRect(bx,by,90,19);
      ctx.fillStyle='rgb('+col[0]+','+col[1]+','+col[2]+')';ctx.fillRect(bx+3,by+3,13,13);
      ctx.strokeStyle='rgba(0,0,0,.5)';ctx.strokeRect(bx+3,by+3,13,13);
      ctx.fillStyle=active?'#1a1208':'#e8dcc0';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText((t>=100?'✱':'')+name,bx+20,by+13);
      edHit.push({x:bx,y:by,w:90,h:19,fn:()=>edState.tile=t});
    }
    y+=tileRows*22+8;
    btn(P.x+pad,y,184,20,'+ New tile type…',false,()=>edState.wiz='tile');
    y+=26;
    ctx.fillStyle='#c8a25a';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText('brush',P.x+pad,y+12);
    [1,2,3].forEach((b,i)=>btn(P.x+pad+40+i*36,y,32,18,(b*2-1)+'×'+(b*2-1),edState.brush===b,()=>edState.brush=b));
    y+=30;
    ctx.fillStyle='rgba(232,220,192,.6)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText('LMB paint · RMB erase→grass',P.x+pad,y+8);
    y+=20;
  } else if(edState.tab==='skins'){
    const ks=skinKeys();
    for(let i=0;i<ks.length;i++){
      btn(P.x+pad,y+i*20,184,17,ks[i][1].slice(0,22),G.pixelOpen&&psKey===ks[i][0],()=>openPixelStudio(ks[i][0]));
    }
    y+=ks.length*20+4;
    ctx.fillStyle='rgba(232,220,192,.6)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText('pick a surface to paint its pixels',P.x+pad,y+10);
    y+=22;
  } else {
    btn(P.x+pad,y,88,20,'Place',edState.mobMode==='place',()=>edState.mobMode='place');
    btn(P.x+P.w-pad-88,y,88,20,'Stats',edState.mobMode==='stats',()=>edState.mobMode='stats');
    y+=24;
    for(let i=0;i<mobs.length;i++){
      const m=mobs[i], bx=P.x+pad+(i%2)*94, by=y+Math.floor(i/2)*20;
      btn(bx,by,90,17,(customMobDefs[m]?'✱':'')+edMobLabel(m).slice(0,11),edState.mobType===m,()=>edState.mobType=m);
    }
    y+=mobRows*20+4;
    btn(P.x+pad,y,184,20,'+ New mob type…',false,()=>edState.wiz='mob');
    y+=26;
    if(edState.mobMode==='stats'){
      const cfg=ENEMY_CFG[edState.mobType]||{};
      for(const [stat,label2,step,min] of ED_STATS){
        const v=stat==='aggroRange'?((cfg[stat]||0)/TILE).toFixed(1)+'t':cfg[stat];
        ctx.fillStyle='#e8dcc0';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
        ctx.fillText(label2,P.x+pad,y+13);
        btn(P.x+P.w-pad-92,y,20,18,'−',false,()=>edTuneStat(stat,-step,min));
        ctx.fillStyle='#ffd97a';ctx.textAlign='center';
        ctx.fillText(String(v),P.x+P.w-pad-46,y+13);ctx.textAlign='left';
        btn(P.x+P.w-pad-20,y,20,18,'+',false,()=>edTuneStat(stat,step,min));
        y+=22;
      }
      if(isCustomSel){
        btn(P.x+pad,y,184,18,'✕ delete '+edMobLabel(edState.mobType).slice(0,10),false,()=>edDeleteMob(edState.mobType));
        y+=24;
      }
      y+=8;
    } else {
      ctx.fillStyle='rgba(232,220,192,.6)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText('LMB place spawn · RMB remove',P.x+pad,y+12);
      y+=26;
    }
  }
  btn(P.x+pad,y,56,20,'Export',false,edExport);
  btn(P.x+pad+62,y,56,20,'Import',false,edImport);
  btn(P.x+pad+124,y,56,20,edState.resetArmed?'SURE?':'Reset',edState.resetArmed,()=>{
    if(edState.resetArmed){localStorage.removeItem(EDITS_KEY);location.reload();}
    else{edState.resetArmed=true;setTimeout(()=>edState.resetArmed=false,2500);}
  });
  y+=24;
  btn(P.x+pad,y,180,20,'🚀 Standalone Editor',true,()=>window.open('editor.html','_blank'));
  y+=30;
  const htx=Math.floor(worldMouseX/TILE),hty=Math.floor(worldMouseY/TILE);
  const ht=(map[hty]&&map[hty][htx]!==undefined)?(edTileList().find(e2=>e2[0]===map[hty][htx])||[0,'?'])[1]:'—';
  ctx.fillStyle='rgba(232,220,192,.75)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('tile '+htx+','+hty+' = '+ht,P.x+pad,y+4);
  ctx.fillText(worldEdits.spawns.length+' spawns · '+Object.keys(worldEdits.map).length+' tile edits',P.x+pad,y+17);
  // markers over custom spawns
  ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  for(const s of worldEdits.spawns){
    const sc=worldToScreen(s.x*TILE+TILE/2,s.y*TILE+TILE/2,6);
    if(sc.x<-20||sc.x>G.canvas.width+20||sc.y<-20||sc.y>G.canvas.height+20)continue;
    ctx.fillStyle='rgba(255,80,80,.9)';
    ctx.beginPath();ctx.moveTo(sc.x,sc.y-7);ctx.lineTo(sc.x+6,sc.y);ctx.lineTo(sc.x,sc.y+7);ctx.lineTo(sc.x-6,sc.y);ctx.closePath();ctx.fill();
    ctx.fillStyle='#fff';ctx.fillText(edMobLabel(s.t)[0].toUpperCase(),sc.x,sc.y+3);
  }
  ctx.textAlign='left';
}

// ── Tutorial window ───────────────────────────────────────────────
// Opens automatically on first launch; T (or the ? touch button)
// reopens it any time. Paged: Basics / Survive / Town / Adventure.
const TUT_SEEN_KEY='bravoTutorialSeen_v1';
const TUT_PAGES=[
  {title:'BASICS — MOVING & FIGHTING', rows:[
    ['WASD','move (arrow keys work too)'],
    ['LMB','attack / chop / mine what you aim at'],
    ['Space','special attack — Power Strike (Tactics 2)'],
    ['','or Multishot (Archery 2); 8s cooldown'],
    ['X','AGGRO MODE (war mode) — auto-attack any'],
    ['','enemy in reach; click the ⚔ button too'],
    ['V','auto-defend on/off — you strike back when'],
    ['','mobs jump you (even draws your sword)'],
    ['RMB','hold to walk toward the cursor'],
    ['Q','swap tool: axe → pickaxe → sword → bow'],
    ['scroll','zoom the camera (pinch on phone)'],
    ['MMB drag','orbit the camera — spin left/right, tilt'],
    ['','from ground level up to straight overhead'],
    [', / .','spin the camera left / right from the keyboard'],
    ['[ / ]','camera: first person · over the shoulder ·'],
    ['','third person · isometric · far · top down'],
    ['','(first person locks the mouse to look; Esc frees it)'],
    ['drag','pull bag items onto the hotbar, another'],
    ['','cell to rearrange, or the world to drop them'],
    ['','(Shift = drop whole stack; drag a hotbar'],
    ['','slot off the bar to unbind it)'],
    ['M','map — drag its corner to resize, scroll to zoom'],
    ['Shift','hold to run'],
    ['W W / S S','double-tap forward or back to run (while held)'],
    ['','(release the key and you walk again)'],
    ['Ctrl+S','save your game'],
    ['N','mute / unmute sound'],
    ['',''],
    ['📱','on phones: left thumb = move stick,'],
    ['','right side = attack, buttons on the right edge'],
    ['',''],
    ['Esc','settings — field of view, draw distance,'],
    ['','mouse sensitivity, nameplates, volume, and'],
    ['','rebindable keys. The keys listed here are the'],
    ['','defaults; Settings › Keybinds shows yours.'],
  ]},
  {title:'SURVIVE & CRAFT', rows:[
    ['axe','chop trees for wood'],
    ['pickaxe','mine grey rocks for stone (craft it first)'],
    ['C','crafting: wood → planks → sword, bow, walls…'],
    ['I','paper doll — armor slots (head/chest/legs/'],
    ['','boots): leather → bone → bronze → steel'],
    ['◉ wheel','hold the wheel button, flick to a wedge,'],
    ['','release to cast (attack/heal/hide…) — mobile'],
    ['Y','gambits — auto-combat rules (if HP low →'],
    ['','potion, if enemy near → war mode, etc.)'],
    ['B','bandage — heals you over 3 seconds'],
    ['P','drink a healing potion (+50 HP)'],
    ['H','hide — enemies lose sight of you'],
    ['F','wrestle — stuns the nearest enemy'],
    ['',''],
    ['💀','if you die you become a ghost: walk to a'],
    ['','healer (green cross on map), press E to revive,'],
    ['','then return to your corpse and loot it back'],
  ]},
  {title:'TOWN & GOLD', rows:[
    ['E','talk / trade with any NPC you stand next to'],
    ['','merchant — buy & sell goods'],
    ['','banker — store your gold safely'],
    ['','blacksmith — weapons & armor'],
    ['','mage — healing potions'],
    ['','farrier — a horse! (R to mount, 2.2× speed)'],
    ['','antiquarian (💎 map) — spend champion relics'],
    ['','   on powerful artifacts'],
    ['','museum curator (★ map) — fulfill artifact bounties'],
    ['','cryptologist — decode ancient glyphs & lore'],
    ['','grave robber — underground treasures & deals'],
    ['G','call the city guards for help'],
    ['K','skills — they level up as you use them'],
    ['',''],
    ['💰','enemies drop gold & hides — sell what you'],
    ['','don\'t need, bank what you don\'t carry'],
  ]},
  {title:'ADVENTURE & PROGRESSION', rows:[
    ['J','quest journal — the tracker (bottom-left)'],
    ['','always shows your next goal; quests teach'],
    ['','every mechanic and pay rewards'],
    ['🏆','achievements — 15 permanent milestones'],
    ['','  toast appears top-right when one is earned'],
    ['⛩','champion altars (purple shrines): stand close'],
    ['','to awaken them — kill waves, light candles,'],
    ['','climb tiers — the boss drops STEEL weapons'],
    ['🕳','the Rat Dungeon: enter the glowing portal at'],
    ['','the cave on the south road — staged waves!'],
    ['F2','world editor — paint the map, place mobs,'],
    ['','create your own tiles and monsters'],
  ]},
  {title:'HOUSING & DEV COMMANDS', rows:[
    ['Q / cycle','select the Housing Tool to open menu'],
    ['LMB (place)','select house, WASD fly camera, LMB to build'],
    ['click door','open / close your house door (blocks entry)'],
    ['E (at sign)','open House Settings at the front-yard sign'],
    ['','- Toggle Privacy: Public (green) / Private (red)'],
    ['','- Access Checkboxes: Grant/deny friends entry'],
    ['Safety','House walls are protected from dismantling'],
    ['` (backtick)','open DEV GUI panel for visual cheats'],
    ['F12 console','supports: giveGold, givePlanks, giveStone,'],
    ['','teleportTo(tx, ty), godMode(), spawnEnemy(type)'],
    ['','(run "dev.help()" for details)'],
  ]},
];
let tutPage=0, tutHit=[];
function closeTutorial(){
  G.tutorialOpen=false;
  try{ localStorage.setItem(TUT_SEEN_KEY,'1'); }catch(_){}
}
function renderTutorialPanel(){
  const ctx=G.ctx, W=400, rowH=17;
  const page=TUT_PAGES[tutPage];
  const H=46+34+page.rows.length*rowH+46;
  const {px,py}=panelAt('tutorial', Math.round(G.canvas.width/2-W/2), Math.round(G.canvas.height/2-H/2), W, H);
  tutHit=[];
  ctx.fillStyle='rgba(14,16,10,.96)';ctx.fillRect(px,py,W,H);
  ctx.strokeStyle='#8fb85a';ctx.lineWidth=1.5;ctx.strokeRect(px,py,W,H);
  ctx.fillStyle='#b8d878';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('HOW TO PLAY  ·  T to close',px+W/2,py+20);
  // live readout strip (used to crowd the corner HUD — now lives here)
  ctx.fillStyle='rgba(50,60,36,.5)';ctx.fillRect(px+8,py+27,W-16,30);
  ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='#e8dcc0';
  const wlab=player.weapon?player.weapon.replace('_',' '):'unarmed';
  ctx.fillText('📍 tile '+Math.floor(player.x/TILE)+','+Math.floor(player.y/TILE)+'   ⚔ '+wlab+'   🪙 '+inv.gold+'g',px+W/2,py+38);
  ctx.fillText('🪵 '+inv.wood+'  🪨 '+inv.stone+'  ▤ '+inv.planks+'  ➶ '+inv.arrows+'  🟫 '+inv.hide+'  ✚ '+inv.bandages+'  ⚗ '+inv.potions,px+W/2,py+51);
  ctx.fillStyle='#8fb85a';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(page.title,px+W/2,py+72);ctx.textAlign='left';
  let y=py+90;
  for(const [k,d] of page.rows){
    if(k){ctx.fillStyle='#ffd97a';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';
      ctx.textAlign='right';ctx.fillText(k,px+86,y);ctx.textAlign='left';}
    ctx.fillStyle='rgba(230,238,210,.88)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(d,px+96,y);
    y+=rowH;
  }
  // nav: prev / page dots / next / close
  const ny=py+H-32;
  const tbtn=(x,w,label,fn,accent)=>{
    ctx.fillStyle=accent?'rgba(143,184,90,.85)':'rgba(50,60,36,.9)';
    ctx.fillRect(x,ny,w,22);
    ctx.strokeStyle='rgba(143,184,90,.5)';ctx.lineWidth=1;ctx.strokeRect(x,ny,w,22);
    ctx.fillStyle=accent?'#141a0a':'#d8e8b8';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign='center';ctx.fillText(label,x+w/2,ny+15);ctx.textAlign='left';
    tutHit.push({x,y:ny,w,h:22,fn});
  };
  if(tutPage>0) tbtn(px+10,70,'◀ back',()=>tutPage--);
  if(tutPage<TUT_PAGES.length-1) tbtn(px+W-150,70,'next ▶',()=>tutPage++);
  tbtn(px+W-72,62,tutPage===TUT_PAGES.length-1?'done ✔':'close',closeTutorial,tutPage===TUT_PAGES.length-1);
  ctx.fillStyle='rgba(184,216,120,.8)';ctx.textAlign='center';
  ctx.fillText((tutPage+1)+' / '+TUT_PAGES.length,px+W/2-18,ny+15);ctx.textAlign='left';
  // rescue: teleport to the city if stuck (5-min cooldown)
  const sy=ny-30, cd=unstuckCooldownLeft();
  ctx.fillStyle=cd>0?'rgba(60,45,30,.85)':'rgba(150,70,30,.9)';
  ctx.fillRect(px+10,sy,W-20,24);
  ctx.strokeStyle=cd>0?'rgba(120,90,60,.5)':'#e0a050';ctx.lineWidth=1;ctx.strokeRect(px+10,sy,W-20,24);
  ctx.fillStyle=cd>0?'#a89878':'#ffe0b0';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText(cd>0?('🆘 Stuck? — cooldown '+cd+'s'):'🆘 STUCK? — teleport to the city',px+W/2,sy+16);ctx.textAlign='left';
  if(cd<=0) tutHit.push({x:px+10,y:sy,w:W-20,h:24,fn:doUnstuck});
}
function unstuckCooldownLeft(){
  const el=performance.now()-(G.unstuckAt||-1e9);
  return el<300000&&G.unstuckAt?Math.ceil((300000-el)/1000):0;
}
function doUnstuck(){
  if(unstuckCooldownLeft()>0) return;
  G.unstuckAt=performance.now();
  player.x=305*TILE+TILE/2; player.y=351*TILE+TILE/2;   // Lunar city square
  if(player.onHorse){ player.onHorse=false; player.horseDown=false; }
  netTp('unstuck');
  closeTutorial();
  addFloater(player.x,player.y-30,'🆘 rescued to the city!');
  snd.heal();
}

// ── Paper doll (I) — artwork panel, movable + corner-resizable ─────
// Male/female art with 12 slot frames; armor/weapon/artifacts render
// into the frames. Frame interiors below are in 1408×768 art space.
const DOLL_SLOTS={
  main:[70,269,222,498], off:[1190,269,1342,498],
  headLab:[295,53,433,202], head:[522,52,661,193], neck:[750,52,889,193],
  armL:[295,232,433,379], torso:[634,252,774,397], armR:[975,232,1113,379],
  ring1:[295,410,433,557], ring2:[975,410,1113,557],
  brac1:[295,588,433,735], legs:[522,588,661,735], feet:[750,588,889,735], brac2:[975,588,1113,735],
};
const DOLL_ARMOR_MAP={head:'head',headLab:'head',torso:'chest',legs:'legs',feet:'boots'};
const DOLL_STRIP=26;                       // stat strip under the artwork
let dollResize=null;
function dollScale(){ return (panelOfs.doll&&panelOfs.doll.s)||1; }
function dollRect(){
  const s=dollScale(), W=Math.round(620*s), H=Math.round(620*s*768/1408)+DOLL_STRIP;
  const {px,py}=panelAt('doll', G.canvas.width-W-16, 90, W, H);
  return {px,py,W,H,s,ah:H-DOLL_STRIP};
}
function dollSlotScreen(key){
  const {px,py,W,ah}=dollRect(),r=DOLL_SLOTS[key];
  return {x:px+r[0]/1408*W, y:py+r[1]/768*ah, w:(r[2]-r[0])/1408*W, h:(r[3]-r[1])/768*ah};
}
function dollGenderBtn(){const{px,py}=dollRect();return{x:px+8,y:py+30,w:40,h:20};}
// jewelry picker: G.dollPick = slotKey while choosing what to equip
function dollPickList(){
  if(!G.dollPick)return[];
  const type=ARTIFACT_SLOT_TYPE[G.dollPick];
  return player.artifactInv.map((it,idx)=>({it,idx})).filter(r=>r.it.identified&&artifactDef(r.it.defId)&&artifactDef(r.it.defId).slot===type);
}
function dollPickRect(){
  const{px,py}=dollRect(),n=Math.max(1,dollPickList().length);
  const w=250,h=34+n*32+8;
  return {x:Math.max(8,px-w-6),y:py+40,w,h};
}
function renderPaperDoll(){
  const ctx=G.ctx,{px,py,W,H,ah}=dollRect();
  const art=GUI[player.dollGender==='f'?'dollF':'dollM'];
  ctx.fillStyle='rgba(14,12,18,.97)';ctx.fillRect(px,py,W,H);
  if(art.ok)ctx.drawImage(art.img,px,py,W,ah);
  ctx.strokeStyle='#c8a25a';ctx.lineWidth=1.5;ctx.strokeRect(px,py,W,H);
  const fpx=n=>Math.max(8,Math.round(n*W/620));
  const mono=n=>'bold '+fpx(n)+'px ui-monospace,Menlo,Consolas,monospace';
  // armor pieces (head/torso/legs/feet): tinted wash + material tag
  for(const k of['head','torso','legs','feet']){
    const r=dollSlotScreen(k),m=player.armor[DOLL_ARMOR_MAP[k]]||0;
    if(!m)continue;
    ctx.fillStyle=ARMOR_COLS[m];ctx.globalAlpha=0.22;ctx.fillRect(r.x+2,r.y+2,r.w-4,r.h-4);ctx.globalAlpha=1;
    const th=fpx(14);
    ctx.fillStyle=ARMOR_COLS[m];ctx.fillRect(r.x+3,r.y+r.h-th-3,r.w-6,th);
    ctx.fillStyle='#16100a';ctx.font=mono(9);ctx.textAlign='center';
    ctx.fillText(ARMOR_MATS[m]+' +'+Math.round(ARMOR_DR[m]*100)+'%',r.x+r.w/2,r.y+r.h-th/2+fpx(3)-3);
  }
  // main hand: current weapon (click cycles owned weapons)
  {
    const r=dollSlotScreen('main'),w=HOTBAR_WEAPONS[player.weapon];
    if(w){
      const sz=Math.min(r.w,r.h)*0.74;
      if(!drawSprite(WEAPON_SPR[player.weapon],r.x+(r.w-sz)/2,r.y+(r.h-sz)/2-fpx(6),sz,sz)){
        ctx.font=Math.round(sz*0.55)+'px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
        ctx.fillText(w.icon,r.x+r.w/2,r.y+r.h/2);
      }
      const wTier=player.weapon==='sword'?(player.swordTier||1):player.weapon==='bow'?(player.bowTier||1):1;
      ctx.fillStyle='#f0d878';ctx.font=mono(9);ctx.textAlign='center';
      ctx.fillText((wTier>1?TIER_NAMES[wTier]+' ':'')+w.label,r.x+r.w/2,r.y+r.h-fpx(6));
    }
  }
  // jewelry slots (artifacts)
  for(const sk of ARTIFACT_SLOTS){
    const r=dollSlotScreen(sk),id=player.equippedArtifacts[sk];
    if(!id)continue;
    const def=artifactDef(id);
    ctx.fillStyle='rgba(154,106,208,.20)';ctx.fillRect(r.x+2,r.y+2,r.w-4,r.h-4);
    ctx.font=Math.round(r.h*0.4)+'px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText(def.icon,r.x+r.w/2,r.y+r.h*0.52);
    ctx.fillStyle='#e0c8ff';ctx.font=mono(8);
    ctx.fillText(def.name,r.x+r.w/2,r.y+r.h-fpx(6));
    ctx.strokeStyle='rgba(192,144,240,.85)';ctx.lineWidth=1.5;ctx.strokeRect(r.x+1.5,r.y+1.5,r.w-3,r.h-3);
  }
  // header: character name, race, & gender toggle
  const raceData = RACES[player.race] || RACES.Human;
  const str = (player.stats?.str || 10) + (raceData.bonus.str || 0);
  const dex = (player.stats?.dex || 10) + (raceData.bonus.dex || 0);
  const int = (player.stats?.int || 10) + (raceData.bonus.int || 0);
  const vit = (player.stats?.vit || 10) + (raceData.bonus.vit || 0);
  ctx.fillStyle='rgba(0,0,0,.55)';ctx.font=mono(11);ctx.textAlign='center';
  ctx.fillText(`${raceData.icon} ${player.name} (${player.race}) · S:${str} D:${dex} I:${int} V:${vit}`,px+W/2+1,py+fpx(16)+1);
  ctx.fillStyle='#f0d8a0';
  ctx.fillText(`${raceData.icon} ${player.name} (${player.race}) · S:${str} D:${dex} I:${int} V:${vit}`,px+W/2,py+fpx(16));
  const gb=dollGenderBtn();
  ctx.fillStyle='rgba(20,14,26,.85)';ctx.fillRect(gb.x,gb.y,gb.w,gb.h);
  ctx.strokeStyle='rgba(200,162,90,.7)';ctx.lineWidth=1;ctx.strokeRect(gb.x,gb.y,gb.w,gb.h);
  ctx.fillStyle='#e8dcc0';ctx.font=mono(11);ctx.fillText(player.dollGender==='f'?'♀ / ♂':'♂ / ♀',gb.x+gb.w/2,gb.y+15);
  // bottom stat strip
  const sy=py+ah,b=player.artifactBonus||{};
  ctx.fillStyle='rgba(10,8,14,.95)';ctx.fillRect(px,sy,W,DOLL_STRIP);
  const parts=['armor '+Math.round(armorDR()*100)+'%'];
  if(b.maxHp)parts.push('+'+b.maxHp+' hp');
  const swB=(b.swordDmg||0)+(b.allDmg||0),arB=(b.arrowDmg||0)+(b.allDmg||0);
  if(swB)parts.push('+'+Math.round(swB*100)+'% sword');
  if(arB)parts.push('+'+Math.round(arB*100)+'% arrow');
  if(b.xpMult)parts.push('+'+Math.round(b.xpMult*100)+'% xp');
  if(b.autoRevive)parts.push('☥ death ward');
  ctx.fillStyle='#8fd88f';ctx.font=mono(10);ctx.textAlign='center';
  ctx.fillText(parts.join('  ·  '),px+W/2,sy+DOLL_STRIP/2+fpx(4));
  // resize handle
  ctx.fillStyle='rgba(200,162,90,.75)';ctx.fillRect(px+W-9,py+H-9,9,9);
  ctx.textAlign='left';
  // jewelry picker popup
  if(G.dollPick){
    const pr=dollPickRect(),list=dollPickList();
    ctx.fillStyle='rgba(16,10,22,.97)';ctx.fillRect(pr.x,pr.y,pr.w,pr.h);
    ctx.strokeStyle='#9a6ad0';ctx.lineWidth=1.5;ctx.strokeRect(pr.x,pr.y,pr.w,pr.h);
    ctx.fillStyle='#c090f0';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText('Equip '+ARTIFACT_SLOT_LABEL[G.dollPick],pr.x+pr.w/2,pr.y+20);
    ctx.textAlign='left';
    if(!list.length){
      ctx.fillStyle='rgba(200,180,220,.55)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText('none held — click away to close',pr.x+10,pr.y+52);
    }else list.forEach((r,i)=>{
      const ry=pr.y+34+i*32;
      ctx.fillStyle='rgba(40,25,55,.85)';ctx.fillRect(pr.x+6,ry,pr.w-12,28);
      ctx.strokeStyle='rgba(120,70,170,.5)';ctx.lineWidth=1;ctx.strokeRect(pr.x+6,ry,pr.w-12,28);
      const def=artifactDef(r.it.defId);
      ctx.fillStyle='#e0c8ff';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(def.icon+' '+def.name,pr.x+12,ry+12);
      ctx.fillStyle='rgba(200,180,220,.65)';ctx.font='9px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(def.desc,pr.x+12,ry+23);
    });
  }
}
function handleDollClick(e){
  const {px,py,W,H}=dollRect();
  const hit=r=>e.clientX>=r.x&&e.clientX<=r.x+r.w&&e.clientY>=r.y&&e.clientY<=r.y+r.h;
  if(G.dollPick){
    const pr=dollPickRect(),list=dollPickList();
    if(hit(pr)){
      const i=Math.floor((e.clientY-(pr.y+34))/32);
      if(i>=0&&i<list.length)equipArtifact(list[i].idx,G.dollPick);
      G.dollPick=null;return true;
    }
    G.dollPick=null;                        // click elsewhere closes the picker
  }
  if(e.clientX<px||e.clientX>px+W||e.clientY<py||e.clientY>py+H)return false;
  if(hit(dollGenderBtn())){player.dollGender=player.dollGender==='m'?'f':'m';saveGame(true);return true;}
  const at=k=>hit(dollSlotScreen(k));
  if(at('main')){                           // cycle owned weapons
    const list=Object.keys(HOTBAR_WEAPONS).filter(id=>player[HOTBAR_WEAPONS[id].pkey]);
    if(list.length>1){player.weapon=list[(list.indexOf(player.weapon)+1)%list.length];snd.craft();}
    return true;
  }
  for(const sk of ARTIFACT_SLOTS)if(at(sk)){
    if(player.equippedArtifacts[sk])unequipArtifact(sk);
    else G.dollPick=sk;
    return true;
  }
  for(const k of['head','headLab','torso','legs','feet'])if(at(k)){
    const sl=DOLL_ARMOR_MAP[k],m=player.armor[sl]||0;
    addFloater(player.x,player.y-30,sl+': '+(m?ARMOR_MATS[m]+' (+'+Math.round(ARMOR_DR[m]*100)+'%)':'empty — craft leather (C) or visit the smith'));
    return true;
  }
  for(const k of['armL','armR','off'])if(at(k)){addFloater(player.x,player.y-30,'coming soon');return true;}
  return true;                              // swallow other clicks on the panel
}

// ── Radial menu drawing ───────────────────────────────────────────
function drawRadialButton(){
  if(radialHidden()||uiBlocking()||player.dead)return;
  const ctx=G.ctx,b=radialBtn();
  ctx.fillStyle=radialDrag?'rgba(90,150,120,.92)':radial.open?'rgba(120,90,160,.9)':'rgba(30,24,40,.7)';
  ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle=radialDrag?'rgba(140,240,190,.95)':'rgba(190,150,240,.85)';ctx.lineWidth=2;ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.stroke();
  if(radialDrag){   // repositioning: show it's grabbed
    ctx.fillStyle='rgba(200,255,225,.9)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText('drop to place',b.x,b.y+b.r+14);ctx.textAlign='left';
  }
  ctx.fillStyle='#e8dcf0';ctx.font='bold 20px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('◉',b.x,b.y+7);ctx.textAlign='left';
}
function drawRadial(){
  const ctx=G.ctx,n=radialWedges.length,R=radial.r,cx=radial.cx,cy=radial.cy;
  ctx.save();
  ctx.fillStyle='rgba(10,8,16,.55)';ctx.fillRect(0,0,G.canvas.width,G.canvas.height);
  for(let i=0;i<n;i++){
    const a0=-Math.PI/2-Math.PI/n+i*(Math.PI*2/n), a1=a0+Math.PI*2/n;
    const id=radialWedges[i],act=COMBAT_ACTIONS[id],sel=i===radial.sel,usable=act&&act.can();
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,R,a0,a1);ctx.closePath();
    ctx.fillStyle=sel?(usable?'rgba(150,110,210,.92)':'rgba(120,60,60,.9)'):'rgba(26,20,36,.9)';
    ctx.fill();ctx.strokeStyle='rgba(190,150,240,.5)';ctx.lineWidth=1.5;ctx.stroke();
    const mid=(a0+a1)/2, lx=cx+Math.cos(mid)*R*0.62, ly=cy+Math.sin(mid)*R*0.62;
    ctx.fillStyle=usable?(sel?'#fff':'#d8cce8'):'rgba(200,180,180,.45)';
    ctx.font='20px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText(act?act.icon:'?',lx,ly+4);
    ctx.font='9px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(act?act.label:'',lx,ly+18);
  }
  ctx.fillStyle='rgba(10,8,16,.9)';ctx.beginPath();ctx.arc(cx,cy,26,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='rgba(190,150,240,.6)';ctx.lineWidth=1.5;ctx.stroke();
  ctx.fillStyle='rgba(220,200,240,.8)';ctx.font='9px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('flick',cx,cy+3);
  ctx.restore();ctx.textAlign='left';
}
// Floating "[E] …" prompts over every interactable within reach.
function drawInteractPrompts(){
  if((player.dead&&!player.ghost)||uiBlocking())return;
  const ctx=G.ctx,px=player.x,py=player.y,items=[];
  const add=(wx,wy,label,rng,h)=>{ if(Math.hypot(wx-px,wy-py)<(rng||TILE*2.6))items.push({x:wx,y:wy,label,h}); };
  // name tags over remote players (multiplayer) — hidden players stay hidden
  if(prefs.showNames!==false)
    for(const [,st] of net.remotes) if(!st.hidden&&(!st.dead||st.ghost))
      add(st.x,st.y,(st.ghost?'👻 ':'')+st.name,TILE*(prefs.nameDist||46),150);
  if(player.ghost){
    add(HEALER.x,HEALER.y,'[E] Resurrect',TILE*3);
    for(const wh of WORLD_HEALERS)add(wh.x,wh.y,'[E] Resurrect',TILE*3);
  }else{
    add(MERCHANT.x,MERCHANT.y,'[E] Trade');
    add(BANKER.x,BANKER.y,'[E] Bank');
    add(BLACKSMITH.x,BLACKSMITH.y,'[E] Blacksmith');
    add(MAGE.x,MAGE.y,'[E] Mage Shop');
    add(FARRIER.x,FARRIER.y,'[E] Farrier');
    add(FLETCHER.x,FLETCHER.y,'[E] Fletcher');
    add(ANTIQUARIAN.x,ANTIQUARIAN.y,'[E] Antiquarian');
    add(CRYPTOLOGIST.x,CRYPTOLOGIST.y,'[E] Cryptologist');
    add(CURATOR.x,CURATOR.y,'[E] Museum Curator');
    add(GRAVE_ROBBER.x,GRAVE_ROBBER.y,'[E] Grave Robber');
    add(CONTRACT_BOARD.x,CONTRACT_BOARD.y,'[E] Contracts',TILE*3,58);
    { const wc=nearbyWorldChest(); if(wc) add(wc.x*TILE+TILE/2,wc.y*TILE+TILE/2,wc.hoard?'[E] 👑 Hoard':'[E] Open chest',TILE*2,40); }
    add(HEALER.x,HEALER.y,'[E] Heal',TILE*3);
    for(const wh of WORLD_HEALERS)add(wh.x,wh.y,'[E] Heal',TILE*3);
    if(G.placedHouses)for(const h of G.placedHouses){
      const dd=houseDoorTile(h); add(dd.tx*TILE+TILE/2,dd.ty*TILE+TILE/2,h.doorOpen?'[E] close door':'[E] open door',TILE*1.8);
      const sp=houseSignPos(h); if(getNearbyHouseDoorIndex()===-1) add(sp.x,sp.z,'[E] house settings',TILE*2.4);
    }
    for(const a of CHAMP_ALTARS)if(a.state==='idle')add(a.x,a.y,'⚔ champion shrine',TILE*4);
    for(const p of portals)add(p.position.x,p.position.z,'▼ enter dungeon',TILE*2.4);
  }
  if(!items.length)return;
  ctx.textAlign='center';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
  for(const it of items){
    const sc=worldToScreen(it.x,it.y,it.h||46);
    if(sc.x<-40||sc.x>G.canvas.width+40||sc.y<-20||sc.y>G.canvas.height)continue;
    ctx.fillStyle='rgba(0,0,0,.6)';ctx.fillText(it.label,sc.x+1,sc.y+1);
    ctx.fillStyle='rgba(255,235,150,.96)';ctx.fillText(it.label,sc.x,sc.y);
  }
  ctx.textAlign='left';
}
function drawGambitHud(){
  if(!G.gambitsOn||player.dead)return;
  const ctx=G.ctx,x=10,y=G.canvas.height-84;
  ctx.fillStyle='rgba(30,20,44,.75)';ctx.fillRect(x-4,y-13,96,20);
  ctx.fillStyle='#c090ff';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('⚙ GAMBITS',x,y);
  if(G.gambitFlash&&G.gambitFlash.t>0){
    const a=COMBAT_ACTIONS[G.gambitFlash.act];
    ctx.fillStyle='rgba(200,160,255,'+Math.min(1,G.gambitFlash.t)+')';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText('→ '+(a?a.label:''),x+2,y+15);
  }
}
// ── Gambit config panel (Y) ───────────────────────────────────────
let gambitHit=[];
function renderGambitPanel(){
  const ctx=G.ctx,W=372,rowH=34;
  const H=52+gambits.length*rowH+34+30;
  const {px,py}=panelAt('gambit', Math.round(G.canvas.width/2-W/2), Math.round(G.canvas.height/2-H/2), W, H);
  gambitHit=[];
  const btn=(x,y2,w,h,label,active,fn,col)=>{
    ctx.fillStyle=active?'rgba(150,110,210,.9)':'rgba(44,34,60,.9)';ctx.fillRect(x,y2,w,h);
    ctx.strokeStyle='rgba(160,120,210,.5)';ctx.lineWidth=1;ctx.strokeRect(x,y2,w,h);
    ctx.fillStyle=active?'#160f22':(col||'#e0d4f0');ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText(label,x+w/2,y2+h/2+4);ctx.textAlign='left';
    gambitHit.push({x,y:y2,w,h,fn});
  };
  ctx.fillStyle='rgba(16,12,24,.96)';ctx.fillRect(px,py,W,H);
  ctx.strokeStyle='#9060c8';ctx.lineWidth=1.5;ctx.strokeRect(px,py,W,H);
  ctx.fillStyle='#c090ff';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('GAMBITS — auto-combat rules  ·  Y to close',px+W/2,py+19);ctx.textAlign='left';
  // master enable
  btn(px+10,py+30,150,18,G.gambitsOn?'● RUNNING':'○ paused',G.gambitsOn,()=>G.gambitsOn=!G.gambitsOn);
  ctx.fillStyle='rgba(210,190,240,.6)';ctx.font='9px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('top rule that matches fires first',px+168,py+43);
  let y=py+52;
  for(let i=0;i<gambits.length;i++){
    const g=gambits[i],c=gambitCond(g.cond),a=COMBAT_ACTIONS[g.act];
    ctx.fillStyle=g.on?'rgba(40,30,58,.7)':'rgba(24,20,32,.7)';ctx.fillRect(px+8,y,W-16,rowH-4);
    btn(px+10,y+6,20,rowH-16,g.on?'✓':' ',g.on,()=>g.on=!g.on);
    // priority number
    ctx.fillStyle='rgba(180,160,210,.7)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(String(i+1),px+34,y+18);
    // IF condition (click to cycle)
    ctx.fillStyle='#a8c8ff';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    const condTxt='IF '+c.label+(c.arg?' '+g.arg+(c.unit||''):'');
    ctx.fillText(condTxt,px+46,y+15);
    gambitHit.push({x:px+44,y:y+2,w:150,h:16,fn:()=>{const idx=GAMBIT_CONDS.findIndex(x=>x.id===g.cond);const nc=GAMBIT_CONDS[(idx+1)%GAMBIT_CONDS.length];g.cond=nc.id;g.arg=nc.arg?(nc.def||0):0;}});
    if(c.arg){
      btn(px+200,y+3,16,15,'-',false,()=>g.arg=Math.max(c.min,g.arg-c.step));
      btn(px+218,y+3,16,15,'+',false,()=>g.arg=Math.min(c.max,g.arg+c.step));
    }
    // THEN action (click to cycle)
    ctx.fillStyle='#ffcc88';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText('→ '+(a?a.label:'?'),px+46,y+29);
    gambitHit.push({x:px+44,y:y+18,w:130,h:14,fn:()=>{const idx=GAMBIT_ACTS.indexOf(g.act);g.act=GAMBIT_ACTS[(idx+1)%GAMBIT_ACTS.length];}});
    // reorder + delete
    btn(px+W-72,y+3,16,15,'▲',false,()=>{if(i>0){const t=gambits[i-1];gambits[i-1]=g;gambits[i]=t;}});
    btn(px+W-54,y+3,16,15,'▼',false,()=>{if(i<gambits.length-1){const t=gambits[i+1];gambits[i+1]=g;gambits[i]=t;}});
    btn(px+W-30,y+3,18,15,'✕',false,()=>gambits.splice(i,1),'#ff9090');
    y+=rowH;
  }
  btn(px+10,y+4,120,20,'+ Add rule',false,()=>gambits.push({on:true,cond:'hpBelow',arg:50,act:'bandage'}));
  ctx.fillStyle='rgba(210,190,240,.55)';ctx.font='9px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('click IF / → to change · +/- adjusts · ▲▼ reorder',px+140,y+18);
}
function handleGambitClick(e){
  for(const h of gambitHit){
    if(e.clientX>=h.x&&e.clientX<=h.x+h.w&&e.clientY>=h.y&&e.clientY<=h.y+h.h){h.fn();try{localStorage.setItem;}catch(_){}return true;}
  }
  return true;   // swallow clicks inside the panel area
}

// ── Character sheet (L) ───────────────────────────────────────────
// Level + XP, attribute allocation from level-up points, and the ARPG
// equipment bag: equip/unequip rolled items and socket gems into them.
const CHARP_W=fitPanelW(440), CHARP_H=470;
const CHAR_STATS=[['str','STR','melee damage'],['dex','DEX','arrow damage, speed'],['int','INT','arcane power'],['vit','VIT','max HP']];
function charPanelXY(){return panelAt('charsheet', Math.round(G.canvas.width/2-CHARP_W/2), Math.round(G.canvas.height/2-CHARP_H/2), CHARP_W, CHARP_H);}
function charStatRects(){
  const{px,py}=charPanelXY();
  return CHAR_STATS.map((s,i)=>({key:s[0],label:s[1],hint:s[2],y:py+96+i*26,
    plus:{x:px+186,y:py+96+i*26-13,w:18,h:18}}));
}
function charBagRects(){
  const{px,py}=charPanelXY(), items=player.equipmentItems||[];
  return items.map((it,i)=>({idx:i,item:it,x:px+12,y:py+250+i*22,w:CHARP_W-24,h:20}))
    .filter(r=>r.y<py+CHARP_H-52);
}
function charEquipRects(){
  const{px,py}=charPanelXY();
  return [{slot:'weapon',x:px+222,y:py+96,w:200,h:44},{slot:'armor',x:px+222,y:py+146,w:200,h:44}];
}
function renderCharPanel(){
  const ctx=G.ctx,{px,py}=charPanelXY();
  const raceData=RACES[player.race]||RACES.Human;
  ctx.fillStyle='rgba(10,10,16,.97)';ctx.fillRect(px,py,CHARP_W,CHARP_H);
  ctx.strokeStyle='#c8a25a';ctx.lineWidth=2;ctx.strokeRect(px,py,CHARP_W,CHARP_H);
  ctx.fillStyle='#f0d878';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('CHARACTER  ·  L to close',px+CHARP_W/2,py+22);
  ctx.font='12px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='#e8dcc0';
  ctx.fillText(`${raceData.icon} ${player.name}  ·  ${player.race}  ·  Level ${player.level}`,px+CHARP_W/2,py+42);
  // XP bar
  const bx=px+12,bw=CHARP_W-24,frac=player.level>=50?1:Math.max(0,Math.min(1,player.xp/(player.xpMax||1)));
  ctx.fillStyle='rgba(0,0,0,.5)';ctx.fillRect(bx,py+52,bw,12);
  ctx.fillStyle='#4a90e2';ctx.fillRect(bx,py+52,Math.round(bw*frac),12);
  ctx.strokeStyle='rgba(255,255,255,.2)';ctx.lineWidth=1;ctx.strokeRect(bx,py+52,bw,12);
  ctx.fillStyle='#cfe4ff';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(player.level>=50?'MAX LEVEL':player.xp+' / '+player.xpMax+' XP',px+CHARP_W/2,py+62);
  // Attributes
  ctx.textAlign='left';ctx.fillStyle='#f0d878';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('ATTRIBUTES',px+12,py+84);
  ctx.textAlign='right';ctx.fillStyle=player.statPoints>0?'#80e880':'rgba(200,190,160,.6)';
  ctx.fillText(player.statPoints+' pts',px+204,py+84);ctx.textAlign='left';
  for(const r of charStatRects()){
    const base=player.stats?.[r.key]??10, race=raceData.bonus[r.key]||0, gear=eqStat(r.key);
    ctx.fillStyle='#e8dcc0';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(r.label,px+14,r.y+4);
    ctx.fillStyle='#fff';ctx.fillText(''+(base+race+gear),px+56,r.y+4);
    ctx.fillStyle='rgba(180,200,240,.7)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText((race?'+'+race+' race ':'')+(gear?'+'+gear+' gear':''),px+84,r.y+4);
    if(player.statPoints>0){
      const b=r.plus;ctx.fillStyle='rgba(45,85,35,.95)';ctx.fillRect(b.x,b.y,b.w,b.h);
      ctx.strokeStyle='#70b860';ctx.lineWidth=1;ctx.strokeRect(b.x,b.y,b.w,b.h);
      ctx.fillStyle='#e0ffd0';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
      ctx.fillText('+',b.x+b.w/2,b.y+13);ctx.textAlign='left';
    }
  }
  // Equipped ARPG gear
  ctx.fillStyle='#f0d878';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('EQUIPPED',px+222,py+84);
  for(const r of charEquipRects()){
    const it=player.equippedItems?.[r.slot];
    ctx.fillStyle='rgba(255,255,255,.05)';ctx.fillRect(r.x,r.y,r.w,r.h);
    ctx.strokeStyle=it?(it.color||'#888'):'rgba(140,130,110,.4)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    if(it){
      ctx.fillStyle=it.color||'#fff';ctx.fillText(it.name,r.x+6,r.y+15);
      ctx.fillStyle='rgba(210,205,190,.8)';ctx.font='9px ui-monospace,Menlo,Consolas,monospace';
      const bits=it.affixes.map(a=>'+'+a.val+' '+a.unit).slice(0,2).join('  ');
      ctx.fillText(bits||it.rarityName,r.x+6,r.y+28);
      const socks=it.sockets.map(s=>s.gem?(GEMS_ICON[s.gem]||'◆'):'○').join(' ');
      if(socks)ctx.fillText('sockets: '+socks+'   (click to socket)',r.x+6,r.y+39);
    } else { ctx.fillStyle='rgba(160,150,130,.6)';ctx.fillText('(empty '+r.slot+')',r.x+6,r.y+24); }
  }
  // Bag
  ctx.fillStyle='#f0d878';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('LOOT BAG  (click to equip)',px+12,py+240);
  const bag=charBagRects();
  if(!bag.length){ctx.fillStyle='rgba(180,170,150,.6)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText('empty — slay champions and elites for rolled gear',px+12,py+262);}
  for(const r of bag){
    const it=r.item,sel=G.charSel===r.idx;
    if(sel){ctx.fillStyle='rgba(240,216,120,.15)';ctx.fillRect(r.x,r.y,r.w,r.h);}
    ctx.fillStyle=it.color||'#fff';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(it.name,r.x+4,r.y+14);
    ctx.fillStyle='rgba(200,195,180,.7)';ctx.font='9px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='right';
    ctx.fillText(it.rarityName+'  lv'+it.levelReq+'  '+(it.baseStat.dmg?('+'+it.baseStat.dmg+' dmg'):('+'+it.baseStat.def+' def')),r.x+r.w-4,r.y+14);
    ctx.textAlign='left';
  }
  // gem stock footer
  ctx.fillStyle='rgba(200,190,160,.75)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('gems: '+GEM_KEYS.map(g=>(GEMS_ICON[g]||'')+ (inv[g]||0)).join('   '),px+12,py+CHARP_H-14);
}
const GEMS_ICON={ruby:'🔴',sapphire:'🔷',emerald:'🟢',diamond:'⚪'};
function handleCharPanelClick(e){
  const{px,py}=charPanelXY();
  if(e.clientX<px||e.clientX>px+CHARP_W||e.clientY<py||e.clientY>py+CHARP_H)return false;
  const hit=b=>e.clientX>=b.x&&e.clientX<=b.x+b.w&&e.clientY>=b.y&&e.clientY<=b.y+b.h;
  // spend a stat point
  if(player.statPoints>0)for(const r of charStatRects()){
    if(hit(r.plus)){ player.stats[r.key]=(player.stats[r.key]||10)+1; player.statPoints--;
      refreshEquipStats(); snd.pickup(); addFloater(player.x,player.y-30,'+1 '+r.label); return true; }
  }
  // click an equipped item → socket the first spare gem, or unequip if no sockets/gems
  for(const r of charEquipRects()){
    if(!hit(r))continue;
    const it=player.equippedItems?.[r.slot]; if(!it)return true;
    const openIdx=it.sockets.findIndex(s=>!s.gem);
    const gem=GEM_KEYS.find(g=>(inv[g]||0)>0);
    if(openIdx>=0&&gem&&socketGem(it,openIdx,gem)){
      refreshEquipStats(); snd.gold(); addFloater(player.x,player.y-30,'socketed '+gem); return true;
    }
    player.equipmentItems.push(it); player.equippedItems[r.slot]=null;   // unequip back to bag
    refreshEquipStats(); snd.pickup(); return true;
  }
  // click a bag item → equip into its slot (swapping whatever is there)
  for(const r of charBagRects()){
    if(!hit(r))continue;
    G.charSel=r.idx;
    if((player.level||1)<r.item.levelReq){ addFloater(player.x,player.y-30,'requires level '+r.item.levelReq); return true; }
    const slot=r.item.slot;
    const prev=player.equippedItems[slot];
    player.equipmentItems.splice(r.idx,1);
    if(prev)player.equipmentItems.push(prev);
    player.equippedItems[slot]=r.item;
    G.charSel=null; refreshEquipStats(); snd.pickup();
    addFloater(player.x,player.y-30,'equipped '+r.item.name);
    return true;
  }
  return true;   // swallow clicks inside the panel
}

function recomputeDerivedStats(){
  const raceData = RACES[player.race] || RACES.Human;
  const eq = (typeof _eqStats!=='undefined' && _eqStats) || {};
  const dex = (player.stats?.dex || 10) + (raceData.bonus.dex || 0) + (eq.dex||0);
  const vit = (player.stats?.vit || 10) + (raceData.bonus.vit || 0) + (eq.vit||0);
  player.maxHp = 100 + (vit - 10) * 10 + (eq.maxHp||0);
  if (player.hp === undefined || player.hp > player.maxHp) player.hp = player.maxHp;
  player.speed = 190 + (dex - 10) * 4 + (player.race === 'Centaur' ? 25 : 0) + (eq.speed||0);
}

function buildSave(){
  return {px:player.x,py:player.y,hp:player.hp,inv:{...inv},hasAxe:player.hasAxe,hasSword:player.hasSword,hasBow:player.hasBow,hasPickaxe:player.hasPickaxe,hasArmor:player.hasArmor,weapon:player.weapon,swordTier:player.swordTier||1,bowTier:player.bowTier||1,pickaxeTier:player.pickaxeTier||1,autoDefend:G.autoDefend!==false,aggroMode:!!G.aggroMode,armor:{...player.armor},bank:{gold:bank.gold},skillXp:{tactics:skills.tactics.xp,archery:skills.archery.xp,hiding:skills.hiding.xp,healing:skills.healing.xp,wrestling:skills.wrestling.xp},quests:{idx:questState.idx,prog:questState.prog},hasHouseTool:player.hasHouseTool,placedHouses:net.status==='online'?undefined:G.placedHouses,gambits,gambitsOn:!!G.gambitsOn,
    // Shared world state -- the server owns this and broadcasts it, so only
    // persist a private copy when we are offline and nothing else will.
    // Saving it while online is what let each browser restore a divergent world.
    placedObjects:net.status==='online'?undefined:placedObjects.map(o=>({...o})),
    hasHorse:!!player.hasHorse,onHorse:!!player.onHorse,horseDown:!!player.horseDown,horseX:player.horseX||0,horseY:player.horseY||0,
    artifactInv:player.artifactInv.map(it=>({...it})),equippedArtifacts:{...player.equippedArtifacts},dollGender:player.dollGender,
    name:player.name,gender:player.gender,race:player.race,stats:{...(player.stats||{str:10,dex:10,int:10,vit:10})},
    level:player.level,xp:player.xp,xpMax:player.xpMax,statPoints:player.statPoints,skillPoints:player.skillPoints,
    equipmentItems:(player.equipmentItems||[]).map(it=>({...it})),
    equippedItems:{weapon:player.equippedItems?.weapon?{...player.equippedItems.weapon}:null,
                   armor: player.equippedItems?.armor ?{...player.equippedItems.armor} :null},
    antiqStock:G.antiqStock,antiqStockAt:G.antiqStockAt,bounty:G.bounty,bountyAt:G.bountyAt,
    contracts:(G.contracts||[]).map(c=>({...c})),contractRank:G.contractRank||0,
    dungeonBest:G.dungeonBest||1,floorBossesDown:{...(G.floorBossesDown||{})},
    chestsLooted:{...(G.chestsLooted||{})},
    totalKills:G.totalKills||0,gambitHinted:!!G.gambitHinted,
    achiev:[...(G.achiev||[])],
    hotbar:hotbar.map(s=>s?{...s}:null),macros:macros.map(m=>({name:m.name,steps:[...m.steps]}))};
}
function saveGame(quiet){
  const s=buildSave();
  try{
    localStorage.setItem('medievalSave_v06',JSON.stringify(s));
    AccountManager.saveCurrentSlot(s, { name: player.name, gender: player.gender, race: player.race, stats: player.stats });
  }catch(e){}
  netSave(s);   // online: server is the source of truth (anti-tamper, no lost loot)
  if(!quiet) addFloater(player.x,player.y-34, net.status==='online'?'💾 saved to server':'💾 saved!');
}
// auto-save to the server periodically so progress never rolls back
let _autoSaveT=0;
function autoSaveTick(dt){
  if(net.status!=='online')return;
  _autoSaveT+=dt; if(_autoSaveT<20)return; _autoSaveT=0;
  if(!player.dead) netSave(buildSave());
}
// Wipe every scrap of per-character progression back to first-boot defaults.
// Creating a new character used to reset only a few inventory fields, so the
// new hero silently inherited the previous one's level, gear, skills, bank,
// quests, contracts, chests and buildings.
function resetForNewCharacter(){
  // level & attributes
  player.level=1; player.xp=0; player.xpMax=getXpForLevel(1);
  player.statPoints=0; player.skillPoints=0;
  player.stats={str:10,dex:10,int:10,vit:10};
  // gear & equipment
  player.equipmentItems=[]; player.equippedItems={weapon:null,armor:null};
  player.equippedArtifacts={neck:null,ring1:null,ring2:null,brac1:null,brac2:null};
  player.artifactInv=[]; player.artifactBonus={};
  player.armor={head:0,chest:0,legs:0,boots:0}; player.hasArmor=false;
  player.swordTier=1; player.bowTier=1; player.pickaxeTier=1;
  player.hasAxe=true; player.hasSword=false; player.hasBow=false;
  player.hasPickaxe=false; player.hasHouseTool=false; player.weapon='axe';
  // mount & status
  player.hasHorse=false; player.onHorse=false; player.horseDown=false;
  player.isRat=false; player.ratTimer=0; player.charmed=false; player.charmTimer=0;
  player.poisonTimer=0; player.stunTimer=0; player.webTimer=0; player.bandageTimer=0;
  player.dead=false; player.ghost=false; player.iframes=0;
  // inventory (the caller lays the starting kit on top)
  for(const k in inv) inv[k]=0;
  // skills
  for(const k in skills){
    const sk=skills[k]; sk.xp=0;
    if('active' in sk)sk.active=false; if('timer' in sk)sk.timer=0; if('cooldown' in sk)sk.cooldown=0;
  }
  // economy, quests, world progress
  bank.gold=0; bank.interestAccum=0;
  questState.idx=0; questState.prog=0;
  G.contracts=null; G.contractRank=0;
  G.chestsLooted={}; G.floorBossesDown={};
  G.dungeonBest=1; G.dungeonFloor=0; G.inDungeon=false;
  G.corpse=null; G.corpseLootOpen=false;
  G.antiqStock=null; G.antiqStockAt=0; G.bounty=null; G.bountyAt=0;
  G.totalKills=0; G.gambitHinted=false; G.achiev=new Set();
  G.placedHouses=[];
  placedObjects.length=0; placedObjectsDirty=true;
  recomputeArtifactBonus();
  refreshEquipStats();
  updateArmorVisuals();
  ensureContracts();
}
function loadGame(blob){
  try{
    let s=blob;
    if(!s){
      const activeSlot = AccountManager.getActiveSlot();
      if(activeSlot && activeSlot.saveBlob) s = activeSlot.saveBlob;
      else { const raw=localStorage.getItem('medievalSave_v06'); if(raw) s=JSON.parse(raw); }
    }
    if(!s||typeof s!=='object')return false;
    player.x=s.px;player.y=s.py;player.hp=s.hp;Object.assign(inv,s.inv);
    player.name=s.name||player.name||'Traveler';
    player.gender=s.gender||'male';
    player.race=s.race||'Human';
    player.stats=s.stats||{str:10,dex:10,int:10,vit:10};
    player.dollGender=player.gender==='female'?'f':'m';
    recomputeDerivedStats();
    player.hasAxe=s.hasAxe;player.hasSword=s.hasSword;player.hasBow=s.hasBow;player.hasPickaxe=s.hasPickaxe;player.hasArmor=s.hasArmor;player.weapon=s.weapon;bank.gold=s.bank.gold;player.hasHouseTool=s.hasHouseTool||false;
    player.hasHorse=!!s.hasHorse;player.onHorse=!!s.onHorse;player.horseDown=!!s.horseDown;player.horseX=s.horseX||0;player.horseY=s.horseY||0;
    player.pickaxeTier=s.pickaxeTier||1;
    if(s.skillXp){skills.tactics.xp=s.skillXp.tactics||0;skills.archery.xp=s.skillXp.archery||0;skills.hiding.xp=s.skillXp.hiding||0;skills.healing.xp=s.skillXp.healing||0;skills.wrestling.xp=s.skillXp.wrestling||0;}
    if(s.quests){questState.idx=Math.min(s.quests.idx||0,QUESTS.length);questState.prog=s.quests.prog||0;}
    player.swordTier=s.swordTier||1;player.bowTier=s.bowTier||1;
    if(s.autoDefend===false)G.autoDefend=false;
    G.aggroMode=!!s.aggroMode;
    if(Array.isArray(s.gambits)&&s.gambits.length)gambits=s.gambits;
    G.gambitsOn=!!s.gambitsOn;
    if(s.armor)player.armor={head:0,chest:0,legs:0,boots:0,...s.armor};
    else if(s.hasArmor)player.armor={head:0,chest:1,legs:0,boots:0};   // legacy flat armor → leather chest
    updateArmorVisuals();
    if(inv.bone===undefined)inv.bone=0;
    if(inv.relics===undefined)inv.relics=0;
    if(Array.isArray(s.placedObjects)){
      placedObjects.length=0;
      s.placedObjects.forEach(o=>placedObjects.push(o));
      placedObjectsDirty=true;
    }
    player.artifactInv=Array.isArray(s.artifactInv)?s.artifactInv.map(it=>({...it})):[];
    player.equippedArtifacts={neck:null,ring1:null,ring2:null,brac1:null,brac2:null};
    if(s.equippedArtifacts){
      for(const sk of ARTIFACT_SLOTS){
        const id=s.equippedArtifacts[sk];
        if(id&&artifactDef(id)&&ARTIFACT_SLOT_TYPE[sk]===artifactDef(id).slot)player.equippedArtifacts[sk]=id;
      }
    }else if(s.equippedArtifact&&artifactDef(s.equippedArtifact)){   // migrate old single-slot saves
      const def=artifactDef(s.equippedArtifact);
      const sk=ARTIFACT_SLOTS.find(k=>ARTIFACT_SLOT_TYPE[k]===def.slot);
      player.equippedArtifacts[sk]=s.equippedArtifact;
    }
    recomputeArtifactBonus();
    // ARPG progression: level/XP, unspent points, and rolled gear
    if(s.level){player.level=s.level;player.xp=s.xp||0;player.xpMax=s.xpMax||getXpForLevel(player.level);
      player.statPoints=s.statPoints||0;player.skillPoints=s.skillPoints||0;}
    player.equipmentItems=Array.isArray(s.equipmentItems)?s.equipmentItems.map(it=>({...it})):[];
    player.equippedItems={weapon:s.equippedItems?.weapon?{...s.equippedItems.weapon}:null,
                          armor: s.equippedItems?.armor ?{...s.equippedItems.armor} :null};
    refreshEquipStats();
    if(Array.isArray(s.contracts))G.contracts=s.contracts.map(c=>({...c}));
    G.contractRank=s.contractRank||0;
    G.dungeonBest=s.dungeonBest||1;
    G.floorBossesDown={...(s.floorBossesDown||{})};
    G.chestsLooted={...(s.chestsLooted||{})};
    placedObjectsDirty=true;                     // refresh which chests still stand
    ensureContracts();
    if(s.antiqStock){G.antiqStock=s.antiqStock;G.antiqStockAt=s.antiqStockAt||0;}
    if(s.bounty){G.bounty=s.bounty;G.bountyAt=s.bountyAt||0;}
    G.totalKills=s.totalKills||0; G.gambitHinted=!!s.gambitHinted;
    G.achiev=new Set(Array.isArray(s.achiev)?s.achiev:[]);
    if(Array.isArray(s.macros))macros=s.macros.filter(m=>m&&Array.isArray(m.steps)).map(m=>({name:m.name||'Macro',steps:m.steps.filter(st=>COMBAT_ACTIONS[st])}));
    if(Array.isArray(s.hotbar)){
      hotbar=s.hotbar.slice(0,HOTBAR_SLOTS).map(sl=>{
        if(!sl||typeof sl!=='object')return null;
        if(sl.k==='weapon'&&HOTBAR_WEAPONS[sl.id])return{k:'weapon',id:sl.id};
        if(sl.k==='act'&&COMBAT_ACTIONS[sl.id])return{k:'act',id:sl.id};
        if(sl.k==='macro'&&macros[sl.id])return{k:'macro',id:sl.id};
        if(sl.k==='item'&&BAG_BY_KEY[sl.id])return{k:'item',id:sl.id};
        return null;
      });
      while(hotbar.length<HOTBAR_SLOTS)hotbar.push(null);
    }
    if(s.placedHouses){
      G.placedHouses=s.placedHouses;
      for(const h of G.placedHouses){
        h.isPublic=h.isPublic||false;
        h.friends=h.friends||[];
        h.doorOpen=h.doorOpen||false;
        const {x0,y0,size}=h;
        for(let dy=0;dy<size;dy++)for(let dx=0;dx<size;dx++){
          const x=x0+dx,y=y0+dy;
          const isBorder=(dy===0||dy===size-1||dx===0||dx===size-1);
          const isDoor=(dy===size-1&&dx===Math.floor(size/2));
          if(isBorder&&!isDoor){
            map[y][x]=T.WALL;origTile[y][x]=T.WALL;playerPlacedWalls[y][x]=true;
          }else{
            map[y][x]=T.PATH;origTile[y][x]=T.PATH;playerPlacedWalls[y][x]=false;
          }
          respawnAt[y][x]=null;
          bakeStaticTile(x,y);minimapUpdateTile(x,y);
        }
      }
      updateHouseSigns();
    }
    return true;
  }catch(e){return false;}
}

// ── Input ─────────────────────────────────────────────────────────
// The movement code reads keys['w'] directly in half a dozen places, so a
// rebind has to be applied HERE: press whatever is bound to Move Forward and the
// map records it under 'w'. See canonKey() in settings.js for why that is the
// whole of the rebinding mechanism.
function onKey(d){return e=>{if(!e.key)return;
  const raw=e.key.toLowerCase();
  if(settingsCapture) return;                 // the menu is listening for a bind
  const k=canonKey(raw);
  keys[k]=d;
  if(!uiBlocking()) dtapKey(k, d, !!e.repeat);
  if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(raw))e.preventDefault();};}
window.addEventListener('keydown',onKey(true));window.addEventListener('keyup',onKey(false));
document.addEventListener('keydown',onKey(true));document.addEventListener('keyup',onKey(false));

window.addEventListener('keydown',e=>{
  const kRaw=e.key.toLowerCase();
  // The settings menu is waiting for a key to assign: swallow it whole, so that
  // binding Crafting to 'm' does not also open the map on the way past.
  if(settingsCapture){ e.preventDefault(); captureBind(kRaw); return; }
  const k=canonKey(kRaw);
  if(k==='f2'){
    e.preventDefault();
    G.editorOpen=!G.editorOpen;
    if(G.editorOpen){G.craftOpen=G.tradeOpen=G.bankOpen=G.skillOpen=G.questOpen=false;G.buildMode=false;addFloater(player.x,player.y-30,'WORLD EDITOR — WASD fly · F2 exit');}
    else{saveEdits();buildHighlight.visible=false;buildHighlight.scale.setScalar(1);edState.wiz=null;G.pixelOpen=false;}
    return;
  }
  if(G.editorOpen){ if(k==='escape'){
    if(G.pixelOpen){G.pixelOpen=false;return;}
    if(edState.wiz){edState.wiz=null;return;}
    G.editorOpen=false;saveEdits();buildHighlight.visible=false;buildHighlight.scale.setScalar(1);
  } return; }
  if(k==='enter'){ if(!uiBlocking()) openChatInput(); return; }   // multiplayer chat
  if(k==='c'&&!player.dead){
    if(e.shiftKey){
      G.charSelectOpen=!G.charSelectOpen;
    } else {
      G.buildMode=false;G.tradeOpen=false;G.skillOpen=false;G.bankOpen=false;G.craftOpen=!G.craftOpen;
    }
  }
  if(k==='k'){G.craftOpen=false;G.tradeOpen=false;G.buildMode=false;G.bankOpen=false;G.questOpen=false;G.skillOpen=!G.skillOpen;}
  if(k==='j'){G.craftOpen=false;G.tradeOpen=false;G.buildMode=false;G.bankOpen=false;G.skillOpen=false;G.questOpen=!G.questOpen;}
  if(k==='t'){G.craftOpen=false;G.tradeOpen=false;G.buildMode=false;G.bankOpen=false;G.skillOpen=false;G.questOpen=false;if(G.tutorialOpen)closeTutorial();else G.tutorialOpen=true;}
  if(k==='i'){G.dollOpen=!G.dollOpen;if(!G.dollOpen)G.dollPick=null;}
  if(k==='o'){G.craftOpen=G.tradeOpen=G.bankOpen=G.skillOpen=G.questOpen=G.dollOpen=false;G.backpackOpen=!G.backpackOpen;}
  if(k==='y'){G.craftOpen=G.tradeOpen=G.bankOpen=G.skillOpen=G.questOpen=G.dollOpen=false;G.gambitOpen=!G.gambitOpen;}
  if(k>='1'&&k<='8'&&!e.ctrlKey&&!uiBlocking())fireHotbarSlot(k.charCodeAt(0)-49);
  if(k==='z'&&!uiBlocking())fireHotbarSlot(G.hotbarSel);
  if(k==='m')G.minimapOpen=!G.minimapOpen;
  // Ctrl + (=/+) zoom in, Ctrl + (-/_) zoom out — trackpad/keyboard parity
  if(e.ctrlKey&&(k==='='||k==='+')){e.preventDefault();camZoom=Math.max(0.3,camZoom*0.89);}
  if(e.ctrlKey&&(k==='-'||k==='_')){e.preventDefault();camZoom=Math.min(3.0,camZoom*1.12);}
  if(e.ctrlKey&&k==='0'){e.preventDefault();camZoom=innerWidth<600?0.55:0.72;}
  // Camera presets. Every letter on the keyboard was already bound, and the
  // brackets read as "step through a list" anyway.
  if(!e.ctrlKey&&!e.altKey&&k===']'){e.preventDefault();setCamMode(camModeIdx+1);}
  if(!e.ctrlKey&&!e.altKey&&k==='['){e.preventDefault();setCamMode(camModeIdx-1);}
  if(k==='n'){const nm=!soundMuted;setSoundMuted(nm);addFloater(player.x,player.y-30,nm?'sound off':'sound on');}
  if(k==='`'){
    e.preventDefault();
    G.devGuiOpen=!G.devGuiOpen;
    G.craftOpen=G.tradeOpen=G.buildMode=G.bankOpen=G.skillOpen=G.questOpen=G.houseSettingsOpen=G.houseMenuOpen=false;
    G.antiqOpen=G.cryptoOpen=G.curatorOpen=G.robberOpen=false;
    return;
  }
  if(k==='escape'){
    // Escape is first and foremost a "close what is open" key -- so remember
    // whether anything WAS open before the closer below runs. Only if nothing
    // was does Escape mean "show me the settings".
    // modalOpen() and uiBlocking() between them name every panel this branch
    // closes. The minimap is deliberately NOT among them: Escape does not close
    // it, so counting it as "something was open" would mean the settings menu
    // could never be reached -- the minimap is on by default.
    const _hadOpen = modalOpen()||uiBlocking();
    G.settingsOpen=false; settingsCapture=null; setSliderDrag=null;
    if(!_hadOpen){ G.settingsOpen=true; settingsTab=0; settingsScroll=0; }
    G.craftOpen=false;G.buildMode=false;G.tradeOpen=false;G.skillOpen=false;G.bankOpen=false;G.smithOpen=false;G.mageOpen=false;G.farrierOpen=false;G.questOpen=false;G.dollOpen=false;G.dollPick=null;G.gambitOpen=false;
    G.antiqOpen=false;G.cryptoOpen=false;G.curatorOpen=false;G.robberOpen=false;
    G.houseMenuOpen=false;
    G.houseSettingsOpen=false;
    G.devGuiOpen=false;
    G.backpackOpen=false;
    G.chestOpen=false;
    if(G.trade){netTradeCancel();closeTrade(false);}
    G.tradeInvite=null;
    if(G.housePlacementMode){
      G.housePlacementMode=false;
      if(G.prePlacementPos){player.x=G.prePlacementPos.x;player.y=G.prePlacementPos.y;}
      buildHighlight.visible=false;buildHighlight.scale.setScalar(1);
    }
    if(G.tutorialOpen)closeTutorial();
  }
  if(k==='s'&&e.ctrlKey){e.preventDefault();if(!player.dead)saveGame();}
  if(k==='q'&&!G.craftOpen&&!G.tradeOpen&&!G.skillOpen)toggleWeapon();
  if(k==='r'&&!player.dead)horseAction();
  if(k==='p'&&!player.dead)usePotion();
  if(k===' '&&!player.dead){e.preventDefault();doSpecial();}
  if(k==='x'&&!player.dead)toggleAggro();
  if(k==='v'){
    if(hidingLv()>=4&&!player.dead){
      const sk=skills.hiding;
      sk.shadowstepCd=sk.shadowstepCd||0;
      if(sk.shadowstepCd>0){
        addFloater(player.x,player.y-30,'shadowstep cd '+Math.ceil(sk.shadowstepCd)+'s');
      } else {
        let dx=0,dy=0;
        if(keys['w']||keys['arrowup'])dy-=1;
        if(keys['s']||keys['arrowdown'])dy+=1;
        if(keys['a']||keys['arrowleft'])dx-=1;
        if(keys['d']||keys['arrowright'])dx+=1;
        const tv=touchVec();dx+=tv.x;dy+=tv.y;
        if (camAngle !== 0) {
          const rx = dx * Math.cos(camAngle) + dy * Math.sin(camAngle);
          const ry = dy * Math.cos(camAngle) - dx * Math.sin(camAngle);
          dx = rx; dy = ry;
        }
        const ml=Math.hypot(dx,dy);
        if(ml>0.01){dx/=ml;dy/=ml;} else {dx=Math.cos(player.dir||0);dy=Math.sin(player.dir||0);}
        let dist=80,finalX=player.x,finalY=player.y;
        for(let stepAmt=5;stepAmt<=dist;stepAmt+=5){
          const tx=player.x+dx*stepAmt,ty=player.y+dy*stepAmt;
          if(boxBlocked(tx,ty,player.r)||doorBlocks(tx,ty,player.r))break;
          finalX=tx;finalY=ty;
        }
        player.x=finalX;player.y=finalY;
        player.iframes=0.2;
        sk.shadowstepCd=12;
        const nearEnemy=nearestEnemy(TILE*5);
        if(!nearEnemy){
          sk.active=true;
          sk.timer=HIDING_DUR[hidingLv()-1];
          sk.cooldown=0;
          addFloater(player.x,player.y-30,'Shadowstep! (hidden)');
        } else {
          addFloater(player.x,player.y-30,'Shadowstep!');
        }
        snd.swing();
      }
    } else {
      G.autoDefend=G.autoDefend===false;
      addFloater(player.x,player.y-30,G.autoDefend?'auto-defend ON':'auto-defend OFF');
    }
  }
  if(k==='l'){G.charOpen=!G.charOpen;if(G.charOpen)G.charSel=null;}
  if(k==='g'&&!player.dead)callGuards();
  if(k==='b'&&!player.dead)useBandage();
  if(k==='h'&&!player.dead)doHiding();
  if(k==='f'&&!player.dead)doWrestling();
  if(k==='e'){
    if(player.ghost){
      G.corpseLootOpen=false;
      if(Math.hypot(HEALER.x-player.x,HEALER.y-player.y)<TILE*2.5){respawnPlayer();snd.heal();addFloater(HEALER.x,HEALER.y-30,'resurrected!');}
      else{let wrez=false;for(const wh of WORLD_HEALERS){if(Math.hypot(wh.x-player.x,wh.y-player.y)<TILE*2.5){respawnPlayer();snd.heal();addFloater(wh.x,wh.y-30,'resurrected!');wrez=true;break;}}if(!wrez)addFloater(player.x,player.y-30,'find a healer to revive!');}
      return;
    }
    if(!player.dead){
      const nearbyChest = placedObjects.find(o => o.type==='secure_chest' && Math.hypot(o.x-player.x, o.y-player.y)<TILE*2.5);
      if(nearbyChest){
        openSecureChest(nearbyChest);
        return;
      }
      const _doorIdx = getNearbyHouseDoorIndex();
      if(_doorIdx !== -1){ toggleHouseDoor(_doorIdx); return; }   // E opens/closes the door (all platforms)
      const nearbySignIdx = getNearbyHouseSignIndex();
      if(nearbySignIdx !== -1) {
        G.activeHouseIndex = nearbySignIdx;
        G.houseSettingsOpen = !G.houseSettingsOpen;
        G.craftOpen = G.tradeOpen = G.bankOpen = G.smithOpen = G.mageOpen = G.farrierOpen = G.skillOpen = G.houseMenuOpen = false;
        G.antiqOpen = G.cryptoOpen = G.curatorOpen = G.robberOpen = false;
        return;
      }
      if(G.smithOpen){if(!handleSmithClick(e))G.smithOpen=false;return;}
      if(G.mageOpen){if(!handleMageClick(e))G.mageOpen=false;return;}
      if(G.farrierOpen){if(!handleFarrierClick(e))G.farrierOpen=false;return;}
      if(G.antiqOpen){if(!handleAntiqClick(e))G.antiqOpen=false;return;}
      if(G.cryptoOpen){if(!handleCryptoClick(e))G.cryptoOpen=false;return;}
      if(G.curatorOpen){if(!handleCuratorClick(e))G.curatorOpen=false;return;}
      if(G.robberOpen){if(!handleRobberClick(e))G.robberOpen=false;return;}
      if(G.houseMenuOpen){if(!handleHouseMenuClick(e))G.houseMenuOpen=false;return;}
      if(G.houseSettingsOpen){if(!handleHouseSettingsClick(e))G.houseSettingsOpen=false;return;}
      if(G.corpseLootOpen)G.corpseLootOpen=false;
      else if(G.corpse&&Math.hypot(G.corpse.x-player.x,G.corpse.y-player.y)<TILE*2)G.corpseLootOpen=true;
      else if(G.bankOpen)G.bankOpen=false;
      else if(G.tradeOpen)G.tradeOpen=false;
      else if(G.houseMenuOpen)G.houseMenuOpen=false;
      else if(G.houseSettingsOpen)G.houseSettingsOpen=false;
      else{
        let used=false;
        for(const wh of WORLD_HEALERS){
          if(Math.hypot(wh.x-player.x,wh.y-player.y)<TILE*2.5){
            const amt=Math.min(player.maxHp-player.hp,50);
            if(amt>0){player.hp+=amt;addSkillXp(skills.healing,10);addFloater(wh.x,wh.y-30,'healed +'+amt+'!');snd.heal();}
            else if(inv.gold>=8){inv.gold-=8;inv.bandages++;snd.gold();addFloater(wh.x,wh.y-30,'bandage bought! -8g');}
            else addFloater(wh.x,wh.y-30,'full HP  (need 8g for bandage)');
            used=true;break;
          }
        }
        if(!used&&Math.hypot(BANKER.x-player.x,BANKER.y-player.y)<TILE*2.5){closeShopPanels();G.bankOpen=true;}
        else if(!used&&Math.hypot(MERCHANT.x-player.x,MERCHANT.y-player.y)<TILE*2.5){closeShopPanels();G.tradeOpen=true;}
        else if(!used&&Math.hypot(BLACKSMITH.x-player.x,BLACKSMITH.y-player.y)<TILE*2.5){closeShopPanels();G.smithOpen=true;}
        else if(!used&&Math.hypot(MAGE.x-player.x,MAGE.y-player.y)<TILE*2.5){closeShopPanels();G.mageOpen=true;}
        else if(!used&&Math.hypot(FARRIER.x-player.x,FARRIER.y-player.y)<TILE*2.5){closeShopPanels();G.farrierOpen=true;}
        else if(!used&&Math.hypot(ANTIQUARIAN.x-player.x,ANTIQUARIAN.y-player.y)<TILE*2.5){closeShopPanels();G.antiqOpen=true;}
        else if(!used&&Math.hypot(CRYPTOLOGIST.x-player.x,CRYPTOLOGIST.y-player.y)<TILE*2.5){closeShopPanels();G.cryptoOpen=true;}
        else if(!used&&Math.hypot(CURATOR.x-player.x,CURATOR.y-player.y)<TILE*2.5){closeShopPanels();G.curatorOpen=true;}
        else if(!used&&Math.hypot(GRAVE_ROBBER.x-player.x,GRAVE_ROBBER.y-player.y)<TILE*2.5){closeShopPanels();G.robberOpen=true;}
        else if(!used&&nearbyWorldChest()){closeShopPanels();G.activeWorldChest=nearbyWorldChest();G.worldChestOpen=true;snd.pickup();}
        else if(!used&&Math.hypot(CONTRACT_BOARD.x-player.x,CONTRACT_BOARD.y-player.y)<TILE*2.5){closeShopPanels();ensureContracts();G.contractsOpen=true;}
        else if(!used&&Math.hypot(FLETCHER.x-player.x,FLETCHER.y-player.y)<TILE*2.5){addFloater(FLETCHER.x,FLETCHER.y-30,"'Arrows? Craft 'em from wood.'");}
      }
    }
  }
});

// Was a plain constant; it is now the DEFAULT of a preference. Read through
// stickMax() rather than captured once, because the setting can move while the
// game is running.
const STICK_MAX = 60;
function stickMax(){ return Math.max(36, Math.min(96, prefs.stickSize || STICK_MAX)); }
function stickSprint(){ return stickMax() * 1.3; }   // 78/60 -- the shipped ratio
// Push past the ring to sprint. Chosen over a separate button because the right
// side of the screen is already eight buttons deep, and over a double-tap because
// that costs a beat you do not have when something is chasing you.
const STICK_SPRINT = 78;
function touchVec(){
  if(!stick.active)return{x:0,y:0};
  const max=stickMax();let dx=stick.dx,dy=stick.dy,len=Math.hypot(dx,dy);
  if(len>max){dx=dx/len*max;dy=dy/len*max;}return{x:dx/max,y:dy/max};
}
// 1.4x deliberately matches the run multiplier a long right-click already gives on
// desktop, and the server's MAX_SPEED budget names that exact figure -- so sprinting
// introduces no speed the anti-cheat has not already accounted for.
const SPRINT_MULT = 1.4;

// ── Running on a keyboard ────────────────────────────────────────
// A tap is a press and release inside DTAP_MS.
//
// This was 300, which is what the gesture measures at when a test fires the two
// presses 140ms apart — but that is not a hand. The platform's own double-click
// threshold is 400-500ms and nobody calls that sluggish, so a real double-tap
// that took 320ms was being silently thrown away as two separate steps. 400 is
// still far too fast to hit by walking in taps.
const DTAP_MS = 400;
// Release-to-press gap. Auto-repeat delivered as keyup/keydown pairs has a gap
// of ~0-5ms; a human lifting a finger and putting it back cannot get near 45ms.
// This single number is what separates the two, and it is why the detector no
// longer has to trust e.repeat.
const DTAP_MIN_GAP = 45;
// Longest press that still counts as a TAP. Holding the key for a third of a
// second is walking, not tapping, and must not prime the gesture.
const DTAP_TAP_MAX = 260;
const _dtapAt   = { w:0, s:0 };   // when the current/last press began
const _dtapUp   = { w:0, s:0 };   // when it was released
const _dtapShort= { w:false, s:false };   // was that press short enough to be a tap
let _dtapRun = null;             // the key that latched the run, or null
// Diagnostics. "Double-tap does not work" has too many possible causes to guess
// between — wrong camera mode, taps too slow, the key never seen at all — and
// each looks identical from outside. These make it one question.
const _dtapDbg = { downs:0, taps:0, arms:0, lastGapMs:null, lastReleaseGapMs:null, lastRejected:null };
// `k` is the CANONICAL key — onKey has already translated it — so this reads
// 'w' and 's' whatever the player has actually bound to forward and back.
const _now = () => (typeof performance!=='undefined') ? performance.now() : Date.now();
function dtapKey(k, down, repeat){
  if(k!=='w' && k!=='s') return;
  const now = _now();
  if(!down){
    // Record the shape of the press that just ended: only a SHORT one can prime
    // a double tap. This is what stops "hold W, twitch, hold W" from running.
    _dtapShort[k] = (now - _dtapAt[k]) <= DTAP_TAP_MAX;
    _dtapUp[k] = now;
    if(_dtapRun===k) _dtapRun=null;
    return;
  }
  _dtapDbg.downs++;
  // e.repeat is still honoured where the browser sets it — it is just no longer
  // the only defence, because it is not reliably set.
  if(repeat){ _dtapDbg.lastRejected='auto-repeat flag'; return; }
  _dtapDbg.taps++;

  const sincePress   = now - _dtapAt[k];   // this press vs the previous press
  const sinceRelease = now - _dtapUp[k];   // this press vs the last release
  _dtapDbg.lastGapMs = Math.round(sincePress);
  _dtapDbg.lastReleaseGapMs = Math.round(sinceRelease);

  if(!_dtapShort[k])                     _dtapDbg.lastRejected='previous press was a hold, not a tap';
  else if(sinceRelease < DTAP_MIN_GAP)   _dtapDbg.lastRejected='release gap '+Math.round(sinceRelease)+'ms — key repeat, not a tap';
  else if(sincePress >= DTAP_MS)         _dtapDbg.lastRejected='taps '+Math.round(sincePress)+'ms apart, window is '+DTAP_MS;
  else { _dtapRun = k; _dtapDbg.arms++; _dtapDbg.lastRejected=null; }

  _dtapAt[k] = now;
}
// Alt-tab, click away, or anything else that takes focus mid-stride: the keyup
// never arrives and the key stays down forever. A stuck Sprint is a permanent
// run, which is the other way to get the symptom this fix is about.
addEventListener('blur', () => {
  for(const k in keys) keys[k] = false;
  _dtapRun = null;
  _dtapShort.w = _dtapShort.s = false;
});
function keyboardRunning(){
  // Belt and braces: if the keyup was swallowed (a menu opened over it, the
  // window lost focus mid-stride) the latch would otherwise stick on forever.
  if(_dtapRun && !keys[_dtapRun]) _dtapRun = null;
  // Walking is the default and there is no way to make it not the default.
  // An always-run preference used to live here; it is gone on purpose. Stealth
  // is going to key off player.running, and a mode where the character runs
  // without the player asking would silently make them audible everywhere.
  //
  // keys[] is indexed by canonical key, so 'shift' here means "whatever is
  // bound to Sprint" without this having to look the binding up.
  return !!keys['shift'] || _dtapRun !== null;
}
function touchSprinting(){
  return stick.active && Math.hypot(stick.dx, stick.dy) > stickSprint();
}
// ── Touch controls ────────────────────────────────────────────────
// Left half: virtual joystick. Right half: hold to attack toward the
// touch. Button column (Q/E/C/B/M) on the right edge reuses the keyboard
// handlers via synthetic key events. Two fingers pinch-zoom the camera.
const TB_R = 30;
function touchBtns(){
  const bx=G.canvas.width-TB_R-12, gap=TB_R*2+14;
  const by=G.canvas.height-220;
  const btns=[
    {k:'q', lab:'Q⚒', x:bx, y:by-gap*5},
    {k:'e', lab:'E',  x:bx, y:by-gap*4},
    {k:'c', lab:'C',  x:bx, y:by-gap*3},
    {k:'b', lab:'B✚', x:bx, y:by-gap*2},
    {k:'j', lab:'J⚑', x:bx, y:by-gap},
    {k:'m', lab:'M',  x:bx, y:by},
    {k:'t', lab:'?',  x:bx, y:by-gap*6},
    {k:'x', lab:'⚔',  x:bx, y:by-gap*7},
    {k:'o', lab:'🎒', x:bx-gap, y:by},          // backpack (second column)
    // Viewpoint. Dispatches the same ']' the keyboard uses, so presets have one
    // code path. Without this a touch device could not change camera at all --
    // camAngle/camPitch are otherwise keyboard- and pointer-lock-only.
    {k:']', lab:'👁', x:bx-gap, y:by-gap},
    // Call the guards. callGuards() has always existed on 'g' and is even in the
    // help panel, but there was no way to reach it without a keyboard -- so on a
    // phone the single most useful "get me out of this" action was unreachable.
    {k:'g', lab:'🛡', x:bx-gap, y:by-gap*2},
  ];
  if(player.hasHorse) btns.push({k:'r', lab:'🐴', x:bx, y:by-gap*8});   // mount/dismount/whistle
  return btns;
}
function hitTouchBtn(x,y){
  for(const b of touchBtns()) if(Math.hypot(x-b.x,y-b.y)<=TB_R+6) return b;
  return null;
}
const pinch={active:false,d0:0,z0:1,target:null};
const uiTouch={id:null};   // finger currently driving an open panel (as a mouse)
const _tDist=(a,b)=>Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
addEventListener('mouseup',()=>{ setSliderDrag=null; });
const _fwdMouse=(type,x,y,onWin)=>(onWin?window:G.canvas).dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,button:0,buttons:type==='mouseup'?0:1,bubbles:true}));
G.canvas.addEventListener('touchstart',e=>{
  if(!G.isTouch){G.isTouch=true;applyMobileHudMode();}
  if(e.touches.length===2){
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    let pinchOnMinimap = false;
    if(G.minimapOpen){
      const {mx, my, sz} = minimapRect();
      const margin = 20;
      const inMinimap = (x, y) => x >= mx - margin && x <= mx + sz + margin && y >= my - margin && y <= my + sz + margin;
      if(inMinimap(t0.clientX, t0.clientY) || inMinimap(t1.clientX, t1.clientY)){
        pinchOnMinimap = true;
      }
    }
    pinch.active=true; pinch.d0=_tDist(t0, t1);
    if(pinchOnMinimap){
      pinch.target='minimap';
      pinch.z0=G.minimapZoom||1.0;
    } else {
      pinch.target='camera';
      pinch.z0=camZoom;
    }
    stick.active=false;stick.id=null; action.active=false;action.id=null;
    e.preventDefault(); return;
  }
  for(const t of e.changedTouches){
    const b=hitTouchBtn(t.clientX,t.clientY);
    if(b){
      // b.k is the DEFAULT key for that action; send whatever it is bound to now,
      // or canonKey() on the way in would treat it as a key that does nothing.
      const _bk=keyForDefault(b.k);
      window.dispatchEvent(new KeyboardEvent('keydown',{key:_bk,bubbles:true}));
      window.dispatchEvent(new KeyboardEvent('keyup',{key:_bk,bubbles:true}));
      continue;
    }
    // hotbar tap fires the slot (before the joystick/attack zones claim it)
    if(!modalOpen()&&!G.editorOpen){
      const hi=hotbarSlotAt(t.clientX,t.clientY);
      if(hi!==-1){fireHotbarSlot(hi);continue;}
    }
    // an open menu or minimap: drive it like a mouse so all its buttons/drag/resize work
    let shouldFwd = modalOpen();
    if (!shouldFwd && G.minimapOpen) {
      const {mx, my, sz} = minimapRect();
      const margin = 10;
      if (t.clientX >= mx - margin && t.clientX <= mx + sz + margin && t.clientY >= my - margin && t.clientY <= my + sz + margin) {
        shouldFwd = true;
      }
    }
    if(shouldFwd){ if(uiTouch.id===null) uiTouch.id=t.identifier; _fwdMouse('mousedown',t.clientX,t.clientY); continue; }
    // build / house-placement: tap places at that spot if outside the stick zone
    // Thumb zone for the movement stick. 30% of a narrow phone is only ~110px,
    // which is a cramped target, so give small screens a wider share.
    const touchLimit = Math.min(innerWidth * (innerWidth < 500 ? 0.42 : 0.3)
                                 * Math.max(0.6, Math.min(1.5, prefs.stickZone || 1)), 300);
    if((G.buildMode||G.housePlacementMode)&&t.clientX>=touchLimit){
      _fwdMouse('mousedown',t.clientX,t.clientY); _fwdMouse('mouseup',t.clientX,t.clientY,true); continue;
    }
    // radial hotwell: tap-hold the ◉ button and drag to a wedge to cast;
    // a long press instead picks the button up so it can be repositioned.
    const rb=radialBtn();
    if(!radialHidden()&&!uiBlocking()&&!radial.open&&Math.hypot(t.clientX-rb.x,t.clientY-rb.y)<=rb.r+10){
      openRadial();radial.id=t.identifier;beginRadialHold(t.identifier);continue;
    }
    if(t.clientX<touchLimit&&!stick.active){stick.active=true;stick.id=t.identifier;stick.baseX=t.clientX;stick.baseY=t.clientY;stick.dx=0;stick.dy=0;}
    else if(t.clientX>=touchLimit&&!action.active){action.active=true;action.id=t.identifier;action.sx=t.clientX;action.sy=t.clientY;}
  }e.preventDefault();
},{passive:false});
G.canvas.addEventListener('touchmove',e=>{
  if(pinch.active&&e.touches.length>=2){
    const d=_tDist(e.touches[0],e.touches[1]);
    if(d>8){
      if(pinch.target==='minimap'){
        G.minimapZoom=Math.max(1.0,Math.min(12.0,pinch.z0*(d/pinch.d0)));
      } else {
        camZoom=Math.max(0.3,Math.min(3.0,pinch.z0*pinch.d0/d));
      }
    }
    e.preventDefault(); return;
  }
  for(const t of e.changedTouches){
    if(uiTouch.id!==null&&t.identifier===uiTouch.id){_fwdMouse('mousemove',t.clientX,t.clientY);continue;}
    if(radialDrag&&t.identifier===radialDrag.id){moveRadialTo(t.clientX,t.clientY);continue;}
    if(radial.open&&t.identifier===radial.id){
      const rb0=radialBtn();
      if(Math.hypot(t.clientX-rb0.x,t.clientY-rb0.y)>14) endRadialHold();  // it's a flick, not a hold
      updateRadial(t.clientX,t.clientY);continue;
    }
    if(t.identifier===stick.id){stick.dx=t.clientX-stick.baseX;stick.dy=t.clientY-stick.baseY;}
    if(t.identifier===action.id){action.sx=t.clientX;action.sy=t.clientY;}
  }e.preventDefault();
},{passive:false});
function endTouch(e){
  if(e.touches.length<2){pinch.active=false;pinch.target=null;}
  for(const t of e.changedTouches){
    if(uiTouch.id!==null&&t.identifier===uiTouch.id){_fwdMouse('mouseup',t.clientX,t.clientY,true);uiTouch.id=null;continue;}
    if(radialDrag&&t.identifier===radialDrag.id){finishRadialDrag();continue;}
    if(radial.open&&t.identifier===radial.id){endRadialHold();triggerRadial();continue;}
    if(t.identifier===stick.id){stick.active=false;stick.id=null;stick.dx=0;stick.dy=0;}if(t.identifier===action.id){action.active=false;action.id=null;}
  }
}
G.canvas.addEventListener('touchend',endTouch);G.canvas.addEventListener('touchcancel',endTouch);

function minimapRect(){
  const sz=G.minimapSz!==null?G.minimapSz:MINIMAP_BASE;
  const mx=G.minimapX!==null?G.minimapX:G.canvas.width-sz-10;
  const my=G.minimapY!==null?G.minimapY:G.canvas.height-sz-10;
  return{mx,my,sz};
}

G.canvas.addEventListener('mousedown',e=>{
  // First person with the mouse released — Esc, alt-tab, a boot-time request the browser
  // refused, or a menu we just closed. The click buys the look back rather than swinging
  // at something you cannot aim at. Once held, clicks behave normally again.
  //
  // This is also why no hint is needed: the recovery IS a click, and clicking is what you
  // were going to do. Pointer Lock cannot be entered without a user gesture, so a click
  // is the closest to automatic the browser permits.
  if(camMode().fp && document.pointerLockElement!==G.canvas && e.button===0 && !modalOpen()){
    requestLook(); e.preventDefault(); return;
  }
  if(G.charSelectOpen&&e.button===0){handleCharSelectClick(e);return;}
  if(G.charCreatorOpen&&e.button===0){handleCharCreatorClick(e);return;}
  // the jewelry picker floats outside the doll panel — route to it first
  if(G.dollOpen&&G.dollPick&&e.button===0&&handleDollClick(e))return;
  if(e.button===0&&panelDragStart(e.clientX,e.clientY))return;   // grab a panel header
  if(G.gambitOpen&&e.button===0){handleGambitClick(e);return;}
  // hotbar: press a slot — a plain click fires it on release, dragging moves
  // it (slot↔slot swap, off the bar to unbind). Middle-click (no drag) fires
  // the selected slot; middle-DRAG orbits the camera (spin + tilt).
  if(!G.editorOpen){
    if(e.button===0){
      const hi=hotbarSlotAt(e.clientX,e.clientY);
      if(hi!==-1){
        // Dragging rearranges the bar, and rearranging is what the pack is for. With the
        // pack closed a hotbar click just fires the slot — which also stops a click that
        // moved a few pixels mid-fight from silently unbinding something.
        if(hotbar[hi] && G.backpackOpen)
          uiDrag={src:'hotbar',slotIdx:hi,sx:e.clientX,sy:e.clientY,x:e.clientX,y:e.clientY,moved:false};
        else fireHotbarSlot(hi);                    // fire it (empty slots just select)
        return;
      }
    }
  }
  if(e.button===1){e.preventDefault();camOrbit={lx:e.clientX,ly:e.clientY,dist:0,moved:false};return;}
  // radial wheel: press the ◉ button to open, drag to a wedge, release
  if(e.button===0&&!radialHidden()&&!uiBlocking()&&!player.dead){
    const b=radialBtn();
    if(Math.hypot(e.clientX-b.x,e.clientY-b.y)<=b.r+6){openRadial();radial.id='mouse';beginRadialHold('mouse');return;}
  }
  if(G.editorOpen){
    if(e.button===2)e.preventDefault();
    // pixel studio first (its buttons, palette, and paint grid)
    if(G.pixelOpen){
      for(const h of psHit){
        if(e.clientX>=h.x&&e.clientX<=h.x+h.w&&e.clientY>=h.y&&e.clientY<=h.y+h.h){if(e.button===0)h.fn();return;}
      }
      const cellHit=psPixelAt(e.clientX,e.clientY);
      if(cellHit){
        if(e.button===2){psPick(cellHit[0],cellHit[1]);return;}     // RMB = quick dropper
        if(psTool==='pick'){psPick(cellHit[0],cellHit[1]);return;}
        psPushUndo();
        if(psTool==='fill'){psFill(cellHit[0],cellHit[1]);return;}
        psPen(cellHit[0],cellHit[1]); mouse.down=true; return;      // drag to keep drawing
      }
      const pr=panelRects['pixel'];
      if(pr&&e.clientX>=pr.x&&e.clientX<=pr.x+pr.w&&e.clientY>=pr.y&&e.clientY<=pr.y+pr.h)return;
    }
    // panel buttons first
    for(const h of edHit){
      if(e.clientX>=h.x&&e.clientX<=h.x+h.w&&e.clientY>=h.y&&e.clientY<=h.y+h.h){if(e.button===0)h.fn();return;}
    }
    if(edOverPanel(e.clientX,e.clientY))return;
    // world interaction
    const w=screenToWorld(e.clientX,e.clientY);
    if(edState.tab==='map'){
      mouse.sx=e.clientX;mouse.sy=e.clientY;mouse.hasPos=true;
      if(e.button===0){mouse.down=true;edPaint(w.x,w.y,false);}
      else if(e.button===2){rmb.down=true;edPaint(w.x,w.y,true);}
    } else {
      if(e.button===0)edPlaceMob(w.x,w.y);
      else if(e.button===2)edRemoveMob(w.x,w.y);
    }
    return;
  }
  if(G.questOpen&&e.button===0){G.questOpen=false;return;}
  if(G.tutorialOpen&&e.button===0){
    for(const h of tutHit){
      if(e.clientX>=h.x&&e.clientX<=h.x+h.w&&e.clientY>=h.y&&e.clientY<=h.y+h.h){h.fn();return;}
    }
    closeTutorial();return;
  }
  if(G.dollOpen&&e.button===0){
    const r=panelRects['doll'];
    if(r&&e.clientX>=r.x+r.w-12&&e.clientX<=r.x+r.w&&e.clientY>=r.y+r.h-12&&e.clientY<=r.y+r.h){
      dollResize={sx:e.clientX,sy:e.clientY,s0:dollScale()};return;     // corner grab
    }
    if(handleDollClick(e))return;   // slots, picker, gender toggle; false = clicked outside
  }
  if(G.minimapOpen&&e.button===0){
    const{mx,my,sz}=minimapRect(),CORN=12;
    if(e.clientX>=mx+sz-CORN&&e.clientX<=mx+sz+4&&e.clientY>=my+sz-CORN&&e.clientY<=my+sz+4){G.minimapResize={ox:e.clientX,oy:e.clientY,startSz:sz,startMx:G.minimapX,startMy:G.minimapY};return;}
    if(e.clientX>=mx-2&&e.clientX<=mx+sz+2&&e.clientY>=my-2&&e.clientY<=my+sz+2){G.minimapDrag={ox:e.clientX-mx,oy:e.clientY-my};return;}
  }
  if(e.button===2){
    e.preventDefault();if(G.craftOpen||G.buildMode)return;
    if(player.ghost){rmb.down=true;return;}if(player.dead)return;
    // Use raycasted world position for wall dismantling
    const w=screenToWorld(e.clientX,e.clientY),wx=w.x,wy=w.y;
    const tx=Math.floor(wx/TILE),ty=Math.floor(wy/TILE);
    // Right-click pickup. Screen-space pick first (the only thing that can hit a
    // wall mount), then the original ground-plane test as a fallback.
    const existingObj = pickPlacedObject(e.clientX, e.clientY)
      || placedObjects.find(o => !o.face && Math.hypot(o.x - wx, o.y - wy) < TILE * 1.1);
    if (existingObj && Math.hypot(existingObj.x - player.x, existingObj.y - player.y) <= HARVEST_RANGE) {
      // A doused campfire relights instead of being picked up. To take a spent
      // one home, relight it and right-click again — the lit one picks up
      // normally, so this is never a dead end.
      if (relightPlaced(existingObj)) return;
      removePlacedObject(existingObj, true);
      return;
    }
    if(tx>=0&&ty>=0&&tx<MAP_W&&ty<MAP_H&&map[ty][tx]===T.WALL){
      const cx=tx*TILE+TILE/2,cy=ty*TILE+TILE/2;
      if(Math.hypot(cx-player.x,cy-player.y)<=HARVEST_RANGE){
        if(isInsidePlacedHouse(tx, ty)){addFloater(cx,cy-12,"can't dismantle house!");return;}
        if(!playerPlacedWalls[ty][tx]){addFloater(cx,cy-12,"can't dismantle!");return;}
        map[ty][tx]=T.GRASS;origTile[ty][tx]=T.GRASS;playerPlacedWalls[ty][tx]=false;
        bakeStaticTile(tx,ty);minimapUpdateTile(tx,ty);inv.planks+=1;addFloater(cx,cy-12,'+1 plank');return;
      }
    }
    // Right-click places whatever placeable is in hand. This was two copy-pasted
    // blocks that only knew about torch and lantern — every other placeable was
    // craft-panel-only. Now all eight go through the one path.
    const held=heldPlaceable();
    if(held){
      // Aim at the wall itself, not its footprint: raycast the wall meshes first
      // so clicking the visible face mounts there. Falls back to the ground tile.
      const def=PLACEABLES[held];
      if(def.surfaces.includes('wall')){
        const w=pickWallTile(e.clientX,e.clientY);
        if(w && placePlaceable(held,w.tx,w.ty,false,w.point)) return;
      }
      if(placePlaceable(held,tx,ty)) return;
    }
    rmb.down=true;return;
  }
  if(G.tradeInvite){ if(handleTradeInviteClick(e))return; }
  if(G.trade){ if(!handleTradeClick(e))G.trade=null; return; }
  if(G.backpackOpen){ if(!handleBackpackClick(e))G.backpackOpen=false; return; }
  if(G.charOpen){ if(!handleCharPanelClick(e))G.charOpen=false; return; }
  if(G.contractsOpen){ if(!handleContractClick(e))G.contractsOpen=false; return; }
  if(G.worldChestOpen){ if(!handleWorldChestClick(e)){G.worldChestOpen=false;G.activeWorldChest=null;} return; }
  if(G.smithOpen){if(!handleSmithClick(e))G.smithOpen=false;return;}
  if(G.mageOpen){if(!handleMageClick(e))G.mageOpen=false;return;}
  if(G.farrierOpen){if(!handleFarrierClick(e))G.farrierOpen=false;return;}
  if(G.antiqOpen){if(!handleAntiqClick(e))G.antiqOpen=false;return;}
  if(G.cryptoOpen){if(!handleCryptoClick(e))G.cryptoOpen=false;return;}
  if(G.curatorOpen){if(!handleCuratorClick(e))G.curatorOpen=false;return;}
  if(G.robberOpen){if(!handleRobberClick(e))G.robberOpen=false;return;}
  if(G.houseMenuOpen){if(!handleHouseMenuClick(e))G.houseMenuOpen=false;return;}
  if(G.houseSettingsOpen){if(!handleHouseSettingsClick(e))G.houseSettingsOpen=false;return;}
  if(G.settingsOpen){if(!handleSettingsClick(e))G.settingsOpen=false;return;}
  if(G.devGuiOpen){if(!handleDevClick(e))G.devGuiOpen=false;return;}
  if(G.housePlacementMode){
    if(e.button===0){
      const w=screenToWorld(e.clientX,e.clientY);
      placeHouse(w.x,w.y);
    }
    return;
  }
  // click a nearby player to request a trade (online)
  if(e.button===0&&net.status==='online'&&!G.trade){
    const wp=screenToWorld(e.clientX,e.clientY);
    if(tryStartTradeAt(wp.x,wp.y))return;
  }
  // click a house door within reach to open/close it (before other actions)
  if(e.button===0&&G.placedHouses&&G.placedHouses.length){
    const wd=screenToWorld(e.clientX,e.clientY),di=getHouseDoorAt(wd.x,wd.y);
    if(di>=0){
      const d=houseDoorTile(G.placedHouses[di]);
      const dcx=d.tx*TILE+TILE/2, dcy=d.ty*TILE+TILE/2;
      if(Math.hypot(dcx-player.x,dcy-player.y)<TILE*3){ toggleHouseDoor(di); return; }
    }
  }
  // click a secure chest within reach to open it
  if(e.button===0&&!player.dead){
    const wd=screenToWorld(e.clientX,e.clientY);
    const chest = placedObjects.find(o => o.type==='secure_chest' && Math.hypot(o.x-wd.x, o.y-wd.y)<TILE*0.9);
    if(chest){
      if(Math.hypot(chest.x-player.x, chest.y-player.y)<TILE*3.2){
        openSecureChest(chest);
        return;
      }
    }
  }
  if(player.weapon==='house_tool'&&!G.houseMenuOpen&&!G.housePlacementMode){
    if(e.button===0){G.houseMenuOpen=true;return;}
  }
  if(G.corpseLootOpen){
    const W=240,H=220,PAD=14,{px,py}=corpseXY();
    const btnY=py+H-44;
    if(e.clientX>=px+PAD&&e.clientX<=px+W-PAD&&e.clientY>=btnY&&e.clientY<=btnY+30){takeAllCorpse();return;}
    G.corpseLootOpen=false;return;
  }
  if(G.chestOpen){if(!handleChestClick(e))G.chestOpen=false;return;}
  if(G.bankOpen){if(!handleBankClick(e))G.bankOpen=false;return;}
  if(G.tradeOpen){
    for(const r of tradeRects()){
      if(e.clientX>=r.buyX&&e.clientX<=r.buyX+r.btnW&&e.clientY>=r.y+4&&e.clientY<=r.y+4+r.btnH){doBuy(r.item);return;}
      if(e.clientX>=r.sellX&&e.clientX<=r.sellX+r.btnW&&e.clientY>=r.y+4&&e.clientY<=r.y+4+r.btnH){doSell(r.item);return;}
      if(r.item.kind==='res'&&e.clientX>=r.sellAllX&&e.clientX<=r.sellAllX+r.btnW&&e.clientY>=r.y+4&&e.clientY<=r.y+4+r.btnH){doSellAll(r.item);return;}
    }
    G.tradeOpen=false;return;
  }
  if(G.craftOpen){
    const _hit=(r)=>e.clientX>=r.x&&e.clientX<=r.x+r.w&&e.clientY>=r.y&&e.clientY<=r.y+r.h;
    // Arrows first: they sit in the header, but testing them after the rows would let a
    // stray overlap craft something instead of scrolling.
    if(craftMaxScroll()>0){
      const b=craftScrollBtns();
      if(_hit(b.up)){   G.craftScroll=Math.max(0,(G.craftScroll||0)-1); return; }
      if(_hit(b.down)){ G.craftScroll=Math.min(craftMaxScroll(),(G.craftScroll||0)+1); return; }
    }
    for(const r of recipeRects())if(r.vis&&_hit(r)){doCraft(r.id);return;}
    G.craftOpen=false;return;
  }
  if(G.buildMode){const w=screenToWorld(e.clientX,e.clientY);placeItem(w.x,w.y);return;}
  if(aggroBtnRect&&e.button===0&&e.clientX>=aggroBtnRect.x&&e.clientX<=aggroBtnRect.x+aggroBtnRect.w&&e.clientY>=aggroBtnRect.y&&e.clientY<=aggroBtnRect.y+aggroBtnRect.h){toggleAggro();return;}
  mouse.down=true;mouse.sx=e.clientX;mouse.sy=e.clientY;mouse.hasPos=true;
});
G.canvas.addEventListener('mousemove',e=>{
  if(setSliderDrag){ const{row,ctl}=setSliderDrag; row.set(sliderValueAt(row,ctl,e.clientX)); return; }
  // Pointer-locked first person: the cursor no longer exists, so the movement
  // deltas turn the head instead. mouse.sx/sy are pinned to the centre of the
  // screen so everything downstream that aims at "where the cursor is" — the
  // attack ray, RMB move-toward — aims at the crosshair, which is what a first
  // person view means.
  if(document.pointerLockElement===G.canvas){
    // 0.0022 rad/px was the shipped feel, so a sensitivity of 1.0 is exactly
    // what it always was -- nobody's aim changes unless they ask for it.
    const _sens=0.0022*(prefs.lookSens||1), _iy=prefs.invertY?-1:1;
    camAngle=(camAngle - e.movementX*_sens + Math.PI*2)%(Math.PI*2);
    fpPitch=Math.max(-FP_PITCH_LIMIT,Math.min(FP_PITCH_LIMIT,fpPitch - e.movementY*_sens*_iy));
    mouse.sx=innerWidth*0.5; mouse.sy=innerHeight*0.5; mouse.hasPos=true;
    return;
  }
  // First person without the lock: cursor motion IS the look, no button held.
  // Aim stays pinned to the crosshair exactly as it is under the lock, so the
  // attack ray and RMB move-toward agree with what the centre of the screen is
  // pointing at rather than with where the cursor happens to be.
  // Already handled by the window-capture listener above, which runs first and
  // sees moves this one never gets (anything over the platform's top-strip
  // chrome). Just step aside so the cursor-position path below does not also
  // run and move the aim off the crosshair.
  if(fpFreeLookActive()) return;
  mouse.sx=e.clientX;mouse.sy=e.clientY;mouse.hasPos=true;
  if(uiDrag){                      // item drag: ghost follows the cursor
    uiDrag.x=e.clientX;uiDrag.y=e.clientY;
    if(Math.hypot(e.clientX-uiDrag.sx,e.clientY-uiDrag.sy)>6)uiDrag.moved=true;
    if(uiDrag.moved)return;
  }
  if(camOrbit){                    // middle-mouse drag: spin (x) + tilt (y)
    const dx=e.clientX-camOrbit.lx, dy=e.clientY-camOrbit.ly;
    camOrbit.lx=e.clientX; camOrbit.ly=e.clientY;
    camOrbit.dist+=Math.abs(dx)+Math.abs(dy);
    if(camOrbit.dist>6)camOrbit.moved=true;
    camAngle=(camAngle - dx*0.006 + Math.PI*2)%(Math.PI*2);
    // In first person the vertical drag is a look, not an orbit tilt — camPitch
    // is meaningless there and changing it would silently alter the framing you
    // return to when you step back out.
    if(camMode().fp) fpPitch=Math.max(-FP_PITCH_LIMIT,Math.min(FP_PITCH_LIMIT,fpPitch - dy*0.005));
    else camPitch=Math.max(0.06,Math.min(1.54,camPitch - dy*0.005));
    return;
  }
  if(radialDrag&&radialDrag.id==='mouse'){moveRadialTo(e.clientX,e.clientY);return;}
  if(radial.open&&radial.id==='mouse'){
    const rb0=radialBtn();
    if(Math.hypot(e.clientX-rb0.x,e.clientY-rb0.y)>14) endRadialHold();
    updateRadial(e.clientX,e.clientY);return;
  }
  if(dollResize){
    const d=((e.clientX-dollResize.sx)+(e.clientY-dollResize.sy))/2;
    (panelOfs.doll??={x:0,y:0}).s=Math.max(0.7,Math.min(2,dollResize.s0+d/140));
    return;
  }
  if(packResize){
    const d=((e.clientX-packResize.sx)+(e.clientY-packResize.sy))/2;
    (panelOfs.backpack??={x:0,y:0}).s=Math.max(0.7,Math.min(1.8,packResize.s0+d/160));
    return;
  }
  if(panelDragMove(e.clientX,e.clientY))return;
  if(G.minimapResize){
    const delta=Math.max(e.clientX-G.minimapResize.ox,e.clientY-G.minimapResize.oy);
    G.minimapSz=Math.max(80,Math.min(Math.min(G.canvas.width*0.5,G.canvas.height*0.5),Math.round(G.minimapResize.startSz+delta)));
    const mx2=G.minimapResize.startMx!==null?G.minimapResize.startMx:G.canvas.width-G.minimapSz-10;
    if(G.minimapX!==null)G.minimapX=Math.max(0,Math.min(G.canvas.width-G.minimapSz-4,mx2));return;
  }
  if(G.minimapDrag){
    const sz=G.minimapSz!==null?G.minimapSz:MINIMAP_BASE;
    G.minimapX=Math.max(0,Math.min(G.canvas.width-sz-4,e.clientX-G.minimapDrag.ox));
    G.minimapY=Math.max(0,Math.min(G.canvas.height-sz-4,e.clientY-G.minimapDrag.oy));return;
  }
  if(G.minimapOpen){const{mx,my,sz}=minimapRect();G.minimapHover=e.clientX>=mx-2&&e.clientX<=mx+sz+2&&e.clientY>=my-2&&e.clientY<=my+sz+2;}
});
window.addEventListener('mouseup',e=>{if(e.button===1){if(camOrbit&&!camOrbit.moved&&!G.editorOpen&&!uiBlocking()&&!player.dead)fireHotbarSlot(G.hotbarSel);camOrbit=null;return;}if(e.button===0&&uiDrag){finishUiDrag(e);mouse.down=false;return;}panelDragEnd();if(radialDrag&&radialDrag.id==='mouse'){finishRadialDrag();return;}if(radial.open&&radial.id==='mouse'){endRadialHold();triggerRadial();return;}if(dollResize||packResize){dollResize=null;packResize=null;try{localStorage.setItem(PANEL_POS_KEY,JSON.stringify(panelOfs));}catch(_){}}if(e.button===2){rmb.down=false;return;}G.minimapDrag=null;G.minimapResize=null;mouse.down=false;});
G.canvas.addEventListener('contextmenu',e=>e.preventDefault());
G.canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  if(G.minimapOpen){
    const{mx,my,sz}=minimapRect();
    if(e.clientX>=mx-2&&e.clientX<=mx+sz+2&&e.clientY>=my-2&&e.clientY<=my+sz+2){
      G.minimapZoom=Math.max(1.0,Math.min(12.0,G.minimapZoom*(e.deltaY>0?0.82:1.22)));
      return;
    }
  }
  // craft open: wheel over the panel scrolls the recipe list. 35 recipes do not fit
  // a phone in one column, so without this the lower half is unreachable.
  if(G.craftOpen){
    const {px,py}=panelXY();
    if(e.clientX>=px&&e.clientX<=px+PANEL_W&&e.clientY>=py&&e.clientY<=py+PANEL_H){
      G.craftScroll=Math.max(0,Math.min(craftMaxScroll(),(G.craftScroll||0)+(e.deltaY>0?1:-1)));
      return;
    }
  }
  // backpack open: wheel over the bag scrolls its grid rows
  if(G.backpackOpen){
    const g=packGridRect();
    if(e.clientX>=g.x-14&&e.clientX<=g.x+g.w+34&&e.clientY>=g.y-14&&e.clientY<=g.y+g.h+14){
      G.packScroll=Math.max(0,Math.min(packMaxScroll(),G.packScroll+(e.deltaY>0?1:-1)));
      return;
    }
  }
  // plain wheel cycles the hotbar (UO-vet ask: scroll to change weapons);
  // Ctrl+wheel — or scrolling while a panel is up / dead — zooms the camera
  if(!e.ctrlKey&&!uiBlocking()&&!player.dead&&!player.ghost){
    cycleHotbar(e.deltaY>0?1:-1);
    return;
  }
  camZoom=Math.max(0.3,Math.min(3.0,camZoom*(e.deltaY>0?1.12:0.89)));
},{passive:false});
G.canvas.tabIndex=0;

// ── UI Panels ─────────────────────────────────────────────────────
function renderCraftPanel(){
  const ctx=G.ctx,{px,py}=panelXY(),wb=nearbyObject('workbench',3);
  const fg=nearbyObject('forge',3)||Math.hypot(BLACKSMITH.x-player.x,BLACKSMITH.y-player.y)<TILE*2.5;
  ctx.fillStyle='rgba(18,13,8,.93)';ctx.fillRect(px,py,PANEL_W,PANEL_H);
  ctx.strokeStyle='#c8a25a';ctx.lineWidth=1.5;ctx.strokeRect(px,py,PANEL_W,PANEL_H);
  ctx.fillStyle='#c8a25a';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('CRAFTING  ·  C to close',px+PANEL_W/2,py+HEADER_H-8);
  // Tell the player there is more, and roughly where they are. Without this a
  // single-column list looks like the whole recipe book is six items long.
  const _maxS=craftMaxScroll();
  if(_maxS>0){
    const rowsTotal=Math.ceil(RECIPES.length/craftCols());
    const b=craftScrollBtns();
    const arrow=(r,glyph,on)=>{
      ctx.fillStyle=on?'rgba(90,65,20,.9)':'rgba(30,26,20,.8)';ctx.fillRect(r.x,r.y,r.w,r.h);
      ctx.strokeStyle=on?'#c8a25a':'rgba(100,90,80,.35)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
      ctx.fillStyle=on?'#e8dcc0':'#555';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';
      ctx.textAlign='center';ctx.fillText(glyph,r.x+r.w/2,r.y+r.h/2+4.5);
    };
    arrow(b.up,'▲',G.craftScroll>0);
    arrow(b.down,'▼',G.craftScroll<_maxS);
    ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillStyle='rgba(200,162,90,.75)';ctx.textAlign='left';
    ctx.fillText('rows '+(G.craftScroll+1)+'-'+Math.min(G.craftScroll+craftRowsVisible(),rowsTotal)+' of '+rowsTotal,
                 px+PANEL_PAD,py+HEADER_H+22);
    ctx.textAlign='center';
  }
  ctx.strokeStyle='rgba(200,162,90,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+HEADER_H);ctx.lineTo(px+PANEL_W-8,py+HEADER_H);ctx.stroke();
  const rects=recipeRects();
  for(const r of rects){
    if(!r.vis) continue;
    const rec=r.rec,can=canCraft(rec.id);
    let locked=false;
    if(rec.adv){
      if(rec.id==='iron_ingot') locked=!fg;
      else if(rec.id==='steel_sword'||rec.id==='steel_bow'||rec.id==='steel_arm') locked=!(wb||fg);
      else if(rec.id==='anvil') locked=!(wb&&fg);
      else locked=!wb;
    }
    ctx.fillStyle=locked?'rgba(25,20,15,.9)':can?'rgba(90,65,20,.9)':'rgba(38,33,28,.9)';ctx.fillRect(r.x,r.y,r.w,r.h);
    ctx.strokeStyle=locked?'rgba(80,70,60,.4)':can?'#c8a25a':'rgba(100,90,80,.4)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
    ctx.textAlign='center';ctx.fillStyle=locked?'#443':can?'#e8dcc0':'#555';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(rec.top,r.x+r.w/2,r.y+14);
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle=locked?'#443':can?'#a08040':'#444';ctx.fillText(rec.sub(),r.x+r.w/2,r.y+27);
  }
  ctx.textAlign='left';
}
function renderTradePanel(){
  const ctx=G.ctx,{px,py}=tradePanelXY();
  ctx.fillStyle='rgba(10,6,18,.95)';ctx.fillRect(px,py,TRADE_W,TRADE_H);
  ctx.strokeStyle='#9a7aaa';ctx.lineWidth=1.5;ctx.strokeRect(px,py,TRADE_W,TRADE_H);
  ctx.fillStyle='#9a7aaa';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('MERCHANT  ·  E to close',px+TRADE_W/2,py+18);
  ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g',px+TRADE_W/2,py+35);
  ctx.strokeStyle='rgba(150,120,180,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+TRADE_HEADER);ctx.lineTo(px+TRADE_W-8,py+TRADE_HEADER);ctx.stroke();
  const rects=tradeRects();
  for(let i=0;i<TRADE_ITEMS.length;i++){
    const r=rects[i],item=TRADE_ITEMS[i];
    if(i===5){ctx.fillStyle='rgba(150,120,180,.15)';ctx.fillRect(px+8,r.y-TRADE_SECT_H+2,TRADE_W-16,1);ctx.fillStyle='#7a6a9a';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='left';ctx.fillText('— Equipment —',px+TRADE_PAD,r.y-2);}
    ctx.fillStyle='rgba(35,20,55,.85)';ctx.fillRect(r.x,r.y,r.w,r.h);
    ctx.textAlign='left';ctx.fillStyle='#d0c0e8';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';
    const stock=item.kind==='res'?' (have '+(inv[item.key]||0)+')':player[item.pkey]?' ★':'';
    ctx.fillText(item.label+stock,r.x+6,r.y+r.h/2+4);
    const cB=canBuy(item);
    ctx.fillStyle=cB?'rgba(50,110,35,.9)':'rgba(25,35,20,.7)';ctx.fillRect(r.buyX,r.y+4,r.btnW,r.btnH);
    ctx.strokeStyle=cB?'#6c3':'rgba(50,65,40,.5)';ctx.lineWidth=1;ctx.strokeRect(r.buyX,r.y+4,r.btnW,r.btnH);
    ctx.fillStyle=cB?'#90e040':'#334';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(item.buy+'g buy',r.buyX+r.btnW/2,r.y+r.h/2+4);
    const cS=canSell(item);
    ctx.fillStyle=cS?'rgba(110,50,20,.9)':'rgba(35,20,10,.7)';ctx.fillRect(r.sellX,r.y+4,r.btnW,r.btnH);
    ctx.strokeStyle=cS?'#c84':'rgba(70,40,20,.5)';ctx.lineWidth=1;ctx.strokeRect(r.sellX,r.y+4,r.btnW,r.btnH);
    ctx.fillStyle=cS?'#f0a050':'#330';ctx.textAlign='center';ctx.fillText(item.sell+'g sell',r.sellX+r.btnW/2,r.y+r.h/2+4);
    if(item.kind==='res'){
      ctx.fillStyle=cS?'rgba(140,40,15,.9)':'rgba(35,15,10,.7)';ctx.fillRect(r.sellAllX,r.y+4,r.btnW,r.btnH);
      ctx.strokeStyle=cS?'#d53':'rgba(70,30,20,.5)';ctx.lineWidth=1;ctx.strokeRect(r.sellAllX,r.y+4,r.btnW,r.btnH);
      ctx.fillStyle=cS?'#ffa870':'#320';ctx.textAlign='center';ctx.fillText('all',r.sellAllX+r.btnW/2,r.y+r.h/2+4);
    }
  }
  ctx.textAlign='left';
}
function renderBankPanel(){
  const ctx=G.ctx,{px,py}=bankPanelXY();
  ctx.fillStyle='rgba(10,8,4,.97)';ctx.fillRect(px,py,BANK_W,BANK_H);
  ctx.strokeStyle='#c8a030';ctx.lineWidth=2;ctx.strokeRect(px,py,BANK_W,BANK_H);
  ctx.fillStyle='#c8a030';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('🏦 CITY BANK  ·  E to close',px+BANK_W/2,py+20);
  ctx.strokeStyle='rgba(200,160,48,.4)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+BANK_HEADER);ctx.lineTo(px+BANK_W-8,py+BANK_HEADER);ctx.stroke();
  const earnRate=Math.round(bank.gold*0.01*10)/10;
  ctx.textAlign='left';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillStyle='#d0c090';ctx.fillText('On hand:',px+BANK_PAD,py+65);ctx.fillStyle='#f0d060';ctx.fillText(inv.gold+'g',px+BANK_W-BANK_PAD-ctx.measureText(inv.gold+'g').width,py+65);
  ctx.fillStyle='#d0c090';ctx.fillText('Deposited:',px+BANK_PAD,py+84);ctx.fillStyle='#70e070';ctx.fillText(bank.gold+'g',px+BANK_W-BANK_PAD-ctx.measureText(bank.gold+'g').width,py+84);
  ctx.fillStyle='#d0c090';ctx.fillText('Interest:',px+BANK_PAD,py+103);ctx.fillStyle='rgba(120,220,120,.8)';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(bank.gold>0?'+'+earnRate+'g/min':'0g (deposit to earn)',px+BANK_PAD+70,py+103);
  ctx.strokeStyle='rgba(200,160,48,.25)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+116);ctx.lineTo(px+BANK_W-8,py+116);ctx.stroke();
  ctx.fillStyle='#a08030';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='left';ctx.fillText('DEPOSIT',px+BANK_PAD,py+132);
  const dAmts=[10,50,'all'],dLabels=['+10g','+50g','+all'];
  for(let i=0;i<3;i++){const bx=px+BANK_PAD+i*(BANK_BTN_W+6),by=py+138,can=dAmts[i]==='all'?inv.gold>0:inv.gold>=dAmts[i];ctx.fillStyle=can?'rgba(80,60,10,.9)':'rgba(30,25,5,.7)';ctx.fillRect(bx,by,BANK_BTN_W,BANK_BTN_H);ctx.strokeStyle=can?'#c8a030':'rgba(80,70,30,.4)';ctx.lineWidth=1;ctx.strokeRect(bx,by,BANK_BTN_W,BANK_BTN_H);ctx.fillStyle=can?'#f0d060':'#554';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(dLabels[i],bx+BANK_BTN_W/2,by+18);}
  ctx.strokeStyle='rgba(200,160,48,.25)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+178);ctx.lineTo(px+BANK_W-8,py+178);ctx.stroke();
  ctx.fillStyle='#a08030';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='left';ctx.fillText('WITHDRAW',px+BANK_PAD,py+194);
  const wAmts=[10,50,'all'],wLabels=['-10g','-50g','-all'];
  for(let i=0;i<3;i++){const bx=px+BANK_PAD+i*(BANK_BTN_W+6),by=py+200,can=wAmts[i]==='all'?bank.gold>0:bank.gold>=wAmts[i];ctx.fillStyle=can?'rgba(10,50,20,.9)':'rgba(5,20,10,.7)';ctx.fillRect(bx,by,BANK_BTN_W,BANK_BTN_H);ctx.strokeStyle=can?'#40a040':'rgba(30,60,30,.4)';ctx.lineWidth=1;ctx.strokeRect(bx,by,BANK_BTN_W,BANK_BTN_H);ctx.fillStyle=can?'#70e070':'#354';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(wLabels[i],bx+BANK_BTN_W/2,by+18);}
  ctx.textAlign='left';
}
function corpseXY(){return panelAt('corpse', Math.round(G.canvas.width/2-120), Math.round(G.canvas.height/2-110), 240, 220);}
function renderCorpseLoot(){
  const ctx=G.ctx,W=240,H=220,PAD=14;
  const {px,py}=corpseXY();
  ctx.fillStyle='rgba(30,8,8,.96)';ctx.fillRect(px,py,W,H);ctx.strokeStyle='#cc4444';ctx.lineWidth=1.5;ctx.strokeRect(px,py,W,H);
  ctx.fillStyle='#cc6060';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('YOUR CORPSE  ·  E to close',px+W/2,py+18);ctx.textAlign='left';ctx.fillStyle='#e8c0a0';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';
  if(!G.corpse){ctx.fillText('(empty)',px+PAD,py+50);return;}
  const items=Object.entries(G.corpse.inv).filter(([,v])=>v>0);
  if(!items.length){ctx.textAlign='center';ctx.fillText('(no items)',px+W/2,py+90);ctx.textAlign='left';}
  let row=0;for(const[k,v]of items){const ry=py+38+row*28;ctx.fillStyle='rgba(80,20,20,.7)';ctx.fillRect(px+PAD,ry,W-PAD*2,24);ctx.fillStyle='#e8c0a0';
    if(isLootGear(k)&&drawLootThumb(k,px+PAD+3,ry+2,20,20)) ctx.fillText(itemLabel(k)+': '+v,px+PAD+27,ry+16);
    else ctx.fillText(itemLabel(k)+': '+v,px+PAD+6,ry+16);
    row++;}
  const btnY=py+H-44;ctx.fillStyle='rgba(160,40,40,.9)';ctx.fillRect(px+PAD,btnY,W-PAD*2,30);ctx.strokeStyle='#ee6060';ctx.lineWidth=1;ctx.strokeRect(px+PAD,btnY,W-PAD*2,30);ctx.fillStyle='#ffcccc';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('Take All',px+W/2,btnY+20);ctx.textAlign='left';
}
function renderBuildOverlay(){
  // Was a 3-entry map, so forge/secure_chest/hearth/anvil all rendered
  // "BUILD — undefined". Labels live in the registry now; wall is a map tile,
  // not a placed object, so it keeps its own name.
  const ctx=G.ctx;
  const label = G.buildItem==='wall' ? 'Wall' : (PLACEABLES[G.buildItem]?.label || G.buildItem);
  ctx.fillStyle='rgba(0,0,0,.65)';ctx.fillRect(G.canvas.width/2-160,8,320,28);ctx.fillStyle='#b8e890';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('BUILD — place '+label.toLowerCase()+'  ·  ESC cancel',G.canvas.width/2,27);ctx.textAlign='left';
  if(mouse.hasPos){
    const w=screenToWorld(mouse.sx,mouse.sy),tx=Math.floor(w.x/TILE),ty=Math.floor(w.y/TILE);
    if(tx>=0&&ty>=0&&tx<MAP_W&&ty<MAP_H){
      const cx=tx*TILE+TILE/2,cy=ty*TILE+TILE/2,valid=map[ty][tx]===T.GRASS&&Math.hypot(cx-player.x,cy-player.y)<=HARVEST_RANGE;
      buildHighlight.position.set(cx,1,cy);buildHighlight.material.color.setHex(valid?0x50d250:0xd23030);buildHighlight.material.opacity=valid?0.38:0.22;buildHighlight.visible=true;
    } else buildHighlight.visible=false;
  } else buildHighlight.visible=false;
}
const SKILL_PERKS = {
  tactics:   { 6:'★ Master Stance (+10% Crit)', 7:'★ Cleave (Arc Attack)', 8:'★ Executioner (+50% vs Low HP)', 9:'★ Whirlwind (360° Special)', 10:'★ Weaponmaster (+25% Dmg)' },
  archery:   { 6:'★ Eagle Eye (+15% Crit)', 7:'★ Longshot (+30% Range/Spd)', 8:'★ Piercing Volley (Pierces 3)', 9:'★ Rapid Fire (-40% Bow CD)', 10:'★ Deadeye (2.5x Crit Dmg)' },
  hiding:    { 6:'★ Shadow Stalker (+20% Spd)', 7:'★ Ambush (Guaranteed 2x Crit)', 8:'★ Vanish (-5s CD)', 9:'★ Smoke Screen (Stun on hide)', 10:'★ Ghostwalker (1-Hit Shield)' },
  healing:   { 6:'★ Quick Patch (-30% Time)', 7:'★ Rejuvenation (+25% HP Instant)', 8:'★ Purification (Cleanse Stuns)', 9:'★ Field Medic (Out-of-combat Regen)', 10:'★ Divine Grace (Death Ward CD 45s)' },
  wrestling: { 6:'★ Heavy Fists (+25% Dmg)', 7:'★ Iron Grip (+1.5s Stun & Slow)', 8:'★ Counter-Punch (20% Counter)', 9:'★ Ground Slam (AOE Stun)', 10:"★ Brawler's Might (Usable Armed)" },
};
function renderSkillPanel(){
  const ctx=G.ctx,{px,py}=panelAt('skills', Math.round(G.canvas.width/2-SKILL_PANEL_W/2), Math.round(G.canvas.height/2-SKILL_PANEL_H/2), SKILL_PANEL_W, SKILL_PANEL_H);
  ctx.fillStyle='rgba(8,12,20,.96)';ctx.fillRect(px,py,SKILL_PANEL_W,SKILL_PANEL_H);ctx.strokeStyle='#5a8aaa';ctx.lineWidth=1.5;ctx.strokeRect(px,py,SKILL_PANEL_W,SKILL_PANEL_H);
  ctx.fillStyle='#5a8aaa';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('SKILLS  ·  K to close',px+SKILL_PANEL_W/2,py+22);
  ctx.strokeStyle='rgba(90,138,170,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+32);ctx.lineTo(px+SKILL_PANEL_W-8,py+32);ctx.stroke();
  const SKDEFS=[
    {key:'tactics',label:'⚔ TACTICS',hint:'Sword dmg: '+TACTICS_DMG[tacticsLv()-1],active:false},
    {key:'archery',label:'🏹 ARCHERY',hint:'Arrow dmg: '+ARCHERY_DMG[archeryLv()-1],active:false},
    {key:'hiding',label:'👤 HIDING',hint:'Duration: '+HIDING_DUR[hidingLv()-1]+'s  CD: '+Math.ceil(skills.hiding.cooldown)+'s',active:skills.hiding.active,key2:'H'},
    {key:'healing',label:'🩹 HEALING',hint:'Bandage: '+HEAL_AMT[healingLv()-1]+' HP  [B to use]',active:player.bandageTimer>0},
    {key:'wrestling',label:'🤼 WRESTLING',hint:'Stun: '+WRESTLE_STUN[wrestlingLv()-1]+'s  Dmg: '+WRESTLE_DMG[wrestlingLv()-1]+'  CD: '+Math.ceil(skills.wrestling.cooldown)+'s',active:false,key2:'F'}
  ];
  for(let i=0;i<SKDEFS.length;i++){
    const sd=SKDEFS[i],sk=skills[sd.key],lv=skillLv(sk),ry=py+36+i*SKILL_PANEL_ROW,barX=px+12,barW=SKILL_PANEL_W-24;
    ctx.fillStyle=sd.active?'rgba(50,90,50,.4)':'rgba(20,28,40,.7)';ctx.fillRect(px+6,ry+2,SKILL_PANEL_W-12,SKILL_PANEL_ROW-4);ctx.strokeStyle=sd.active?'rgba(80,180,80,.5)':'rgba(60,90,120,.3)';ctx.lineWidth=1;ctx.strokeRect(px+6,ry+2,SKILL_PANEL_W-12,SKILL_PANEL_ROW-4);
    ctx.textAlign='left';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle=sd.active?'#80e880':'#a8c8e0';ctx.fillText(sd.label,barX,ry+18);ctx.fillStyle=lv>=10?'#ffd700':'#f0d060';ctx.textAlign='right';ctx.fillText('Lv '+lv+(lv>=10?' MAX':''),px+SKILL_PANEL_W-12,ry+18);
    if(sd.key2){ctx.fillStyle='rgba(160,200,255,.7)';ctx.fillText('['+sd.key2+']',px+SKILL_PANEL_W-68,ry+18);}
    const xpPrev=skillXpPrev(sk),xpMax=skillXpMax(sk),xpCur=sk.xp,frac=lv>=10?1:Math.max(0,Math.min(1,(xpCur-xpPrev)/(xpMax-xpPrev)));
    ctx.fillStyle='rgba(0,0,0,.5)';ctx.fillRect(barX,ry+24,barW,7);ctx.fillStyle=lv>=10?'#ffd700':'#3a8aff';ctx.fillRect(barX,ry+24,Math.round(barW*frac),7);ctx.strokeStyle='rgba(255,255,255,.15)';ctx.lineWidth=1;ctx.strokeRect(barX,ry+24,barW,7);
    ctx.fillStyle='rgba(200,220,255,.6)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='right';ctx.fillText(lv>=10?'MAX':xpCur+'/'+xpMax,px+SKILL_PANEL_W-12,ry+23);
    ctx.textAlign='left';ctx.fillStyle=SKILL_PERKS[sd.key][lv]?'#70e0ff':'rgba(180,200,220,.7)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    const hintText = SKILL_PERKS[sd.key][lv] ? SKILL_PERKS[sd.key][lv] : sd.hint;
    ctx.fillText(hintText,barX,ry+45);
  }
  ctx.textAlign='left';
}
const SMITH_ITEMS=[
  {id:'sword',label:'Sword',price:30,kind:'tool',pkey:'hasSword',wpn:'sword'},
  {id:'bow',label:'Bow',price:25,kind:'tool',pkey:'hasBow',wpn:'bow'},
  {id:'sword2',label:'Iron Sword ★ (+30% dmg)',price:60,kind:'tier',tkey:'swordTier',need:'hasSword',tier:2},
  {id:'bow2',label:'Iron-tip Bow ★ (+30%)',price:50,kind:'tier',tkey:'bowTier',need:'hasBow',tier:2},
  {id:'sword4',label:'Mithril Sword ★★★ (+100%)',price:200,kind:'tier',tkey:'swordTier',need:'hasSword',tier:4},
  {id:'bow4',label:'Mithril Bow ★★★ (+100%)',price:160,kind:'tier',tkey:'bowTier',need:'hasBow',tier:4},
  {id:'sword5',label:'Runic Sword ★★★★ (+150%)',price:400,kind:'tier',tkey:'swordTier',need:'hasSword',tier:5},
  {id:'bow5',label:'Runic Bow ★★★★ (+150%)',price:350,kind:'tier',tkey:'bowTier',need:'hasBow',tier:5},
  {id:'pickaxe',label:'Pickaxe',price:20,kind:'tool',pkey:'hasPickaxe',wpn:'pickaxe'},
  {id:'barmor',label:'Bronze Armor (+7%)',price:45,kind:'apiece',mat:3},
  {id:'sarmor',label:'Steel Armor (+10%)',price:90,kind:'apiece',mat:4},
  {id:'marmor',label:'Mithril Armor (+14%)',price:180,kind:'apiece',mat:5},
  {id:'rarmor',label:'Runic Armor (+18%)',price:320,kind:'apiece',mat:6},
  {id:'bandage',label:'Bandage',price:8,kind:'res',key:'bandages',amt:1}
];
const SMITH_W=fitPanelW(300),SMITH_ROW_H=42,SMITH_HEADER=48,SMITH_PAD=14,SMITH_H=SMITH_HEADER+SMITH_PAD+SMITH_ITEMS.length*SMITH_ROW_H+SMITH_PAD;
function smithPanelXY(){return panelAt('smith', Math.round(G.canvas.width/2-SMITH_W/2), Math.round(G.canvas.height/2-SMITH_H/2), SMITH_W, SMITH_H);}
function smithRects(){const{px,py}=smithPanelXY(),top=py+SMITH_HEADER+SMITH_PAD;return SMITH_ITEMS.map((it,i)=>({y:top+i*SMITH_ROW_H,x:px+SMITH_PAD,w:SMITH_W-SMITH_PAD*2,h:SMITH_ROW_H-4,btnX:px+SMITH_W-SMITH_PAD-80,btnW:78,btnH:SMITH_ROW_H-14,item:it}));}
function canSmithBuy(it){
  if(it.kind==='res') return inv.gold>=it.price;
  if(it.kind==='tier') return inv.gold>=it.price&&player[it.need]&&(player[it.tkey]||1)<it.tier;
  if(it.kind==='apiece') return inv.gold>=it.price&&hasUpgradeSlot(it.mat);
  return inv.gold>=it.price&&!player[it.pkey];
}
function smithOwned(it){
  if(it.kind==='tool') return !!player[it.pkey];
  if(it.kind==='tier') return (player[it.tkey]||1)>=it.tier;
  if(it.kind==='apiece') return !hasUpgradeSlot(it.mat);   // full set at this material
  return false;
}
function doSmithBuy(it){if(!canSmithBuy(it))return;snd.gold();inv.gold-=it.price;if(it.kind==='res'){inv[it.key]+=it.amt;addFloater(player.x,player.y-20,'+'+it.amt+' '+it.label);}if(it.kind==='tool'){player[it.pkey]=true;if(it.wpn)player.weapon=it.wpn;addFloater(player.x,player.y-20,it.label+'!');}if(it.kind==='tier'){player[it.tkey]=it.tier;addFloater(player.x,player.y-20,it.label+' — equipped!');}if(it.kind==='apiece')equipArmorPiece(it.mat);}
function handleSmithClick(e){for(const r of smithRects()){if(e.clientX>=r.btnX&&e.clientX<=r.btnX+r.btnW&&e.clientY>=r.y+(r.h-r.btnH)/2&&e.clientY<=r.y+(r.h+r.btnH)/2){doSmithBuy(r.item);return true;}}return false;}
function renderSmithPanel(){
  const ctx=G.ctx,{px,py}=smithPanelXY();
  ctx.fillStyle='rgba(12,8,4,.97)';ctx.fillRect(px,py,SMITH_W,SMITH_H);ctx.strokeStyle='#c87030';ctx.lineWidth=2;ctx.strokeRect(px,py,SMITH_W,SMITH_H);
  ctx.fillStyle='#c87030';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('⚒ BLACKSMITH  ·  E to close',px+SMITH_W/2,py+20);
  ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g',px+SMITH_W/2,py+37);
  ctx.strokeStyle='rgba(200,112,48,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+SMITH_HEADER);ctx.lineTo(px+SMITH_W-8,py+SMITH_HEADER);ctx.stroke();
  for(const r of smithRects()){const it=r.item,owned=smithOwned(it),can=canSmithBuy(it);ctx.fillStyle=owned?'rgba(50,40,20,.7)':'rgba(35,20,8,.85)';ctx.fillRect(r.x,r.y,r.w,r.h);ctx.strokeStyle=owned?'rgba(200,150,60,.6)':'rgba(80,50,20,.5)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.textAlign='left';ctx.fillStyle=owned?'#c0a040':'#e0c090';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';const tag=owned?' ★':it.kind==='res'?' (have '+(inv[it.key]||0)+')':'';ctx.fillText(it.label+tag,r.x+8,r.y+r.h/2+4);if(!owned){const by=r.y+(r.h-r.btnH)/2;ctx.fillStyle=can?'rgba(150,80,20,.9)':'rgba(40,25,10,.7)';ctx.fillRect(r.btnX,by,r.btnW,r.btnH);ctx.strokeStyle=can?'#e08040':'rgba(80,50,20,.4)';ctx.lineWidth=1;ctx.strokeRect(r.btnX,by,r.btnW,r.btnH);ctx.fillStyle=can?'#f0c060':'#554';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(it.price+'g buy',r.btnX+r.btnW/2,by+r.btnH/2+4);}}
  ctx.textAlign='left';
}
const MAGE_ITEMS=[{id:'potion',label:'Heal Potion',sub:'Restores 50 HP  [P to use]',price:15,maxStack:10}];
const MAGE_W=fitPanelW(300),MAGE_ROW_H=52,MAGE_HEADER=48,MAGE_PAD=14,MAGE_H=MAGE_HEADER+MAGE_PAD+MAGE_ITEMS.length*MAGE_ROW_H+MAGE_PAD;
function magePanelXY(){return panelAt('mage', Math.round(G.canvas.width/2-MAGE_W/2), Math.round(G.canvas.height/2-MAGE_H/2), MAGE_W, MAGE_H);}
function mageRects(){const{px,py}=magePanelXY(),top=py+MAGE_HEADER+MAGE_PAD;return MAGE_ITEMS.map((it,i)=>({y:top+i*MAGE_ROW_H,x:px+MAGE_PAD,w:MAGE_W-MAGE_PAD*2,h:MAGE_ROW_H-4,btnX:px+MAGE_W-MAGE_PAD-80,btnW:78,btnH:MAGE_ROW_H-18,item:it}));}
function handleMageClick(e){for(const r of mageRects()){const it=r.item;if(e.clientX>=r.btnX&&e.clientX<=r.btnX+r.btnW&&e.clientY>=r.y+(r.h-r.btnH)/2&&e.clientY<=r.y+(r.h+r.btnH)/2){if(it.id==='potion'){if(inv.gold<it.price){addFloater(player.x,player.y-20,'need '+it.price+'g!');return true;}if(inv.potions>=it.maxStack){addFloater(player.x,player.y-20,'already full!');return true;}inv.gold-=it.price;inv.potions++;snd.gold();addFloater(player.x,player.y-20,'potion bought!');}return true;}}return false;}
function renderMagePanel(){
  const ctx=G.ctx,{px,py}=magePanelXY();
  ctx.fillStyle='rgba(6,4,18,.97)';ctx.fillRect(px,py,MAGE_W,MAGE_H);ctx.strokeStyle='#9966cc';ctx.lineWidth=2;ctx.strokeRect(px,py,MAGE_W,MAGE_H);
  ctx.fillStyle='#c090ff';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('✦ MAGE SHOP  ·  E to close',px+MAGE_W/2,py+20);
  ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g    Potions: '+inv.potions+'/'+MAGE_ITEMS[0].maxStack,px+MAGE_W/2,py+37);
  ctx.strokeStyle='rgba(150,100,200,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+MAGE_HEADER);ctx.lineTo(px+MAGE_W-8,py+MAGE_HEADER);ctx.stroke();
  for(const r of mageRects()){const it=r.item,full=inv.potions>=it.maxStack,can=inv.gold>=it.price&&!full;ctx.fillStyle='rgba(20,10,40,.85)';ctx.fillRect(r.x,r.y,r.w,r.h);ctx.strokeStyle='rgba(130,80,200,.4)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.textAlign='left';ctx.fillStyle='#d0b0ff';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(it.label,r.x+8,r.y+16);ctx.fillStyle='rgba(180,160,220,.6)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(it.sub,r.x+8,r.y+32);const by=r.y+(r.h-r.btnH)/2;ctx.fillStyle=can?'rgba(80,30,150,.9)':'rgba(30,15,50,.7)';ctx.fillRect(r.btnX,by,r.btnW,r.btnH);ctx.strokeStyle=can?'#aa66ff':'rgba(80,50,120,.4)';ctx.lineWidth=1;ctx.strokeRect(r.btnX,by,r.btnW,r.btnH);ctx.fillStyle=can?'#e0b0ff':'#554';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(full?'FULL':it.price+'g buy',r.btnX+r.btnW/2,by+r.btnH/2+4);}
  ctx.textAlign='left';
}
const FARRIER_W=fitPanelW(300),FARRIER_HEADER=48,FARRIER_PAD=14,FARRIER_BODY_H=110,FARRIER_H=FARRIER_HEADER+FARRIER_PAD+FARRIER_BODY_H+FARRIER_PAD;
function farrierPanelXY(){return panelAt('farrier', Math.round(G.canvas.width/2-FARRIER_W/2), Math.round(G.canvas.height/2-FARRIER_H/2), FARRIER_W, FARRIER_H);}
function handleFarrierClick(e){const{px,py}=farrierPanelXY();const bx=px+FARRIER_PAD,bw=FARRIER_W-FARRIER_PAD*2,bh=36,by=py+FARRIER_HEADER+FARRIER_PAD+58;if(e.clientX>=bx&&e.clientX<=bx+bw&&e.clientY>=by&&e.clientY<=by+bh){if(player.hasHorse){addFloater(player.x,player.y-20,'already have a horse!');return true;}if(inv.gold<200){addFloater(player.x,player.y-20,'need 200g!');return true;}inv.gold-=200;player.hasHorse=true;player.onHorse=true;snd.gold();addFloater(player.x,player.y-20,'horse acquired! [R] to mount/dismount');G.farrierOpen=false;return true;}return false;}
function renderFarrierPanel(){
  const ctx=G.ctx,{px,py}=farrierPanelXY();
  ctx.fillStyle='rgba(8,6,2,.97)';ctx.fillRect(px,py,FARRIER_W,FARRIER_H);ctx.strokeStyle='#a07030';ctx.lineWidth=2;ctx.strokeRect(px,py,FARRIER_W,FARRIER_H);
  ctx.fillStyle='#d0a050';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('🐴 FARRIER  ·  E to close',px+FARRIER_W/2,py+20);ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g',px+FARRIER_W/2,py+37);
  ctx.strokeStyle='rgba(160,112,48,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+FARRIER_HEADER);ctx.lineTo(px+FARRIER_W-8,py+FARRIER_HEADER);ctx.stroke();
  const ry=py+FARRIER_HEADER+FARRIER_PAD;ctx.fillStyle='rgba(30,20,5,.7)';ctx.fillRect(px+FARRIER_PAD,ry,FARRIER_W-FARRIER_PAD*2,FARRIER_BODY_H);ctx.strokeStyle='rgba(160,112,48,.4)';ctx.lineWidth=1;ctx.strokeRect(px+FARRIER_PAD,ry,FARRIER_W-FARRIER_PAD*2,FARRIER_BODY_H);
  ctx.textAlign='center';ctx.fillStyle='#e8c878';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(player.hasHorse?'★ Horse (OWNED)':'Horse  — 200g',px+FARRIER_W/2,ry+20);ctx.fillStyle='rgba(200,170,100,.7)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('2.2× movement speed',px+FARRIER_W/2,ry+38);ctx.fillText('[R] to mount / dismount',px+FARRIER_W/2,ry+52);
  if(player.hasHorse){ctx.fillStyle='rgba(100,180,80,.8)';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(player.onHorse?'🐴 Currently mounted':'🐴 Horse ready (press R)',px+FARRIER_W/2,ry+72);}
  else{const bx=px+FARRIER_PAD,bw=FARRIER_W-FARRIER_PAD*2,bh=36,by=ry+58,can=inv.gold>=200;ctx.fillStyle=can?'rgba(100,70,10,.9)':'rgba(30,20,5,.7)';ctx.fillRect(bx,by,bw,bh);ctx.strokeStyle=can?'#d09020':'rgba(80,60,20,.4)';ctx.lineWidth=1;ctx.strokeRect(bx,by,bw,bh);ctx.fillStyle=can?'#f0d060':'#554';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Buy Horse — 200g',px+FARRIER_W/2,by+bh/2+5);}
  ctx.textAlign='left';
}

// ── Antiquarian — shop (T2/T3 for relics, 420s refresh) + artifact inventory ──
const ANTIQ_W=fitPanelW(340),ANTIQ_ROW_H=40,ANTIQ_HEADER=54,ANTIQ_PAD=14,ANTIQ_STOCK_N=4,ANTIQ_REFRESH=420;
function antiqStockPrice(tier){return tier===3?5:2;}
function ensureAntiqStock(){
  if(G.antiqStock&&G.gameTime-G.antiqStockAt<ANTIQ_REFRESH)return;
  const pool=[...artifactsOfTier(2),...artifactsOfTier(3)];
  G.antiqStock=Array.from({length:ANTIQ_STOCK_N},()=>pool[Math.floor(Math.random()*pool.length)].id);
  G.antiqStockAt=G.gameTime;
}
function antiqInvRows(){
  const rows=[];
  for(const sk of ARTIFACT_SLOTS)if(player.equippedArtifacts[sk])rows.push({kind:'equipped',slotKey:sk,defId:player.equippedArtifacts[sk]});
  player.artifactInv.forEach((item,idx)=>rows.push({kind:'inv',idx,item}));
  return rows;
}
function antiqPanelXY(){
  ensureAntiqStock();
  const invRows=Math.max(1,antiqInvRows().length);
  const H=ANTIQ_HEADER+ANTIQ_PAD+ANTIQ_STOCK_N*ANTIQ_ROW_H+28+invRows*ANTIQ_ROW_H+ANTIQ_PAD;
  return {...panelAt('antiq', Math.round(G.canvas.width/2-ANTIQ_W/2), Math.max(8,Math.round(G.canvas.height/2-H/2)), ANTIQ_W, H), H};
}
function antiqStockRects(){
  const{px,py}=antiqPanelXY(),top=py+ANTIQ_HEADER+ANTIQ_PAD;
  return G.antiqStock.map((defId,i)=>({y:top+i*ANTIQ_ROW_H,x:px+ANTIQ_PAD,w:ANTIQ_W-ANTIQ_PAD*2,h:ANTIQ_ROW_H-4,btnX:px+ANTIQ_W-ANTIQ_PAD-70,btnW:64,btnH:ANTIQ_ROW_H-14,defId}));
}
function antiqInvRects(){
  const{px,py}=antiqPanelXY(),top=py+ANTIQ_HEADER+ANTIQ_PAD+ANTIQ_STOCK_N*ANTIQ_ROW_H+28;
  return antiqInvRows().map((r,i)=>({y:top+i*ANTIQ_ROW_H,x:px+ANTIQ_PAD,w:ANTIQ_W-ANTIQ_PAD*2,h:ANTIQ_ROW_H-4,row:r}));
}
function handleAntiqClick(e){
  for(const r of antiqStockRects()){
    if(e.clientX>=r.btnX&&e.clientX<=r.btnX+r.btnW&&e.clientY>=r.y+(r.h-r.btnH)/2&&e.clientY<=r.y+(r.h+r.btnH)/2){
      const def=artifactDef(r.defId),price=antiqStockPrice(def.tier);
      if(inv.relics<price){addFloater(player.x,player.y-20,'need '+price+' relics!');return true;}
      inv.relics-=price;player.artifactInv.push({defId:def.id,identified:true});
      questEvent('relic',null);
      snd.gold();addFloater(player.x,player.y-20,def.name+' purchased!');
      return true;
    }
  }
  for(const r of antiqInvRects()){
    if(e.clientX>=r.x&&e.clientX<=r.x+r.w&&e.clientY>=r.y&&e.clientY<=r.y+r.h){
      if(r.row.kind==='equipped')unequipArtifact(r.row.slotKey);
      else if(r.row.item.identified)equipArtifact(r.row.idx);
      else addFloater(player.x,player.y-20,'unidentified — visit the Cryptologist');
      return true;
    }
  }
  return false;
}
function renderAntiqPanel(){
  const ctx=G.ctx,{px,py,H}=antiqPanelXY();
  ctx.fillStyle='rgba(16,10,22,.97)';ctx.fillRect(px,py,ANTIQ_W,H);ctx.strokeStyle='#9a6ad0';ctx.lineWidth=2;ctx.strokeRect(px,py,ANTIQ_W,H);
  ctx.fillStyle='#c090f0';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('📿 ANTIQUARIAN  ·  E to close',px+ANTIQ_W/2,py+20);
  ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g   Relics: '+(inv.relics||0)+'💎',px+ANTIQ_W/2,py+37);
  const refreshLeft=Math.max(0,Math.ceil(ANTIQ_REFRESH-(G.gameTime-G.antiqStockAt)));
  ctx.fillStyle='rgba(200,170,240,.6)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('stock refreshes in '+refreshLeft+'s',px+ANTIQ_W/2,py+ANTIQ_HEADER-2);
  ctx.strokeStyle='rgba(154,106,208,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+ANTIQ_HEADER);ctx.lineTo(px+ANTIQ_W-8,py+ANTIQ_HEADER);ctx.stroke();
  for(const r of antiqStockRects()){
    const def=artifactDef(r.defId),price=antiqStockPrice(def.tier),can=inv.relics>=price;
    ctx.fillStyle='rgba(40,25,55,.85)';ctx.fillRect(r.x,r.y,r.w,r.h);ctx.strokeStyle='rgba(120,70,170,.5)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
    ctx.textAlign='left';ctx.fillStyle='#e0c8ff';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(def.icon+' '+def.name+'  (T'+def.tier+')',r.x+8,r.y+15);
    ctx.fillStyle='rgba(200,180,220,.65)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(def.desc,r.x+8,r.y+29);
    const by=r.y+(r.h-r.btnH)/2;ctx.fillStyle=can?'rgba(110,60,170,.9)':'rgba(40,25,55,.7)';ctx.fillRect(r.btnX,by,r.btnW,r.btnH);ctx.strokeStyle=can?'#c090f0':'rgba(90,60,120,.4)';ctx.lineWidth=1;ctx.strokeRect(r.btnX,by,r.btnW,r.btnH);
    ctx.fillStyle=can?'#f0d0ff':'#554';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(price+'💎 buy',r.btnX+r.btnW/2,by+r.btnH/2+4);
  }
  const secY=py+ANTIQ_HEADER+ANTIQ_PAD+ANTIQ_STOCK_N*ANTIQ_ROW_H+14;
  ctx.textAlign='left';ctx.fillStyle='#c090f0';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('YOUR ARTIFACTS  (click to equip/unequip)',px+ANTIQ_PAD,secY);
  const rows=antiqInvRows();
  if(!rows.length){ctx.fillStyle='rgba(200,180,220,.5)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('none held',px+ANTIQ_PAD,secY+ANTIQ_ROW_H/2+10);}
  else for(const r of antiqInvRects()){
    const row=r.row,equipped=row.kind==='equipped';
    const def=artifactDef(equipped?row.defId:row.item.defId),identified=equipped||row.item.identified;
    ctx.fillStyle=equipped?'rgba(80,50,120,.85)':'rgba(30,18,42,.8)';ctx.fillRect(r.x,r.y,r.w,r.h);ctx.strokeStyle=equipped?'#c090f0':'rgba(120,70,170,.4)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
    ctx.fillStyle=identified?'#e0c8ff':'rgba(200,180,220,.6)';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';
    const label=identified?def.icon+' '+def.name+' (T'+def.tier+')':'❔ Unidentified T? Artifact';
    ctx.fillText(label,r.x+8,r.y+15);
    ctx.fillStyle='rgba(200,180,220,.65)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(equipped?'EQUIPPED ('+ARTIFACT_SLOT_LABEL[row.slotKey]+') — click to unequip':identified?def.desc+'  — click to equip':'visit the Cryptologist to identify',r.x+8,r.y+29);
  }
  ctx.textAlign='left';
}

// ── Cryptologist — identify unidentified artifacts for 25g ───────
const CRYPTO_ROW_H=44,CRYPTO_W=fitPanelW(320),CRYPTO_HEADER=48,CRYPTO_PAD=14,CRYPTO_COST=25;
function cryptoUnidRows(){return player.artifactInv.map((item,idx)=>({idx,item})).filter(r=>!r.item.identified);}
function cryptoPanelXY(){
  const n=Math.max(1,cryptoUnidRows().length);
  const H=CRYPTO_HEADER+CRYPTO_PAD+n*CRYPTO_ROW_H+CRYPTO_PAD;
  return {...panelAt('crypto', Math.round(G.canvas.width/2-CRYPTO_W/2), Math.max(8,Math.round(G.canvas.height/2-H/2)), CRYPTO_W, H), H};
}
function cryptoRects(){
  const{px,py}=cryptoPanelXY(),top=py+CRYPTO_HEADER+CRYPTO_PAD;
  return cryptoUnidRows().map((r,i)=>({y:top+i*CRYPTO_ROW_H,x:px+CRYPTO_PAD,w:CRYPTO_W-CRYPTO_PAD*2,h:CRYPTO_ROW_H-6,btnX:px+CRYPTO_W-CRYPTO_PAD-84,btnW:78,btnH:CRYPTO_ROW_H-16,row:r}));
}
function handleCryptoClick(e){
  for(const r of cryptoRects()){
    if(e.clientX>=r.btnX&&e.clientX<=r.btnX+r.btnW&&e.clientY>=r.y+(r.h-r.btnH)/2&&e.clientY<=r.y+(r.h+r.btnH)/2){
      if(inv.gold<CRYPTO_COST){addFloater(player.x,player.y-20,'need '+CRYPTO_COST+'g!');return true;}
      inv.gold-=CRYPTO_COST;r.row.item.identified=true;snd.gold();
      addFloater(player.x,player.y-20,'✨ '+artifactDef(r.row.item.defId).name+' identified!');
      return true;
    }
  }
  return false;
}
function renderCryptoPanel(){
  const ctx=G.ctx,{px,py,H}=cryptoPanelXY();
  ctx.fillStyle='rgba(6,14,18,.97)';ctx.fillRect(px,py,CRYPTO_W,H);ctx.strokeStyle='#40b0c0';ctx.lineWidth=2;ctx.strokeRect(px,py,CRYPTO_W,H);
  ctx.fillStyle='#80d8e8';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('🔍 CRYPTOLOGIST  ·  E to close',px+CRYPTO_W/2,py+20);
  ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g',px+CRYPTO_W/2,py+37);
  ctx.strokeStyle='rgba(64,176,192,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+CRYPTO_HEADER);ctx.lineTo(px+CRYPTO_W-8,py+CRYPTO_HEADER);ctx.stroke();
  const rows=cryptoRects();
  if(!rows.length){ctx.fillStyle='rgba(180,220,230,.6)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('no unidentified artifacts',px+CRYPTO_W/2,py+CRYPTO_HEADER+CRYPTO_PAD+20);ctx.textAlign='left';return;}
  for(const r of rows){
    ctx.fillStyle='rgba(15,35,40,.85)';ctx.fillRect(r.x,r.y,r.w,r.h);ctx.strokeStyle='rgba(64,176,192,.4)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
    ctx.textAlign='left';ctx.fillStyle='#b0e8f0';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('❔ Unidentified T? Artifact',r.x+8,r.y+18);
    const can=inv.gold>=CRYPTO_COST,by=r.y+(r.h-r.btnH)/2;
    ctx.fillStyle=can?'rgba(30,120,140,.9)':'rgba(20,45,50,.7)';ctx.fillRect(r.btnX,by,r.btnW,r.btnH);ctx.strokeStyle=can?'#50c0d0':'rgba(60,90,95,.4)';ctx.lineWidth=1;ctx.strokeRect(r.btnX,by,r.btnW,r.btnH);
    ctx.fillStyle=can?'#c0f0f8':'#554';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(CRYPTO_COST+'g ID',r.btnX+r.btnW/2,by+r.btnH/2+4);
  }
  ctx.textAlign='left';
}

// ── Museum Curator — rotating artifact bounty board ───────────────
const CURATOR_W=fitPanelW(320),CURATOR_HEADER=48,CURATOR_PAD=14,CURATOR_BODY_H=100,CURATOR_H=CURATOR_HEADER+CURATOR_PAD+CURATOR_BODY_H+CURATOR_PAD,CURATOR_REFRESH=600;
function ensureBounty(){
  if(G.bounty&&G.gameTime-G.bountyAt<CURATOR_REFRESH)return;
  G.bounty={defId:ARTIFACT_DEFS[Math.floor(Math.random()*ARTIFACT_DEFS.length)].id};
  G.bountyAt=G.gameTime;
}
function curatorPanelXY(){ensureBounty();return panelAt('curator', Math.round(G.canvas.width/2-CURATOR_W/2), Math.round(G.canvas.height/2-CURATOR_H/2), CURATOR_W, CURATOR_H);}
function fulfillBounty(){
  ensureBounty();
  const def=artifactDef(G.bounty.defId);
  const idx=player.artifactInv.findIndex(it=>it.identified&&it.defId===def.id);
  if(idx<0){addFloater(player.x,player.y-20,"you don't have that artifact!");return;}
  player.artifactInv.splice(idx,1);
  const reward=def.value*3+200;
  inv.gold+=reward;snd.gold();
  questEvent('bounty',null);
  addFloater(player.x,player.y-30,'🏛 bounty fulfilled! +'+reward+'g');
  G.bounty=null;G.bountyAt=G.gameTime;ensureBounty();
}
function handleCuratorClick(e){
  const{px,py}=curatorPanelXY();
  const bx=px+CURATOR_PAD,bw=CURATOR_W-CURATOR_PAD*2,bh=36,by=py+CURATOR_HEADER+CURATOR_PAD+56;
  if(e.clientX>=bx&&e.clientX<=bx+bw&&e.clientY>=by&&e.clientY<=by+bh){fulfillBounty();return true;}
  return false;
}
function renderCuratorPanel(){
  ensureBounty();
  const ctx=G.ctx,{px,py}=curatorPanelXY(),def=artifactDef(G.bounty.defId);
  ctx.fillStyle='rgba(18,14,4,.97)';ctx.fillRect(px,py,CURATOR_W,CURATOR_H);ctx.strokeStyle='#c0a030';ctx.lineWidth=2;ctx.strokeRect(px,py,CURATOR_W,CURATOR_H);
  ctx.fillStyle='#e0c060';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('🏛 MUSEUM CURATOR  ·  E to close',px+CURATOR_W/2,py+20);
  ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g',px+CURATOR_W/2,py+37);
  ctx.strokeStyle='rgba(192,160,48,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+CURATOR_HEADER);ctx.lineTo(px+CURATOR_W-8,py+CURATOR_HEADER);ctx.stroke();
  const ry=py+CURATOR_HEADER+CURATOR_PAD;
  ctx.fillStyle='rgba(35,28,8,.7)';ctx.fillRect(px+CURATOR_PAD,ry,CURATOR_W-CURATOR_PAD*2,CURATOR_BODY_H);ctx.strokeStyle='rgba(192,160,48,.4)';ctx.lineWidth=1;ctx.strokeRect(px+CURATOR_PAD,ry,CURATOR_W-CURATOR_PAD*2,CURATOR_BODY_H);
  ctx.fillStyle='#f0d878';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('WANTED: '+def.icon+' '+def.name+' (T'+def.tier+')',px+CURATOR_W/2,ry+20);
  ctx.fillStyle='rgba(220,200,140,.7)';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('reward: '+(def.value*3+200)+'g',px+CURATOR_W/2,ry+38);
  const have=player.artifactInv.some(it=>it.identified&&it.defId===def.id);
  const bx=px+CURATOR_PAD,bw=CURATOR_W-CURATOR_PAD*2,bh=36,by=ry+56,can=have;
  ctx.fillStyle=can?'rgba(120,90,10,.9)':'rgba(30,20,5,.7)';ctx.fillRect(bx,by,bw,bh);ctx.strokeStyle=can?'#e0b030':'rgba(80,60,20,.4)';ctx.lineWidth=1;ctx.strokeRect(bx,by,bw,bh);
  ctx.fillStyle=can?'#f8e090':'#554';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(can?'Turn in artifact':'you lack this artifact',px+CURATOR_W/2,by+bh/2+4);
  ctx.textAlign='left';
}

// ── Grave Robber — 75g gamble box (90% trash · 9% T1 · 1% T3) ────
const ROBBER_W=fitPanelW(300),ROBBER_HEADER=48,ROBBER_PAD=14,ROBBER_BODY_H=90,ROBBER_H=ROBBER_HEADER+ROBBER_PAD+ROBBER_BODY_H+ROBBER_PAD,ROBBER_COST=75;
function robberPanelXY(){return panelAt('robber', Math.round(G.canvas.width/2-ROBBER_W/2), Math.round(G.canvas.height/2-ROBBER_H/2), ROBBER_W, ROBBER_H);}
function gambleBox(){
  if(inv.gold<ROBBER_COST){addFloater(player.x,player.y-20,'need '+ROBBER_COST+'g!');return;}
  inv.gold-=ROBBER_COST;
  const r=Math.random();
  if(r<0.90){snd.gold();addFloater(player.x,player.y-30,'📦 ...just dust and cobwebs. Trash.');}
  else if(r<0.99)grantRandomArtifact(1,0,0);
  else grantRandomArtifact(0,0,1);
}
function handleRobberClick(e){
  const{px,py}=robberPanelXY();
  const bx=px+ROBBER_PAD,bw=ROBBER_W-ROBBER_PAD*2,bh=36,by=py+ROBBER_HEADER+ROBBER_PAD+50;
  if(e.clientX>=bx&&e.clientX<=bx+bw&&e.clientY>=by&&e.clientY<=by+bh){gambleBox();return true;}
  return false;
}
function renderRobberPanel(){
  const ctx=G.ctx,{px,py}=robberPanelXY();
  ctx.fillStyle='rgba(10,10,10,.97)';ctx.fillRect(px,py,ROBBER_W,ROBBER_H);ctx.strokeStyle='#707070';ctx.lineWidth=2;ctx.strokeRect(px,py,ROBBER_W,ROBBER_H);
  ctx.fillStyle='#b0b0b0';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('⚰ GRAVE ROBBER  ·  E to close',px+ROBBER_W/2,py+20);
  ctx.fillStyle='#f0d060';ctx.font='13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gold: '+inv.gold+'g',px+ROBBER_W/2,py+37);
  ctx.strokeStyle='rgba(112,112,112,.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+8,py+ROBBER_HEADER);ctx.lineTo(px+ROBBER_W-8,py+ROBBER_HEADER);ctx.stroke();
  const ry=py+ROBBER_HEADER+ROBBER_PAD;
  ctx.fillStyle='rgba(25,25,25,.7)';ctx.fillRect(px+ROBBER_PAD,ry,ROBBER_W-ROBBER_PAD*2,ROBBER_BODY_H);ctx.strokeStyle='rgba(112,112,112,.4)';ctx.lineWidth=1;ctx.strokeRect(px+ROBBER_PAD,ry,ROBBER_W-ROBBER_PAD*2,ROBBER_BODY_H);
  ctx.fillStyle='#d0d0d0';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Gamble Box — '+ROBBER_COST+'g',px+ROBBER_W/2,ry+18);
  ctx.fillStyle='rgba(180,180,180,.65)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('90% trash · 9% T1 artifact · 1% T3 artifact',px+ROBBER_W/2,ry+34);
  const bx=px+ROBBER_PAD,bw=ROBBER_W-ROBBER_PAD*2,bh=36,by=ry+50,can=inv.gold>=ROBBER_COST;
  ctx.fillStyle=can?'rgba(70,70,70,.9)':'rgba(25,25,25,.7)';ctx.fillRect(bx,by,bw,bh);ctx.strokeStyle=can?'#a0a0a0':'rgba(70,70,70,.4)';ctx.lineWidth=1;ctx.strokeRect(bx,by,bw,bh);
  ctx.fillStyle=can?'#e8e8e8':'#554';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.fillText('Open Box — '+ROBBER_COST+'g',px+ROBBER_W/2,by+bh/2+5);
  ctx.textAlign='left';
}

// ── Housing System ────────────────────────────────────────────────
const HOUSES = [
  {
    id: 'house_9x9',
    label: '9x9 Cozy Cabin',
    size: 9,
    cost: { gold: 100, planks: 30, stone: 20 },
    sub: () => `Needs: 100g, 30 planks, 20 stone`
  }
];

const HOUSE_W = fitPanelW(320), HOUSE_ROW_H = 64, HOUSE_HEADER = 48, HOUSE_PAD = 14;
const HOUSE_H = HOUSE_HEADER + HOUSE_PAD + HOUSES.length * HOUSE_ROW_H + HOUSE_PAD;

function housePanelXY() {
  return panelAt('house_menu', Math.round(G.canvas.width/2 - HOUSE_W/2), Math.round(G.canvas.height/2 - HOUSE_H/2), HOUSE_W, HOUSE_H);
}

function houseRects() {
  const {px, py} = housePanelXY();
  const top = py + HOUSE_HEADER + HOUSE_PAD;
  return HOUSES.map((h, i) => {
    return {
      y: top + i * HOUSE_ROW_H,
      x: px + HOUSE_PAD,
      w: HOUSE_W - HOUSE_PAD * 2,
      h: HOUSE_ROW_H - 6,
      btnX: px + HOUSE_W - HOUSE_PAD - 78,
      btnW: 70,
      btnH: HOUSE_ROW_H - 16,
      item: h
    };
  });
}

function canAffordHouse(cost) {
  return inv.gold >= cost.gold && (inv.planks || 0) >= cost.planks && (inv.stone || 0) >= cost.stone;
}

function canPlaceHouseAt(tx, ty, size) {
  // footprint bounds in world units (+ a small margin) — used to reject
  // placing on top of any player, so nobody gets walled in
  const wx0 = tx * TILE, wy0 = ty * TILE, wx1 = (tx + size) * TILE, wy1 = (ty + size) * TILE;
  const insideFootprint = (px, py) => px >= wx0 - TILE && px < wx1 + TILE && py >= wy0 - TILE && py < wy1 + TILE;
  for (const [, st] of net.remotes) if (!st.dead && insideFootprint(st.x, st.y)) return false;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
      if (map[y][x] !== T.GRASS) return false;

      const cx = x * TILE + TILE/2;
      const cy = y * TILE + TILE/2;
      if (placedObjects.some(o => Math.abs(o.x - cx) < TILE/2 && Math.abs(o.y - cy) < TILE/2)) return false;
    }
  }
  return true;
}

// lay a house's wall/floor tiles into the map (used by local placement AND
// houses arriving from the server)
function applyHouseTiles(x0, y0, size) {
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
    const x = x0 + dx, y = y0 + dy;
    const isBorder = (dy === 0 || dy === size - 1 || dx === 0 || dx === size - 1);
    const isDoor = (dy === size - 1 && dx === Math.floor(size / 2));
    if (isBorder && !isDoor) {
      map[y][x] = T.WALL; origTile[y][x] = T.WALL; playerPlacedWalls[y][x] = true;
    } else {
      map[y][x] = T.PATH; origTile[y][x] = T.PATH; playerPlacedWalls[y][x] = false;
    }
    respawnAt[y][x] = null;
    bakeStaticTile(x, y); minimapUpdateTile(x, y);
  }
}
// erase a house (a remote owner demolished it) back to grass
function clearHouseTiles(h) {
  for (let dy = 0; dy < h.size; dy++) for (let dx = 0; dx < h.size; dx++) {
    const x = h.x0 + dx, y = h.y0 + dy;
    map[y][x] = T.GRASS; origTile[y][x] = T.GRASS; playerPlacedWalls[y][x] = false;
    respawnAt[y][x] = null;
    bakeStaticTile(x, y); minimapUpdateTile(x, y);
  }
}
// Reconcile the shared house list from the server with the local world.
// First sync after connecting also uploads any local-only houses (built
// offline / pre-multiplayer) so nobody loses their home.
let _housesMigrated = false;
function applyServerHouses(list) {
  const key = h => h.x0 + ',' + h.y0 + ',' + h.size;
  const srvKeys = new Set(list.map(key));
  const local = G.placedHouses || [];
  if (!_housesMigrated) {
    _housesMigrated = true;
    for (const h of local) if (!srvKeys.has(key(h))) netHousePlace(h);
  }
  const localMap = new Map(local.map(h => [key(h), h]));
  // remove local houses the server doesn't know — the server list is the
  // truth (freshly migrated ones blink out and return on the round-trip)
  for (const h of local) if (!srvKeys.has(key(h))) clearHouseTiles(h);
  // lay tiles for new-to-us houses
  for (const h of list) if (!localMap.has(key(h))) applyHouseTiles(h.x0, h.y0, h.size);
  G.placedHouses = list.map(h => ({ x0: h.x0, y0: h.y0, size: h.size, isPublic: !!h.isPublic,
    friends: h.friends || [], doorOpen: !!h.doorOpen, owner: h.owner || '' }));
  rebuildHouseProps();
}

function placeHouse(wx, wy) {
  const tx = Math.floor(wx/TILE);
  const ty = Math.floor(wy/TILE);
  const size = G.placingHouse.size;
  const offset = Math.floor(size / 2);
  const x0 = tx - offset;
  const y0 = ty - offset;
  
  if (!canPlaceHouseAt(x0, y0, size)) {
    addFloater(wx, wy - 12, "cannot place here!");
    snd.hurt();
    return false;
  }
  
  const cost = G.placingHouse.cost;
  inv.gold -= cost.gold;
  inv.planks -= cost.planks;
  inv.stone -= cost.stone;

  applyHouseTiles(x0, y0, size);
  const newHouse = {x0, y0, size, isPublic: false, friends: [], doorOpen: false, owner: playerName()};
  G.placedHouses.push(newHouse);
  if(G.placedHouses.length===1) grantAchiev('house');  // "Homesteader" — first house placed
  netHousePlace(newHouse);   // share it with the world (server assigns ownership)
  rebuildHouseProps();
  
  player.x = (x0 + Math.floor(size / 2)) * TILE + TILE/2;
  player.y = (y0 + size) * TILE + TILE/2;
  
  G.housePlacementMode = false;
  buildHighlight.visible = false;
  buildHighlight.scale.setScalar(1);
  
  if (typeof saveGame === 'function') saveGame();
  
  snd.heal();
  addFloater(player.x, player.y - 20, "House built!");
  
  return true;
}

function handleHouseMenuClick(e) {
  for (const r of houseRects()) {
    if (e.clientX >= r.btnX && e.clientX <= r.btnX + r.btnW && e.clientY >= r.y + (r.h - r.btnH)/2 && e.clientY <= r.y + (r.h + r.btnH)/2) {
      const h = r.item;
      if (!canAffordHouse(h.cost)) {
        addFloater(player.x, player.y - 20, 'cannot afford house!');
        return true;
      }
      
      G.prePlacementPos = { x: player.x, y: player.y };
      G.houseMenuOpen = false;
      G.housePlacementMode = true;
      G.placingHouse = h;
      
      addFloater(player.x, player.y - 20, 'Entering Placement Mode');
      return true;
    }
  }
  return false;
}

function renderHousePanel() {
  const ctx = G.ctx;
  const {px, py} = housePanelXY();
  ctx.fillStyle = 'rgba(8,18,12,.97)';
  ctx.fillRect(px, py, HOUSE_W, HOUSE_H);
  ctx.strokeStyle = '#60c880';
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, HOUSE_W, HOUSE_H);
  
  ctx.fillStyle = '#60c880';
  ctx.font = 'bold 14px ui-monospace,Menlo,Consolas,monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🏠 HOUSING TOOL  ·  E to close', px + HOUSE_W/2, py + 20);
  
  ctx.fillStyle = '#f0d060';
  ctx.font = '12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(`Planks: ${inv.planks || 0}  Stone: ${inv.stone || 0}  Gold: ${inv.gold || 0}g`, px + HOUSE_W/2, py + 37);
  
  ctx.strokeStyle = 'rgba(96,200,128,.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 8, py + HOUSE_HEADER);
  ctx.lineTo(px + HOUSE_W - 8, py + HOUSE_HEADER);
  ctx.stroke();
  
  const rects = houseRects();
  for (let i = 0; i < HOUSES.length; i++) {
    const r = rects[i];
    const h = r.item;
    const can = canAffordHouse(h.cost);
    
    ctx.fillStyle = 'rgba(20,40,30,.85)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(96,200,128,.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d0ffd0';
    ctx.font = 'bold 13px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(h.label, r.x + 8, r.y + 16);
    
    ctx.fillStyle = 'rgba(180,220,190,.7)';
    ctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(h.sub(), r.x + 8, r.y + 32);
    
    const by = r.y + (r.h - r.btnH) / 2;
    ctx.fillStyle = can ? 'rgba(30,120,60,.9)' : 'rgba(50,60,55,.6)';
    ctx.fillRect(r.btnX, by, r.btnW, r.btnH);
    ctx.strokeStyle = can ? '#60ff80' : 'rgba(96,128,110,.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.btnX, by, r.btnW, r.btnH);
    
    ctx.fillStyle = can ? '#d0ffd0' : '#888';
    ctx.font = 'bold 11px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Place', r.btnX + r.btnW/2, by + r.btnH/2 + 4);
  }
  ctx.textAlign = 'left';
}

// ── Wooden House Signposts ─────────────────────────────────────────
// ── House props: front-yard sign + hinged clickable door ──────────
// Shared geometries/materials (built once, not per rebuild).
const _hgSignPost   = new THREE.BoxGeometry(4, 40, 4);
const _hgSignBoard  = new THREE.BoxGeometry(26, 18, 3);
const _hgSignPlaque = new THREE.PlaneGeometry(20, 12);
const _hgDoorSlab   = new THREE.BoxGeometry(TILE-6, WALL_H*0.92, 6);
const _hgWoodDark   = new THREE.MeshStandardMaterial({color:0x6b4423, roughness:0.88, metalness:0.0});
const _hgWoodLight  = new THREE.MeshStandardMaterial({color:0x8b5a2b, roughness:0.85, metalness:0.0});
const _hgDoorMat    = new THREE.MeshStandardMaterial({color:0x7a4a24, roughness:0.82, metalness:0.0});
// The knob is the one genuinely metallic thing on a house — it was Lambert with
// a fake emissive standing in for a highlight. With an env map it can just be
// brass and catch a real reflection.
const _hgKnobMat    = new THREE.MeshStandardMaterial({color:0xd8c060, roughness:0.35, metalness:0.85});

const houseSignMeshes = [];   // {grp, plaqueMat, house}
const houseDoorMeshes = [];   // {pivot, house}

// Tile coords of a house's door (middle of the south wall) + the sign
// position (in the yard, just south-east of the door so it never blocks).
function houseDoorTile(h){ return {tx:h.x0+Math.floor(h.size/2), ty:h.y0+h.size-1}; }
function houseSignPos(h){
  const {tx,ty}=houseDoorTile(h);
  return { x:(tx+1)*TILE+6, z:(ty+1)*TILE+TILE*0.5 };
}

function rebuildHouseProps() {
  for (const s of houseSignMeshes) scene.remove(s.grp);
  for (const d of houseDoorMeshes) scene.remove(d.pivot);
  houseSignMeshes.length = 0; houseDoorMeshes.length = 0;
  if (!G.placedHouses || !scene) return;

  for (const h of G.placedHouses) {
    // ── signpost, standing in the front yard ──
    const sp = houseSignPos(h);
    const grp = new THREE.Group();
    const post  = new THREE.Mesh(_hgSignPost,  _hgWoodDark);  post.position.y=20; post.castShadow=true;
    const board = new THREE.Mesh(_hgSignBoard, _hgWoodLight); board.position.y=38; board.castShadow=true;
    // status plaque on both faces (green=public, red=private) — colored per frame
    const plaqueMat = new THREE.MeshBasicMaterial({color:0xd04030, side:THREE.DoubleSide});
    const plaque = new THREE.Mesh(_hgSignPlaque, plaqueMat);
    plaque.position.set(0,38,2.1);
    grp.add(post, board, plaque);
    grp.position.set(sp.x, 0, sp.z);
    scene.add(grp);
    houseSignMeshes.push({grp, plaqueMat, house:h});

    // ── hinged door in the south-wall gap ──
    const {tx,ty}=houseDoorTile(h);
    const hingeX = tx*TILE + 3;                 // pivot on the west edge of the doorway
    const cz     = ty*TILE + TILE/2;
    const pivot = new THREE.Group();
    pivot.position.set(hingeX, 0, cz);
    const slab = new THREE.Mesh(_hgDoorSlab, _hgDoorMat);
    slab.position.set((TILE-6)/2, WALL_H*0.46, 0);   // extends east from the hinge
    slab.castShadow = true;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(2.4,8,6), _hgKnobMat);
    knob.position.set(TILE-12, WALL_H*0.46, 4);
    pivot.add(slab, knob);
    pivot.rotation.y = h.doorOpen ? -Math.PI*0.5 : 0;
    scene.add(pivot);
    houseDoorMeshes.push({pivot, house:h});
  }
}
// keep the old name working for existing call sites
function updateHouseSigns(){ rebuildHouseProps(); }

// Smoothly swing doors toward their open/closed target + colour plaques.
function animateHouseProps() {
  for (const d of houseDoorMeshes) {
    const target = d.house.doorOpen ? -Math.PI*0.5 : 0;
    d.pivot.rotation.y += (target - d.pivot.rotation.y) * 0.25;
  }
  for (const s of houseSignMeshes) {
    s.plaqueMat.color.setHex(s.house.isPublic ? 0x40b040 : 0xd04030);
  }
}

function getNearbyHouseSignIndex() {
  if (!G.placedHouses) return -1;
  for (let i = 0; i < G.placedHouses.length; i++) {
    const sp = houseSignPos(G.placedHouses[i]);
    if (Math.hypot(sp.x - player.x, sp.z - player.y) < TILE * 2.5) return i;
  }
  return -1;
}
// Nearest house door within reach (for E-key / touch toggling), or -1.
function getNearbyHouseDoorIndex() {
  if (!G.placedHouses) return -1;
  let best=-1, bd=TILE*1.8;   // tight, so the yard sign (settings) stays reachable
  for (let i=0;i<G.placedHouses.length;i++) {
    const d=houseDoorTile(G.placedHouses[i]);
    const dist=Math.hypot(d.tx*TILE+TILE/2-player.x, d.ty*TILE+TILE/2-player.y);
    if (dist<bd){ bd=dist; best=i; }
  }
  return best;
}
// Toggle a house door with owner/friend/public permission (shared online).
function toggleHouseDoor(di){
  const h=G.placedHouses[di]; if(!h) return;
  const d=houseDoorTile(h), dcx=d.tx*TILE+TILE/2, dcy=d.ty*TILE+TILE/2;
  if(h.doorHp !== undefined && h.doorHp <= 0){
    addFloater(dcx,dcy-16,'🚪 door is broken — needs repair!');
    snd.hurt();
    return;
  }
  if(net.status==='online'&&h.owner&&h.owner!==playerName()&&!h.isPublic&&!(h.friends||[]).includes(playerName())){
    addFloater(dcx,dcy-16,'🔒 locked — '+h.owner+"'s house"); snd.hurt(); return;
  }
  h.doorOpen=!h.doorOpen;
  netHouseUpdate(di,{doorOpen:h.doorOpen});
  snd.craft(); addFloater(dcx,dcy-16,h.doorOpen?'door opened':'door closed');
  if(typeof saveGame==='function')saveGame();
}

// Which house's door tile a world point falls on (for clicking), or -1.
function getHouseDoorAt(wx, wy) {
  if (!G.placedHouses) return -1;
  const tx=Math.floor(wx/TILE), ty=Math.floor(wy/TILE);
  for (let i=0;i<G.placedHouses.length;i++) {
    const d=houseDoorTile(G.placedHouses[i]);
    if (tx===d.tx && ty===d.ty) return i;
  }
  return -1;
}
// Closed doors block movement across their tile (open doors let you pass).
function doorBlocks(cx, cy, r) {
  if (!G.placedHouses) return false;
  for (const h of G.placedHouses) {
    if (h.doorOpen) continue;
    const d=houseDoorTile(h), dx0=d.tx*TILE, dy0=d.ty*TILE;
    if (cx+r>dx0 && cx-r<dx0+TILE && cy+r>dy0 && cy-r<dy0+TILE) return true;
  }
  return false;
}

function isInsidePlacedHouse(tx, ty) {
  if (!G.placedHouses) return false;
  for (const h of G.placedHouses) {
    if (tx >= h.x0 && tx < h.x0 + h.size && ty >= h.y0 && ty < h.y0 + h.size) return true;
  }
  return false;
}

const SETTINGS_W = fitPanelW(320), SETTINGS_H = 340, SETTINGS_HEADER = 48, SETTINGS_PAD = 14;
function houseSettingsPanelXY() {
  return panelAt('house_settings', Math.round(G.canvas.width/2 - SETTINGS_W/2), Math.round(G.canvas.height/2 - SETTINGS_H/2), SETTINGS_W, SETTINGS_H);
}

function houseSettingsRects() {
  const {px, py} = houseSettingsPanelXY();
  const rects = [];
  rects.push({
    id: 'privacy_toggle',
    x: px + SETTINGS_PAD,
    y: py + 55,
    w: SETTINGS_W - SETTINGS_PAD * 2,
    h: 32
  });
  
  const colW = (SETTINGS_W - SETTINGS_PAD * 2 - 10) / 2;
  const startY = py + 125;
  const rowH = 34;
  // online: real players (current friends first so they can be removed even
  // while offline); offline fallback keeps the old NPC list
  let friendsList;
  if (net.status === 'online') {
    const h = G.placedHouses[G.activeHouseIndex];
    const names = new Set(h && h.friends ? h.friends : []);
    for (const [, st] of net.remotes) if (st.name !== playerName()) names.add(st.name);
    friendsList = [...names].slice(0, 6);
  } else {
    friendsList = ['Merchant', 'Banker', 'Healer', 'Blacksmith', 'Farrier', 'Mage'];
  }
  
  for (let i = 0; i < friendsList.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    rects.push({
      id: 'friend_' + friendsList[i].toLowerCase(),
      name: friendsList[i],
      x: px + SETTINGS_PAD + col * (colW + 10),
      y: startY + row * rowH,
      w: colW,
      h: 28
    });
  }
  rects.push({ id: 'repair_door', x: px + SETTINGS_PAD, y: py + SETTINGS_H - 76,
    w: SETTINGS_W - SETTINGS_PAD * 2, h: 30 });
  rects.push({ id: 'demolish', x: px + SETTINGS_PAD, y: py + SETTINGS_H - 40,
    w: SETTINGS_W - SETTINGS_PAD * 2, h: 30 });
  return rects;
}

function handleHouseSettingsClick(e) {
  const idx = G.activeHouseIndex;
  const house = G.placedHouses[idx];
  if (!house) return false;
  // online: only the owner may change privacy / friends / demolish
  const notMine = net.status==='online' && house.owner && house.owner !== playerName();
  const rects = houseSettingsRects();
  const demo = rects[rects.length - 1];
  if (e.clientX >= demo.x && e.clientX <= demo.x + demo.w && e.clientY >= demo.y && e.clientY <= demo.y + demo.h) {
    if (notMine) { addFloater(player.x, player.y-30, "not your house!"); return true; }
    clearHouseTiles(house);
    G.placedHouses.splice(idx, 1);
    netHouseRemove(idx);
    rebuildHouseProps();
    G.houseSettingsOpen = false;
    snd.craft(); addFloater(player.x, player.y-30, 'house demolished');
    if (typeof saveGame === 'function') saveGame();
    return false;
  }
  const repBtn = rects[rects.length - 2];
  if (e.clientX >= repBtn.x && e.clientX <= repBtn.x + repBtn.w && e.clientY >= repBtn.y && e.clientY <= repBtn.y + repBtn.h) {
    if (notMine) { addFloater(player.x, player.y-30, "not your house!"); return true; }
    const currentHp = house.doorHp === undefined ? 200 : house.doorHp;
    if (currentHp >= 200) {
      addFloater(player.x, player.y-30, 'door is fully repaired!');
      return true;
    }
    if (inv.planks >= 5 && (inv.iron_ingot || 0) >= 1) {
      inv.planks -= 5;
      inv.iron_ingot -= 1;
      house.doorHp = 200;
      netHouseUpdate(idx, { doorHp: 200 });
      snd.craft();
      addFloater(player.x, player.y-30, 'door repaired!');
      if (typeof saveGame === 'function') saveGame();
    } else {
      addFloater(player.x, player.y-30, 'need 5 planks + 1 iron ingot!');
    }
    return true;
  }
  const priv = rects[0];
  if (e.clientX >= priv.x && e.clientX <= priv.x + priv.w && e.clientY >= priv.y && e.clientY <= priv.y + priv.h) {
    if (notMine) { addFloater(player.x, player.y-30, "not your house!"); return true; }
    house.isPublic = !house.isPublic;
    netHouseUpdate(G.activeHouseIndex, { isPublic: house.isPublic });
    snd.pickup();
    if (typeof saveGame === 'function') saveGame();
    return true;
  }
  for (let i = 1; i < rects.length; i++) {
    const r = rects[i];
    if (e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y && e.clientY <= r.y + r.h) {
      if (notMine) { addFloater(player.x, player.y-30, "not your house!"); return true; }
      house.friends = house.friends || [];
      const idx = house.friends.indexOf(r.name);
      if (idx === -1) {
        house.friends.push(r.name);
      } else {
        house.friends.splice(idx, 1);
      }
      netHouseUpdate(G.activeHouseIndex, { friends: house.friends });
      snd.pickup();
      if (typeof saveGame === 'function') saveGame();
      return true;
    }
  }
  return false;
}

function renderHouseSettingsPanel() {
  const ctx = G.ctx;
  const {px, py} = houseSettingsPanelXY();
  const house = G.placedHouses[G.activeHouseIndex];
  if (!house) { G.houseSettingsOpen = false; return; }
  
  ctx.fillStyle = 'rgba(12,10,18,.96)';
  ctx.fillRect(px, py, SETTINGS_W, SETTINGS_H);
  ctx.strokeStyle = '#a890d0';
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, SETTINGS_W, SETTINGS_H);
  
  ctx.fillStyle = '#a890d0';
  ctx.font = 'bold 14px ui-monospace,Menlo,Consolas,monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🏡 HOUSE SETTINGS  ·  E to close', px + SETTINGS_W/2, py + 20);
  
  ctx.fillStyle = '#888';
  ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(`Owner: ${house.owner || 'you'}  ·  House #${G.activeHouseIndex + 1}`, px + SETTINGS_W/2, py + 36);
  
  ctx.strokeStyle = 'rgba(168,144,208,.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 8, py + SETTINGS_HEADER);
  ctx.lineTo(px + SETTINGS_W - 8, py + SETTINGS_HEADER);
  ctx.stroke();
  
  const rects = houseSettingsRects();
  const privBtn = rects[0];
  const isPub = house.isPublic;
  
  ctx.fillStyle = isPub ? 'rgba(50,110,35,.85)' : 'rgba(120,40,40,.85)';
  ctx.fillRect(privBtn.x, privBtn.y, privBtn.w, privBtn.h);
  ctx.strokeStyle = isPub ? '#6c3' : '#e66';
  ctx.lineWidth = 1;
  ctx.strokeRect(privBtn.x, privBtn.y, privBtn.w, privBtn.h);
  
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(isPub ? '🔓 Status: PUBLIC (Anyone can enter)' : '🔒 Status: PRIVATE (Friends only)', px + SETTINGS_W/2, privBtn.y + 20);
  
  ctx.fillStyle = '#a890d0';
  ctx.font = 'bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('— Friend Access List —', px + SETTINGS_W/2, py + 112);
  
  const friends = house.friends || [];
  for (let i = 1; i < rects.length - 2; i++) {   // last 2 rects are Repair and Demolish
    const r = rects[i];
    const added = friends.includes(r.name);

    ctx.fillStyle = added ? 'rgba(60,110,80,.85)' : 'rgba(35,30,45,.85)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = added ? '#5d8' : 'rgba(168,144,208,.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    ctx.fillStyle = added ? '#dcf' : '#888';
    ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText((added ? '✓ ' : '+ ') + r.name, r.x + r.w/2, r.y + 18);
  }
  const repBtn = rects[rects.length - 2];
  const doorHp = house.doorHp === undefined ? 200 : house.doorHp;
  ctx.fillStyle = doorHp < 200 ? 'rgba(200, 162, 90, 0.85)' : 'rgba(60, 50, 40, 0.7)';
  ctx.fillRect(repBtn.x, repBtn.y, repBtn.w, repBtn.h);
  ctx.strokeStyle = '#c8a25a'; ctx.lineWidth = 1; ctx.strokeRect(repBtn.x, repBtn.y, repBtn.w, repBtn.h);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(`🔧 Repair Door (Cost: 5p + 1i) [HP: ${doorHp}/200]`, px + SETTINGS_W/2, repBtn.y + 20);

  const demo = rects[rects.length - 1];
  ctx.fillStyle = 'rgba(120,30,30,.9)'; ctx.fillRect(demo.x, demo.y, demo.w, demo.h);
  ctx.strokeStyle = '#e66'; ctx.lineWidth = 1; ctx.strokeRect(demo.x, demo.y, demo.w, demo.h);
  ctx.fillStyle = '#fdd'; ctx.font = 'bold 12px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('🔨 Demolish House (refund none)', px + SETTINGS_W/2, demo.y + 20);
  ctx.textAlign = 'left';
}

// ── Backpack / drops / trading ─────────────────────────────────────
const BAG_ITEMS=[
  {k:'gold',lab:'Gold',ic:'🪙',spr:'chest'},{k:'wood',lab:'Wood',ic:'🪵'},{k:'stone',lab:'Stone',ic:'🪨'},
  {k:'planks',lab:'Planks',ic:'▤'},{k:'arrows',lab:'Arrows',ic:'➶',spr:'crossbow'},{k:'hide',lab:'Hide',ic:'🟫',spr:'hidepile'},
  {k:'bone',lab:'Bone',ic:'🦴'},{k:'bandages',lab:'Bandages',ic:'✚',spr:'bandage'},{k:'potions',lab:'Potions',ic:'⚗',spr:'potion_red'},
  {k:'skull',lab:'Skull',ic:'💀'},
  {k:'iron_ore',lab:'Iron Ore',ic:'🪨',spr:'crystals'},{k:'iron_ingot',lab:'Iron Ingot',ic:'🧱',spr:'anvil'},{k:'steel_ingot',lab:'Steel Ingot',ic:'🔗',spr:'tongs'},{k:'siege_ram',lab:'Siege Ram',ic:'🐏'},
  // Every placeable is a pack item — drag one to the hotbar, select it, right-click to place.
  ...Object.keys(PLACEABLES).map(k=>({k:PLACEABLES[k].invKey, lab:PLACEABLES[k].label,
    ic:PLACEABLES[k].emoji, ...(k==='torch'?{spr:'torch'}:{})})),
  // Lootable gear — model thumbnails drawn via `thumb`, real 3D on the ground
  ...LOOT_KEYS.map(k=>({k, lab:LOOT_GEAR[k].lab, ic:LOOT_GEAR[k].ic, thumb:k})),
];
const BAG_BY_KEY=Object.fromEntries(BAG_ITEMS.map(b=>[b.k,b]));
// Custom backpack arrangement (drag a cell onto another to reorder).
// Stored as an ordered list of resource keys; artifacts always follow.
const PACK_ORDER_KEY='bravo3d_pack_order';
let packOrder=(()=>{ try{const a=JSON.parse(localStorage.getItem(PACK_ORDER_KEY));return Array.isArray(a)?a:null;}catch(_){return null;} })();
function packOrderKeys(){
  const base=BAG_ITEMS.map(b=>b.k);
  if(!packOrder)return base;
  const seen=packOrder.filter(k=>BAG_BY_KEY[k]);
  for(const k of base)if(!seen.includes(k))seen.push(k);
  return seen;
}
function packReorder(fromIdx,toIdx){
  const items=packItems(),a=items[fromIdx];
  if(!a||a.kind!=='res'||fromIdx===toIdx)return;
  // fromIdx/toIdx index the VISIBLE pack, which now only lists what is actually
  // carried — so they cannot be spliced straight into packOrderKeys(), which still
  // holds every item in the game. Reorder the visible keys, then put the ones the
  // player is not carrying after them so they keep a stable order for later.
  const visible=items.filter(it=>it.kind==='res').map(it=>it.k);
  const moved=visible.filter(k=>k!==a.k);
  moved.splice(Math.max(0,Math.min(toIdx,moved.length)),0,a.k);
  const order=[...moved,...packOrderKeys().filter(k=>!moved.includes(k))];
  packOrder=order;
  try{localStorage.setItem(PACK_ORDER_KEY,JSON.stringify(order));}catch(_){}
  G.packSel=Math.min(toIdx,packItems().length-1);
}
function invAdd(type,n){ inv[type]=(inv[type]||0)+n; }
function dropItem(type,count){
  const have=inv[type]||0; const n=Math.min(count,have);
  if(n<=0){ addFloater(player.x,player.y-30,'none to drop'); return; }
  inv[type]=have-n;
  if(net.status==='online') netDropAdd(type,n);        // server brokers the shared drop
  else { for(let i=0;i<Math.min(n,6);i++){const a=Math.random()*6.28,d=8+Math.random()*14;drops.push({type,x:player.x+Math.cos(a)*d,y:player.y+Math.sin(a)*d,lifetime:120});} }
  addFloater(player.x,player.y-24,'dropped '+n+' '+type); snd.pickup();
  saveGame(true);
}
const BAG_W=300, BAG_ROWH=26, BAG_PAD=12;   // still used by the secure-chest panel
// ── Backpack — artwork grid (O) ────────────────────────────────────
// The 6×6 grid area of the backpack art holds resources + artifacts as
// icon cells; wheel (or the ▲▼ arrows) scrolls rows when they overflow.
// Grid-first layout. The old PACK_GRID mapped the usable area into a backpack
// illustration; the panel is now built FROM the grid instead, so nothing is spent on
// artwork. Everything below scales together via packScaleG().
const PACK_COLS=6, PACK_ROWS=6;
const PACK_CELL=46;      // cell edge at scale 1
const PACK_FRAME=12;     // border around the grid
const PACK_GUTTER=26;    // right-hand column holding the ▲▼ scroll arrows
const PACK_FOOTER=54;    // selected-item label + drop/sell buttons
function packScaleG(){ return (panelOfs.backpack&&panelOfs.backpack.s)||1; }
let packResize=null;
function backpackXY(){
  const s=packScaleG();
  const W=Math.round((PACK_FRAME*2 + PACK_CELL*PACK_COLS + PACK_GUTTER)*s);
  const H=Math.round((PACK_FRAME*2 + PACK_CELL*PACK_ROWS + PACK_FOOTER)*s);
  const defaultX = Math.round(G.canvas.width/2 - W/2);
  const x = G.chestOpen ? defaultX + 170 : defaultX;
  return {...panelAt('backpack', x, Math.round(G.canvas.height/2 - H/2), W, H), W, H};
}
function packItems(){
  // Only what the player actually carries. The pack used to list every item in the
  // game at a count of 0, so finding the three things you own meant scanning past
  // forty you did not. Ordering (packOrder) still applies to whatever survives.
  const items=packOrderKeys().map(k=>({kind:'res',...BAG_BY_KEY[k],n:inv[k]||0})).filter(it=>it.n>0);
  player.artifactInv.forEach((item,idx)=>{
    const def=artifactDef(item.defId);
    items.push({kind:'art',idx,item,lab:item.identified?def.name:'Unidentified Artifact',ic:item.identified?def.icon:'❔'});
  });
  return items;
}
function packGridRect(){
  const{px,py,W,H}=backpackXY(), s=packScaleG();
  const f=PACK_FRAME*s;
  return {x:px+f, y:py+f, w:W-f*2-PACK_GUTTER*s, h:H-f*2-PACK_FOOTER*s};
}
function packMaxScroll(){ return Math.max(0,Math.ceil(packItems().length/PACK_COLS)-PACK_ROWS); }
function packCellAt(sx,sy){
  const g=packGridRect(),cw=g.w/PACK_COLS,ch=g.h/PACK_ROWS;
  if(sx<g.x||sy<g.y||sx>g.x+g.w||sy>g.y+g.h)return -1;
  const col=Math.min(PACK_COLS-1,((sx-g.x)/cw)|0),row=Math.min(PACK_ROWS-1,((sy-g.y)/ch)|0);
  return (row+G.packScroll)*PACK_COLS+col;
}
function packArrowRects(){
  const g=packGridRect(),s=22;
  return [{x:g.x+g.w+8,y:g.y,w:s,h:s},{x:g.x+g.w+8,y:g.y+g.h-s,w:s,h:s}];
}
function packBtnRects(){
  const g=packGridRect(), s=packScaleG();
  const bw=Math.round(74*s), bh=Math.round(22*s);
  const by=g.y+g.h+Math.round(26*s);
  return [{x:g.x,y:by,w:bw,h:bh},{x:g.x+bw+Math.round(8*s),y:by,w:bw,h:bh}];
}
function renderBackpack(){
  const ctx=G.ctx,{px,py,W,H}=backpackXY(),s=packScaleG();
  // Frame. Two tones so the border still reads as leather without a 1408px image.
  ctx.fillStyle='#3a2a1c';ctx.fillRect(px,py,W,H);
  ctx.strokeStyle='#6b4e2f';ctx.lineWidth=Math.max(2,3*s);ctx.strokeRect(px+1,py+1,W-2,H-2);
  ctx.strokeStyle='rgba(200,162,90,.45)';ctx.lineWidth=1;ctx.strokeRect(px+4*s,py+4*s,W-8*s,H-8*s);
  const g=packGridRect(),cw=g.w/PACK_COLS,ch=g.h/PACK_ROWS;
  // Every cell gets its socket drawn, occupied or not — an empty grid should still read
  // as a grid, which is what the old illustration was doing for free.
  ctx.fillStyle='rgba(24,17,11,.92)';ctx.fillRect(g.x,g.y,g.w,g.h);
  for(let row=0;row<PACK_ROWS;row++)for(let col=0;col<PACK_COLS;col++){
    const x=g.x+col*cw, y=g.y+row*ch;
    ctx.fillStyle='rgba(52,38,25,.85)';ctx.fillRect(x+2,y+2,cw-4,ch-4);
    ctx.strokeStyle='rgba(120,92,58,.55)';ctx.lineWidth=1;ctx.strokeRect(x+2.5,y+2.5,cw-5,ch-5);
  }
  const items=packItems(),maxS=packMaxScroll();
  if(G.packScroll>maxS)G.packScroll=maxS;
  if(G.packSel!=null&&G.packSel>=items.length)G.packSel=null;
  for(let row=0;row<PACK_ROWS;row++)for(let col=0;col<PACK_COLS;col++){
    const i=(row+G.packScroll)*PACK_COLS+col;
    if(i>=items.length)continue;
    const it=items[i],x=g.x+col*cw,y=g.y+row*ch,sel=G.packSel===i;
    if(sel){ctx.fillStyle='rgba(240,216,120,.22)';ctx.fillRect(x+1,y+1,cw-2,ch-2);}
    const dim=it.kind==='res'&&it.n<=0,a=dim?0.22:1;
    const sz=Math.min(cw,ch)*0.76;
    const drewIcon = (it.thumb&&drawLootThumb(it.thumb,x+(cw-sz)/2,y+(ch-sz)/2,sz,sz,a))
                  || (it.spr&&drawSprite(it.spr,x+(cw-sz)/2,y+(ch-sz)/2,sz,sz,a));
    if(!drewIcon){
      ctx.globalAlpha=a;ctx.font=Math.round(sz*0.6)+'px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
      ctx.fillText(it.ic,x+cw/2,y+ch/2+sz*0.22);ctx.globalAlpha=1;
    }
    if(it.kind==='res'&&it.n>0){
      const bs=it.n>9999?((it.n/1000)|0)+'k':''+it.n;
      ctx.font='bold '+Math.max(9,Math.round(ch*0.22))+'px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='right';
      ctx.fillStyle='rgba(0,0,0,.85)';ctx.fillText(bs,x+cw-2,y+ch-3);
      ctx.fillStyle='#f0d878';ctx.fillText(bs,x+cw-3,y+ch-4);
    }
    if(it.kind==='art'){                     // artifact tier pip
      ctx.font='bold '+Math.max(8,Math.round(ch*0.17))+'px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='right';
      ctx.fillStyle=it.item.identified?'#c090f0':'rgba(200,180,220,.6)';
      ctx.fillText(it.item.identified?'T'+artifactDef(it.item.defId).tier:'?',x+cw-3,y+ch-4);
    }
    if(sel){ctx.strokeStyle='#f0d060';ctx.lineWidth=2;ctx.strokeRect(x+1,y+1,cw-2,ch-2);}
  }
  // scroll arrows + row dots
  if(maxS>0){
    const[up,dn]=packArrowRects();
    const arrow=(r,ch2,on)=>{ctx.fillStyle=on?'rgba(60,45,25,.92)':'rgba(30,24,16,.6)';ctx.fillRect(r.x,r.y,r.w,r.h);
      ctx.strokeStyle=on?'#c8a25a':'rgba(120,100,70,.4)';ctx.lineWidth=1;ctx.strokeRect(r.x,r.y,r.w,r.h);
      ctx.fillStyle=on?'#f0d878':'#665';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
      ctx.fillText(ch2,r.x+r.w/2,r.y+16);};
    arrow(up,'▲',G.packScroll>0);arrow(dn,'▼',G.packScroll<maxS);
    ctx.fillStyle='rgba(240,216,120,.75)';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText((G.packScroll+1)+'-'+Math.min(G.packScroll+PACK_ROWS,Math.ceil(items.length/PACK_COLS))+'/'+Math.ceil(items.length/PACK_COLS),up.x+up.w/2,(up.y+dn.y+dn.h)/2+4);
  }
  // No title bar: it used to sit on the illustration's top flap at H*0.115, which is
  // inside the grid now, and a bag full of items does not need labelling.
  // Selected-item info + actions live in the footer strip under the grid.
  if(G.packSel!=null&&items[G.packSel]){
    const it=items[G.packSel];
    ctx.fillStyle='#f0e0b8';ctx.font='bold '+Math.max(10,Math.round(11*s))+'px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign='left';
    ctx.fillText(it.kind==='res'?it.lab+'  ×'+it.n:it.ic+' '+it.lab,g.x,g.y+g.h+Math.round(16*s));
    if(it.kind==='res'){
      const[b1,b2]=packBtnRects(),has=it.n>0;
      const btn=(b,txt,on=has)=>{ctx.fillStyle=on?'rgba(120,60,30,.92)':'rgba(40,34,26,.7)';ctx.fillRect(b.x,b.y,b.w,b.h);
        ctx.strokeStyle=on?'#d0904a':'rgba(120,100,70,.4)';ctx.lineWidth=1;ctx.strokeRect(b.x,b.y,b.w,b.h);
        ctx.fillStyle=on?'#ffe0b0':'#665';ctx.font='bold '+Math.max(9,Math.round(H*0.022))+'px ui-monospace,Menlo,Consolas,monospace';
        ctx.fillText(txt,b.x+b.w/2,b.y+b.h/2+4);};
      // gear can be sold to the merchant right from the bag when standing near them
      const canSellGear = isLootGear(it.k) && Math.hypot(MERCHANT.x-player.x,MERCHANT.y-player.y)<TILE*2.5;
      btn(b1,'drop 1');
      if(canSellGear) btn(b2,'sell '+LOOT_GEAR[it.k].value+'g');
      else btn(b2,'drop all');
    }else{
      ctx.fillStyle='rgba(224,200,255,.8)';ctx.font=Math.max(9,Math.round(9*s))+'px ui-monospace,Menlo,Consolas,monospace';
      ctx.textAlign='left';
      ctx.fillText(it.item.identified?'equip on the paper doll (I)':'identify at the Cryptologist',g.x,g.y+g.h+Math.round(38*s));
    }
  }
  // resize handle (bottom-right of the grid frame)
  ctx.fillStyle='rgba(200,162,90,.75)';ctx.fillRect(g.x+g.w+8,g.y+g.h+8,9,9);
  ctx.textAlign='left';
}
function handleBackpackClick(e){
  const hit=b=>e.clientX>=b.x&&e.clientX<=b.x+b.w&&e.clientY>=b.y&&e.clientY<=b.y+b.h;
  const g=packGridRect();
  if(hit({x:g.x+g.w+4,y:g.y+g.h+4,w:17,h:17})){packResize={sx:e.clientX,sy:e.clientY,s0:packScaleG()};return true;}
  const items=packItems();
  if(G.packSel!=null&&items[G.packSel]&&items[G.packSel].kind==='res'){
    const[b1,b2]=packBtnRects(),k=items[G.packSel].k;
    if(hit(b1)){dropItem(k,1);return true;}
    if(hit(b2)){
      // gear near the merchant → sell one for gold instead of dropping the stack
      if(isLootGear(k) && (inv[k]||0)>0 && Math.hypot(MERCHANT.x-player.x,MERCHANT.y-player.y)<TILE*2.5){
        inv[k]-=1; inv.gold+=LOOT_GEAR[k].value; snd.gold();
        addFloater(player.x,player.y-20,'sold '+itemLabel(k)+'  +'+LOOT_GEAR[k].value+'g');
        return true;
      }
      dropItem(k,inv[k]||0); return true;
    }
  }
  if(packMaxScroll()>0){
    const[up,dn]=packArrowRects();
    if(hit(up)){G.packScroll=Math.max(0,G.packScroll-1);return true;}
    if(hit(dn)){G.packScroll=Math.min(packMaxScroll(),G.packScroll+1);return true;}
  }
  const ci=packCellAt(e.clientX,e.clientY);
  if(ci>=0){
    G.packSel=ci<items.length?ci:null;
    // picking up a cell starts a potential drag (UO/Minecraft-style):
    // release over the hotbar to bind, another cell to rearrange, or
    // the world to drop it on the ground
    if(G.packSel!=null)uiDrag={src:'pack',idx:ci,sx:e.clientX,sy:e.clientY,x:e.clientX,y:e.clientY,moved:false};
    return true;
  }
  return true;                              // modal panel: swallow stray clicks
}

// ── Drag & drop: backpack ↔ hotbar ↔ world ────────────────────────
let uiDrag=null;   // {src:'pack'|'hotbar', idx|slotIdx, sx,sy, x,y, moved}
// items usable straight from a hotbar slot: equipables + consumables
// Selecting one of these on the hotbar puts it in hand (sets player.weapon).
// Every placeable qualifies: holding it is what makes right-click place it.
const ITEM_EQUIP={siege_ram:1};
for(const k in PLACEABLES) ITEM_EQUIP[PLACEABLES[k].invKey]=1;
const ITEM_ACT={potions:'potion',bandages:'bandage'};
function finishUiDrag(e){
  const d=uiDrag; uiDrag=null;
  if(!d)return false;
  if(!d.moved){
    // plain click on a hotbar slot fires it (click-to-fire preserved)
    if(d.src==='hotbar')fireHotbarSlot(d.slotIdx);
    return d.src==='hotbar';
  }
  const hi=hotbarSlotAt(e.clientX,e.clientY);
  if(d.src==='pack'){
    const it=packItems()[d.idx];
    if(!it)return true;
    if(hi!==-1){
      if(it.kind==='res'){hotbar[hi]={k:'item',id:it.k};addFloater(player.x,player.y-30,it.lab+' → slot '+(hi+1));snd.pickup();}
      else addFloater(player.x,player.y-30,'equip artifacts on the paper doll (I)');
      return true;
    }
    if(G.backpackOpen){
      const ci=packCellAt(e.clientX,e.clientY);
      if(ci>=0){ if(it.kind==='res')packReorder(d.idx,ci); return true; }
      const {px,py,W,H}=backpackXY();
      if(e.clientX>=px&&e.clientX<=px+W&&e.clientY>=py&&e.clientY<=py+H)return true;   // dropped on the bag art: no-op
    }
    // released over the world → drop on the ground (Shift = whole stack)
    if(it.kind==='res'){ if((inv[it.k]||0)>0)dropItem(it.k,e.shiftKey?(inv[it.k]||0):1); else addFloater(player.x,player.y-30,'none to drop'); }
    else addFloater(player.x,player.y-30,"artifacts can't be dropped — sell or equip them");
    return true;
  }
  if(d.src==='hotbar'){
    if(hi!==-1){ if(hi!==d.slotIdx){const t=hotbar[hi];hotbar[hi]=hotbar[d.slotIdx];hotbar[d.slotIdx]=t;} }
    else hotbar[d.slotIdx]=null;             // dragged off the bar → unbind (item stays in the pack)
    return true;
  }
  return true;
}
function drawUiDragGhost(){
  if(!uiDrag||!uiDrag.moved)return;
  const ctx=G.ctx,x=uiDrag.x,y=uiDrag.y;
  const hi=hotbarSlotAt(x,y);                // green highlight on the target slot
  if(hi!==-1){const r=hotbarRect(),sx=r.x+hi*(HOTBAR_SZ+HOTBAR_GAP);
    ctx.strokeStyle='#80e080';ctx.lineWidth=2;ctx.strokeRect(sx-1,r.y-1,HOTBAR_SZ+2,HOTBAR_SZ+2);}
  let spr=null,icon='?';
  if(uiDrag.src==='pack'){
    const it=packItems()[uiDrag.idx];
    if(it){spr=it.spr;icon=it.ic;}
  }else{
    const s=hotbar[uiDrag.slotIdx],def=hotbarSlotDef(s);
    if(s&&def){
      icon=def.icon;
      spr=s.k==='weapon'?WEAPON_SPR[s.id]:s.k==='act'?ACTION_SPR[s.id]:s.k==='item'?(BAG_BY_KEY[s.id]||{}).spr:s.k==='macro'?'scroll':null;
    }
  }
  const SZ=40;
  if(!(spr&&drawSprite(spr,x-SZ/2,y-SZ/2,SZ,SZ,0.85))){
    ctx.save();ctx.globalAlpha=0.85;
    ctx.font='28px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText(icon,x,y+10);ctx.restore();
  }
  ctx.textAlign='left';
}

const CHEST_W=fitPanelW(310);
function chestXY(){
  const H=52+BAG_ITEMS.length*BAG_ROWH+18;
  const defaultX = Math.round(G.canvas.width/2 - CHEST_W/2);
  const x = defaultX - 160;
  return panelAt('secure_chest_panel', x, Math.round(G.canvas.height/2 - H/2), CHEST_W, H);
}
function chestRects(){
  const {px,py}=chestXY(); const rects=[]; let y=py+44;
  for(const it of BAG_ITEMS){
    rects.push({
      k: it.k,
      dp1: {x: px + CHEST_W - 130, y, w: 22, h: 20},
      dpA: {x: px + CHEST_W - 104, y, w: 32, h: 20},
      wd1: {x: px + CHEST_W - 64, y, w: 22, h: 20},
      wdA: {x: px + CHEST_W - 38, y, w: 32, h: 20}
    });
    y+=BAG_ROWH;
  }
  return rects;
}
function renderChest(){
  const ctx=G.ctx; const {px,py}=chestXY(); const H=52+BAG_ITEMS.length*BAG_ROWH+18;
  const chest = G.activeChest;
  if (!chest) { G.chestOpen = false; return; }
  ctx.fillStyle='rgba(12,14,24,.97)';ctx.fillRect(px,py,CHEST_W,H);
  ctx.strokeStyle='#a890d0';ctx.lineWidth=2;ctx.strokeRect(px,py,CHEST_W,H);
  ctx.fillStyle='#b8e8b0';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('🔒 SECURE CHEST (HP: '+chest.hp+'/'+chest.maxHp+')',px+CHEST_W/2,py+22);ctx.textAlign='left';
  const rects=chestRects();
  for(let i=0;i<BAG_ITEMS.length;i++){
    const it=BAG_ITEMS[i],r=rects[i],y=r.dp1.y;
    ctx.fillStyle='#e8dcc0';ctx.font='12px ui-monospace,Menlo,Consolas,monospace';
    if(it.thumb&&drawLootThumb(it.thumb,px+BAG_PAD,y-2,20,20)) ctx.fillText(it.lab,px+BAG_PAD+24,y+15);
    else ctx.fillText(it.ic+' '+it.lab,px+BAG_PAD,y+15);
    const chestCount = chest.items[it.k] || 0;
    ctx.textAlign='right';ctx.fillStyle='#b8e8b0';ctx.fillText(''+chestCount,px+CHEST_W-138,y+15);ctx.textAlign='left';
    const btn=(b,txt,on)=>{
      ctx.fillStyle=on?'rgba(45,85,35,.9)':'rgba(40,34,26,.7)';ctx.fillRect(b.x,b.y,b.w,b.h);
      ctx.strokeStyle=on?'#70b860':'rgba(120,100,70,.4)';ctx.lineWidth=1;ctx.strokeRect(b.x,b.y,b.w,b.h);
      ctx.fillStyle=on?'#e0ffd0':'#665';ctx.font='10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
      ctx.fillText(txt,b.x+b.w/2,b.y+14);ctx.textAlign='left';
    };
    const hasInv = (inv[it.k] || 0) > 0;
    const hasChest = chestCount > 0;
    btn(r.dp1, '+1', hasInv);
    btn(r.dpA, '+All', hasInv);
    btn(r.wd1, '-1', hasChest);
    btn(r.wdA, '-All', hasChest);
  }
}
function handleChestClick(e){
  const chest = G.activeChest;
  if (!chest) return false;
  const rects = chestRects();
  for(let i=0;i<BAG_ITEMS.length;i++){
    const r=rects[i],k=BAG_ITEMS[i].k;
    const hit=b=>e.clientX>=b.x&&e.clientX<=b.x+b.w&&e.clientY>=b.y&&e.clientY<=b.y+b.h;
    if (hit(r.dp1)) {
      const have = inv[k] || 0;
      if (have > 0) {
        inv[k] = have - 1;
        chest.items[k] = (chest.items[k] || 0) + 1;
        if (k === 'gold') snd.gold(); else snd.pickup();
        saveGame(true);
      }
      return true;
    }
    if (hit(r.dpA)) {
      const have = inv[k] || 0;
      if (have > 0) {
        inv[k] = 0;
        chest.items[k] = (chest.items[k] || 0) + have;
        if (k === 'gold') snd.gold(); else snd.pickup();
        saveGame(true);
      }
      return true;
    }
    if (hit(r.wd1)) {
      const have = chest.items[k] || 0;
      if (have > 0) {
        chest.items[k] = have - 1;
        inv[k] = (inv[k] || 0) + 1;
        if (k === 'gold') snd.gold(); else snd.pickup();
        saveGame(true);
      }
      return true;
    }
    if (hit(r.wdA)) {
      const have = chest.items[k] || 0;
      if (have > 0) {
        chest.items[k] = 0;
        inv[k] = (inv[k] || 0) + have;
        if (k === 'gold') snd.gold(); else snd.pickup();
        saveGame(true);
      }
      return true;
    }
  }
  return true;
}
function openSecureChest(chest) {
  const tx = Math.floor(chest.x/TILE), ty = Math.floor(chest.y/TILE);
  const h = getHouseContaining(tx, ty);
  const myName = playerName();
  const hasAccess = net.status !== 'online' || !chest.owner || chest.owner === myName || (h && (h.owner === myName || (h.friends||[]).includes(myName)));
  if (!hasAccess) {
    addFloater(chest.x, chest.y-16, '🔒 locked — ' + (chest.owner || 'secure') + "'s chest");
    snd.hurt();
    return;
  }
  closeShopPanels();
  G.chestOpen = true;
  G.activeChest = chest;
  G.backpackOpen = true;
  snd.pickup();
}

// ── Trade window ──
function openTrade(withId,withName){
  G.tradeInvite=null;
  G.trade={withId,withName,my:{gold:0,items:{}},their:{gold:0,items:{}},myConf:false,theirConf:false};
  G.craftOpen=G.tradeOpen=G.bankOpen=G.skillOpen=G.backpackOpen=false;
  addFloater(player.x,player.y-40,'🤝 trading with '+withName);
}
function closeTrade(completed){ G.trade=null; if(!completed)addFloater(player.x,player.y-30,'trade closed'); }
function sendTradeOffer(){ if(G.trade){ G.trade.myConf=false; netTradeOffer(G.trade.my); } }
function tradeAdj(k,dir){
  if(!G.trade)return; const o=G.trade.my;
  if(k==='gold'){ const step=dir>0?10:-10; o.gold=Math.max(0,Math.min(inv.gold||0,(o.gold||0)+step)); }
  else { o.items[k]=Math.max(0,Math.min(inv[k]||0,(o.items[k]||0)+dir)); }
  sendTradeOffer();
}
function applyTradeSwap(give,get){
  inv.gold=Math.max(0,(inv.gold||0)-(give.gold||0))+(get.gold||0);
  const allK=new Set([...Object.keys(give.items||{}),...Object.keys(get.items||{})]);
  for(const k of allK){ inv[k]=Math.max(0,(inv[k]||0)-((give.items||{})[k]||0))+((get.items||{})[k]||0); }
  addFloater(player.x,player.y-30,'✅ trade complete!'); snd.gold(); saveGame(true);
}
const PT_ITEMS=['gold','wood','stone','planks','arrows','hide','bone','potions','bandages'];
const TR_W=fitPanelW(380), TR_ROWH=24, TR_PAD=12;
function ptradeXY(){ const H=64+PT_ITEMS.length*TR_ROWH+52; return panelAt('trade_p', Math.round(G.canvas.width/2-TR_W/2), Math.round(G.canvas.height/2-H/2), TR_W, H); }
function ptradeRects(){
  const {px,py}=ptradeXY(); const rects={rows:[]}; let y=py+52;
  for(const k of PT_ITEMS){ rects.rows.push({k,minus:{x:px+118,y,w:20,h:18},plus:{x:px+164,y,w:20,h:18}}); y+=TR_ROWH; }
  const by=py+64+PT_ITEMS.length*TR_ROWH+8;
  rects.confirm={x:px+TR_PAD,y:by,w:(TR_W-TR_PAD*3)/2,h:30};
  rects.cancel={x:px+TR_PAD*2+(TR_W-TR_PAD*3)/2,y:by,w:(TR_W-TR_PAD*3)/2,h:30};
  return rects;
}
function renderTrade(){
  const ctx=G.ctx,tr=G.trade; if(!tr)return; const {px,py}=ptradeXY(); const H=64+PT_ITEMS.length*TR_ROWH+52;
  ctx.fillStyle='rgba(14,12,20,.98)';ctx.fillRect(px,py,TR_W,H);
  ctx.strokeStyle='#9a80d0';ctx.lineWidth=2;ctx.strokeRect(px,py,TR_W,H);
  ctx.fillStyle='#c0a8f0';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('🤝 TRADE with '+tr.withName,px+TR_W/2,py+22);
  ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillStyle='#9a86c0';
  ctx.fillText('you give',px+72,py+40); ctx.fillText('they give',px+TR_W-90,py+40);
  ctx.textAlign='left';
  const rects=ptradeRects();
  for(let i=0;i<PT_ITEMS.length;i++){ const k=PT_ITEMS[i],r=rects.rows[i],y=r.minus.y;
    ctx.fillStyle='#cbb8e8';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';ctx.fillText(k,px+TR_PAD,y+14);
    const mine=k==='gold'?(tr.my.gold||0):((tr.my.items||{})[k]||0);
    const theirs=k==='gold'?(tr.their.gold||0):((tr.their.items||{})[k]||0);
    const stepBtn=(b,t)=>{ ctx.fillStyle='rgba(80,60,120,.9)';ctx.fillRect(b.x,b.y,b.w,b.h);ctx.strokeStyle='#a68fd8';ctx.lineWidth=1;ctx.strokeRect(b.x,b.y,b.w,b.h);ctx.fillStyle='#e8dcf8';ctx.textAlign='center';ctx.fillText(t,b.x+b.w/2,b.y+13);ctx.textAlign='left'; };
    stepBtn(r.minus,'−'); stepBtn(r.plus,'+');
    ctx.fillStyle='#fff';ctx.textAlign='center';ctx.fillText(''+mine,px+152,y+14);ctx.textAlign='left';
    ctx.fillStyle='#c8f0c8';ctx.textAlign='right';ctx.fillText(''+theirs,px+TR_W-TR_PAD,y+14);ctx.textAlign='left';
  }
  const cfm=rects.confirm,cnc=rects.cancel;
  ctx.fillStyle=tr.myConf?'rgba(40,120,55,.95)':'rgba(50,80,40,.9)';ctx.fillRect(cfm.x,cfm.y,cfm.w,cfm.h);
  ctx.strokeStyle='#6d3';ctx.lineWidth=1;ctx.strokeRect(cfm.x,cfm.y,cfm.w,cfm.h);
  ctx.fillStyle='#eaffea';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText(tr.myConf?'✓ YOU CONFIRMED':'CONFIRM',cfm.x+cfm.w/2,cfm.y+19);
  ctx.fillStyle='rgba(120,40,40,.9)';ctx.fillRect(cnc.x,cnc.y,cnc.w,cnc.h);ctx.strokeStyle='#e66';ctx.strokeRect(cnc.x,cnc.y,cnc.w,cnc.h);
  ctx.fillStyle='#fdd';ctx.fillText('CANCEL',cnc.x+cnc.w/2,cnc.y+19);
  ctx.fillStyle=tr.theirConf?'#8f8':'#877';ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText(tr.theirConf?'✓ they confirmed':'…waiting on them',px+TR_W/2,py+H-4);ctx.textAlign='left';
}
function handleTradeClick(e){
  const tr=G.trade; if(!tr)return true; const rects=ptradeRects();
  const hit=b=>e.clientX>=b.x&&e.clientX<=b.x+b.w&&e.clientY>=b.y&&e.clientY<=b.y+b.h;
  for(let i=0;i<PT_ITEMS.length;i++){ const r=rects.rows[i];
    if(hit(r.minus)){ tradeAdj(PT_ITEMS[i],-1); return true; }
    if(hit(r.plus)){ tradeAdj(PT_ITEMS[i],+1); return true; }
  }
  if(hit(rects.confirm)){ tr.myConf=true; netTradeConfirm(); return true; }
  if(hit(rects.cancel)){ netTradeCancel(); closeTrade(false); return false; }
  return true;
}

function renderTradeInvite(){
  const inv2=G.tradeInvite; if(!inv2)return;
  if(performance.now()-inv2.t>20000){ G.tradeInvite=null; return; }   // invite expires
  const ctx=G.ctx, W=280,H=90, px=Math.round(G.canvas.width/2-W/2), py=Math.round(G.canvas.height*0.3);
  ctx.fillStyle='rgba(14,12,20,.97)';ctx.fillRect(px,py,W,H);ctx.strokeStyle='#9a80d0';ctx.lineWidth=2;ctx.strokeRect(px,py,W,H);
  ctx.fillStyle='#c0a8f0';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillText('🤝 '+inv2.name+' wants to trade',px+W/2,py+26);ctx.textAlign='left';
  inv2._acc={x:px+16,y:py+46,w:W/2-24,h:28}; inv2._dec={x:px+W/2+8,y:py+46,w:W/2-24,h:28};
  ctx.fillStyle='rgba(40,120,55,.95)';ctx.fillRect(inv2._acc.x,inv2._acc.y,inv2._acc.w,inv2._acc.h);
  ctx.fillStyle='#eaffea';ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('ACCEPT',inv2._acc.x+inv2._acc.w/2,inv2._acc.y+18);
  ctx.fillStyle='rgba(120,40,40,.9)';ctx.fillRect(inv2._dec.x,inv2._dec.y,inv2._dec.w,inv2._dec.h);
  ctx.fillStyle='#fdd';ctx.fillText('DECLINE',inv2._dec.x+inv2._dec.w/2,inv2._dec.y+18);ctx.textAlign='left';
}
function handleTradeInviteClick(e){
  const inv2=G.tradeInvite; if(!inv2||!inv2._acc)return false;
  const hit=b=>e.clientX>=b.x&&e.clientX<=b.x+b.w&&e.clientY>=b.y&&e.clientY<=b.y+b.h;
  if(hit(inv2._acc)){ netTradeAccept(inv2.from); G.tradeInvite=null; return true; }
  if(hit(inv2._dec)){ G.tradeInvite=null; return true; }
  return false;
}
// click a nearby remote player (not on a panel) to request a trade
function tryStartTradeAt(wx,wy){
  if(net.status!=='online'||G.trade)return false;
  for(const [id,st] of net.remotes){ if(st.dead)continue;
    if(Math.hypot(st.x-wx,st.y-wy)<TILE&&Math.hypot(st.x-player.x,st.y-player.y)<TILE*5){
      netTradeReq(id); addFloater(st.x,st.y-40,'🤝 trade request sent'); return true; }
  }
  return false;
}

function renderHousePlacementOverlay() {
  const ctx = G.ctx;
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(G.canvas.width/2-200, 8, 400, 28);
  ctx.fillStyle = '#f0d060';
  ctx.font = '13px ui-monospace,Menlo,Consolas,monospace';
  ctx.textAlign = 'center';
  ctx.fillText('HOUSING — Place 9x9 House  ·  ESC cancel', G.canvas.width/2, 27);
  ctx.textAlign = 'left';
  
  if (mouse.hasPos) {
    const w = screenToWorld(mouse.sx, mouse.sy);
    const tx = Math.floor(w.x/TILE);
    const ty = Math.floor(w.y/TILE);
    const size = G.placingHouse.size;
    const offset = Math.floor(size / 2);
    const x0 = tx - offset;
    const y0 = ty - offset;
    
    const valid = canPlaceHouseAt(x0, y0, size);
    const cx = (x0 + size / 2) * TILE;
    const cy = (y0 + size / 2) * TILE;
    
    buildHighlight.position.set(cx, 1.2, cy);
    buildHighlight.scale.set(size, 1, size);
    buildHighlight.material.color.setHex(valid ? 0x50d250 : 0xd23030);
    buildHighlight.material.opacity = valid ? 0.38 : 0.22;
    buildHighlight.visible = true;
  } else {
    buildHighlight.visible = false;
  }
}

// ── Update ────────────────────────────────────────────────────────
function update(dt){
  const rotSpeed = 1.8;
  // [ and ] deliberately do NOT rotate: they cycle the camera presets in the
  // keydown handler, and having them do both meant every preset change also spun
  // the view for as long as the key was held. Rotation stays on , / . (and their
  // shifted < / > so it works without releasing shift).
  if (keys['<'] || keys[',']) camAngle -= rotSpeed * dt;
  if (keys['>'] || keys['.']) camAngle += rotSpeed * dt;
  camAngle = (camAngle + Math.PI * 2) % (Math.PI * 2);

  if(G.editorOpen){editorUpdate(dt);return;}   // world paused while editing
  if(player.weapon !== 'house_tool'){
    if(G.housePlacementMode || G.houseMenuOpen){
      if(G.housePlacementMode && G.prePlacementPos){
        player.x=G.prePlacementPos.x;player.y=G.prePlacementPos.y;
      }
      G.housePlacementMode=false;G.houseMenuOpen=false;buildHighlight.visible=false;buildHighlight.scale.setScalar(1);
    }
  }
  updateWorldMouse();
  if(G.houseSettingsOpen && G.activeHouseIndex !== -1){
    const h=G.placedHouses[G.activeHouseIndex];
    if(h){
      const tx_door=h.x0+Math.floor(h.size/2),ty_door=h.y0+h.size-1;
      const sx=(tx_door+1)*TILE+TILE/2,sy=ty_door*TILE+TILE/2;
      if(Math.hypot(sx-player.x,sy-player.y)>TILE*3.5)G.houseSettingsOpen=false;
    }
  }
  G.gameTime=worldNow();      // shared world clock, not a per-session counter
  // Set-based respawn check: only iterate tiles that are actually pending
  for(const key of pendingRespawns){
    const [x,y]=key.split(',').map(Number);
    const r=respawnAt[y][x]; if(!r){pendingRespawns.delete(key);continue;}
    if(G.gameTime<r.time)continue;
    if(Math.hypot(x*TILE+TILE/2-player.x,y*TILE+TILE/2-player.y)<player.r+TILE/2)continue;
    map[y][x]=r.tile;resourceHp[y][x]=r.hp;respawnAt[y][x]=null;
    pendingRespawns.delete(key);
    bakeStaticTile(x,y);minimapUpdateTile(x,y);
  }
  G.enemyRespawnClock+=dt;
  // local wolf/bandit population manager — offline only (online they're server mobs)
  if(net.status!=='online'&&G.enemyRespawnClock>=ENEMY_POP_CHECK_INTERVAL){G.enemyRespawnClock=0;let aliveWolves=0,aliveBandits=0;for(const e of enemies){if(e.state==='dead'||e.state==='respawning')continue;if(e.type==='wolf')aliveWolves++;else if(e.type==='bandit')aliveBandits++;}const wolfShort=WOLF_TARGET-aliveWolves,banditShort=BANDIT_TARGET-aliveBandits;if(wolfShort>0){spawnRandomEnemy('wolf',CITY);if(wolfShort>5)spawnRandomEnemy('wolf',CITY);}if(banditShort>0){spawnRandomEnemy('bandit',CITY);if(banditShort>3)spawnRandomEnemy('bandit',CITY);}}
  if(player.ghost){
    let dx=0,dy=0;if(keys['w']||keys['arrowup'])dy-=1;if(keys['s']||keys['arrowdown'])dy+=1;if(keys['a']||keys['arrowleft'])dx-=1;if(keys['d']||keys['arrowright'])dx+=1;
    const tv=touchVec();dx+=tv.x;dy+=tv.y;   // ghosts need the mobile joystick too — otherwise phones can never walk to a healer to be rez'd
    if (camAngle !== 0) {
      const rx = dx * Math.cos(camAngle) + dy * Math.sin(camAngle);
      const ry = dy * Math.cos(camAngle) - dx * Math.sin(camAngle);
      dx = rx; dy = ry;
    }
    if(rmb.down&&mouse.hasPos){const rdx=worldMouseX-player.x,rdy=worldMouseY-player.y,rDist=Math.hypot(rdx,rdy);if(rDist>4){dx+=rdx/rDist;dy+=rdy/rDist;}}
    const ml=Math.hypot(dx,dy);if(ml>1){dx/=ml;dy/=ml;}
    const step=player.speed*0.6*dt;
    // A ghost passes through everything, and this is not a flourish — it is the
    // fix for being permanently stuck.
    //
    // This used to run the same boxBlocked test the living player does, but
    // WITHOUT the WADE override the living path wraps around its own call. So
    // water was solid to a ghost: die in a river and you were already inside
    // the obstacle, every candidate position failed, and there was no way out
    // at all. The identical trap caught anyone who died with their collision
    // box overlapping a tree, a wall or a boulder.
    //
    // A ghost is incorporeal and its whole job is to reach a healer. Collision
    // has nothing to offer here except the chance to strand someone, so the
    // only limit left is the edge of the map.
    const gx=player.x+dx*step, gy=player.y+dy*step;
    player.x=Math.max(TILE*0.5, Math.min((MAP_W-0.5)*TILE, gx));
    player.y=Math.max(TILE*0.5, Math.min((MAP_H-0.5)*TILE, gy));
  }
  if(!player.dead){
    let dx=0,dy=0;if(keys['w']||keys['arrowup'])dy-=1;if(keys['s']||keys['arrowdown'])dy+=1;if(keys['a']||keys['arrowleft'])dx-=1;if(keys['d']||keys['arrowright'])dx+=1;
    const tv=touchVec();dx+=tv.x;dy+=tv.y;
    if (camAngle !== 0) {
      const rx = dx * Math.cos(camAngle) + dy * Math.sin(camAngle);
      const ry = dy * Math.cos(camAngle) - dx * Math.sin(camAngle);
      dx = rx; dy = ry;
    }
    let speedMult=1;
    if(touchSprinting()||keyboardRunning())speedMult=SPRINT_MULT;
    // ONE authoritative answer to "is this character running right now", for
    // hiding and stealth to read later rather than each re-deriving it from
    // keys, the touch stick and the always-run preference separately — three
    // copies of that test would eventually disagree, and a stealth system that
    // disagrees with the movement system is the worst kind of bug to chase.
    //
    // It means ACTUALLY running: run mode engaged AND the character moving. Hold
    // forward against a wall and the latch is still set, but you are not running
    // and nothing should hear you as though you were.
    player.running = speedMult===SPRINT_MULT && (dx!==0 || dy!==0);
    if(rmb.down&&!G.craftOpen&&!G.buildMode&&mouse.hasPos){const rdx=worldMouseX-player.x,rdy=worldMouseY-player.y,rDist=Math.hypot(rdx,rdy);if(rDist>4){const td=rDist/TILE;const rm=td<1.5?0.5:td<3?1.0:1.4;dx+=rdx/rDist;dy+=rdy/rDist;speedMult=rm;}}
    if(player.stunTimer>0){player.stunTimer=Math.max(0,player.stunTimer-dt);return;}
    if(player.webTimer>0)player.webTimer=Math.max(0,player.webTimer-dt);
    if(player.charmTimer>0){player.charmTimer=Math.max(0,player.charmTimer-dt);if(player.charmTimer<=0)player.charmed=false;}
    if(player.poisonTimer>0){player.poisonTimer=Math.max(0,player.poisonTimer-dt);player.poisonTick+=dt;if(player.poisonTick>=1){player.poisonTick-=1;damagePlayer(player.poisonDmg);addFloater(player.x,player.y-18,'☠ '+player.poisonDmg);}}
    if(player.charmed){dx=-dx;dy=-dy;}
    const _curTileH=map[Math.floor(player.y/TILE)]?.[Math.floor(player.x/TILE)];
    if(player.onHorse&&(_curTileH===T.CAVE_FLOOR||_curTileH===T.CAVE_ENTRANCE||_curTileH===T.CAVE_WALL)){player.onHorse=false;addFloater(player.x,player.y-30,'dismounted (cave)');}
    if(player.onHorse)speedMult*=2.2;if(player.isRat)speedMult*=0.55;
    if(G.housePlacementMode)speedMult*=1.8;
    const ml=Math.hypot(dx,dy);if(ml>1){dx/=ml;dy/=ml;}
    if(skills.hiding.active){
      if(hidingLv()>=2){
        speedMult*=0.45;
        const unstealthSpeedMult=player.onHorse?2.2:(rmb.down?1.4:1.0);
        if(unstealthSpeedMult>1.05&&ml>0.1){
          skills.hiding.active=false;
          skills.hiding.cooldown=30;
          addFloater(player.x,player.y-30,'stealth broken (running)');
        }
      } else if(ml>0.05){
        skills.hiding.active=false;
        skills.hiding.cooldown=30;
        addFloater(player.x,player.y-30,'stealth broken (moved)');
      }
    }
    const webMult=player.webTimer>0?0.35:1;
    // ── Wading ──
    // Depth is the gap between the water surface and the carved bed, so it
    // comes from the same height field everything else samples. Shallows barely
    // slow you; mid-river is a hard slog. Deliberately punishing — a river
    // should be a decision, not a shortcut.
    const wDepth = waterDepthAt(player.x, player.y);
    const wadeMult = wDepth <= 0 ? 1
                   : wDepth < WADE_KNEE ? 0.72
                   : wDepth < WADE_HEAD ? 0.42
                   : 0.30;
    const step=player.speed*speedMult*webMult*wadeMult*dt;const nx=player.x+dx*step;const ny=player.y+dy*step;
    if(G.housePlacementMode){player.x=nx;player.y=ny;}
    else{
      // Water is passable for the PLAYER only. boxBlocked still reports it as
      // solid for everything else, so mobs keep their banks and won't chase you
      // into the river — and the server's mob walkability bitmap agrees, since
      // it is a separate copy that we have not touched.
      // Water has to be non-blocking for the DURATION of the player's own
      // collision test, not judged from the centre tile afterwards.
      // boxBlocked samples a box of radius r: walking toward a bank, that box
      // overlaps water while the centre is still on grass, so a centre-tile
      // test rejects the move and the player can never actually enter the
      // river — they stick to the edge. Flipping the shared BLOCKING entry for
      // these two calls is synchronous and restored immediately, so mobs (and
      // everything else that calls boxBlocked) still treat water as solid.
      const _wasWade = WADE.on;
      WADE.on = true;
      try {
        if(!boxBlocked(nx,player.y,player.r)&&!doorBlocks(nx,player.y,player.r))player.x=nx;
        if(!boxBlocked(player.x,ny,player.r)&&!doorBlocks(player.x,ny,player.r))player.y=ny;
      } finally {
        WADE.on = _wasWade;
      }
    }
    // ── Drowning ──
    // Above WADE_HEAD the character's head is under. Damage lands on a fixed
    // tick so the player gets a readable countdown rather than a slow bleed,
    // and DROWN_TICKS of them is fatal.
    if(wDepth >= WADE_HEAD && !player.dead){
      player.drownT = (player.drownT||0) + dt;
      if(player.drownT >= DROWN_TICK_SEC){
        player.drownT -= DROWN_TICK_SEC;
        player.drownTicks = (player.drownTicks||0) + 1;
        const left = DROWN_TICKS - player.drownTicks;
        if(player.drownTicks >= DROWN_TICKS){
          damagePlayer(player.hp + 1000);          // out of air
          addFloater(player.x, player.y-40, 'drowned!');
        } else {
          damagePlayer(Math.max(1, Math.round(player.maxHp * DROWN_FRAC)));
          addFloater(player.x, player.y-40, 'drowning! '+left);
          snd.hit && snd.hit();
        }
      }
    } else if(player.drownTicks || player.drownT){
      // Surfacing resets immediately — you get your breath back.
      player.drownT = 0; player.drownTicks = 0;
    }
    if(G.corpse && !player.dead && !player.ghost){
      if(Math.hypot(G.corpse.x - player.x, G.corpse.y - player.y) < TILE * 1.0){
        takeAllCorpse();
      }
    }
    if(ml>0.1&&!G.housePlacementMode){G._stepAcc+=step*ml;if(G._stepAcc>=52){G._stepAcc=0;snd.step();}}
    const _curTile=map[Math.floor(player.y/TILE)]?.[Math.floor(player.x/TILE)];const _inCave=_curTile===T.CAVE_FLOOR||_curTile===T.CAVE_ENTRANCE;const _wasCave=G._lastTileType===T.CAVE_FLOOR||G._lastTileType===T.CAVE_ENTRANCE;if(_inCave!==_wasCave)snd.cave();G._lastTileType=_curTile;
    if(G.swingTimer>0)G.swingTimer=Math.max(0,G.swingTimer-dt);if(G.bowCooldown>0)G.bowCooldown=Math.max(0,G.bowCooldown-dt);if(player.iframes>0)player.iframes-=dt;
    if(player.ratTimer>0){player.ratTimer=Math.max(0,player.ratTimer-dt);if(player.ratTimer<=0){player.isRat=false;addFloater(player.x,player.y-30,'restored to human form!');}}
    if(player.hp<player.maxHp&&nearbyObject('campfire',2))player.hp=Math.min(player.maxHp,player.hp+2*dt);
    if(player.bandageTimer>0){const healPerSec=HEAL_AMT[healingLv()-1]/3;player.hp=Math.min(player.maxHp,player.hp+healPerSec*dt);player.bandageTimer=Math.max(0,player.bandageTimer-dt);}
    const hsk=skills.hiding;if(hsk.active){hsk.timer=Math.max(0,hsk.timer-dt);addSkillXp(skills.hiding,5*dt);if(hsk.timer<=0){hsk.active=false;hsk.cooldown=30;addFloater(player.x,player.y-30,'visible again');}}if(hsk.cooldown>0)hsk.cooldown=Math.max(0,hsk.cooldown-dt);
    if(hsk.shadowstepCd>0)hsk.shadowstepCd=Math.max(0,hsk.shadowstepCd-dt);
    if(player.deathWardCd>0)player.deathWardCd=Math.max(0,player.deathWardCd-dt);
    if(skills.wrestling.cooldown>0)skills.wrestling.cooldown=Math.max(0,skills.wrestling.cooldown-dt);
    if(bank.gold>0){bank.interestAccum+=bank.gold*(0.01/60)*dt;if(bank.interestAccum>=1){const g=Math.floor(bank.interestAccum);bank.gold+=g;bank.interestAccum-=g;}}
    if(player.hp<player.maxHp&&!player.dead){const fireBonus=nearbyObject('campfire',2)?2:1;player.hp=Math.min(player.maxHp,player.hp+0.5*fireBonus*dt);}
    for(const wh of WORLD_HEALERS){if(!wh.healTimer)wh.healTimer=6;if(Math.hypot(wh.x-player.x,wh.y-player.y)<TILE*3.5){wh.healTimer-=dt;if(wh.healTimer<=0){wh.healTimer=8;if(!player.dead&&!player.ghost&&player.hp<player.maxHp){const amt=Math.min(player.maxHp-player.hp,12);player.hp+=amt;snd.heal();addFloater(wh.x,wh.y-34,'✨ +'+amt);}}}}
    if(!uiBlocking()&&!modalOpen()){if(mouse.down)doAttack(worldMouseX,worldMouseY,mouse.sx,mouse.sy);if(action.active){const aw=screenToWorld(action.sx,action.sy);doAttack(aw.x,aw.y,action.sx,action.sy);}}
  }
  // ⚠ AN UPPER BOUND, NOT JUST A LOWER ONE. This was `player.y >= DUNGEON_Y0*TILE`
  // alone, which was correct while the dungeon band was the last thing on the
  // map. The Saltmere coast sits BELOW it, so without the second half of this
  // test the whole beach counts as dungeon: cave ambience, cave music, the
  // dungeon floor readout and anything else gated on G.inDungeon, in daylight
  // on a beach.
  G.inDungeon = player.y >= DUNGEON_Y0*TILE && player.y < TERRAIN_MAP_H*TILE;
  if(G.inDungeon){ const f=floorAt(Math.floor(player.x/TILE),Math.floor(player.y/TILE)); if(f)G.dungeonFloor=f.n; }
  else G.dungeonFloor=0;
  // First arrival on the coast pays for its ground; every later frame is a
  // pointer compare.
  G.onCoast = player.y >= COAST_Y0*TILE;
  if(G.onCoast && !coastSurface) ensureCoastSurface();
  if(G.portalCooldown<=0){
    const ptx=Math.floor(player.x/TILE), pty=Math.floor(player.y/TILE);
    if(ptx>=0&&pty>=0&&ptx<MAP_W&&pty<MAP_H&&map[pty][ptx]===T.TELEPORT){
      const stair=DUNGEON_STAIRS[ptx+','+pty];
      if(!G.inDungeon){                                   // overworld → floor 1
        G.dungeonEntryX=player.x; G.dungeonEntryY=player.y;
        player.x=DUNGEON_ENTRY_TILE.x*TILE+TILE/2; player.y=DUNGEON_ENTRY_TILE.y*TILE+TILE/2;
        G.inDungeon=true; enterFloor(1);
      } else if(stair){                                   // floor ↔ floor
        player.x=stair.sx*TILE+TILE/2; player.y=stair.sy*TILE+TILE/2;
        enterFloor(stair.to);
      } else {                                            // floor 1's original exits
        const relX=ptx-DUNGEON_X0;
        if(relX<DUNGEON_W/2){
          player.x=G.dungeonEntryX||(DUNGEON_PORTAL_A.x*TILE+TILE/2);
          player.y=G.dungeonEntryY||(DUNGEON_PORTAL_A.y*TILE+TILE/2);
          addFloater(player.x,player.y-30,'back above ground!');
        } else {
          player.x=305*TILE+TILE/2; player.y=351*TILE+TILE/2;
          addFloater(player.x,player.y-30,'arrived at the city!');
        }
        G.inDungeon=false; G.dungeonFloor=0; snd.cave();
      }
      G.portalCooldown=1.2; netTp('portal');
    }
  }
  if(G.portalCooldown>0)G.portalCooldown=Math.max(0,G.portalCooldown-dt);
  questPoll();
  G.camX=player.x-G.canvas.width/2;G.camY=player.y-G.canvas.height/2;
  G.camX=Math.max(0,Math.min(G.camX,MAP_W*TILE-G.canvas.width));G.camY=Math.max(0,Math.min(G.camY,MAP_H*TILE-G.canvas.height));
  if(MAP_W*TILE<G.canvas.width)G.camX=(MAP_W*TILE-G.canvas.width)/2;if(MAP_H*TILE<G.canvas.height)G.camY=(MAP_H*TILE-G.canvas.height)/2;
  if(swordSwing.active){swordSwing.lifetime-=dt;if(swordSwing.lifetime<=0)swordSwing.active=false;}
  if(specialCd>0)specialCd=Math.max(0,specialCd-dt);
  runGambits(dt);
  runMacroQueue(dt);
  if(G.gambitFlash&&G.gambitFlash.t>0)G.gambitFlash.t-=dt;
  // Combat stance:
  //   AGGRO MODE (X) — war mode: attack ANY living enemy in reach
  //   auto-defend (V) — only counter mobs already attacking you
  // Melee auto-draws the sword when engaging while holding a tool.
  const stance=G.aggroMode?2:(G.autoDefend!==false?1:0);
  if(stance&&!player.dead&&!player.ghost&&!player.isRat&&!skills.hiding.active&&!G.buildMode&&!G.craftOpen&&!G.housePlacementMode){
    let tgt=null,best=1e9;
    for(const e of enemies){
      if(e.state==='dead'||e.state==='respawning')continue;
      if(stance===1&&e.state!=='aggro')continue;
      const d=Math.hypot(e.x-player.x,e.y-player.y);
      if(d<best){best=d;tgt=e;}
    }
    if(tgt){
      if(player.weapon==='bow'&&player.hasBow){
        if(best<=TILE*8&&G.bowCooldown<=0&&inv.arrows>0)fireArrow(tgt.x,tgt.y);
      }else if(best<=SWORD_RANGE*0.95&&player.hasSword&&G.swingTimer<=0){
        if(player.weapon!=='sword'){player.weapon='sword';addFloater(player.x,player.y-30,'⚔ '+(stance===2?'aggro!':'auto-defend!'));}
        swordSwingAttack(tgt.x,tgt.y);
      }
    }
  }
  for(let i=projectiles.length-1;i>=0;i--){const a=projectiles[i],spd=Math.hypot(a.vx,a.vy);a.x+=a.vx*dt;a.y+=a.vy*dt;a.dist+=spd*dt;const at=tileAt(a.x,a.y);let hit=(at===T.TREE||at===T.STONE||at===T.WALL);if(!hit)for(const e of enemies){if(e.state==='dead'||e.state==='respawning')continue;if(Math.hypot(a.x-e.x,a.y-e.y)<e.r+6){damageEnemy(e,a.dmg||15);addSkillXp(skills.archery,10);if(a.pierce>0&&!(a.hitIds&&a.hitIds.has(e))){a.pierce--;(a.hitIds??=new Set()).add(e);}else hit=true;break;}}
    if(!hit)for(const [rid,st] of net.remotes){ // PvP: arrow strikes another player (server referees)
      if(st.dead||st.ghost||st.hidden)continue;
      if(Math.hypot(a.x-st.x,a.y-st.y)<19){netPvp(rid,'bow');hit=true;break;}}
    if(hit||a.dist>(a.maxDist||TILE*14))projectiles.splice(i,1);}
  syncServerMobs(dt);   // server-authoritative mobs mirror into `enemies`
  for(const e of enemies){ if(!e.srv) updateEnemy(e,dt); } champSpawnTick(dt);
  sweepBurnouts(dt);
  for(let i=eProjList.length-1;i>=0;i--){const p=eProjList[i];p.life-=dt;if(p.life<=0){eProjList.splice(i,1);continue;}p.x+=p.vx*dt;p.y+=p.vy*dt;if(boxBlocked(p.x,p.y,p.r)){eProjList.splice(i,1);continue;}if(!player.dead&&Math.hypot(p.x-player.x,p.y-player.y)<player.r+p.r){damagePlayer(p.dmg);eProjList.splice(i,1);}}
  if(G.guardCallCooldown>0)G.guardCallCooldown=Math.max(0,G.guardCallCooldown-dt);
  for(let i=guards.length-1;i>=0;i--){updateGuard(guards[i],dt);if(guards[i].dead)guards.splice(i,1);}
  for(let i=drops.length-1;i>=0;i--){const d=drops[i];
    if(d.srvId){ // server-brokered shared drop: pickup goes through the server (it decides who gets it)
      if(!player.dead&&!d.taking&&Math.hypot(d.x-player.x,d.y-player.y)<player.r+16){ d.taking=true; netDropTake(d.srvId); }
      continue; }
    d.lifetime-=dt;if(d.lifetime<=0){drops.splice(i,1);continue;}
    if(!player.dead&&Math.hypot(d.x-player.x,d.y-player.y)<player.r+12){
      if(d.type==='arpg_item'&&d.item){        // ARPG instance → equipment bag, not a stack
        player.equipmentItems.push(d.item);
        addFloater(player.x,player.y-24,d.item.rarityName+': '+d.item.name+'  [G]');
      } else { invAdd(d.type,1); addFloater(player.x,player.y-24,'+1 '+itemLabel(d.type)); }
      snd.pickup();drops.splice(i,1);
    }}
  for(let i=floaters.length-1;i>=0;i--){const f=floaters[i];f.life-=dt;f.y-=26*dt;if(f.life<=0)floaters.splice(i,1);}
  for(const k in hitFlash){hitFlash[k]-=dt;if(hitFlash[k]<=0)delete hitFlash[k];}
  updateFallingTrees(dt);
}

// ── Render helpers ─────────────────────────────────────────────────
function drawPlayerHpBar(){
  const ctx=G.ctx,BAR_W=200,BAR_H=16,BAR_X=Math.round(G.canvas.width/2-BAR_W/2),BAR_Y=G.canvas.height-44;
  const frac=Math.max(0,Math.min(1,player.hp/player.maxHp));
  ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(BAR_X-2,BAR_Y-2,BAR_W+4,BAR_H+4);
  const hcol=frac>0.5?'#60d040':frac>0.25?'#d0c030':'#d04020';
  ctx.fillStyle=hcol;ctx.fillRect(BAR_X,BAR_Y,Math.round(BAR_W*frac),BAR_H);
  ctx.strokeStyle='rgba(255,255,255,.25)';ctx.lineWidth=1;ctx.strokeRect(BAR_X,BAR_Y,BAR_W,BAR_H);
  ctx.fillStyle='#fff';ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText(Math.ceil(player.hp)+'/'+player.maxHp+' HP',BAR_X+BAR_W/2,BAR_Y+BAR_H-3);ctx.textAlign='left';
  // aggro-mode stance button (X or click) — red when hot
  if(!player.dead){
    const ax=BAR_X-80;
    aggroBtnRect={x:ax,y:BAR_Y-2,w:70,h:BAR_H+4};
    ctx.fillStyle=G.aggroMode?'rgba(190,45,30,.92)':'rgba(40,34,22,.85)';
    ctx.fillRect(ax,BAR_Y-2,70,BAR_H+4);
    ctx.strokeStyle=G.aggroMode?'#ff8060':'rgba(200,162,90,.4)';ctx.lineWidth=1;ctx.strokeRect(ax,BAR_Y-2,70,BAR_H+4);
    ctx.fillStyle=G.aggroMode?'#ffe0d0':'rgba(232,220,192,.6)';ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText('⚔ AGGRO',ax+35,BAR_Y+BAR_H-4);ctx.textAlign='left';
  } else aggroBtnRect=null;
  // special-attack readiness chip (SPACE), shown once the skill unlocks it
  const hasSpec=(player.weapon==='sword'&&player.hasSword&&tacticsLv()>=2)||(player.weapon==='bow'&&player.hasBow&&archeryLv()>=2);
  if(hasSpec&&!player.dead){
    const sx2=BAR_X+BAR_W+10, ready=specialCd<=0;
    ctx.fillStyle=ready?'rgba(200,162,90,.9)':'rgba(40,34,22,.85)';
    ctx.fillRect(sx2,BAR_Y-2,58,BAR_H+4);
    ctx.strokeStyle=ready?'#ffd97a':'rgba(200,162,90,.4)';ctx.lineWidth=1;ctx.strokeRect(sx2,BAR_Y-2,58,BAR_H+4);
    ctx.fillStyle=ready?'#1a1208':'rgba(232,220,192,.6)';ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
    ctx.fillText(ready?'⚡ SPACE':Math.ceil(specialCd)+'s',sx2+29,BAR_Y+BAR_H-4);ctx.textAlign='left';
  }
}
// Boss HP bar — top-centre of screen while a named floor boss is alive.
// A critical AAA gap: fighting a 1080-HP boss with no HP readout is disorienting.
function drawBossHpBar(){
  const boss=enemies.find(e=>e.floorBoss&&e.state!=='dead'&&e.state!=='respawning');
  if(!boss||!G.inDungeon) return;
  const ctx=G.ctx, W=G.canvas.width;
  const BAR_W=Math.min(440,W-40), BAR_H=18;
  const BX=Math.round(W/2-BAR_W/2), BY=64;
  const frac=Math.max(0,Math.min(1,boss.hp/(boss.maxHp||1)));
  const enraged=frac<=0.25;
  const nameY=BY-5;
  // Boss name + enrage tag
  ctx.font='bold 12px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
  ctx.fillStyle='rgba(0,0,0,.8)';ctx.fillText((boss.bossName||'BOSS')+(enraged?'  ⚠ ENRAGED':''),W/2+1,nameY+1);
  ctx.fillStyle=enraged?'#ff6060':'#f0dca0';ctx.fillText((boss.bossName||'BOSS')+(enraged?'  ⚠ ENRAGED':''),W/2,nameY);
  // Bar background
  ctx.fillStyle='rgba(0,0,0,.70)';ctx.fillRect(BX-2,BY,BAR_W+4,BAR_H+4);
  // HP fill — bright red, darker when drained
  ctx.fillStyle=enraged?'#e83030':'#c04040';
  ctx.fillRect(BX,BY+2,Math.round(BAR_W*frac),BAR_H);
  // HP text
  ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillStyle='rgba(255,255,255,.9)';
  ctx.fillText(Math.ceil(boss.hp)+' / '+boss.maxHp+' HP',W/2,BY+BAR_H-2);
  // Border
  ctx.strokeStyle=enraged?'#ff8060':'rgba(180,60,60,.8)';ctx.lineWidth=1.5;
  ctx.strokeRect(BX,BY+2,BAR_W,BAR_H);
  ctx.textAlign='left';
}
function drawGhostHUD(){
  const ctx=G.ctx,W=G.canvas.width,H=G.canvas.height;
  ctx.fillStyle='rgba(60,0,60,.08)';ctx.fillRect(0,0,W,H);ctx.fillStyle='rgba(200,150,255,.85)';ctx.font='bold 15px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';ctx.fillText('👻 GHOST — find a healer and press E to respawn',W/2,H-70);ctx.textAlign='left';
}
function renderMinimap(){
  const{mx,my,sz}=minimapRect(), ctx=G.ctx;
  ctx.fillStyle='rgba(0,0,0,.78)'; ctx.fillRect(mx-2,my-2,sz+4,sz+4);
  ctx.strokeStyle=G.minimapHover?'#ffe866':'#c8a25a';
  ctx.lineWidth=G.minimapHover?1.5:1; ctx.strokeRect(mx-2,my-2,sz+4,sz+4);

  // View rect centered on player, clamped to the map so scale never distorts.
  const zoom=Math.max(1.0, G.minimapZoom||1.0);
  const vW=MAP_W/zoom, vH=MAP_H/zoom;
  const pcx=player.x/TILE, pcy=player.y/TILE;
  const srcX=Math.max(0,Math.min(MAP_W-vW,pcx-vW/2));
  const srcY=Math.max(0,Math.min(MAP_H-vH,pcy-vH/2));
  ctx.drawImage(miniCanvas,srcX,srcY,vW,vH,mx,my,sz,sz);   // 1 px/tile → tile-unit coords

  // Tile coords → minimap pixel coords
  const sX=sz/vW, sY=sz/vH;
  const toSX=wx=>mx+(wx-srcX)*sX;
  const toSY=wy=>my+(wy-srcY)*sY;
  const inView=(px,py)=>px>=mx&&px<=mx+sz&&py>=my&&py<=my+sz;

  // City boundary
  const csx=toSX(CITY.x1),csy=toSY(CITY.y1);
  if(inView(csx,csy)){
    ctx.strokeStyle='rgba(200,162,90,.7)'; ctx.lineWidth=1;
    ctx.strokeRect(csx,csy,(CITY.x2-CITY.x1)*sX,(CITY.y2-CITY.y1)*sY);
  }

  // Player dot
  ctx.fillStyle='#ffee00'; ctx.beginPath(); ctx.arc(toSX(pcx),toSY(pcy),Math.max(2,sz/80),0,Math.PI*2); ctx.fill();

  // Enemies (cave-dwellers stand out in magenta)
  for(const e of enemies){
    if(e.state==='respawning'||e.state==='dead') continue;
    const ex=toSX(e.x/TILE), ey=toSY(e.y/TILE);
    if(!inView(ex,ey)) continue;
    const cave=e.type==='goblin'||e.type==='troll'||e.type==='spider';
    ctx.fillStyle=cave?'#cc44ff':'#ff3030';
    ctx.fillRect(ex-1,ey-1,2,2);
  }

  // Healer crosses
  const cs=Math.max(2,Math.round(sz/40));
  ctx.fillStyle='#40ff80';
  const drawHDot=(hx,hy)=>{
    const dx=toSX(hx/TILE), dy=toSY(hy/TILE);
    if(!inView(dx,dy)) return;
    ctx.fillRect(dx-1,dy-cs-1,3,cs*2+2); ctx.fillRect(dx-cs-1,dy-1,cs*2+2,3);
  };
  drawHDot(HEALER.x,HEALER.y);
  for(const wh of WORLD_HEALERS) drawHDot(wh.x,wh.y);

  // Hidden-system NPCs — small colored diamonds so players can find them on the map
  const drawNpcDot=(wx,wy,col)=>{
    const dx=toSX(wx/TILE), dy=toSY(wy/TILE);
    if(!inView(dx,dy)) return;
    const r=Math.max(2,Math.round(sz/70));
    ctx.fillStyle=col;
    ctx.beginPath();ctx.moveTo(dx,dy-r);ctx.lineTo(dx+r,dy);ctx.lineTo(dx,dy+r);ctx.lineTo(dx-r,dy);ctx.closePath();ctx.fill();
  };
  drawNpcDot(ANTIQUARIAN.x,   ANTIQUARIAN.y,   '#b070ff');  // purple  — relic shop
  drawNpcDot(CURATOR.x,        CURATOR.y,        '#e0c040');  // gold    — museum
  drawNpcDot(CRYPTOLOGIST.x,   CRYPTOLOGIST.y,  '#40c8e0');  // cyan    — cipher / lore
  drawNpcDot(GRAVE_ROBBER.x,   GRAVE_ROBBER.y,  '#909090');  // gray    — underground dealer

  // Corner resize handle + hints
  ctx.fillStyle='rgba(200,162,90,.75)'; ctx.fillRect(mx+sz-5,my+sz-5,7,7);
  if(G.minimapHover){
    ctx.fillStyle='rgba(255,232,100,.85)'; ctx.font='8px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign='center'; ctx.fillText('scroll=zoom · drag corner=resize',mx+sz/2,my-5); ctx.textAlign='left';
  }
  ctx.fillStyle='rgba(200,162,90,.8)'; ctx.font='9px ui-monospace,Menlo,Consolas,monospace';
  ctx.textAlign='right'; ctx.fillText('[M] map',mx+sz,my-4+(G.minimapHover?8:0)); ctx.textAlign='left';
}

// ── 3D Entity sync ─────────────────────────────────────────────────
let _lastSyncT=0;
const _slotRigCache = [];  // per-pool-slot: {type, hiding} — skip configureRig when unchanged
// ── Render distance + animation-LOD, device- and zoom-aware ──
// Phones get a much tighter bubble; zooming out widens it. Fog tracks the
// edge so culled entities fade out instead of popping.
//
// Shared by mobs (syncEntities) and remote players (syncRemotePlayers) so the
// two can never drift apart — a player and a wolf standing next to each other
// should disappear at the same distance.
function viewRadii(){
  const _mob = (typeof innerWidth==='number'&&innerWidth<600) || G.isTouch;
  const zoomK = Math.max(1, camZoom/(_mob?0.55:0.72));
  // Vision is a player-distance circle → uniform in every direction (~45+
  // tiles). Animation is a smaller radius so skinning cost stays bounded.
  // renderScale is the player's draw-distance preference. It multiplies the
  // vision radius only -- the animation radius is a CPU-cost bound, and letting
  // a slider raise it would trade a frame-rate problem for a worse one.
  const rs  = Math.max(0.5, Math.min(2, prefs.renderScale || 1));
  const RD  = (_mob?1200:2300) * zoomK * rs;   // vision / cull radius (world units)
  const AD  = (_mob?600:1080)  * zoomK;        // animate within this (~12 tiles on mobile)
  return { _mob, RD, AD, RD2: RD*RD, AD2: AD*AD };
}
// Hard ceiling on simultaneously animated remote players. AD alone is not a
// bound: a hundred players in one town square are all inside it, and each one
// costs a full skinned-mesh update. The nearest few are the only ones whose
// limbs you can actually read.
const MAX_ANIMATED_REMOTES = 20;

function syncEntities(t){
  const adt=Math.min(Math.max(t-_lastSyncT,0),0.1); _lastSyncT=t;
  const isHiding = skills.hiding.active;
  const { _mob, RD, AD, RD2, AD2 } = viewRadii();
  const NPC_LOOK2 = (TILE*6)*(TILE*6);
  // Fog fades by camera distance, so push it *past* the far (north) edge of
  // vision — then it never fades anything on-screen, only the far background.
  const _camFar = Math.hypot(Math.cos(camPitch)*CAM_R*camZoom + RD, Math.sin(camPitch)*CAM_R*camZoom);
  scene.fog.near = _camFar*1.05; scene.fog.far = _camFar*2.0;
  let ei=0;
  for(const e of enemies){
    if(ei>=enemyPool.length)break;const si=ei,grp=enemyPool[ei++];
    const inst=slotModel[si];
    if(e.state==='dead'||e.state==='respawning'){grp.visible=false;if(inst)inst.obj.visible=false;continue;}
    const edx=e.x-player.x, edz=e.y-player.y, ed2=edx*edx+edz*edz;
    if(ed2>RD2){ grp.visible=false; if(inst)inst.obj.visible=false; continue; }   // render-distance cull
    const eNear = ed2<AD2;                                                        // animation-LOD gate
    // Prefer the animated GLTF model once its file has loaded
    const mm=MOB_MODELS[e.type];
    if(SKINNING_OK&&mm&&loadedModels[mm.file]){
      grp.visible=false;
      const im=(inst&&inst.type===e.type)?inst:buildSlotModel(si,e.type);
      animModel(im,e,t,adt,eNear);
      continue;
    }
    if(inst)inst.obj.visible=false;
    grp.visible=true;grp.position.set(e.x,heightAt(e.x,e.y),e.y);
    // Only reconfigure rig when enemy type or hiding state changes for this slot
    const cache=_slotRigCache[si];
    if(!cache||cache.type!==e.type||cache.hiding!==isHiding){
      const vis=EVIS[e.type]||EVIS_DEF,col=isHiding?0x888888:vis[0];
      // A hiding mob is a grey silhouette on purpose, so it gets no outfit and
      // no skin tone — dressing it would hand back the detail the grey removes.
      const est=isHiding?null:(ESTYLE[e.type]||null);
      const esk=(est&&RIG_STYLES[est]&&typeof RIG_STYLES[est].skin==='number')?RIG_STYLES[est].skin:false;
      configureRig(grp, col, vis[1],vis[2],vis[3],vis[4],vis[5]||0, esk);
      dressRig(grp, est);
      applyProp(grp, PROP[e.type]||null, vis[1],vis[2],vis[3]);
      _slotRigCache[si]={type:e.type,hiding:isHiding};
    }
    // walk cycle + attack swing; turns toward movement, faces player when idle
    if(eNear){
      const af=e.attackCooldown-e.attackTimer;
      animateRig(grp, e.x, e.y, t,
        {turn:true, faceX:player.x, faceZ:player.y, attack:(af>=0&&af<0.28)?1-af/0.28:0});
    }
  }
  for(let i=ei;i<enemyPool.length;i++){enemyPool[i].visible=false;const m=slotModel[i];if(m)m.obj.visible=false;_slotRigCache[i]=null;}
  const useProtag=SKINNING_OK&&protag&&!player.dead&&!player.ghost&&!player.isRat&&!G.housePlacementMode;
  if(useProtag){
    const P=protag;
    plrGrp.visible=false;
    // Hidden, not skipped, in first person. `useProtag` stays true so the
    // mixer keeps advancing, held props keep refreshing and the attack cues
    // still fire — stepping back out of first person must not reveal a
    // character frozen in whatever pose they were in when you entered.
    // (plrGrp is the OTHER avatar: a fallback primitive rig used when the GLB
    // is not available. Both have to be hidden, which is why the first attempt
    // at this only half worked and you ended up inside the model's head.)
    P.obj.visible=!camMode().fp;
    P.obj.position.set(player.x,heightAt(player.x,player.y),player.y);
    const pdx=player.x-(P.lx??player.x), pdz=player.y-(P.lz??player.y);
    P.lx=player.x; P.lz=player.y;
    const pdist=Math.hypot(pdx,pdz), moving=pdist>0.3&&pdist<TILE*3;
    // face where you're moving (works on mobile/keyboard); when idle,
    // face the cursor if aiming with a mouse. Smoothly turned.
    let faceTgt=null;
    if(moving) faceTgt=Math.atan2(-pdx,-pdz);
    else if(mouse.hasPos&&!G.isTouch) faceTgt=Math.atan2(-(worldMouseX-player.x),-(worldMouseY-player.y));
    // Kept deliberately snappier than a mob — this one answers the cursor — but
    // it is bounded and frame-rate independent now, so a 144Hz machine and a
    // 30Hz one turn the character at the same speed.
    if(faceTgt!==null) turnToward(P.obj, faceTgt, adt, 'player');
    // one-shot cues: revival, specials, weapon swings, tool chopping & mining
    if(P.wasGhost)protagOnce('arise',t);
    else if(protagSkillCue){protagOnce(protagSkillCue===1?'skill1':'skill2',t);protagSkillCue=0;}
    else if(swordSwing.active&&t>=P.busyUntil)protagOnce('attack',t);
    else if(G.bowCooldown>(P.lastBowCd||0)+0.2&&t>=P.busyUntil)protagOnce('attack',t);
    else if(G.swingTimer>(P.lastSwingTimer||0)&&t>=P.busyUntil)protagOnce('attack',t);
    P.lastBowCd=G.bowCooldown;
    P.lastSwingTimer=G.swingTimer;
    if(t>=P.busyUntil)protagPlay(player.onHorse?'idle':(moving?'walk':'idle'));   // mounted = seated pose, never run
    P.mixer.update(adt);
    const pOp=skills.hiding.active?0.35:1;
    // Only traverse the model graph when opacity actually changes
    if(P._lastOp!==pOp){P._lastOp=pOp;P.inner.traverse(o=>{if(o.isMesh)o.material.opacity=pOp;});}
    refreshHeldProp();   // includes torch/lantern (older inline call dropped them)
    P.wasGhost=false;
  } else {
    if(protag){protag.obj.visible=false;protag.wasGhost=player.ghost;}
    plrGrp.position.set(player.x,heightAt(player.x,player.y),player.y);plrGrp.visible=(!player.dead||player.ghost)&&!G.housePlacementMode&&!camMode().fp;
    if(mouse.hasPos) plrGrp.rotation.y = Math.atan2(-(worldMouseX-player.x), -(worldMouseY-player.y));  // face the cursor
    const [pB,pH,pL]=plrGrp.userData.mats;
    if(player.ghost){
      // Spectral: glowing pale blue, weaponless
      pB.color.setHex(0xc8e8ff); pH.color.setHex(0xddeeff); pL.color.setHex(0xb0d8f4);
      pB.emissive.setHex(0x2a4a6a); pH.emissive.setHex(0x2a4a6a); pL.emissive.setHex(0x1c3450);
      plrGrp.children[6].visible=false;
    } else {
      pB.color.setHex(PLR[0]); pH.color.setHex(0xcaa472); pL.color.setHex(PLR[0]).multiplyScalar(0.62);
      pB.emissive.setHex(0x000000); pH.emissive.setHex(0x000000); pL.emissive.setHex(0x000000);
      applyProp(plrGrp, player.weapon==='bow'?'bow':player.weapon==='axe'?'axe':player.weapon==='pickaxe'?'pickaxe':'sword', PLR[1],PLR[2],PLR[3]);
      // iron/steel weapons read visibly in hand
      const pTier=player.weapon==='sword'?(player.swordTier||1):player.weapon==='bow'?(player.bowTier||1):1;
      if(pTier===2)plrGrp.userData.mats[3].color.setHex(0xc8ccd4);
      else if(pTier===3)plrGrp.userData.mats[3].color.setHex(0x9fd0ff);
    }
    const plrOp=player.ghost?0.55:(skills.hiding.active?0.35:1);
    setRigOpacity(plrGrp.userData.mats, plrOp);
    const pAtk=swordSwing.active?Math.max(0,Math.min(1,swordSwing.lifetime/swordSwing.duration)):0;
    animateRig(plrGrp, player.x, player.y, t, {attack:pAtk});
  }
  // Mount: horse under the rider; dismounted, it stands where you left it
  if(horse){
    const riding=player.onHorse&&useProtag;
    const standing=!riding&&player.hasHorse&&player.horseDown&&!player.dead;
    horse.obj.visible=riding||standing;
    if(riding){
      horse.obj.position.set(player.x,heightAt(player.x,player.y),player.y);
      horse.obj.rotation.y=protag.obj.rotation.y;
      horse.mixer.update(adt);
      protag.obj.position.y=horse.rideH;   // rider sits into the saddle
    }else if(standing){
      horse.obj.position.set(player.horseX,0,player.horseY);
      horse.mixer.update(adt*0.35);        // lazy idle sway while it waits
    }
  }
  // Player corpse
  if(G.corpse){corpseGrp.visible=true;corpseGrp.position.set(G.corpse.x,0,G.corpse.y);}
  else corpseGrp.visible=false;
  for(let i=0;i<guardPool.length;i++){const g=guards[i];if(!g||g.dead){guardPool[i].visible=false;continue;}
    const gd2=(g.x-player.x)*(g.x-player.x)+(g.y-player.y)*(g.y-player.y);
    if(gd2>RD2){guardPool[i].visible=false;continue;}
    guardPool[i].visible=true;guardPool[i].position.set(g.x,0,g.y);
    if(gd2<AD2){const gaf=g.attackCooldown-g.attackTimer;animateRig(guardPool[i],g.x,g.y,t,{turn:true,attack:(gaf>=0&&gaf<0.28)?1-gaf/0.28:0});}}
  for(const n of npcs) {
    const nd2=(n.position.x-player.x)*(n.position.x-player.x)+(n.position.z-player.y)*(n.position.z-player.y);
    // Was `continue` alone, which skipped the ANIMATION but left the mesh visible —
    // so every town NPC was still drawn from anywhere on the map. Mobs and guards
    // above both hide at RD; NPCs never did.
    if(nd2>RD2){ n.visible=false; continue; }
    n.visible=true;
    if(nd2<AD2) animateRig(n,n.position.x,n.position.z,t);   // idle breathing
    if(nd2<NPC_LOOK2){                             // face the player only in range
      const tgt = Math.atan2(-(player.x - n.position.x), -(player.y - n.position.z));
      turnToward(n, tgt, adt, 'npc');
    }
  }
  // GLB town NPCs: gentle local wander + look at the player only within range;
  // movement/animation gated by distance so they're free when you're away.
  for(const n of glbNpcs){
    const o=n.obj;
    const pdx=player.x-o.position.x, pdz=player.y-o.position.z, pd2=pdx*pdx+pdz*pdz;
    // Same omission as the rig NPCs above: frozen but still submitted every frame.
    if(pd2>RD2){ o.visible=false; continue; }
    o.visible=true;
    const near = pd2<AD2;
    n.pause-=adt; let moving=false;
    if(n.pause<=0){                                // pick a new spot within the leash of home
      const a=Math.random()*Math.PI*2, r=Math.random()*(TILE*1.5);
      const nx=n.hx+Math.cos(a)*r, nz=n.hz+Math.sin(a)*r;
      if(npcWalkable(nx,nz)){ n.tx=nx; n.tz=nz; }
      n.pause=2+Math.random()*4;
      if(n.idleNames) n.curIdle=n.idleNames[(Math.random()*n.idleNames.length)|0];
    }
    if(n.tx!=null){
      const tdx=n.tx-o.position.x, tdz=n.tz-o.position.z, td=Math.hypot(tdx,tdz);
      if(td>2){ const st=Math.min(td,24*adt); o.position.x+=tdx/td*st; o.position.z+=tdz/td*st; moving=true; }
      else n.tx=null;
    }
    let tgt=Math.PI;                               // rest: south
    if(pd2<NPC_LOOK2) tgt=Math.atan2(-pdx,-pdz);   // look at the player in range
    else if(moving) tgt=Math.atan2(-(n.tx-o.position.x),-(n.tz-o.position.z));
    turnToward(o, tgt, adt, 'npc');
    if(near){ setNpcAnim(n, moving?'walk':(n.curIdle||'idle')); n.mixer.update(adt); }
  }
  for(let i=0;i<arrowPool.length;i++){const a=projectiles[i];if(!a){arrowPool[i].visible=false;continue;}arrowPool[i].visible=true;arrowPool[i].position.set(a.x,heightAt(a.x,a.y)+18,a.y);arrowPool[i].rotation.y=-Math.atan2(a.vy,a.vx);}
  const _lt=performance.now()*0.001;
  for(let i=0;i<dropPool.length;i++){
    const d=drops[i];
    if(!d){dropPool[i].visible=false;lootDropPool[i].visible=false;continue;}
    if(isLootGear(d.type)&&_lootGeo[d.type]){          // gear drop → real 3D model, bobbing + spinning
      dropPool[i].visible=false;
      const h=lootDropPool[i];
      if(h._type!==d.type){
        while(h.children.length)h.remove(h.children[0]);
        const m=new THREE.Mesh(_lootGeo[d.type], _lootMat[d.type]); m.castShadow=true; h.add(m);
        h._type=d.type;
      }
      h.visible=true; h.position.set(d.x, heightAt(d.x,d.y) + 6+Math.sin(_lt*2.2+i)*1.6, d.y); h.rotation.y=_lt*0.9;
    } else {
      lootDropPool[i].visible=false;
      dropPool[i].visible=true;
      if(d.type==='arpg_item'&&d.item){        // rarity-coloured, bobbing so it reads as gear
        dropPool[i].position.set(d.x, heightAt(d.x,d.y) + 10+Math.sin(_lt*3+i)*2.5, d.y);
        dropPool[i].material.color.set(d.item.color||'#ffffff');
      } else {
        dropPool[i].position.set(d.x,heightAt(d.x,d.y)+8,d.y);
        dropPool[i].material.color.setHex(d.type==='gold'?0xf0d020:d.type==='hide'?0x8a6040:d.type==='skull'?0xffffff:d.type==='bone'?0xe8e0d0:d.type==='iron_ore'?0x70584b:d.type==='iron_ingot'?0xbfb0a7:d.type==='steel_ingot'?0xdae2eb:d.type==='ruby'?0xff4444:d.type==='sapphire'?0x44aaff:d.type==='emerald'?0x44ff66:d.type==='diamond'?0xffffff:0x7a7a7a);
      }
    }
  }
  if(!G.buildMode&&!G.editorOpen&&!G.housePlacementMode)buildHighlight.visible=false;
  updateObstacles();
  updateGrass();
  updateEnvironmentCycle(adt);
  netTick(adt); syncRemotePlayers(t,adt); autoSaveTick(adt);   // multiplayer presence + server autosave
  // Orbit camera: camAngle spins around the player, camPitch tilts from
  // ground level (0.06) to straight overhead (1.54) at constant radius.
  // The camera rides the terrain with the player. Without this it holds a fixed
  // world height and buries itself in the first hill you climb.
  const _camGY = heightAt(player.x, player.y);
  if (camMode().fp) {
    // First person: sit in the character's head and look along camAngle.
    // Forward is -(sin, cos) — the direction the orbit camera looks FROM its
    // position TOWARD the player, which is also exactly the direction W already
    // moved you, so view and movement cannot disagree.
    const eye = _camGY + CHAR_H * FP_EYE_FRAC;
    const cp = Math.cos(fpPitch);
    camera.position.set(player.x, eye, player.y);
    camera.lookAt(
      player.x - Math.sin(camAngle) * 1000 * cp,
      eye + Math.sin(fpPitch) * 1000,
      player.y - Math.cos(camAngle) * 1000 * cp
    );
  } else {
    // Orbit: camAngle spins around the player, camPitch tilts from ground level
    // (0.06) to straight overhead (1.54) at constant radius.
    const horiz = Math.cos(camPitch) * CAM_R * camZoom;
    const cx = player.x + Math.sin(camAngle) * horiz;
    const cz = player.y + Math.cos(camAngle) * horiz;
    // Height off the PLAYER's ground — correct on flat ground, and the reason
    // this camera follows you up a hill instead of burying itself in it.
    let camY = _camGY + Math.max(16, Math.sin(camPitch) * CAM_R * camZoom);
    // ...but the camera is not standing where the player is. On a slope the
    // boom end can be tens of units of terrain BELOW the ground it is over, and
    // then the view is from inside the hill, looking up through the underside
    // of the world. Sample the ground along the boom and stay above all of it:
    // the far end matters most, but a crest partway along would block the shot
    // even with both ends clear.
    camY = Math.max(camY, camBoomFloor(cx, cz));
    camera.position.set(cx, camY, cz);
    // At low angles aim at the torso instead of the feet so the view stays level
    camera.lookAt(player.x, _camGY + (camPitch < CAM_PITCH0 ? (1 - camPitch/CAM_PITCH0) * 24 : 0), player.y);
  }
}

// ── 3D Render ──────────────────────────────────────────────────────
function render3D(t){
  // Animated water — scroll the ripple texture so waves drift visibly
  _windU.value = t;                                        // canopy sway (see topMesh.onBeforeCompile)
  _grassMat.uniforms.uTime.value = t;                      // ground cover sway
  _fireU.value = t;                                        // flame curl + flicker
  // Ripples, glint and foam all live in the water shader now, driven off the
  // render clock. Deliberately NOT G.gameTime — that's an epoch value in the
  // 1.7e9 range, and float32 uniforms have nowhere near the precision to
  // animate smoothly that far from zero.
  water.update({ t, sunDir:_sunDir, sunColor:_envSunCol, dayF:_envDayF,
                 envMap:scene.environment, cameraPos:camera.position });
  animatePortals(t);
  animateAltars(t);
  animateArches(t);
  animateHouseProps();
  updateBossTelegraphs();
  syncEntities(t);
  // After update() has placed the camera for this frame — fitting against last
  // frame's camera makes shadow edges lag visibly when you run.
  fitSunShadow();
  const rdt = Math.min(Math.max(t-_lastRenderT, 0), 0.1); _lastRenderT = t;
  if(rndr) rndr.render(rdt); else renderer.render(scene,camera);
  const ctx=G.ctx;ctx.clearRect(0,0,G.canvas.width,G.canvas.height);
  for(const k in panelRects)delete panelRects[k];   // only open panels re-register below
  if(player.ghost){
    ctx.fillStyle='rgba(15,20,35,0.45)';
    ctx.fillRect(0,0,G.canvas.width,G.canvas.height);
  }
  if(stick.active){
    const v=touchVec(), sprinting=touchSprinting();
    // The ring is the only feedback that sprint engaged, so make it unmistakable
    // without being loud: gold and thicker, plus a faint outer ring at the threshold.
    ctx.strokeStyle=sprinting?'rgba(240,208,96,.75)':'rgba(255,255,255,.3)';
    ctx.lineWidth=sprinting?5:3;
    ctx.beginPath();ctx.arc(stick.baseX,stick.baseY,stickMax(),0,Math.PI*2);ctx.stroke();
    if(sprinting){
      ctx.strokeStyle='rgba(240,208,96,.25)';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(stick.baseX,stick.baseY,stickSprint(),0,Math.PI*2);ctx.stroke();
    }
    ctx.fillStyle=sprinting?'rgba(240,208,96,.6)':'rgba(255,255,255,.5)';
    ctx.beginPath();ctx.arc(stick.baseX+v.x*STICK_MAX,stick.baseY+v.y*STICK_MAX,24,0,Math.PI*2);ctx.fill();
  }
  if(G.isTouch){
    for(const b of touchBtns()){
      ctx.fillStyle='rgba(20,15,10,.55)';ctx.beginPath();ctx.arc(b.x,b.y,TB_R,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='rgba(200,162,90,.75)';ctx.lineWidth=2;ctx.beginPath();ctx.arc(b.x,b.y,TB_R,0,Math.PI*2);ctx.stroke();
      ctx.fillStyle='#e8dcc0';ctx.font='bold 17px ui-monospace,Menlo,Consolas,monospace';ctx.textAlign='center';
      ctx.fillText(b.lab,b.x,b.y+6);
    }
    ctx.textAlign='left';
  }
  ctx.textAlign='center';ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';
  for(const f of floaters){const a=Math.max(0,Math.min(1,f.life/0.9));const sc=worldToScreen(f.x,f.y,30);ctx.fillStyle='rgba(0,0,0,'+(a*0.6)+')';ctx.fillText(f.text,sc.x+1,sc.y+1);ctx.fillStyle='rgba(245,225,150,'+a+')';ctx.fillText(f.text,sc.x,sc.y);}
  ctx.textAlign='left';ctx.filter='none';
  // Corpse label — prompt to loot when the (living) player is close
  if(G.corpse){
    const cd=Math.hypot(G.corpse.x-player.x,G.corpse.y-player.y);
    if(cd<TILE*3.2){
      const cs=worldToScreen(G.corpse.x,G.corpse.y,26),near=cd<TILE*2&&!player.ghost;
      ctx.textAlign='center';ctx.font='bold 13px ui-monospace,Menlo,Consolas,monospace';
      const label=near?'[E] Loot corpse':'your corpse';
      ctx.fillStyle='rgba(0,0,0,.6)';ctx.fillText(label,cs.x+1,cs.y+1);
      ctx.fillStyle=near?'rgba(235,120,120,.95)':'rgba(200,180,120,.85)';ctx.fillText(label,cs.x,cs.y);
      ctx.textAlign='left';
    }
  }
  drawInteractPrompts();
  if(rmb.down&&mouse.hasPos&&(!player.dead||player.ghost)){const rdx=worldMouseX-player.x,rdy=worldMouseY-player.y,rDist=Math.hypot(rdx,rdy),td=rDist/TILE;const col=td<1.5?'rgba(100,220,100,.6)':td<3?'rgba(220,200,80,.6)':'rgba(220,100,60,.6)';const ps=worldToScreen(player.x,player.y,20),ms=worldToScreen(worldMouseX,worldMouseY,4);ctx.setLineDash([4,4]);ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(ps.x,ps.y);ctx.lineTo(ms.x,ms.y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=col;ctx.beginPath();ctx.arc(ms.x,ms.y,4,0,Math.PI*2);ctx.fill();}
  drawPlayerHpBar();
  drawBossHpBar();
  drawTimeClock();
  if(!G.editorOpen)drawHotbar();
  drawQuestTracker();
  drawAchievToast();
  if(G.minimapOpen)renderMinimap();
  if(G.buildMode)renderBuildOverlay();
  if(G.housePlacementMode)renderHousePlacementOverlay();
  if(G.houseMenuOpen)renderHousePanel();
  if(G.houseSettingsOpen)renderHouseSettingsPanel();
  if(G.devGuiOpen)renderDevPanel();
  if(G.settingsOpen)renderSettings();
  if(G.craftOpen)renderCraftPanel();
  if(G.tradeOpen)renderTradePanel();
  if(G.chestOpen)renderChest();
  if(G.bankOpen)renderBankPanel();
  if(G.smithOpen)renderSmithPanel();
  if(G.mageOpen)renderMagePanel();
  if(G.farrierOpen)renderFarrierPanel();
  if(G.antiqOpen)renderAntiqPanel();
  if(G.cryptoOpen)renderCryptoPanel();
  if(G.curatorOpen)renderCuratorPanel();
  if(G.robberOpen)renderRobberPanel();
  if(G.skillOpen)renderSkillPanel();
  if(G.corpseLootOpen)renderCorpseLoot();
  if(G.charOpen)renderCharPanel();
  if(G.contractsOpen)renderContractPanel();
  if(G.worldChestOpen)renderWorldChest();
  if(G.questOpen)renderQuestPanel();
  if(G.editorOpen)renderEditorPanel();
  if(G.editorOpen&&G.pixelOpen)renderPixelStudio();
  if(G.dollOpen)renderPaperDoll();
  drawGambitHud();
  drawRadialButton();
  if(radial.open)drawRadial();
  if(G.gambitOpen)renderGambitPanel();
  if(G.backpackOpen)renderBackpack();
  if(G.trade)renderTrade();
  if(G.tradeInvite)renderTradeInvite();
  if(G.tutorialOpen)renderTutorialPanel();
  if(G.charSelectOpen){
    renderCharSelect(ctx, G.canvas, (slotIdx) => {
      AccountManager.setActiveSlotIndex(slotIdx);
      const slot = AccountManager.getActiveSlot();
      if (slot && slot.saveBlob) {
        loadGame(slot.saveBlob);
      }
      G.charSelectOpen = false;
      addFloater(player.x, player.y - 40, `✨ Playing as ${player.name} (${player.race})`);
    }, (slotIdx) => {
      openCreator(slotIdx);
    });
  }
  if(G.charCreatorOpen){
    renderCharCreator(ctx, G.canvas, (charData) => {
      AccountManager.setActiveSlotIndex(charData.slotIdx);
      resetForNewCharacter();          // a new hero starts genuinely from scratch
      player.name = charData.name;
      player.gender = charData.gender;
      player.race = charData.race;
      player.stats = { ...charData.stats };
      player.dollGender = charData.gender === 'female' ? 'f' : 'm';
      
      // Starting kit for a brand new character. Deliberately no sword/bow/
      // pickaxe — the tutorial chain has you craft each of those, and handing
      // them over up front skips the quests and makes a "new" hero feel used.
      findClearSpawn();
      inv.wood = 0; inv.stone = 0; inv.planks = 0; inv.arrows = 10; inv.gold = 20; inv.bandages = 2;
      player.hasAxe = true; player.hasSword = false; player.hasBow = false; player.hasPickaxe = false;
      player.weapon = 'axe';
      recomputeDerivedStats();

      saveGame(true);
      G.charCreatorOpen = false;
      G.charSelectOpen = false;
      addFloater(player.x, player.y - 40, `✨ Welcome to Lunar, ${player.name}!`);
    }, () => {
      G.charCreatorOpen = false;
      G.charSelectOpen = true;
    });
  }
  drawUiDragGhost();               // dragged item icon rides above all panels
  if(player.ghost)drawGhostHUD();
  // pos / inventory / weapon readouts moved into the How To Play panel (T) —
  // the always-on HUD stays down to the title line + transient statuses
  const st=[];if(prefs.showFps)st.push(_fpsVal+' FPS');
  // player.running, NOT keyboardRunning(). The difference is the whole point:
  // keyboardRunning() means "run mode is engaged", which is true while you stand
  // still with Sprint held, so the badge lit up when nobody was running. An
  // indicator that is on while you are stationary teaches the player that the
  // game thinks it is running when it is not — which is exactly the wrong thing
  // to be wrong about while trying to work out whether a key walks or runs.
  if(!player.dead&&player.running)st.push('🏃 RUN');if(G.aggroMode)st.push('⚔ AGGRO');if(skills.hiding.active)st.push('👤 HIDDEN');if(player.poisonTimer>0)st.push('☠ POISONED');if(player.charmed)st.push('💚 CHARMED');if(player.stunTimer>0)st.push('⚡ STUNNED');if(player.isRat)st.push('🐀 RAT CURSE');if(G.inDungeon){const _f=DUNGEON_FLOORS.find(x=>x.n===G.dungeonFloor);st.push('💀 F'+(G.dungeonFloor||1)+' '+(_f?_f.name.toUpperCase():'RAT DUNGEON'));}if(player.onHorse)st.push('🐴 MOUNTED');
  document.getElementById('status').textContent=st.join('  ');
}


// Height is derived from the busiest page so no page has dead space and none
// clips: header + tabs + ceil(maxButtons/2) rows + footer.
const DEV_W = fitPanelW(388), DEV_HEADER = 46, DEV_TABS_H = 26, DEV_PAD = 12, DEV_ROW_H = 34;
function devPanelXY() {
  const h = devPanelH();
  return panelAt('dev_panel', Math.round(G.canvas.width/2 - DEV_W/2), Math.round(G.canvas.height/2 - h/2), DEV_W, h);
}
// Anything that answers a question rather than doing something logs to the
// console (where the JSON is readable) and confirms on screen, so a click never
// looks like it did nothing.
function devLog(label, value){
  let parsed=value, wasJson=false;
  if(typeof value==='string'){ try{ parsed=JSON.parse(value); wasJson=true; }catch(_){ parsed=value; } }
  console.log('[DEV] '+label+':', parsed);
  // A helper that failed returns a plain sentence ("could not spawn at ..."),
  // and that sentence IS the answer — putting it on screen beats sending the
  // user to the console to find out why nothing happened.
  addFloater(player.x, player.y-30,
    (!wasJson && typeof parsed==='string' && parsed.length<64) ? parsed : label+' → console');
}
function devNearestPlaced(){
  let best=null, bd=1e9;
  for(const o of placedObjects){ const d=Math.hypot(o.x-player.x,o.y-player.y); if(d<bd){bd=d;best=o;} }
  return best;
}
function devBoss(){ return enemies.find(e=>e.floorBoss); }

// ── Pages ──
// The command surface outgrew one screen once placeables, burnout and boss
// mechanics landed. Grouped by what you're actually doing rather than by which
// module implements it.
const DEV_PAGES = [
  { key:'GIVE', title:'Give', buttons: () => [
    { label:'+1000 Gold',      action:()=>window.giveGold(1000) },
    { label:'+50 Planks',      action:()=>window.givePlanks(50) },
    { label:'+50 Stone',       action:()=>window.giveStone(50) },
    { label:'+50 Wood',        action:()=>window.giveWood(50) },
    { label:'+100 All Res',    action:()=>window.giveAll(100) },
    { label:'+10 Iron/Steel',  action:()=>window.giveIronSteel(10) },
    { label:'+10 Torches',     action:()=>window.giveTorches(10) },
    { label:'+10 Lanterns',    action:()=>window.giveLanterns(10) },
    { label:'+1 Siege Ram',    action:()=>window.giveSiegeRam() },
    { label:'Equip House Tool',action:()=>window.giveHouseTool() },
    { label:'+5 Each Placeable',action:()=>{ for(const k in PLACEABLES) inv[PLACEABLES[k].invKey]=(inv[PLACEABLES[k].invKey]||0)+5;
        addFloater(player.x,player.y-30,'+5 of every placeable'); } },
    { label:'+20 Bandages',    action:()=>{ inv.bandages=(inv.bandages||0)+20; addFloater(player.x,player.y-30,'+20 bandages'); } },
  ]},
  { key:'PLAYER', title:'Player', buttons: () => [
    { label:'God Mode',        action:()=>window.godMode() },
    { label:'Full Revive',     action:()=>window.fullRevive() },
    { label:'Max Skills',      action:()=>window.maxSkills() },
    { label:'Tier 5 Weapons',  action:()=>{ _dev.setTier(5,5,5); addFloater(player.x,player.y-30,'runic weapons'); } },
    { label:'Full Runic Armor',action:()=>{ _dev.equipFullArmor(6); addFloater(player.x,player.y-30,'runic armor'); } },
    { label:'Full Iron Armor', action:()=>{ _dev.equipFullArmor(3); addFloater(player.x,player.y-30,'iron armor'); } },
    { label:'Teleport City',   action:()=>window.teleportTo(301,357) },
    { label:'Teleport Wild',   action:()=>window.teleportTo(280,200) },
    { label:'Teleport Dungeon',action:()=>window.teleportTo(DUNGEON_X0+16, DUNGEON_Y0+22) },
    { label:'Log Combat Stats',action:()=>devLog('combat',{melee:_dev.meleeDmg(),arrow:_dev.arrowDmg(),armorDR:_dev.armorDR()}) },
    { label:'Log Equip Stats', action:()=>devLog('equipment',_dev.equipStats()) },
    { label:'Spawn Wolf',      action:()=>window.spawnEnemy('wolf',2) },
  ]},
  { key:'GFX', title:'Graphics', buttons: () => [
    ...TIERS.map(t => ({ label:()=>(getTier()===t?'● ':'○ ')+t.toUpperCase(), action:()=>{
      setTier(t); addFloater(player.x,player.y-30,'quality: '+t); } })),
    { label:()=>'Shadows: '+(renderer.shadowMap.enabled?'ON':'OFF'), action:()=>window.toggleShadows() },
    { label:()=>'Time: '+(_timeFrozen!==null?'FROZEN':'running'), action:()=>
        addFloater(player.x,player.y-30,_dev.freezeTime(_timeFrozen===null)) },
    { label:'Log Passes',      action:()=>devLog('passes', rndr?rndr.passes():['(passthrough)']) },
    { label:'Log Shadow Box',  action:()=>devLog('shadow', JSON.parse(_dev.shadowBox())) },
    { label:'Log Materials',   action:()=>devLog('materials', JSON.parse(_dev.matAudit())) },
    { label:'Log Shot State',  action:()=>devLog('shot', JSON.parse(_dev.shot())) },
    { label:'Log Perf',        action:()=>devLog('perf', JSON.parse(_dev.perf())) },
  ]},
  { key:'WORLD', title:'World', buttons: () => [
    { label:'Toggle Day/Night',action:()=>window.toggleTime() },
    { label:'Advance Moon ▶',  action:()=>window.advanceMoon() },
    { label:'Set 06:00 Dawn',  action:()=>addFloater(player.x,player.y-30,_dev.setHour(6)) },
    { label:'Set 12:00 Noon',  action:()=>addFloater(player.x,player.y-30,_dev.setHour(12)) },
    { label:'Set 20:00 Dusk',  action:()=>addFloater(player.x,player.y-30,_dev.setHour(20)) },
    { label:'Set 00:00 Night', action:()=>addFloater(player.x,player.y-30,_dev.setHour(0)) },
    { label:()=>'Shadows: '+(renderer.shadowMap.enabled?'ON':'OFF'), action:()=>window.toggleShadows() },
    { label:'Open Settings',   action:()=>{ G.devGuiOpen=false; G.settingsOpen=true; } },
    { label:'Rebake Terrain',  action:()=>devLog('terrain rebake',_dev.warp()) },
    { label:'Log Texture Probe',action:()=>devLog('textures',_dev.texProbe()) },
    { label:'Log Scene Env',   action:()=>devLog('scene env',_dev.sceneEnv()) },
  ]},
  { key:'BUILD', title:'Build', buttons: () => {
    const out = Object.keys(PLACEABLES).map(k=>({
      label:'Hold '+PLACEABLES[k].label,
      action:()=>{ inv[PLACEABLES[k].invKey]=Math.max(1,inv[PLACEABLES[k].invKey]||0);
        player.weapon=PLACEABLES[k].invKey; refreshHeldProp(true);
        addFloater(player.x,player.y-30,'holding '+PLACEABLES[k].label+' — right-click to place'); } }));
    out.push(
      { label:'Pick Up Nearest', action:()=>{ const o=devNearestPlaced();
          if(!o) return addFloater(player.x,player.y-30,'nothing placed');
          removePlacedObject(o,true); } },
      { label:'Burn Out Nearest',action:()=>{ const o=devNearestPlaced();
          if(!o) return addFloater(player.x,player.y-30,'nothing placed');
          const i=placedObjects.indexOf(o); devLog('burn',_dev.burn(i,-1)); _dev.sweep(); } },
      { label:'Relight Nearest', action:()=>{ const o=devNearestPlaced();
          if(!o) return addFloater(player.x,player.y-30,'nothing placed');
          devLog('relight',_dev.relight(placedObjects.indexOf(o))); } },
      { label:'Log Placeables',  action:()=>devLog('placeables',_dev.placeables()) });
    return out;
  }},
  { key:'BOSS', title:'Bosses', buttons: () => [
    { label:'Spawn Gravebinder',action:()=>devLog('boss',_dev.boss('gravebinder')) },
    { label:'Spawn Molloch',    action:()=>devLog('boss',_dev.boss('molloch')) },
    { label:'▶ Grave Slam',     action:()=>devLog('cast',_dev.forceCast('grave_slam')) },
    { label:'▶ Bone Cage',      action:()=>devLog('cast',_dev.forceCast('bone_cage')) },
    { label:'▶ Marrow Quake',   action:()=>devLog('cast',_dev.forceCast('marrow_quake')) },
    { label:'▶ Piercing Shriek',action:()=>devLog('cast',_dev.forceCast('shriek')) },
    { label:'▶ Plague Wave',    action:()=>devLog('cast',_dev.forceCast('plague_wave')) },
    { label:'▶ Swarm',          action:()=>devLog('cast',_dev.forceCast('swarm')) },
    { label:'Boss HP 50%',      action:()=>devLog('boss hp',_dev.bossHp(0.5)) },
    { label:'Boss HP 20% (rage)',action:()=>devLog('boss hp',_dev.bossHp(0.2)) },
    { label:'Kill Boss',        action:()=>{ const b=devBoss();
        if(!b) return addFloater(player.x,player.y-30,'no boss alive');
        damageEnemy(b, b.hp+1); } },
    { label:'Log Cast State',   action:()=>devLog('cast state',_dev.cast()) },
  ]},
];
function devMaxRows(){
  let m=0; for(const p of DEV_PAGES) m=Math.max(m, Math.ceil(p.buttons().length/2));
  return m;
}
function devPanelH(){ return DEV_HEADER + DEV_TABS_H + 6 + devMaxRows()*DEV_ROW_H + 18; }
function devTabRects(){
  const {px,py}=devPanelXY();
  const n=DEV_PAGES.length, w=(DEV_W-DEV_PAD*2)/n;
  return DEV_PAGES.map((p,i)=>({ page:i, label:p.key,
    x:px+DEV_PAD+i*w, y:py+DEV_HEADER-4, w:w-3, h:DEV_TABS_H-6 }));
}
function devRects() {
  const {px, py} = devPanelXY();
  const page = DEV_PAGES[G.devPage||0] || DEV_PAGES[0];
  const list = page.buttons();
  const colW = (DEV_W - DEV_PAD * 2 - 10) / 2;
  const startY = py + DEV_HEADER + DEV_TABS_H + 6;
  return list.map((b,i)=>({
    label: typeof b.label==='function' ? b.label() : b.label,
    action: b.action,
    x: px + DEV_PAD + (i%2) * (colW + 10),
    y: startY + Math.floor(i/2) * DEV_ROW_H,
    w: colW, h: 28,
  }));
}

function handleDevClick(e) {
  for (const t of devTabRects()) {
    if (e.clientX>=t.x && e.clientX<=t.x+t.w && e.clientY>=t.y && e.clientY<=t.y+t.h) {
      G.devPage = t.page; return true;
    }
  }
  for (const r of devRects()) {
    if (e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y && e.clientY <= r.y + r.h) {
      try { r.action(); } catch(err){ console.warn('[DEV] '+r.label+' failed:', err);
        addFloater(player.x, player.y-30, r.label+' failed — see console'); }
      return true;
    }
  }
  return true;                     // clicks inside the panel shouldn't close it
}

function renderDevPanel() {
  const ctx = G.ctx;
  const {px, py} = devPanelXY();
  const pageIdx = G.devPage||0, page = DEV_PAGES[pageIdx] || DEV_PAGES[0];
  const DEV_H = devPanelH();

  ctx.fillStyle = 'rgba(24,12,12,.97)';
  ctx.fillRect(px, py, DEV_W, DEV_H);
  ctx.strokeStyle = '#e06060';
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, DEV_W, DEV_H);

  ctx.fillStyle = '#e06060';
  ctx.font = 'bold 14px ui-monospace,Menlo,Consolas,monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🛠 DEV — '+page.title+'  ·  ` to close', px + DEV_W/2, py + 19);

  ctx.fillStyle = '#999';
  ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
  const b=devBoss();
  ctx.fillText(`tile ${Math.floor(player.x/TILE)},${Math.floor(player.y/TILE)}`
    + `  ·  placed ${placedObjects.length}`
    + (b?`  ·  ${b.bossName} ${Math.round(b.hp/b.maxHp*100)}%`:''), px + DEV_W/2, py + 34);

  for (const t of devTabRects()) {
    const on = t.page===pageIdx;
    ctx.fillStyle = on ? 'rgba(224,96,96,.85)' : 'rgba(60,20,20,.7)';
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeStyle = on ? '#ffcccc' : 'rgba(224,96,96,.5)';
    ctx.lineWidth = 1; ctx.strokeRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = on ? '#2a0e0e' : '#e0a0a0';
    ctx.font = 'bold 10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(t.label, t.x + t.w/2, t.y + 14);
  }

  for (const r of devRects()) {
    ctx.fillStyle = 'rgba(60,20,20,.85)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#e06060';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#ffcccc';
    // Shrink to fit rather than overflow the button — labels vary a lot in length.
    let fs = 11;
    ctx.font = 'bold '+fs+'px ui-monospace,Menlo,Consolas,monospace';
    while (fs > 7 && ctx.measureText(r.label).width > r.w - 8) {
      fs -= 1; ctx.font = 'bold '+fs+'px ui-monospace,Menlo,Consolas,monospace';
    }
    ctx.fillText(r.label, r.x + r.w/2, r.y + 18);
  }
  ctx.fillStyle = '#7a5050';
  ctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
  ctx.fillText('page '+(pageIdx+1)+'/'+DEV_PAGES.length+'  ·  readouts print to the browser console',
    px + DEV_W/2, py + DEV_H - 8);
  ctx.textAlign = 'left';
}


// ══ Settings (ESC) ═══════════════════════════════════════════════════════════
// Everything a player can change about how the game looks, sounds and controls.
// The dev panel keeps the things that change the WORLD (spawn a wolf, set the
// hour); this keeps the things that change the PLAYER'S experience of it.
const SET_W = fitPanelW(408);
const SET_HEADER = 40, SET_TABS_H = 26, SET_ROW_H = 32, SET_PAD = 12;
const SET_FOOTER = 38, SET_GUTTER = 20;
let settingsTab = 0, settingsScroll = 0;
let settingsCapture = null;      // action id awaiting a keypress, or null
let setSliderDrag = null;        // row being dragged, or null

// How many rows fit. On a phone the panel is height-capped by fitPanelH, so this
// shrinks and the scroll arrows start earning their place.
function setVisibleRows(){
  const maxH = fitPanelH(SET_HEADER + SET_TABS_H + 6 + 12*SET_ROW_H + SET_FOOTER);
  return Math.max(4, Math.floor((maxH - SET_HEADER - SET_TABS_H - 6 - SET_FOOTER) / SET_ROW_H));
}
// Drawn rows: what fits, or what there is, whichever is smaller. The dev panel
// sizes itself to its BUSIEST page so it never jumps -- that works there because
// its pages are all about as long. Here they run from 2 rows (Audio) to 27
// (Keybinds), so a fixed height would mean either a scrollbar on a two-row page
// or half a panel of nothing on it. The panel is centred, so it grows and
// shrinks symmetrically and the tab strip stays put.
function setRowCount(){ return Math.max(1, Math.min(setVisibleRows(), setRows().length)); }
function setPanelH(){ return SET_HEADER + SET_TABS_H + 6 + setRowCount()*SET_ROW_H + SET_FOOTER; }
function settingsXY(){
  const h = setPanelH();
  return panelAt('settings', Math.round(G.canvas.width/2 - SET_W/2),
                             Math.round(G.canvas.height/2 - h/2), SET_W, h);
}

// A row is one of:
//   {t:'toggle', label, get, set}
//   {t:'slider', label, min, max, step, get, set, fmt}
//   {t:'cycle',  label, get, next}
//   {t:'bind',   id, label}
//   {t:'btn',    label, action}
//   {t:'note',   label}
const SET_TABS = [
  { key:'VIDEO', title:'Video', rows: () => [
    { t:'cycle',  label:'Quality',        get:()=>getTier().toUpperCase(),
      next:()=>{ const i=TIERS.indexOf(getTier()); setTier(TIERS[(i+1)%TIERS.length]); } },
    { t:'toggle', label:'Shadows',        get:()=>!!renderer.shadowMap.enabled, set:()=>window.toggleShadows() },
    { t:'slider', label:'Field of View',  min:-20, max:30, step:1,
      get:()=>prefs.fov, set:v=>{ setPref('fov',v); applyFov(camMode()); },
      fmt:()=>Math.round(camera.fov)+'°' },
    { t:'slider', label:'Draw Distance',  min:0.5, max:2, step:0.05,
      get:()=>prefs.renderScale, set:v=>setPref('renderScale',v),
      fmt:()=>Math.round(viewRadii().RD/TILE)+' tiles' },
    { t:'note',   label:'Draw distance trades frame rate for how far you can see.' },
  ]},
  { key:'CTRL', title:'Controls', rows: () => {
    const r = [
      { t:'slider', label:'Mouse Sensitivity', min:0.25, max:3, step:0.05,
        get:()=>prefs.lookSens, set:v=>setPref('lookSens',v), fmt:()=>prefs.lookSens.toFixed(2)+'×' },
      { t:'toggle', label:'Invert Look Y',  get:()=>!!prefs.invertY, set:v=>setPref('invertY',v) },
      { t:'note',   label:'Walk by default. Hold Sprint, or double-tap forward' },
      { t:'note',   label:'or back and keep holding it, to run.' },
      { t:'cycle',  label:'Camera',         get:()=>camMode().label||camMode().id,
        next:()=>setCamMode(camModeIdx+1) },
      { t:'note',   label:'Mouse look is first person only — [ and ] step camera modes.' },
      { t:'toggle', label:'Flick Control',  get:()=>!radialHidden(), set:v=>setRadialHidden(!v) },
      { t:'btn',    label:'Reset Flick Position',
        action:()=>{ resetRadialPos(); addFloater(player.x,player.y-30,'flick control reset'); } },
    ];
    // The movement stick and its thumb zone only exist on a touch screen. They
    // are still listed on a desktop (so the settings are discoverable when the
    // same account picks up a tablet) but marked as what they are.
    r.push({ t:'slider', label:'Thumb Stick Size', min:36, max:96, step:2,
             get:()=>prefs.stickSize, set:v=>setPref('stickSize',v), fmt:()=>Math.round(prefs.stickSize)+'px' });
    r.push({ t:'slider', label:'Thumb Zone Width', min:0.6, max:1.5, step:0.05,
             get:()=>prefs.stickZone, set:v=>setPref('stickZone',v),
             fmt:()=>Math.round(prefs.stickZone*100)+'%' });
    if(!isTouchPrimary()) r.push({ t:'note', label:'Stick settings apply on phone and tablet.' });
    return r;
  }},
  { key:'KEYS', title:'Keybinds', rows: () => [
    ...BIND_DEFS.map(b => ({ t:'bind', id:b.id, label:b.label })),
    { t:'btn', label:'Reset All Keys', action:()=>{ resetBinds(); addFloater(player.x,player.y-30,'keys reset'); } },
  ]},
  { key:'HUD', title:'Interface', rows: () => [
    { t:'toggle', label:'Player Nameplates', get:()=>prefs.showNames!==false, set:v=>setPref('showNames',v) },
    { t:'slider', label:'Nameplate Range', min:10, max:80, step:2,
      get:()=>prefs.nameDist, set:v=>setPref('nameDist',v), fmt:()=>Math.round(prefs.nameDist)+' tiles' },
    { t:'toggle', label:'Show FPS',       get:()=>!!prefs.showFps, set:v=>setPref('showFps',v) },
    { t:'toggle', label:'Minimap',        get:()=>!!G.minimapOpen, set:v=>{ G.minimapOpen=v; } },
    { t:'btn',    label:'Reset Panel Positions',
      action:()=>{ resetPanelPositions(); addFloater(player.x,player.y-30,'panels reset'); } },
  ]},
  { key:'AUDIO', title:'Audio', rows: () => [
    { t:'toggle', label:'Sound',          get:()=>!soundMuted, set:v=>setSoundMuted(!v) },
    { t:'slider', label:'Master Volume',  min:0, max:1, step:0.05,
      get:()=>prefs.volume, set:v=>{ setPref('volume',v); setMasterVol(v); },
      fmt:()=>Math.round(prefs.volume*100)+'%' },
  ]},
];

function setRows(){ return (SET_TABS[settingsTab]||SET_TABS[0]).rows(); }
function setMaxScroll(){ return Math.max(0, setRows().length - setVisibleRows()); }

function setTabRects(){
  const {px,py}=settingsXY();
  const n=SET_TABS.length, w=(SET_W-SET_PAD*2)/n;
  return SET_TABS.map((t,i)=>({ tab:i, label:t.key,
    x:px+SET_PAD+i*w, y:py+SET_HEADER-6, w:w-3, h:SET_TABS_H-6 }));
}
// The row area, minus the right-hand gutter the arrows live in.
function setRowRects(){
  const {px,py}=settingsXY();
  const rows=setRows(), vis=setRowCount();
  settingsScroll=Math.max(0,Math.min(settingsScroll,setMaxScroll()));
  const startY=py+SET_HEADER+SET_TABS_H+6;
  const w=SET_W-SET_PAD*2-(setMaxScroll()>0?SET_GUTTER:0);
  const out=[];
  for(let i=0;i<vis;i++){
    const row=rows[i+settingsScroll]; if(!row)break;
    out.push({ row, x:px+SET_PAD, y:startY+i*SET_ROW_H, w, h:SET_ROW_H-4 });
  }
  return out;
}
// Control column: right-aligned, same width for every row so the panel reads as
// a list rather than a ransom note.
function setCtlRect(r){
  const w=Math.min(150, r.w*0.46);
  return { x:r.x+r.w-w, y:r.y+4, w, h:SET_ROW_H-12 };
}
function setArrowRects(){
  if(setMaxScroll()<=0) return [];
  const {px,py}=settingsXY();
  const x=px+SET_W-SET_PAD-SET_GUTTER+2, top=py+SET_HEADER+SET_TABS_H+6;
  const h=setRowCount()*SET_ROW_H;
  return [{ dir:-1, x, y:top, w:SET_GUTTER-4, h:22 },
          { dir:+1, x, y:top+h-22, w:SET_GUTTER-4, h:22 }];
}
function setFooterRects(){
  const {px,py}=settingsXY(), H=setPanelH();
  const bw=(SET_W-SET_PAD*2-8)/2, by=py+H-SET_FOOTER+7;
  return [{ id:'reset', label:'Reset Defaults', x:px+SET_PAD, y:by, w:bw, h:22 },
          { id:'done',  label:'Done', x:px+SET_PAD+bw+8, y:by, w:bw, h:22 }];
}

const _inR=(e,r)=>e.clientX>=r.x&&e.clientX<=r.x+r.w&&e.clientY>=r.y&&e.clientY<=r.y+r.h;
function sliderValueAt(row, ctl, x){
  const t=Math.max(0,Math.min(1,(x-ctl.x-6)/(ctl.w-12)));
  const v=row.min + t*(row.max-row.min);
  const st=row.step||1;
  return Math.round(v/st)*st;
}

function handleSettingsClick(e){
  if(settingsCapture) return true;          // waiting for a key; ignore clicks
  for(const t of setTabRects()) if(_inR(e,t)){ settingsTab=t.tab; settingsScroll=0; return true; }
  for(const a of setArrowRects()) if(_inR(e,a)){
    settingsScroll=Math.max(0,Math.min(setMaxScroll(),settingsScroll+a.dir)); return true; }
  for(const f of setFooterRects()) if(_inR(e,f)){
    if(f.id==='done'){ G.settingsOpen=false; }
    else { resetPrefs(); resetBinds(); setMasterVol(prefs.volume); applyFov(camMode());
           addFloater(player.x,player.y-30,'settings reset'); }
    return true;
  }
  for(const r of setRowRects()){
    const row=r.row, ctl=setCtlRect(r);
    if(row.t==='btn'){ if(_inR(e,r)){ try{ row.action(); }catch(err){ console.warn('[SET]',err); } return true; } continue; }
    if(row.t==='note') continue;
    if(!_inR(e,ctl)) continue;
    if(row.t==='toggle'){ row.set(!row.get()); return true; }
    if(row.t==='cycle'){ row.next(); return true; }
    if(row.t==='bind'){ settingsCapture=row.id; return true; }
    if(row.t==='slider'){
      row.set(sliderValueAt(row,ctl,e.clientX));
      setSliderDrag={row,ctl};                 // keep following the cursor
      return true;
    }
  }
  return true;                                 // clicks inside the panel never close it
}

// Assign whatever was pressed. Escape cancels rather than binding Escape, which
// would leave no way back out of the menu.
function captureBind(k){
  const id=settingsCapture; settingsCapture=null;
  if(!id) return;
  if(k==='escape') return;
  if(k==='f2'||k==='f5'||k==='f11'||k==='f12') return;   // browser/editor keys stay put
  setBind(id,k);
  addFloater(player.x,player.y-30,keyLabel(k)+' → '+(BIND_DEFS.find(b=>b.id===id)||{}).label);
}

function renderSettings(){
  const ctx=G.ctx, {px,py}=settingsXY(), H=setPanelH();
  const tab=SET_TABS[settingsTab]||SET_TABS[0];

  ctx.fillStyle='rgba(16,13,9,.97)'; ctx.fillRect(px,py,SET_W,H);
  ctx.strokeStyle='#c8a25a'; ctx.lineWidth=2; ctx.strokeRect(px,py,SET_W,H);

  ctx.textAlign='center';
  ctx.fillStyle='#e8dcc0'; ctx.font='bold 14px ui-monospace,Menlo,Consolas,monospace';
  const _ms=setMaxScroll();
  ctx.fillText('⚙ SETTINGS — '+tab.title
    + (_ms>0 ? '   '+(settingsScroll+1)+'–'+Math.min(setRows().length,settingsScroll+setVisibleRows())
               +'/'+setRows().length : ''),
    px+SET_W/2, py+22);

  for(const t of setTabRects()){
    const on=t.tab===settingsTab;
    ctx.fillStyle=on?'rgba(200,162,90,.9)':'rgba(48,38,24,.8)';
    ctx.fillRect(t.x,t.y,t.w,t.h);
    ctx.strokeStyle=on?'#f0e0b8':'rgba(200,162,90,.45)'; ctx.lineWidth=1;
    ctx.strokeRect(t.x,t.y,t.w,t.h);
    ctx.fillStyle=on?'#241a0e':'#c8b48a';
    ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(t.label,t.x+t.w/2,t.y+14);
  }

  for(const r of setRowRects()){
    const row=r.row;
    if(row.t==='note'){
      ctx.textAlign='left'; ctx.fillStyle='#8a7a5c';
      ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(row.label,r.x+2,r.y+18);
      continue;
    }
    if(row.t==='btn'){
      ctx.fillStyle='rgba(60,48,30,.9)'; ctx.fillRect(r.x,r.y+3,r.w,r.h-6);
      ctx.strokeStyle='rgba(200,162,90,.6)'; ctx.lineWidth=1; ctx.strokeRect(r.x,r.y+3,r.w,r.h-6);
      ctx.textAlign='center'; ctx.fillStyle='#e8dcc0';
      ctx.font='bold 11px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(row.label,r.x+r.w/2,r.y+18);
      continue;
    }
    ctx.textAlign='left'; ctx.fillStyle='#d8c8a4';
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(row.label,r.x+2,r.y+19);

    const c=setCtlRect(r);
    if(row.t==='toggle'){
      const on=row.get();
      ctx.fillStyle=on?'rgba(110,160,90,.85)':'rgba(60,48,30,.9)';
      ctx.fillRect(c.x,c.y,c.w,c.h);
      ctx.strokeStyle=on?'#bde09a':'rgba(200,162,90,.5)'; ctx.lineWidth=1;
      ctx.strokeRect(c.x,c.y,c.w,c.h);
      ctx.textAlign='center'; ctx.fillStyle=on?'#12200c':'#a89878';
      ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(on?'ON':'OFF',c.x+c.w/2,c.y+c.h/2+4);
    } else if(row.t==='cycle'){
      ctx.fillStyle='rgba(60,48,30,.9)'; ctx.fillRect(c.x,c.y,c.w,c.h);
      ctx.strokeStyle='rgba(200,162,90,.6)'; ctx.lineWidth=1; ctx.strokeRect(c.x,c.y,c.w,c.h);
      ctx.textAlign='center'; ctx.fillStyle='#e8dcc0';
      ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(String(row.get()).slice(0,16)+' ▸',c.x+c.w/2,c.y+c.h/2+4);
    } else if(row.t==='bind'){
      const cap=settingsCapture===row.id, k=bindOf(row.id);
      ctx.fillStyle=cap?'rgba(200,162,90,.9)':'rgba(60,48,30,.9)';
      ctx.fillRect(c.x,c.y,c.w,c.h);
      ctx.strokeStyle=cap?'#fff':(k?'rgba(200,162,90,.6)':'rgba(200,90,90,.7)');
      ctx.lineWidth=1; ctx.strokeRect(c.x,c.y,c.w,c.h);
      ctx.textAlign='center'; ctx.fillStyle=cap?'#241a0e':(k?'#e8dcc0':'#c88');
      ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(cap?'press a key…':keyLabel(k),c.x+c.w/2,c.y+c.h/2+4);
    } else if(row.t==='slider'){
      const v=row.get(), t=(v-row.min)/(row.max-row.min);
      const tx=c.x+6, tw=c.w-12, ty=c.y+c.h/2;
      ctx.strokeStyle='rgba(200,162,90,.35)'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(tx+tw,ty); ctx.stroke();
      ctx.strokeStyle='#c8a25a'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(tx+tw*t,ty); ctx.stroke();
      ctx.fillStyle='#e8dcc0'; ctx.beginPath(); ctx.arc(tx+tw*t,ty,6,0,Math.PI*2); ctx.fill();
      ctx.textAlign='right'; ctx.fillStyle='#a89878';
      ctx.font='10px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillText(row.fmt?row.fmt():String(v), c.x-6, r.y+19);
    }
  }

  for(const a of setArrowRects()){
    const dis=a.dir<0?settingsScroll<=0:settingsScroll>=setMaxScroll();
    ctx.fillStyle=dis?'rgba(48,38,24,.5)':'rgba(60,48,30,.95)';
    ctx.fillRect(a.x,a.y,a.w,a.h);
    ctx.strokeStyle='rgba(200,162,90,'+(dis?'.25':'.6')+')'; ctx.lineWidth=1;
    ctx.strokeRect(a.x,a.y,a.w,a.h);
    ctx.textAlign='center'; ctx.fillStyle=dis?'#6a5a40':'#e8dcc0';
    ctx.font='11px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(a.dir<0?'▲':'▼',a.x+a.w/2,a.y+15);
  }

  for(const f of setFooterRects()){
    const done=f.id==='done';
    ctx.fillStyle=done?'rgba(200,162,90,.9)':'rgba(60,48,30,.9)';
    ctx.fillRect(f.x,f.y,f.w,f.h);
    ctx.strokeStyle='rgba(200,162,90,.6)'; ctx.lineWidth=1; ctx.strokeRect(f.x,f.y,f.w,f.h);
    ctx.textAlign='center'; ctx.fillStyle=done?'#241a0e':'#e8dcc0';
    ctx.font='bold 10px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillText(f.label+(done?'  (Esc)':''),f.x+f.w/2,f.y+15);
  }
  ctx.textAlign='left';
}

// ── Dev Console Mode Helper Commands ───────────────────────────────
function initDevCommands() {
  window.giveGold = (n = 1000) => {
    inv.gold += n;
    snd.gold();
    addFloater(player.x, player.y - 20, `+${n} gold`);
    console.log(`[DEV] Added ${n} gold. New total: ${inv.gold}`);
  };
  window.givePlanks = (n = 50) => {
    inv.planks = (inv.planks || 0) + n;
    addFloater(player.x, player.y - 20, `+${n} planks`);
    console.log(`[DEV] Added ${n} planks. New total: ${inv.planks}`);
  };
  window.giveStone = (n = 50) => {
    inv.stone = (inv.stone || 0) + n;
    addFloater(player.x, player.y - 20, `+${n} stone`);
    console.log(`[DEV] Added ${n} stone. New total: ${inv.stone}`);
  };
  window.giveWood = (n = 50) => {
    inv.wood = (inv.wood || 0) + n;
    addFloater(player.x, player.y - 20, `+${n} wood`);
    console.log(`[DEV] Added ${n} wood. New total: ${inv.wood}`);
  };
  window.giveAll = (n = 100) => {
    inv.gold += n;
    inv.planks = (inv.planks || 0) + n;
    inv.stone = (inv.stone || 0) + n;
    inv.wood = (inv.wood || 0) + n;
    snd.gold();
    addFloater(player.x, player.y - 20, `+${n} all resources`);
    console.log(`[DEV] Added ${n} of gold, planks, stone, and wood.`);
  };
  window.giveHouseTool = () => {
    player.hasHouseTool = true;
    player.weapon = 'house_tool';
    addFloater(player.x, player.y - 20, `Housing Tool equipped`);
    console.log(`[DEV] Housing Tool given and equipped.`);
  };
  window.teleportTo = (tx, ty) => {
    player.x = tx * TILE + TILE/2;
    player.y = ty * TILE + TILE/2;
    netTp('dev');
    addFloater(player.x, player.y - 20, `Teleported!`);
    console.log(`[DEV] Teleported to tile coordinates: (${tx}, ${ty})`);
  };
  window.godMode = () => {
    player.hp = player.maxHp = 99999;
    addFloater(player.x, player.y - 20, `God Mode ON`);
    console.log(`[DEV] God mode enabled. Max HP set to 99999.`);
  };
  window.spawnEnemy = (type = 'wolf', offset = 2) => {
    if (!ENEMY_CFG[type]) {
      console.warn(`[DEV] Unknown enemy type "${type}". Valid types:`, Object.keys(ENEMY_CFG));
      return;
    }
    const tx = Math.floor(player.x / TILE) + offset;
    const ty = Math.floor(player.y / TILE);
    const e = makeEnemy(type, tx, ty);
    if (e) {
      enemies.push(e);
      addFloater(e.x, e.y - 20, `${type} spawned!`);
      console.log(`[DEV] Spawned "${type}" at tile (${tx}, ${ty})`);
    } else {
      console.warn(`[DEV] Could not spawn "${type}" at tile (${tx}, ${ty})`);
    }
  };
  window.giveIronSteel = (n = 10) => {
    inv.iron_ore = (inv.iron_ore || 0) + n;
    inv.iron_ingot = (inv.iron_ingot || 0) + n;
    inv.steel_ingot = (inv.steel_ingot || 0) + n;
    addFloater(player.x, player.y - 20, `+${n} iron & steel`);
    console.log(`[DEV] Added iron/steel. New totals: ore: ${inv.iron_ore}, iron: ${inv.iron_ingot}, steel: ${inv.steel_ingot}`);
  };
  window.giveSiegeRam = () => {
    inv.siege_ram = (inv.siege_ram || 0) + 1;
    addFloater(player.x, player.y - 20, `+1 Siege Ram`);
    console.log(`[DEV] Added 1 Siege Ram. New total: ${inv.siege_ram}`);
  };
  window.maxSkills = () => {
    skills.hiding.xp = 10000;
    skills.healing.xp = 10000;
    skills.wrestling.xp = 10000;
    addFloater(player.x, player.y - 20, `Skills maxed to Lv 4!`);
    console.log(`[DEV] Maxed all skill talents (Lv 4).`);
  };
  window.toggleTime = () => {
    // Shift the clock rather than assigning gameTime — it's re-derived from
    // the shared world clock every frame, so a direct write wouldn't stick.
    shiftWorldTime(DAY_CYCLE_SEC / 2);
    addFloater(player.x, player.y - 20, `Time toggled!`);
    console.log(`[DEV] Toggled time (local only). Cycle position: ${Math.floor(G.gameTime % DAY_CYCLE_SEC)}s`);
  };
  // The dev panel had an "Advance Moon" button wired to this, but it was never
  // defined — clicking it threw. One phase is an eighth of the 4-day lunar
  // cycle, i.e. half an in-game day.
  window.advanceMoon = () => {
    shiftWorldTime(DAY_CYCLE_SEC / 2);
    const names=['New','Waxing Crescent','First Quarter','Waxing Gibbous','Full','Waning Gibbous','Last Quarter','Waning Crescent'];
    addFloater(player.x, player.y - 20, `🌙 ${names[G.moonPhase||0]}`);
    console.log(`[DEV] Moon advanced (local only) → phase ${G.moonPhase}`);
  };
  window.toggleShadows = (enable) => {
    renderer.shadowMap.enabled = enable !== undefined ? enable : !renderer.shadowMap.enabled;
    scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
    const status = renderer.shadowMap.enabled ? 'ON' : 'OFF';
    addFloater(player.x, player.y - 20, `Shadows ${status}`);
    console.log(`[DEV] Shadows toggled → ${status}`);
    return `Shadows ${status}`;
  };
  window.fullRevive = () => {
    player.dead = false;
    player.ghost = false;
    player.hp = player.maxHp;
    player.poisonTimer = 0;
    player.poisonDmg = 0;
    player.isRat = false;
    player.deathWardCd = 0;
    addFloater(player.x, player.y - 20, `Full Revived!`);
    console.log(`[DEV] Full revive executed.`);
  };
  window.giveLanterns = (n = 10) => {
    inv.lantern = (inv.lantern || 0) + n;
    addFloater(player.x, player.y - 20, `+${n} Lanterns`);
    console.log(`[DEV] Added lanterns. New total: ${inv.lantern}`);
  };
  window.giveTorches = (n = 10) => {
    inv.torch = (inv.torch || 0) + n;
    addFloater(player.x, player.y - 20, `+${n} Torches`);
    console.log(`[DEV] Added torches. New total: ${inv.torch}`);
  };
  
  // Group under a handy "dev" object as well
  window.dev = {
    giveGold: window.giveGold,
    givePlanks: window.givePlanks,
    giveStone: window.giveStone,
    giveWood: window.giveWood,
    giveAll: window.giveAll,
    giveHouseTool: window.giveHouseTool,
    teleportTo: window.teleportTo,
    godMode: window.godMode,
    spawnEnemy: window.spawnEnemy,
    giveIronSteel: window.giveIronSteel,
    giveSiegeRam: window.giveSiegeRam,
    giveLanterns: window.giveLanterns,
    maxSkills: window.maxSkills,
    toggleTime: window.toggleTime,
    fullRevive: window.fullRevive,
    // Camera + forest LOD readout. The near/far split is driven by the live
    // camera angle, so "why is the forest more detailed over here" is a
    // question worth being able to answer without a debugger.
    camInfo: () => {
      const m = camMode();
      const info = {
        mode: m.id, fov: camera.fov,
        camPitch: +camPitch.toFixed(3), camZoom: +camZoom.toFixed(3),
        fpPitch: +fpPitch.toFixed(3),
        nearBudget: nearForest
          ? Math.min(NEAR_TREES_CAP, Math.round((QS.nearTrees|0) * nearBudgetFactor(m.fp, camPitch, camZoom)))
          : 0,
        tierNearTrees: QS.nearTrees|0,
        nearRadiusTiles: +nearRadiusTiles(m.fp, camPitch).toFixed(1),
        placed: nearForest ? nearForest.species.map(sp => sp.id + ':' + sp.bark.count).join(' ') : '(none)',
        farTrees: trunkMesh.count,
      };
      console.table ? console.table(info) : console.log(info);
      return info;
    },
    help: () => {
      console.log(`
--- [DEV MODE CONSOLE COMMANDS] ---
giveGold(amount)        - Give player gold (default: 1000)
givePlanks(amount)      - Give player planks (default: 50)
giveStone(amount)       - Give player stone (default: 50)
giveWood(amount)        - Give player wood (default: 50)
giveAll(amount)         - Give all resources (default: 100)
giveHouseTool()         - Give and equip the Housing Tool
teleportTo(tx, ty)      - Teleport player to tile coordinates (tx, ty)
godMode()               - Enable god mode (99999 max HP)
spawnEnemy(type, off)   - Spawn enemy at player location offset (default: 'wolf')
giveIronSteel(amount)   - Give player iron ore, iron ingot, and steel ingot (default: 10)
giveSiegeRam()          - Give player 1 Siege Ram
giveLanterns(amount)    - Give player lanterns (default: 10)
maxSkills()             - Max all active skill trees to level 4
toggleTime()            - Switch instantly between day and night cycles
fullRevive()            - Instantly resurrect player, restore full HP, and clear rat curse
camInfo()               - Camera mode, fov, and the forest LOD budget it implies
      `);
    }
  };
  
  console.log(`%c[DEV MODE] Console commands loaded! Call "dev.help()" to see instructions.`, "color: #a890d0; font-weight: bold;");
}

// ── Multiplayer presence ───────────────────────────────────────────
// Remote players render as clones of the real Protag model (animated,
// weapon-in-hand), falling back to a name-tinted procedural rig until the
// GLB is loaded. Positions smooth between 10Hz server updates; facing
// comes from the server-synced dir. All of it no-ops when offline.
const remoteVis = new Map();   // sessionId -> {rig?, model?, rx, rz, lw, wkind, wslot, mats}
function nameColor(n){
  let h=0; for(let i=0;i<n.length;i++) h=(h*31+n.charCodeAt(i))|0;
  const c=new THREE.Color(); c.setHSL(((h>>>0)%360)/360, 0.55, 0.5); return c.getHex();
}
function buildRemoteModel(st){
  const inner=SkeletonUtils.clone(protagTemplate);   // carries scale/offset/π-yaw
  const mats=[];
  inner.traverse(o=>{ if(o.isMesh){ o.castShadow=true;
    // Culling stays ON. It was disabled because three tests a SkinnedMesh against
    // its BIND-POSE bounding sphere, so an animating character can be culled while
    // still visibly on screen. Inflating the sphere fixes that without giving up
    // culling entirely — and culling is worth a lot here, since an off-screen
    // remote was otherwise still submitting ~12.9k triangles every frame.
    //
    // SkeletonUtils.clone SHARES geometry between clones, so this must happen once
    // per geometry, not once per player: unguarded, every join would inflate the
    // same sphere again and it would grow without bound until nothing ever culled.
    const g=o.geometry;
    if(g && !g.userData._skinBoundsInflated){
      if(!g.boundingSphere) g.computeBoundingSphere();
      if(g.boundingSphere) g.boundingSphere.radius *= 1.75;
      g.userData._skinBoundsInflated = true;
    }
    o.frustumCulled=true;
    // Materials stay per-remote: opacity is per-player (ghost 0.45, hidden 0.25),
    // so sharing them would make one player's death fade every other player out.
    o.material=o.material.clone(); o.material.transparent=true; mats.push(o.material); } });
  const obj=new THREE.Group(); obj.add(inner);
  obj.position.set(st.x,heightAt(st.x,st.y),st.y); scene.add(obj); obj.updateMatrixWorld(true);
  const mixer=new THREE.AnimationMixer(inner);
  const find=n=>protagClips.find(c=>c.name===n);
  const mk=c=>c?mixer.clipAction(c):null;
  const actions={ idle:mk(find('Alert')), walk:mk(find('Running')||find('Walking')),
    attack:mk(find('Attack')||find('Left_Slash')) };
  if(actions.attack) actions.attack.setLoop(THREE.LoopOnce);
  if(actions.idle) actions.idle.play();
  return {obj,inner,mixer,actions,cur:'idle',busyUntil:0,mats};
}
function setRemoteAnim(m,name){
  if(m.cur===name||!m.actions[name])return;
  if(m.actions[m.cur])m.actions[m.cur].fadeOut(0.2);
  m.actions[name].reset().fadeIn(0.2).play(); m.cur=name;
}
function remoteAttackCue(id){
  const v=remoteVis.get(id);
  if(v&&v.model) v.model.pendingAttack=true;   // consumed by syncRemotePlayers on its own clock
}
// hang the right weapon model on a remote clone's hand bone (world-scale
// normalized slot, same trick as the local player's)
function remoteWeapon(v,kind){
  if(v.wkind===kind||!v.model)return;
  if(!v.wslot){
    let hb=null; v.model.inner.traverse(o=>{ if(!hb&&o.isBone&&/RightHand$/i.test(o.name)) hb=o; });
    if(!hb){ v.wkind=kind; return; }
    const ws=new THREE.Vector3(); hb.getWorldScale(ws);
    v.wslot=new THREE.Group(); v.wslot.scale.setScalar(1/(ws.x||1)); hb.add(v.wslot);
  }
  v.wkind=kind;
  while(v.wslot.children.length) v.wslot.remove(v.wslot.children[0]);
  const tpl=weaponTemplates[kind]; if(!tpl) return;
  const m=tpl.clone();
  const adj=WEAPON_ADJUST[kind]||{pos:[0,0,0],rot:[0,0,0],scale:1};
  m.position.fromArray(adj.pos); m.rotation.set(adj.rot[0],adj.rot[1],adj.rot[2]);
  m.scale.setScalar(adj.scale);
  v.wslot.add(m);
}
function syncRemotePlayers(t,dt){
  if(net.remotes.size===0 && remoteVis.size===0) return;
  // Same radii the mobs use, plus a hard cap on how many remotes may animate.
  const { RD2, AD2 } = viewRadii();
  // Rank by distance once per frame: everything past RD is hidden, everything
  // past AD holds its pose, and only the nearest MAX_ANIMATED_REMOTES get a
  // mixer update at all.
  const _ranked=[];
  for(const [id,st] of net.remotes){
    const dx=st.x-player.x, dz=st.y-player.y;
    _ranked.push([id, dx*dx+dz*dz]);
  }
  _ranked.sort((a,b)=>a[1]-b[1]);
  const _d2=new Map(_ranked);
  const _mayAnimate=new Set();
  for(let i=0;i<_ranked.length && _mayAnimate.size<MAX_ANIMATED_REMOTES;i++){
    if(_ranked[i][1]<=AD2) _mayAnimate.add(_ranked[i][0]);
  }
  for(const [id,st] of net.remotes){
    let v=remoteVis.get(id);
    if(!v){
      v={rx:st.x,rz:st.y,lw:null,wkind:null,wslot:null};
      remoteVis.set(id,v);
    }
    if(SKINNING_OK && !v.model && protagTemplate){     // real model (or upgrade from rig)
      if(v.rig){ scene.remove(v.rig); v.rig=null; }
      v.model=buildRemoteModel(st);
    } else if(!v.model && !v.rig){                     // fallback rig until GLB arrives
      const g=makeRig();
      configureRig(g, nameColor(st.name||'?'), 18,34,11, 7, 0, true);
      g.position.set(st.x,heightAt(st.x,st.y),st.y); scene.add(g); v.rig=g;
    }
  }
  for(const [id,v] of remoteVis){
    if(!net.remotes.has(id)){
      if(v.rig)scene.remove(v.rig);
      if(v.model)scene.remove(v.model.obj);
      if(v.horse)scene.remove(v.horse.obj);
      remoteVis.delete(id); continue;
    }
    const st=net.remotes.get(id);
    const k=Math.min(1,dt*10);
    v.rx+=(st.x-v.rx)*k; v.rz+=(st.y-v.rz)*k;
    const _rd2=_d2.get(id) ?? 0;
    const _tooFar=_rd2>RD2;                 // render-distance cull
    const _animate=_mayAnimate.has(id);     // animation-LOD + nearest-N cap
    const visible=(!st.dead||st.ghost) && !_tooFar;
    const op=st.ghost?0.45:(st.hidden?0.25:1);
    const w=(st.weapon==='bow'||st.weapon==='axe'||st.weapon==='pickaxe')?st.weapon:'sword';
    if(v.model){
      const m=v.model;
      m.obj.visible=visible;
      m.obj.position.set(v.rx,st.onHorse?(horse?horse.rideH:50):0,v.rz);   // riders sit at saddle height
      turnToward(m.obj, st.dir, dt, 'remote');         // face the server-synced dir
      if(m.pendingAttack&&m.actions.attack){            // server-validated swing
        m.pendingAttack=false;
        if(m.actions[m.cur])m.actions[m.cur].fadeOut(0.08);
        m.actions.attack.reset().fadeIn(0.08).play(); m.cur='attack';
        m.busyUntil=t+Math.min(m.actions.attack.getClip().duration*0.85,1.2);
      }
      const catching=Math.hypot(st.x-v.rx,st.y-v.rz)>4;   // still gliding → walking
      if(t>=m.busyUntil) setRemoteAnim(m, st.onHorse?'idle':(catching?'walk':'idle'));
      // Skinning is the expensive half of a remote player. Past AD, or outside the
      // nearest-N cap, the pose simply freezes — at that distance the character is
      // a few pixels tall and nobody can tell.
      if(_animate) m.mixer.update(dt);
      setRigOpacity(m.mats, op);
      // A hidden model needs no weapon attached, and swapping props is not free.
      if(visible) remoteWeapon(v,w);
    }
    // their horse: under them while riding, standing where they left it
    const wantsHorse=(st.onHorse||st.horseDown)&&visible&&!_tooFar;
    if(SKINNING_OK&&wantsHorse&&!v.horse&&horseTemplate){
      const inner=SkeletonUtils.clone(horseTemplate);
      const obj=new THREE.Group(); obj.add(inner); scene.add(obj);
      const mixer=new THREE.AnimationMixer(inner);
      if(horseClip) mixer.clipAction(horseClip).play();
      v.horse={obj,mixer};
    }
    if(v.horse){
      v.horse.obj.visible=wantsHorse;
      if(st.onHorse){
        v.horse.obj.position.set(v.rx,0,v.rz);
        if(v.model) v.horse.obj.rotation.y=v.model.obj.rotation.y;
        if(_animate) v.horse.mixer.update(dt);
      }else if(st.horseDown){
        v.horse.obj.position.set(st.horseX,0,st.horseY);
        if(_animate) v.horse.mixer.update(dt*0.35);
      }
    }
    if(v.model){}else if(v.rig){
      v.rig.visible=visible;   // `visible` already carries the render-distance cull
      v.rig.position.set(v.rx,heightAt(v.rx,v.rz),v.rz);
      if(v.lw!==w){ applyProp(v.rig,w,18,34,11); v.lw=w; }
      animateRig(v.rig,v.rx,v.rz,t,{turn:true});
      setRigOpacity(v.rig.userData.mats, op);
    }
  }
}
// ── Server-authoritative mobs ──────────────────────────────────────
// While online, the overworld wolves/bandits come from the server: they're
// mirrored into the local `enemies` array as pseudo-enemies (srv:true) so
// every existing system — rendering, targeting, gambits, radial menu,
// swings, arrows — works unchanged. Local AI/damage is skipped for them;
// damageEnemy routes hits to the server via hooks.srvMobHit.
const srvMobs=new Map();   // mobId -> pseudo-enemy in `enemies`
let localMobsCulled=false;
function syncServerMobs(dt){
  if(net.status!=='online'||net.mobs.size===0){
    if(localMobsCulled){                       // went offline: drop server mirrors,
      for(let i=enemies.length-1;i>=0;i--) if(enemies[i].srv) enemies.splice(i,1);
      srvMobs.clear(); localMobsCulled=false;  // local population refills over time
    }
    return;
  }
  if(!localMobsCulled){ localMobsCulled=true;  // connected: retire the local packs
    for(let i=enemies.length-1;i>=0;i--){const e=enemies[i];
      if(!e.srv&&(e.type==='wolf'||e.type==='bandit')&&!e.isChamp&&!e.customId) enemies.splice(i,1);}
  }
  for(const [id,ms] of net.mobs){
    let e=srvMobs.get(id);
    if(!e){
      const wolf=ms.type==='wolf';
      e={srv:true,srvId:id,type:ms.type,x:ms.x,y:ms.y,hp:ms.hp,maxHp:ms.maxHp,
        r:wolf?11:13,speed:wolf?140:75,damage:wolf?8:15,
        aggroRange:TILE*(wolf?4:6),attackRange:TILE*(wolf?1.1:1.3),
        attackCooldown:wolf?1.1:1.4,attackTimer:1,iframes:0,state:'idle',
        deadTimer:0,respawnTimer:0,spawnX:ms.x,spawnY:ms.y,wanderTimer:0,
        rangedTimer:0,abilityTimer:0,stunTimer:0,fleeing:false};
      srvMobs.set(id,e); enemies.push(e);
    }
    e.x=ms.x; e.y=ms.y; e.hp=ms.hp; e.maxHp=ms.maxHp;
    e.state=ms.dead?'dead':'idle';
    if(e.iframes>0)e.iframes-=dt;
    if(e.attackTimer>0)e.attackTimer-=dt;
  }
}
hooks.srvMobHit=(e,dmg)=>netMobHit(e.srvId,Math.round(dmg));

// chat log (bottom-left) + input, styled to match the HUD
const chatLogDiv=document.createElement('div');
chatLogDiv.style.cssText='position:fixed;left:10px;bottom:132px;z-index:4;max-width:360px;'+
  'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#e8dcc0;'+
  'text-shadow:0 1px 2px #000;pointer-events:none;user-select:none;';
document.body.appendChild(chatLogDiv);
const chatIn=document.createElement('input');
chatIn.id='bravoChatIn'; chatIn.maxLength=140; chatIn.placeholder='say something… (Enter)';
chatIn.style.cssText='position:fixed;left:10px;bottom:104px;z-index:5;width:280px;display:none;'+
  'font:13px ui-monospace,Menlo,Consolas,monospace;color:#f0e6c8;background:rgba(10,8,4,.92);'+
  'border:1px solid #c8a25a;border-radius:4px;padding:5px 8px;outline:none;';
document.body.appendChild(chatIn);
function openChatInput(){ if(net.status!=='online')return; chatIn.style.display='block'; chatIn.focus(); }
function closeChatInput(){ chatIn.style.display='none'; chatIn.value=''; chatIn.blur(); grabFocus(); }
chatIn.addEventListener('keydown',e=>{
  e.stopPropagation();                              // keep game keys out of typing
  if(e.key==='Enter'){ const txt=chatIn.value.trim(); if(txt) netChat(txt); closeChatInput(); }
  else if(e.key==='Escape') closeChatInput();
});
function renderChatLog(){
  chatLogDiv.innerHTML='';
  for(const m of net.chatLog.slice(-6)){
    const row=document.createElement('div');
    const b=document.createElement('b'); b.textContent=m.name+': ';
    row.appendChild(b); row.appendChild(document.createTextNode(m.text));
    chatLogDiv.appendChild(row);
  }
}
const mpHud=document.createElement('div');
document.getElementById('hud')?.appendChild(mpHud);
function updateMpHud(){
  mpHud.textContent = net.status==='online' ? '🌐 '+net.onlineCount+' online · Enter to chat'
    : net.nameRejected ? '📛 name "'+playerName()+'" is taken — pick another'
    : (net.status==='connecting' ? '🌐 connecting…' : '📴 offline');
}
// Joining the shared world makes you a visible, attackable body in it. Two things
// must be true before that is fair:
//   1. the models are in     -- otherwise you stand there unable to see the world
//   2. a character is chosen -- otherwise you stand there unable to MOVE, because
//                               character select blocks input while it is open
// The first pass only gated on (1) and left the second window open.
let _netStarted = false;
function maybeStartNet(){
  if(_netStarted || !MP_ENABLED) return;
  if(G.charSelectOpen || G.charCreatorOpen) return;   // still picking who to be
  _netStarted = true;
  bootScreen.whenReady(startNet);                     // ...and only once assets are in
}
function startNet(){
  initNet(()=>({ x:player.x, y:player.y,
    dir: protag?protag.obj.rotation.y:plrGrp.rotation.y,
    weapon: player.weapon||'sword', dead:!!player.dead, ghost:!!player.ghost,
    onHorse:!!player.onHorse, hidden:!!(skills.hiding&&skills.hiding.active),
    horseDown:!!(player.hasHorse&&player.horseDown), horseX:player.horseX||0, horseY:player.horseY||0,
    hp:player.hp|0, maxHp:player.maxHp|0 }));
}
if(MP_ENABLED){
  net.onChat=m=>{
    renderChatLog();
    if(m.feed) return;                                   // kill feed: log only
    if(m.name===playerName()) addFloater(player.x,player.y-40,'💬 '+m.text);
    else for(const [,st] of net.remotes) if(st.name===m.name){ addFloater(st.x,st.y-40,'💬 '+m.text); break; }
  };
  // server-validated PvP hit: victim takes the damage through the normal
  // damage path (armor DR + iframes apply); everyone sees the strike
  net.onPvpHit=m=>{
    remoteAttackCue(m.from);                     // play the attacker's swing anim
    if(m.to===net.selfId){
      const from=net.remotes.get(m.from);
      damagePlayer(m.dmg);
      addFloater(player.x,player.y-52,'⚔ '+(from?from.name:'someone')+' strikes you!');
    }else{
      const tgt=net.remotes.get(m.to);
      if(tgt) addFloater(tgt.x,tgt.y-40,m.from===net.selfId?'⚔ hit!':'⚔');
    }
  };
  // server mob events: swings hurt their target; deaths drop loot for the
  // server-decided killer only (no dupe farming)
  net.onMobAtk=m=>{
    const e=srvMobs.get(m.id);
    if(e) e.attackTimer=e.attackCooldown;          // plays the swing anim
    if(m.to===net.selfId){
      damagePlayer(m.dmg);
    }
  };
  net.onMobDead=m=>{
    const e=srvMobs.get(m.id);
    if(!e) return;
    if(m.killer===net.selfId){
      spawnDrops(e);                                // loot is yours
      if(hooks.onKill) hooks.onKill(e);             // quest credit
      snd.enemyDie();
    }
  };
  net.onHouses=list=>applyServerHouses(list);       // shared houses
  net.onPlacedObjects=list=>{                       // shared persistent placed items (torches, lanterns, forges, etc.)
    if(Array.isArray(list)){
      placedObjects.length=0;
      for(const o of list){
        const p={id:o.id,type:o.type,x:o.x,y:o.y,owner:o.owner};
        // Only `face` crosses the wire; mountY is derivable from the registry, so
        // the server never has to know about it. Rebuilding the object field by
        // field is why this needs saying — a plain copy would have dropped it.
        if(o.face && FACE_DIR[o.face]){
          p.face=o.face;
          p.mountY=(PLACEABLES[o.type]&&PLACEABLES[o.type].wallY)||WALL_H*0.6;
        }
        // litAt is what makes burnout agree across clients — it's an absolute
        // world-clock stamp, so everyone derives the same remaining fuel.
        if(o.litAt>0) p.litAt=o.litAt;
        placedObjects.push(p);
      }
      placedObjectsDirty=true;
    }
  };
  // server save = source of truth: on join, adopt the server's copy of our
  // gold/inventory/skills/position (anti-tamper, and no lost loot on reconnect)
  // Adopt the server's clock so everyone shares one sky (sent on join, then
  // re-broadcast every 60s to correct drift).
  net.onWorldTime=m=>{ if(m&&m.t) setServerWorldTime(m.t); };
  net.onSave=blob=>{
    if(!blob) return;
    loadGame(blob);
    addFloater(player.x,player.y-40,'☁ progress restored from server');
  };
  // shared ground drops
  net.onDropAdd=m=>{ if(drops.some(d=>d.srvId===m.id))return; drops.push({srvId:m.id,type:m.type,count:m.count,x:m.x,y:m.y}); };
  net.onDropGone=m=>{ const i=drops.findIndex(d=>d.srvId===m.id); if(i>=0)drops.splice(i,1); };
  net.onDropGot=m=>{ invAdd(m.type,m.count); addFloater(player.x,player.y-24,'+'+m.count+' '+m.type); snd.pickup(); };
  // trading
  net.onTradeInvite=m=>{ G.tradeInvite={from:m.from,name:m.name,t:performance.now()}; addFloater(player.x,player.y-40,'🤝 '+m.name+' wants to trade (see prompt)'); };
  net.onTradeStart=m=>{ openTrade(m.with,m.name); };
  net.onTradeUpdate=m=>{ if(!G.trade)return; G.trade.their=m.theirOffer; G.trade.myConf=m.youConfirmed; G.trade.theirConf=m.theyConfirmed; };
  net.onTradeDone=m=>{ applyTradeSwap(m.give,m.get); closeTrade(true); };
  net.onTradeEnd=m=>{ if(G.trade){ addFloater(player.x,player.y-30,'trade cancelled'); closeTrade(false);} G.tradeInvite=null; };
  updateMpHud(); setInterval(updateMpHud,2000);
}

// ── Game loop ──────────────────────────────────────────────────────
let lastT=0;
function loop(t=0){
  fpsSample(t);
  maybeStartNet();   // no-op after the first successful start
  releaseLookForUI();
  requestAnimationFrame(loop);const raw=t-lastT;const dt=Math.min(raw/1000,0.05);lastT=t;
  fpFreeLookEdge(dt);   // keep turning while the cursor is pinned to a window edge
  _perf.push(raw); if(!HEADLESS) frameTick(raw);   // frameTick drives the auto-demote watchdog
  update(dt);render3D(t/1000);
}

// ── Boot ───────────────────────────────────────────────────────────
G.gameTime = worldNow();   // start on the shared clock, not at 00:00
findClearSpawn();
const acc = AccountManager.getAccount();
const activeSlot = AccountManager.getActiveSlot();
if(activeSlot && activeSlot.saveBlob) {
  loadGame(activeSlot.saveBlob);
} else {
  loadGame();
}
G.charSelectOpen = true;
populateWorld();
populateDungeon();
// spawn the editor-placed custom mobs (persist + respawn like natives)
for(const s of worldEdits.spawns){
  const e=makeEnemy(s.t,s.x,s.y);
  if(e){e.customId=s.id;enemies.push(e);}
}
// first launch: open the tutorial (T reopens it any time)
try{ if(!localStorage.getItem(TUT_SEEN_KEY)) G.tutorialOpen=true; }catch(_){}
initDevCommands();

// ── FX visibility group (for the GTAO prepass) ────────────────────
// GTAOPass renders a normal+depth prepass with an override material and does
// NOT exclude transparent materials, nor does it expose a layer mask. Additive
// effects have no meaningful surface — a flame billboard would write the normal
// of a flat card floating in mid-air — so leaving them in makes the pass
// occlude geometry against ghosts.
//
// This is NOT a real THREE.Group. Reparenting ~300 meshes created across dozens
// of sites (pooled flames, portals, spark systems, altar glows, the sky dome,
// the starfield) would touch far more code than it's worth and would reorder
// the transparent queue as a side effect. composer.js only ever reads and
// writes `.visible`, so an object honouring that contract does the job with no
// structural change at all.
const fxGroup = (() => {
  const list = [];
  const saved = [];
  let hidden = false;
  return {
    add(o){ if(o && list.indexOf(o) === -1) list.push(o); },
    clear(){ list.length = 0; },
    count(){ return list.length; },
    get visible(){ return !hidden; },
    set visible(v){
      if(!v && !hidden){
        saved.length = 0;
        for(const o of list){ saved.push(o.visible); o.visible = false; }
        hidden = true;
      } else if(v && hidden){
        for(let i = 0; i < list.length; i++) list[i].visible = saved[i];
        hidden = false;
      }
    },
  };
})();
// Collected by traversal rather than at each creation site, so effects added
// later are picked up without anyone remembering to register them.
// Additive blending is the right test: the ~2400 character-rig materials are
// `transparent:true` but are solid-looking figures that SHOULD occlude, so
// filtering on transparency instead would wrongly drop every NPC out of AO.
function refreshFxList(){
  fxGroup.clear();
  scene.traverse(o => {
    if(!o.isMesh && !o.isPoints && !o.isSprite) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for(const m of mats){
      if(m && m.blending === THREE.AdditiveBlending){ fxGroup.add(o); break; }
    }
  });
  // depthWrite:false already keeps water out of the depth buffer, but the
  // prepass uses an override material that ignores that.
  fxGroup.add(waterMesh);
  return fxGroup.count();
}

// ── Postprocessing ────────────────────────────────────────────────
// Created last because it's async (the addons are dynamically imported so the
// low tier never downloads them) and because it needs the finished scene.
// On low this returns a passthrough that just calls renderer.render, so the
// mobile path costs exactly what it did before.
// fxGroup is built from additive-blending meshes by traversal (refreshFxList
// above) and passed in so the GTAO prepass can hide effects during its depth
// pass.  Ultra tier enables GTAO; all lower tiers skip it.
console.log('[gfx] fx meshes excluded from the AO prepass:', refreshFxList());
rndr = await createComposer({ THREE, renderer, scene, camera, settings: QS, fxGroup });
rndr.setPixelRatio(Math.min(devicePixelRatio, QS.pixelRatio));
rndr.setSize(innerWidth, innerHeight);
console.log('[gfx] tier', getTier(), '·', rndr.passes().join(' → '));

// Tier changes rebuild the composer and push the new knobs at everything that
// caches them. Hot-swappable on purpose: comparing tiers with a page reload in
// between is useless, because the reload also moves the sun and the weather.
onTierChange((tier, s) => {
  QS = s;
  renderer.setPixelRatio(Math.min(devicePixelRatio, QS.pixelRatio));
  renderer.shadowMap.enabled = QS.shadows;
  renderer.shadowMap.type = QS.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if(QS.shadowMapSize) sun.shadow.mapSize.set(QS.shadowMapSize, QS.shadowMapSize);
  // The shadow map is only reallocated if the old target is thrown away.
  if(sun.shadow.map){ sun.shadow.map.dispose(); sun.shadow.map = null; }
  sky.setSettings(QS); water.setSettings(QS);
  _grassDirty = true;   // density is tier-driven, so the field has to be re-laid
  const sizeIt = () => { rndr.setPixelRatio(Math.min(devicePixelRatio, QS.pixelRatio));
                         rndr.setSize(innerWidth, innerHeight);
                         console.log('[gfx] tier →', tier, '·', (rndr.passes().join(' → ')||'passthrough')); };
  // rebuild() is synchronous and therefore cannot resurrect a passthrough — the
  // addons are dynamically imported, so going from a composer-less tier back to
  // a composer tier has to re-await createComposer. Without this, one trip
  // through `low` (which the auto-demote watchdog can do on its own) left the
  // session permanently unable to get bloom or AA back.
  if(rndr && QS.composer && rndr.passes().length === 0){
    refreshFxList();
    createComposer({ THREE, renderer, scene, camera, settings: QS, fxGroup })
      .then(c => { rndr = c; sizeIt(); });
  } else if(rndr){ rndr.rebuild(QS); sizeIt(); }
});
// #headless: timer-driven loop for testing — runs even in hidden tabs,
// where the browser suspends requestAnimationFrame entirely
if(HEADLESS)
  window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),33);
loop();
