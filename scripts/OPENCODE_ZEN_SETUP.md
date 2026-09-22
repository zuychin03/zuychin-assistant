# OpenCode Zen: qualified free models

Catalogue checked on 23/09/2026 against the [public model list](https://opencode.ai/zen/v1/models) and [Zen documentation](https://opencode.ai/docs/en/zen/).

| Model | API ID | Selection rationale |
| --- | --- | --- |
| MiMo V2.6 Flash | `mimo-v2.6-flash-free` | Fast multimodal coding, reasoning and tool use |
| Nemotron 3 Ultra | `nemotron-3-ultra-free` | Large text reasoning and agent model |
| Nemotron 3.5 Lightning | `nemotron-3.5-lightning-free` | Fast text reasoning and tool use |
| Muse Spark 1.3 Contributor | `muse-spark-1.3-contributor-free` | Multimodal reasoning; separate Responses protocol and training-data terms |

MiMo and Nemotron use `https://opencode.ai/zen/v1/chat/completions`. Muse Spark Contributor uses `https://opencode.ai/zen/v1/responses`, which the app does not yet implement. Its catalogue entry explicitly marks that protocol, and the chat adapter rejects it before sending a request. The app registers no paid Zen models or embedding models. Model selection is based on the published catalogue and the assistant's frontier/fast preference, not a new performance benchmark. Provider-specific context metadata comes from [models.dev](https://models.dev/api.json): 200K for MiMo, 1M for Ultra and Muse, and 256K for Lightning. Muse's published output ceiling is 128K; strict schema support remains unverified.

MiMo V2.5 is superseded by V2.6 Flash. Big Pickle has insufficient public model identity and capability evidence for this shortlist. Ling Flash Fin specialises in finance. Jev uses a typed-decision API rather than conversational completions. Muse Spark 1.3 supersedes the older 1.2 Contributor listing. The standard `muse-spark-1.3` is paid and is not registered or aliased to the free variant. The older DeepSeek free ID remains in the public catalogue but failed the prior endpoint audit; it has not been reinstated.

## Add the key later

Set `OPENCODE_ZEN_API_KEY` in the server environment, or in `.env.local` for local development. Restart the local server or redeploy after changing the environment. Do not put the key in source code or client configuration.

The provider remains unavailable even with a key: the [endpoint audit](MODEL_AUDIT_2026_09.md) received HTTP 403 `FreeTierError` for MiMo V2.6 Flash and Nemotron 3.5 Lightning outside OpenCode. Access to the newly added Ultra and Muse variants remains unverified. A listed model or new key does not establish third-party access. The dashboard shows that restriction, and the chat picker and automatic workers exclude Zen until access is verified.

After a new key is supplied, test each exact free ID with synthetic text and a harmless tool call. Activate only endpoints that succeed for this application through the documented API. Confirm vision separately for MiMo; retain the conservative output limit and disabled strict structured output until validated. Muse additionally needs a Responses adapter with streaming and tool-continuation tests before it can be enabled. Do not impersonate the OpenCode client, substitute paid IDs or remove the restriction merely because the key exists.

Zen's free availability is time-limited. Its [privacy terms](https://opencode.ai/docs/en/zen/#privacy) also differ by model: Muse Spark Contributor grants permission for prompts and completions to train future Meta models, MiMo inputs may support model improvement, and NVIDIA trial endpoints exclude personal or confidential submissions. No user data was sent to Zen during this catalogue update. Muse remains unavailable, including when a Zen key is configured.
