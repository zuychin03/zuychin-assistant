import crypto from "crypto";

// Slack co-working surface: request-signature verification, chat.postMessage,
// and helpers to identify who authored an event. Node runtime only (uses the
// node crypto HMAC); never import from an edge route.

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;
const SLACK_API = "https://slack.com/api";

const REPLAY_WINDOW_SECONDS = 60 * 5;

// Prefer the user token when set: some agent Slack apps ignore mentions authored
// by a bot, so posting as the user makes @mentions read as human-authored.
function postToken(): string | undefined {
    return SLACK_USER_TOKEN || SLACK_BOT_TOKEN;
}

// Verifies Slack's v0 request signature: HMAC-SHA256 over `v0:{ts}:{body}` with
// a ±5-min replay window. Constant-time compare.
export function verifySlackSignature(
    rawBody: string,
    signature: string | null,
    timestamp: string | null,
): boolean {
    if (!SLACK_SIGNING_SECRET || !signature || !timestamp) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SECONDS) return false;

    const hmac = crypto
        .createHmac("sha256", SLACK_SIGNING_SECRET)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest("hex");
    const expected = Buffer.from(`v0=${hmac}`);
    const actual = Buffer.from(signature);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export interface SlackPostResult {
    ok: boolean;
    ts?: string;
    error?: string;
}

export async function sendSlackMessage(
    channel: string,
    text: string,
    opts?: { threadTs?: string },
): Promise<SlackPostResult> {
    const token = postToken();
    if (!token) {
        console.warn("[Slack] No SLACK_BOT_TOKEN/SLACK_USER_TOKEN set, cannot send.");
        return { ok: false, error: "no_token" };
    }
    try {
        const res = await fetch(`${SLACK_API}/chat.postMessage`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                channel,
                text,
                ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
            }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string; error?: string };
        if (!data.ok) {
            console.error("[Slack] chat.postMessage failed:", data.error);
            return { ok: false, error: data.error };
        }
        return { ok: true, ts: data.ts };
    } catch (err) {
        console.error("[Slack] chat.postMessage error:", err);
        return { ok: false, error: String(err) };
    }
}

// Subset of the Slack message / app_mention event shape.
export interface SlackMessageEvent {
    type: string;
    subtype?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    app_id?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
}

// One registry drives both directions. SLACK_AGENTS is a JSON array, e.g.
// [{"label":"cursor","appId":"A123","mentionId":"U456"}, ...]:
// appId/botId identify inbound events; mentionId is the Slack user id used to
// <@mention> the agent outbound. Populated once the agent apps are installed.
export interface SlackAgent {
    label: string;
    appId?: string;
    botId?: string;
    mentionId?: string;
}

let agents: SlackAgent[] | null = null;
function getAgents(): SlackAgent[] {
    if (agents) return agents;
    let parsed: SlackAgent[] = [];
    try {
        const raw = JSON.parse(process.env.SLACK_AGENTS || "[]");
        if (Array.isArray(raw)) parsed = raw.filter((a): a is SlackAgent => a && typeof a.label === "string");
    } catch {
        console.warn("[Slack] SLACK_AGENTS is not valid JSON; ignoring.");
    }
    agents = parsed;
    return parsed;
}

export function listAgents(): SlackAgent[] {
    return getAgents();
}

// Returns the agent label for an event's author, or null for humans/unknown.
// A bot user's message carries user = its bot user id, so matching on mentionId
// alone is enough — no need to also capture app_id/bot_id.
export function identifyAgent(event: SlackMessageEvent): string | null {
    const found = getAgents().find(
        (a) =>
            (a.mentionId && a.mentionId === event.user) ||
            (a.appId && a.appId === event.app_id) ||
            (a.botId && a.botId === event.bot_id),
    );
    return found?.label ?? null;
}

// Slack mention token for an agent label, falling back to a plain @label.
export function mentionFor(label: string): string {
    const agent = getAgents().find((a) => a.label === label);
    return agent?.mentionId ? `<@${agent.mentionId}>` : `@${label}`;
}

// Whether Zuychin itself authored the event; used to break echo loops.
export function isOwnMessage(event: SlackMessageEvent): boolean {
    const selfApp = process.env.SLACK_APP_ID;
    const selfBotUser = process.env.SLACK_BOT_USER_ID;
    if (selfApp && event.app_id === selfApp) return true;
    if (selfBotUser && event.user === selfBotUser) return true;
    return false;
}
