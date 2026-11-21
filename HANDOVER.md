# MehmaanOS: handover to Aria Cloud Services

## 1. Deploy on Aria Run
Last attempt (20 Nov 2026) failed on the platform side with:
`Account 217749395964 can't create new App Runner services.`
The AWS account behind Aria Run cannot create App Runner services. Fix that on AWS first (or run Aria Run on ECS/Fargate); the app itself needs nothing special.

Aria Run form:
| Field | Value |
|---|---|
| Runtime | Node.js |
| Service name | `mehmaanos` |
| Port | `3000` |
| Git repository | `https://github.com/esmat3477/mehmaanos.git` |
| Resources | 0.5 vCPU / 1 GB (enough for one restaurant) |
| Env vars | `NODE_ENV=production`, `DATABASE_URL=...`, `APP_SECRET=...`, `PUBLIC_URL=https://<app domain>` |

Alternative: build the `Dockerfile` and use "Custom Container" (port 3000; image has a health check).

## 2. Database
Any PostgreSQL 13+ (e.g. AWS RDS, smallest instance). The app creates its own tables (`mos_state`, `mos_backups`) on start. TLS is used automatically for non-local hosts. Single instance only: do not run more than one replica against the same database.

## 3. First start (10 minutes)
1. Open `https://<app>/login` and sign in with **1111** (setup PIN).
2. Admin → **Staff**: create your Manager account with your own PIN. Setup PINs switch off immediately.
3. Add waiter and kitchen accounts, one per person.
4. Admin → **Menu**: replace the demo dishes, prices and categories; fill Dari/Pashto names.
5. Have the manager check allergens and click **I have checked all allergens**.
6. Admin → **Tables & QR**: set tables, print the QR sheet.
7. Admin → **Settings**: set the restaurant name and country (UAE / Afghanistan quick setup, or custom currency + tax). Keep "Staff must approve each QR order" ON for the pilot.
8. Test one order end to end: guest phone → waiter accepts → kitchen → served → closed → Daily report.

## 4. Pilot release gates
Done (20 Nov 2026):
- [x] Phone tests: iPhone-size and low-end Android 360px on slow 3G, English/Dari/Pashto, no sideways scrolling, tap sizes (`tools/e2e_phone_outage.py`, 20/20 pass)
- [x] Outage tests: phone offline when sending, reply lost after the server saved the order, server restart mid-service. No lost and no duplicate orders; kitchen reconnects by itself
- [x] Translation pass: Afghan vocabulary, 12 corrections; full sheet in `TRANSLATIONS-REVIEW.md`
- [x] Staff guide per role + printable paper order slips for outages: `/guide`
- [x] PostgreSQL persistence verified across restarts
- [x] Multi-country: currency, tax (included/added/none, per-dish rate), Arabic/Urdu/Hindi; Dubai flow verified (`tools/e2e_dubai.py`)

Still open (need people, not code):
- [ ] Real menu, prices and allergen data from the restaurant (enter in Admin → Menu)
- [ ] Native speakers review the guest text: Dari/Pashto (`TRANSLATIONS-REVIEW.md`) and the new Arabic/Urdu/Hindi strings in `public/guest.js`
- [ ] One check on a real iPhone (Safari engine could not be installed in the build environment)
- [ ] Supervised trial service with staff, using `/guide`
- [ ] Aria AWS fix (section 1), database, domain
- [ ] Legal: restaurant country/entity, privacy notice, trademark check for "MehmaanOS"

## 5. Code map
| Path | What |
|---|---|
| `server.js` | HTTP server, routing, auth, realtime (SSE) |
| `lib/orders.js` | Pricing, validation, order state machine (pure, unit tested) |
| `lib/store.js` | PostgreSQL / file storage, write ordering, backups |
| `lib/auth.js` | Signed QR tokens, sessions, PIN hashing |
| `lib/report.js` | Daily reconciliation report |
| `lib/seed.js` | Demo menu, schema migrations, EU 14 allergen list |
| `public/` | Guest, waiter, kitchen, admin screens (vanilla JS, no build step) |
| `test/` | Unit, API end-to-end and PostgreSQL tests (CI in `.github/workflows`) |
| `tools/e2e_phone_outage.py` | Browser tests: phones, slow network, outages, restart |
| `public/guide.html` | Staff guide and paper order slips (`/guide`) |
