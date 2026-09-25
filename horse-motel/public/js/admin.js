import { api, el, money, fmtDate, fmtRange, fieldError, clearErrors, busy, setStatus } from './common.js';
import { cameraCard } from './camera-player.js';

const $ = (id) => document.getElementById(id);
let units = [];
let site = null;
let preview;
const tz = () => site?.timezone || 'America/Chicago';
const todayIso = () => site?.today || new Date().toISOString().slice(0, 10);

// ── Tabs ──────────────────────────────────────────────────
function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const onShow = { 't-settings': () => { loadSync(); loadLog(); }, 't-occupancy': () => loadOccupancy() };
  const select = (tab) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    });
    tab.focus();
    onShow[tab.id]?.();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const to = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); select(tabs[to]); }
    });
  });
}

// ── Bookings ──────────────────────────────────────────────
const STATUS = { confirmed: ['ok', 'Confirmed'], pending: ['neutral', 'Awaiting payment'], needs_attention: ['bad', 'Needs attention'], cancelled: ['bad', 'Cancelled'] };
const VIEW_CAPTIONS = { upcoming: 'Upcoming and current bookings', attention: 'Bookings that need attention', cancelled: 'Cancelled bookings', past: 'Past stays', all: 'All bookings' };

function whatText(b) {
  return [b.house ? `House${b.guests ? ` (${b.guests})` : ''}` : null, b.stalls ? `${b.stalls} stall${b.stalls > 1 ? 's' : ''}` : null,
    b.rv_sites ? `${b.rv_sites} RV` : null, b.rv_sewer ? `${b.rv_sewer} full hookup` : null].filter(Boolean).join(', ');
}

async function loadBookings({ focusMsg = false } = {}) {
  const view = $('bk-view').value;
  const q = $('bk-q').value.trim();
  const { bookings } = await api(`/api/admin/bookings?view=${encodeURIComponent(view)}&q=${encodeURIComponent(q)}`);
  $('bk-caption').textContent = `${VIEW_CAPTIONS[view]}${q ? ` matching “${q}”` : ''} (${bookings.length})`;
  const rows = bookings.map((b) => {
    const [cls, label] = b.kind === 'block' ? ['neutral', b.source === 'ical' ? 'Airbnb' : 'Blocked'] : STATUS[b.status] || ['neutral', b.status];
    const actions = el('div', { class: 'row-actions' });
    const hidden = (t) => el('span', { class: 'visually-hidden' }, t);
    if (b.kind === 'guest' && b.status === 'confirmed') {
      actions.append(
        el('button', { type: 'button', class: 'btn secondary small', onclick: () => simple(b, 'resend') }, 'Re-send email', hidden(` for ${b.ref}`)),
        el('button', { type: 'button', class: 'btn secondary small', onclick: () => changeEmail(b) }, 'Change email', hidden(` for ${b.ref}`)));
    }
    if (b.status === 'needs_attention') {
      actions.append(el('button', { type: 'button', class: 'btn secondary small', onclick: () => resolve(b) }, 'Refund & resolve', hidden(` ${b.ref}`)));
    }
    if (b.status === 'confirmed' && b.source !== 'ical') {
      actions.append(el('button', { type: 'button', class: 'btn danger small', onclick: () => cancelBooking(b) },
        b.kind === 'block' ? 'Remove block' : 'Cancel', hidden(` ${b.ref}`)));
    }
    const guestCell = b.kind === 'block' ? (b.notes || 'Owner block') : [
      b.name, b.isNew ? el('span', { class: 'badge warn new-dot' }, 'New') : null, el('br'),
      el('a', { href: `mailto:${b.email}` }, b.email), el('br'),
      b.phone ? el('a', { href: `tel:${b.phone.replace(/[^\d+]/g, '')}` }, b.phone) : null];
    return el('tr', {},
      el('td', { 'data-label': 'Dates' }, fmtRange(b.check_in, b.check_out), el('br'), el('span', { class: 'small muted' }, `${b.ref}${b.source === 'admin' ? ' · phone booking' : ''}`)),
      el('td', { 'data-label': 'Guest' }, guestCell),
      el('td', { 'data-label': 'What' }, whatText(b), b.units.length ? [el('br'), el('span', { class: 'small muted' }, b.units.join(', '))] : null,
        b.kind === 'guest' && b.notes ? [el('br'), el('span', { class: 'small' }, `“${b.notes}”`)] : null),
      el('td', { 'data-label': 'Status' }, el('span', { class: `badge ${cls}` }, label),
        b.kind === 'guest' ? [el('br'), el('span', { class: 'small muted' }, `${money(b.amount_cents, b.currency)}${b.refund_cents ? ` · refunded ${money(b.refund_cents, b.currency)}` : ''}`)] : null),
      el('td', { 'data-label': 'Actions' }, actions));
  });
  $('bk-rows').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '5' }, 'No bookings to show.'))]));
  if (focusMsg) $('bk-msg').querySelector('p')?.focus();
}

