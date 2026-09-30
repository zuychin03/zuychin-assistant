# Council adapter compatibility

Checked on 30/09/2026 with host ACP SDK `1.3.0` and protocol version `1`.
The manifest pins the tested direct dependencies; `npm ci` preserves their locked dependencies.
These are compatibility observations, not a claim that every vendor tool is contained by the host.

| Adapter | Version | Model evidence | Explicit selection |
|---|---|---|---|
| `@agentclientprotocol/codex-acp` | `2.0.0` | Stable `configOptions` | Model and reasoning selections require matching returned configuration |
| `@zed-industries/claude-code-acp` | `0.16.2` | Legacy `models.currentModelId`, preserved verbatim | `session/set_model` acknowledgement, labelled separately from independent readback |

No-override launches record the adapter's reported default and its source. An alias such as
`default` is not expanded into a guessed provider model. Missing model/version metadata remains
unknown. ACP adapter version comes from `initialize.agentInfo.version`, not the configured label.

Explicit selections must be allowed by the Council instance and advertised by the adapter.
The host applies the model first, refreshes the reasoning options, then checks the final returned
configuration before recording an execution or sending a prompt. Missing or conflicting
confirmation fails the launch. For legacy adapters, successful `session/set_model` acknowledgement
records the literal requested identifier with `adapter_legacy_set_model` provenance. It does not
claim an independent readback or resolve a provider alias. Legacy model changes combined with
explicit reasoning are rejected when refreshed reasoning configuration is unavailable.
The probe's generated block omits unsupported defaults/allowlists.

## Reproduce the checks

From a checkout with dependencies installed and local adapter configuration:

```sh
npm run council:probe:test
npm run council:v3:test
npx tsx scripts/council-acp-probe.mts --models --agent codex
npx tsx scripts/council-acp-probe.mts --models --agent claude-code
npx tsx scripts/council-acp-probe.mts --set-model <advertised-id> --set-reasoning <advertised-effort> --agent codex
```

The selection flags imply model listing, without enabling a prompt or supplying an MCP server.
They affect only the temporary probe session. Omit `--set-reasoning` when it is not advertised.
`--prompt` and `--edit` are separate opt-ins that can spend vendor tokens; MCP checks require an
explicit endpoint and the dedicated probe key. See the README for that setup.

## Evidence and limits

Installed-adapter checks covered handshake, metadata discovery and explicit session selection
without prompts or MCP servers. Codex returned matching model/reasoning configuration; Claude
acknowledged an advertised legacy model identifier. Neither check changed vendor configuration.
Synthetic adapter/host tests cover default provenance, model and reasoning confirmation, changed
reasoning options, malformed responses and rejection before kickoff. They do not prove a vendor's
inference model or persistence after reconnect. Configured live selection and reconnect acceptance
remain separate checks. Synthetic success does not prove a complete hosted Council execution.

Reconnect restores the saved per-seat choices, including an intentional adapter default, and
revalidates them against the current adapter and local allowlist. A previously dispatched seat
with a missing or mismatched selection journal is refused. Startup is bounded, and dispatch
waits for negotiation, execution recording and seat join to succeed.

Host path checks apply to ACP client filesystem/terminal requests and supported permission
locations. Adapters that perform their own file or shell operations can bypass these checks.
Configured capability flags are claims to verify with the edit probe, not an operating-system
sandbox. Recheck mediation and permission behaviour before changing an adapter or its version.
