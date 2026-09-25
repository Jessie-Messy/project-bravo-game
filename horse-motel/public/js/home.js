import { api, getSession, money, fmtDate, fmtTime, el, fieldError, clearErrors, showAlert, busy, announce } from './common.js';

// sessionStorage can be unavailable (private mode, blocked storage): never let that break booking.
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

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
  const live = document.getElementById('lightbox-live');
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
    const alt = btn.dataset.alt;
    img.src = thumb.currentSrc.replace(/-(480|960)\.webp$/, '-1600.webp') || thumb.src;
    img.srcset = thumb.srcset;
    img.sizes = '100vw';
    img.alt = alt;
    caption.textContent = alt;
    count.textContent = `Photo ${current + 1} of ${visible.length}`;
    live.textContent = `Photo ${current + 1} of ${visible.length}: ${alt}`;
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (!btn) return;
    opener = btn;
    show(visible.indexOf(btn.closest('li')));
    dialog.showModal();
    ctaUpdate?.({ lightbox: true });
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
  dialog.addEventListener('close', () => { live.textContent = ''; ctaUpdate?.({ lightbox: false }); opener?.focus(); });

  // Swipe between photos on touch screens (buttons do the same for everyone else).
  let startX = null;
  dialog.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  dialog.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) show(current + (dx < 0 ? 1 : -1));
    startX = null;
  });
}

// ════════════════════════ Sticky "check availability" bar (phones) ════════════════════════
let ctaUpdate = null;
function initMobileCta() {
  const bar = document.getElementById('mobile-cta');
  const book = document.getElementById('book');
  const hero = document.querySelector('.hero');
  if (!bar || !book || !('IntersectionObserver' in window)) return;
  const seen = { book: false, hero: true, lightbox: false };
  const update = (patch = {}) => {
    Object.assign(seen, patch);
    const show = !seen.book && !seen.hero && !seen.lightbox;
    bar.hidden = !show;
    document.documentElement.classList.toggle('has-cta', show);
  };
  ctaUpdate = update;
  // Keep the page's bottom padding equal to the bar's real height (it grows with zoom).
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => document.documentElement.style.setProperty('--cta-h', `${bar.offsetHeight || 64}px`)).observe(bar);
  }
  new IntersectionObserver((entries) => {
    for (const e of entries) seen[e.target === book ? 'book' : 'hero'] = e.isIntersecting;
    update();
  }).observe(book);
  new IntersectionObserver((entries) => { seen.hero = entries[0].isIntersecting; update(); }).observe(hero);
}