async function simple(b, action) {
  try {
    const out = await api(`/api/admin/bookings/${b.id}/${action}`, { method: 'POST' });
    setStatus($('bk-msg'), out.note || 'Done.', 'success', { focus: true });
  } catch (e) { setStatus($('bk-msg'), e.message, 'error', { focus: true }); }
}

function ask(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

async function cancelBooking(b) {
  if (b.kind === 'block') {
    if (!confirm(`Remove this block (${fmtRange(b.check_in, b.check_out)})?`)) return;
    return afterAction(() => api(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: {} }));
  }
  $('cancel-summary').textContent = `${b.ref}: ${b.name}, ${fmtRange(b.check_in, b.check_out)} (${whatText(b)}).`;
  $('cancel-refund').checked = false;
  $('cancel-refund').disabled = !b.paidOnline;
  $('cancel-refund-label').textContent = b.paidOnline ? `Refund ${money(b.amount_cents, b.currency)} to their card` : 'Refund (not paid online — settle this with the guest directly)';
  $('cancel-notify').checked = true;
  if (await ask($('cancel-dialog')) !== 'confirm') return;
  await afterAction(() => api(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: { refund: $('cancel-refund').checked, notify: $('cancel-notify').checked } }));
}

async function resolve(b) {
  if (!confirm(`Refund ${b.name} and release ${b.ref}? Use this when a payment arrived for dates that were no longer free.`)) return;
  await afterAction(() => api(`/api/admin/bookings/${b.id}/resolve`, { method: 'POST', body: { refund: true } }));
}

