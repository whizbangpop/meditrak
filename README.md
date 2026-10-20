# Meditrak

A self-hosted, server-rendered medication tracker you can install on your phone as a PWA.

- **Medications** — tablets, capsules or vials, with a strength and a default dose.
- **Stock** — every box/packet/vial you receive is recorded with batch, expiry and quantity
  (tablet/capsule count, or strength in mg/ml + total volume for vials). Doses are deducted
  automatically: opened items first, then the soonest expiry; expired items are never used;
  a dose that runs past one vial carries on into the next.
- **Schedules** — daily at set times, every N days, specific weekdays, or as needed. Each
  schedule has its own dose (defaults to one tablet, or the vial's default dose) shown with
  a live conversion ("= 2 tablets", "≈ 0.4 ml at 50 mg/ml").
- **Supplies** — syringes, needles, swabs etc. Link them to a medication with a per-dose
  quantity to use them automatically; you can also use, restock or recount them manually.
- **Blood tests** — define each test you track (name, unit, optional minimum/maximum range),
  record all the results from one blood draw in a single form, and see each test charted over
  time with dashed marker lines at the range limits and out-of-range results flagged.
- **Today view** — take / adjust / skip each dose, undo mistakes (stock is restored), plus
  alerts for low stock, days of supply left, expiring and expired items.
- **Reminders** — Web Push notifications at each dose time with a *Mark taken* button, and an
  optional follow-up if a dose hasn't been logged.
- **Accounts** — sign in with any OpenID Connect provider; each user creates their own
  profile (name, time zone, reminder preferences) and only sees their own data. JSON export
  and full account deletion are on the Profile page.

## Quick start (local)

```bash
npm install
DEV_LOGIN=true npm run dev     # http://localhost:3000, name-only dev sign-in
```

Push and PWA install work on `localhost` without HTTPS, so you can try everything on your
computer first.

## Production

1. Copy `.env.example` to `.env` and fill in `BASE_URL` and the `OIDC_*` values.
2. In your identity provider create a confidential OIDC client with redirect URI
   `https://<your host>/auth/callback` (and post-logout URI `https://<your host>/login`).
3. Run it:
   ```bash
   docker compose up -d --build
   ```
   If port 3000 is taken on the host, set `HOST_PORT` (e.g. `HOST_PORT=3080`) in `.env`.
   Use `HOST_BIND=127.0.0.1` when the reverse proxy runs on the same machine.
   The container fixes ownership of `./data` on start and runs the app as `PUID:PGID`
   (default `1000:1000`), never as root.
4. Put it behind a reverse proxy with HTTPS (Caddy, Traefik, nginx…). **HTTPS is required**
   for installing the PWA and for notifications on phones.

Data (SQLite DB, generated session secret and VAPID keys) lives in `./data` — back that folder
up. Keep `VAPID_*` keys stable or devices will need to re-enable notifications.

## Installing on your phone

- **Android (Chrome):** open the site → menu → *Install app* (or use the button on Profile).
  Then Profile → *Enable notifications*.
- **iPhone/iPad (iOS 16.4+):** open in Safari → Share → *Add to Home Screen*, open Meditrak
  from the Home Screen, then Profile → *Enable notifications*. iOS doesn't show notification
  action buttons, so tap the notification to open the app and log the dose.

## How it fits together

```
src/
  server.js        Express app, sessions (signed cookie), CSRF, routing
  auth.js          OIDC (authorization code + PKCE), dev login, logout
  db.js            SQLite schema (better-sqlite3)
  schedule.js      Dose time engine (time-zone and DST aware)
  stock.js         Stock maths, dose recording/undo, disposable usage
  push.js          VAPID/web-push, reminder scheduler (every 30s), signed action tokens
  routes/          doses (Today, history), medications (+stock, schedules), disposables, bloods, profile, push API
views/             EJS templates
public/            CSS, client JS, service worker, manifest, icons
```

Doses are logged against a schedule *occurrence* (schedule + time), so each reminder slot can
only be logged once; unscheduled doses can be logged any time.

Run one instance only — the reminder scheduler runs in-process.
