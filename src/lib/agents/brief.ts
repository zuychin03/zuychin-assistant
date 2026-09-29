// Pasteable briefs carry short-lived claims, never durable credentials.

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

You have a short-lived claim code. First locate YOUR OWN client config and its
format from your client's docs, then use a local script with an HTTP client to
make this request:

  POST ${params.baseUrl}/api/agent/claim
  Content-Type: application/json
  Body: {"claim":"${claim}"}

Capture the response privately in process memory. Parse its key, client,
scopes and accessLevel fields, then write the key directly to your client config
as described in step 2. Only persist the durable key in that protected config.
Do not print the response or expose it to chat, tool output, logs or shell
history. Never pass the key in command-line arguments or return it to your
conversation context. Disable request/response tracing and keep errors free of
response bodies and credentials. If you cannot do this safely, stop and report
the limitation without exchanging the claim.

If the claim is refused, stop and ask for a fresh one; do not guess a value.
An interrupted exchange can retry the same claim within its validity window;
it returns the same key. Do not print the retry response either.

## 2. Configure or migrate the MCP server

Use a Streamable HTTP MCP server in your own config:

  name    zuychin-knowledge
  url     ${mcpUrl}
  header  Authorization: Bearer <the key from step 1>

If an existing Zuychin server uses this same MCP endpoint, replace that existing
server's credential with the new key, retaining its name. Do not add a duplicate
server beside it, even if its name differs from zuychin-knowledge. If no entry
exists for this endpoint, add one using the name above. Preserve unrelated MCP
servers and other config settings. Keep the config private to your user account.
Reload the client connection so verification uses the new credential.

## 3. Prove it worked

List your MCP tools. You must be able to see at least:

  search_knowledge  list_notes  vault_search  vault_read

Then call search_knowledge once with a harmless query. A successful response
proves the connection. If you get a 401, check the saved credential and reloaded
connection privately; do not report success until the call works. Do not write
knowledge or convene a council to test access. Tool visibility does not prove
your access level; use accessLevel and scopes from the claim response.

## 4. What you are allowed to do

Your key carries a fixed access level chosen by the owner. You cannot raise it.
Each level includes the knowledge permissions of the preceding levels:

  read      read-only          search and read only
  notes     notes read/write   also save_note, update_note, delete_note
  full      full read/write    also vault_ingest, vault_write
  council   full read/write + convene and observe councils (council:owner)

Read, notes and full cannot convene councils. Council participation still needs
a separate session-bound seat credential (council:seat) and its own brief. Host
operations need a dedicated host credential (council:host). This key grants
neither seat nor host authority.

## 5. Report back

Report only the config file path, whether you replaced or added the entry, the
client name, access level, visible tool names and the read-only test result.
Do not include config contents, the claim, the key, any Authorization header or
private search results. Stop there.`;
}
