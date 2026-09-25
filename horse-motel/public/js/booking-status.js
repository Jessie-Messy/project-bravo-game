import { api, el, icon, money, fmtRange, fmtTime, focusHeading } from './common.js';

const q = new URLSearchParams(location.search);
const ref = q.get('ref') || '';
const t = q.get('t') || '';
const cancelled = q.has('cancelled');
const box = document.getElementById('status');
const store = { del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } } };
let shown = null;
let tries = 0;

// Renders a state once. Polling that finds the same state again changes nothing on
// screen and doesn't move focus, so screen reader and keyboard users aren't interrupted.
function show(key, kind, title, ...body) {
  if (shown === key) return;
  shown = key;
  const h = el('h1', {}, title);
  box.replaceChildren(el('div', { class: `big-icon ${kind}`, 'aria-hidden': 'true' }, icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'x' : 'clock')), h, ...body);
  focusHeading(h, `${title} — Rockin' C Ranch`);
}

function summary(s) {
  const parts = [s.house ? `Ranch house (${s.guests} guest${s.guests === 1 ? '' : 's'})` : null,
    s.stalls ? `${s.stalls} stall${s.stalls > 1 ? 's' : ''}` : null,
    s.rvSites ? `${s.rvSites} RV hookup${s.rvSites > 1 ? 's' : ''}` : null,
    s.rvSewer ? `${s.rvSewer} full hookup${s.rvSewer > 1 ? 's' : ''}` : null].filter(Boolean);
  return el('p', { class: 'lede' }, `${fmtRange(s.checkIn, s.checkOut)} · ${parts.join(', ')} · ${money(s.amount, s.currency)}`);
}

async function check() {
  let s;
  try { s = await api(`/api/bookings/status?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(t)}`); }
  catch (e) {
    show('missing', 'bad', 'We couldn’t find that booking', el('p', {}, e.message), el('p', {}, el('a', { href: '/#book' }, 'Start a new booking')));
    return;
  }

  if (s.status === 'confirmed') {
    store.del('rc-hold'); store.del('rc-draft');
    show('confirmed', 'ok', 'You’re booked!', summary(s),
      el('p', {}, 'Confirmation number ', el('strong', {}, s.ref)),
      s.units.length ? el('p', {}, `Reserved for you: ${s.units.join(', ')}.`) : null,
      el('p', {}, `We’ve emailed your confirmation to ${s.email}. If you’re new here, it has a link to create your password — then you can watch your stall cameras from your account.`),
      el('p', { class: 'small muted' }, 'Email not there after a few minutes? Check your spam folder, or contact us (details at the bottom of the page) if the address above looks wrong.'),
      el('p', {}, el('a', { class: 'btn secondary', href: '/login' }, 'I already have an account — sign in')));
    return;
  }
  if (s.status === 'pending' && cancelled) {
    await api('/api/bookings/release', { method: 'POST', body: { ref, t } }).catch(() => {});
    store.del('rc-hold');
    show('released', 'bad', 'Payment cancelled', el('p', {}, 'No payment was taken and your dates have been released. Your details are still filled in if you want to try again.'),
      el('p', {}, el('a', { class: 'btn', href: '/#book' }, 'Back to booking')));
    return;
  }
  if (s.status === 'pending') {
    const waiting = tries < 20;
    show(waiting ? 'waiting' : 'slow', 'wait', waiting ? 'Confirming your payment…' : 'Still confirming', summary(s),
      el('p', {}, waiting ? 'This usually takes a few seconds. You can leave this page — we’ll email you as soon as it’s confirmed.'
        : 'Your payment is taking longer than usual to confirm. We’ll email you the moment it does — no need to book again.'),
      s.holdUntil ? el('p', { class: 'small muted' }, `Your dates are held until ${fmtTime(s.holdUntil)}.`) : null);
    if (tries++ < 20) setTimeout(check, Math.min(1500 * tries, 6000));
    return;
  }
  if (s.status === 'needs_attention') {
    show('attention', 'wait', 'We’re finishing your booking', summary(s),
      el('p', {}, 'Your payment went through, but we need to double-check something by hand. We’ll be in touch shortly — you don’t need to do anything.'));
    return;
  }
  if (s.status === 'cancelled') {
    show('cancelled', 'bad', 'This booking was cancelled', summary(s),
      s.refunded ? el('p', {}, `${money(s.refunded, s.currency)} has been refunded to your card.`) : el('p', {}, 'Contact us if you have questions about a refund (details at the bottom of the page).'));
    return;
  }
  store.del('rc-hold');
  show('expired', 'bad', 'This booking expired',
    el('p', {}, cancelled ? 'Payment was cancelled, so no money was taken.' : 'The 30-minute hold ended before payment was completed, so no money was taken.'),
    el('p', {}, el('a', { class: 'btn', href: '/#book' }, 'Book again')));
}

check();
