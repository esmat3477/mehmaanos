# MehmaanOS

*Every guest welcomed. Every order connected.*

QR table ordering for restaurants: guest menu in English, Dari and Pashto, kitchen display, waiter dashboard and manager admin. Scope follows the MehmaanOS Business Proposal (MVP-01 to MVP-07) and the release gates in the Technical & QA Assessment. Product concept by Aria Cloud Services.

> **Status: pilot-ready code with DEMO menu data.** Before real service: replace the menu, have a native speaker check Dari/Pashto, have a manager confirm allergens, and run a supervised pilot. Payments are deliberately out of scope.

## Screens
| URL | Who | What |
|---|---|---|
| `/t/<token>` | Guest | Menu (EN/دری/پښتو), cart, send order, live status, call waiter / bill / water |
| `/staff` | Waiter | Table map, approve/reject orders, guest requests (flagged after 2 min), mark served/closed |
| `/kitchen` | Kitchen | New / Cooking / Ready, timers, late tickets after 20 min, sound on new order |
| `/guide` | Everyone | Printable staff guide per role + paper order slips for outages |
| `/admin` | Manager | Menu editor, sold-out, allergen sign-off, QR codes, staff accounts, daily report, settings, backups, audit log |

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

## Configuration
| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes for live use** | PostgreSQL connection string. Without it, data is a JSON file and can be lost on redeploy. Tables are created automatically. |
| `APP_SECRET` | Recommended | Long random string for signing QR codes and sessions. If unset, one is generated and stored in the database. Changing it invalidates all printed QR codes. |
| `PUBLIC_URL` | Recommended | e.g. `https://mehmaanos.example.af`, used in QR codes. Otherwise taken from the request. |
| `ADMIN_PIN` / `STAFF_PIN` / `KITCHEN_PIN` | Optional | Shared fallback PINs. Prefer named accounts under Admin → Staff. |
| `PORT` | Optional | Default `3000`. |
| `DATA_DIR` | Optional | Folder for the JSON file when no database is set. |

## Run
```
npm install
npm start                 # http://localhost:3000, then sign in with 1111 and create your Manager account
npm test                  # 15 tests; set TEST_DATABASE_URL to include the PostgreSQL test
python tools/e2e_phone_outage.py   # 20 browser tests (needs: pip install playwright)
```
Node 18+. One runtime dependency (`pg`). Health check: `GET /healthz`.

## Not included (separate decisions per the proposal)
Online payments, split bills, POS/fiscal integration, multi-restaurant SaaS, loyalty/reviews, photos.

See **HANDOVER.md** for deployment on Aria Run.
