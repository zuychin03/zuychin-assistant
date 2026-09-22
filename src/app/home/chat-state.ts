export const NEW_CHAT = "new";

export interface DraftFile { name: string; mimeType: string; base64: string; size: number }
export interface ChatDraft {
  text: string;
  file: DraftFile | null;
  replyTo: { role: "user" | "assistant"; content: string } | null;
}
export const emptyDraft = (): ChatDraft => ({ text: "", file: null, replyTo: null });
export interface ChatRun { id: string; controller: AbortController }
export interface ChatSession<Message, Payload, Progress> {
  key: string;
  messages: Message[];
  loaded: boolean;
  revision: number;
  historyRequest: number;
  historyLoading: boolean;
  draftRevision: number;
  draft: ChatDraft;
  queue: { id: string; payload: Payload }[];
  run: ChatRun | null;
  progress: Progress | null;
  fileRequest: number;
}

export class ChatWorkspace<Message, Payload, Progress> {
  private sessions = new Map<string, ChatSession<Message, Payload, Progress>>();
  private listeners = new Set<() => void>();
  private editedDrafts = new Set<string>();
  private version = 0;
  activeKey = NEW_CHAT;
  storageError = "";
  onDraftChange?: (key: string, draft: ChatDraft) => void;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  serverSnapshot = () => 0;
  notify = () => { this.version++; this.listeners.forEach((listener) => listener()); };

  get(key = this.activeKey): ChatSession<Message, Payload, Progress> {
    let session = this.sessions.get(key);
    if (!session) {
      session = { key, messages: [], loaded: key === NEW_CHAT, revision: 0, historyRequest: 0, historyLoading: false, draftRevision: 0,
        draft: emptyDraft(), queue: [], run: null, progress: null, fileRequest: 0 };
      this.sessions.set(key, session);
    }
    return session;
  }
  contains(session: ChatSession<Message, Payload, Progress>) { return this.sessions.get(session.key) === session; }
  select(key: string) { this.activeKey = key; this.get(key); this.notify(); }
  runningKeys() { return [...this.sessions.values()].filter((session) => session.run).map((session) => session.key); }
  hasPendingWork(unsaved: (message: Message) => boolean = () => false) {
    return [...this.sessions.values()].some((session) => session.run || session.queue.length || session.messages.some(unsaved));
  }
  updateMessages(session: ChatSession<Message, Payload, Progress>, update: (messages: Message[]) => Message[]) {
    if (!this.contains(session)) return;
    session.messages = update(session.messages);
    session.loaded = true;
    session.revision++;
    this.notify();
  }
  setDraft(session: ChatSession<Message, Payload, Progress>, draft: ChatDraft) {
    if (!this.contains(session)) return;
    session.draft = draft;
    session.draftRevision++;
    this.editedDrafts.add(session.key);
    this.onDraftChange?.(session.key, draft);
    this.notify();
  }
  restoreDraftIfEmpty(session: ChatSession<Message, Payload, Progress>, draft: ChatDraft) {
    if (session.draft.text || session.draft.file || session.draft.replyTo || !this.contains(session)) return false;
    this.setDraft(session, draft);
    return true;
  }
  hydrateDraft(key: string, draft: ChatDraft) {
    if (this.editedDrafts.has(key)) return;
    const session = this.get(key);
    if (session.draftRevision) return;
    session.draft = draft;
    this.notify();
  }
  adopt(session: ChatSession<Message, Payload, Progress>, key: string) {
    if (!this.contains(session)) return false;
    const oldKey = session.key;
    this.sessions.delete(oldKey);
    session.key = key;
    this.sessions.set(key, session);
    this.editedDrafts.add(oldKey);
    this.editedDrafts.add(key);
    if (this.activeKey === oldKey) this.activeKey = key;
    this.onDraftChange?.(oldKey, emptyDraft());
    this.onDraftChange?.(key, session.draft);
    this.notify();
    return true;
  }
  beginHistory(session: ChatSession<Message, Payload, Progress>) {
    session.historyLoading = true;
    const ticket = { request: ++session.historyRequest, revision: session.revision };
    this.notify();
    return ticket;
  }
  finishHistory(session: ChatSession<Message, Payload, Progress>, request: number) {
    if (session.historyRequest !== request) return;
    session.historyLoading = false;
    this.notify();
  }
  acceptHistory(session: ChatSession<Message, Payload, Progress>, ticket: { request: number; revision: number }, messages: Message[]) {
    if (!this.contains(session) || session.run || session.historyRequest !== ticket.request || session.revision !== ticket.revision) return false;
    this.updateMessages(session, () => messages);
    return true;
  }
  beginRun(session: ChatSession<Message, Payload, Progress>): ChatRun | null {
    if (!this.contains(session) || session.run) return null;
    const run = { id: crypto.randomUUID(), controller: new AbortController() };
    session.run = run;
    session.progress = null;
    this.notify();
    return run;
  }
  ownsRun(session: ChatSession<Message, Payload, Progress>, run: ChatRun) {
    return this.contains(session) && session.run === run;
  }
  finishRun(session: ChatSession<Message, Payload, Progress>, run: ChatRun) {
    if (!this.ownsRun(session, run)) return false;
    session.run = null;
    session.progress = null;
    this.notify();
    return true;
  }
  enqueue(session: ChatSession<Message, Payload, Progress>, payload: Payload) {
    if (!this.contains(session)) return;
    session.queue = [...session.queue, { id: crypto.randomUUID(), payload }];
    this.notify();
  }
  shift(session: ChatSession<Message, Payload, Progress>) {
    const next = session.queue[0];
    session.queue = session.queue.slice(1);
    this.notify();
    return next;
  }
  removeQueued(session: ChatSession<Message, Payload, Progress>, id: string) {
    session.queue = session.queue.filter((item) => item.id !== id);
    this.notify();
  }
  cancel(session: ChatSession<Message, Payload, Progress>) {
    session.queue = [];
    session.run?.controller.abort();
    this.notify();
  }
  remove(session: ChatSession<Message, Payload, Progress>) {
    this.cancel(session);
    this.sessions.delete(session.key);
    this.editedDrafts.add(session.key);
    this.onDraftChange?.(session.key, emptyDraft());
    if (this.activeKey === session.key) this.activeKey = NEW_CHAT;
    this.notify();
  }
}

export function completedRetry<Message extends { id: string; role: string; content: string }>(
  messages: Message[], sent: string, knownIds: readonly string[],
): boolean {
  const [user, reply] = messages.slice(-2);
  return !!user && !!reply && user.role === "user" && reply.role === "assistant"
    && user.content === sent && !knownIds.includes(reply.id) && !knownIds.includes(user.id);
}

export function sameDraft(left: ChatDraft, right: ChatDraft): boolean {
  return left.text === right.text && left.file?.name === right.file?.name && left.file?.base64 === right.file?.base64
    && left.file?.mimeType === right.file?.mimeType && left.file?.size === right.file?.size
    && left.replyTo?.role === right.replyTo?.role && left.replyTo?.content === right.replyTo?.content;
}
