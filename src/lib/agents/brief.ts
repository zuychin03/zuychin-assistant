// Paste-in brief for setting an agent up against the knowledge base.
//
// It carries a CLAIM, never the durable key. A knowledge key is permanent and
// reaches notes and the vault; a brief is a document whose whole purpose is to
// be pasted around, so an embedded key would travel through the clipboard, the
// agent's context window and usually its logs. The claim is worthless once it
// expires, and the exchange is a plain HTTPS POST so the agent can make it
// before any MCP server exists and write its config exactly once.

export const CLAIM_PLACEHOLDER = "<PASTE_YOUR_CLAIM_HERE>";

export function knowledgeAgentSetup(params: {
    baseUrl: string;
    claim?: string;
}): string {
    const claim = params.claim ?? CLAIM_PLACEHOLDER;
    const mcpUrl = `${params.baseUrl}/api/mcp/mcp`;
    return `You are being connected to "Zuychin", a personal knowledge base exposed over MCP.
Set yourself up, prove it worked, then stop and report. Do not write anything to
the knowledge base yet.

## 1. Exchange your claim for a key

You have been given a one-time claim code. It is short-lived. Exchange it now:

  curl -sX POST ${params.baseUrl}/api/agent/claim \\
    -H 'content-type: application/json' \\
    -d '{"claim":"${claim}"}'

The response looks like:

  { "key": "zck_...", "client": "<your name>", "scopes": [...], "accessLevel": "..." }

That "key" is your durable credential. Keep it. Do not print it, do not paste it
into chat, and do not put it anywhere except the config file in step 2. If the
request fails, stop and ask for a fresh claim; do not retry with a guessed value.

Re-running the same claim inside its window returns the same key, so a retry is
safe if you lost the response.

## 2. Add the MCP server

Add a Streamable HTTP MCP server to YOUR OWN config, with the key already in
place. Only the three facts below are fixed; find the file and format from your
own docs.

  name    zuychin-knowledge
  url     ${mcpUrl}
  header  Authorization: Bearer <the key from step 1>

Claude Code does it in one command:

  claude mcp add --transport http zuychin-knowledge ${mcpUrl} --header "Authorization: Bearer <KEY>"

Cursor uses ~/.cursor/mcp.json; Codex uses ~/.codex/config.toml. If you already
have a Zuychin server configured under a different name, leave it alone and add
this one beside it.

## 3. Prove it worked

List your MCP tools. You must be able to see at least:

  search_knowledge  list_notes  vault_search  vault_read

Then call search_knowledge once with a harmless query. If the server answers,
you are connected. If you get a 401, your key did not save correctly; fix that
before going on.

## 4. What you are allowed to do

Your key carries a fixed access level chosen by the owner, and you cannot raise
it. Some of these may be refused, which is expected and not a bug:

  read-only          search and read only
  notes read/write   also save_note, update_note, delete_note
  full read/write    also vault_ingest, vault_write

No key issued this way can convene a council. Council work uses a separate seat
credential with its own brief.

## 5. Report back

Report which config file you changed, which tools you can see, and what your
access level turned out to be. Stop there.`;
}
