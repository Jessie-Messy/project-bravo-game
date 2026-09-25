import { api, el, icon, money, fmtDate } from './common.js';

const q = new URLSearchParams(location.search);
const ref = q.get('ref') || '';
const t = q.get('t') || '';
const cancelled = q.has('cancelled');
const box = document.getElementById('status');
let tries = 0;

function show(kind, title, ...body) {
  const h = el('h1', { tabindex: '-1' }, title);
  box.replaceChildren(el('div', { class: `big-icon ${kind}`, 'aria-hidden': 'true' }, icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'x' : 'clock')), h, ...body);
  h.focus();
}

function summary(s) {
  const parts = [s.house ? 'Ranch house' : null, s.stalls ? `${s.stalls} stall${s.stalls > 1 ? 's' : ''}` : null, s.rvSites ? `${s.rvSites} RV site${s.rvSites > 1 ? 's' : ''}` : null].filter(Boolean);
  return el('p', { class: 'lede' }, `${fmtDate(s.checkIn)} → ${fmtDate(s.checkOut)} · ${parts.join(', ')} · ${money(s.amount, s.currency)}`);
}

async function check() {
  let s;
  try { s = await api(`/api/bookings/status?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(t)}`); }
  catch (e) { show('bad', 'We couldn’t find that booking', el('p', {}, e.message), el('p', {}, el('a', { href: '/#book' }, 'Start a new booking'))); return; }

  if (s.status === 'confirmed') {
    show('ok', 'You’re booked!', summary(s),
      el('p', {}, `Confirmation number `, el('strong', {}, s.ref)),
      el('p', {}, 'We’ve emailed you a confirmation. If you’re new here, it has a link to create your password — then you can watch your stall cameras from your account.'),
      el('p', {}, el('a', { class: 'btn', href: '/account' }, 'Go to my account')));
    return;
  }
  if (s.status === 'pending' && cancelled) {
    await api('/api/bookings/release', { method: 'POST', body: { ref, t } }).catch(() => {});
    show('bad', 'Payment cancelled', el('p', {}, 'No payment was taken and your dates have been released.'), el('p', {}, el('a', { class: 'btn', href: '/#book' }, 'Back to booking')));
    return;
  }
  if (s.status === 'pending') {
    if (tries++ < 20) {
      show('wait', 'Confirming your payment…', summary(s), el('p', {}, 'This usually takes a few seconds. You can leave this page — we’ll email you as soon as it’s confirmed.'));
      setTimeout(check, Math.min(1500 * tries, 6000));
    } else {
      show('wait', 'Still confirming', summary(s), el('p', {}, 'Your payment is taking longer than usual to confirm. We’ll email you the moment it does — no need to book again.'));
    }
    return;
  }
  if (s.status === 'needs_attention') {
    show('wait', 'We’re finishing your booking', summary(s), el('p', {}, 'Your payment went through, but we need to double-check something by hand. We’ll be in touch shortly.'));
    return;
  }
  show('bad', 'This booking expired', el('p', {}, 'The 30-minute hold ended before payment was completed, so no money was taken.'), el('p', {}, el('a', { class: 'btn', href: '/#book' }, 'Book again')));
}

history.replaceState(null, '', `/booking?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(t)}`);
check();
