// input.js — one control surface, three ways to drive it.
//
// The phone scheme is the one everything else is designed around, because it is
// the constrained case:
//
//   • Steering is a RELATIVE analog drag, not a fixed on-screen stick. Wherever
//     the thumb lands becomes centre, and displacement from there is edge
//     angle. Fixed sticks force the player to look at their thumb; a relative
//     drag can be used blind, which is the only kind of control that survives
//     a 90 km/h descent on a 6-inch screen.
//   • Centre pulls back when the thumb stops moving, so a held carve decays to
//     neutral instead of the player having to unwind an arbitrary offset.
//   • ONE action button. Tap it to ollie, keep holding it to grab. Two verbs,
//     one thumb, no dead zone between them.
//
// Keyboard and gamepad feed the same struct so nothing downstream cares.

export class Input {
  constructor(target, opts = {}) {
    this.target = target;
    this.state = { steer: 0, jump: false, grab: false, brake: false };
    this._jumpQueued = false;
    this._jumpConsumed = true;

    this.touchSteer = 0;
    this.touchId = null;
    this.originX = 0;
    this.lastX = 0;
    this.travel = 0;               // px of thumb travel — a tap must be short
    this.pressT = 0;

    this.actionHeld = false;
    this.actionId = null;

    this.tiltEnabled = false;
    this.tiltZero = null;
    this.tilt = 0;

    this.keys = new Set();
    this.enabled = false;
    this.sensitivity = opts.sensitivity ?? 1;

    this._bind();
  }

  _bind() {
    const t = this.target;

    // Steering surface — the whole canvas except where the action button is.
    t.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.target.closest && e.target.closest('[data-action-button]')) return;
      if (this.touchId !== null) return;
      this.touchId = e.pointerId;
      this.originX = this.lastX = e.clientX;
      this.travel = 0;
      this.pressT = performance.now();
      t.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }, { passive: false });

    t.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.touchId) return;
      const dx = e.clientX - this.lastX;
      this.travel += Math.abs(dx);
      this.lastX = e.clientX;
      // Recentre slowly: the origin chases the thumb, so a long drag in one
      // direction never runs out of screen.
      const span = Math.max(70, Math.min(180, window.innerWidth * 0.20)) / this.sensitivity;
      let s = (e.clientX - this.originX) / span;
      s = Math.max(-1, Math.min(1, s));
      this.touchSteer = s;
      e.preventDefault();
    }, { passive: false });

    const up = (e) => {
      if (e.pointerId !== this.touchId) return;
      // A short press that barely moved is a tap → ollie. This is what lets the
      // action button be optional rather than mandatory.
      if (this.travel < 14 && performance.now() - this.pressT < 260) this._jumpQueued = true;
      this.touchId = null;
      this.touchSteer = 0;
      e.preventDefault();
    };
    t.addEventListener('pointerup', up, { passive: false });
    t.addEventListener('pointercancel', up, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        this._jumpQueued = true;
        e.preventDefault();
      }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'ArrowDown') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.touchId = null; this.touchSteer = 0; this.actionHeld = false; });
  }

  /** Wire an on-screen button as ollie (tap) and grab (hold). */
  bindActionButton(el) {
    el.setAttribute('data-action-button', '');
    const down = (e) => {
      if (!this.enabled) return;
      this.actionId = e.pointerId;
      this.actionHeld = true;
      this._jumpQueued = true;
      el.classList.add('is-held');
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    };
    const up = (e) => {
      if (e.pointerId !== this.actionId) return;
      this.actionHeld = false;
      this.actionId = null;
      el.classList.remove('is-held');
      e.preventDefault(); e.stopPropagation();
    };
    el.addEventListener('pointerdown', down, { passive: false });
    el.addEventListener('pointerup', up, { passive: false });
    el.addEventListener('pointercancel', up, { passive: false });
  }

  /** Wire a brake / speed-check button. */
  bindBrakeButton(el) {
    el.setAttribute('data-action-button', '');
    const set = (v) => (e) => {
      this._brakeHeld = v;
      el.classList.toggle('is-held', v);
      e.preventDefault(); e.stopPropagation();
    };
    el.addEventListener('pointerdown', set(true), { passive: false });
    el.addEventListener('pointerup', set(false), { passive: false });
    el.addEventListener('pointercancel', set(false), { passive: false });
  }

  // ── Tilt ────────────────────────────────────────────────────────
  async enableTilt() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const r = await DOE.requestPermission();
        if (r !== 'granted') return false;
      } catch { return false; }
    }
    window.addEventListener('deviceorientation', this._onTilt = (e) => {
      // gamma is roll in landscape, beta in portrait — pick whichever axis the
      // current orientation actually maps to left/right.
      const portrait = window.innerHeight >= window.innerWidth;
      const raw = portrait ? (e.gamma || 0) : -(e.beta || 0);
      if (this.tiltZero === null) this.tiltZero = raw;
      this.tilt = Math.max(-1, Math.min(1, (raw - this.tiltZero) / 26));
    });
    this.tiltEnabled = true;
    return true;
  }

  disableTilt() {
    if (this._onTilt) window.removeEventListener('deviceorientation', this._onTilt);
    this.tiltEnabled = false;
    this.tiltZero = null;
    this.tilt = 0;
  }

  recentreTilt() { this.tiltZero = null; }

  // ── Per-frame poll ──────────────────────────────────────────────
  poll(dt) {
    const s = this.state;
    let steer = 0;

    if (this.keys.size) {
      if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) steer -= 1;
      if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) steer += 1;
    }
    if (this.touchId !== null) steer += this.touchSteer;
    else if (this.tiltEnabled) steer += this.tilt;

    // Gamepad, if one is plugged in. Free to support and nice on desktop.
    // Its buttons are read into their OWN flags and OR'd in at the end rather
    // than written to the shared held-state: a pad reporting "not pressed" must
    // never cancel a thumb that is holding the on-screen button.
    let padGrab = false, padBrake = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.14) steer += ax;
      const a = !!p.buttons[0]?.pressed;
      if (a && !this._padA) this._jumpQueued = true;
      this._padA = a;
      padGrab = a;
      padBrake = !!(p.buttons[6]?.pressed || p.buttons[1]?.pressed);
      break;
    }

    s.steer = Math.max(-1, Math.min(1, steer));
    s.jump = this._jumpQueued;
    this._jumpQueued = false;
    s.grab = this.actionHeld || padGrab ||
      this.keys.has('Space') || this.keys.has('KeyW') || this.keys.has('ArrowUp');
    s.brake = !!this._brakeHeld || padBrake ||
      this.keys.has('ArrowDown') || this.keys.has('KeyS');
    return s;
  }

  reset() {
    this._jumpQueued = false;
    this.touchId = null;
    this.touchSteer = 0;
    this.actionHeld = false;
    this._brakeHeld = false;
    this.keys.clear();
  }
}
