# API reference

Everything the car booking platform exposes over HTTP. The browser app uses the **App API** (section 3). Fabric uses the **Data Export API** (section 4). Both are JSON.

The source of truth is the code: `src/routes/*.js`. If this document and the code disagree, the code wins, and this document should be fixed.

## 1. Conventions

| Item | Rule |
|---|---|
| Base URL | `https://<fqdn>` (locally `http://localhost:8080`) |
| Format | JSON request and response bodies, `Content-Type: application/json` (the policy upload is the one exception) |
| Dates | UTC ISO 8601 strings, e.g. `2026-10-27T05:55:42.159Z`. The browser converts to local time |
| IDs | Integers |
| Errors | `{"error":"<message a user can act on>"}` with the status codes below |
| Unknown path under `/api` | `404 {"error":"Not found."}` |

**Status codes**

| Code | Meaning |
|---|---|
| 200 / 201 | OK / created |
| 400 | Validation failed (bad or missing field) |
| 401 | Not signed in, or bad API key |
| 403 | Signed in but not allowed (e.g. a driver calling an admin endpoint), or missing `X-Requested-By` header |
| 404 | Not found, or not yours (the API does not reveal other people's records) |
| 409 | Conflict (double booking, duplicate, already submitted, wrong state) |
| 429 | Too many failed sign-in or key attempts. Wait about 15 minutes |
| 5xx | Server problem. The message is generic; details are in the logs |

## 2. Authentication

There are two separate mechanisms. They are not interchangeable.

**App API: a user, not a key.**

| Mode (`AUTH_MODE`) | How requests are authenticated |
|---|---|
| `local` (test, staging) | `POST /api/auth/login` sets an `HttpOnly` session cookie (`nst_sid`, 12 hours). Send it on later calls |
| `gateway` (production) | Entra ID signs the user in before the app. The app reads the `X-MS-CLIENT-PRINCIPAL` header the platform adds. See [SSO-IMPLEMENTATION.md](SSO-IMPLEMENTATION.md) |

Every **POST, PUT, PATCH and DELETE** under `/api` must also send the header `X-Requested-By: nst-app` (a cross-site request guard). A missing header returns 403.

**Data Export API: a key, not a user.** `Authorization: Bearer <key>` or `X-Api-Key: <key>`. A signed-in session is not accepted there.

**Roles.** `admin` can do everything. `driver` can use only their own records. Requirements are shown per endpoint: *any* = any signed-in user, *admin* = admin only, *owner* = the driver who owns the record.

## 3. App API (`/api`)

### 3.1 Sign-in and profile

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/auth/config` | public | `{mode, appEnv, version, testLogins}`. `testLogins` is `null` unless test data is on |
| `POST /api/auth/login` | public, local mode | Body `{email, password}`. Returns the user and sets the cookie. 401 wrong credentials, 403 account disabled, 404 in gateway mode, 429 throttled |
| `POST /api/auth/logout` | any | Ends the session |
| `GET /api/me` | any | The current user (below) |
| `PUT /api/me` | any | Body `{name, licence}`. Drivers must supply a licence number |
| `POST /api/me/policy-ack` | any | Records that the user acknowledged the vehicle use policy |
| `POST /api/me/password` | any, local mode | Body `{currentPassword, newPassword}` (8+ characters). Signs out other sessions |

User object: `{id, email, name, role, licence, policyAcked, profileComplete}`.

### 3.2 Vehicles and bookings (pool cars)

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/vehicles` | any | Fleet. Admins also see archived vehicles. `[{id, rego, model, archived}]` |
| `POST /api/vehicles` | admin | Body `{rego, model}`. 409 if the rego exists |
| `PUT /api/vehicles/:id` | admin | Same body |
| `POST /api/vehicles/:id/archive` | admin | Hides the vehicle from booking |
| `POST /api/vehicles/:id/restore` | admin | Reverses archive |
| `GET /api/bookings` | any | Drivers get their own bookings in full and everyone else's as anonymous blocks (see below). Admins get everything. Declined bookings are visible only to their owner and admins |
| `POST /api/bookings` | any | Create a booking, status `pending` |
| `POST /api/bookings/:id/review` | admin | Body `{decision: "approved" \| "declined"}`. 409 if already reviewed |
| `DELETE /api/bookings/:id` | admin | Cancel and remove |
| `PUT /api/bookings/:id/trip` | owner | Log a trip. Only when the booking is `approved` |
| `GET /api/drivers` | admin | Drivers with booking count, total km and policy acknowledgement time |

**Create booking** body: `{vehicleId, department, costCentre, use, pickup, ret}`, where `use` is `Business` or `Private`, and `pickup`/`ret` are ISO times (`ret` after `pickup`). A driver's name, licence and email come from their account. An **admin** booking on behalf of someone also sends `driverName`, `license` and optionally `email`. 409 if the vehicle is already booked for any part of that time.

**Booking object, in full** (own bookings and admin view): `{id, vehicleId, use, pickup, ret, status, mine, driverName, license, email, department, costCentre, createdAt, reviewedAt, actualPickup, actualReturn, startKm, finishKm, startNotes, finishNotes, fuelOk}`.
**Anonymous form** (other drivers' bookings as seen by a driver): only `{id, vehicleId, use, pickup, ret, status, mine}`.

**Trip log** body, in two steps. Start: `{actualPickup, startKm, startNotes}`. Finish: `{actualReturn, finishKm, finishNotes, fuelOk}` where `fuelOk` is a boolean (at least a quarter tank). Sending both edits a finished log. Rules: finish after start, finish odometer greater than start, `fuelOk` required on finish.

### 3.3 Admin settings

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/admin-profiles` | admin | People who receive booking alert emails |
| `POST /api/admin-profiles` | admin | Body `{name, email}` |
| `PUT /api/admin-profiles/:id` | admin | Same body |
| `DELETE /api/admin-profiles/:id` | admin | Remove |
| `GET /api/alerts` | admin | `{webhookUrl, log:[{id, kind, subject, recipients, sentAt, delivered}]}`, newest 50 |
| `PUT /api/alerts/webhook` | admin | Body `{url}`. Public `https://` URL only; empty clears it |
| `GET /api/policy` | any | Policy document metadata `{filename, size, uploadedAt}` or `null` |
| `GET /api/policy/file` | any | The PDF itself (`application/pdf`, inline) |
| `PUT /api/policy` | admin | Upload: raw PDF bytes as the body with `Content-Type: application/pdf` and header `X-Filename: <url-encoded name>`. Max 5MB, must start with `%PDF-` |
| `DELETE /api/policy` | admin | Remove |

### 3.4 Company cars

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/company-vehicles` | admin | Register of permanently allocated vehicles `[{id, rego, model, dueServiceKm}]` |
| `POST /api/company-vehicles` | admin | Body `{rego, model, dueServiceKm?}` |
| `PUT /api/company-vehicles/:id` | admin | Same body |
| `DELETE /api/company-vehicles/:id` | admin | Also removes its allocations |
| `GET /api/company-allocations` | admin | `[{id, name, email, vehicleId}]` |
| `POST /api/company-allocations` | admin | Body `{name, email, vehicleId}`. The driver is matched by the email they sign in with. One vehicle per driver |
| `PUT /api/company-allocations/:id` | admin | Same body |
| `DELETE /api/company-allocations/:id` | admin | Remove |
| `GET /api/company-car/me` | any | The caller's own car: `{monthKey, vehicle, prestart, km:[{monthKey, odometer, submittedAt}]}` (`vehicle` is `null` if none allocated) |
| `POST /api/company-car/prestart` | any (needs an allocation) | One per month. Body `{items, notes, mexNumber, faultCompleted}` |
| `POST /api/company-car/km` | any (needs an allocation) | One per month. Body `{odometer}`. Rejected if lower than last month's |
| `GET /api/company-car/activity` | admin | This month's prestart and km for every allocation |
| `PATCH /api/prestarts/:id` | admin | Body `{mexNumber?, faultCompleted?}` to track a flagged fault |

Prestart `items` is an object of booleans (`true` = OK) with exactly these keys: `tyres, lights, brakes, fluids, mirrors, presentable, dents`. The month is the current month in `Australia/Brisbane` time.

### 3.5 Incidents

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/incidents` | any | Admins see all reports, drivers see only their own. Newest first |
| `POST /api/incidents` | any | Submit a report |

Create body: `{description (required), weather, weatherOther, roadSurface, speedLimit, visibility, thirdParty}`. Allowed values:

- `weather`: `Dry / Sunny`, `Wet / Raining`, `Foggy`, `Overcast`, `Other` (then `weatherOther` is kept)
- `roadSurface`: `Sealed / Asphalt`, `Gravel`, `Dirt`, `Uneven`, `Muddy / Boggy`
- `visibility`: `Clear`, `Drastically Reduced`, `Night (Streetlights ON)`, `Night (Streetlights OFF)`
- `speedLimit`: a number up to three digits
- `thirdParty`: `{name, phone, email, licence, rego, vehicle, insurer, policy}`, all optional text

Blank values are allowed for the choice fields; anything else must match the lists above.

### 3.6 Example

```bash
# Sign in (local mode) and keep the cookie
curl -c jar.txt -H 'Content-Type: application/json' -H 'X-Requested-By: nst-app' \
  -d '{"email":"driver.pool@neumannsteel.test","password":"neumansteel123"}' \
  http://localhost:8080/api/auth/login

# Read, then write (writes need the X-Requested-By header)
curl -b jar.txt http://localhost:8080/api/bookings
curl -b jar.txt -H 'Content-Type: application/json' -H 'X-Requested-By: nst-app' \
  -d '{"vehicleId":5,"department":"IT","costCentre":"CC-1","use":"Business","pickup":"2026-11-10T23:00:00Z","ret":"2026-11-11T07:00:00Z"}' \
  http://localhost:8080/api/bookings
```

## 4. Data Export API (`/api/export/v1`)

Read-only, same contract on every Neumann platform, used to load data into Fabric. Key authentication only (section 2). If no key is configured the endpoints return 404. Setup and the notebook are in [../docs/FABRIC-INGESTION.md](../docs/FABRIC-INGESTION.md); the standard is [../docs/PLATFORM-STANDARD.md](../docs/PLATFORM-STANDARD.md) section 14.

| Method and path | Purpose |
|---|---|
| `GET /api/export/v1/manifest` | `{platform, version, env, schemaVersion, serverTime, datasets:[{name, primaryKey, watermarkColumn, containsPersonalData, columns, rowCount}]}` |
| `GET /api/export/v1/<dataset>` | One dataset, paged |

**Dataset query parameters**

| Parameter | Meaning |
|---|---|
| `limit` | 1 to 5000, default 1000 |
| `cursor` | The previous response's `nextCursor`. Omit for the first page |
| `updatedSince` | ISO date-time. Only rows whose watermark column is later than this. Omit for a full load |

**Response:** `{platform, dataset, extractedAt, count, hasMore, nextCursor, data:[…]}`. Keep requesting with `cursor=nextCursor` while `hasMore` is true; `nextCursor` is `null` on the last page.

**Datasets:** `users, vehicles, bookings, admin_profiles, alerts_log, company_vehicles, company_allocations, prestarts, km_log, incidents, policy_document, audit_log, deleted_records`.

- Rows are raw table columns in snake_case. JSON held in a column (`items`, `third_party`, `recipients`) arrives as a string.
- `deleted_records` lists removed rows: `{id, entity, entity_id, deleted_at}`.
- Never exposed: password hashes, sessions, settings and webhook URLs, the policy PDF contents.
- Several datasets contain personal data (names, emails, licence numbers, incident details). The manifest flags them with `containsPersonalData`.

```bash
curl -H 'Authorization: Bearer nst-test-data-api-key' http://localhost:8080/api/export/v1/manifest
curl -H 'Authorization: Bearer nst-test-data-api-key' \
  'http://localhost:8080/api/export/v1/bookings?limit=500&updatedSince=2026-10-27T00:00:00.000Z'
```

## 5. Health check

`GET /health`: no authentication. Returns `{"status":"ok","version":"<git sha>","env":"<APP_ENV>"}` after checking the database, or `503 {"status":"error"}`. Used by the container probes and the deploy pipeline's smoke test. When Entra authentication is on, this path must be excluded from it.

## 6. Security notes for API users

- Do not call the App API with an API key or the Export API with a session. They are deliberately separate.
- A driver's session cannot read other drivers' details, even by guessing IDs. Such requests return 404 or anonymised data.
- Logins and key attempts are throttled per address. Repeated failures return 429.
- The policy PDF is served with `Cache-Control: private`. Other API responses set no caching headers, so do not put a shared cache in front of `/api`.
- This API is not versioned apart from the export path (`/v1`). The App API is for the bundled browser app only; do not build other clients on it without agreeing a stable contract first.
