import { api, fieldError, clearErrors, showAlert, busy } from './common.js';

const form = document.getElementById('forgot-form');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(form);
  const email = document.getElementById('email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    fieldError(email, 'Enter an email address like name@example.com.');
    email.focus();
    return;
  }
  const btn = form.querySelector('button');
  busy(btn, true, 'Sending…');
  try {
    await api('/api/auth/forgot', { method: 'POST', body: { email: email.value.trim() } });
    form.hidden = true;
    document.getElementById('forgot-done').hidden = false;
    document.getElementById('done-title').focus();
  } catch (ex) {
    busy(btn, false);
    showAlert(document.getElementById('forgot-error'), ex.message);
  }
});
