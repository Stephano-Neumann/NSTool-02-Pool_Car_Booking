# Neumann Steel Internal Platform Standard

**Version:** 0.1 (draft) · **Reference implementation:** `NSTool-02-Pool_Car_Booking` (car booking)
**Status:** Draft. Hosting, repo structure and the approval gate (section 12) need a decision from the platform owner and IT before this is final.

Every internal tool we build — whether it starts as a shadow tool, a Claude artifact or a fresh idea — follows this standard. The car booking tool is the pilot; where this document and that repo disagree, fix whichever one is wrong.

## 1. Principles

1. **Stay inside the Microsoft tenant.** Azure for hosting, Entra ID for identity, GitHub for source. No third-party hosts for company data.
2. **The server decides.** Anything a user must not do is enforced on the server. The browser is untrusted: no passcodes, role checks or "hidden" data in client code.
3. **State lives outside the container.** A container is disposable. Data goes in a database on a persistent volume (or a managed database), never in the container filesystem or the browser.
4. **Same shape every time.** Same layout, config, health check, pipeline and test logins, so any engineer (or Claude Code session) can pick up any tool.
5. **Nothing reaches production without a review.** Pull request, passing tests, then deploy.

## 2. Intake and triage

Before building, answer these. Put the answers in the tool's `README.md`.

| Question | Why it matters |
|---|---|
| Who uses it, and which roles exist? | Drives the role table (section 5) and the test logins (section 6). |
| **Where does state live?** | Decides database tier (section 7) and backup needs. |
| What does it send or call (email, webhooks, Graph, other systems)? | Needs permissions, a sender mailbox, secrets. |
| Does it hold personal or sensitive data (licences, incident reports, HR)? | Retention, access logging, who may export. |
| What replaces it if it is switched off? | Decides how much availability effort is justified. |

**Triage outcome — pick one:**

- **Harden in place:** the tool already has a real backend and database. Apply sections 3–11 to what exists.
- **Re-platform:** single-file, artifact-style or browser-storage tools (e.g. anything using `window.storage` or `localStorage` as its database). There is no backend to harden. Rebuild on this stack, keeping the UI and behaviour.

## 3. Reference stack

| Layer | Standard | Notes |
|---|---|---|
| Runtime | Node.js 22, Express 5 | One language front to back keeps tools approachable. A different runtime needs a written reason. |
| Database | SQLite (`better-sqlite3`) on a mounted volume — see section 7 for when to move to Azure SQL or Postgres | Numbered SQL migrations from day one. |
| Frontend | Static files served by the backend from `public/`. Plain HTML, CSS and JS unless the tool needs a framework | No inline scripts (the CSP forbids them). |
| Container | One `Dockerfile`, multi-stage, non-root, `HEALTHCHECK` | Test stage runs the API tests. |
| Hosting | Azure Container Apps, one replica while on SQLite | App Service is acceptable; a self-managed VM is not the default. |
| Registry | Azure Container Registry, pulled with a managed identity | No registry passwords. |
| CI/CD | GitHub Actions with OIDC login to Azure | No stored Azure credentials. |
| Identity | Entra ID at the gateway (Container Apps authentication) in production | Local passwords only in non-production (section 5). |

## 4. Repository layout

A tool is one folder with this shape. As a standalone repo it is the repo root. In the monorepo it is `tools/<tool-name>/` and the workflow paths gain that prefix.

```
.github/workflows/ci-cd.yml    test on every PR; deploy on merge to main
docs/                          standards, runbooks
infra/main.bicep               everything Azure needs, as code
public/                        static frontend (index.html, app.js, styles.css, assets/)
scripts/                       operational scripts (add-user.js, ...)
src/                           server: app.js, server.js, config.js, db.js, auth.js, routes/, migrations/
test/                          API tests (node:test)
Dockerfile  docker-compose.yml  .dockerignore  .gitignore  .env.example
README.md  CHANGELOG.md  CLAUDE.md
```

Rules: no secrets in the repo (`.env` is ignored, `.env.example` documents every variable); no build artefacts; generated files are not committed.

