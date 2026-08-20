// ui.js — screens, HUD and saved progress.
//
// Built in JS rather than written into the HTML so the entry file stays a dozen
// lines and every card, run row and stat bar comes from the same data the game
// reads. Adding a board to gear.js puts a board in the picker; there is no
// second place to update.
//
// The screen flow is deliberately flat — home is a hub with three tappable
// summary rows, not a wizard. On a phone, one tap to the thing you want to
// change beats four taps through a sequence you did not want to repeat.

import { BOARDS, RIDERS } from './data/gear.js';
import { RUNS, GRADE_META } from './data/runs.js';
import { TIERS, getTier, setTier, IS_TOUCH } from './config.js';
import * as audio from './audio.js';

const SAVE_KEY = 'bravoSnowSave_v1';

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
const fmtTime = (s) => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
};
const stars = (n) => Array.from({ length: 3 }, (_, i) =>
  `<span class="${i < n ? '' : 'off'}">★</span>`).join('');

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* private mode — run without persistence */ }
  return { rider: RIDERS[0].id, board: BOARDS[0].id, run: RUNS[0].id, bests: {}, tilt: false, muted: false };
}
export function writeSave(s) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export class UI {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.save = loadSave();
    this.sel = {
      rider: RIDERS.find(r => r.id === this.save.rider) || RIDERS[0],
      board: BOARDS.find(b => b.id === this.save.board) || BOARDS[0],
      run: RUNS.find(r => r.id === this.save.run) || RUNS[0],
    };
    if (!this.save.bests) this.save.bests = {};   // saves written before bests existed
    this.screens = {};
    this._build();
    this.show('home');
  }

  // ── Construction ────────────────────────────────────────────────
  _build() {
    this._buildHome();
    this._buildPicker('rider', 'Rider', RIDERS, this._riderCard.bind(this));
    this._buildPicker('board', 'Board', BOARDS, this._boardCard.bind(this));
    this._buildRuns();
    this._buildHud();
    this._buildPause();
    this._buildResults();
  }

  _screen(id) {
    const s = el('section', 'screen');
    s.id = 'screen-' + id;
    this.root.appendChild(s);
    this.screens[id] = s;
    return s;
  }

  _topbar(title, backTo) {
    const bar = el('div', 'topbar');
    if (backTo) {
      const b = el('button', 'btn icon ghost', '←');
      b.setAttribute('aria-label', 'Back');
      b.onclick = () => { audio.sfx.ui(); this.show(backTo); };
      bar.appendChild(b);
    }
    bar.appendChild(el('div', 'crumb', title));
    bar.appendChild(el('div', 'spacer'));
    return bar;
  }

  _buildHome() {
    const s = this._screen('home');
    s.appendChild(el('div', 'topbar', '<div class="crumb">Project Bravo</div>'));

    const hero = el('div');
    hero.style.cssText = 'flex:1;display:flex;flex-direction:column;justify-content:flex-end;min-height:0';
    hero.appendChild(el('div', 'eyebrow', 'Snowboarding'));
    hero.appendChild(el('h1', 'title', 'ALPENGLOW'));
    hero.appendChild(el('p', 'sub', 'Ten real mountains, from a Zermatt glacier boulevard to the throat of Corbet’s Couloir. Pick your rider, pick your board, drop in.'));
    s.appendChild(hero);

    // Three summary rows, each a shortcut straight into its picker.
    const summary = el('div');
    summary.style.cssText = 'display:grid;gap:9px;margin:16px 0 12px';
    this.rows = {};
    for (const [key, label] of [['rider', 'Rider'], ['board', 'Board'], ['run', 'Run']]) {
      const r = el('button', 'row');
      r.style.cssText += 'width:100%;text-align:left;cursor:pointer;font-family:inherit;color:inherit';
      r.innerHTML = `<span style="color:var(--dim);font-size:11px;letter-spacing:.13em;text-transform:uppercase;font-weight:800">${label}</span>
        <span class="rowval" style="font-weight:700;font-size:14px;text-align:right;flex:1">—</span>
        <span style="color:var(--dim)">›</span>`;
      r.onclick = () => { audio.sfx.ui(); this.show(key); };
      summary.appendChild(r);
      this.rows[key] = r.querySelector('.rowval');
    }
    s.appendChild(summary);

    const go = el('button', 'btn primary wide', 'DROP IN');
    go.style.fontSize = '17px';
    go.style.minHeight = '60px';
    go.onclick = () => { audio.sfx.start(); this.hooks.onStart(this.sel); };
    s.appendChild(go);

    const foot = el('div');
    foot.style.cssText = 'display:flex;gap:9px;margin-top:9px';
    const settings = el('button', 'btn ghost small', '⚙ Settings');
    settings.style.flex = '1';
    settings.onclick = () => { audio.sfx.ui(); this.openPause(true); };
    foot.appendChild(settings);
    s.appendChild(foot);

    this._syncRows();
  }

  _syncRows() {
    if (!this.rows) return;
    this.rows.rider.textContent = this.sel.rider.name;
    this.rows.board.textContent = this.sel.board.name;
    const g = GRADE_META[this.sel.run.grade];
    this.rows.run.innerHTML = `<span style="color:${g.color}">${g.symbol}</span> ${this.sel.run.run} · <span style="color:var(--muted)">${this.sel.run.mountain}</span>`;
    this.save.rider = this.sel.rider.id;
    this.save.board = this.sel.board.id;
    this.save.run = this.sel.run.id;
    writeSave(this.save);
  }

  _statBars(stats) {
    const wrap = el('div', 'stats');
    for (const [k, v] of Object.entries(stats)) {
      const row = el('div', 'stat');
      row.innerHTML = `<span>${k}</span><div class="bar"><i style="width:${v * 10}%"></i></div>`;
      wrap.appendChild(row);
    }
    return wrap;
  }

  _riderCard(r) {
    const c = el('div', 'card');
    c.innerHTML = `<div class="kicker">${r.tag}</div><h3>${r.name}</h3>
      <div style="font-size:11.5px;color:var(--dim);margin-top:2px">${r.home}</div>
      <p>${r.blurb}</p>`;
    c.appendChild(this._statBars({
      Speed: Math.round((r.mods.speed - 0.9) * 50),
      Control: Math.round((r.mods.control - 0.9) * 50),
      Style: Math.round((r.mods.style - 0.9) * 50),
      Balance: Math.round((r.mods.balance - 0.9) * 50),
    }));
    return c;
  }

  _boardCard(b) {
    const c = el('div', 'card');
    c.innerHTML = `<div class="kicker">${b.kind}</div><h3>${b.name}</h3>
      <div style="font-size:11.5px;color:var(--dim);margin-top:2px">${(b.length * 100).toFixed(0)} cm · ${(b.waist * 1000).toFixed(0)} mm waist</div>
      <p>${b.blurb}</p>`;
    c.appendChild(this._statBars({
      Speed: b.stats.speed, Edge: b.stats.edge, Float: b.stats.float,
      Pop: b.stats.pop, Agility: b.stats.agility,
    }));
    // A slice of the topsheet palette, so the rail reads at a glance.
    const swatch = el('div');
    swatch.style.cssText = `position:absolute;inset:auto 0 0 0;height:4px;background:linear-gradient(90deg,${b.art.base},${b.art.accent},${b.art.ink})`;
    c.appendChild(swatch);
    return c;
  }

  _buildPicker(key, label, items, render) {
    const s = this._screen(key);
    s.appendChild(this._topbar('Choose ' + label, 'home'));

    const head = el('div');
    head.innerHTML = `<div class="eyebrow">${label}</div><h2 class="title" style="font-size:clamp(22px,6vw,36px)">Pick your ${label.toLowerCase()}</h2>`;
    s.appendChild(head);

    const spacer = el('div');
    spacer.style.flex = '1';
    s.appendChild(spacer);

    const rail = el('div', 'rail');
    const cards = [];
    items.forEach((it) => {
      const c = render(it);
      c.onclick = () => {
        audio.sfx.select();
        this.sel[key] = it;
        cards.forEach(x => x.classList.remove('is-selected'));
        c.classList.add('is-selected');
        c.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        this._syncRows();
        this.hooks.onPreview?.(key, this.sel);
      };
      if (it.id === this.sel[key].id) c.classList.add('is-selected');
      rail.appendChild(c);
      cards.push(c);
    });
    s.appendChild(rail);

    const done = el('button', 'btn primary wide', 'CONFIRM');
    done.onclick = () => { audio.sfx.ui(); this.show('home'); };
    s.appendChild(done);

    // Centre the current selection when the screen opens.
    s._onShow = () => {
      const c = cards[items.findIndex(i => i.id === this.sel[key].id)];
      c?.scrollIntoView({ block: 'nearest', inline: 'center' });
    };
  }

  _buildRuns() {
    const s = this._screen('run');
    s.appendChild(this._topbar('Choose Run', 'home'));
    s.appendChild(el('div', '', '<div class="eyebrow">The mountain</div><h2 class="title" style="font-size:clamp(22px,6vw,36px);margin-bottom:12px">Ten real descents</h2>'));

    const list = el('div', 'runlist');
    this.runRows = [];
    RUNS.forEach((r) => {
      const g = GRADE_META[r.grade];
      const row = el('div', 'run');
      const best = this.save.bests?.[r.id];
      row.innerHTML = `
        <div class="grade" style="color:${g.color}">${g.symbol}</div>
        <div>
          <div class="name">${r.run}</div>
          <div class="meta">${r.mountain} · ${r.region}</div>
          <div class="meta" style="color:var(--dim);margin-top:2px">${r.vertical.toLocaleString()} m vertical · ${(r.realLength / 1000).toFixed(1)} km · ${r.gradeLabel}</div>
        </div>
        <div class="right">
          <div class="stars">${stars(best?.stars || 0)}</div>
          <div class="mono" style="margin-top:4px">${best ? fmtTime(best.time) : '—'}</div>
        </div>`;
      row.onclick = () => {
        audio.sfx.select();
        this.sel.run = r;
        this.runRows.forEach(x => x.classList.remove('is-selected'));
        row.classList.add('is-selected');
        this._syncRows();
        this.hooks.onPreview?.('run', this.sel);
        this._runDetail(r);
      };
      if (r.id === this.sel.run.id) row.classList.add('is-selected');
      list.appendChild(row);
      this.runRows.push(row);
    });
    s.appendChild(list);

    this.runBlurb = el('p', 'sub');
    this.runBlurb.style.cssText += 'margin:8px 2px 10px;min-height:3em';
    s.appendChild(this.runBlurb);

    const done = el('button', 'btn primary wide', 'CONFIRM');
    done.onclick = () => { audio.sfx.ui(); this.show('home'); };
    s.appendChild(done);

    s._onShow = () => this._runDetail(this.sel.run);
  }

  _runDetail(r) {
    const w = { clear: 'Bluebird', flurries: 'Light flurries', overcast: 'Flat light', snow: 'Snowing', storm: 'Storm' }[r.weather];
    const sn = { groomed: 'Groomed', powder: 'Powder', hardpack: 'Hardpack', crud: 'Crud', ice: 'Ice' }[r.snow];
    this.runBlurb.innerHTML = `${r.blurb}<br><span style="color:var(--accent-2);font-weight:700">${w} · ${sn} · Par ${fmtTime(r.parTime)}</span>`;
  }

  // ── HUD ─────────────────────────────────────────────────────────
  _buildHud() {
    const h = el('div');
    h.id = 'hud';
    h.innerHTML = `
      <div class="hud-top">
        <div class="hud-chip"><div class="label">Time</div><div class="value mono" id="hudTime">0:00.00</div></div>
        <div class="hud-chip"><div class="label">Score</div><div class="value mono" id="hudScore">0</div></div>
      </div>
      <button id="btnPause" aria-label="Pause">❚❚</button>
      <div class="combo" id="hudCombo">×1.0</div>
      <div class="progress"><i id="hudProg"></i><div class="pip" id="hudPip"></div></div>
      <div class="speedo"><div class="n mono" id="hudSpeed">0</div><div class="u">km/h</div></div>
      <div id="callouts"></div>
      <div class="controls">
        <div class="ctl" id="btnBrake">CHECK</div>
        <div class="ctl" id="btnAction">OLLIE<br><span style="opacity:.6;font-size:9px">HOLD = GRAB</span></div>
      </div>
      <div class="steerhint" id="steerHint">Drag anywhere to carve</div>`;
    this.root.appendChild(h);
    this.hud = h;
    this.hudTime = h.querySelector('#hudTime');
    this.hudScore = h.querySelector('#hudScore');
    this.hudSpeed = h.querySelector('#hudSpeed');
    this.hudProg = h.querySelector('#hudProg');
    this.hudPip = h.querySelector('#hudPip');
    this.hudCombo = h.querySelector('#hudCombo');
    this.callouts = h.querySelector('#callouts');
    this.steerHint = h.querySelector('#steerHint');
    this.btnAction = h.querySelector('#btnAction');
    this.btnBrake = h.querySelector('#btnBrake');
    h.querySelector('#btnPause').onclick = () => { audio.sfx.ui(); this.openPause(false); };
    if (!IS_TOUCH) this.steerHint.textContent = '← → to carve · SPACE to ollie & grab · S to check speed';
  }

  setHudVisible(v) { this.hud.classList.toggle('is-active', v); }

  updateHud(t, score, speedKmh, progress, combo) {
    this.hudTime.textContent = fmtTime(t);
    this.hudScore.textContent = Math.round(score).toLocaleString();
    this.hudSpeed.textContent = Math.round(speedKmh);
    const pct = (progress * 100).toFixed(1) + '%';
    this.hudProg.style.height = pct;
    this.hudPip.style.top = pct;
    const on = combo > 1.01;
    this.hudCombo.classList.toggle('is-on', on);
    if (on) this.hudCombo.textContent = '×' + combo.toFixed(2) + ' COMBO';
  }

  callout(text, points, bad = false) {
    const c = el('div', 'callout' + (bad ? ' bad' : ''));
    c.innerHTML = points ? `${text} <span class="pts">+${Math.round(points).toLocaleString()}</span>` : text;
    this.callouts.appendChild(c);
    setTimeout(() => c.remove(), 950);
    // Keep the stack short — three callouts is already a wall of text at speed.
    while (this.callouts.children.length > 3) this.callouts.firstChild.remove();
  }

  hideHint() { this.steerHint.style.opacity = '0'; }

  // ── Pause / settings ────────────────────────────────────────────
  _buildPause() {
    const p = el('div');
    p.id = 'pause';
    const panel = el('div', 'glass pause-panel');
    panel.innerHTML = `<div class="eyebrow">Paused</div>
      <h2 class="title" style="font-size:26px;margin-bottom:6px">Settings</h2>`;

    const qRow = el('div', 'row');
    qRow.innerHTML = '<span>Graphics</span>';
    const seg = el('div', 'seg');
    this.qButtons = {};
    TIERS.forEach(t => {
      const b = el('button', getTier() === t ? 'is-on' : '', t.toUpperCase());
      b.onclick = () => {
        audio.sfx.ui();
        setTier(t);
        Object.values(this.qButtons).forEach(x => x.classList.remove('is-on'));
        b.classList.add('is-on');
      };
      seg.appendChild(b);
      this.qButtons[t] = b;
    });
    qRow.appendChild(seg);
    panel.appendChild(qRow);

    const sRow = el('div', 'row');
    sRow.innerHTML = '<span>Sound</span>';
    const sBtn = el('button', 'btn small', audio.isMuted() ? 'OFF' : 'ON');
    sBtn.onclick = () => {
      const m = !audio.isMuted();
      audio.setMuted(m);
      sBtn.textContent = m ? 'OFF' : 'ON';
      this.save.muted = m; writeSave(this.save);
      if (!m) audio.sfx.ui();
    };
    sRow.appendChild(sBtn);
    panel.appendChild(sRow);

    if (IS_TOUCH) {
      const tRow = el('div', 'row');
      tRow.innerHTML = '<span>Tilt steering</span>';
      const tBtn = el('button', 'btn small', this.save.tilt ? 'ON' : 'OFF');
      tBtn.onclick = async () => {
        const want = !this.save.tilt;
        const ok = want ? await this.hooks.onTilt(true) : (this.hooks.onTilt(false), false);
        this.save.tilt = want && ok;
        tBtn.textContent = this.save.tilt ? 'ON' : 'OFF';
        writeSave(this.save);
        audio.sfx.ui();
      };
      tRow.appendChild(tBtn);
      panel.appendChild(tRow);
    }

    const resume = el('button', 'btn primary wide', 'RESUME');
    resume.onclick = () => { audio.sfx.ui(); this.closePause(); };
    panel.appendChild(resume);

    this.pauseRestart = el('button', 'btn ghost wide', 'RESTART RUN');
    this.pauseRestart.onclick = () => { audio.sfx.ui(); this.closePause(); this.hooks.onRetry(); };
    panel.appendChild(this.pauseRestart);

    this.pauseQuit = el('button', 'btn ghost wide', 'BACK TO MENU');
    this.pauseQuit.onclick = () => { audio.sfx.ui(); this.closePause(); this.hooks.onQuit(); };
    panel.appendChild(this.pauseQuit);

    p.appendChild(panel);
    this.root.appendChild(p);
    this.pause = p;
  }

  openPause(fromMenu) {
    this.pauseFromMenu = fromMenu;
    this.pauseRestart.style.display = fromMenu ? 'none' : '';
    this.pauseQuit.textContent = fromMenu ? 'CLOSE' : 'BACK TO MENU';
    this.pause.classList.add('is-active');
    this.hooks.onPause?.(true);
  }
  closePause() {
    this.pause.classList.remove('is-active');
    this.hooks.onPause?.(false);
  }
  get isPaused() { return this.pause.classList.contains('is-active'); }

  // ── Results ─────────────────────────────────────────────────────
  _buildResults() {
    const s = this._screen('results');
    this.resultBody = el('div');
    this.resultBody.style.cssText = 'flex:1;overflow-y:auto;min-height:0;touch-action:pan-y';
    s.appendChild(this.resultBody);

    const btns = el('div');
    btns.style.cssText = 'display:grid;gap:8px;margin-top:12px';
    const again = el('button', 'btn primary wide', 'RIDE IT AGAIN');
    again.onclick = () => { audio.sfx.start(); this.hooks.onRetry(); };
    const next = el('button', 'btn ghost wide', 'PICK ANOTHER RUN');
    next.onclick = () => { audio.sfx.ui(); this.show('run'); };
    const home = el('button', 'btn ghost wide', 'MENU');
    home.onclick = () => { audio.sfx.ui(); this.hooks.onQuit(); };
    btns.append(again, next, home);
    s.appendChild(btns);
  }

  showResults(run, res) {
    const best = this.save.bests[run.id];
    const isBestTime = !best || res.time < best.time;
    const isBestScore = !best || res.score > best.score;
    this.save.bests[run.id] = {
      time: isBestTime ? res.time : best.time,
      score: isBestScore ? res.score : best.score,
      stars: Math.max(best?.stars || 0, res.stars),
    };
    writeSave(this.save);
    // Keep the run list's badges live without a rebuild.
    const i = RUNS.indexOf(run);
    const row = this.runRows[i];
    if (row) {
      row.querySelector('.stars').innerHTML = stars(this.save.bests[run.id].stars);
      row.querySelector('.mono').textContent = fmtTime(this.save.bests[run.id].time);
    }

    const g = GRADE_META[run.grade];
    const delta = res.time - run.parTime;
    this.resultBody.innerHTML = `
      <div class="result-hero">
        <div class="eyebrow" style="color:${g.color}">${g.symbol} ${run.mountain}</div>
        <h2 class="title" style="font-size:clamp(24px,7vw,40px)">${run.run}</h2>
        <div class="result-stars">${stars(res.stars)}</div>
        <div class="sub" style="margin-top:0">${res.grade}</div>
      </div>
      <div class="result-grid">
        <div class="result-cell"><div class="k">Time</div><div class="v mono">${fmtTime(res.time)}</div>
          <div style="font-size:11px;color:${delta <= 0 ? 'var(--accent)' : 'var(--muted)'};margin-top:2px">${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(2)}s vs par</div></div>
        <div class="result-cell"><div class="k">Score</div><div class="v mono">${Math.round(res.score).toLocaleString()}</div>
          ${isBestScore ? '<div style="font-size:11px;color:var(--gold);margin-top:2px">New best</div>' : ''}</div>
        <div class="result-cell"><div class="k">Top speed</div><div class="v mono">${Math.round(res.topSpeed * 3.6)}<small style="font-size:11px"> km/h</small></div></div>
        <div class="result-cell"><div class="k">Air time</div><div class="v mono">${res.airTotal.toFixed(1)}<small style="font-size:11px"> s</small></div></div>
        <div class="result-cell"><div class="k">Tricks</div><div class="v mono">${res.tricksLanded}</div></div>
        <div class="result-cell"><div class="k">Biggest air</div><div class="v mono">${res.biggestAir.toFixed(2)}<small style="font-size:11px"> s</small></div></div>
        <div class="result-cell"><div class="k">Crashes</div><div class="v mono">${res.crashes}</div></div>
        <div class="result-cell"><div class="k">Best combo</div><div class="v mono">×${res.bestCombo.toFixed(2)}</div></div>
      </div>
      ${res.tricks.length ? `<div class="trick-log">${res.tricks.slice(-14).map(t =>
        `<div class="trick-row"><span>${t.name}</span><b>+${t.points.toLocaleString()}</b></div>`).join('')}</div>` : ''}`;
    this.show('results');
  }

  // ── Navigation ──────────────────────────────────────────────────
  show(id) {
    for (const [key, s] of Object.entries(this.screens)) {
      s.classList.toggle('is-active', key === id);
    }
    this.current = id;
    this.setHudVisible(false);
    this.screens[id]?._onShow?.();
    this.hooks.onScreen?.(id, this.sel);
  }

  enterRide() {
    for (const s of Object.values(this.screens)) s.classList.remove('is-active');
    this.current = 'ride';
    this.setHudVisible(true);
    this.steerHint.style.opacity = '1';
  }
}
