# Model registry audit, 23/09/2026

This is a sanitised record of the model refresh. It separates provider catalogue entries,
successful endpoint calls, capability checks and retired endpoints. Small synthetic probes
were used; no keys, request identifiers, private prompts, document contents or account
identifiers are included here.

Local evidence is retained in the ignored `docs/model-audit-live.json`,
`docs/model-candidate-probes.json`, `docs/model-capability-probes.json` and
`docs/model-final-probes.json`, `docs/model-stream-probes.json` and
`docs/model-force-stream-probes.json`. Those files are working evidence, not public
repository dependencies. Statuses below describe these probes, not future availability or a service SLA.

## Registry and live evidence

An HTTP 200 establishes only the result described in the last column. A successful chat is
not a successful tool call, and a timeout is inconclusive rather than proof of retirement.
The runtime registry remains the authority for configured capabilities and output limits.

| Provider | Exact chat model ID | Registry decision | Observed evidence |
| --- | --- | --- | --- |
| Gemini | `gemini-3.8-flash` | Added; replaces older Flash aliases | Chat 200 with response |
| Gemini | `gemini-3.5-flash-lite` | Retained; default web chat | Chat 200 with response |
| Gemini free key | `gemini-3.8-flash` | Added | 503 high demand; transient, no successful response in this probe set |
| Gemini free key | `gemini-3.5-flash-lite` | Retained | Initial 503; later chat 200 with response |
| OpenRouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | Retained | Chat 200 with response |
| OpenRouter | `poolside/laguna-s-2.1:free` | Retained | Initial 429 upstream rate limit; later chat 200 |
| OpenRouter | `google/gemma-4-31b-it:free` | Retained | Chat 200 with response |
| OpenRouter | `google/gemma-4-26b-a4b-it` | Retained; metered, excluded from free workers | Chat 200 with response |
| OpenRouter | `nvidia/nemotron-3.5-lightning:free` | Added | Tool probe timed out at 60 seconds; streaming returned HTTP 200 but no answer, tool call or completion before a 120-second timeout; inconclusive |
| NVIDIA NIM | `moonshotai/kimi-k3` | Added | Chat timed out at 60 seconds; tool, streaming and vision probes timed out at 120 seconds; inconclusive |
| NVIDIA NIM | `z-ai/glm-5.3` | Added | Chat timed out at 60 seconds; tool and streaming probes timed out at 120 seconds; inconclusive |
| NVIDIA NIM | `z-ai/glm-5.3-flash` | Added | Chat 200; named tool call 200; synthetic image question answered correctly |
| NVIDIA NIM | `deepseek-ai/deepseek-v4.1-flash` | Added; automatic tools enabled, explicit Search disabled | Chat 200; synthetic image question answered correctly. Automatic streamed tool selection returned a named call and completed. Forced tool selection returned plain JSON in both non-streaming and streamed probes |
| NVIDIA NIM | `nvidia/nemotron-3.5-lightning-30b-a3b` | Added | Chat 200; initial tool timeout at 60 seconds, then named tool call 200 after about 106 seconds |
| NVIDIA NIM | `nvidia/nemotron-3-ultra-550b-a55b` | Retained | Chat 200 with response |
| NVIDIA NIM | `google/gemma-4-31b-it` | Retained | Chat probes timed out at 60 seconds and streaming at 120 seconds; inconclusive |
| NVIDIA NIM | `google/diffusiongemma-26b-a4b-it` | Retained; no tools | Chat 200 with response |
| NVIDIA NIM | `poolside/laguna-xs-2.1` | Retained | Initial timeout; later chat 200 with response |
| DeepSeek direct | `deepseek-flash` | Canonical Flash ID; labelled V4.1 Flash | Chat 200; streamed probe returned a named tool call with arguments and completed |
| DeepSeek direct | `deepseek-v4-pro` | Retained; metered | Chat 200 with response |
| OpenCode Zen | `mimo-v2.6-flash-free` | Retained configuration, provider unavailable | 403 `FreeTierError`: free access restricted to OpenCode |
| OpenCode Zen | `nemotron-3.5-lightning-free` | Retained configuration, provider unavailable | 403 `FreeTierError`: free access restricted to OpenCode |
| TokenRouter | `moonshotai/kimi-k3-free` | Retained configuration, provider unavailable for the audited key | 503: no available channel for the configured group |