## 5. Identity, roles and authorisation

**Authentication** (who are you) and **authorisation** (what may you do) are separate.

| Environment | `AUTH_MODE` | How people sign in |
|---|---|---|
| local, staging | `local` | Email + password against the app's `users` table (scrypt-hashed). Test accounts only. |
| production | `gateway` | Entra ID, enforced by the platform before a request reaches the app. The app reads the `X-MS-CLIENT-PRINCIPAL` header. |

Gateway mode is only safe when the platform is set to **require authentication** and block anonymous requests. Otherwise the header can be forged. Verify this before go-live by calling the app directly with no sign-in and a made-up header.

**Roles** come from Entra app roles in production (`ADMIN_ROLE`, default `Admin`; `ADMIN_EMAILS` bootstraps the first admins). Each tool documents its roles in a table:

| Role | Can | Cannot |
|---|---|---|
| admin | everything in the tool | — |
| driver (default) | their own records | see other users' personal details |

Authorisation rules:

- Every route declares its requirement (`requireAuth`, `requireAdmin`, or an ownership check). A route with none is a bug.
- Ownership is checked from the session user, never from an ID or name in the request body.
- Data about other people is redacted on the server before it is sent (the car board shows "Booked", not a name).
- The server refuses to start with unsafe settings: test data or local auth in production.
- Login throttling, a generic "incorrect email or password" message, and no user enumeration.
- Mutating API calls require `X-Requested-By` (a CSRF guard on top of `SameSite=Lax` cookies).

## 6. Test logins (every platform)

Every tool ships test accounts so any screen and edge case is reachable in seconds.

- **Password for every test login on every platform: `neumansteel123`.**
- Email format: `<role>[.<state>]@neumannsteel.test` (the `.test` domain is reserved and can never receive real email).
- **One account per role, and one per notable account state.** The minimum set:

| Persona | Purpose |
|---|---|
| `admin@` | Full access |
| one per additional role | e.g. `approver@`, `viewer@` |
| `<role>.new@` | First-run: incomplete profile, onboarding or policy not yet accepted |
| `<role>.empty@` | No data: every empty state |
| `<role>.<scenario>@` | Rich data for each major workflow and each error state (declined, overdue, faulted) |
| a second user of the same role | Proves users cannot see each other's data |
| `disabled@` | Account exists but is switched off; sign-in must be refused |

- Seed data is **relative to today**, so the screens are never empty or stale.
- Test accounts are refreshed on every start so the shared password always works. Sample records are inserted once.
- The login screen lists the test logins as click-to-sign-in rows when test data is on, and shows an environment badge.

**Hard rules**

1. Seeding is controlled by `SEED_TEST_DATA=true` and **refused when `APP_ENV=production`** (the server will not start).
2. Staging that has test logins must not hold real data, and should be IP-restricted (`allowedIpRanges` in the Bicep).
3. Never reuse this password for anything that is not a test login.
4. Each tool's README lists its test logins and what each one is for.

## 7. Data

**Where it lives**

| Tier | Use when | Setup |
|---|---|---|
| 1 — SQLite on a volume | Internal tool, tens of users, one writer, acceptable to restore from the last snapshot | `DATA_DIR=/data`, Azure Files share mounted, **exactly one replica**, `SQLITE_JOURNAL_MODE=DELETE` on Azure Files |
| 2 — Azure SQL or PostgreSQL | More than one replica, many concurrent users, or any need for point-in-time restore | Managed service, private access, same migrations discipline |

Moving from tier 1 to tier 2 is a planned change, not an emergency: keep SQL portable (no SQLite-only tricks in application code) and keep all access in one data layer.

**Always**

