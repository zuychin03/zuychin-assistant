# Security policy

## Supported versions

Security fixes go into `main`. There are no separate releases.

## Reporting a vulnerability

Please report vulnerabilities privately. Don't open a public issue, discussion or pull request.

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include what's affected, the steps to reproduce it, the impact you expect, and the commit you tested.

This is a small project maintained in spare time, so a reply may take a few days. You'll hear back once the report has been looked at, and again when a fix is ready. Please keep the details private until then.

## Scope

In scope:

- Sign-in and sessions: passkeys, the password and TOTP recovery path, session cookies and the auth proxy.
- Any API route that works without a valid session, cron routes without `CRON_SECRET`, and the chat API without `CHAT_API_KEY`.
- The shared MCP server and per-agent credentials: claims, key exchange, access levels and revocation.
- Any table or database function the anon key can reach.
- A scheduled task changing something without approval, including email, web or vault content steering it into an action it should have asked about.
- The Council host: escaping a seat's worktree, the loopback pairing and control channel, and the Windows desktop supervisor.
- The Telegram and GitHub vault webhooks accepting forged requests.

Out of scope:

- Problems in model providers, Supabase, Google, Discord, Telegram or npm packages, unless this code uses them unsafely.
- What a Council agent can do with its own vendor login. Environment filtering isn't an operating-system sandbox, as the README says.
- A model giving a wrong or odd answer. That's a bug, so please open an issue.
- Findings that need an already compromised computer, server or account.

## Keeping your deployment safe

- Use long random values for `AUTH_SESSION_SECRET`, `CRON_SECRET`, `CHAT_API_KEY`, `TELEGRAM_WEBHOOK_SECRET` and `GITHUB_VAULT_WEBHOOK_SECRET`.
- Keep `SUPABASE_SERVICE_ROLE_KEY` and every provider key on the server. On a project created before every table was server-only, run `scripts/migrations/server-only-tables.sql`.
- Set `AUTH_RP_ID` and `AUTH_ORIGIN` to your exact domain before enrolling a passkey.
- Keep the vault repository private.
