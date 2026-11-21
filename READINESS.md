# MehmaanOS readiness report — 21 Nov 2026

**Verdict: the code is ready for a supervised pilot.** What remains needs people (hosting, native speakers, real restaurant data), not code.

## Evidence (all re-run together on 21 Nov 2026)
| Check | Result | How to repeat |
|---|---|---|
| Unit + API tests (pricing, VAT, state machine, auth, isolation between restaurants, signup, owner console, upgrade path, archiving, security) | **24/24 pass** | `TEST_DATABASE_URL=... npm test` |
| Phones + outages (iPhone/Android sizes, slow 3G, 3 languages, offline send, lost reply, server restart) | **20/20 pass** | `python tools/e2e_phone_outage.py` |
| Dubai flow (UAE setup in admin UI, Arabic guest, VAT) | AED 84.00 incl. AED 4.00 VAT, no layout overflow, no script errors | `python tools/e2e_dubai.py` |
| Accessibility (axe-core, WCAG 2 A/AA + best practice, 18 screens/states) | **0 violations** | `python tools/a11y_audit.py` |
| Load (PostgreSQL, 20 restaurants, 100 simultaneous) | ~1,000 orders/s, p95 145 ms, 0 errors, 0 duplicate order numbers; single order p50 39 ms | `DATABASE_URL=... node tools/loadtest.js` |
| Dependency vulnerabilities | **0** (`npm audit`) | `npm audit --omit=dev` |

## Security review — fixed on 21 Nov 2026
1. **Forged client IPs** could bypass login/signup limits → `X-Forwarded-For` is only trusted with `TRUST_PROXY=1`, and only its last (proxy-added) entry.
2. **Distributed PIN guessing** → manager PINs need 6+ digits; after 30 failed logins in 15 min a restaurant allows one attempt per 10 s (slows attackers without locking staff out).
3. **Login cost grew with staff count** (blocking scrypt per account) → indexed PIN lookup + non-blocking scrypt: one check per login.
4. **Sessions survived PIN changes** → per-person session version; changing a PIN or deactivating signs that person out everywhere.
5. **Spreadsheet formula injection** in CSV export (guest notes, dish names) → neutralised.
6. **Locked-out manager** had no recovery → owner console "Reset manager PIN" (temporary 6-digit PIN, logged).
Also: HSTS on HTTPS, owner-console PIN must be 10+ characters, exports never contain PIN hashes or secrets.

Already in place: per-restaurant signing secrets, signed revocable QR codes, HttpOnly SameSite=Strict cookies scoped per restaurant, strict Content-Security-Policy (no inline scripts), server-side prices, idempotent orders, role-checked state machine, audit log, rate limits.

## Scale
- Finished orders older than 7 days (`ARCHIVE_DAYS`) move to monthly archives, so a restaurant stays fast however long it is used. Reports, CSV and exports include archives.
- Each restaurant is one document; a single server comfortably handles many restaurants (see load test). For hundreds of busy restaurants, run several servers with restaurants split between them (do not point two servers at the same restaurant).

## Still open (needs people)
- [ ] Hosting: Aria AWS App Runner block, PostgreSQL, domain, HTTPS (`HANDOVER.md`)
- [ ] Native-speaker review: Dari/Pashto (`TRANSLATIONS-REVIEW.md`), Arabic/Urdu/Hindi (`public/guest.js`)
- [ ] Real iPhone Safari check (WebKit could not be installed in the build environment)
- [ ] Real menu, prices and allergen sign-off from the first restaurant
- [ ] Supervised staff trial using `/guide`
- [ ] Lawyer: terms of service, privacy notice (UAE PDPL / GDPR), trademark check for "MehmaanOS"; accountant: tax setup outside the UAE
- [ ] Optional before scaling sales: automatic billing (Stripe or local provider), email verification at signup, custom domains, menu photos
