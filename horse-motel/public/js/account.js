import { api, getSession, setCsrf, el, icon, money, fmtDate, fmtHour, fieldError, clearErrors, showAlert, busy, announce } from './common.js';
import { cameraCard } from './camera-player.js';

const $ = (id) => document.getElementById(id);
let players = [];
let me;

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

function statusBadge(s) {
  if (s === 'confirmed') return el('span', { class: 'badge ok' }, icon('check'), 'Confirmed');
  if (s === 'cancelled') return el('span', { class: 'badge bad' }, 'Cancelled');
  return el('span', { class: 'badge warn' }, 'We’re reviewing this booking');
}

function render(data) {
  me = data.user;
  $('hello').textContent = `Hi${me.name ? ', ' + me.name.split(' ')[0] : ''}`;
  $('acct-loading').hidden = true;
  $('acct').hidden = false;

  // Cameras
  players.forEach((p) => p.stop());
  players = [];
  const cams = $('cams');
  if (!data.cameras.length) {
    cams.replaceChildren(el('div', { class: 'empty' }, icon('camera'),
      el('p', { class: 'm-0' }, 'No cameras yet. When you book a stall, its camera appears here — it switches on a few hours before check-in.'),
      el('p', { class: 'mt-14 mb-0' }, el('a', { href: '/#book' }, 'Book a stall'))));
  } else {
    const grid = el('div', { class: 'cam-grid' });
    for (const c of data.cameras) { const p = cameraCard(c, { tz: 'America/Chicago' }); players.push(p); grid.append(p.card); }
    cams.replaceChildren(grid);
  }

  // Stays
  const stays = $('stays');
  if (!data.bookings.length) {
    stays.replaceChildren(el('p', { class: 'muted' }, 'No bookings on this account yet.'));
  } else {
    stays.replaceChildren(...data.bookings.map((b) => {
      const parts = [];
      if (b.house) parts.push(`Ranch house (${b.guests} guest${b.guests === 1 ? '' : 's'})`);
      if (b.stalls) parts.push(`${b.stalls} stall${b.stalls > 1 ? 's' : ''}`);
      if (b.rvSites) parts.push(`${b.rvSites} RV site${b.rvSites > 1 ? 's' : ''}`);
      return el('article', { class: 'stay-card' },
        el('h3', {}, `${fmtDate(b.checkIn, { month: 'short', day: 'numeric' })} – ${fmtDate(b.checkOut)}`),
        el('div', { class: 'meta' }, statusBadge(b.status), el('span', {}, `Confirmation ${b.ref}`)),
        el('p', { class: 'm-0' }, parts.join(' · ')),
        b.units.length ? el('p', { class: 'm-0 muted' }, `Assigned: ${b.units.join(', ')}`) : null,
        el('p', { class: 'mt-14 mb-0 small muted' }, `Check-in from ${fmtHour(data.ranch.checkInHour)} · check-out by ${fmtHour(data.ranch.checkOutHour)} · Paid ${money(b.amount, b.currency)}`));
    }));
  }

  // Security
  $('p-email').value = me.email; $('pw-username').value = me.email;
  $('p-name').value = me.name; $('p-phone').value = me.phone;
  renderMfa();
  const nag = $('mfa-nag');
  if (me.role === 'admin' && !me.totpEnabled) {
    nag.hidden = false;
    nag.replaceChildren('Admin accounts must turn on two-step verification before the admin page will open. ',
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

async function load() {
  try {
    render(await api('/api/account'));
  } catch (e) {
    if (e.status === 401) { location.replace('/login?next=/account'); return; }
    $('acct-loading').hidden = true;
    showAlert($('acct-error'), e.message);
  }
}

function msg(box, text, kind = 'success') {
  box.className = `alert ${kind}`;
  box.textContent = text;
  box.hidden = !text;
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
      msg($('profile-msg'), 'Saved.');
    } catch (ex) { msg($('profile-msg'), ex.message, 'error'); }
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
      form.reset();
      msg($('pw-msg'), 'Password changed. Other devices have been signed out.');
    } catch (ex) {
      const target = ex.body?.field === 'current' ? cur : ex.body?.field === 'next' ? nxt : null;
      if (target) { fieldError(target, ex.message); target.focus(); } else msg($('pw-msg'), ex.message, 'error');
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
      form.hidden = true;
      $('mfa-confirm-form').hidden = false;
      $('mfa-code').focus();
      msg($('mfa-msg'), '');
    } catch (ex) {
      if (ex.body?.field === 'password') { fieldError(pw, ex.message); pw.focus(); } else msg($('mfa-msg'), ex.message, 'error');
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
      me.totpEnabled = true;
      renderMfa();
      msg($('mfa-msg'), 'Two-step verification is on. You’ll be asked for a code each time you sign in.');
      $('mfa-msg').focus?.();
      announce('Two-step verification turned on.');
      await getSession(true);
      if (me.role === 'admin') $('mfa-nag').hidden = true;
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
      me.totpEnabled = false;
      renderMfa();
      msg($('mfa-msg'), 'Two-step verification is off.', 'info');
    } catch (ex) { msg($('mfa-msg'), ex.message, 'error'); }
    busy(btn, false);
  });
}

document.addEventListener('visibilitychange', () => { /* image feeds pause themselves when hidden */ });
window.addEventListener('pagehide', () => players.forEach((p) => p.stop()));

initTabs();
wireForms();
getSession().then(({ user }) => { if (!user) location.replace('/login?next=/account'); else load(); });
// Keep camera windows current: re-check every 5 minutes (cameras turn on/off by time).
setInterval(() => { if (!document.hidden && !players.some((p) => p.card.querySelector('video, img'))) load(); }, 5 * 60e3);
