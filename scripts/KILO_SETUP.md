# Kilo: qualified free models

Checked on 23/09/2026 against the [gateway catalogue](https://api.kilo.ai/api/gateway/models), [free model page](https://kilo.ai/landing/free-models) and authenticated synthetic requests using the configured key.

The app uses `KILO_API_KEY` with `https://api.kilo.ai/api/gateway/chat/completions`. Set it in the server environment or `.env.local`, then restart or redeploy. The key stays server-side. The provider needs no additional client headers or paid fallback configuration. Existing chat, messaging and embedding defaults are unchanged.

## Enabled endpoints

| Model | Exact free ID | Verified behaviour | Published context / output |
| --- | --- | --- | --- |
| Nemotron 3 Ultra | `nvidia/nemotron-3-ultra-550b-a55b:free` | Streamed text and forced tool call | 1,000,000 / 65,536 |
| Nemotron 3.5 Lightning | `nvidia/nemotron-3.5-lightning:free` | Streamed text and automatic tool call; forced search disabled | 1,000,000 / 65,536 |
| Ling 3.0 Flash VL | `inclusionai/ling-3.0-flash-vl:free` | Streamed text, forced tool call, image input and reasoning | 262,144 / 32,768 |
| Step 3.7 Flash | `stepfun/step-3.7-flash:free` | Streamed text, forced tool call, image input and reasoning | 262,144 / 262,144 |
| Laguna S 2.1 | `poolside/laguna-s-2.1:free` | Streamed text and forced tool call | 262,144 / 32,768 |

Kilo lists zero input/output pricing for all five. Explicit free IDs are used throughout. Dynamic `kilo-auto/free`, paid variants and the Nex promotion expiring on 25/09/2026 are excluded. Fast, available tool models can join the existing free worker fallback chain, after the preferred models.

The probes used a fixed test reply, a harmless `report_status` function, a generated red square and basic arithmetic. No saved knowledge, conversations or private files were submitted. All five produced completed SSE answers and valid tool arguments. Lightning required automatic tool choice: three forced-call attempts timed out at 45 seconds, while the automatic call completed in about 23 seconds. Its ordinary tools remain enabled, but the forced web-search toggle is disabled. Laguna returned one HTTP 429 before a successful retry. These are access and protocol checks, not performance benchmarks or reliability guarantees. Published maximum token limits were not exhaustion-tested. Strict structured output remains disabled.

Thinking is explicitly enabled or disabled through Kilo's `reasoning` object. Image support is enabled only for Ling and Step, both of which identified the synthetic image correctly. The app's adapter accepts image inputs here; it does not send video attachments to these routes.

## Excluded endpoints

| Advertised model | Exact free ID | Result |
| --- | --- | --- |
| [MiniMax M3](https://kilo.ai/models/minimax-minimax-m3-free) | `minimax/minimax-m3:free` | HTTP 404 for text and tool requests |
| [Hy3](https://kilo.ai/models/tencent-hy3-free) | `tencent/hy3:free` | HTTP 404 for text and tool requests |
| [Ring-2.6-1T](https://kilo.ai/models/inclusionai-ring-2-6-1t-free) | `inclusionai/ring-2.6-1t:free` | HTTP 404 for text and tool requests |

Kilo advertises these exact IDs at zero input/output cost, but omits them from its gateway catalogue. Its authenticated gateway reported that the requested model does not exist. They have been removed from the app's registry and metadata, including the dashboard's unavailable-model list. Paid IDs never substitute for them. Recheck free pricing and successful endpoint access before adding them again.

## Limits and data terms

Kilo documents a shared 200 free requests per hour per IP, including authenticated requests. Upstream capacity can impose additional limits. See [usage and billing](https://kilo.ai/docs/gateway/usage-and-billing).

The free catalogue marks these routes as potentially using prompts for training. NVIDIA trial routes also restrict personal and confidential submissions. See [Kilo's provider terms](https://kilo.ai/docs/gateway/models-and-providers). Connecting the key does not change those terms.

Local regression commands:

```powershell
npx tsx scripts/test-provider-registry.mts
npx tsx scripts/test-kilo-adapter.mts
npx tsx scripts/test-model-picker.mts
npx tsc --noEmit --incremental false
npm run lint -- --ignore-pattern '.impeccable/review/**'
```

The adapter regressions use fake fetch responses and dummy keys. They exercise request routing, reasoning toggles, streamed tool fragments, output limits and rejection of unavailable or incompatible models without contacting external services.
