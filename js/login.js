// login.js — account login shown before the world loads.
//
// Deliberately DOM rather than canvas. Every other panel in this game is drawn
// on the canvas, but text entry is the one thing canvas is genuinely bad at:
// real <input> gives us password masking, clipboard, autofill, IME and mobile
// keyboards for free, and a password field drawn by hand would have none of it.
import { accountLogin, accountRegister, accountResume, auth, MP_ENABLED } from './net.js';

let overlay = null;

function el(tag, style, text) {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text != null) e.textContent = text;
  return e;
}

const FONT = 'ui-monospace,Menlo,Consolas,monospace';
const BTN = `padding:9px 14px;margin:0;border:1px solid #7a6a48;border-radius:3px;
  background:linear-gradient(#4a3c24,#2e2415);color:#f0e0c0;font:600 13px ${FONT};cursor:pointer;`;
const FIELD = `width:100%;box-sizing:border-box;padding:9px 10px;margin:4px 0 10px;
  border:1px solid #6a5c40;border-radius:3px;background:#15120c;color:#f0e6d0;font:14px ${FONT};`;

// Resolves when the player is logged in, or when they choose to play offline.
// Returns 'online' | 'offline'.
export function showLogin() {
  return new Promise(resolve => {
    overlay = el('div', `position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
      justify-content:center;background:rgba(8,7,5,.92);font:14px ${FONT};`);

    const card = el('div', `width:340px;max-width:92vw;padding:22px;border:1px solid #6a5c40;
      border-radius:6px;background:linear-gradient(#221b12,#16110b);box-shadow:0 10px 40px rgba(0,0,0,.6);`);

    card.appendChild(el('div', `font:700 17px ${FONT};color:#f0c040;text-align:center;margin-bottom:4px;`,
      'PROJECT BRAVO'));
    card.appendChild(el('div', `font:12px ${FONT};color:#9a8f78;text-align:center;margin-bottom:16px;`,
      'log in to carry your character between computers'));

    const uLab = el('div', `font:12px ${FONT};color:#c8bda0;`, 'username');
    const u = el('input', FIELD); u.autocomplete = 'username'; u.maxLength = 24;
    const pLab = el('div', `font:12px ${FONT};color:#c8bda0;`, 'password');
    const p = el('input', FIELD); p.type = 'password'; p.autocomplete = 'current-password'; p.maxLength = 72;
    card.append(uLab, u, pLab, p);

    const msg = el('div', `min-height:32px;font:12px ${FONT};color:#e07a6a;margin:2px 0 8px;line-height:1.35;`);
    card.appendChild(msg);

    const row = el('div', 'display:flex;gap:8px;');
    const loginBtn = el('button', BTN + 'flex:1;', 'Log in');
    const regBtn = el('button', BTN + 'flex:1;', 'Create account');
    row.append(loginBtn, regBtn);
    card.appendChild(row);

    const offline = el('button', BTN + 'width:100%;margin-top:10px;opacity:.75;', 'Play offline (this device only)');
    card.appendChild(offline);
    card.appendChild(el('div', `font:11px ${FONT};color:#7a7160;margin-top:10px;line-height:1.4;`,
      'Offline play saves to this browser only. Characters created offline stay here.'));

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => u.focus(), 50);

    let busy = false;
    const setBusy = (b, note) => {
      busy = b;
      loginBtn.disabled = regBtn.disabled = b;
      loginBtn.style.opacity = regBtn.style.opacity = b ? '.6' : '1';
      if (note) { msg.style.color = '#9a8f78'; msg.textContent = note; }
    };
    const fail = t => { msg.style.color = '#e07a6a'; msg.textContent = t; };

    async function go(fn, label) {
      if (busy) return;
      if (!u.value.trim() || !p.value) return fail('enter a username and password');
      setBusy(true, label + '…');
      const r = await fn(u.value.trim(), p.value);
      setBusy(false);
      if (!r.ok) return fail(r.error || 'could not log in');
      close();
      resolve('online');
    }
    loginBtn.onclick = () => go(accountLogin, 'logging in');
    regBtn.onclick = () => go(accountRegister, 'creating account');
    offline.onclick = () => { close(); resolve('offline'); };
    p.onkeydown = e => { if (e.key === 'Enter') loginBtn.click(); };
    u.onkeydown = e => { if (e.key === 'Enter') p.focus(); };

    function close() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
    }
  });
}

// Boot entry: reuse a cached session if it is still good, otherwise prompt.
// With multiplayer disabled (?mp=off) we never prompt at all — offline play
// must not require a server that isn't there.
export async function ensureAccount() {
  if (!MP_ENABLED) return 'offline';
  if (await accountResume()) return 'online';
  return showLogin();
}

export { auth };
