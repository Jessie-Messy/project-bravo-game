# Rockin' C Ranch — booking site & stall cameras

The website for Rockin' C Ranch, a horse hotel and country lodging in Lonoke, Arkansas.

- **Availability calendar**: live counts of free stalls, RV/trailer hookups (including full hookups with sewer) and the house for every night.
- **Online booking**: guests choose dates, stalls, hookups and/or the house, see the price, and pay on Stripe's hosted checkout. Going back from checkout keeps their details and lets them resume or release the held dates.
- **Automatic onboarding**: when Stripe confirms payment, the site confirms the booking, assigns specific stalls, creates the guest's account (or adds the stay to their existing one), and emails a one-time link to set a password.
- **Stall cameras**: signed-in guests see live video of **only the stalls they rented**, and **only during their stay** (from 3 hours before check-in to 2 hours after check-out, configurable).
- **Admin page**: bookings (search, views, "new" markers), cancel with one-click Stripe refund and guest email, fix a mistyped guest email, phone/cash bookings with the same camera onboarding, a "who's where" stall-by-night grid, block specific stalls/sites/the house, camera-to-stall mapping with a live test, activity log.
- **Airbnb calendar sync**: Airbnb reservations block the house here automatically (and free it if cancelled); bookings made here are published as a private calendar link for Airbnb to import, so the house can't be double-booked. Overlaps are emailed to you.
- Works on phones, tablets and computers; light and dark mode; built to WCAG 2.2 AA.

Everything lives in this folder and is independent of the game in the rest of the repository.

---

## Quick start (on your computer, no payment keys needed)

Needs Node.js 20.11 or newer.

```bash
cd horse-motel
npm install          # also copies the video player and fonts into public/
npm run seed-demo    # optional: a demo camera on every stall
npm start            # http://localhost:3000
```

Without Stripe keys the site runs in **test mode**: "Continue to secure payment" goes to a test checkout page with a "Simulate successful payment" button, and emails are written to `data/outbox/` (and the console) instead of being sent. Book a stall, "pay", then open the set-up link from the console to create a password and see the camera page.

Make yourself an owner account:

```bash
npm run create-admin -- you@example.com
```

Open the printed link, set a password, then **Account → Account & security → turn on two-step verification**. The admin page (`/admin`) will not open until you do.

---

## Going live

### 1. Server

