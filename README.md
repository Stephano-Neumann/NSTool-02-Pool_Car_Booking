# Neumann Steel Car Booking

Pool car booking, company car checks (monthly prestart and km) and incident reporting. Node.js + SQLite, runs in one Docker container, deploys to Azure Container Apps from GitHub.

This is the pilot tool for the [Platform Standard](docs/PLATFORM-STANDARD.md). It replaces the single-file `resources/pool-car-booking (6).html`, which kept its data in browser storage and enforced admin access in the page itself.

## Run it locally

```bash
docker compose up --build
```

Open <http://localhost:8080>. Data is stored in a Docker volume and survives restarts and rebuilds. Reset everything with `docker compose down -v`.

## Test logins

Password for **all** test logins: `neumansteel123`. The sign-in page lists them as click-to-sign-in rows while test data is on.

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
| `ADMIN_ROLE` / `ADMIN_EMAILS` | `Admin` / empty | Gateway mode: Entra app role that grants admin, and emails that are always admin |
| `ALERT_WEBHOOK_URL` | empty | Power Automate HTTP trigger for booking alert emails (admins can also set it in the app) |
| `DATA_API_KEY` / `PLATFORM_NAME` | empty / `car-booking` | Key for the read-only Data Export API used by Fabric (empty = disabled), and the name used in lake tables |

## Data for Fabric

The app exposes a read-only Data Export API (`/api/export/v1`) so all platform data can be loaded into the lakehouse. See [docs/FABRIC-INGESTION.md](docs/FABRIC-INGESTION.md) and [fabric/ingest_platforms.py](fabric/ingest_platforms.py). Local test key: `nst-test-data-api-key`.

## Other commands

```bash
docker build --target test .                                   # API tests (24)
docker compose exec app node scripts/add-user.js a@b.com "Name" admin 'a-long-password'
curl localhost:8080/health
```

## Deploy to Azure Container Apps

Pushing to `main` runs [ci-cd.yml](.github/workflows/ci-cd.yml): tests, then provision ([infra/main.bicep](infra/main.bicep)), build the image in Azure Container Registry, deploy a new revision, and smoke-test `/health`.

One-time setup (steps 2 and 3 need Entra and subscription permissions; if you do not have them, ask IT):

1. Create a resource group, e.g. `az group create -n rg-nst-car-booking -l australiaeast`.
2. Create an Entra app registration with a federated credential for this repo's `main` branch (GitHub OIDC), so no secret is stored.
3. Give that identity **Contributor** and **Role Based Access Control Administrator** on the resource group (the template grants the app permission to pull from the registry).
4. In GitHub, add repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and repository variable `AZURE_RESOURCE_GROUP`.
5. Optional variables: `APP_ENV` (`staging` default), `AUTH_MODE`, `SEED_TEST_DATA`, `ADMIN_EMAILS`, `ALLOWED_IP_RANGES` (e.g. `["203.0.113.0/24"]`).
6. Push to `main`. The deployed URL is `https://<fqdn>/health` in the workflow log, or `az containerapp show -g <rg> -n ca-nstcarbooking --query properties.configuration.ingress.fqdn`.

**Staging has test logins with a shared, known password. Set `ALLOWED_IP_RANGES` to your office ranges, or do not put the URL anywhere public, and keep real data out of it.**

### Going to production

1. Set `APP_ENV=production` and `AUTH_MODE=gateway`. Test data is then forced off and the app refuses to start otherwise.
2. On the Container App, turn on **Authentication** with Microsoft Entra ID and require sign-in for all requests. Gateway mode trusts the header the platform sets, so this step is what makes it safe.
3. Define an `Admin` app role in the Entra app registration and assign it to the admins. Everyone else who signs in is a driver, created on first sign-in.
4. Check an unauthenticated request to the app URL is redirected to sign-in and cannot reach `/api`.

## Known limits

- **SQLite, one replica.** The template pins `minReplicas = maxReplicas = 1` and mounts the database on Azure Files with `nobrl` and the rollback journal, because SMB does not support SQLite locking or WAL reliably. That is fine for this tool's size. Do not raise the replica count. If the tool outgrows this, move to Azure SQL or PostgreSQL (standard, section 7).
- **Backups are not configured by the template.** Turn on Azure Backup (or scheduled share snapshots) for the storage account's `app-data` share and try a restore before relying on it.
- **Booking emails** are sent through a webhook (Power Automate) as in the original tool. Without one they are logged only. A Graph `sendMail` integration is the longer-term route.
- **Not yet verified:** the Azure deployment (Bicep, workflow and Entra setup) has not been run against a real subscription. Expect to fix small things on the first run. Local Docker, the API tests and the browser walkthrough have been run.

## Differences from the original single-file tool

- Real sign-in (email + password locally, Entra in production) replaces the shared `1234` passcode, the recovery code in the page source and the name-plus-licence "login". Admin access is checked on the server.
- Drivers are identified by their account, not by typing a name and licence. Company car allocations match on the driver's email.
- The server enforces double-booking, trip log rules and the monthly prestart and km rules.
- Other drivers' bookings reach a driver's browser as anonymous time blocks.
- Two original bugs fixed: clicking a day on the board pre-filled the **previous** date for users east of UTC (such as Queensland), and the "Other" weather text box in incident reports could never appear (two elements shared one id).
- The policy PDF limit is 5MB and it is stored in the database, so it is part of the backup.

## Structure

See [docs/PLATFORM-STANDARD.md](docs/PLATFORM-STANDARD.md) section 4. Change history is in [CHANGELOG.md](CHANGELOG.md).
