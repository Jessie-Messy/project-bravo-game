// physics.js — the ride.
//
// The whole sim is BALLISTIC-FIRST: every frame integrates full 3D velocity
// under gravity and only then asks whether the board ended up below the snow.
// If it did, the contact is resolved; if it did not, the rider is in the air.
// Nothing anywhere decides "now you jump" — going airborne off a roller, a
// mogul, a kicker lip or a cliff band all fall out of the same three lines,
// which is why the terrain features in course.js work without physics knowing
// they exist.
//
// Heading convention matches course.js: yaw 0 points down the fall line (-Z),
// and forward = (sin yaw, 0, -cos yaw).

import { PHYS, SCORE } from './config.js';
import { CHUNK_LEN } from './course.js';
import { SNOW_TYPES } from './data/runs.js';

const UP = { x: 0, y: 1, z: 0 };

function angDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export class Ride {
  constructor(course, handling, run) {
    this.course = course;
    this.h = handling;
    this.run = run;
    this.snow = SNOW_TYPES[run.snow] || SNOW_TYPES.groomed;
    this.events = [];               // drained by main.js each frame

    const c = course.centreAt(0);
    this.pos = { x: c, y: course.height(c, 0) + 0.2, z: 0 };
    this.vel = { x: 0, y: 0, z: -6 };
    this.yaw = 0;
    this.edge = 0;
    this.edgeTarget = 0;
    this.grounded = true;
    this.airTime = 0;
    this.lastAirTime = 0;
    this.groundNormal = { x: 0, y: 1, z: 0 };
    this.slip = 0;
    this.crashT = 0;
    this.crashCooldown = 0;
    this.spinAccum = 0;
    this.spinDir = 0;
    this.grab = 0;
    this.grabType = 0;
    this.onRail = 0;
    this.switchRiding = false;

    this.score = 0;
    this.pending = 0;               // in-air points, banked on a clean landing
    this.combo = 1;
    this.comboTimer = 0;
    this.tricks = [];
    this.stats = { topSpeed: 0, airTotal: 0, biggestAir: 0, tricksLanded: 0, crashes: 0, distance: 0 };

    this.finished = false;
    this.started = false;
    this.time = 0;
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.y, this.vel.z); }
  get groundSpeed() { return Math.hypot(this.vel.x, this.vel.z); }
  get distance() { return -this.pos.z; }

  emit(type, data) { this.events.push({ type, ...data }); }

  /**
   * @param input {steer:-1..1, jump:bool(edge-triggered), grab:bool, brake:bool}
   */
  update(dt, input) {
    if (this.finished) dt = Math.min(dt, 0.033);
    const course = this.course, h = this.h;
    this.time += dt;

    if (this.crashT > 0) return this._updateCrash(dt);

    // ── Steering intent ───────────────────────────────────────────
    const steer = clamp(input.steer || 0, -1, 1);
    this.edgeTarget = steer;
    const resp = PHYS.EDGE_RESPONSE * (this.grounded ? 1 : 0.55);
    this.edge += (this.edgeTarget - this.edge) * Math.min(1, resp * dt);

    if (this.grounded) this._updateGround(dt, input, steer);
    else this._updateAir(dt, input, steer);

    // ── Integrate ─────────────────────────────────────────────────
    this.vel.y -= PHYS.GRAVITY * dt;

    // Quadratic air drag, weighted by how tucked the rider is. Riding flat and
    // straight is genuinely faster than riding on edge, which is what makes a
    // cat track a decision rather than a corridor.
    const sp = this.speed;
    const tuck = 1 - Math.abs(this.edge) * 0.55;
    const drag = PHYS.AIR_DRAG * h.drag * (1.55 - 0.55 * tuck) * sp * sp;
    if (sp > 0.001) {
      const f = Math.min(1, drag * dt / sp);
      this.vel.x -= this.vel.x * f; this.vel.y -= this.vel.y * f; this.vel.z -= this.vel.z * f;
    }

    const topSpeed = PHYS.MAX_SPEED * h.topSpeed;
    if (sp > topSpeed) {
      const k = topSpeed / sp;
      this.vel.x *= k; this.vel.y *= k; this.vel.z *= k;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    // ── Contact ───────────────────────────────────────────────────
    const gh = course.height(this.pos.x, this.pos.z);
    const n = course.normal(this.pos.x, this.pos.z, this.groundNormal);
    const sink = this.snow.sink * (1.1 - h.float * 0.55);
    const surface = gh - sink;

    if (this.pos.y <= surface + 0.02) {
      this._resolveContact(surface, n, dt);
    } else {
      if (this.grounded) { this.grounded = false; this.airTime = 0; this.spinAccum = 0; }
      this.airTime += dt;
    }

    // ── Obstacles ─────────────────────────────────────────────────
    // Checked after integration, against the board's own position: a tree is
    // only in the way if you are below its canopy, so clearing one off a cliff
    // drop is a legitimate line.
    if (this.crashCooldown <= 0 && this.groundSpeed > 5) this._checkObstacles();

    // ── Bookkeeping ───────────────────────────────────────────────
    this.stats.topSpeed = Math.max(this.stats.topSpeed, this.groundSpeed);
    this.stats.distance = Math.max(this.stats.distance, this.distance);
    if (!this.grounded) this.stats.airTotal += dt;
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) { this.combo = 1; this.emit('comboEnd'); }
    }
    if (this.crashCooldown > 0) this.crashCooldown -= dt;

    if (!this.started && this.distance > 1) { this.started = true; this.emit('start'); }
    if (!this.finished && this.distance >= course.length) {
      this.finished = true;
      this.emit('finish');
    }
    return null;
  }

  _updateGround(dt, input, steer) {
    const course = this.course, h = this.h, n = this.groundNormal;

    // Gravity projected onto the slope plane: g - (g·n)n. This is the entire
    // reason a steeper pitch is faster, with no special-casing anywhere.
    const gdotn = -PHYS.GRAVITY * n.y;
    const ax = -gdotn * n.x;
    const ay = -PHYS.GRAVITY - gdotn * n.y;
    const az = -gdotn * n.z;
    this.vel.x += ax * dt;
    this.vel.z += az * dt;
    this.vel.y += (ay + PHYS.GRAVITY) * dt;    // gravity itself is added later

    const gs = this.groundSpeed;

    // Turning. You cannot steer a board that is not moving, and the turn rate
    // falls off at the very top end the way real edge hold does.
    const speedAuth = clamp(gs / 7, 0, 1) * (1 - clamp((gs - 30) / 40, 0, 0.35));

    // Below walking pace there is no edge authority left, so a player who
    // over-turned and stalled across the fall line would be stuck facing
    // sideways forever with no input that could rescue them. Pivot the board
    // back downhill — which is exactly what a real rider does, by hopping the
    // tail around — and scale the edge scrub out at the same time so a held
    // edge cannot pin them to the slope.
    if (gs < 5.5) {
      const err = angDiff(this.course.headingAt(this.distance), this.yaw);
      this.yaw += err * Math.min(1, (1 - gs / 5.5) * 2.4 * dt);
    }
    const gripSnow = this.snow.grip;
    const turn = PHYS.TURN_RATE * h.turnRate * this.edge * speedAuth * gripSnow * dt;
    this.yaw += turn;

    // Carve vs drift. The velocity heading chases the board heading at a rate
    // set by grip; whatever is left over is slip, and slip is what throws the
    // rooster tail and scrubs the speed.
    if (gs > 0.2) {
      const vYaw = Math.atan2(this.vel.x, -this.vel.z);
      const err = angDiff(this.yaw, vYaw);
      const grip = PHYS.CARVE_GRIP * h.grip * gripSnow * (this.onRail > 0 ? 1.4 : 1);
      const k = 1 - Math.exp(-grip * 9 * dt);
      const newYaw = vYaw + err * k;
      this.vel.x = Math.sin(newYaw) * gs;
      this.vel.z = -Math.cos(newYaw) * gs;
      this.slip = clamp(Math.abs(err) * (0.35 + Math.abs(this.edge)), 0, 1.6);
    } else {
      this.slip = 0;
    }

    // Friction: base + edge scrub + powder drag. Scaled by normal load so it
    // eases off over a roller crest.
    const load = clamp(n.y, 0.3, 1);
    let mu = PHYS.BASE_FRICTION * this.snow.friction;
    mu += PHYS.EDGE_FRICTION * this.slip * Math.abs(this.edge) * clamp(gs / 5.5, 0, 1);
    mu += PHYS.POWDER_DRAG * this.snow.drag * (1.15 - this.h.float * 0.75);
    if (input.brake) mu += 0.55;
    if (this.onRail > 0) mu = 0.02;                      // rails are slick
    const decel = mu * PHYS.GRAVITY * load * dt;
    if (gs > 0.001) {
      const f = Math.min(1, decel / gs);
      this.vel.x -= this.vel.x * f;
      this.vel.z -= this.vel.z * f;
    }

    // Carve scoring: held edge, real speed, actually gripping rather than
    // sliding sideways.
    if (Math.abs(this.edge) > 0.55 && gs > 14 && this.slip < 0.55) {
      this.score += SCORE.CARVE_PER_SEC * this.combo * dt * this.h.styleMult;
    }
    if (this.onRail > 0) {
      this.pending += 110 * dt * this.h.styleMult;
      this.onRail -= dt;
    }

    // Ollie
    if (input.jump) {
      const pop = PHYS.JUMP_POP * this.h.pop * (0.65 + 0.35 * clamp(gs / 20, 0, 1));
      // Half along the surface normal, half straight up: pop off a bank throws
      // you out from the wall, but never sideways enough to feel wrong.
      this.vel.x += n.x * pop * 0.5;
      this.vel.y += (n.y * 0.5 + 0.5) * pop;
      this.vel.z += n.z * pop * 0.5;
      this.grounded = false;
      this.airTime = 0;
      this.spinAccum = 0;
      this.emit('pop', { power: pop });
    }
  }

  _updateAir(dt, input, steer) {
    // Spin. Steering in the air rotates the board; the accumulated angle is
    // what the trick name is read off at touchdown.
    const rate = PHYS.AIR_SPIN_RATE * this.h.spinRate * steer * dt;
    this.yaw += rate;
    this.spinAccum += rate;

    // Grabs. Which grab you get is picked from how long you have been in the
    // air and which way you are spinning, so a run produces varied trick names
    // without asking a phone player to press four different buttons.
    if (input.grab) {
      if (this.grab < 0.01) this.grabType = (Math.abs(this.spinAccum) > 2 ? 1 : 0) + (this.airTime > 0.9 ? 2 : 0);
      this.grab = Math.min(1, this.grab + dt * 5);
      this.pending += SCORE.GRAB_PER_SEC * dt * this.h.styleMult;
    } else {
      this.grab = Math.max(0, this.grab - dt * 6);
    }
    this.pending += SCORE.AIR_PER_SEC * dt;
  }

  _resolveContact(surface, n, dt) {
    const wasAir = !this.grounded;
    const airT = this.airTime;

    // Impact speed along the surface normal.
    const vn = this.vel.x * n.x + this.vel.y * n.y + this.vel.z * n.z;

    // A near-vertical face that the rider is travelling INTO is a wall, not a
    // landing — crevasse walls, cliff faces, the inside of a chute.
    const gs = this.groundSpeed;
    const intoWall = n.y < 0.52 && gs > 9 &&
      (this.vel.x * n.x + this.vel.z * n.z) < -gs * 0.35;

    if (intoWall && this.crashCooldown <= 0) return this._crash('wall');

    this.pos.y = surface;

    if (wasAir && airT > 0.22) {
      // Landing. Two things can go wrong: landing sideways to your direction of
      // travel, or landing mid-rotation. Both are the same check.
      const vYaw = Math.atan2(this.vel.x, -this.vel.z);
      let err = Math.abs(angDiff(this.yaw, vYaw));
      const sw = err > Math.PI * 0.5;
      if (sw) err = Math.PI - err;             // a clean switch landing is fine
      const tol = PHYS.LAND_TOLERANCE * this.h.stability * (1 + clamp(1 - gs / 20, 0, 0.6));
      const hard = -vn > 15 + this.h.stability * 8;

      if ((err > tol || hard) && this.crashCooldown <= 0) {
        return this._crash(hard ? 'flat' : 'sideways');
      }
      this._land(airT, sw);
    } else if (wasAir) {
      this.grab = 0;
      this.pending = 0;
    }

    this.grounded = true;
    this.airTime = 0;
    this.spinAccum = 0;
    this.grab = 0;

    // Kill the into-surface velocity, keeping a little compression bounce so
    // rollers feel springy rather than absorbent.
    if (vn < 0) {
      const restitution = Math.min(0.18, Math.abs(vn) * 0.012);
      this.vel.x -= n.x * vn * (1 + restitution);
      this.vel.y -= n.y * vn * (1 + restitution);
      this.vel.z -= n.z * vn * (1 + restitution);
    }

    // Rail detection: standing on top of a rail feature keeps friction near
    // zero and racks up grind points.
    const d = this.distance, u = this.pos.x - this.course.centreAt(d);
    for (const f of (this.course.buckets.get(Math.floor(d / CHUNK_LEN)) || [])) {
      if (f.kind === 'rail' && d > f.d && d < f.d + f.len && Math.abs(u - f.off) < f.w * 1.1) {
        if (this.onRail <= 0) this.emit('grind');
        this.onRail = 0.25;
      }
    }
  }

  _land(airT, isSwitch) {
    this.lastAirTime = airT;
    this.stats.biggestAir = Math.max(this.stats.biggestAir, airT);
    this.switchRiding = isSwitch;

    // Trick name from the accumulated rotation, rounded to the nearest 180.
    const deg = Math.abs(this.spinAccum) * 180 / Math.PI;
    const steps = Math.round(deg / 180);
    let points = this.pending;
    let name = '';

    if (steps >= 1) {
      const spinDeg = steps * 180;
      const key = 'SPIN_' + spinDeg;
      points += SCORE[key] || (SCORE.SPIN_900 + (spinDeg - 900) * 2.2);
      name = (this.spinAccum > 0 ? 'FS ' : 'BS ') + spinDeg;
    } else if (airT > 0.55) {
      name = 'AIR';
    }
    if (this.grabType !== undefined && this.pending > 0 && this.grab > 0.3) {
      name = (name ? name + ' ' : '') + ['INDY', 'MELON', 'NOSEGRAB', 'TAIL'][this.grabType % 4];
    }
    if (airT > 1.6) { points += SCORE.BIG_AIR_BONUS; name = name ? name + ' — BIG AIR' : 'BIG AIR'; }
    if (isSwitch && name) name = 'SW ' + name;

    if (points > 1 && name) {
      const total = Math.round(points * this.combo * this.h.styleMult);
      this.score += total;
      this.combo = Math.min(SCORE.COMBO_MAX, this.combo + SCORE.COMBO_STEP);
      this.comboTimer = 3.2;
      this.stats.tricksLanded++;
      this.tricks.push({ name, points: total, at: this.time });
      this.emit('trick', { name, points: total, combo: this.combo, airT });
    }
    this.pending = 0;
  }

  _checkObstacles() {
    const k = this.course.colliderKey(this.distance);
    const x = this.pos.x, z = this.pos.z, y = this.pos.y;
    // Two buckets so a collider straddling a boundary is never missed.
    for (let b = 0; b < 2; b++) {
      const list = this.course.colliderBucket(k + b);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (y > c.top) continue;                 // cleared it — that is a line
        const dx = x - c.x, dz = z - c.z;
        if (dx * dx + dz * dz < c.r2) { this._crash('tree'); return; }
      }
    }
  }

  _crash(reason) {
    this.stats.crashes++;
    this.score = Math.max(0, this.score - Math.round(this.pending * SCORE.CRASH_PENALTY));
    this.pending = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.crashT = 1.55;
    this.crashCooldown = 2.4;
    this.grounded = true;
    this.grab = 0;
    const keep = PHYS.CRASH_SPEED_KEEP;
    this.vel.x *= keep; this.vel.z *= keep;
    this.vel.y = Math.min(this.vel.y, 0) * 0.2;
    this.emit('crash', { reason });
    return 'crash';
  }

  _updateCrash(dt) {
    this.crashT -= dt;
    const course = this.course;
    // Slide out along the fall line, bleeding off what speed is left.
    this.vel.y -= PHYS.GRAVITY * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
    const gh = course.height(this.pos.x, this.pos.z);
    if (this.pos.y < gh) {
      this.pos.y = gh;
      this.vel.y = 0;
      const f = Math.min(1, 2.6 * dt);
      this.vel.x -= this.vel.x * f;
      this.vel.z -= this.vel.z * f;
    }
    course.normal(this.pos.x, this.pos.z, this.groundNormal);
    this.edge *= 0.9;

    if (this.crashT <= 0) {
      // Get up pointed down the hill, with just enough speed to keep going.
      this.crashT = 0;
      this.yaw = this.course.headingAt(this.distance);
      const gs = Math.max(6, this.groundSpeed);
      this.vel.x = Math.sin(this.yaw) * gs;
      this.vel.z = -Math.cos(this.yaw) * gs;
      this.emit('recover');
    }
    return 'crash';
  }

  /** Fraction of the course completed, 0..1. */
  get progress() { return clamp(this.distance / this.course.length, 0, 1); }
}
