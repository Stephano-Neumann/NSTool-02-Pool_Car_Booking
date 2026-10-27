# Car booking tool — notes for Claude Code

Follow `docs/PLATFORM-STANDARD.md`. This repo is its reference implementation.

## Commands

- Run locally: `docker compose up --build` → http://localhost:8080 (reset data: `docker compose down -v`)
- Tests: `docker build --target test .` (no Node on the dev machine is assumed)
- All test logins use the password `neumansteel123`; list is in `README.md` and `src/seed.js`

## Rules

- Authorisation lives in `src/routes/*` and `src/auth.js`. Never rely on the browser (`public/app.js`) for access control.
- Schema changes: add a new numbered file in `src/migrations/`. Never edit an existing one.
- No inline scripts in `public/` (the CSP blocks them). No secrets in the repo.
- Adding a role or account state: add a test login in `src/seed.js` and a row in the README table, and cover it in `test/api.test.js`.
- Never enable `SEED_TEST_DATA` or `AUTH_MODE=local` for production.
- Keep `README.md` and `CHANGELOG.md` current with every change.