async function changeEmail(b) {
  $('email-summary').textContent = `${b.ref}: ${b.name} is currently ${b.email}.`;
  $('new-email').value = b.email;
  $('new-email').removeAttribute('aria-invalid');
  if (await ask($('email-dialog')) !== 'confirm') return;
  const email = $('new-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setStatus($('bk-msg'), 'That email address doesn’t look right. Nothing was changed.', 'error', { focus: true }); return; }
  await afterAction(() => api(`/api/admin/bookings/${b.id}/email`, { method: 'POST', body: { email } }));
}

// Runs an action, reloads the list, and puts focus on the result (the row the user was
// on may be gone).
async function afterAction(fn) {
  try {
    const out = await fn();
    setStatus($('bk-msg'), out.note || 'Done.');
  } catch (e) { setStatus($('bk-msg'), e.message, 'error'); }
  await loadBookings({ focusMsg: true }).catch(() => {});
  const p = $('bk-msg').querySelector('p');
  if (p) { p.setAttribute('tabindex', '-1'); p.focus(); }
}

// ── Occupancy ─────────────────────────────────────────────
async function loadOccupancy() {
  if (!$('occ-from').value) $('occ-from').value = todayIso();
  const data = await api(`/api/admin/occupancy?from=${$('occ-from').value}&days=${$('occ-days').value}`);
  const nights = Array.from({ length: data.days }, (_, i) => { const d = new Date(data.from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  $('occ-head').replaceChildren(el('tr', {}, el('th', { scope: 'col' }, 'Unit'),
    nights.map((n) => el('th', { scope: 'col', abbr: fmtDate(n) }, fmtDate(n, { weekday: 'short', month: 'numeric', day: 'numeric' })))));
  $('occ-rows').replaceChildren(...data.units.map((u) => el('tr', {}, el('th', { scope: 'row' }, u.label),
    nights.map((n) => {
      const c = data.grid[`${u.id}:${n}`];
      if (!c) return el('td', {}, el('span', { class: 'visually-hidden' }, 'free'));
      const cls = c.kind === 'block' ? 'block' : c.status === 'pending' ? 'pending' : 'guest';
      return el('td', { class: cls, title: c.ref }, c.status === 'pending' ? `${c.who} (unpaid)` : c.who);
    }))));
}

// ── Unit pickers ──────────────────────────────────────────
function unitPicker(container, prefix, selected = [], onChange) {
  const groups = [['house', 'House'], ['stall', 'Stalls'], ['rv', 'RV sites']];
  container.replaceChildren(...groups.flatMap(([kind]) => units.filter((u) => u.kind === kind).map((u) => el('div', { class: 'check' },
    el('input', { type: 'checkbox', id: `${prefix}-${u.id}`, value: u.id, checked: selected.includes(u.id), onchange: onChange }),
    el('label', { for: `${prefix}-${u.id}` }, u.label)))));
}
const pickedUnits = (container) => [...container.querySelectorAll('input:checked')].map((i) => Number(i.value));

// ── Cameras ───────────────────────────────────────────────
const updateMultiWarning = () => {
  const stallsTicked = pickedUnits($('c-units')).filter((id) => units.find((u) => u.id === id)?.kind === 'stall').length;
  $('c-multi').hidden = stallsTicked < 2;
};

async function loadCameras() {
  const { cameras } = await api('/api/admin/cameras');
  const label = (id) => units.find((u) => u.id === id)?.label || '?';
  $('cam-rows').replaceChildren(...(cameras.length ? cameras.map((c) => el('tr', {},
    el('td', { 'data-label': 'Camera' }, c.name, el('br'), el('span', { class: 'small muted' }, `${c.sourceType}${c.host ? ' · ' + c.host : ''}${c.active ? '' : ' · inactive'}`)),
    el('td', { 'data-label': 'Shows' }, c.unitIds.map(label).join(', ') || '—'),
    el('td', { 'data-label': 'Actions' }, el('div', { class: 'row-actions' },
      el('button', { type: 'button', class: 'btn secondary small', onclick: () => editCamera(c) }, 'Edit', el('span', { class: 'visually-hidden' }, ` ${c.name}`)),
      c.active ? el('button', { type: 'button', class: 'btn secondary small', onclick: () => previewCamera(c) }, 'Test', el('span', { class: 'visually-hidden' }, ` ${c.name}`)) : null,
      el('button', { type: 'button', class: 'btn danger small', onclick: () => deleteCamera(c) }, 'Delete', el('span', { class: 'visually-hidden' }, ` ${c.name}`)))))) :
    [el('tr', {}, el('td', { colspan: '3' }, 'No cameras yet. Add one with the form.'))]));
}

function editCamera(c) {
  $('cam-form-title').textContent = `Edit ${c.name}`;
  $('c-id').value = c.id; $('c-name').value = c.name; $('c-type').value = c.sourceType; $('c-url').value = '';
  $('c-active').checked = c.active; $('c-cancel').hidden = false;
  unitPicker($('c-units'), 'cu', c.unitIds, updateMultiWarning);
  updateMultiWarning();
  $('c-name').focus();
}

function resetCameraForm() {
  $('cam-form').reset(); $('c-id').value = ''; $('c-cancel').hidden = true;
  $('cam-form-title').textContent = 'Add a camera';
  unitPicker($('c-units'), 'cu', [], updateMultiWarning);
  updateMultiWarning();
}

async function deleteCamera(c) {
  if (!confirm(`Delete ${c.name}? Guests will lose this feed.`)) return;
  try {
    await api(`/api/admin/cameras/${c.id}`, { method: 'DELETE' });
    setStatus($('cam-list-msg'), `${c.name} deleted.`, 'success', { focus: true });
  } catch (e) { setStatus($('cam-list-msg'), e.message, 'error', { focus: true }); }
  await loadCameras().catch(() => {});
}

function previewCamera(c) {
  preview?.stop();
  preview = cameraCard({ id: c.publicId, name: c.name, type: c.sourceType === 'hls' ? 'hls' : 'image', live: true, covers: [], liveUntil: Date.now() + 864e5 },
    { tz: tz(), heading: 'h3' });
  $('cam-preview').replaceChildren(preview.card);
  preview.card.querySelector('button')?.focus();
}

// ── Settings ──────────────────────────────────────────────
async function loadSync() {
  const s = await api('/api/admin/calendar-sync');
  const box = $('sync-info');
  box.replaceChildren(
    el('p', {}, s.enabled ? `Importing ${s.feeds} calendar${s.feeds > 1 ? 's' : ''} every few minutes. ${s.lastSync ? `Last synced ${new Date(s.lastSync).toLocaleString('en-US', { timeZone: tz() })}.` : 'Not synced yet.'}`
      : 'Not set up. Add your Airbnb calendar’s export link to ICAL_IMPORT_URLS (Airbnb → Calendar → Availability → Connect calendars → Export).'),
    s.lastError ? el('p', { class: 'field-error' }, s.lastError) : null,
    s.exportUrl ? el('div', { class: 'field' }, el('label', { for: 'export-url' }, 'Give Airbnb this link (Import calendar)'),
      el('input', { type: 'text', id: 'export-url', readonly: true, value: s.exportUrl, onfocus: (e) => e.target.select() }))
      : el('p', { class: 'muted' }, 'To let Airbnb see bookings made here, set ICAL_EXPORT_TOKEN to a long random value.'));
  $('sync-now').hidden = !s.enabled;
}

async function loadLog() {
  const { entries } = await api('/api/admin/audit');
  $('log-rows').replaceChildren(...entries.map((e) => el('tr', {},
    el('td', { 'data-label': 'When' }, new Date(e.at).toLocaleString('en-US', { timeZone: tz() })),
    el('td', { 'data-label': 'Event' }, e.action), el('td', { 'data-label': 'Account' }, e.email || '—'),
    el('td', { 'data-label': 'Detail' }, e.detail), el('td', { 'data-label': 'IP' }, e.ip))));
}

// ── Forms ─────────────────────────────────────────────────
function wire() {
  $('logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.assign('/'); });
  $('bk-filter').addEventListener('submit', (e) => { e.preventDefault(); loadBookings().catch((ex) => setStatus($('bk-msg'), ex.message, 'error')); });
  $('bk-view').addEventListener('change', () => loadBookings().catch(() => {}));
  $('occ-form').addEventListener('submit', (e) => { e.preventDefault(); loadOccupancy().catch(() => {}); });

  $('phone-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const num = (id) => Math.max(0, Number.parseInt($(id).value, 10) || 0);
    const guests = num('ph-guests');
    const amount = $('ph-amount').value.trim();
    if (!$('ph-in').value) { fieldError($('ph-in'), 'Choose the check-in date.'); $('ph-in').focus(); return; }
    if (!$('ph-out').value || $('ph-out').value <= $('ph-in').value) { fieldError($('ph-out'), 'Choose a later check-out date.'); $('ph-out').focus(); return; }
    if (amount && !/^\d+(\.\d{1,2})?$/.test(amount)) { fieldError($('ph-amount'), 'Enter an amount like 125 or 125.50.'); $('ph-amount').focus(); return; }
    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, 'Booking…');
    try {
      const out = await api('/api/admin/bookings', { method: 'POST', body: {
        stay: { checkIn: $('ph-in').value, checkOut: $('ph-out').value, house: guests > 0, guests,
          stalls: num('ph-stalls'), rvSites: num('ph-rv'), rvSewer: num('ph-sewer') },
        contact: { name: $('ph-name').value.trim(), email: $('ph-email').value.trim(), phone: $('ph-phone').value.trim(), notes: $('ph-notes').value.trim() },
        ...(amount ? { amountCents: Math.round(Number(amount) * 100) } : {}),
      } });
      form.reset();
      setStatus($('ph-msg'), out.note, 'success', { focus: true });
      loadBookings().catch(() => {});
    } catch (ex) {
      const map = { name: 'ph-name', email: 'ph-email', phone: 'ph-phone', checkIn: 'ph-in', checkOut: 'ph-out', stalls: 'ph-stalls', rvSites: 'ph-rv', rvSewer: 'ph-sewer', guests: 'ph-guests' };
      const target = ex.body?.field && $(map[ex.body.field.split('.').pop()]);
      if (target) { fieldError(target, ex.message); target.focus(); } else setStatus($('ph-msg'), ex.message, 'error', { focus: true });
    }
    busy(btn, false);
  });

  $('block-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    $('b-units-error').textContent = '';
    if (!$('b-in').value) { fieldError($('b-in'), 'Choose the first night.'); $('b-in').focus(); return; }
    if (!$('b-out').value || $('b-out').value <= $('b-in').value) { fieldError($('b-out'), 'Choose a later date.'); $('b-out').focus(); return; }
    const unitIds = pickedUnits($('b-units'));
    if (!unitIds.length) { $('b-units-error').textContent = 'Tick at least one thing to block.'; $('b-units').querySelector('input')?.focus(); return; }
    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, 'Blocking…');
    try {
      await api('/api/admin/blocks', { method: 'POST', body: { checkIn: $('b-in').value, checkOut: $('b-out').value, unitIds, note: $('b-note').value.trim() } });
      form.reset();
      setStatus($('block-msg'), 'Blocked. It now shows in the bookings list.', 'success', { focus: true });
      loadBookings().catch(() => {});
    } catch (ex) { setStatus($('block-msg'), ex.message, 'error', { focus: true }); }
    busy(btn, false);
  });

  $('mfa-reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = $('r-email').value.trim();
    if (!email) { fieldError($('r-email'), 'Enter the guest’s email.'); $('r-email').focus(); return; }
    if (!confirm(`Turn off two-step verification for ${email}?`)) return;
    try {
      await api('/api/admin/users/reset-mfa', { method: 'POST', body: { email } });
      form.reset();
      setStatus($('reset-msg'), 'Done. Ask the guest to sign in and turn it on again.');
    } catch (ex) { setStatus($('reset-msg'), ex.message, 'error'); }
  });

  $('sync-now').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Syncing…');
    try { const out = await api('/api/admin/calendar-sync', { method: 'POST' }); setStatus($('sync-msg'), out.note, out.ok ? 'success' : 'error'); }
    catch (ex) { setStatus($('sync-msg'), ex.message, 'error'); }
    busy(btn, false);
    loadSync().catch(() => {});
  });

  $('c-cancel').addEventListener('click', resetCameraForm);
  $('cam-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors(form);
    const id = $('c-id').value;
    const body = {
      name: $('c-name').value.trim(), sourceType: $('c-type').value, sourceUrl: $('c-url').value.trim(),
      unitIds: pickedUnits($('c-units')), active: $('c-active').checked,
    };
    if (!body.name) { fieldError($('c-name'), 'Name the camera.'); $('c-name').focus(); return; }
    if (!id && body.sourceType !== 'demo' && !body.sourceUrl) { fieldError($('c-url'), 'Enter the camera address.'); $('c-url').focus(); return; }
    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, 'Saving…');
    try {
      await api(id ? `/api/admin/cameras/${id}` : '/api/admin/cameras', { method: id ? 'PUT' : 'POST', body });
      resetCameraForm();
      setStatus($('cam-msg'), 'Camera saved.', 'success', { focus: true });
      await loadCameras();
    } catch (ex) { setStatus($('cam-msg'), ex.message, 'error', { focus: true }); }
    busy(btn, false);
  });
}

(async () => {
  initTabs();
  wire();
  try {
    [site, { units }] = await Promise.all([api('/api/site'), api('/api/admin/units')]);
    unitPicker($('c-units'), 'cu', [], updateMultiWarning);
    unitPicker($('b-units'), 'bu');
    for (const id of ['b-in', 'b-out', 'ph-in', 'ph-out']) $(id).min = todayIso();
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
    box.setAttribute('tabindex', '-1');
    box.focus();
  }
})();
