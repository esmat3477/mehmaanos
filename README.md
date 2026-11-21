# MehmaanOS

*Every guest welcomed. Every order connected.*

QR table ordering for restaurants in any country: guest menu in English, Arabic, Dari, Pashto, Urdu and Hindi (each restaurant chooses), kitchen display, waiter dashboard and manager admin. Scope follows the MehmaanOS Business Proposal (MVP-01 to MVP-07) and the release gates in the Technical & QA Assessment. Product concept by Aria Cloud Services.

> **Status: pilot-ready code with DEMO menu data.** Before real service: replace the menu, have a native speaker check Dari/Pashto, have a manager confirm allergens, and run a supervised pilot. Payments are deliberately out of scope.

## One platform, many restaurants
Each restaurant signs up at **`/signup`** and gets its own address **`/r/<name>/`**, with completely separate data, staff PINs, QR codes and signing secret. A restaurant can never see or change another (tested).

| URL | Who | What |
|---|---|---|
| `/` | Public | Landing page |
| `/signup` | Restaurant owner | Self-service signup: name, web address, country, manager PIN; free trial (default 60 days) |
| `/platform` | You (platform owner) | Owner console: all restaurants, usage, trial/active/suspended, mark paid, extend trial, export or delete a restaurant's data. Needs `PLATFORM_PIN`. |

Inside each restaurant (`/r/<name>/...`):

## Screens
| URL | Who | What |
|---|---|---|
| `t/<token>` | Guest | Menu (EN/دری/پښتو), cart, send order, live status, call waiter / bill / water |
| `staff` | Waiter | Table map, approve/reject orders, guest requests (flagged after 2 min), mark served/closed |
| `kitchen` | Kitchen | New / Cooking / Ready, timers, late tickets after 20 min, sound on new order |
| `guide` | Everyone | Printable staff guide per role + paper order slips for outages |
| `admin` | Manager | Menu editor, sold-out, allergen sign-off, QR codes, staff accounts, daily report, settings, backups, audit log |

## Safeguards
- **Prices and totals are calculated by the server** in whole AFN; the guest's phone cannot change them.
- **No duplicate orders**: a retry after a dropped connection returns the same order. The guest only sees "sent" after the order is saved.
- **Order history is frozen**: menu edits or deletions never change past orders.
- **Order state machine with roles**: kitchen cannot approve; nothing skips "preparing"; closed is final; every step records who and when.
- **Signed table QR codes**, revocable per table ("New QR").
- **Named staff accounts** with their own hashed PINs; deactivation signs them out immediately. Setup PINs `1111/2222/3333` work only until the first Manager account (or env PINs) exists.
- **Staff approval before kitchen** (default on), **pause ordering** switch, rate limits, login lockout.
- **Allergen sign-off**: guests see a warning until a named manager confirms; any allergen edit voids the sign-off.
- **Audit log**, **daily reconciliation report**, CSV export, automatic backups every 6 h (last 28 kept) + manual download.

## Countries, currency and tax
Admin → Settings → *Country, currency & tax*.
- **Quick setup**: 🇦🇪 UAE / Dubai (AED, 5% VAT included in menu prices, as the UAE tax authority requires; Arabic, Hindi, Urdu, Dari) and 🇦🇫 Afghanistan (AFN, no tax, Dari, Pashto).
- **Any other country**: choose currency (AED, SAR, QAR, EUR, GBP, USD, PKR, INR, AFN), tax mode (included / added on top / none), rate and label. Confirm local rules with an accountant.
- **Per-dish tax rate** for countries with different rates for food and drinks.
- Every order stores its own currency, VAT and amounts; the daily report and CSV show tax. Changing currency never converts existing prices.

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes for live use** | PostgreSQL connection string. Without it, data is a JSON file and can be lost on redeploy. Tables are created automatically. |
| `APP_SECRET` | Recommended | Long random master secret; each restaurant gets its own derived secret. If unset, secrets are generated and stored per restaurant. Changing it invalidates printed QR codes. |
| `PUBLIC_URL` | Recommended | e.g. `https://mehmaanos.example.af`, used in QR codes. Otherwise taken from the request. |
| `ADMIN_PIN` / `STAFF_PIN` / `KITCHEN_PIN` | Optional | Only for an upgraded single-restaurant install. New restaurants create named accounts. |
| `PLATFORM_PIN` | To use `/platform` | Your owner-console PIN, at least 10 characters. Console is off without it. |
| `SIGNUP_CODE` | Optional | If set, signup needs this invite code (good for a controlled pilot). |
| `SIGNUP_DISABLED` | Optional | `1` closes signup. |
| `TRIAL_DAYS` | Optional | Free-trial length for new restaurants (default 60). |
| `DEFAULT_SLUG` | Optional | Address of an upgraded single-restaurant install (default `main`). |
| `TRUST_PROXY` | **Yes behind a load balancer** (Aria Run, AWS) | `1` = trust the proxy's `X-Forwarded-*` headers for client IP and HTTPS. Leave unset when the app is reached directly. |
| `ARCHIVE_DAYS` | Optional | Finished orders older than this move to monthly archives (default 7). |
| `PORT` | Optional | Default `3000`. |
| `DATA_DIR` | Optional | Folder for the JSON file when no database is set. |

## Run
```
npm install
npm start                 # http://localhost:3000 → /signup to create a restaurant
npm test                  # 24 tests (incl. isolation between restaurants, security); set TEST_DATABASE_URL to include the PostgreSQL test
python tools/e2e_phone_outage.py   # 20 browser tests (needs: pip install playwright)
python tools/e2e_dubai.py          # Dubai flow: UAE preset, Arabic guest, VAT
python tools/a11y_audit.py         # accessibility audit, every screen
node tools/loadtest.js             # load test (set DATABASE_URL to test PostgreSQL)
```
Node 18+. One runtime dependency (`pg`). Health check: `GET /healthz`.

## Not included (separate decisions per the proposal)
Online payments and automatic subscription billing (trial/paid status is tracked manually in `/platform`), split bills, POS/fiscal integration, custom domains per restaurant, email verification, loyalty/reviews, photos.

See **HANDOVER.md** for deployment on Aria Run and **READINESS.md** for test evidence and the security review.
