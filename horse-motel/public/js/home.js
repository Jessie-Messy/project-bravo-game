import { api, money, fmtDate, el, fieldError, clearErrors, showAlert, busy, announce } from './common.js';

// ════════════════════════ Gallery ════════════════════════
function initGallery() {
  const list = document.getElementById('gallery');
  const dialog = document.getElementById('lightbox');
  if (!list || !dialog) return;
  const items = [...list.querySelectorAll('li')];
  const status = document.getElementById('gallery-status');
  const img = document.getElementById('lightbox-img');
  const caption = document.getElementById('lightbox-caption');
  const count = document.getElementById('lightbox-count');
  let visible = items;
  let current = 0;
  let opener = null;

  document.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      items.forEach((li) => { li.hidden = f !== 'all' && li.dataset.group !== f; });
      visible = items.filter((li) => !li.hidden);
      status.textContent = `Showing ${visible.length} ${f === 'all' ? '' : f.toLowerCase() + ' '}photos`;
    });
  });

  function show(i) {
    current = (i + visible.length) % visible.length;
    const btn = visible[current].querySelector('button');
    const thumb = btn.querySelector('img');
    const alt = btn.getAttribute('aria-label').replace(/^View larger: /, '');
    img.src = thumb.currentSrc.replace(/-(480|960)\.webp$/, '-1600.webp') || thumb.src;
    img.srcset = thumb.srcset;
    img.sizes = '100vw';
    img.alt = alt;
    caption.textContent = alt;
    count.textContent = `Photo ${current + 1} of ${visible.length}`;
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (!btn) return;
    opener = btn;
    show(visible.indexOf(btn.closest('li')));
    dialog.showModal();
    dialog.querySelector('[data-next]').focus();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-prev]').addEventListener('click', () => show(current - 1));
  dialog.querySelector('[data-next]').addEventListener('click', () => show(current + 1));
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(current - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(current + 1); }
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { opener?.focus(); });

  // Swipe between photos on touch screens.
  let startX = null;
  dialog.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  dialog.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) show(current + (dx < 0 ? 1 : -1));
    startX = null;
  });
}

