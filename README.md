# MehmaanOS: phase-one pilot

*Every guest welcomed. Every order connected.*

QR table ordering for a single restaurant: guest menu (English, Dari, Pashto), kitchen display, floor/waiter dashboard and admin. Built to match the MVP scope (MVP-01 to MVP-07) in the MehmaanOS Business Proposal and the gates in the Technical & QA Assessment. Hosted on **Aria Run** (ariacloudservices.org).

> **Status: pilot prototype with DEMO menu data.** Prices, dishes and allergens are placeholders. Dari/Pashto text needs native-speaker review. Not cleared for live service or payments.

## Screens
| URL | Who | What |
|---|---|---|
| `/t/<token>` | Guest | Menu, cart, send order, live status, call waiter / bill / water |
| `/staff` | Waiter | Table map, approve/reject orders, guest requests, mark served/closed |
| `/kitchen` | Kitchen | New / Cooking / Ready columns, timers, late alerts, chime |
| `/admin` | Manager | Prices, sold-out, allergen sign-off, QR codes (print/rotate), settings, audit log, CSV export |

## Built-in safeguards (from the QA report)
- **Server-side pricing** in whole AFN: the browser never sets prices or totals.
- **Idempotent orders**: a retry after a network error can never create a duplicate ticket.
- **Order snapshots**: changing the menu never changes past orders.
- **State machine with roles**: e.g. kitchen cannot approve; nothing skips "preparing"; closed is final.
- **Signed, revocable table QR codes**: "New QR" kills a copied code.
- **Staff approval before kitchen** (default on), **pause ordering** switch, rate limits, PIN login with lockout.
- **Allergen warning** shown to guests until a named manager confirms the data.
- **Audit log** of every action, plus CSV export for daily reconciliation.
- **No online payments**: payment stays with staff/existing till, as both reports require.

## Deploy on Aria Run
- Runtime: Node.js · Port `3000` · 0.5 vCPU / 1 GB is enough for the pilot
- Environment variables (set these before real use):
  ```
  ADMIN_PIN=xxxx
  STAFF_PIN=xxxx
  KITCHEN_PIN=xxxx
  APP_SECRET=<long random string>
  PUBLIC_URL=https://<your app domain>
  ```
  Without the PINs the defaults `1111` / `2222` / `3333` apply and the dashboard shows a red warning.
- Data is stored in `DATA_DIR` (default `./data`) as a JSON file. **If the container is redeployed without a persistent volume, orders reset.** Fine for demos; move to PostgreSQL before live service.

## Run locally
```
npm start        # http://localhost:3000
npm test         # 8 tests: pricing, idempotency, state machine, QR revocation, full API flow
```
No dependencies. Node 18+.

## Not included (separate decisions per the proposal)
Online payments, split bills, POS/fiscal integration, multi-restaurant SaaS, loyalty/reviews.
