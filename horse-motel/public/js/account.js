import { api, getSession, setCsrf, el, icon, money, fmtRange, fmtHour, fieldError, clearErrors, showAlert, busy, setStatus, announce } from './common.js';
import { cameraCard } from './camera-player.js';

const $ = (id) => document.getElementById(id);
let players = [];
let me;
let ranch = { timezone: 'America/Chicago' };

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab, focus = true) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    history.replaceState(null, '', tab.id === 'tab-security' ? '#security' : location.pathname);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const moves = { ArrowRight: 1, ArrowLeft: -1 };
      if (e.key in moves) { e.preventDefault(); select(tabs[(i + moves[e.key] + tabs.length) % tabs.length]); }
      if (e.key === 'Home') { e.preventDefault(); select(tabs[0]); }
      if (e.key === 'End') { e.preventDefault(); select(tabs[tabs.length - 1]); }
    });
  });
  if (location.hash === '#security') select($('tab-security'), false);
}

function statusBadge(b) {
  if (b.status === 'confirmed') return el('span', { class: 'badge ok' }, icon('check'), 'Confirmed');
  if (b.status === 'cancelled') return el('span', { class: 'badge bad' }, b.refunded ? 'Cancelled · refunded' : 'Cancelled');
  return el('span', { class: 'badge warn' }, 'We’re reviewing this booking');
}

