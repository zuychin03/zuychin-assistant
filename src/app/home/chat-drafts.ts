import { emptyDraft, type ChatDraft, type DraftFile } from "./chat-state.ts";

let database: Promise<IDBDatabase> | undefined;
let writes = Promise.resolve();
const savedFiles = new Map<string, { file: DraftFile | null; revision: string | null }>();

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("zuychin-chat-drafts", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("drafts");
        request.result.createObjectStore("files");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Draft storage is busy in another tab."));
    }).catch((error) => { database = undefined; throw error; });
  }
  return database;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readChatDrafts(): Promise<[string, ChatDraft][]> {
  const db = await openDatabase();
  const transaction = db.transaction(["drafts", "files"], "readonly");
  const drafts = transaction.objectStore("drafts"), files = transaction.objectStore("files");
  const [keys, values, fileKeys, fileValues] = await Promise.all([
    result(drafts.getAllKeys()), result(drafts.getAll()), result(files.getAllKeys()), result(files.getAll()),
  ]);
  const attachments = new Map(fileKeys.map((key, index) => [String(key), fileValues[index] as DraftFile]));
  return keys.flatMap((key, index) => {
    const value = values[index] as (Partial<ChatDraft> & { fileRevision?: string | null }) | null;
    if (!value || typeof value.text !== "string") return [];
    const file = attachments.get(String(key)) ?? null;
    savedFiles.set(String(key), { file, revision: file ? value.fileRevision ?? crypto.randomUUID() : null });
    return [[String(key), { ...emptyDraft(), text: value.text, replyTo: value.replyTo ?? null, file }] as [string, ChatDraft]];
  });
}

export function writeChatDraft(key: string, draft: ChatDraft): Promise<void> {
  const next = writes.catch(() => {}).then(async () => {
    const db = await openDatabase();
    const saved = savedFiles.get(key);
    const revision = draft.file ? saved?.file === draft.file ? saved.revision : crypto.randomUUID() : null;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["drafts", "files"], "readwrite");
      const drafts = transaction.objectStore("drafts"), files = transaction.objectStore("files");
      if (!draft.text && !draft.file && !draft.replyTo) {
        drafts.delete(key);
        files.delete(key);
      } else {
        const previous = drafts.get(key);
        previous.onsuccess = () => {
          drafts.put({ text: draft.text, replyTo: draft.replyTo, fileRevision: revision }, key);
          // Another tab may have replaced the attachment since our last write.
          if (previous.result?.fileRevision !== revision) {
            if (draft.file) files.put(draft.file, key);
            else files.delete(key);
          }
        };
      }
      transaction.oncomplete = () => { savedFiles.set(key, { file: draft.file, revision }); resolve(); };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Draft save was interrupted."));
    });
  });
  writes = next;
  return next;
}
