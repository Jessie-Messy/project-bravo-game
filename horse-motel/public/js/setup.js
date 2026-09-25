import { api, getSession, fieldError, clearErrors, showAlert, busy } from './common.js';

// The token lives in the URL fragment (#token=…), which browsers never send to servers
// or put in Referer headers. Remove it from the address bar straight away.
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', location.pathname);

const loading = document.getElementById('setup-loading');
const invalid = document.getElementById('setup-invalid');
const form = document.getElementById('setup-form');
const pw = document.getElementById('password');
const pw2 = document.getElementById('password2');

document.getElementById('show-pw').addEventListener('change', (e) => {
  pw.type = pw2.type = e.target.checked ? 'text' : 'password';
});

function fail(msg) {
  loading.hidden = true;
  document.getElementById('setup-title').textContent = 'This link can’t be used';
  invalid.hidden = false;
  invalid.replaceChildren(msg, ' ', Object.assign(document.createElement('a'), { href: '/forgot', textContent: 'Get a new link' }));
  document.getElementById('setup-title').focus();
}

(async () => {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return fail('This link is incomplete. Copy the whole link from your email, or');
  try {
    const info = await api('/api/auth/token-info', { method: 'POST', body: { token } });
    loading.hidden = true;
    form.hidden = false;
    document.getElementById('acct-email').value = info.email;
    if (info.purpose !== 'setup') document.getElementById('setup-title').textContent = 'Choose a new password';
    document.getElementById('setup-intro').textContent = info.purpose === 'setup'
      ? 'Welcome! Choose a password to finish setting up your guest account. You’ll use it to see your stay and watch your stall cameras.'
      : 'Choose a new password for your account. You’ll be signed out everywhere else.';
    pw.focus();
  } catch (e) { fail(e.message); }
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(form);
  const err = document.getElementById('setup-error');
  err.hidden = true;
  if (pw.value.length < 12) { fieldError(pw, 'Use at least 12 characters.'); pw.focus(); return; }
  if (pw.value !== pw2.value) { fieldError(pw2, 'The two passwords don’t match.'); pw2.focus(); return; }
  const btn = form.querySelector('button[type="submit"]');
  busy(btn, true, 'Saving…');
  try {
    const out = await api('/api/auth/set-password', { method: 'POST', body: { token, password: pw.value } });
    if (out.next === 'login') { location.assign('/login'); return; }
    await getSession(true);
    location.assign(out.user.role === 'admin' ? '/account#security' : '/account');
  } catch (ex) {
    busy(btn, false);
    if (ex.body?.field === 'password') { fieldError(pw, ex.message); pw.focus(); }
    else showAlert(err, ex.message);
  }
});
