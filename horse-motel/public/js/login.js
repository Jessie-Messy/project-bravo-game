import { api, getSession, fieldError, clearErrors, showAlert, busy, focusHeading } from './common.js';

const next = (() => {
  const n = new URLSearchParams(location.search).get('next') || '';
  return /^\/(account|admin)$/.test(n) ? n : null; // only our own pages: no open redirect
})();

const form = document.getElementById('login-form');
const mfa = document.getElementById('mfa-form');
const email = document.getElementById('email');
const password = document.getElementById('password');
let challenge = null;

getSession().then(({ user }) => { if (user) location.replace(next || (user.role === 'admin' ? '/admin' : '/account')); });
document.getElementById('show-pw').addEventListener('change', (e) => { password.type = e.target.checked ? 'text' : 'password'; });

function done(user) {
  location.assign(next || (user.role === 'admin' ? '/admin' : '/account'));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(form);
  const err = document.getElementById('login-error');
  err.hidden = true;
  if (!email.value.trim()) { fieldError(email, 'Enter your email address.'); email.focus(); return; }
  if (!password.value) { fieldError(password, 'Enter your password.'); password.focus(); return; }
  const btn = form.querySelector('button[type="submit"]');
  busy(btn, true, 'Signing in…');
  try {
    const out = await api('/api/auth/login', { method: 'POST', body: { email: email.value.trim(), password: password.value } });
    if (out.mfaRequired) {
      challenge = out.challenge;
      form.hidden = true;
      mfa.hidden = false;
      // Read the new step's heading and instructions first, then the user tabs to the code.
      focusHeading(document.getElementById('mfa-title'), 'Enter your code — Rockin\' C Ranch');
      return;
    }
    await getSession(true);
    done(out.user);
  } catch (ex) {
    showAlert(err, ex.message);
    password.value = '';
  } finally { busy(btn, false); }
});

mfa.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('code');
  const err = document.getElementById('mfa-error');
  clearErrors(mfa);
  err.hidden = true;
  if (!/^\d{6}$/.test(code.value.trim())) { fieldError(code, 'Enter the 6 digits from your app.'); code.focus(); return; }
  const btn = mfa.querySelector('button[type="submit"]');
  busy(btn, true, 'Checking…');
  try {
    const out = await api('/api/auth/mfa', { method: 'POST', body: { challenge, code: code.value.trim() } });
    await getSession(true);
    done(out.user);
  } catch (ex) {
    busy(btn, false);
    code.value = '';
    if (ex.body?.restart) { restart(); showAlert(document.getElementById('login-error'), ex.message); return; }
    showAlert(err, ex.message);
  }
});

function restart() {
  challenge = null;
  mfa.hidden = true;
  form.hidden = false;
  document.title = 'Sign in — Rockin\' C Ranch';
  password.value = '';
  email.focus();
}
document.getElementById('mfa-back').addEventListener('click', restart);