- Schema changes are numbered files in `src/migrations/` applied once, in order, inside a transaction. Never edit a shipped migration.
- Foreign keys on; constraints and `CHECK`s in the schema, not just in code.
- Timestamps stored as UTC ISO strings. Display in the user's time zone. Anything that must group by day or month (like "this month's prestart") uses the configured `TZ` (default `Australia/Brisbane`).
- Backups: the Azure Files share needs snapshots or Azure Backup, and the restore has been tried once before go-live. Soft delete alone is not a backup.
- Files (PDFs, photos): small files may live as blobs in the database; anything large or numerous goes to Azure Blob Storage, private, served through an authenticated endpoint or short-lived SAS link. Validate type by content (e.g. `%PDF-`), not file extension, and cap size.
- Personal data: collect only what the tool needs, show it only to roles that need it, and say how long it is kept.
- An append-only `audit_log` records who changed what (admin actions at minimum).

## 8. API conventions

- JSON under `/api`; static frontend at `/`; unauthenticated `GET /health` returns `{"status":"ok","version":"<git sha>","env":"..."}` and checks the database.
- Errors: `{"error":"<message a user can act on>"}` with the right status (400 validation, 401 not signed in, 403 not allowed, 404 not found or not yours, 409 conflict, 429 throttled). Never leak stack traces or SQL.
- Validate every field on the server: type, length, range, allowed values. The client's validation is a convenience only.
- Business rules (double-booking, odometer going backwards, state transitions) are enforced on the server in a transaction.
- Logs are one JSON object per line to stdout (`level`, `msg`, `ts`, context). No passwords, tokens or personal data in logs.

## 9. Outbound services

- Email: Microsoft Graph `sendMail` from a dedicated shared mailbox, or a Power Automate HTTP trigger as the interim route (the car tool uses the webhook route). Record every notification in a log table, delivered or not.
- Server-side calls to admin-supplied URLs accept public `https` only (no localhost or private ranges), with a timeout.
- Secrets (webhook URLs with keys, Graph credentials) come from environment variables fed by Key Vault or GitHub secrets, never from the repo.
- Anything the tool talks to is listed in its README (intake question 3).

## 10. Security checklist (every tool, before first deploy)

- [ ] No secrets, passcodes or recovery codes in source or the frontend bundle
- [ ] All authorisation on the server; tested with a driver-level login calling admin endpoints directly
- [ ] Users cannot read or change other users' records by changing an ID
- [ ] Passwords hashed (scrypt/argon2/bcrypt); login throttled; sessions `HttpOnly`, `SameSite`, `Secure` behind TLS, with an expiry
- [ ] Security headers and a strict CSP (no inline scripts, no `eval`)
- [ ] All output escaped in the browser; all SQL parameterised
- [ ] File uploads validated by content and size
- [ ] Errors are generic to the user and detailed in the log
- [ ] `/health` works and the container runs as non-root
- [ ] Test data and local auth refused in production, with a test that proves it
- [ ] README, CHANGELOG, and the role and test-login tables are current
- [ ] **Per-tool audit:** read the original tool for flaws specific to it. The car tool's were a hard-coded admin passcode and recovery code in the page source, client-side-only admin checks, an impersonable name-and-licence login, and a policy PDF held in browser storage. A generic checklist would not have caught them.

## 11. Environments and delivery

| Environment | `APP_ENV` | Data | Auth |
|---|---|---|---|
| local | `local` | Docker volume, test data | `local` |
| staging | `staging` | Own database, test data optional, no real data | `local` or `gateway` |
| production | `production` | Real data | `gateway` only |

Pipeline (`.github/workflows/ci-cd.yml`):

1. **Every pull request:** API tests (`docker build --target test`), build the release image, start it and hit `/health`.
2. **Merge to `main`:** provision infrastructure from `infra/main.bicep`, build the image in ACR tagged with the commit SHA, deploy a new revision, then smoke-test `/health` and confirm it reports the new SHA.
3. **Rollback:** reactivate the previous Container Apps revision, then fix forward through a PR.

Branch protection on `main`: pull request required, tests must pass, no direct pushes, no force pushes. Creators work on their own branch. The real guardrail is repository permissions, so test that a creator's credentials genuinely cannot push to `main`. `CLAUDE.md` is guidance, not enforcement.

Releases are listed in `CHANGELOG.md`.

