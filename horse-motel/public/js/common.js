// Shared browser helpers: API calls with CSRF protection, session state, the mobile
// menu, and accessible form/status handling. No inline scripts anywhere (strict CSP).
//
// Every page script imports this module as "./common.js" and the page <head> loads it as
// "/js/common.js": the same URL, so the browser runs it exactly once.

let csrf = null;
let sessionPromise = null;

export function getSession(force = false) {
  if (!sessionPromise || force) {
    sessionPromise = fetch('/api/auth/session', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((s) => { csrf = s.csrf; return s; })
      .catch(() => ({ user: null }));
  }
  return sessionPromise;
}

export function setCsrf(token) { csrf = token; }

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body || {}; }
}

export async function api(path, { method = 'GET', body } = {}) {
  if (method !== 'GET') await getSession();
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrf;
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('We couldn’t reach the server. Check your connection and try again.', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after'));
    const wait = retry > 90 ? ` ${Math.ceil(retry / 60)} minutes` : retry ? ` ${retry} seconds` : ' a little while';
    const msg = data.error || (res.status === 429 ? `Too many tries. Please wait${wait} and try again.` : 'Something went wrong. Please try again.');
    throw new ApiError(msg, res.status, data);
  }
  if (data.csrf) csrf = data.csrf;
  return data;
}

// ── Formatting ─────────────────────────────────────────────
export const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

export const fmtDate = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

// "Fri, Oct 3 – Sun, Oct 5, 2026": one consistent format for a stay everywhere.
export const fmtRange = (a, b) => `${fmtDate(a, { weekday: 'short', month: 'short', day: 'numeric' })} – ${fmtDate(b)}`;

export const fmtHour = (h) => `${((h + 11) % 12) + 1}:00 ${h >= 12 ? 'PM' : 'AM'}`;

export const fmtInstant = (ms, tz = 'America/Chicago') =>
  new Date(ms).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export const fmtTime = (ms, tz = 'America/Chicago') =>
  new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

// Builds DOM safely: never innerHTML with data.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// ── Accessible form errors ─────────────────────────────────
// Puts a message under a field, marks it invalid, and wires aria-describedby.
export function fieldError(input, message) {
  if (!input) return;
  const errId = `${input.id}-error`;
  let slot = document.getElementById(errId);
  if (!slot) {
    slot = el('p', { class: 'field-error', id: errId });
    (input.closest('.field, .check') || input.parentElement)?.append(slot);
  }
  slot.textContent = message || '';
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  const ids = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  ids.add(errId);
  input.setAttribute('aria-describedby', [...ids].join(' '));
}

export function clearErrors(form) {
  form.querySelectorAll('[aria-invalid="true"]').forEach((i) => fieldError(i, ''));
}

// Shows a form-level error in an alert box and moves focus to it.
export function showAlert(box, message, kind = 'error') {
  if (!box) return;
  box.className = `alert ${kind}`;
  box.textContent = message;
  box.hidden = !message;
  if (message) { box.setAttribute('tabindex', '-1'); box.focus({ preventScroll: false }); }
}

// Writes a result into a status region that is always in the page (role="status"), so
// screen readers announce it. Pass focus: true to also move focus to it, e.g. when the
// control the user was on has just been removed.
export function setStatus(region, text, kind = 'success', { focus = false } = {}) {
  if (!region) return;
  if (!text) { region.replaceChildren(); return; }
  const box = el('p', { class: `alert ${kind}`, tabindex: focus ? '-1' : null }, text);
  region.replaceChildren(box);
  if (focus) box.focus();
}

// Marks a button busy without disabling it: a disabled button drops keyboard focus, which
// loses screen reader users' place. A capturing guard below swallows repeat clicks/submits.
export function busy(button, isBusy, busyText) {
  if (!button) return;
  if (isBusy) {
    button.dataset.label = button.dataset.label || button.textContent;
    button.dataset.busy = '1';
    button.setAttribute('aria-disabled', 'true');
    button.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), busyText || 'Please wait…');
  } else {
    delete button.dataset.busy;
    button.removeAttribute('aria-disabled');
    if (button.dataset.label) { button.textContent = button.dataset.label; delete button.dataset.label; }
  }
}
const isBusy = (node) => !!node?.closest?.('[data-busy]');

// Moves focus to a heading (or other non-interactive element) so a screen reader reads
// the new step, without a visible focus box around it.
export function focusHeading(node, title) {
  if (!node) return;
  node.setAttribute('tabindex', '-1');
  node.focus();
  if (title) document.title = title;
}

// A polite live region for status messages that don't need focus.
let liveRegion;
export function announce(message) {
  if (!liveRegion) {
    liveRegion = el('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
    document.body.append(liveRegion);
  }
  liveRegion.textContent = '';
  setTimeout(() => { liveRegion.textContent = message; }, 50);
}

// ── Page chrome ────────────────────────────────────────────
function initMenu() {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;
  const header = toggle.closest('header');
  const mq = window.matchMedia('(max-width: 860px)');
  const set = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.hidden = mq.matches && !open;
  };
  set(false);
  mq.addEventListener('change', () => set(false));
  toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => { if (e.target.closest('a') && mq.matches) set(false); });
  // Close when focus moves on past the menu, so it never hides what's focused next.
  header.addEventListener('focusout', (e) => {
    if (mq.matches && e.relatedTarget && !header.contains(e.relatedTarget)) set(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { set(false); toggle.focus(); }
  });
}

async function initAuthNav() {
  const { user } = await getSession();
  document.querySelectorAll('[data-auth]').forEach((a) => {
    const need = a.dataset.auth;
    a.hidden = need === 'out' ? !!user : need === 'in' ? !user : !(user && user.role === 'admin');
  });
}

function init() {
  if (window.__ranchChrome) return; // belt and braces: never wire the page twice
  window.__ranchChrome = true;
  initMenu();
  initAuthNav();
  document.querySelectorAll('[data-year]').forEach((n) => { n.textContent = new Date().getFullYear(); });
  // Swallow clicks and submits while an action is already running.
  document.addEventListener('click', (e) => {
    if (isBusy(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('submit', (e) => {
    if (e.target.querySelector('[data-busy]')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
