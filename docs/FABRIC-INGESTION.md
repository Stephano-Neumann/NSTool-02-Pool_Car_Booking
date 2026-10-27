# Loading platform data into Fabric

Every platform exposes the same read-only **Data Export API**. One Fabric notebook ([fabric/ingest_platforms.py](../fabric/ingest_platforms.py)) loads all of them into the lakehouse as bronze Delta tables.

## The API

Base: `https://<platform-fqdn>/api/export/v1` · Auth: `Authorization: Bearer <api-key>` (or `X-Api-Key: <api-key>`). A signed-in user session does not work here, and the key does nothing else.

| Call | Returns |
|---|---|
| `GET /manifest` | Platform name, app version, schema version, `serverTime`, and every dataset with its columns, primary key (`id`), watermark column, row count and whether it contains personal data |
| `GET /<dataset>?updatedSince=<ISO>&cursor=<n>&limit=<n>` | `{platform, dataset, extractedAt, count, hasMore, nextCursor, data:[…]}` |

- `limit` is 1–5000 (default 1000). Page through with `cursor` = the previous `nextCursor`; stop when `hasMore` is `false` (`nextCursor` is then `null`).
- `updatedSince` returns only rows whose watermark column is later than that time. Omit it for a full load.
- Rows are raw table columns (snake_case). JSON stored in a column (e.g. `items`, `third_party`, `recipients`) arrives as a string.
- Deleted rows are listed in the `deleted_records` dataset (`entity`, `entity_id`, `deleted_at`).
- Never exposed: password hashes, sessions, settings and webhook URLs, and the policy PDF itself (only its metadata).
- Errors: `401` bad or missing key, `404` export not enabled or unknown dataset, `400` bad parameter, `429` too many failed attempts.

Car booking datasets: `users, vehicles, bookings, admin_profiles, alerts_log, company_vehicles, company_allocations, prestarts, km_log, incidents, policy_document, audit_log, deleted_records`. Personal data is flagged in the manifest (driver names and emails, licence numbers, incident details), so treat the lakehouse tables as confidential.

## Try it locally

```bash
docker compose up -d --build
curl -H "Authorization: Bearer nst-test-data-api-key" localhost:8080/api/export/v1/manifest
curl -H "Authorization: Bearer nst-test-data-api-key" "localhost:8080/api/export/v1/bookings?limit=2"
```

## Connect Fabric

1. **Create a key** per platform and environment: `openssl rand -hex 32`. Put it in two places: the GitHub secret `DATA_API_KEY` (the pipeline sets it on the Container App) and an Azure Key Vault secret, e.g. `car-booking-data-api-key`. Without a key the export endpoints return 404.
2. **Make the app reachable by Fabric.** If the Container App is IP-restricted, Fabric's outbound addresses must be allowed, or Fabric reaches it privately. This is a network decision for IT.
3. **Gateway sign-in:** when Entra authentication is on for the app, exclude `/api/export/*` and `/health` from it (Container Apps authentication → excluded paths). The API key protects those routes, not Entra.
4. **Notebook:** import `fabric/ingest_platforms.py` into your workspace, attach the lakehouse, fill in `KEY_VAULT_URL` and the `PLATFORMS` entry.
5. **Schedule** it from a Fabric pipeline (hourly is plenty). The first run loads everything; later runs load changes since the stored watermark.

Result tables: `bronze_<platform>_<dataset>` (all columns as strings plus `_ingested_at`), `bronze_ingest_control` (watermarks) and `bronze_ingest_log`. Build typed silver tables on top.

Prefer a Data Factory Copy activity? Use a REST source with the same URL, an `Authorization` header, and pagination rule *query parameter `cursor` = `$.nextCursor`*, ending when `$.nextCursor` is empty. The notebook is the better route because it handles watermarks, upserts and deletions.

## Add the next platform

The platform ships the same endpoints (standard, section 14), then:
1. Generate its key; store it in GitHub and Key Vault.
2. Add one entry to `PLATFORMS` in the notebook.
3. Run it.

## Rotate a key

1. Set `DATA_API_KEY_NEXT` to the new key (the app accepts both) and deploy.
2. Update the Key Vault secret to the new key.
3. Promote: set `DATA_API_KEY` to the new key, clear `DATA_API_KEY_NEXT`, deploy.

## Limits to know about

- The notebook has not been run in a real Fabric workspace. The API and its tests have been.
- A row changed twice between loads arrives once, in its latest state. Anything needing full history must be derived from `audit_log` or from successive loads.
- `users.updated_at` ignores logins and password changes on purpose.
- Keys are shared secrets: one leak exposes everything the API serves. Store them only in Key Vault and GitHub secrets, and rotate on staff changes.
