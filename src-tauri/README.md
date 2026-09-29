# Council desktop shell

This Windows-first Tauri 2 shell opens the deployed Next.js app and supervises the existing Node Council host. It implements V4.1b lifecycle control, not the V4 Council protocol. Next.js still runs on the server; no service-role credential or local Next server is bundled.

## Set up this computer

Install Node.js 24, Rust with the MSVC target, Visual Studio C++ tools, the Windows SDK and WebView2. Run `npm install` in this checkout. If Cargo cannot find the linker, use Visual Studio Developer PowerShell.

Prepare `scripts/council-agents.json` using the existing example. Add the deployed app's exact origin to `host.origins`. Keep the dedicated `MCP_COUNCIL_HOST_KEY` in the local env file, then run:

```powershell
npm run council:desktop:setup -- --app-url https://your-app.example
npm run council:desktop:build
```

Setup writes owner configuration to the platform app configuration directory (`%APPDATA%\com.zuychin.council` on Windows). It copies only the host credential into `host.local.env`. Provider credentials should use the existing local adapter configuration or vendor login. The executable is `src-tauri/target/release/zuychin-council-desktop.exe`; the configured Node runtime, checkout and npm dependencies must remain installed.

`--workspace <name>` selects a workspace already listed in `host.repos`. Setup defaults auto-adoption off. The owner can edit the strict V1 `launch` object in `desktop.json` to change those defaults. Moving the checkout or changing the host credential requires rerunning setup. `desktop.example.json` documents the configuration shape; never commit actual machine paths or credentials.

For development, `npm run council:desktop:setup -- --local --app-url http://localhost:3000` writes ignored configuration in this directory, then `npm run council:desktop:dev` opens that origin. Start the Next dev server separately. Other local ports must appear in `host.origins`. HTTP loopback origins work only in debug builds. `ZUYCHIN_DESKTOP_CONFIG` selects an alternative owner configuration for isolated tests.

## Use and recovery

Use **Host > Start host**, **Stop host** and **Restart host** in the native menu. The title and disabled menu status report lifecycle or a safe error. The updated `/council` page also offers these controls when loaded inside Tauri; that panel reaches the deployed app only after the web changes are deployed.

Stop and restart require fresh idle health. Closing the app stops its owned host, including active work, then terminates remaining owned processes after a deadline. The window stays open if termination cannot be confirmed. An unexpected death, missing exit report or forced termination is never presented as a clean stop. Windows Job Objects contain descendants before Node resumes and remove them if the desktop process dies.

On Windows, ownership is released only after the parent exits and the owned job reports zero active processes. A forced descendant cleanup blocks automatic restart. If job accounting fails or cleanup exceeds its deadline, ownership remains held and the window reports the failure.

A separately launched terminal host is never taken over or stopped by the native supervisor. Its existing singleton lock prevents a second host from starting. Stop that host from its terminal first when deliberately switching to desktop ownership.

Pairing is still the existing web flow. Pair once using the code printed by a manual host launched against the same repository, stop it, then start the desktop host. The host reuses that repository's pairing identity. A Tauri webview has its own browser storage, so an existing browser pairing does not automatically carry over. Native status deliberately omits credentials and raw output. The terminal launcher remains the recovery path:

```powershell
npx tsx --env-file=.env.local scripts/council-host.mts --repo C:/projects/your-repo
```

## Security boundary

The webview can invoke four argument-free lifecycle/status commands. Canonical executable, entry point, configuration, working directory and environment come from the owner's local configuration. App commands are explicitly declared in the build manifest and granted only to the main window at the configured origin. Navigation to other origins, extra windows and downloads are denied. No filesystem, shell, generic HTTP or process-ID command is exposed.

Council control still uses the existing paired loopback HTTP/WebSocket client. Rust reads only V1 launch, stop, health, log and exit messages. Status logs use fixed descriptions; raw stdout log text and stderr never reach the page.

## Verification

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
$env:COUNCIL_TEST_NODE = (Get-Command node).Source
cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored
cargo build --manifest-path src-tauri/Cargo.toml
npx tsx scripts/test-council-desktop.mts
npx tsc --noEmit
npm run lint
npm run council:supervisor:test
```

The native smoke uses an isolated home, Git workspace, host configuration, fake credential and loopback fixture. It exercises actual webview IPC, permission denial, the existing paired HTTP/WebSocket path, restart, clean stop and repeated window-close cleanup. It makes no hosted database calls and leaves any existing host alone. The ignored Rust process tests require an explicit Node path and exercise deadlines, busy refusal, queue saturation, unreported death and descendant cleanup, including abrupt supervisor exit, with fake hosts.

## Before distribution

This is a private unsigned build, with no updater or installer enabled. Before broader distribution:

1. Decide whether to bundle a pinned Node runtime and host/adapters or require an installed checkout. Record licences and runtime checksums.
2. Provision host credentials locally, with owner-only file permissions and a rotation flow. Never embed credentials in installers or update metadata.
3. Sign Windows executables and installers using an owner-controlled certificate. Keep signing credentials out of source and separate signing from untrusted pull-request jobs.
4. Introduce an authenticated release pipeline and signed Tauri update artefacts. Pin updater public keys, verify rollback/recovery behaviour and keep updates disabled until tested.
5. Verify the deployed HTTPS origin, sign-in, pairing and loopback access on the release WebView2 runtime. Complete rendered desktop/accessibility QA and test installer upgrade/uninstall on a clean machine.
