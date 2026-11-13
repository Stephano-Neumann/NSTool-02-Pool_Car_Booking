# Neumann Steel Car Booking

Pool car booking, company car checks (monthly prestart and km) and incident reporting. Node.js + SQLite, runs in one Docker container, deploys to Azure Container Apps from GitHub.

This is the pilot tool for the [Platform Standard](docs/PLATFORM-STANDARD.md). It replaces the single-file `resources/pool-car-booking (6).html`, which kept its data in browser storage and enforced admin access in the page itself.

## Run it locally

```bash
docker compose up --build
```

Open <http://localhost:8080>. Data is stored in a Docker volume and survives restarts and rebuilds. Reset everything with `docker compose down -v`.

## Test logins

Password for **all** test logins: `neumansteel123`. The test environment uses the same sign-in page as every other environment, with no list of accounts on it: open `/nsadmin`, then type a test email and the password above. Test accounts only exist while test data is on.

| Email | Role | Use it to test |
|---|---|---|
| `admin@neumannsteel.test` | Admin | Every panel: approvals, drivers, fleet, alert recipients, alerts, policy PDF, company vehicles, allocations, company car activity, incident reports |
| `driver.new@neumannsteel.test` | Driver | First run: licence missing, policy not acknowledged, then a first booking |
| `driver.pool@neumannsteel.test` | Driver | Bookings in every state: completed, in progress (Finish trip), upcoming (Start trip), pending, declined, low fuel and damage flags |
| `driver.pool2@neumannsteel.test` | Driver | Second driver. Their bookings show as "Booked" on Paul's board |
| `driver.companycar@neumannsteel.test` | Driver | Allocated NST-C01. Monthly prestart and km not yet done |
| `driver.companycar.fault@neumannsteel.test` | Driver | Allocated NST-C02. Prestart faults flagged, service overdue |
| `driver.nocar@neumannsteel.test` | Driver | No company car, no history: all empty states |
| `driver.incident@neumannsteel.test` | Driver | Existing incident reports, with and without a third party |
| `driver.disabled@neumannsteel.test` | Driver | Disabled account. Sign-in must be refused |

Sample bookings are dated relative to today. Test data only exists when `SEED_TEST_DATA=true`.

## Roles

In production the role comes from the Entra app role on the signed-in user's token (`roles` claim). Nobody is made admin by email address.

| Entra app role | App role |
|---|---|
| `CarPool.Admin` | Admin (also has everything a Driver has). Wins if the user also has `CarPool.User` |
| `CarPool.User` | Driver |
| neither | No access: every API call returns 403 and the page shows a no-access message. No account is created |

Test environments (`AUTH_MODE=local`) keep using the role stored on each test login.

| Role | Can | Cannot |
|---|---|---|
| Admin | Approve or decline bookings, cancel bookings, manage the fleet, company vehicles and allocations, alert recipients and webhook, policy PDF, see all drivers and incident reports | — |
| Driver | See the availability board, request bookings, log their own trips, complete their own company car checks, submit and read their own incident reports | See other drivers' names or details, see admin panels, approve anything |

## Configuration

