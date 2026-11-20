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
7. Admin → **Settings**: set the restaurant name. Keep "Staff must approve each QR order" ON for the pilot.
8. Test one order end to end: guest phone → waiter accepts → kitchen → served → closed → Daily report.

## 4. Pilot release gates still open (from the QA report)
- [ ] Real menu, prices and allergen data from the restaurant
- [ ] Native-speaker review of all Dari and Pashto text
- [ ] Device test: cheap Android + iPhone Safari (guests), kitchen tablet under kitchen conditions
- [ ] Outage drill: kill Wi-Fi/internet mid-service; confirm paper fallback and that no order is lost or duplicated
- [ ] Staff training + supervised shadow service before guests use it
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