The new Gemini ID and its 65,536-token output limit are published in the
[Gemini 3.8 Flash documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
New NIM entries were checked against the [NVIDIA catalogue](https://integrate.api.nvidia.com/v1/models)
and their official references: [Kimi K3](https://build.nvidia.com/moonshotai/kimi-k3/modelcard),
[GLM-5.3](https://docs.api.nvidia.com/nim/reference/z-ai-glm-5-3),
[GLM-5.3 Flash](https://docs.api.nvidia.com/nim/reference/z-ai-glm-5-3-flash) and
[Nemotron 3.5 Lightning](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard).
Catalogue presence does not resolve the timeouts above. OpenRouter entries were checked
against its [model catalogue](https://openrouter.ai/api/v1/models).

| Embedding provider | Exact model ID | Decision and evidence |
| --- | --- | --- |
| NVIDIA NIM | `nvidia/nemotron-3-embed-1b` | New default; repeated 200 responses with 2048-dimensional vectors |
| Gemini | `gemini-embedding-2` | Stable alternative; 200 with the application's requested 768 dimensions |

The dimensions and endpoint contract are documented by
[NVIDIA](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-embed-1b-infer)
and its [model card](https://build.nvidia.com/nvidia/nemotron-3-embed-1b/modelcard).
[Gemini Embedding 2](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2)
supports several dimensions; this application registers 768. Vectors from different models
remain incompatible even when their dimensions match.

## Confirmed retirement versus other failures

NVIDIA returned an explicit end-of-life response with HTTP 410 for each of these endpoints:

| Removed NIM ID | Provider-reported retirement date | Replacement or action |
| --- | --- | --- |
| `minimaxai/minimax-m3` | 09/09/2026 | Chat alias to `moonshotai/kimi-k3` |
| `deepseek-ai/deepseek-v4-pro` | 07/08/2026 | Chat alias to `z-ai/glm-5.3` |
| `deepseek-ai/deepseek-v4-flash` | 07/08/2026 | Chat alias to `deepseek-ai/deepseek-v4.1-flash` |
| `stepfun-ai/step-3.7-flash` | 28/08/2026 | Chat alias to `z-ai/glm-5.3-flash` |
| `z-ai/glm-5.2` | 21/08/2026 | Chat alias to `z-ai/glm-5.3` |
| `openai/gpt-oss-120b` | 03/09/2026 | Chat alias to `nvidia/nemotron-3-ultra-550b-a55b` |
| `nvidia/llama-nemotron-embed-1b-v2` | 25/08/2026 | Removed; vectors require migration to a supported embedding model |

Other outcomes must not be labelled retirement:

- `nvidia/llama-embed-nemotron-8b` returned 404 twice. It was removed as an unavailable
  embedding endpoint; these probes did not establish an end-of-life date.
- `gemini-3.7-flash` remained reachable on the primary key. Its replacement by 3.8 is a
  registry refresh, not a claim that 3.7 retired. `gemini-embedding-2-preview` also returned
  200; the registry now uses the stable embedding ID.
- OpenCode's old `deepseek-v4-flash-free`, `laguna-s-2.1-free` and `ling-3.0-flash-free`
  returned upstream-unavailable errors. New free candidates, including MiMo V2.6 Flash,
  Nemotron Ultra, Nemotron Lightning and Ling 3.0 Flash Fin, returned the explicit 403
  restriction. The app records an unavailable reason and does not bypass it. The
  [Zen documentation](https://opencode.ai/docs/zen/) describes the provider; the restriction
  above is direct endpoint evidence for this integration.
- TokenRouter's Kimi endpoint had no usable channel. The alternative
  `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` returned 403 for the configured token.
  This establishes this key's access limitation, not global unavailability of the model.
- Direct DeepSeek accepted `deepseek-flash` and `deepseek-v4-pro`; `deepseek-pro` returned
  400 with those supported IDs. Existing Flash aliases resolve to `deepseek-flash`.
  See the [direct API model reference](https://api-docs.deepseek.com/quick_start/pricing/).
- The initial TTS request returned 400 because its request configuration was incomplete.
  With the voice configuration supplied, `gemini-3.1-flash-tts-preview` and
  `gemini-3.8-flash-tts` both returned audio. The configured preview TTS model is unchanged.

## Defaults and capability limits

- Web chat defaults to Gemini 3.5 Flash-Lite. Gemini 3.8 Flash is available explicitly and
  is the complex-worker fallback.
- Messaging defaults try NIM GLM-5.3 Flash, NIM Nemotron 3 Ultra, then Gemini 3.8 Flash,
  subject to configured provider availability.
- The preferred free worker chain uses NIM GLM-5.3 Flash, NIM DeepSeek V4.1 Flash,
  NIM Nemotron 3.5 Lightning, then OpenRouter Nemotron 3.5 Lightning, followed by eligible Fast-tagged models.
  DiffusionGemma is tried first for subtasks that do not need tools. Direct DeepSeek,
  metered OpenRouter models and explicitly unavailable providers are excluded.
- New endpoints without a verified output ceiling use the conservative 8,192-token
  fallback. Registry capability flags may come from provider documentation; only the
  specific live behaviours in the matrix were exercised.
- OpenCode Zen and TokenRouter keep explicit unavailable reasons. They are hidden from
  selectable models and skipped by automatic workers even when their key is present.
- NIM DeepSeek's automatic tool-call emission is supported by the streamed probe; forcing
  a named tool did not emit a tool call. Its Search toggle remains disabled for that reason.

## Embedding migration boundary

The browser migration selects up to 20 pending records per request, uses counts between
batches, and audits all vectors before activation. Provider calls and database operations
share a 40-second deadline. The CLI stages all replacement vectors before its write phase.

The default model change is not itself a data migration. The CLI requires `--model <id>`
and is read-only without `--apply`; use `tsx --tsconfig tsconfig.json` for the project's
import aliases. It covers `embeddings`, `memories`, `vault_pages`,
`knowledge_chunks` and `knowledge_assertions`, validates vectors before writes, detects
source changes and activates the target only after a fresh complete scan. The
[README migration instructions](../README.md#migrating-knowledge-embeddings) contain the
plan and apply commands.

The admin migration endpoint now uses the same five-table planning, conditional-update and
verification code. It prepares up to 20 rows per request with concurrency four, reports
unavailable status as 503 and changed/unsaved rows as a retryable 409, and activates only
after complete verification. This is source-verified behaviour, not a hosted migration result.

At this audit snapshot, endpoint validation and migration implementation are separate from
hosted-store completion. No completed hosted migration or all-green provider claim is
established by this report. Remaining timeout and tool-execution uncertainties are listed
explicitly above. No deployment or UI recommendation is part of this model refresh.
