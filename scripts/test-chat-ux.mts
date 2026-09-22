import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatWorkspace, NEW_CHAT, completedRetry, emptyDraft, sameDraft, type ChatDraft } from "../src/app/home/chat-state.ts";

type Message = { id: string; role: string; content: string; retry?: boolean };
type Payload = { text: string };
const workspace = () => new ChatWorkspace<Message, Payload, string>();
const message = (id: string, content = id): Message => ({ id, role: "assistant", content });
const draft = (text: string): ChatDraft => ({ text, file: { name: "notes.txt", mimeType: "text/plain", size: 3, base64: "YWJj" }, replyTo: { role: "assistant", content: "Earlier context" } });

test("stream updates and queued payloads stay in their original conversation after navigation", () => {
  const state = workspace(), a = state.get("a"), b = state.get("b");
  const run = state.beginRun(a)!;
  state.enqueue(a, { text: "Follow up A" });
  state.select("b");
  state.updateMessages(b, () => [message("b-reply")]);
  state.updateMessages(a, (messages) => [...messages, message("a-token")]);
  assert.equal(state.get(), b);
  assert.deepEqual(b.messages.map((item) => item.id), ["b-reply"]);
  assert.equal(state.finishRun(a, run), true);
  assert.equal(state.shift(a)?.payload.text, "Follow up A");
  assert.equal(b.queue.length, 0);
});

test("each conversation can own a run and double submit cannot create a second owner", () => {
  const state = workspace(), a = state.get("a"), b = state.get("b");
  assert(state.beginRun(a));
  assert.equal(state.beginRun(a), null);
  assert(state.beginRun(b));
  assert.deepEqual(state.runningKeys(), ["a", "b"]);
});

test("finishing an old run cannot clear a newer run", () => {
  const state = workspace(), a = state.get("a");
  const first = state.beginRun(a)!;
  state.finishRun(a, first);
  const second = state.beginRun(a)!;
  assert.equal(state.finishRun(a, first), false);
  assert.equal(a.run, second);
});

test("cancelling one chat preserves another chat's run, queue and draft", () => {
  const state = workspace(), a = state.get("a"), b = state.get("b");
  const first = state.beginRun(a)!, second = state.beginRun(b)!;
  state.enqueue(a, { text: "A" });
  state.enqueue(b, { text: "B" });
  state.setDraft(b, draft("B draft"));
  state.cancel(a);
  assert(first.controller.signal.aborted);
  assert(!second.controller.signal.aborted);
  assert.equal(a.queue.length, 0);
  assert.equal(b.queue[0].payload.text, "B");
  assert.equal(b.draft.text, "B draft");
});

test("new-chat creation adopts the origin queue and draft without stealing the viewed chat", () => {
  const state = workspace(), origin = state.get();
  const run = state.beginRun(origin)!;
  state.enqueue(origin, { text: "Follow up" });
  state.setDraft(origin, draft("Next thought"));
  state.select("existing");
  assert(state.adopt(origin, "created"));
  assert.equal(state.activeKey, "existing");
  assert.equal(state.get("created"), origin);
  assert(state.ownsRun(origin, run));
  assert.equal(origin.queue[0].payload.text, "Follow up");
  assert.equal(origin.draft.file?.name, "notes.txt");
  assert.equal(state.get(NEW_CHAT).draft.text, "");
});

test("adopting a viewed new chat updates only its key", () => {
  const state = workspace(), origin = state.get();
  state.adopt(origin, "created");
  assert.equal(state.activeKey, "created");
  assert.equal(state.get(), origin);
});

test("out-of-order navigation fetches populate their own histories without changing the view", () => {
  const state = workspace(), a = state.get("a"), b = state.get("b");
  const requestA = state.beginHistory(a), requestB = state.beginHistory(b);
  state.select("b");
  assert(state.acceptHistory(b, requestB, [message("b-history")]));
  assert(state.acceptHistory(a, requestA, [message("a-history")]));
  assert.equal(state.get(), b);
  assert.equal(state.get().messages[0].id, "b-history");
});

test("stale history cannot replace streamed messages or a newer history response", () => {
  const state = workspace(), a = state.get("a");
  const old = state.beginHistory(a), recent = state.beginHistory(a);
  assert.equal(state.acceptHistory(a, old, [message("stale")]), false);
  state.beginRun(a);
  state.updateMessages(a, () => [message("live")]);
  assert.equal(state.acceptHistory(a, recent, [message("before-run")]), false);
  assert.equal(a.messages[0].id, "live");
  state.finishHistory(a, old.request);
  assert(a.historyLoading);
  state.finishHistory(a, recent.request);
  assert(!a.historyLoading);
});

test("late callbacks for a deleted conversation cannot recreate its messages", () => {
  const state = workspace(), a = state.get("a");
  const run = state.beginRun(a)!, history = state.beginHistory(a);
  state.remove(a);
  state.updateMessages(a, () => [message("late")]);
  assert.equal(state.finishRun(a, run), false);
  assert.equal(state.acceptHistory(a, history, [message("late-history")]), false);
  assert.equal(state.contains(a), false);
  assert.equal(state.get("a").messages.length, 0);
});

test("text, file and reply drafts survive conversation switches and only the sent draft clears", () => {
  const state = workspace(), a = state.get("a"), b = state.get("b");
  state.setDraft(a, draft("A draft"));
  state.select("b");
  state.setDraft(b, draft("B draft"));
  state.select("a");
  assert(sameDraft(state.get().draft, draft("A draft")));
  state.setDraft(a, emptyDraft());
  assert(sameDraft(b.draft, draft("B draft")));
});