Any small Linux VPS works (1 GB RAM is plenty). Put the app behind a reverse proxy that handles HTTPS. With [Caddy](https://caddyserver.com) that is the whole config:

```
book.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

```bash
cd horse-motel
umask 077              # so .env, the database and backups are readable only by you
npm ci --omit=dev
cp .env.example .env   # then edit it — see below
openssl rand -base64 32   # paste into DATA_KEY in .env, and keep a copy somewhere safe
npm run create-admin -- you@example.com
node src/server.js     # run it under systemd or pm2 so it restarts
```

A sample systemd unit:

```ini
[Unit]
Description=Rockin C Ranch site
After=network.target

[Service]
WorkingDirectory=/srv/horse-motel
ExecStart=/usr/bin/node src/server.js
Restart=always
User=ranch
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/horse-motel/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Data lives in `data/ranch.db` (SQLite). **Back it up daily** — e.g. `(umask 077; sqlite3 data/ranch.db ".backup /backups/ranch-$(date +%F).db")` — and keep `DATA_KEY` backed up separately: 2-step secrets and camera addresses in the database are encrypted with it.

### 2. Settings (`.env`)

Every setting is documented in [`.env.example`](.env.example). The ones that matter most:

| Setting | What it is |
|---|---|
| `APP_ORIGIN` | Your public `https://` address. |
| `DATA_KEY` | Encryption key for secrets in the database (`openssl rand -base64 32`). |
| `PRICE_*_CENTS` | **Your real prices, in cents.** The defaults are placeholders. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | From your Stripe dashboard (next step). |
| `SMTP_URL`, `MAIL_FROM` | An email provider (Postmark, SendGrid, Amazon SES, Google Workspace SMTP…). Guests' set-up links go out by email. |
| `ADMIN_ALERT_EMAIL` | Where you get new-booking alerts. Required. |
| `RANCH_CONTACT_PHONE` / `RANCH_CONTACT_EMAIL` | Shown on every page and in emails. At least one is required. |
| `CANCELLATION_POLICY` | Your cancellation policy text (policies page and FAQ). |
| `ICAL_IMPORT_URLS`, `ICAL_EXPORT_TOKEN` | Airbnb calendar sync (see below). |
| `CAMERA_ALLOWED_HOSTS` | The address(es) of your camera box (see below). Required. |

The server **refuses to start** in production if HTTPS, Stripe, email, `DATA_KEY` or the camera allow-list are missing, or if any setting is out of range, so a half-configured site can never take bookings. Test payments only ever run on `localhost`.

### 3. Stripe

1. Create a Stripe account and get your secret key (Developers → API keys).
2. Developers → Webhooks → **Add endpoint**: `https://book.example.com/api/webhooks/stripe`, with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
3. Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.

Guests pay on Stripe's own page, so card numbers never touch this server. A booking is only confirmed by Stripe's **signed** webhook, never by the browser coming back from checkout. Refunding a payment in full in Stripe cancels the booking and ends camera access automatically.

### 4. Airbnb calendar sync

1. In Airbnb: **Calendar → Availability → Connect calendars → Export calendar**. Copy the link into `ICAL_IMPORT_URLS`. Airbnb reservations now block the house on this site (every 30 minutes, or **Admin → Sync & security → Sync now**).
2. Set `ICAL_EXPORT_TOKEN` to a long random value (`openssl rand -hex 24`). **Admin → Sync & security** then shows a private calendar link; in Airbnb, **Connect calendars → Import calendar** and paste it. Bookings made on this site then block the house on Airbnb. The feed says only "Reserved", never guest names.
3. If both sites ever take the same night, you get an "ACTION NEEDED" email.

`ICAL_BLOCKS` sets what an Airbnb reservation blocks here: `house` (default), or e.g. `house,stall` if your Airbnb guests also get the barn.

### 5. Cameras

**Full guide with a shopping list, mounting tips and step-by-step install: [`cameras/README.md`](cameras/README.md).**

In short: PoE dome cameras (one per stall) plug into a PoE NVR at the ranch. A small Tailscale router lets the web server reach the NVR privately; nothing is port-forwarded. On the web server, [MediaMTX](https://github.com/bluenviron/mediamtx) (config in `cameras/mediamtx.yml`) turns each camera into an HLS stream on `127.0.0.1`, only while someone is watching. Then `npm run cameras:setup` adds one camera per stall.

Guests never connect to a camera directly. The site relays video from MediaMTX and checks, on **every** request, that the guest has a confirmed booking for that stall and that their stay is on right now. Camera addresses and passwords stay on the server, encrypted.

Cameras that can only produce still pictures work too: in **Admin → Cameras**, choose "Still picture" and give the snapshot URL. Guests' pages refresh it every 2 seconds.

**One camera per stall is best.** If a camera shows two stalls, a guest who rents either stall can see both horses while their stay overlaps with the other guest's. When the same stall has back-to-back guests, the leaving guest's view ends at check-out time and the next guest's starts after it, so they never overlap.

---

## Taking a phone booking, cancelling, refunding

- **Phone or cash booking**: Admin → Phone booking. It's confirmed immediately and the guest gets the normal welcome email, set-up link and camera access.
- **Cancel**: Admin → Bookings → Cancel. Tick "Refund" to refund the card payment through Stripe in one step, and "Email the guest" to tell them. Camera access ends at once. (A full refund made in the Stripe dashboard also cancels the booking automatically.)
- **Wrong email**: Admin → Bookings → Change email moves the stay and its cameras to the right address and re-sends the confirmation there.

## How booking & onboarding works

```
Guest picks dates ─► POST /api/bookings ─► units reserved for 31 min (database-enforced,
                                            can't be double-booked) ─► Stripe Checkout
Stripe ─► signed webhook ─► booking confirmed ─► guest account created or linked
                                              └► welcome email with one-time set-up link
Guest sets password ─► signs in ─► sees stays + only their stalls' cameras, only during the stay
Unpaid holds are released automatically (after checking with Stripe that no payment is in flight).
```

---

## Security

- **Payments**: Stripe Checkout, cards only (PCI handled by Stripe). Prices are computed on the server; the amount Stripe collected is checked against the booking before confirming. Webhooks are signature-verified and idempotent, and a late or replayed payment event can never revive a cancelled or refunded booking.
- **Holds can't be abused**: unpaid holds are limited per network, per email and site-wide, so nobody can take the calendar off sale by starting checkouts they never finish.
- **No double booking**: `UNIQUE(unit, night)` in the database — enforced even under simultaneous requests.
- **Accounts**: passwords hashed with scrypt (N=2¹⁷), a few hashes at once so a login flood gets a fast "busy" instead of exhausting the server; at least 12 characters; common passwords refused. Sign-in attempts are counted per account *before* the password check (parallel guessing can't slip through); after 5 failures sign-in pauses for 15 minutes and the owner is emailed. If the password was right but the 2-step code keeps failing, those pauses double each time up to 24 hours (the password is clearly known), while plain wrong passwords never lock anyone out for long. Rate limits on every sign-in, reset and booking endpoint. Sign-in errors don't reveal whether an email has an account.
- **Two-step verification** (authenticator app, RFC 6238) — optional for guests, **required for admins** (including to view cameras). Codes can't be replayed. Secrets are encrypted at rest (AES-256-GCM).
- **Sessions**: random 256-bit tokens, stored only as hashes; `HttpOnly`, `SameSite=Lax`, `Secure`, `__Host-` cookie; 2-hour idle and 7-day absolute timeout; rotated at sign-in; all sessions, unused reset links and pending sign-ins revoked on password change/reset or "sign out everywhere".
- **Links in emails** (set-up, reset) are single-use, expire, are stored hashed, and travel in the URL fragment so they never appear in server logs or `Referer` headers.
- **CSRF**: same-origin check on every write, JSON-only bodies, plus a per-session token for signed-in requests.
- **Email** is only ever sent encrypted (`smtps://`, or STARTTLS required).
- **Headers**: strict Content-Security-Policy (`script-src 'self'`, no inline scripts or styles, no third-party scripts or fonts), HSTS, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, locked-down `Permissions-Policy`.
- **Cameras**: per-request authorization tied to booking + time window; camera URLs/credentials never sent to browsers and encrypted at rest; mandatory upstream host allow-list; playlist rewriting blocks path traversal and off-host redirects; upstream responses size-capped while streaming; requests in flight capped per account and per camera; segments shared between viewers through a short cache; views are logged.
- **Admin**: requires two-step verification on every session; activity log of sign-ins, bookings and camera views.
- The server refuses to start with an unsafe production configuration.

## Accessibility

Built to WCAG 2.2 AA: semantic landmarks and headings, skip link, visible focus everywhere, a fully keyboard-operable calendar (arrow keys, Home/End, Page Up/Down) with typed-date inputs as an alternative, labelled form fields with errors announced and linked to their inputs, a native `<dialog>` photo viewer that traps and restores focus, 44 px touch targets, reduced-motion support, dark and Windows high-contrast modes, and no horizontal scrolling at 320 px (400% zoom).

## Tests

```bash
npm test            # API: booking, payments, onboarding, auth, 2-step, CSRF, camera access, admin
npm run test:a11y   # real-browser axe-core scan (phone + desktop, light + dark) and keyboard flows
SCREENSHOTS=1 npm run test:a11y   # also saves screenshots to test/a11y/report/
```

## Updating photos

Photos are in `photos-src/` with their descriptions (alt text) in `src/photos.js`. After changing them run `npm run images` (needs the dev dependencies).
