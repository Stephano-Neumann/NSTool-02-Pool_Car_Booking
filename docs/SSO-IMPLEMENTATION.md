# Implementing SSO (Microsoft Entra ID)

How to switch this platform from test sign-in to single sign-on. The same steps apply to every platform built to the [Platform Standard](../docs/PLATFORM-STANDARD.md).

**Status:** the app side is built and unit-tested with simulated headers. The Azure and Entra steps below have **not** been run against a real tenant, so treat the first run as a trial and fix small differences as you find them. Several steps need Entra or subscription rights; if you do not have them, send this document to IT.

## 1. How it works

```
Browser ──► Container App ingress ──► Easy Auth (Entra sign-in) ──► App
                                         adds X-MS-CLIENT-PRINCIPAL
```

- **Azure Container Apps authentication ("Easy Auth")** signs the user in with Entra ID *before* the request reaches the app. The app contains no Microsoft sign-in code.
- The app (`AUTH_MODE=gateway`) reads the `X-MS-CLIENT-PRINCIPAL` header the platform adds, takes the user's email, name and roles from it, and creates the user record on first sign-in.
- **Authentication** (who you are) comes from Entra. **Authorisation** (what you may do) stays in the app: roles are checked on the server for every request.

| Role | How it is granted |
|---|---|
| Admin | Entra app role `Admin` (setting `ADMIN_ROLE`), or the email is listed in `ADMIN_EMAILS` (bootstrap) |
| Driver | Everyone else who signs in |

Already in the app and needing no change: first-run licence prompt, policy acknowledgement, sign-in and sign-out links (`/.auth/login/aad`, `/.auth/logout`), password features hidden in gateway mode, and refusal to start in production with test logins or local passwords.

## 2. Before you start

- [ ] The app is deployed and healthy in Azure (see README, "Deploy to Azure Container Apps").
- [ ] You know the app's address (FQDN): `az containerapp show -g <rg> -n <app> --query properties.configuration.ingress.fqdn -o tsv`
- [ ] Decide who may use the tool (everyone in the tenant, or named people and groups). The recommendation is named groups.
- [ ] **Close the export-route gap first** (section 7). It must be fixed before go-live.

## 3. Create the Entra app registration (IT)

In the Entra admin centre → **App registrations → New registration**:

1. **Name:** e.g. `NST Car Booking`. **Supported account types:** this organisation only (single tenant).
2. **Redirect URI** (type *Web*): `https://<app-fqdn>/.auth/login/aad/callback`
3. After creating it, record the **Application (client) ID** and **Directory (tenant) ID**.
4. **Authentication** → under *Implicit grant and hybrid flows*, tick **ID tokens**.
5. **Certificates & secrets** → new client secret. Record the value (shown once) and set a calendar reminder for its expiry. Store it in Key Vault, never in the repo.
6. **App roles** → create a role:
   - Display name `Admin`, allowed member types *Users/Groups*, **value `Admin`** (must match `ADMIN_ROLE`), enabled.
7. **Token configuration** → add the optional claims `email` and `upn` to the ID token if the sign-in later fails with "no email" (the app accepts `preferred_username`, `upn` or `emails`).

Then in **Enterprise applications → NST Car Booking**:

1. **Properties** → set **Assignment required? = Yes**. Only assigned people and groups can now sign in.
2. **Users and groups** → assign the groups who may use the tool as normal users, and assign the people who should be admins with the **Admin** role.

## 4. Turn on authentication on the Container App

Azure portal → the Container App → **Authentication** → **Add identity provider**:

| Setting | Value |
|---|---|
| Identity provider | Microsoft |
| App registration | Pick an existing registration → the one above |
| Client secret | The secret from step 3 (store it as a Container App secret) |
| Issuer URL | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Restrict access | **Require authentication** |
| Unauthenticated requests | **HTTP 302 redirect to the identity provider** |
| Token store | Off (the app does not need tokens) |

Then set **excluded paths** (Authentication → *Edit* the auth settings, or the `excludedPaths` of the auth config):

