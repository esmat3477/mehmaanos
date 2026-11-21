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
| Env vars | `NODE_ENV=production`, `DATABASE_URL=...`, `APP_SECRET=...`, `PUBLIC_URL=https://<app domain>`, `TRUST_PROXY=1`, `PLATFORM_PIN=...` |

Alternative: build the `Dockerfile` and use "Custom Container" (port 3000; image has a health check).

## 2. Database
Any PostgreSQL 13+ (e.g. AWS RDS, smallest instance). The app creates its own tables (`mos_state`, `mos_backups`) on start. TLS is used automatically for non-local hosts. Single instance only: do not run more than one replica against the same database.

## 3. Platform setup
- Set `PLATFORM_PIN` (10+ characters; owner console at `/platform`), `APP_SECRET`, `DATABASE_URL`, `PUBLIC_URL`, and `TRUST_PROXY=1` (Aria Run sits behind a load balancer).
- A restaurant manager who forgets their PIN: `/platform` → **Reset manager PIN**.
- For a controlled launch set `SIGNUP_CODE` and give the code only to pilot restaurants.
- Upgrading the earlier single-restaurant version: its data becomes `/r/main`; old printed QR codes and bookmarks redirect automatically.
- Billing is manual for now: when a restaurant pays, open `/platform` → **Mark paid / active**. Connecting a payment provider (e.g. Stripe) is a separate step that needs the company's own account and keys.

## 4. First start for a restaurant (10 minutes)
1. Open `https://<app>/signup`, create the restaurant (choose its web address and manager PIN). You land in its Admin.
2. Bookmark `https://<app>/r/<name>/login` for staff.
3. Add waiter and kitchen accounts, one per person.
4. Admin → **Menu**: replace the demo dishes, prices and categories; fill Dari/Pashto names.
5. Have the manager check allergens and click **I have checked all allergens**.
6. Admin → **Tables & QR**: set tables, print the QR sheet.
7. Admin → **Settings**: set the restaurant name and country (UAE / Afghanistan quick setup, or custom currency + tax). Keep "Staff must approve each QR order" ON for the pilot.
8. Test one order end to end: guest phone → waiter accepts → kitchen → served → closed → Daily report.

## 5. Pilot release gates
Done (20 Nov 2026):
- [x] Phone tests: iPhone-size and low-end Android 360px on slow 3G, English/Dari/Pashto, no sideways scrolling, tap sizes (`tools/e2e_phone_outage.py`, 20/20 pass)
- [x] Outage tests: phone offline when sending, reply lost after the server saved the order, server restart mid-service. No lost and no duplicate orders; kitchen reconnects by itself
- [x] Translation pass: Afghan vocabulary, 12 corrections; full sheet in `TRANSLATIONS-REVIEW.md`
- [x] Staff guide per role + printable paper order slips for outages: `/guide`
- [x] PostgreSQL persistence verified across restarts
- [x] Multi-restaurant platform: signup, separate data per restaurant, owner console, suspension; isolation tested
- [x] Multi-country: currency, tax (included/added/none, per-dish rate), Arabic/Urdu/Hindi; Dubai flow verified (`tools/e2e_dubai.py`)

Still open (need people, not code):
- [ ] Real menu, prices and allergen data from the restaurant (enter in Admin → Menu)
- [ ] Native speakers review the guest text: Dari/Pashto (`TRANSLATIONS-REVIEW.md`) and the new Arabic/Urdu/Hindi strings in `public/guest.js`
- [ ] One check on a real iPhone (Safari engine could not be installed in the build environment)
- [ ] Supervised trial service with staff, using `/guide`
- [ ] Aria AWS fix (section 1), database, domain
- [ ] Legal: restaurant country/entity, privacy notice, trademark check for "MehmaanOS"

## 6. Code map
| Path | What |
|---|---|
| `server.js` | HTTP server: platform (landing, signup, owner console) and per-restaurant routes, auth, realtime (SSE) |
| `lib/orders.js` | Pricing, validation, order state machine (pure, unit tested) |
| `lib/store.js` | Restaurant registry + one stored document per restaurant (PostgreSQL / file), ordered writes, backups |
| `lib/auth.js` | Signed QR tokens, sessions, PIN hashing |
| `lib/report.js` | Daily reconciliation report |
| `lib/seed.js` | Demo menu, schema migrations, EU 14 allergen list |
| `public/` | Guest, waiter, kitchen, admin screens (vanilla JS, no build step) |
| `test/` | Unit, API end-to-end and PostgreSQL tests (CI in `.github/workflows`) |
| `tools/e2e_phone_outage.py` | Browser tests: phones, slow network, outages, restart |
| `public/guide.html` | Staff guide and paper order slips (`/guide`) |
