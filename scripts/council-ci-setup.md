# Council database CI

The database job creates an isolated Supabase stack inside its GitHub Actions runner. No hosted project or `TEST_*` repository secrets are required. The suites insert and delete test rows and deliberately expire a Council lease, so they must stay separate from the owner's database.

## Isolated setup

The workflow pins Supabase CLI **2.118.0** and copies [the CI configuration](../.github/supabase/config.toml) into `$RUNNER_TEMP/council-supabase/supabase/config.toml`. It starts PostgreSQL 17, Auth, REST and the local API gateway. Optional services are disabled. This separate working directory excludes the checkout's ignored migration history and seed data.

CI applies the **entire** authoritative [`supabase-setup.sql`](../supabase-setup.sql) through `psql` with `ON_ERROR_STOP`, reloads the REST schema cache and waits for the required Council tables to become accessible. A schema or readiness error fails the job. The script contains its own transactions; CI does not wrap it in one transaction or reuse a partially initialised database.

[`prepare-council-ci.mts`](prepare-council-ci.mts) reads the local stack's status file and creates `.env.local` for the database scripts. It accepts only an HTTP loopback API origin, rejects malformed keys and refuses to overwrite an existing file. It uses the stack's generated local keys and a fresh random session secret. Credential values are not printed.

No provider API keys or production credentials are needed. A Gemini placeholder allows the MCP module to initialise; these suites do not call Gemini.

## Required checks

The database job runs every suite below, without a secret-dependent skip:

1. `npm run council:schema:check`
2. `npm run agents:test`
3. `npm run council:v3:test:db`
4. `npm run council:protocol:test`
5. `npm run journal:test`

The schema, V3 and protocol suites cover what online councils use: host leases, host-issued seat keys, execution records, debate, pause and verdicts. Since the local council clean-up (`v7-council-local-cleanup.sql`, the last block of `supabase-setup.sql`), the V3 suite and the schema check also confirm that the campaign, delivery, owner-note and guest seat-key SQL is gone.

An additional transaction suite, `test-agent-claim-postgres.mts`, runs in a separate PostgreSQL 16 container with networking disabled and no published ports. It verifies real lock contention on agent claims. It removes its own database, and the workflow always removes its owned container. The seat renewal suite was removed with the clean-up, because the campaign-time renewal and the guest seat resolver it tested are gone.

Cleanup runs even after failure: it stops this Supabase stack with `--no-backup` and removes the temporary environment, status and log files. The offline suites remain a separate check.

After an authorised commit and push or pull request, inspect the **checks** run for that exact commit. Confirm the offline job, the transaction suite and all five database suites pass. Re-running an older commit does not validate this workflow. A green local run does not close the remote CI gate.

## Local checks and remaining gates

On 29/09/2026 an isolated Windows run with Node 25.6.0, Supabase CLI 2.118.0 and PostgreSQL 17 passed the complete SQL setup, schema gate (6), credentials (52), V3 database contracts (35), protocol (83), journal (10) and fault Phases A/B (35, zero skips). The environment helper passed 76 checks and actionlint 1.7.12 passed. Protocol tests were corrected to reflect the existing rejection policy and remove a network-timing assumption; no SQL changed in that snapshot. Published `60347c2` passed exact-commit GitHub run `36540520042`; retirement commit `300b808` passed run `36583804961`. Those results do not cover the subsequent native and campaign-credential changes.

Final typecheck and full lint passed in a temporary copy after clean `npm ci`; the original checkout lacked installed dependencies. The workflow's exact REST-readiness code also passed locally. The owned Next server and Supabase stack were stopped, with no listener on port 3105 or remaining test containers, and generated environment/status/startup-log files were removed. Existing unrelated containers were preserved; this does not claim removal of every temporary artifact.

These checks need no database or owner credentials:

```powershell
npm run council:ci:env:test
```

To reproduce the database job locally, use Docker and an isolated checkout with no `.env.local`, following the workflow's isolated configuration and cleanup. Do not replace the normal app's environment or point these suites at its database. If setup fails partway, recreate the disposable stack before retrying the full SQL script.

Passing isolated database CI does not validate hosted configuration. Each knowledge caller must use a named client key; the shared knowledge bearers are retired.

## Seat credential renewal

[`migrations/council-seat-renewal.sql`](migrations/council-seat-renewal.sql) is still in the full setup script, but the local council clean-up replaces its `renew_council_host_lease` with a body that only extends the lease, and drops its guest `issue_council_seat_key` and `resolve_council_seat_key`. Seat keys were only renewed during code campaigns, which no longer exist. Online council seats get a host-issued key bound to their run instead.