## 12. Open decisions (need a human owner)

| Decision | Options | Owner |
|---|---|---|
| Hosting target | Container Apps (used by the pilot) or App Service | Platform owner / IT |
| Repo structure | One repo per tool, or monorepo `tools/<name>/` | Platform owner |
| Approval gate | Who reviews and approves a merge to `main` | Platform owner |
| Database tier for the first production tool | SQLite tier 1 or a managed database | Platform owner / IT |
| Sender mailbox and Graph permissions | Shared mailbox name and who grants consent | IT |
| Retention periods | Per tool, for incident and driver data | Business owner / People & Culture where staff data is involved |
| GitHub plan | Whether organisation SSO is available on the current plan | IT |
| Fabric to platform network path | Public ingress with an IP allow-list, or private networking | IT |

## 13. Definition of done for a new tool

1. Intake answers and triage outcome recorded in the README.
2. Layout, Dockerfile, compose file, `.env.example` match section 4.
3. Roles table, test logins (section 6) and seed data in place.
4. API tests cover sign-in for every test login, authorisation boundaries, and each business rule.
5. Security checklist (section 10) ticked.
6. `docker compose up --build` works from a clean clone.
7. Pipeline green on a PR, deployed to staging, `/health` reports the deployed SHA.
8. Backup restore tried once.
9. Production plan written down: gateway sign-in, Entra roles, data tier, mailbox.
10. Data Export API (section 14) implemented, tested, and the platform added to the Fabric notebook.

## 14. Data Export API (every platform)

Every platform exposes the same read-only API so one Fabric pipeline can load all platform data into the lakehouse. Full detail and setup: [FABRIC-INGESTION.md](FABRIC-INGESTION.md). The car booking tool is the reference (`src/routes/export.js`).

**Contract — do not vary it:**

| Item | Standard |
|---|---|
| Base path | `/api/export/v1` |
| Auth | API key, `Authorization: Bearer <key>` or `X-Api-Key`. Not a user session; an admin login must not work here |
| Key config | `DATA_API_KEY` (and `DATA_API_KEY_NEXT` during rotation) from Key Vault / GitHub secrets. No key = endpoints return 404 |
| `GET /manifest` | `platform, version, env, schemaVersion, serverTime, datasets[{name, primaryKey, watermarkColumn, containsPersonalData, columns, rowCount}]` |
| `GET /<dataset>` | `?updatedSince=&cursor=&limit=` (limit 1–5000) → `{platform, dataset, extractedAt, count, hasMore, nextCursor, data}` |
| Keys and paging | Every dataset has an integer `id` primary key and is paged by `id` |
| Change tracking | Mutable tables carry `updated_at` (UTC ISO, maintained by triggers or the data layer). Append-only tables use their own timestamp as the watermark |
| Deletions | Recorded in a `deleted_records` dataset (`entity`, `entity_id`, `deleted_at`) |
| Platform name | `PLATFORM_NAME` env var; lowercase, used in lake table names |

**Rules**

1. **Allow-list columns per dataset.** New columns are not exported until someone adds them. Never export password hashes, sessions, tokens, webhook URLs or secrets, and never file contents (metadata only).
2. Flag every dataset that holds personal data (`containsPersonalData`). The lakehouse tables built from them are confidential, with access limited accordingly.
3. Read-only. No write, update or delete through this API.
4. Failed key attempts are throttled and logged. Successful pulls are logged (dataset, row count, caller IP) without data.
5. Exclude `/api/export/*` and `/health` from gateway (Entra) authentication; the key protects them.
6. Tests must cover: key required, session not accepted, disabled without key, no secret columns, paging, incremental load, deletion tombstone.
7. Schema changes go through migrations as usual. The manifest's `schemaVersion` changes with them, and the Fabric load takes new columns without breaking because bronze stores strings.
8. Keys: one per platform and environment, generated with `openssl rand -hex 32`, rotated on staff changes using the two-key process.

Open decision for IT: how Fabric reaches each platform (public ingress with IP allow-list, or private networking).
