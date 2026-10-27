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
