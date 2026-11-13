# Changelog

## Unreleased

- Hibernation: the app scales to zero after 1 hour with no use (minReplicas 0, cooldownPeriod 3600, one HTTP scale rule) and wakes on the next visit; maxReplicas stays 1. Container Apps API version raised to 2025-01-01.
- Separate admin page `/nsadmin`. Local mode: it hosts the email + password sign-in (the main page shows no form). Gateway mode: only signed-in admins (Entra `Admin` app role or `ADMIN_EMAILS`) are served the app there; everyone else gets a 403 no-access page.
- Gateway mode: optional `ALLOWED_EMAIL_DOMAINS` allowlist (defence in depth on top of Entra "Assignment required"). Out-of-domain sign-ins are rejected and create no user. New test; wired through `infra/main.bicep` and the pipeline variable `ALLOWED_EMAIL_DOMAINS`.

## 1.0.0

First platform version. Re-platformed from the single-file `pool-car-booking (6).html`.

- Node.js + SQLite backend with numbered migrations; data persists in `/data/app.db`.
- Server-side sign-in (local passwords for test environments, Entra gateway for production) and server-side authorisation.
- Pool car booking, trip logs, admin approvals, fleet, alert recipients and webhook, policy PDF.
- Company car allocations, monthly prestart check and km log.
- Incident reporting.
- Dockerfile, docker-compose, Bicep for Azure Container Apps, GitHub Actions pipeline.
- Test logins for every role and account state (password `neumansteel123`), non-production only.
- Fixed: board day click pre-filled the previous date for users east of UTC; incident "Other" weather box could not appear.

## 1.1.0

- Data Export API (`/api/export/v1`) for loading all platform data into Fabric: manifest, paged and incremental datasets, deletion tombstones, API-key auth.
- Migration 002: `updated_at` change tracking and `deleted_records`.
- Fabric ingestion notebook and docs; Data Export API added to the platform standard (section 14).

## 1.1.1

Pre-deployment fixes from the Azure deployment guide.

- Deploy check now inspects the new Container App revision with the Azure CLI instead of calling `/health`, so it works when `ALLOWED_IP_RANGES` blocks GitHub runners.
- Workflow permissions are per job; only the deploy job gets `id-token: write`.
- `docker-compose.yml` publishes the port on `127.0.0.1` only.
- Export routes are mounted before user lookup and the CSRF check; a forged `X-MS-CLIENT-PRINCIPAL` header on `/api/export/*` cannot create or read a user (new test).
- Original single-file tool removed from the repository; `resources/` is git-ignored.
- Added `.github/dependabot.yml` (npm, GitHub Actions, Docker; weekly).
- Persistence test on staging: bookings survive a restart, a stop and start, and a new revision deployed from a merged pull request.

## 1.2.0

- Admins can delete a pool vehicle from the edit window or the Archived tab. A warning popup says it is permanent; in the database it is only a `deleted` flag (migration 003), so the vehicle row and every booking, trip log and audit entry are kept. Archive and Restore are unchanged.
- Deleted vehicles disappear from the fleet lists, the board and booking; their registration cannot be reused. The Data Export API vehicles dataset gains `deleted`, `deleted_at`, `deleted_by`.
- Sign-in page is identical in every environment: the clickable test-login list is gone and `/api/auth/config` no longer returns test accounts or the test password.
- Archive, Restore and Delete failed with a bare `Request failed (403)` on the deployed site, and so did every other write (POST). Cause: the app sent `Referrer-Policy: no-referrer`, so the browser sent no Referer, and the Azure Container Apps sign-in layer (Easy Auth) rejects any POST without one as a possible cross-site forgery, before it reaches the app. The app now sends `Referrer-Policy: same-origin` (Referer to our own site only, nothing to other sites); new test. Every non-GET request also sends a JSON body, which is harmless.
- Archive: the page now reports a failed refresh after a successful archive instead of failing silently; new test covers archiving a vehicle that has bookings.

## 1.3.0

- Production access is now decided by the Entra app roles on the signed-in user's token (`roles` claim): `CarPool.User` gives normal booking access, `CarPool.Admin` gives administrator access plus everything a user has, and administrator wins if both are held. Users with neither role are denied: every API call returns 403 (`code: "no_role"`), `/nsadmin` shows the no-access page, the main page shows a no-access message with a Sign out button, and no user record is created.
- Removed the hard-coded admin list: `ADMIN_EMAILS`, `ADMIN_ROLE`, the `adminEmails` Bicep parameter and the pipeline variable are gone. **Before deploying, assign `CarPool.Admin` to the admins in Entra, or nobody will be able to administer the app.**
- Roles are re-read from the token on every request, so a changed role applies as soon as Entra issues a token with it (next sign-in). A role removed mid-session is refused on the next call and the page switches to the no-access screen.
- Role value matching is exact and case-sensitive (`Admin` or `carpool.admin` no longer grant anything). Test environments (`AUTH_MODE=local`) are unchanged.
- Tests: both roles, both together, neither, old role names, array-style roles claim, promotion, demotion and removal between requests, no account for no-role users.

