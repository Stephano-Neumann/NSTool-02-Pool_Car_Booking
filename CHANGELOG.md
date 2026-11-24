# Changelog

## Unreleased

- Pool cars: new admin **Booking history** panel lists completed bookings (searchable) with a Details view of everything recorded: booking, driver, approval (and who approved it), trip log, odometer, fuel and notes. Bookings returned to admins now include who reviewed them.
- Incident reports: new required **Address of the incident** field at the top of the form, and photo attachments (up to 8). Admins see the address, photo count and every field, including the reporter's licence and email, in the incident panel and detail view. The reporter can add more photos to their own report later.
- Company car: drivers can attach photos to the monthly prestart check (when submitting, or afterwards). Admins get a **View check** button on the activity panel and a new **Prestart check history** panel showing every month's checklist, notes, Mex # and photos.
- Migration 006: `incidents.address` and a `photos` table. New endpoints: `POST /api/incidents/:id/photos`, `POST /api/prestarts/:id/photos`, `GET /api/photos/:id` (owner or admin), `GET /api/company-car/prestarts` (admin). Data Export API: `incidents.address` and a `photos` metadata dataset.
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

## 1.4.0

- Admins now sign in to the same pages as a regular user (`/`: Company Car, Pool Car Booking, Incident Management). An "Admin page" button on the menu, the session bar and the Company Car and Incident screens opens the admin console at `/nsadmin`, and a "User pages" button there brings them back, as often as they like.
- In the user view an admin books for themselves like any other user (own name and licence, no on-behalf fields) and sees only their own incident reports. The admin console still books on behalf of someone else.
- API: `POST /api/bookings` accepts `asSelf: true` (admin books as themselves); `GET /api/incidents?mine=1` returns only the caller's reports. Neither widens access; the role check is unchanged on every admin route.

## 1.5.0

- App usage analytics for Fabric. Migration 004 adds `usage_sessions` (one row per visit: user, account type, `user` or `admin` page, device class, start, last seen, end, active seconds, screen and action counts) and `usage_events` (each screen opened, and each write through the API with its HTTP status and duration).
- The browser sends `POST /api/usage/ping` when a screen opens, every 60 seconds while the page is visible, and when it is hidden or closed. Only time with the page visible counts. Writes are recorded on the server, so they do not depend on the browser. The sign-in itself is recorded too. Reads and the raw user agent are not stored.
- Data Export API: new datasets `usage_sessions` (watermark `updated_at`) and `usage_events` (watermark `at`), both flagged as personal data. The internal visit key is not exported. The Fabric notebook picks them up from the manifest.
- `USAGE_RETENTION_DAYS` (default 365): older usage is purged from the app in the hourly sweep, without tombstones, so the lake keeps the history. The app refuses to start if it is not a whole number of days, 1 or more.
- Migration 005: both usage tables and datasets carry `user_name` and `user_email` (as at the time), so the lake data is readable without a join to `users`. Existing rows are filled in from `users`.
- Tests: ping auth and validation, visit time and screens, idle gaps not counted, actions linked to the visit (including failures), sign-in recorded, another user's visit key refused, retention purge, export datasets and incremental load.
