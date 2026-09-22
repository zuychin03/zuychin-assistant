# UI continuity checks

The usability update preserves the existing visual design while keeping chat work, document drafts and navigation context intact.

## Local regression checks

Run these without production credentials. The vault conflict suite mocks all provider, GitHub and database requests.

```powershell
npx tsc --noEmit
npm run lint
npx tsx scripts/test-chat-ux.mts
npx tsx scripts/test-document-continuity.mts
npx tsx scripts/test-model-picker.mts
npx tsx scripts/test-vault-save-conflicts.mts
npx tsx scripts/test-cosmos-navigation.mts
```

Coverage includes conversation ownership, queue ordering, stale callbacks, history races, draft recovery, cross-tab attachment consistency, document conflicts, safe return URLs and keyboard model selection. Conditional saves reject stale Markdown or a competing vault commit before indexing begins.

## Browser verification

Use disposable local fixtures for mutations and failures. Do not delete real conversations or change the live vault to exercise these checks.

1. Start a delayed reply in chat A, queue another message, switch to B and send there. Confirm each reply and queued request remains with its original conversation, including after visiting Library.
2. Write a draft, switch chats and reload. Confirm the text and attachment recover together. Simulate unavailable browser storage and check the recovery warning.
3. Cancel a deletion with Escape, then simulate a failed deletion. Confirm the chat remains and the error offers retry. Failed project creation, rename, instructions and moves must retain their forms or menus.
4. Search models by provider and capability. Check no results, arrow/Home/End navigation, Enter selection and Escape cancellation. Verify model details and confirmation dialogs contain focus and restore it on close.
5. Edit a document in Library, visit Cosmos and resume the same draft. Simulate failed and conflicting saves. Confirm the draft survives, and filters, document selection and return-to-chat context remain intact.
6. At a narrow mobile width, open a Library page and check reader focus. Back to pages must restore the selected row and list position. Check the model picker fits the viewport.

On 23/09/2026, isolated desktop and 390-pixel mobile browser checks verified background stream/queue ownership, text draft recovery after reload, shared Library/Cosmos drafts, failed saves/deletions/project edits, model search and mobile reader navigation. No real model calls, hosted database writes or vault mutations were used for these checks. Regression coverage uses synthetic storage and network failures; it does not constitute device-wide or production failure testing.
