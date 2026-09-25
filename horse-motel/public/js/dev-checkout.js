import { api, busy, showAlert } from './common.js';

const q = new URLSearchParams(location.search);
const ref = q.get('ref') || '';
const t = q.get('t') || '';
const back = (extra) => `/booking?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(t)}${extra}`;
document.getElementById('pay').addEventListener('click', async (e) => {
  busy(e.currentTarget, true, 'Paying…');
  try {
    await api('/api/dev/mock-pay', { method: 'POST', body: { ref, t } });
    location.assign(back('&paid=1'));
  } catch (ex) { busy(e.currentTarget, false); showAlert(document.getElementById('dev-error'), ex.message); }
});
document.getElementById('cancel').addEventListener('click', () => location.assign(back('&cancelled=1')));