- `/health`: the deploy pipeline's smoke test and the container probes have no user.
- `/api/export/*`: Fabric calls this with an API key, not an interactive sign-in.

Everything else requires a signed-in user.

## 5. Switch the app to gateway mode

Set these on the deployment (GitHub repository **variables**, read by the pipeline):

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `AUTH_MODE` | `gateway` |
| `SEED_TEST_DATA` | `false` (forced off in production anyway) |
| `ADMIN_EMAILS` | Your own email, so you can sign in as admin before roles propagate. Remove it once the `Admin` role works |

Push to `main` (or re-run the workflow). The app refuses to start in production if test data or local sign-in is still on, which is the intended safety net.

Staging can stay on local sign-in with test logins while production uses SSO. Keep the staging address IP-restricted.

## 6. Verify (do all of these)

| Check | Expected |
|---|---|
| Open `https://<fqdn>/` in a private window | Redirected to Microsoft sign-in, then the menu |
| Sign in as an assigned driver | Menu shows; licence prompt on first use; no admin screens |
| Sign in as an `Admin`-role user | Admin screens appear |
| Sign in as someone not assigned | Microsoft blocks sign-in |
| `curl -i https://<fqdn>/api/me` (no sign-in) | 302 or 401, never user data |
| `curl -i https://<fqdn>/health` | 200 `{"status":"ok",...}` |
| `curl -i -H "X-MS-CLIENT-PRINCIPAL: eyJ9" https://<fqdn>/api/me` | 302 or 401. A forged header must get nowhere |
| `curl -i https://<fqdn>/api/export/v1/manifest` (no key) | 401 |
| Fabric notebook run | Pulls data with the key |
| Sign out | Returns to the sign-in page; reopening requires sign-in |

If the forged-header call returns user data, **stop**. Authentication is not being enforced in front of the app and gateway mode is unsafe.

## 7. Known gaps to close before go-live

1. **Export routes and forged headers.** `/api/export/*` is excluded from Easy Auth, so anyone can send a forged `X-MS-CLIENT-PRINCIPAL` header there, and the app currently creates a user record from it before the API key check rejects the request. The export routes should skip the user lookup entirely. Small change in `src/app.js` / `src/auth.js`, with a test.
2. **Easy Auth is configured by hand.** `infra/main.bicep` does not yet define it. Put it in code so it cannot drift: an auth config on the Container App, with the client secret as a Key Vault-backed secret.
3. **Leavers.** Removing someone from Entra stops sign-in, but their user row, bookings and reports stay (usually correct for records). Decide with People & Culture whether anything else must happen when someone leaves.
4. **Client secret expiry.** An expired secret stops all sign-in. Calendar reminder, or use a federated credential instead of a secret.
5. **Role changes lag.** A user's role comes from the token at sign-in, so a role change applies at their next sign-in.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Redirect loop | Redirect URI in the app registration does not exactly match `https://<fqdn>/.auth/login/aad/callback` |
| Signed in but the app shows the sign-in page again | Ingress is bypassing Easy Auth, or `AUTH_MODE` is still `local` |
| 401 on `/api/me` after sign-in | Principal has no usable email claim; add `email`/`upn` optional claims (section 3, step 7) |
| Everyone is a driver, nobody admin | `Admin` role not assigned in the enterprise app, role value is not exactly `Admin`, or user has not signed in again since |
| App will not start in production | `SEED_TEST_DATA` or `AUTH_MODE=local` still set, read the startup error in the logs |
| `AADSTS50105` | "Assignment required" is on and the user is not assigned |
| Pipeline smoke test fails | `/health` is not in the excluded paths |

## 9. Rolling back

Set `AUTH_MODE=local` and `APP_ENV=staging` and redeploy (only in a non-production environment), or reactivate the previous Container Apps revision. Do not "fix" a production sign-in problem by enabling local passwords or test data on a system with real data.

## 10. Reusing this for the next platform

The app side is identical for every platform (`AUTH_MODE=gateway`, the `Admin` role, the excluded paths). Per platform you need only a new app registration (or a new redirect URI on a shared registration), role assignments, and the Authentication settings on its Container App.
