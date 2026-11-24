import assert from "node:assert/strict";

// V8 F13: each mask pattern and Luhn, the names list, placeholders split across stream deltas and Gemini chunks,
// tool arguments restored before a tool runs, and paid or non-training routes left untouched. Offline.

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://mask-fixture.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "mask-fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "mask-fixture-service",
    GEMINI_API_KEY: "mask-fixture-gemini",
    OPENROUTER_API_KEY: "mask-fixture-openrouter",
    DEEPSEEK_API_KEY: "mask-fixture-deepseek",
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected fetch; this suite is offline."); };

const { cleanMaskNames, luhn, Masker, MASK_NOTE, maskChatMessages, readMaskPrefs, streamRestorer } = await import("../src/lib/ai/privacy/mask");
const { maskerFor, rememberMaskPrefs, routeMayTrain } = await import("../src/lib/ai/privacy/policy");
const { maskGeminiClient } = await import("../src/lib/ai/privacy/gemini");
const { generateGeminiChat } = await import("../src/lib/ai/gemini-chat");
const { openaiCompatChat } = await import("../src/lib/ai/openai-compat");
const { getProvider, resolveEmbedding } = await import("../src/lib/ai/providers");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type ObservedGeminiClient = import("../src/lib/ai/model-observations").ObservedGeminiClient;
type GenerateContentResponse = import("@google/genai").GenerateContentResponse;
type GenerateContentParameters = import("@google/genai").GenerateContentParameters;

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const chatRow = (providerId: string, modelId: string, extra: Partial<CatalogueRow>): CatalogueRow => ({ providerId, modelId, label: modelId, shortName: modelId, kind: "chat", origin: "listed", free: false, mayTrain: null, approvedAt: null, probeStatus: null, traits: {}, ...extra }) as CatalogueRow;
setCatalogueSnapshotForTests([
    chatRow("kilo", "kilo/free-trainer", { free: true, mayTrain: true }),
    chatRow("kilo", "kilo/free-private", { free: true, mayTrain: false }),
    chatRow("openrouter", "vendor/model:free", { free: true }),
    chatRow("openrouter", "vendor/model", { free: false }),
]);
rememberMaskPrefs({ enabled: true, names: ["Lena Tran", "Lena", "May", "Nguyễn Văn An", "Australia/Melbourne"] });

await check("emails, phones, addresses and card numbers are masked, and everyday numbers are not", () => {
    const masker = new Masker();
    const text = [
        "Email lena.tran+work@uni.example.edu.au or call 0412 345 678, (03) 9123 4567, +61 412 345 678 or +44 20 7946 0958.",
        "Post it to Unit 3, 45 King Street or 3/12 George Rd. and pay with 4111 1111 1111 1111.",
        "Not these: 1234 5678 9012 3456, 2026-11-25, 25/11/2026 at 15:30, 0.71 to 0.83, 400 ms, recall@8, room B204, 1300 655 506.",
    ].join("\n");
    const masked = masker.mask(text);
    assert.equal(masked, [
        "Email [EMAIL_1] or call [PHONE_1], [PHONE_2], [PHONE_3] or [PHONE_4].",
        "Post it to [ADDRESS_1] or [ADDRESS_2] and pay with [CARD_1].",
        "Not these: 1234 5678 9012 3456, 2026-11-25, 25/11/2026 at 15:30, 0.71 to 0.83, 400 ms, recall@8, room B204, 1300 655 506.",
    ].join("\n"));
    assert.equal(masker.unmask(masked), text, "every placeholder restores its exact original");
    assert.deepEqual(masker.kinds(), { EMAIL: 1, PHONE: 4, ADDRESS: 2, CARD: 1 });
    assert.ok(luhn("4111111111111111") && !luhn("1234567890123456") && !luhn("411111111111"));
});