// ════════════════════════ Booking ════════════════════════
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + 'T00:00:00Z');
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monthStart = (s) => s.slice(0, 8) + '01';
const addMonths = (s, n) => { const d = parse(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function initBooking() {
  const form = document.getElementById('booking-form');
  if (!form) return;
  const site = await api('/api/site').catch(() => null);
  if (!site) {
    showAlert(document.getElementById('booking-error'), 'Booking is unavailable right now. Please try again shortly.');
    return;
  }
  const inv = site.inventory;
  const maxDate = addDays(site.today, inv.bookingWindowDays);
  const state = { checkIn: null, checkOut: null, stalls: Math.min(1, inv.stall), rvSites: 0, house: false, guests: 2 };
  let view = monthStart(site.today);
  let focusDate = site.today;
  const avail = {};            // night -> {house, stalls, rvSites}
  const loaded = new Set();    // months fetched

  // Prices shown next to each option.
  document.getElementById('stalls-price').textContent = `${money(site.pricing.stallNight)} per stall, per night`;
  document.getElementById('rv-price').textContent = `${money(site.pricing.rvNight)} per site, per night · power & water`;
  document.getElementById('house-price').textContent = `${money(site.pricing.houseNight)} per night · 3 bedrooms, sleeps ${inv.maxGuests}`;
  if (site.testPayments) document.getElementById('test-mode').hidden = false;

  const calendar = document.getElementById('calendar');
  const inIn = document.getElementById('check-in');
  const inOut = document.getElementById('check-out');
  inIn.min = site.today; inIn.max = maxDate;
  inOut.min = addDays(site.today, 1); inOut.max = addDays(maxDate, 1);

  async function ensure(month) {
    const need = [month, addMonths(month, 1)].filter((m) => !loaded.has(m));
    if (!need.length) return;
    need.forEach((m) => loaded.add(m));
    const from = need[0];
    try {
      const data = await api(`/api/availability?from=${from}&days=${need.length * 31 + 7}`);
      Object.assign(avail, data.days);
    } catch { need.forEach((m) => loaded.delete(m)); }
  }

  function nightOk(night) {
    const a = avail[night];
    if (!a) return night >= site.today && night <= maxDate; // unknown: let the server decide
    return a.stalls >= state.stalls && a.rvSites >= state.rvSites && (!state.house || a.house >= 1);
  }
  const rangeOk = (a, b) => { for (let d = a; d < b; d = addDays(d, 1)) if (!nightOk(d)) return d; return null; };
  const selectable = (d) => d >= site.today && d <= addDays(maxDate, 1);

  function dayLabel(d) {
    const dt = parse(d);
    let s = `${WEEKDAYS_LONG[dt.getUTCDay()]}, ${fmtDate(d, { month: 'long', day: 'numeric', year: 'numeric' })}`;
    if (d === state.checkIn) s += ', your check-in';
    else if (d === state.checkOut) s += ', your check-out';
    else if (state.checkIn && state.checkOut && d > state.checkIn && d < state.checkOut) s += ', in your stay';
    if (!selectable(d)) return s + ', not bookable';
    const a = avail[d];
    if (a) {
      if (!nightOk(d)) s += ', not available for what you’ve chosen';
      s += `, ${a.stalls} of ${inv.stall} stalls free${a.house ? ', house free' : ', house booked'}`;
    }
    return s;
  }

  function renderMonth(month) {
    const first = parse(month);
    const title = first.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
    const titleId = `m-${month}`;
    const table = el('table', { class: 'cal', role: 'grid', 'aria-labelledby': titleId });
    const thead = el('thead', {}, el('tr', {}, WEEKDAYS.map((w, i) => el('th', { scope: 'col', abbr: WEEKDAYS_LONG[i] }, w))));
    const tbody = el('tbody');
    let d = addDays(month, -first.getUTCDay());
    for (let w = 0; w < 6; w++) {
      const row = el('tr');
      for (let i = 0; i < 7; i++, d = addDays(d, 1)) {
        if (d.slice(0, 7) !== month.slice(0, 7)) { row.append(el('td', { role: 'gridcell' })); continue; }
        const inStay = state.checkIn && state.checkOut && d > state.checkIn && d < state.checkOut;
        const a = avail[d];
        const cls = ['day'];
        if (d === site.today) cls.push('today');
        if (d === state.checkIn) cls.push('range-start');
        if (d === state.checkOut) cls.push('range-end');
        if (inStay) cls.push('in-range');
        const bookable = selectable(d);
        if (bookable && a && !nightOk(d) && d !== state.checkOut) cls.push('full');
        const btn = el('button', {
          type: 'button', class: cls.join(' '), 'data-date': d, tabindex: d === focusDate ? '0' : '-1',
          'aria-label': dayLabel(d), 'aria-pressed': String(d === state.checkIn || d === state.checkOut),
          'aria-disabled': bookable ? null : 'true',
        }, el('span', { 'aria-hidden': 'true' }, String(parse(d).getUTCDate())),
          bookable && a && d <= maxDate ? el('span', { class: 'free', 'aria-hidden': 'true' }, String(a.stalls)) : null);
        row.append(el('td', { role: 'gridcell' }, btn));
      }
      tbody.append(row);
      if (d.slice(0, 7) !== month.slice(0, 7) && w >= 4) break;
    }
    table.append(thead, tbody);
    return el('div', { class: 'month' }, el('h4', { id: titleId }, title), table);
  }

  async function render({ focus = false } = {}) {
    calendar.setAttribute('aria-busy', 'true');
    await ensure(view);
    const months = [renderMonth(view), renderMonth(addMonths(view, 1))];
    calendar.replaceChildren(...months);
    calendar.setAttribute('aria-busy', 'false');
    document.getElementById('cal-prev').disabled = view <= monthStart(site.today);
    document.getElementById('cal-next').disabled = addMonths(view, 1) >= monthStart(maxDate);
    // Make sure one day is always tabbable.
    if (!calendar.querySelector('[tabindex="0"]')) {
      const firstBtn = calendar.querySelector(`.day:not([aria-disabled])`) || calendar.querySelector('.day');
      if (firstBtn) { firstBtn.tabIndex = 0; focusDate = firstBtn.dataset.date; }
    }
    if (focus) calendar.querySelector(`[data-date="${focusDate}"]`)?.focus();
    inIn.value = state.checkIn || '';
    inOut.value = state.checkOut || '';
  }

  function visibleMonths() { return [view.slice(0, 7), addMonths(view, 1).slice(0, 7)]; }
  function isNarrow() { return window.matchMedia('(max-width: 700px)').matches; }

  async function moveFocus(d) {
    if (d < monthStart(site.today) || d > addDays(maxDate, 1)) return;
    focusDate = d;
    const shown = isNarrow() ? [view.slice(0, 7)] : visibleMonths();
    if (!shown.includes(d.slice(0, 7))) {
      view = d < view ? monthStart(d) : (isNarrow() ? monthStart(d) : addMonths(monthStart(d), -1));
    }
    await render({ focus: true });
  }

  function pick(d) {
    if (!selectable(d)) return;
    fieldError(inIn, ''); fieldError(inOut, '');
    if (!state.checkIn || state.checkOut || d <= state.checkIn) {
      if (d > maxDate) return;
      if (!nightOk(d)) { announce(`${fmtDate(d)} isn’t available for what you’ve chosen. Try fewer stalls or another date.`); return; }
      state.checkIn = d; state.checkOut = null;
      announce(`Check-in ${fmtDate(d)} selected. Now choose your check-out date.`);
    } else {
      const bad = rangeOk(state.checkIn, d);
      if (bad) { announce(`The night of ${fmtDate(bad)} isn’t available. Choose an earlier check-out or different dates.`); return; }
      if ((parse(d) - parse(state.checkIn)) / 864e5 > inv.maxNights) { announce(`Stays can be up to ${inv.maxNights} nights.`); return; }
      state.checkOut = d;
      announce(`Check-out ${fmtDate(d)} selected. ${(parse(d) - parse(state.checkIn)) / 864e5} nights.`);
    }
    focusDate = d;
    render({ focus: true });
    updateQuote();
  }

  calendar.addEventListener('click', (e) => {
    const b = e.target.closest('.day');
    if (b && b.getAttribute('aria-disabled') !== 'true') pick(b.dataset.date);
  });
  calendar.addEventListener('keydown', (e) => {
    const b = e.target.closest('.day');
    if (!b) return;
    const d = b.dataset.date;
    const dow = parse(d).getUTCDay();
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -dow, End: 6 - dow };
    if (e.key in moves) { e.preventDefault(); moveFocus(addDays(d, moves[e.key])); }
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const t = parse(d); t.setUTCMonth(t.getUTCMonth() + (e.key === 'PageUp' ? -1 : 1));
      moveFocus(iso(t));
    }
  });
  document.getElementById('cal-prev').addEventListener('click', () => { view = addMonths(view, -1); render(); });
  document.getElementById('cal-next').addEventListener('click', () => { view = addMonths(view, 1); render(); });

  // Typed dates stay in sync with the calendar.
  inIn.addEventListener('change', async () => {
    const v = inIn.value;
    if (!v) { state.checkIn = null; return render(); }
    state.checkIn = v;
    if (state.checkOut && state.checkOut <= v) state.checkOut = null;
    view = monthStart(v); focusDate = v;
    await render(); updateQuote();
  });
  inOut.addEventListener('change', async () => {
    state.checkOut = inOut.value || null;
    await render(); updateQuote();
  });

  // Quantity steppers.
  const limits = { stalls: inv.stall, rvSites: inv.rv };
  function syncSteppers() {
    for (const key of ['stalls', 'rvSites']) {
      document.getElementById(key).textContent = state[key];
      form.querySelector(`[data-step="${key}"][data-dir="-1"]`).disabled = state[key] <= 0;
      form.querySelector(`[data-step="${key}"][data-dir="1"]`).disabled = state[key] >= limits[key];
    }
    document.getElementById('coggins-row').hidden = state.stalls === 0;
  }
  form.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.step;
    state[key] = Math.max(0, Math.min(limits[key], state[key] + Number(b.dataset.dir)));
    syncSteppers(); render(); updateQuote();
  }));
  const house = document.getElementById('house');
  const guests = document.getElementById('guests');
  guests.replaceChildren(...Array.from({ length: inv.maxGuests }, (_, i) => el('option', { value: i + 1, selected: i + 1 === state.guests }, String(i + 1))));
  house.addEventListener('change', () => {
    state.house = house.checked;
    document.getElementById('guests-field').hidden = !state.house;
    render(); updateQuote();
  });
  guests.addEventListener('change', () => { state.guests = Number(guests.value); updateQuote(); });

  // Live price.
  const quoteBox = document.getElementById('quote');
  let quoteSeq = 0;
  let quoteTimer;
  const stayPayload = () => ({ checkIn: state.checkIn, checkOut: state.checkOut, house: state.house,
    stalls: state.stalls, rvSites: state.rvSites, guests: state.house ? state.guests : 0 });
  function updateQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
      if (!state.checkIn || !state.checkOut) {
        quoteBox.replaceChildren(el('p', { class: 'muted m-0' }, state.checkIn ? 'Now choose your check-out date.' : 'Choose your dates to see the price.'));
        return;
      }
      if (!state.house && !state.stalls && !state.rvSites) {
        quoteBox.replaceChildren(el('p', { class: 'muted m-0' }, 'Add a stall, a hookup, or the house.'));
        return;
      }
      const seq = ++quoteSeq;
      try {
        const q = await api('/api/quote', { method: 'POST', body: stayPayload() });
        if (seq !== quoteSeq) return;
        if (!q.quote) { quoteBox.replaceChildren(el('p', { class: 'm-0' }, q.reason)); return; }
        const rows = q.quote.lines.map((l) => el('tr', {}, el('td', {}, l.label), el('td', {}, money(l.total, q.quote.currency))));
        quoteBox.replaceChildren(
          el('p', { class: 'm-0', }, el('strong', {}, `${fmtDate(state.checkIn)} → ${fmtDate(state.checkOut)}`), ` · ${q.quote.nights} night${q.quote.nights > 1 ? 's' : ''}`),
          el('table', {}, el('caption', { class: 'visually-hidden' }, 'Price breakdown'), el('tbody', {}, rows),
            el('tfoot', {}, el('tr', {}, el('td', {}, 'Total'), el('td', {}, money(q.quote.total, q.quote.currency))))),
          q.ok ? null : el('p', { class: 'field-error mt-14', role: 'alert' }, q.reason),
        );
      } catch (e) {
        if (seq === quoteSeq) quoteBox.replaceChildren(el('p', { class: 'm-0' }, e.message));
      }
    }, 250);
  }

  // Submit.
  const errorBox = document.getElementById('booking-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    errorBox.hidden = true;
    const f = (id) => document.getElementById(id);
    const problems = [];
    const need = (input, ok, msg) => { if (!ok) { fieldError(input, msg); problems.push(input); } };
    need(inIn, !!state.checkIn, 'Choose a check-in date.');
    need(inOut, !!state.checkOut, 'Choose a check-out date.');
    need(f('name'), f('name').value.trim().length >= 2, 'Enter your full name.');
    need(f('email'), /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f('email').value.trim()), 'Enter an email address like name@example.com.');
    need(f('phone'), f('phone').value.replace(/\D/g, '').length >= 7, 'Enter a phone number we can reach you on.');
    if (state.stalls > 0) need(f('agree-coggins'), f('agree-coggins').checked, 'Please confirm your horses’ Coggins tests.');
    need(f('agree-rules'), f('agree-rules').checked, 'Please accept the ranch rules to continue.');
    if (!state.house && !state.stalls && !state.rvSites) {
      showAlert(errorBox, 'Add at least one stall, a hookup, or the house.');
      return;
    }
    if (problems.length) {
      showAlert(errorBox, `Please fix ${problems.length} ${problems.length === 1 ? 'thing' : 'things'} before continuing.`);
      problems[0].focus();
      return;
    }
    const btn = document.getElementById('book-btn');
    busy(btn, true, 'Holding your dates…');
    try {
      const out = await api('/api/bookings', { method: 'POST', body: {
        stay: stayPayload(),
        contact: { name: f('name').value.trim(), email: f('email').value.trim(), phone: f('phone').value.trim(), notes: f('notes').value.trim() },
        agree: { rules: f('agree-rules').checked, coggins: state.stalls > 0 ? f('agree-coggins').checked : false },
      } });
      const url = new URL(out.checkoutUrl, location.origin);
      if (url.origin !== location.origin && url.origin !== 'https://checkout.stripe.com') throw new Error('Unexpected payment address.');
      announce('Taking you to secure payment…');
      location.assign(url.href);
    } catch (err) {
      busy(btn, false);
      const field = err.body?.field;
      const map = { 'contact.name': 'name', name: 'name', email: 'email', phone: 'phone' };
      const target = field && f(map[field.split('.').pop()] || '');
      if (target) { fieldError(target, err.message); target.focus(); }
      else showAlert(errorBox, err.message);
      if (err.status === 409) { loaded.clear(); render(); updateQuote(); }
    }
  });

  syncSteppers();
  await render();
}

initGallery();
initBooking();