test("late draft hydration never overwrites a newer edit or restores a deleted draft", () => {
  const state = workspace(), a = state.get("a"), b = state.get("b");
  state.setDraft(a, draft("Typed now"));
  state.hydrateDraft("a", draft("Older storage"));
  assert.equal(a.draft.text, "Typed now");
  state.remove(b);
  state.hydrateDraft("b", draft("Deleted earlier"));
  assert.equal(state.get("b").draft.text, "");
});

test("late hydration cannot resurrect a migrated new-chat draft", () => {
  const state = workspace(), origin = state.get();
  state.adopt(origin, "created");
  state.hydrateDraft(NEW_CHAT, draft("Old scratch draft"));
  assert.equal(state.get(NEW_CHAT).draft.text, "");
});

test("failed payloads restore into an empty durable draft without replacing newer writing", () => {
  const state = workspace(), a = state.get("a");
  const saved: [string, ChatDraft][] = [];
  state.onDraftChange = (key, value) => saved.push([key, value]);
  assert(state.restoreDraftIfEmpty(a, draft("Failed attachment")));
  assert.equal(saved[0][1].file?.base64, "YWJj");
  state.setDraft(a, draft("Newer work"));
  assert.equal(state.restoreDraftIfEmpty(a, draft("Failed attachment")), false);
  assert.equal(a.draft.text, "Newer work");
});

test("retryable unsaved messages keep reload protection active after the run ends", () => {
  const state = workspace(), a = state.get("a");
  assert.equal(state.hasPendingWork((item) => !!item.retry), false);
  state.updateMessages(a, () => [{ ...message("failed"), retry: true }]);
  assert.equal(state.hasPendingWork((item) => !!item.retry), true);
  state.updateMessages(a, () => [message("saved")]);
  assert.equal(state.hasPendingWork((item) => !!item.retry), false);
});

test("retry reconciliation accepts a newly saved reply but rejects an earlier identical turn", () => {
  const pair = [{ id: "user", role: "user", content: "Same question" }, message("reply")];
  assert.equal(completedRetry(pair, "Same question", []), true);
  assert.equal(completedRetry(pair, "Same question", ["reply"]), false);
  assert.equal(completedRetry(pair, "Same question", ["user"]), false);
  assert.equal(completedRetry(pair, "Different question", []), false);
  assert.equal(completedRetry(pair.slice(0, 1), "Same question", []), false);
});

test("removing a queued item preserves the remaining send order", () => {
  const state = workspace(), a = state.get("a");
  state.enqueue(a, { text: "first" });
  state.enqueue(a, { text: "second" });
  state.enqueue(a, { text: "third" });
  state.removeQueued(a, a.queue[1].id);
  assert.equal(state.shift(a)?.payload.text, "first");
  assert.equal(state.shift(a)?.payload.text, "third");
  assert.equal(state.shift(a), undefined);
});

test("a text edit restores its own attachment after another tab replaced the stored file", async () => {
  const stores = new Map<string, Map<string, unknown>>([["drafts", new Map()], ["files", new Map()]]);
  let attachmentWrites = 0;
  const database = {
    transaction() {
      let pending = 0;
      let completion: ReturnType<typeof setTimeout> | undefined;
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        objectStore(name: string) {
          const data = stores.get(name)!;
          const operation = (work: () => unknown) => {
            pending++;
            clearTimeout(completion);
            const request = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined };
            queueMicrotask(() => {
              request.result = work();
              request.onsuccess?.();
              if (--pending === 0) completion = setTimeout(() => transaction.oncomplete?.(), 0);
            });
            return request;
          };
          return {
            get: (key: string) => operation(() => structuredClone(data.get(key))),
            getAllKeys: () => operation(() => [...data.keys()].sort()),
            getAll: () => operation(() => [...data.keys()].sort().map((key) => structuredClone(data.get(key)))),
            put: (value: unknown, key: string) => operation(() => {
              if (name === "files") attachmentWrites++;
              data.set(key, structuredClone(value));
            }),
            delete: (key: string) => operation(() => data.delete(key)),
          };
        },
      };
      return transaction;
    },
  };
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = { open: () => {
    const request = { result: database, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } as unknown as IDBFactory;
  try {
    const { writeChatDraft, readChatDrafts } = await import("../src/app/home/chat-drafts.ts");
    const first = draft("Tab A draft");
    await writeChatDraft("a", first);
    assert.equal(attachmentWrites, 1);
    await writeChatDraft("a", { ...first, text: "Tab A ordinary edit" });
    assert.equal(attachmentWrites, 1);
    const otherFile = { ...first.file!, name: "other.txt", base64: "eHl6" };
    stores.get("drafts")!.set("a", { text: "Tab B draft", replyTo: null, fileRevision: "tab-b-revision" });
    stores.get("files")!.set("a", otherFile);
    await writeChatDraft("a", { ...first, text: "Tab A subsequent edit" });
    assert.equal(attachmentWrites, 2);
    const restored = (await readChatDrafts()).find(([key]) => key === "a")![1];
    assert.equal(restored.text, "Tab A subsequent edit");
    assert.equal(restored.file?.name, "notes.txt");
    assert.equal(restored.file?.base64, "YWJj");
  } finally {
    globalThis.indexedDB = previous;
  }
});