await check("the same detail keeps its placeholder, and masking a longer history again numbers it the same", () => {
    const first = ["Ask Lena at lena@example.com.", "LENA@example.com again, and call 0412345678 or 0412 345 678."];
    const one = new Masker(["Lena"]);
    const maskedOne = first.map((text) => one.mask(text));
    assert.deepEqual(maskedOne, ["Ask [PERSON_1] at [EMAIL_1].", "[EMAIL_1] again, and call [PHONE_1] or [PHONE_1]."]);
    const two = new Masker(["Lena"]);
    const maskedTwo = [...first, "Then email sam@example.com."].map((text) => two.mask(text));
    assert.deepEqual(maskedTwo.slice(0, 2), maskedOne);
    assert.equal(maskedTwo[2], "Then email [EMAIL_2].");
    assert.equal(two.unmask("Unknown [EMAIL_9] stays."), "Unknown [EMAIL_9] stays.");
});

await check("names mask when they start with a capital, longest first, and the saved list is cleaned", () => {
    const masker = new Masker(["Lena", "Lena Tran", "May", "Nguyễn Văn An"]);
    assert.equal(masker.mask("Lena Tran met Lena and NGUYỄN VĂN AN in May. You may ask lena later; Lenas and Malena are other words."),
        "[PERSON_1] met [PERSON_2] and [PERSON_3] in [PERSON_4]. You may ask lena later; Lenas and Malena are other words.");
    assert.deepEqual(cleanMaskNames([" Lena  Tran ", "lena tran", "A", "x".repeat(61), 7, "May"]), ["Lena Tran", "May"]);
    assert.deepEqual(readMaskPrefs(null), { enabled: true, names: [] }, "no saved choice reads as on");
    assert.deepEqual(readMaskPrefs({ masking: { enabled: false, names: ["Lena", "lena"] } }), { enabled: false, names: ["Lena"] });
});

await check("a placeholder split across stream deltas is held until it closes", () => {
    const masker = new Masker(["Lena"]);
    masker.mask("lena@example.com, 0412 345 678, Lena");
    const out: string[] = [];
    const restorer = streamRestorer(masker, (text) => out.push(text));
    for (const delta of ["Write to [EMA", "IL_1] or call [", "PHONE", "_1", "]. See [the notes](x) and [PERS"]) restorer.push(delta);
    restorer.push("ON_1]");
    restorer.flush();
    assert.equal(out.join(""), "Write to lena@example.com or call 0412 345 678. See [the notes](x) and Lena");
    assert.ok(out.every((piece) => !/\[[A-Z]+_?\d*$|^[A-Z_\d]*\]/.test(piece)), `no fragment reaches the screen: ${JSON.stringify(out)}`);
    const tail: string[] = [];
    const cut = streamRestorer(masker, (text) => tail.push(text));
    cut.push("Ends with [EMAIL_");
    cut.flush();
    assert.equal(tail.join(""), "Ends with [EMAIL_", "an unclosed fragment is sent as it is at the end");
});