// Cameras and stays. Redrawn only when something actually changed (a camera switched on
// or off, a booking changed), and focus is put back where it was.
let lastSignature = '';
let wasLive = null;
function renderStay(data) {
  // Tell people waiting on this page when a camera switches on (or off).
  const nowLive = new Map(data.cameras.map((c) => [c.id, c.live]));
  if (wasLive) {
    for (const c of data.cameras) {
      if (c.live && wasLive.get(c.id) === false) announce(`${c.name} is live now.`);
    }
  }
  wasLive = nowLive;
  const signature = JSON.stringify([data.cameras.map((c) => [c.id, c.live, c.liveFrom, c.liveUntil]), data.bookings.map((b) => [b.ref, b.status, b.refunded])]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  const active = document.activeElement;
  const focusKey = active && $('panel-stay').contains(active)
    ? { cam: active.closest('.cam')?.getAttribute('aria-label'), text: active.textContent.trim() } : null;
  players.forEach((p) => p.stop());
  players = [];
  const cams = $('cams');
  if (!data.cameras.length) {
    cams.replaceChildren(el('div', { class: 'empty' }, icon('camera'),
      el('p', { class: 'm-0' }, 'No cameras yet. When you book a stall, its camera appears here — it switches on a few hours before check-in.'),
      el('p', { class: 'mt-14 mb-0' }, el('a', { href: '/#book' }, 'Book a stall'))));
  } else {
    const grid = el('div', { class: 'cam-grid' });
    for (const c of data.cameras) {
      const p = cameraCard(c, { tz: ranch.timezone, heading: 'h4', stay: c.stay });
      players.push(p);
      grid.append(p.card);
    }
    cams.replaceChildren(grid);
  }
  restoreFocus(focusKey);

  const stays = $('stays');
  if (!data.bookings.length) {
    stays.replaceChildren(el('p', { class: 'muted' }, 'No bookings on this account yet.'));
    return;
  }
  stays.replaceChildren(...data.bookings.map((b) => {
    const parts = [];
    if (b.house) parts.push(`Ranch house (${b.guests} guest${b.guests === 1 ? '' : 's'})`);
    if (b.stalls) parts.push(`${b.stalls} stall${b.stalls > 1 ? 's' : ''}`);
    if (b.rvSites) parts.push(`${b.rvSites} RV hookup${b.rvSites > 1 ? 's' : ''}`);
    if (b.rvSewer) parts.push(`${b.rvSewer} full hookup${b.rvSewer > 1 ? 's' : ''}`);
    const paid = b.status === 'cancelled'
      ? (b.refunded ? `Refunded ${money(b.refunded, b.currency)}` : 'Cancelled')
      : `Paid ${money(b.amount, b.currency)}`;
    return el('article', { class: 'stay-card' },
      el('h4', {}, fmtRange(b.checkIn, b.checkOut)),
      el('div', { class: 'meta' }, statusBadge(b), el('span', {}, `Confirmation ${b.ref}`)),
      el('p', { class: 'm-0' }, parts.join(' · ')),
      b.units.length ? el('p', { class: 'm-0 muted' }, `Assigned: ${b.units.join(', ')}`) : null,
      el('p', { class: 'mt-14 mb-0 small muted' }, b.status === 'cancelled' ? paid
        : `Check-in from ${fmtHour(data.ranch.checkInHour)} · check-out by ${fmtHour(data.ranch.checkOutHour)} · ${paid}`));
  }));
  restoreFocus(focusKey);
}

function restoreFocus(key) {
  if (!key) return;
  const card = key.cam && [...document.querySelectorAll('#panel-stay .cam')].find((c) => c.getAttribute('aria-label') === key.cam);
  const target = card && ([...card.querySelectorAll('button:not([hidden])')].find((b) => b.textContent.trim() === key.text) || card.querySelector('button:not([hidden])'));
  (target || $('panel-stay')).focus();
}

// Account & security: filled once, never overwritten by the background refresh, so
// nothing a person is typing is ever lost.
function renderSecurity() {
  $('p-email').value = me.email; $('pw-username').value = me.email;
  $('p-name').value = me.name; $('p-phone').value = me.phone;
  renderMfa();
  const nag = $('mfa-nag');
  if (me.role === 'admin' && !me.totpEnabled) {
    nag.hidden = false;
    nag.replaceChildren('Owner accounts must turn on two-step verification before the admin page will open. ',
      el('a', { href: '#security', onclick: (e) => { e.preventDefault(); $('tab-security').click(); } }, 'Set it up now'));
  } else nag.hidden = true;
}

function renderMfa() {
  $('mfa-status').textContent = me.totpEnabled ? 'Status: on' : 'Status: off';
  $('mfa-off').hidden = me.totpEnabled;
  $('mfa-on').hidden = !me.totpEnabled;
  $('mfa-start-form').hidden = false;
  $('mfa-confirm-form').hidden = true;
}

async function load({ initial = false } = {}) {
  try {
    const data = await api('/api/account');
    ranch = data.ranch;
    if (initial) {
      me = data.user;
      $('hello').textContent = `Hi${me.name ? ', ' + me.name.split(' ')[0] : ''}`;
      $('acct-kind').textContent = me.role === 'admin' ? 'Owner account' : 'Guest account';
      $('acct-loading').hidden = true;
      $('acct').hidden = false;
      renderSecurity();
    }
    renderStay(data);
  } catch (e) {
    if (e.status === 401) { location.replace('/login?next=/account'); return; }
    if (initial) { $('acct-loading').hidden = true; showAlert($('acct-error'), e.message); }
  }
}

function wireForms() {
  $('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.assign('/');
  });
  $('logout-all').addEventListener('click', async () => {
    if (!confirm('Sign out on every device, including this one?')) return;
    await api('/api/account/logout-everywhere', { method: 'POST' }).catch(() => {});
    location.assign('/login');
  });

  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const name = $('p-name');
    if (name.value.trim().length < 2) { fieldError(name, 'Enter your name.'); name.focus(); return; }
    const btn = form.querySelector('button');
    busy(btn, true, 'Saving…');
    try {
      await api('/api/account/profile', { method: 'POST', body: { name: name.value.trim(), phone: $('p-phone').value.trim() } });
      me.name = name.value.trim();
      setStatus($('profile-msg'), 'Saved.');
    } catch (ex) { setStatus($('profile-msg'), ex.message, 'error'); }
    busy(btn, false);
  });

  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const cur = $('pw-current'), nxt = $('pw-next');
    if (!cur.value) { fieldError(cur, 'Enter your current password.'); cur.focus(); return; }
    if (nxt.value.length < 12) { fieldError(nxt, 'Use at least 12 characters.'); nxt.focus(); return; }
    const btn = form.querySelector('button');
    busy(btn, true, 'Changing…');
    try {
      const out = await api('/api/account/password', { method: 'POST', body: { current: cur.value, next: nxt.value } });
      if (out.csrf) setCsrf(out.csrf);
      cur.value = ''; nxt.value = '';
      setStatus($('pw-msg'), 'Password changed. Other devices have been signed out.');
    } catch (ex) {
      const target = ex.body?.field === 'current' ? cur : ex.body?.field === 'next' ? nxt : null;
      if (target) { fieldError(target, ex.message); target.focus(); } else setStatus($('pw-msg'), ex.message, 'error');
    }
    busy(btn, false);
  });

  $('mfa-start-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const pw = $('mfa-start-pw');
    if (!pw.value) { fieldError(pw, 'Enter your password.'); pw.focus(); return; }
    const btn = form.querySelector('button');
    busy(btn, true, 'Starting…');
    try {
      const out = await api('/api/account/mfa/start', { method: 'POST', body: { password: pw.value } });
      pw.value = '';
      $('mfa-qr').src = out.qr;
      $('mfa-secret').textContent = out.secret.replace(/(.{4})/g, '$1 ').trim();
      busy(btn, false);
      form.hidden = true;
      $('mfa-confirm-form').hidden = false;
      setStatus($('mfa-msg'), '');
      $('mfa-steps').focus(); // read the steps and the setup key before the code box
      return;
    } catch (ex) {
      if (ex.body?.field === 'password') { fieldError(pw, ex.message); pw.focus(); } else setStatus($('mfa-msg'), ex.message, 'error');
    }
    busy(btn, false);
  });

  $('mfa-confirm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const code = $('mfa-code');
    if (!/^\d{6}$/.test(code.value.trim())) { fieldError(code, 'Enter the 6 digits from your app.'); code.focus(); return; }
    const btn = form.querySelector('button');
    busy(btn, true, 'Verifying…');
    try {
      const out = await api('/api/account/mfa/confirm', { method: 'POST', body: { code: code.value.trim() } });
      if (out.csrf) setCsrf(out.csrf);
      code.value = '';
      busy(btn, false);
      me.totpEnabled = true;
      renderMfa();
      await getSession(true);
      if (me.role === 'admin') $('mfa-nag').hidden = true;
      setStatus($('mfa-msg'), me.role === 'admin'
        ? 'Two-step verification is on. The admin page is ready.'
        : 'Two-step verification is on. You’ll be asked for a code each time you sign in.', 'success', { focus: true });
      if (me.role === 'admin') $('mfa-msg').querySelector('p').append(' ', el('a', { href: '/admin' }, 'Open the admin page'));
      return;
    } catch (ex) {
      fieldError(code, ex.message); code.focus();
    }
    busy(btn, false);
  });

  $('mfa-on').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button');
    busy(btn, true, 'Turning off…');
    try {
      await api('/api/account/mfa/disable', { method: 'POST', body: { password: $('mfa-off-pw').value, code: $('mfa-off-code').value.trim() } });
      form.reset();
      busy(btn, false);
      me.totpEnabled = false;
      renderMfa();
      setStatus($('mfa-msg'), 'Two-step verification is off.', 'info', { focus: true });
      return;
    } catch (ex) { setStatus($('mfa-msg'), ex.message, 'error'); }
    busy(btn, false);
  });
}

window.addEventListener('pagehide', () => players.forEach((p) => p.stop()));

initTabs();
wireForms();
getSession().then(({ user }) => { if (!user) location.replace('/login?next=/account'); else load({ initial: true }); });
// Cameras switch on and off with the clock: refresh that list every 5 minutes, but only
// while the cameras tab is showing and nothing is playing.
setInterval(() => {
  if (document.hidden || $('panel-stay').hidden || players.some((p) => p.playing())) return;
  load();
}, 5 * 60e3);