All settings are environment variables. See [.env.example](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `APP_ENV` | `local` | `local`, `staging` or `production` |
| `AUTH_MODE` | `local` | `local` = email + password. `gateway` = Entra ID via Container Apps authentication |
| `SEED_TEST_DATA` | `false` | Test logins and sample data. The app refuses to start with this on in production |
| `DATA_DIR` | `./data` (`/data` in the image) | Where `app.db` lives. Mount a persistent volume here |
| `SQLITE_JOURNAL_MODE` | `WAL` | Use `DELETE` when `DATA_DIR` is an Azure Files share |
| `ALLOWED_EMAIL_DOMAINS` | empty | Gateway mode: comma-separated email domains allowed to sign in (e.g. `neumann.com.au`); anyone else is treated as signed out and no user is created. Empty = no restriction |
| `ALERT_WEBHOOK_URL` | empty | Power Automate HTTP trigger for booking alert emails (admins can also set it in the app) |
| `DATA_API_KEY` / `PLATFORM_NAME` | empty / `car-booking` | Key for the read-only Data Export API used by Fabric (empty = disabled), and the name used in lake tables |

## Data for Fabric

The app exposes a read-only Data Export API (`/api/export/v1`) so all platform data can be loaded into the lakehouse. See [docs/FABRIC-INGESTION.md](docs/FABRIC-INGESTION.md) and [fabric/ingest_platforms.py](fabric/ingest_platforms.py). Local test key: `nst-test-data-api-key`.

## Other commands

```bash
docker build --target test .                                   # API tests (25)
docker compose exec app node scripts/add-user.js a@b.com "Name" admin 'a-long-password'
curl localhost:8080/health
```

## Deploy to Azure Container Apps

Pushing to `main` runs [ci-cd.yml](.github/workflows/ci-cd.yml): tests, then provision ([infra/main.bicep](infra/main.bicep)), build the image in Azure Container Registry, deploy a new revision, and check that the new revision is Healthy and Running with the Azure CLI (a plain `/health` call would fail when `ALLOWED_IP_RANGES` is set).

One-time setup (steps 2 and 3 need Entra and subscription permissions; if you do not have them, ask IT):

1. Create a resource group, e.g. `az group create -n rg-nst-car-booking -l australiaeast`.
2. Create an Entra app registration with a federated credential for this repo's `main` branch (GitHub OIDC), so no secret is stored.
3. Give that identity **Contributor** and **Role Based Access Control Administrator** on the resource group (the template grants the app permission to pull from the registry).
4. In GitHub, add repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and repository variable `AZURE_RESOURCE_GROUP`.
5. Optional variables: `APP_ENV` (`staging` default), `AUTH_MODE`, `SEED_TEST_DATA`, `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_IP_RANGES` (e.g. `["203.0.113.0/24"]`).
6. Push to `main`. The deployed URL is `https://<fqdn>/health` in the workflow log, or `az containerapp show -g <rg> -n ca-nstcarbooking --query properties.configuration.ingress.fqdn`.

**Staging has test logins with a shared, known password. Set `ALLOWED_IP_RANGES` to your office ranges, or do not put the URL anywhere public, and keep real data out of it.**

### Going to production

1. Set `APP_ENV=production` and `AUTH_MODE=gateway`. Test data is then forced off and the app refuses to start otherwise.
2. On the Container App, turn on **Authentication** with Microsoft Entra ID and require sign-in for all requests. Gateway mode trusts the header the platform sets, so this step is what makes it safe.
3. In the Entra app registration define two app roles with the values `CarPool.User` and `CarPool.Admin` (allowed member types: Users/Groups), and assign them under Enterprise applications > Users and groups. **Assign yourself `CarPool.Admin` before deploying: there is no email fallback, so anyone without a role is denied, including admins.** Turn on "Assignment required" on the enterprise application so unassigned people are stopped at sign-in too. Role changes reach the app when the user's token is next issued: have them sign out and in (`/.auth/logout`), or wait for the Easy Auth session to expire.
4. Check an unauthenticated request to the app URL is redirected to sign-in and cannot reach `/api`.

## Known limits

- **SQLite, one replica.** The template pins `maxReplicas = 1`, sets `minReplicas = 0` with `cooldownPeriod = 3600` so the app hibernates after 1 hour with no use and wakes on the next visit (the first visit after a sleep is slow), and mounts the database on Azure Files with `nobrl` and the rollback journal, because SMB does not support SQLite locking or WAL reliably. That is fine for this tool's size. Do not raise `maxReplicas`. If the tool outgrows this, move to Azure SQL or PostgreSQL (standard, section 7).
- **Backups.** The app-data share is protected by Azure Backup (vault rsv-nstcarbooking, daily at 7:30 PM UTC, kept 30 days). A restore of app.db from the 9 Nov 2026 recovery point into a separate share was tested and worked. Repeat a restore test after any change to the backup setup. The backup setup lives in Azure, not in the Bicep template.
- **Booking emails** are sent through a webhook (Power Automate) as in the original tool. Without one they are logged only. A Graph `sendMail` integration is the longer-term route.
- **Verified on staging (9 Nov 2026):** the Azure deployment (Bicep, workflow, managed identity, Azure Files mount) runs, and bookings survive a revision restart, a stop and start, and a new revision deployed from a merged pull request. Production sign-in with Entra is not yet set up.

## Differences from the original single-file tool

- Real sign-in (email + password locally, Entra in production) replaces the shared `1234` passcode, the recovery code in the page source and the name-plus-licence "login". Admin access is checked on the server.
- Drivers are identified by their account, not by typing a name and licence. Company car allocations match on the driver's email.
- The server enforces double-booking, trip log rules and the monthly prestart and km rules.
- Other drivers' bookings reach a driver's browser as anonymous time blocks.
- Two original bugs fixed: clicking a day on the board pre-filled the **previous** date for users east of UTC (such as Queensland), and the "Other" weather text box in incident reports could never appear (two elements shared one id).
- The policy PDF limit is 5MB and it is stored in the database, so it is part of the backup.

## Structure

See [docs/PLATFORM-STANDARD.md](docs/PLATFORM-STANDARD.md) section 4. Change history is in [CHANGELOG.md](CHANGELOG.md).
