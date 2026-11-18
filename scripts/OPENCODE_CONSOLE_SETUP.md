# OpenCode Console: paid models only

Checked on 19/11/2026 against the [inference API docs](https://opencode.ai/docs/console/api/inference/), the [Go docs](https://opencode.ai/docs/console/go/), the [model list](https://opencode.ai/console/models) and the public list at `https://opencode.ai/inference/openai/v1/models`.

OpenCode Zen is now called OpenCode Console. The app keeps the provider id `opencode-zen` so call history keeps its provider, but the label, endpoint and env var are new:

| Setting | Value |
| --- | --- |
| Base URL | `https://opencode.ai/inference/openai/v1` |
| Env var | `OPENCODE_API_KEY` (replaces `OPENCODE_ZEN_API_KEY`) |
| Billing | Metered: kept out of free worker routes, like DeepSeek |
| Built-in models | None. Discovery lists them once a key is set |

## What this app can use

- **Free models: no.** The inference docs say free chat models only work from inside OpenCode, and other clients get HTTP 403. A probe on 23/09/2026 got 403 `FreeTierError`. The parser marks every free model as not chat, so discovery never tracks them. The four old free ids (`mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `muse-spark-1.3-contributor-free`) are retired. A saved choice of one falls back to the default model and logs a warning.
- **Paid Chat Completions models: yes, with credits.** On 19/11/2026 the public list had 88 models, 11 of them free. Sixteen were paid models served over Chat Completions (DeepSeek, GLM, Kimi, MiniMax, Mistral Large and Qwen Max families). Those are the ones discovery tracks.
- **Models on other transports: not yet.** Claude models use Messages, GPT, Grok and Muse use Responses, and Gemini uses generate-content. The app only speaks Chat Completions to this provider, so the parser leaves them out.
- **Go plans: not used.** Go is for OpenCode and other coding agents, and asks other clients to send coding-agent style traffic. An assistant's chat is not that traffic.

The list's base price is what the catalogue stores. Some models also list time-of-day multipliers (for example weekday UTC hours), which the app does not read.

## Add a key

1. Buy Console credits on the OpenCode site. This is a paid service.
2. On `/admin`, open **Providers and keys**, choose **Set key** on OpenCode Console, paste the key and enter your access password. The key is checked with a one-token chat to `glm-5.3-flash` (about a millionth of a dollar at the 19/11/2026 price), encrypted, and used straight away. You can set `OPENCODE_API_KEY` in the server environment instead; a dashboard key wins over it.
3. Saving starts a catalogue check. Paid models are listed but not probed on their own.
4. On `/admin#models`, press **Test** on each Console model you want, then **Approve** it. Untested paid models stay out of every picker.

Clearing the key on the dashboard falls back to `OPENCODE_API_KEY`, or leaves the provider without a key.

## Before sending personal data

Each Console model is served by its own upstream provider. Read the Console terms and the model's entry on the model list before using it for anything personal. No user data was sent to OpenCode while preparing this change.
