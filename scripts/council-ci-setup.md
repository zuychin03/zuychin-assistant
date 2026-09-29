# Council database CI

The database job creates an isolated Supabase stack inside its GitHub Actions runner. No hosted project or `TEST_*` repository secrets are required. The suites insert and delete test rows and deliberately expire a Council lease, so they must stay separate from the owner's database.

## Isolated setup

The workflow pins Supabase CLI **2.118.0** and copies [the CI configuration](../.github/supabase/config.toml) into `$RUNNER_TEMP/council-supabase/supabase/config.toml`. It starts PostgreSQL 17, Auth, REST and the local API gateway. Optional services are disabled. This separate working directory excludes the checkout's ignored migration history and seed data.

CI applies the **entire** authoritative [`supabase-setup.sql`](../supabase-setup.sql) through `psql` with `ON_ERROR_STOP`, reloads the REST schema cache and waits for the required Council tables to become accessible. A schema or readiness error fails the job. The script contains its own transactions; CI does not wrap it in one transaction or reuse a partially initialised database.

[`prepare-council-ci.mts`](prepare-council-ci.mts) reads the local stack's status file and creates `.env.local` for the database scripts. It accepts only an HTTP loopback API origin, rejects malformed keys and refuses to overwrite an existing file. It uses the stack's generated local keys and fresh random session and Council-host secrets. Credential values are not printed.

No provider API keys, production host credentials or owner desktop host are needed. A Gemini placeholder allows the MCP module to initialise; these suites use a fake Council agent and do not call Gemini.

## Required checks

The database job runs every suite below, without a secret-dependent skip:

1. `npm run council:schema:check`
2. `npm run agents:test`
3. `npm run council:v3:test:db`
4. `npm run council:protocol:test`
5. `npm run journal:test`
6. `npm run council:fault:test -- --require-phase-b --mcp-url http://127.0.0.1:3105/api/mcp/mcp`

For the last check, CI starts an owned temporary Next server on `127.0.0.1:3105`, verifies authenticated MCP readiness and requires mid-turn crash recovery to execute. Missing prerequisites or a skipped Phase B fail the job.

Cleanup runs even after failure: it stops the owned Next process group, stops this Supabase stack with `--no-backup`, and removes the temporary environment, status and log files. The normal Linux/Windows offline suites remain separate checks. Native desktop CI belongs to the separate, unpublished desktop work.

After an authorised commit and push or pull request, inspect the **checks** run for that exact commit. Confirm both offline jobs, all five database suites and required Phase B pass. Re-running an older commit does not validate this workflow. A green local run does not close the remote CI gate.

## Local checks and remaining gates

On 29/09/2026 an isolated Windows run with Node 25.6.0, Supabase CLI 2.118.0 and PostgreSQL 17 passed the complete SQL setup, schema gate (6), credentials (52), V3 database contracts (35), protocol (83), journal (10) and fault Phases A/B (35, zero skips). The environment helper passed 76 checks and actionlint 1.7.12 passed. Protocol tests were corrected to reflect the existing rejection policy and remove a network-timing assumption; no SQL changed. The exact-commit Ubuntu/Node 24 GitHub run remains pending publication.

Final typecheck and full lint passed in a temporary copy after clean `npm ci`; the original checkout lacked installed dependencies. The workflow's exact REST-readiness code also passed locally. The owned Next server and Supabase stack were stopped, with no listener on port 3105 or remaining test containers, and generated environment/status/startup-log files were removed. Existing unrelated containers were preserved; this does not claim removal of every temporary artifact.

These checks need no database or owner credentials:

```powershell
npm run council:ci:env:test
npm run council:fault:options:test
```

To reproduce the database job locally, use Docker and an isolated checkout with no `.env.local`, following the workflow's isolated configuration and cleanup. Do not replace the normal app's environment or point these suites at its database. If setup fails partway, recreate the disposable stack before retrying the full SQL script.

Passing isolated database CI does not validate hosted configuration or finish the live credential migration. Each knowledge caller, including the ACP probe, must move to a named client key before the shared knowledge bearers are removed. The dedicated Council host key stays separate.

The desktop shell still needs deployed HTTPS sign-in, pairing and full Council-flow acceptance. V4.0 starts only after V3.5's readiness requirements pass, and V4.2 waits for V4.0's V1 contract freeze. The owner's 29/09/2026 approval resumes the database CI blocker only; it does not waive those gates.
