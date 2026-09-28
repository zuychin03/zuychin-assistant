import assert from "node:assert/strict";
import { eligibleChatProviders, resolveChatSelection } from "../src/app/home/chat-policy";

const providers = [
    { id: "paid", available: true, chatModels: [{ id: "p", free: false }] },
    { id: "unknown", available: true, chatModels: [{ id: "u" }] },
    { id: "offline", available: false, chatModels: [{ id: "f", free: true }] },
    { id: "free", available: true, chatModels: [{ id: "a", free: true }, { id: "b", free: true }, { id: "p", free: false }] },
];
assert.equal(resolveChatSelection(providers, "paid::p", false), "paid::p");
assert.equal(resolveChatSelection(providers, "unknown::u", false), "unknown::u");
assert.equal(resolveChatSelection(providers, "paid::p", true), "free::a");
assert.equal(resolveChatSelection(providers, "offline::f", true), "free::a");
assert.equal(resolveChatSelection(providers, "free::b", true), "free::b");
assert.equal(resolveChatSelection(providers.slice(0, 3), "paid::p", true), "");
assert.equal(resolveChatSelection(providers, "", false), "");
assert.deepEqual(eligibleChatProviders(providers, true).map((p) => [p.id, p.chatModels.map((m) => m.id)]), [["free", ["a", "b"]]]);
console.log("Chat free selection: 8 passed.");
