import { api, el, money, fmtDate, fieldError, clearErrors, busy, announce } from './common.js';
import { cameraCard } from './camera-player.js';

const $ = (id) => document.getElementById(id);
let units = [];
let camerasCache = [];
let preview;

function msg(box, text, kind = 'success') { box.className = `alert ${kind}`; box.textContent = text; box.hidden = !text; }

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    });
    tab.focus();
    if (tab.id === 't-activity') loadLog();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); select(tabs[(i + 1) % tabs.length]); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); select(tabs[(i - 1 + tabs.length) % tabs.length]); }
    });
  });
}

const STATUS = { confirmed: ['ok', 'Confirmed'], pending: ['neutral', 'Awaiting payment'], needs_attention: ['bad', 'Needs attention'] };

async function loadBookings() {
  const { bookings } = await api('/api/admin/bookings');
  const rows = bookings.map((b) => {
    const [cls, label] = b.kind === 'block' ? ['neutral', 'Blocked'] : STATUS[b.status] || ['neutral', b.status];
    const what = [b.house ? 'House' : null, b.stalls ? `${b.stalls} stall(s)` : null, b.rv_sites ? `${b.rv_sites} RV` : null].filter(Boolean).join(', ');
    const actions = el('div', { class: 'row-actions' });
    if (b.kind === 'guest' && b.status === 'confirmed') {
      actions.append(el('button', { type: 'button', class: 'btn secondary small', onclick: () => act(b, 'resend', `Re-send the confirmation email to ${b.email}?`) }, 'Re-send email', el('span', { class: 'visually-hidden' }, ` for ${b.ref}`)));
    }
    if (b.status === 'needs_attention') {
      actions.append(el('button', { type: 'button', class: 'btn secondary small', onclick: () => act(b, 'resolve', `Mark ${b.ref} as refunded and release it?`) }, 'Mark refunded', el('span', { class: 'visually-hidden' }, ` for ${b.ref}`)));
    }
    if (b.status === 'confirmed') {
      actions.append(el('button', { type: 'button', class: 'btn danger small', onclick: () => act(b, 'cancel', b.kind === 'block' ? 'Remove this block?' : `Cancel ${b.ref} for ${b.name}? Their camera access ends immediately.`) }, b.kind === 'block' ? 'Remove block' : 'Cancel', el('span', { class: 'visually-hidden' }, ` ${b.ref}`)));
    }
    return el('tr', {},
      el('td', {}, `${fmtDate(b.check_in, { month: 'short', day: 'numeric' })} – ${fmtDate(b.check_out, { month: 'short', day: 'numeric' })}`, el('br'), el('span', { class: 'small muted' }, b.ref)),
      el('td', {}, b.kind === 'block' ? (b.notes || 'Owner block') : [b.name, el('br'), el('a', { href: `mailto:${b.email}` }, b.email), el('br'), el('a', { href: `tel:${b.phone.replace(/[^\d+]/g, '')}` }, b.phone)]),
      el('td', {}, what, b.units.length ? [el('br'), el('span', { class: 'small muted' }, b.units.join(', '))] : null,
        b.kind === 'guest' && b.notes ? [el('br'), el('span', { class: 'small' }, `“${b.notes}”`)] : null),
      el('td', {}, el('span', { class: `badge ${cls}` }, label), b.kind === 'guest' ? [el('br'), el('span', { class: 'small muted' }, money(b.amount_cents, b.currency))] : null),
      el('td', {}, actions));
  });
  $('bk-rows').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '5' }, 'No upcoming bookings.'))]));
}

async function act(b, action, question) {
  if (!confirm(question)) return;
  try {
    const out = await api(`/api/admin/bookings/${b.id}/${action}`, { method: 'POST' });
    msg($('bk-msg'), out.note || 'Done.');
    await loadBookings();
    $('bk-msg').focus?.();
  } catch (e) { msg($('bk-msg'), e.message, 'error'); }
}

function unitChecks(selected = []) {
  $('c-units').replaceChildren(...units.map((u) => el('div', { class: 'check' },
    el('input', { type: 'checkbox', id: `u-${u.id}`, value: u.id, checked: selected.includes(u.id) }),
    el('label', { for: `u-${u.id}` }, u.label))));
}

async function loadCameras() {
  const { cameras } = await api('/api/admin/cameras');
  camerasCache = cameras;
  const label = (id) => units.find((u) => u.id === id)?.label || '?';
  $('cam-rows').replaceChildren(...(cameras.length ? cameras.map((c) => el('tr', {},
    el('td', {}, c.name, el('br'), el('span', { class: 'small muted' }, `${c.sourceType}${c.host ? ' · ' + c.host : ''}${c.active ? '' : ' · inactive'}`)),
    el('td', {}, c.unitIds.map(label).join(', ') || '—'),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { type: 'button', class: 'btn secondary small', onclick: () => editCamera(c) }, 'Edit', el('span', { class: 'visually-hidden' }, ` ${c.name}`)),
      c.active ? el('button', { type: 'button', class: 'btn secondary small', onclick: () => previewCamera(c) }, 'Test', el('span', { class: 'visually-hidden' }, ` ${c.name}`)) : null,
      el('button', { type: 'button', class: 'btn danger small', onclick: () => deleteCamera(c) }, 'Delete', el('span', { class: 'visually-hidden' }, ` ${c.name}`)))))) :
    [el('tr', {}, el('td', { colspan: '3' }, 'No cameras yet. Add one with the form.'))]));
}

