// Outgoing email. In production this goes through SMTP (config refuses to start
// without it). In development and tests, messages are written to data/outbox and kept
// in memory so the onboarding flow can be exercised without a mail server.
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createMailer(cfg) {
  const outbox = [];
  // smtps:// is TLS from the first byte; plain smtp:// must upgrade with STARTTLS or fail,
  // so a network attacker can't strip encryption and read set-up links or the SMTP password.
  let transport = null;
  if (cfg.mail.smtpUrl) {
    const url = new URL(cfg.mail.smtpUrl);
    if (url.protocol === 'smtp:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) url.searchParams.set('requireTLS', 'true');
    transport = nodemailer.createTransport(url.toString());
  }

  async function send({ to, subject, text, action }) {
    // Every email is plain text plus a simple, accessible HTML version with one button.
    const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f6f1e9;font-family:Arial,Helvetica,sans-serif;color:#1f1a14">
<div role="article" aria-label="${esc(subject)}" style="max-width:560px;margin:0 auto;padding:32px 24px">
<p style="font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#6b4a2b;margin:0 0 16px">${esc(cfg.ranch.name)}</p>
${text.split('\n\n').map((p) => `<p style="font-size:16px;line-height:1.6;margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}
${action ? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="display:inline-block;background:#7a3e14;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px">${esc(action.label)}</a></p>
<p style="font-size:13px;color:#5b5147">If the button doesn’t work, copy this link into your browser:<br>${esc(action.url)}</p>` : ''}
</div></body></html>`;
    const fullText = action ? `${text}\n\n${action.label}: ${action.url}\n` : text;
    const msg = { from: cfg.mail.from, to, subject, text: fullText, html };
    if (transport) return transport.sendMail(msg);
    outbox.push(msg);
    if (!cfg.test) {
      const dir = path.join(cfg.dataDir, 'outbox');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${Date.now()}-${to.replace(/[^\w.@-]/g, '_')}.txt`),
        `To: ${to}\nSubject: ${subject}\n\n${fullText}`, { mode: 0o600 });
      console.log(`[mail] (dev outbox) to=${to} subject="${subject}"${action ? ` link=${action.url}` : ''}`);
    }
  }
  return { send, outbox };
}
