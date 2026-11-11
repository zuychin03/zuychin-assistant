# Contributing to Zuychin Assistant

Thanks for helping. Zuychin Assistant is a personal assistant built for one owner and maintained by one person, so forking it for your own setup is as welcome as a pull request. Small, focused pull requests get reviewed fastest. For anything large, open an issue first so we can agree on the approach before you build it.

## What the Assistant holds to

- **Free to run.** Every default works on free tiers. Metered models stay out of the free worker pool, Free only covers what actually runs as well as the model picker, and no paid service becomes a requirement.
- **Server-only data.** The app reaches Supabase with the service role, and the anon key reaches nothing. Setup revokes `anon` and `authenticated` from every table it creates and adds no policy that reaches them. `scripts/test-server-only-tables.mts` checks this.
- **Unattended work asks first.** A scheduled task may read freely, but any tool that changes something waits for the owner's approval, and an unknown tool is refused (`src/lib/tasks/unattended-policy.ts`). Agent-written skills stay drafts until they're approved.
- **No personal details in the repository.** No names, email addresses or real domains in source, prompts, docs or tests. Write "the owner" and use placeholders such as `your-app.example.com`.
- **The Council host is not a sandbox.** Worktree containment and environment filtering are guardrails, not isolation. Open an issue before widening what an agent can reach.

## Set up and run the checks

Use Node 20 or later (CI runs Node 24) and npm. The [Quick Start](README.md#quick-start) covers `.env.local`, the database and the optional integrations.

```bash
npm ci
npm run lint
npm run typecheck
```

Then run the suites for the area you changed. These need no credentials or network:

| Area | Command |
| --- | --- |
| Chat, models, Library, Research, Study, Capture and Tasks | `npm run v6:test` |
| Knowledge Cosmos | `npm run cosmos:test` |
| Council host, protocol and contracts | `npm run council:v3:test`, `npm run council:contracts:test`, `npm run council:services:test` |
| Agent credentials | `npm run agents:offline:test` |
| Windows desktop supervisor (needs Rust) | `npm run council:desktop:test` |
| One suite | `npx tsx scripts/test-<name>.mts` |

The scripts that read `.env.local` (`agents:test`, `journal:test`, `council:protocol:test`, `council:v3:test:db` and `council:schema:check`) connect to a real database, and some insert, change and delete rows. Run them only against a disposable local Supabase, as [the CI setup](scripts/council-ci-setup.md) does, never against a project with real data.

CI runs lint, types and the offline suites on Ubuntu and Windows, the V6 suites, `cargo fmt`, `clippy` and the tests for the desktop supervisor, and the database suites against an isolated Supabase.

## Where things live

The [project structure](README.md#project-structure) in the README maps the main files. In short, `src/app` holds the pages and API routes, `src/lib` the server logic, `src/components` the shared shell, `scripts/` the Council host, migrations and test suites, `src-tauri/` the Windows desktop supervisor, and `discord-bot/` the Discord bot.

## Database changes

- `supabase-setup.sql` is the whole schema, and it must stay safe to run more than once.
- If existing projects need a separate migration, add it under `scripts/migrations/` and make sure setup ends in the same state.

## Interface changes

- Follow [DESIGN.md](DESIGN.md), the Atlas design system. Its tokens live in `src/app/globals.css`. The Knowledge Cosmos stays dark-only and follows [its own design record](scripts/COSMOS_DESIGN.md).
- Check light and dark themes at phone and desktop widths. Touch targets on touch screens are at least 44px.

## Pull requests

- Keep each pull request to one change, with tests for new behaviour and for the bug you fixed.
- Say what changed, why, and how you checked it. For interface changes, add screenshots in both themes at phone and desktop widths.
- Describe user-visible changes in the pull request, so they can go into the release notes.
- Never commit `.env.local`, keys, tokens, vault pages or real conversations.

## Licence

Zuychin Assistant is licensed under [MIT](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