await check("chat messages are masked in a copy with the note, tool arguments included and images untouched", () => {
    const masker = new Masker();
    const messages = [
        { role: "system", content: "You help." },
        { role: "user", content: [{ type: "text", text: "Email lena@example.com" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "send_email", arguments: "{\"to\":\"lena@example.com\"}" } }] },
        { role: "tool", content: "Sent to lena@example.com" },
    ];
    const before = JSON.stringify(messages);
    const masked = maskChatMessages(messages as never[], masker) as typeof messages;
    assert.equal(JSON.stringify(messages), before, "the caller's history keeps the real details");
    assert.equal(masked[0].content, `You help.\n\n${MASK_NOTE}`);
    assert.deepEqual(masked[1].content, [{ type: "text", text: "Email [EMAIL_1]" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
    assert.equal(masked[2].tool_calls![0].function.arguments, "{\"to\":\"[EMAIL_1]\"}");
    assert.equal(masked[3].content, "Sent to [EMAIL_1]");
    assert.equal(masker.unmaskJson("{\"to\":\"[EMAIL_1]\",\"n\":[\"[EMAIL_1]\"]}"), "{\"to\":\"lena@example.com\",\"n\":[\"lena@example.com\"]}");
    const plain = new Masker();
    assert.deepEqual(maskChatMessages([{ role: "user", content: "Nothing personal" }], plain), [{ role: "user", content: "Nothing personal" }], "no note without a placeholder");
});

await check("routes that may train: the free Gemini key, rows flagged may train, OpenRouter and Agnes free rows", async () => {
    assert.ok(routeMayTrain("gemini-free", "gemini-3.5-flash-lite"));
    assert.ok(!routeMayTrain("gemini", "gemini-3.5-flash-lite"));
    assert.ok(routeMayTrain("kilo", "kilo/free-trainer"));
    assert.ok(!routeMayTrain("kilo", "kilo/free-private"));
    assert.ok(routeMayTrain("openrouter", "vendor/model:free"));
    assert.ok(!routeMayTrain("openrouter", "vendor/model"));
    assert.ok(routeMayTrain("agnes", "agnes-2.5-flash", true));
    assert.ok(!routeMayTrain("nvidia-nim", "z-ai/glm-5.3-flash", true), "NIM does not train under its terms");
    assert.ok(await maskerFor("gemini-free", "x"));
    rememberMaskPrefs({ enabled: false, names: [] });
    assert.equal(await maskerFor("gemini-free", "x"), null, "the switch turns masking off");
    rememberMaskPrefs({ enabled: true, names: ["Lena Tran", "Lena", "May", "Nguyễn Văn An", "Australia/Melbourne"] });
});

function sse(deltas: unknown[]): Response {
    const frames = [...deltas.map((delta) => ({ choices: [{ delta }] })), { choices: [{ delta: {}, finish_reason: "stop" }] }];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

await check("an OpenAI-style free route sees placeholders; tool arguments, tokens and the answer come back real", async () => {
    const bodies: { messages: { role: string; content: unknown; tool_calls?: { function: { arguments: string } }[] }[] }[] = [];
    const replies = [
        sse([{ tool_calls: [{ index: 0, id: "c1", function: { name: "get_current_time", arguments: "{\"timezone\":\"[PER" } }] }, { tool_calls: [{ index: 0, function: { arguments: "SON_2]\"}" } }] }]),
        sse([{ content: "[PERSON_1] can reach you at [EMA" }, { content: "IL_1]; it is late in [PERSON_2]." }]),
    ];
    globalThis.fetch = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const reply = replies.shift();
        assert.ok(reply, "unexpected extra request");
        return reply;
    };
    const tokens: string[] = [];
    const answer = await openaiCompatChat({
        provider: getProvider("openrouter")!, embRef: resolveEmbedding(),
        model: { id: "vendor/model:free", label: "Vendor (free)", name: "vendor", free: true, supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: false },
        systemText: "Owner email: owner@example.com", userText: "Tell Lena my time in Australia/Melbourne",
        allowTools: new Set(["get_current_time"]), onToken: (text) => tokens.push(text),
    });
    const [first, second] = bodies;
    assert.equal(first.messages[0].content, `Owner email: [EMAIL_1]\n\n${MASK_NOTE}`);
    assert.equal(first.messages[1].content, "Tell [PERSON_1] my time in [PERSON_2]");
    assert.equal(second.messages[2].tool_calls![0].function.arguments, "{\"timezone\":\"[PERSON_2]\"}", "the history is masked the same way again");
    assert.match(String(second.messages[3].content), /^Current time \(\[PERSON_2\]\): \d/, "the tool ran with the real time zone");
    assert.equal(answer, "Lena can reach you at owner@example.com; it is late in Australia/Melbourne.");
    assert.equal(tokens.join(""), answer);
    assert.ok(!tokens.join("").includes("["), "no placeholder fragment was streamed");
});

await check("paid and non-training OpenAI-style routes are sent as they are", async () => {
    const bodies: { messages: { content: unknown }[] }[] = [];
    globalThis.fetch = async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return sse([{ content: "Done for lena@example.com" }]); };
    const model = { id: "vendor/model", label: "Vendor", name: "vendor", free: false, supportsTools: false, supportsVision: false, supportsThinking: false, supportsSearch: false };
    const answer = await openaiCompatChat({ provider: getProvider("openrouter")!, embRef: resolveEmbedding(), model, systemText: "You help.", userText: "Email Lena at lena@example.com" });
    assert.equal(bodies[0].messages[1].content, "Email Lena at lena@example.com");
    assert.equal(answer, "Done for lena@example.com");
    rememberMaskPrefs({ enabled: false, names: ["Lena"] });
    await openaiCompatChat({ provider: getProvider("openrouter")!, embRef: resolveEmbedding(), model: { ...model, id: "vendor/model:free", free: true }, systemText: "You help.", userText: "Email Lena at lena@example.com" });
    assert.equal(bodies[1].messages[1].content, "Email Lena at lena@example.com", "masking off sends the details");
    rememberMaskPrefs({ enabled: true, names: ["Lena Tran", "Lena", "May", "Nguyễn Văn An", "Australia/Melbourne"] });
});

function chunk(parts: object[], finishReason?: string): GenerateContentResponse {
    return { candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] } as unknown as GenerateContentResponse;
}

