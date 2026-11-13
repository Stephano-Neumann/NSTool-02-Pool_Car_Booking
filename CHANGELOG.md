# Changelog

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

## 1.2.0

- Admins can delete a pool vehicle from the edit window or the Archived tab. A warning popup says it is permanent; in the database it is only a `deleted` flag (migration 003), so the vehicle row and every booking, trip log and audit entry are kept. Archive and Restore are unchanged.
- Deleted vehicles disappear from the fleet lists, the board and booking; their registration cannot be reused. The Data Export API vehicles dataset gains `deleted`, `deleted_at`, `deleted_by`.
- Sign-in page is identical in every environment: the clickable test-login list is gone and `/api/auth/config` no longer returns test accounts or the test password.
- Archive: the page now reports a failed refresh after a successful archive instead of failing silently; new test covers archiving a vehicle that has bookings.