// ════════════════════════ Booking ════════════════════════
const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + 'T00:00:00Z');
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monthStart = (s) => s.slice(0, 8) + '01';
const addMonths = (s, n) => { const d = parse(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
const nightsBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function initBooking() {
  const form = document.getElementById('booking-form');
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const site = await api('/api/site').catch(() => null);
  if (!site) {
    showAlert($('booking-error'), 'Booking is unavailable right now. Please try again shortly, or contact us.');
    return;
  }
  const inv = site.inventory;
  const maxDate = addDays(site.today, inv.bookingWindowDays);
  const draft = store.get('rc-draft') || {};
  const state = {
    checkIn: null, checkOut: null, stalls: Math.min(1, inv.stall), rvSites: 0, rvSewer: 0, house: false, guests: 2,
    ...(draft.state || {}),
  };
  if (state.checkIn && state.checkIn < site.today) { state.checkIn = null; state.checkOut = null; }
  let view = monthStart(state.checkIn || site.today);
  let focusDate = state.checkIn || site.today;
  let free = null;             // the fewest free of each thing across the chosen dates
  const avail = {};            // night -> {house, stalls, rvSites, rvSewer}
  const loaded = new Set();    // months fetched

  // Prices shown next to each option.
  $('stalls-price').textContent = `${money(site.pricing.stallNight)} per stall, per night`;
  $('rv-price').textContent = `${money(site.pricing.rvNight)} per site, per night`;
  $('rvs-price').textContent = `${money(site.pricing.rvSewerNight)} per site, per night`;
  $('house-price').textContent = `${money(site.pricing.houseNight)} per night · 3 bedrooms, sleeps\u00a0${inv.maxGuests}`;
  $('sewer-row').hidden = !inv.rvSewer;
  if (site.testPayments) $('test-mode').hidden = false;

  const calendar = $('calendar');
  const calMsg = $('cal-msg');
  const inIn = $('check-in');
  const inOut = $('check-out');
  inIn.min = site.today; inIn.max = maxDate;
  inOut.min = addDays(site.today, 1); inOut.max = addDays(maxDate, 1);

  const say = (text, kind = 'ok') => { calMsg.textContent = text; calMsg.className = `cal-msg ${kind}`; };

  async function ensure(month, count) {
    const need = Array.from({ length: count }, (_, i) => addMonths(month, i)).filter((m) => !loaded.has(m));
    if (!need.length) return;
    need.forEach((m) => loaded.add(m));
    try {
      const data = await api(`/api/availability?from=${need[0]}&days=${need.length * 31 + 7}`);
      Object.assign(avail, data.days);
    } catch { need.forEach((m) => loaded.delete(m)); }
  }

  function nightOk(night) {
    const a = avail[night];
    if (!a) return night >= site.today && night <= maxDate; // unknown: let the server decide
    return a.stalls >= state.stalls && a.rvSewer >= state.rvSewer && a.rvSites >= state.rvSites + state.rvSewer
      && (!state.house || a.house >= 1);
  }
  const firstBadNight = (a, b) => { for (let d = a; d < b; d = addDays(d, 1)) if (!nightOk(d)) return d; return null; };
  const selectable = (d) => d >= site.today && d <= addDays(maxDate, 1);
  // A date after the chosen check-in that works as a check-out (its own night doesn't matter).
  const validCheckout = (d) => state.checkIn && !state.checkOut && d > state.checkIn
    && nightsBetween(state.checkIn, d) <= inv.maxNights && !firstBadNight(state.checkIn, d);

  // What the little number under each date counts, following what's being booked.
  function counted() {
    if (state.stalls) return { key: 'stalls', label: 'stalls free', legend: 'Stalls still free that night' };
    if (state.rvSewer) return { key: 'rvSewer', label: 'full hookups free', legend: 'Full hookups still free that night' };
    if (state.rvSites) return { key: 'rvSites', label: 'RV sites free', legend: 'RV sites still free that night' };
    return null;
  }

  function dayLabel(d) {
    const dt = parse(d);
    let s = `${d === site.today ? 'Today, ' : ''}${WEEKDAYS_LONG[dt.getUTCDay()]}, ${fmtDate(d, { month: 'long', day: 'numeric', year: 'numeric' })}`;
    if (d === state.checkIn) s += ', your check-in';
    else if (d === state.checkOut) s += ', your check-out';
    else if (state.checkIn && state.checkOut && d > state.checkIn && d < state.checkOut) s += ', in your stay';
    if (!selectable(d)) return s + ', not bookable';
    const a = avail[d];
    if (!a || d > maxDate) return s;
    if (validCheckout(d)) s += ', available as check-out';
    else if (!nightOk(d)) s += ', not available for what you’ve chosen';
    const parts = [`${a.stalls} of ${inv.stall} stalls free`];
    if (state.rvSites || state.rvSewer) parts.push(`${a.rvSites} RV sites free, ${a.rvSewer} with sewer`);
    parts.push(a.house ? 'house free' : 'house booked');
    return `${s}. ${parts.join(', ')}`;
  }

  const monthsShown = () => (window.matchMedia('(max-width: 700px)').matches ? 1 : 2);

  function renderMonth(month) {
    const first = parse(month);
    const title = first.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
    const titleId = `m-${month}`;
    const table = el('table', { class: 'cal', role: 'grid', 'aria-labelledby': titleId, 'aria-describedby': 'cal-help' });
    const thead = el('thead', {}, el('tr', {}, WEEKDAYS.map((w, i) => el('th', { scope: 'col', abbr: WEEKDAYS_LONG[i] },
      el('span', { 'aria-hidden': 'true' }, w), el('span', { class: 'visually-hidden' }, WEEKDAYS_LONG[i])))));
    const tbody = el('tbody');
    const count = counted();
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
        if (bookable && a && !nightOk(d) && d !== state.checkOut && !validCheckout(d)) cls.push('full');
        const selected = d === state.checkIn || d === state.checkOut || inStay;
        const btn = el('button', {
          type: 'button', class: cls.join(' '), 'data-date': d, tabindex: d === focusDate ? '0' : '-1',
          'aria-label': dayLabel(d), 'aria-current': d === site.today ? 'date' : null,
          'aria-disabled': bookable ? null : 'true',
        }, el('span', { 'aria-hidden': 'true' }, String(parse(d).getUTCDate())),
          count && bookable && a && d <= maxDate ? el('span', { class: 'free', 'aria-hidden': 'true' }, String(a[count.key])) : null);
        row.append(el('td', { role: 'gridcell', 'aria-selected': String(!!selected) }, btn));
      }
      tbody.append(row);
      if (d.slice(0, 7) !== month.slice(0, 7) && w >= 4) break;
    }
    table.append(thead, tbody);
    return { node: el('div', { class: 'month' }, el('h4', { id: titleId }, title), table), title };
  }

  async function render({ focus = false } = {}) {
    const n = monthsShown();
    calendar.setAttribute('aria-busy', 'true');
    await ensure(view, n);
    const months = Array.from({ length: n }, (_, i) => renderMonth(addMonths(view, i)));
    calendar.replaceChildren(...months.map((m) => m.node));
    calendar.setAttribute('aria-busy', 'false');
    const title = n === 1 ? months[0].title : `${months[0].title.split(' ')[0]} – ${months[1].title}`;
    if ($('cal-title').textContent !== title) $('cal-title').textContent = title; // announced on month change
    setDisabled($('cal-prev'), view <= monthStart(site.today));
    setDisabled($('cal-next'), addMonths(view, n - 1) >= monthStart(maxDate));
    const count = counted();
    $('legend-count').parentElement.hidden = !count;
    if (count) $('legend-count').textContent = count.legend;
    // One day is always tabbable, and it's in a month that's showing.
    if (!calendar.querySelector('[tabindex="0"]')) {
      const firstBtn = calendar.querySelector('.day:not([aria-disabled])') || calendar.querySelector('.day');
      if (firstBtn) { firstBtn.tabIndex = 0; focusDate = firstBtn.dataset.date; }
    }
    if (focus) calendar.querySelector(`[data-date="${focusDate}"]`)?.focus();
    inIn.value = state.checkIn || '';
    inOut.value = state.checkOut || '';
  }

  function setDisabled(btn, off) {
    // aria-disabled keeps focus on the button when it reaches the end of the range.
    if (off) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
  }

  async function moveFocus(d) {
    if (d < site.today || d > addDays(maxDate, 1)) return;
    const target = calendar.querySelector(`[data-date="${d}"]`);
    if (target) {
      // Same month(s) on screen: just move focus, don't rebuild the grid.
      calendar.querySelector('[tabindex="0"]')?.setAttribute('tabindex', '-1');
      target.tabIndex = 0;
      focusDate = d;
      target.focus();
      return;
    }
    focusDate = d;
    view = d < view ? monthStart(d) : addMonths(monthStart(d), 1 - monthsShown());
    if (view < monthStart(site.today)) view = monthStart(site.today);
    await render({ focus: true });
  }

  function pick(d) {
    if (!selectable(d)) return;
    fieldError(inIn, ''); fieldError(inOut, '');
    if (!state.checkIn || state.checkOut || d <= state.checkIn) {
      if (d > maxDate) { say('That’s too far ahead to book online yet.', 'error'); return; }
      if (!nightOk(d)) {
        say(`${fmtDate(d)} isn’t available for what you’ve chosen. Try another date, or fewer stalls or hookups.`, 'error');
        return;
      }
      state.checkIn = d; state.checkOut = null;
      say(`Check-in ${fmtDate(d)}. Now choose your check-out date.`);
    } else {
      const bad = firstBadNight(state.checkIn, d);
      if (bad) { say(`The night of ${fmtDate(bad)} is already taken. Choose an earlier check-out, or different dates.`, 'error'); return; }
      const nights = nightsBetween(state.checkIn, d);
      if (nights > inv.maxNights) { say(`Online stays can be up to ${inv.maxNights} nights. For longer, contact us.`, 'error'); return; }
      state.checkOut = d;
      say(`${fmtDate(state.checkIn)} to ${fmtDate(d)}: ${nights} night${nights > 1 ? 's' : ''}.`);
    }
    focusDate = d;
    saveDraft();
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
  $('cal-prev').addEventListener('click', (e) => {
    if (e.currentTarget.getAttribute('aria-disabled')) return;
    view = addMonths(view, -1); render().then(() => announce($('cal-title').textContent));
  });
  $('cal-next').addEventListener('click', (e) => {
    if (e.currentTarget.getAttribute('aria-disabled')) return;
    view = addMonths(view, 1); render().then(() => announce($('cal-title').textContent));
  });
  window.matchMedia('(max-width: 700px)').addEventListener('change', () => render());

  // Typed dates stay in sync with the calendar.
  inIn.addEventListener('change', async () => {
    fieldError(inIn, '');
    const v = inIn.value;
    if (!v) { state.checkIn = null; return render(); }
    if (v < site.today) { fieldError(inIn, 'Check-in can’t be in the past.'); return; }
    state.checkIn = v;
    if (state.checkOut && state.checkOut <= v) state.checkOut = null;
    view = monthStart(v); focusDate = v;
    saveDraft();
    await render(); updateQuote();
  });
  inOut.addEventListener('change', async () => {
    fieldError(inOut, '');
    const v = inOut.value;
    if (v && state.checkIn) {
      const bad = v > state.checkIn ? firstBadNight(state.checkIn, v) : null;
      const problem = v <= state.checkIn ? 'Check-out must be after check-in.'
        : nightsBetween(state.checkIn, v) > inv.maxNights ? `Online stays can be up to ${inv.maxNights} nights. For longer, contact us.`
          : bad ? `The night of ${fmtDate(bad)} is already taken. Choose an earlier check-out, or different dates.` : null;
      if (problem) { fieldError(inOut, problem); return; }
    }
    state.checkOut = inOut.value || null;
    saveDraft();
    await render(); updateQuote();
  });

  // Quantity steppers, capped by what's actually free for the chosen dates.
  const stepLabels = { stalls: ['stall', 'stalls'], rvSites: ['power and water hookup', 'power and water hookups'], rvSewer: ['full hookup', 'full hookups'] };
  function limitFor(key) {
    const f = free || { stalls: inv.stall, rvSites: inv.rv, rvSewer: inv.rvSewer };
    if (key === 'stalls') return f.stalls;
    if (key === 'rvSewer') return Math.min(f.rvSewer, f.rvSites - state.rvSites);
    return f.rvSites - state.rvSewer;
  }
  function syncSteppers() {
    for (const key of ['stalls', 'rvSites', 'rvSewer']) {
      const max = Math.max(0, limitFor(key));
      if ($(key).textContent !== String(state[key])) $(key).textContent = state[key];
      setDisabled(form.querySelector(`[data-step="${key}"][data-dir="-1"]`), state[key] <= 0);
      setDisabled(form.querySelector(`[data-step="${key}"][data-dir="1"]`), state[key] >= max);
      const left = $(`${key}-left`);
      const leftText = free && state.checkIn && state.checkOut ? `${max === 0 && state[key] === 0 ? 'None' : max} left for your dates` : '';
      if (left.textContent !== leftText) left.textContent = leftText;
    }
    $('coggins-row').hidden = state.stalls === 0;
  }
  form.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled')) return;
    const key = b.dataset.step;
    state[key] = Math.max(0, Math.min(limitFor(key), state[key] + Number(b.dataset.dir)));
    announce(`${state[key]} ${stepLabels[key][state[key] === 1 ? 0 : 1]}`);
    syncSteppers(); saveDraft(); render(); updateQuote();
  }));
  const house = $('house');
  const guests = $('guests');
  guests.replaceChildren(...Array.from({ length: inv.maxGuests }, (_, i) => el('option', { value: i + 1, selected: i + 1 === state.guests }, String(i + 1))));
  house.checked = state.house;
  $('guests-field').hidden = !state.house;
  house.addEventListener('change', () => {
    state.house = house.checked;
    $('guests-field').hidden = !state.house;
    saveDraft(); render(); updateQuote();
  });
  guests.addEventListener('change', () => { state.guests = Number(guests.value); saveDraft(); updateQuote(); });

  // Live price. The box itself isn't a live region (it would re-read the whole table on
  // every change); one short summary is announced instead.
  const quoteBox = $('quote');
  let quoteSeq = 0;
  let quoteTimer;
  const stayPayload = () => ({ checkIn: state.checkIn, checkOut: state.checkOut, house: state.house,
    stalls: state.stalls, rvSites: state.rvSites, rvSewer: state.rvSewer, guests: state.house ? state.guests : 0 });
  function updateQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
      if (!state.checkIn || !state.checkOut) {
        free = null; syncSteppers();
        quoteBox.replaceChildren(el('p', { class: 'muted m-0' }, state.checkIn ? 'Now choose your check-out date.' : 'Choose your dates to see the price.'));
        return;
      }
      if (!state.house && !state.stalls && !state.rvSites && !state.rvSewer) {
        quoteBox.replaceChildren(el('p', { class: 'muted m-0' }, 'Add a stall, a hookup, or the house.'));
        return;
      }
      const seq = ++quoteSeq;
      try {
        const q = await api('/api/quote', { method: 'POST', body: stayPayload() });
        if (seq !== quoteSeq) return;
        if (q.free) { free = q.free; syncSteppers(); }
        if (!q.quote) { quoteBox.replaceChildren(el('p', { class: 'm-0' }, q.reason)); announce(q.reason); return; }
        const rows = q.quote.lines.map((l) => el('tr', {}, el('td', {}, l.label), el('td', {}, money(l.total, q.quote.currency))));
        quoteBox.replaceChildren(
          el('p', { class: 'm-0' }, el('strong', {}, `${fmtDate(state.checkIn)} → ${fmtDate(state.checkOut)}`), ` · ${q.quote.nights} night${q.quote.nights > 1 ? 's' : ''}`),
          el('table', {}, el('caption', { class: 'visually-hidden' }, 'Price breakdown'), el('tbody', {}, rows),
            el('tfoot', {}, el('tr', {}, el('td', {}, 'Total'), el('td', {}, money(q.quote.total, q.quote.currency))))),
          ...(q.ok ? [] : [el('p', { class: 'field-error mt-14' }, q.reason)]),
        );
        announce(q.ok ? `Total ${money(q.quote.total, q.quote.currency)} for ${q.quote.nights} night${q.quote.nights > 1 ? 's' : ''}.` : q.reason);
      } catch (e) {
        if (seq === quoteSeq) quoteBox.replaceChildren(el('p', { class: 'm-0' }, e.message));
      }
    }, 300);
  }

  // Draft: survives a trip to checkout and back, and a page reload.
  const fields = ['name', 'email', 'phone', 'notes'];
  function saveDraft() {
    store.set('rc-draft', { state, contact: Object.fromEntries(fields.map((f) => [f, $(f).value])) });
  }
  for (const f of fields) {
    if (draft.contact?.[f] && !$(f).value) $(f).value = draft.contact[f];
    $(f).addEventListener('input', saveDraft);
  }
  const confirmLine = $('confirm-email');
  const showConfirm = () => {
    const v = $('email').value.trim();
    confirmLine.hidden = !EMAIL_RE.test(v);
    confirmLine.textContent = EMAIL_RE.test(v) ? `We’ll send your confirmation and camera link to ${v}.` : '';
  };
  $('email').addEventListener('input', showConfirm);
  getSession().then(({ user }) => {
    if (!user || user.role !== 'guest') return;
    if (!$('name').value) $('name').value = user.name || '';
    if (!$('email').value) $('email').value = user.email || '';
    if (!$('phone').value) $('phone').value = user.phone || '';
    showConfirm();
  });
  showConfirm();

  // An unfinished payment from earlier (e.g. the Back button on the checkout page).
  const banner = $('pending-banner');
  async function checkPendingHold() {
    const hold = store.get('rc-hold');
    banner.hidden = true;
    if (!hold) return;
    let s = null;
    try { s = await api(`/api/bookings/status?ref=${encodeURIComponent(hold.ref)}&t=${encodeURIComponent(hold.t)}`); } catch { /* gone */ }
    if (!s || s.status !== 'pending' || !s.holdUntil || s.holdUntil < Date.now()) {
      if (s?.status === 'confirmed') store.del('rc-draft');
      store.del('rc-hold');
      return;
    }
    // Re-check the saved address before using it: only our own pages or Stripe's.
    let safeUrl = null;
    try { const u = new URL(hold.url, location.origin); if (u.origin === location.origin || u.origin === 'https://checkout.stripe.com') safeUrl = u.href; } catch { /* bad value */ }
    if (!safeUrl) { store.del('rc-hold'); return; }
    const resume = el('a', { class: 'btn small', href: safeUrl }, 'Continue to payment');
    const release = el('button', { type: 'button', class: 'btn secondary small' }, 'Release these dates');
    release.addEventListener('click', async () => {
      busy(release, true, 'Releasing…');
      await api('/api/bookings/release', { method: 'POST', body: { ref: hold.ref, t: hold.t } }).catch(() => {});
      store.del('rc-hold');
      loaded.clear();
      banner.replaceChildren(el('p', { class: 'm-0', tabindex: '-1' }, 'Released. Nothing was charged.'));
      banner.firstChild.focus();
      await render(); updateQuote();
    });
    banner.replaceChildren(
      el('p', { class: 'm-0' }, el('strong', {}, 'You have an unfinished booking. '),
        `${fmtDate(s.checkIn)} to ${fmtDate(s.checkOut)} is held for you until ${fmtTime(s.holdUntil, site.timezone)}. Nothing has been charged yet.`),
      el('div', { class: 'row-actions' }, resume, release));
    banner.hidden = false;
  }
  window.addEventListener('pageshow', (e) => { if (e.persisted) { loaded.clear(); checkPendingHold().then(() => render()); } });

  // Submit.
  const errorBox = $('booking-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    errorBox.hidden = true;
    const problems = [];
    const need = (input, ok, msg) => { if (!ok) { fieldError(input, msg); problems.push(input); } };
    const phoneOk = /^[0-9+().\-\s]+$/.test($('phone').value.trim());
    need(inIn, !!state.checkIn, 'Choose a check-in date on the calendar or type it here.');
    need(inOut, !!state.checkOut, 'Choose a check-out date.');
    need($('name'), $('name').value.trim().length >= 2, 'Enter your full name.');
    need($('email'), EMAIL_RE.test($('email').value.trim()), 'Enter an email address like name@example.com.');
    need($('phone'), phoneOk && $('phone').value.replace(/\D/g, '').length >= 7,
      phoneOk ? 'Enter a phone number with at least 7 digits.' : 'Use digits, spaces and + ( ) - only (no letters).');
    if (state.stalls > 0) need($('agree-coggins'), $('agree-coggins').checked, 'Please confirm your horses’ Coggins tests.');
    need($('agree-rules'), $('agree-rules').checked, 'Please accept the ranch rules to continue.');
    if (!state.house && !state.stalls && !state.rvSites && !state.rvSewer) {
      showAlert(errorBox, 'Add at least one stall, a hookup, or the house.');
      return;
    }
    if (problems.length) {
      showAlert(errorBox, `Please fix ${problems.length} ${problems.length === 1 ? 'thing' : 'things'} before continuing: ${problems.map((p) => (document.querySelector(`label[for="${p.id}"]`)?.textContent || '').trim().split('.')[0]).filter(Boolean).join('; ')}.`);
      problems[0].focus();
      return;
    }
    const btn = $('book-btn');
    busy(btn, true, 'Holding your dates…');
    saveDraft();
    try {
      const previous = store.get('rc-hold');
      const out = await api('/api/bookings', { method: 'POST', body: {
        stay: stayPayload(),
        contact: { name: $('name').value.trim(), email: $('email').value.trim(), phone: $('phone').value.trim(), notes: $('notes').value.trim() },
        agree: { rules: $('agree-rules').checked, coggins: state.stalls > 0 ? $('agree-coggins').checked : false },
        ...(previous ? { replace: { ref: previous.ref, t: previous.t } } : {}),
      } });
      const url = new URL(out.checkoutUrl, location.origin);
      if (url.origin !== location.origin && url.origin !== 'https://checkout.stripe.com') throw new Error('Unexpected payment address.');
      store.set('rc-hold', { ref: out.ref, t: out.statusToken, url: url.href, holdUntil: out.holdUntil });
      announce('Taking you to secure payment…');
      location.assign(url.href);
    } catch (err) {
      busy(btn, false);
      const field = err.body?.field;
      const map = { name: 'name', email: 'email', phone: 'phone', notes: 'notes', checkIn: 'check-in', checkOut: 'check-out', guests: 'guests' };
      const target = field && $(map[field.split('.').pop()] || '');
      if (target) { fieldError(target, err.message); target.focus(); }
      else showAlert(errorBox, err.message);
      if (err.status === 409) { loaded.clear(); render(); updateQuote(); }
    }
  });

  syncSteppers();
  await checkPendingHold();
  await render();
  if (state.checkIn && state.checkOut) {
    const n = nightsBetween(state.checkIn, state.checkOut);
    say(`${fmtDate(state.checkIn)} to ${fmtDate(state.checkOut)}: ${n} night${n > 1 ? 's' : ''}.`);
    updateQuote();
  } else if (state.checkIn) {
    say(`Check-in ${fmtDate(state.checkIn)}. Now choose your check-out date.`);
  }
}

initGallery();
initMobileCta();
initBooking();