function fakeGemini(turns: GenerateContentResponse[][], sent: GenerateContentParameters[]): ObservedGeminiClient {
    return { models: {
        generateContent: async (params: GenerateContentParameters) => { sent.push(params); return turns.shift()![0]; },
        generateContentStream: async (params: GenerateContentParameters) => {
            sent.push(params);
            const chunks = turns.shift()!;
            return (async function* () { yield* chunks; })();
        },
        embedContent: async () => { throw new Error("not used"); },
    } } as unknown as ObservedGeminiClient;
}

await check("the free Gemini key sees placeholders; a split placeholder and the tool arguments come back real", async () => {
    const sent: GenerateContentParameters[] = [];
    const client = maskGeminiClient(fakeGemini([
        [chunk([{ functionCall: { name: "send_email", args: { to: "[EMAIL_1]", cc: ["[PERSON_1]"] } }, thoughtSignature: "sig" }], "STOP")],
        [chunk([{ text: "Sent to [PER" }]), chunk([{ text: "SON_1] at " }]), chunk([{ text: "[EMA" }]), chunk([{ text: "IL_1]" }]), chunk([], "STOP")],
    ], sent), "gemini-free");
    const contents = [{ role: "user", parts: [{ text: "Email Lena at lena@example.com" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] }];
    const before = JSON.stringify(contents);
    const tools: { name: string; args: Record<string, unknown> }[] = [];
    const tokens: string[] = [];
    const answer = await generateGeminiChat({
        client, model: "gemini-3.5-flash-lite", contents,
        initialConfig: { systemInstruction: "Owner: Lena Tran" }, finalConfig: {},
        executeTool: async (name, args) => { tools.push({ name, args }); return "Sent to lena@example.com"; },
        onToken: (text) => tokens.push(text),
    });
    assert.equal(JSON.stringify(contents), before, "the caller's contents keep the real details");
    assert.deepEqual(sent[0].contents, [{ role: "user", parts: [{ text: "Email [PERSON_2] at [EMAIL_1]" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] }]);
    assert.equal(sent[0].config?.systemInstruction, `Owner: [PERSON_1]\n\n${MASK_NOTE}`);
    assert.deepEqual(tools, [{ name: "send_email", args: { to: "lena@example.com", cc: ["Lena Tran"] } }], "the tool ran with the real details");
    const history = sent[1].contents as { role: string; parts: Record<string, unknown>[] }[];
    assert.deepEqual(history[1].parts[0], { functionCall: { name: "send_email", args: { to: "[EMAIL_1]", cc: ["[PERSON_1]"] } }, thoughtSignature: "sig" }, "the signature part goes back intact");
    assert.deepEqual(history[2].parts[0], { functionResponse: { name: "send_email", response: { result: "Sent to [EMAIL_1]" } } });
    assert.equal(answer, "Sent to Lena Tran at lena@example.com");
    assert.equal(tokens.join(""), answer);
});

await check("a blocking Gemini call is restored, search citations stay on their words, and the paid key passes through", async () => {
    const sent: GenerateContentParameters[] = [];
    const free = maskGeminiClient(fakeGemini([[chunk([{ text: "Hi [PERSON_1]" }], "STOP")]], sent), "gemini-free");
    const response = await free.models.generateContent({ model: "gemini-3.5-flash-lite", contents: "Write to May" });
    assert.equal(sent[0].contents, "Write to [PERSON_1]");
    assert.equal(response.candidates?.[0].content?.parts?.[0].text, "Hi May");
    const masked = "Cafes near [ADDRESS_1]: Bean There. Ask [PERSON_1].";
    const grounding = () => ({ groundingSupports: [{ segment: { startIndex: 0, endIndex: masked.indexOf(":"), text: "Cafes near [ADDRESS_1]" }, groundingChunkIndices: [0] },
        { segment: { startIndex: masked.indexOf("Ask"), endIndex: masked.length, text: "Ask [PERSON_1]." }, groundingChunkIndices: [1] }] });
    const blocking = maskGeminiClient(fakeGemini([[{ candidates: [{ content: { role: "model", parts: [{ text: masked }] }, groundingMetadata: grounding(), finishReason: "STOP" }] } as unknown as GenerateContentResponse]], sent), "gemini-free");
    const cited = await blocking.models.generateContent({ model: "gemini-3.5-flash-lite", contents: "Cafes near 12 Smith Street? Ask May." });
    const restored = cited.candidates![0].content!.parts![0].text!;
    const supports = cited.candidates![0].groundingMetadata!.groundingSupports!;
    assert.equal(restored, "Cafes near 12 Smith Street: Bean There. Ask May.");
    assert.deepEqual(supports.map((support) => restored.slice(support.segment!.startIndex, support.segment!.endIndex)), ["Cafes near 12 Smith Street", "Ask May."], "citations stay on the same words");
    const streamed = maskGeminiClient(fakeGemini([[chunk([{ text: masked.slice(0, 15) }]),
        { candidates: [{ content: { role: "model", parts: [{ text: masked.slice(15) }] }, groundingMetadata: grounding(), finishReason: "STOP" }] } as unknown as GenerateContentResponse]], sent), "gemini-free");
    const parts: string[] = [];
    let last: GenerateContentResponse | undefined;
    for await (const piece of await streamed.models.generateContentStream({ model: "gemini-3.5-flash-lite", contents: "Cafes near 12 Smith Street? Ask May." })) {
        parts.push(...(piece.candidates?.[0].content?.parts ?? []).map((part) => part.text ?? ""));
        if (piece.candidates?.[0].groundingMetadata) last = piece;
    }
    assert.equal(parts.join(""), restored);
    assert.deepEqual(last!.candidates![0].groundingMetadata!.groundingSupports!.map((support) => restored.slice(support.segment!.startIndex, support.segment!.endIndex)), ["Cafes near 12 Smith Street", "Ask May."]);

    const paid = maskGeminiClient(fakeGemini([[chunk([{ text: "Hi May" }], "STOP")]], sent), "gemini");
    const params = { model: "gemini-3.5-flash-lite", contents: "Write to May at may@example.com" };
    await paid.models.generateContent(params);
    assert.equal(sent.at(-1), params, "the same request object, unchanged");
});

globalThis.fetch = originalFetch;
console.log(`${checks} masking checks passed`);