function editCamera(c) {
  $('cam-form-title').textContent = `Edit ${c.name}`;
  $('c-id').value = c.id; $('c-name').value = c.name; $('c-type').value = c.sourceType; $('c-url').value = '';
  $('c-active').checked = c.active; $('c-cancel').hidden = false;
  unitChecks(c.unitIds);
  $('c-name').focus();
}

function resetCameraForm() {
  $('cam-form').reset(); $('c-id').value = ''; $('c-cancel').hidden = true;
  $('cam-form-title').textContent = 'Add a camera';
  unitChecks();
}

async function deleteCamera(c) {
  if (!confirm(`Delete ${c.name}? Guests will lose this feed.`)) return;
  await api(`/api/admin/cameras/${c.id}`, { method: 'DELETE' });
  announce(`${c.name} deleted.`);
  await loadCameras();
}

function previewCamera(c) {
  preview?.stop();
  preview = cameraCard({ id: c.publicId, name: c.name, type: c.sourceType === 'hls' ? 'hls' : 'image', live: true, covers: [], liveUntil: Date.now() + 864e5 });
  $('cam-preview').replaceChildren(preview.card);
  preview.card.querySelector('button')?.focus();
}

async function loadLog() {
  const { entries } = await api('/api/admin/audit');
  $('log-rows').replaceChildren(...entries.map((e) => el('tr', {},
    el('td', {}, new Date(e.at).toLocaleString('en-US', { timeZone: 'America/Chicago' })),
    el('td', {}, e.action), el('td', {}, e.email || '—'), el('td', {}, e.detail), el('td', {}, e.ip))));
}

function wire() {
  $('logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.assign('/'); });

  $('block-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    if (!$('b-in').value) { fieldError($('b-in'), 'Choose the first night.'); $('b-in').focus(); return; }
    if (!$('b-out').value || $('b-out').value <= $('b-in').value) { fieldError($('b-out'), 'Choose a later date.'); $('b-out').focus(); return; }
    const btn = form.querySelector('button');
    busy(btn, true, 'Blocking…');
    try {
      await api('/api/admin/blocks', { method: 'POST', body: { checkIn: $('b-in').value, checkOut: $('b-out').value,
        house: $('b-house').checked, stalls: Number($('b-stalls').value) || 0, rvSites: Number($('b-rv').value) || 0, note: $('b-note').value.trim() } });
      form.reset();
      msg($('block-msg'), 'Blocked. It now shows in the bookings list.');
      loadBookings();
    } catch (ex) { msg($('block-msg'), ex.message, 'error'); }
    busy(btn, false);
  });

  $('mfa-reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('r-email').value.trim();
    if (!email) { fieldError($('r-email'), 'Enter the guest’s email.'); $('r-email').focus(); return; }
    if (!confirm(`Turn off two-step verification for ${email}?`)) return;
    try {
      await api('/api/admin/users/reset-mfa', { method: 'POST', body: { email } });
      e.currentTarget?.reset?.();
      msg($('reset-msg'), 'Done. Ask the guest to sign in and turn it on again.');
    } catch (ex) { msg($('reset-msg'), ex.message, 'error'); }
  });

  $('c-cancel').addEventListener('click', resetCameraForm);
  $('cam-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const id = $('c-id').value;
    const body = {
      name: $('c-name').value.trim(), sourceType: $('c-type').value, sourceUrl: $('c-url').value.trim(),
      unitIds: [...$('c-units').querySelectorAll('input:checked')].map((i) => Number(i.value)), active: $('c-active').checked,
    };
    if (!body.name) { fieldError($('c-name'), 'Name the camera.'); $('c-name').focus(); return; }
    if (!id && body.sourceType !== 'demo' && !body.sourceUrl) { fieldError($('c-url'), 'Enter the camera address.'); $('c-url').focus(); return; }
    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, 'Saving…');
    try {
      await api(id ? `/api/admin/cameras/${id}` : '/api/admin/cameras', { method: id ? 'PUT' : 'POST', body });
      resetCameraForm();
      msg($('cam-msg'), 'Camera saved.');
      await loadCameras();
    } catch (ex) { msg($('cam-msg'), ex.message, 'error'); }
    busy(btn, false);
  });
}

(async () => {
  initTabs();
  wire();
  try {
    units = (await api('/api/admin/units')).units;
    unitChecks();
    await Promise.all([loadBookings(), loadCameras()]);
    $('adm-loading').hidden = true;
    $('adm').hidden = false;
  } catch (e) {
    $('adm-loading').hidden = true;
    if (e.status === 401) { location.replace('/login?next=/admin'); return; }
    if (e.body?.code === 'mfa_enroll') { location.replace('/account#security'); return; }
    const box = $('adm-error');
    box.hidden = false;
    box.textContent = e.message;
    box.focus?.();
  }
})();
