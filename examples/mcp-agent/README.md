# MCP Agent Example App (`mcp-agent`)

A runnable **AI-agent** example that drives the gateway's Model Context Protocol
endpoint — `POST /v1/mcp`, JSON-RPC 2.0 — through `@nervly/sdk`, the way an agent
would: discover the tool catalog, call tools, and assert the resulting end state.
This is ticket 11's example app.

## What MCP is for

MCP (the Model Context Protocol) exposes the gateway's operational surface as a
machine-callable tool catalog, so an LLM agent can inspect and operate the
platform without bespoke integration code: check gateway health, trigger a
notification, inspect delivery state, list templates and evaluate subscriber
channels. The gateway advertises each tool with its JSON Schema at `tools/list`
and executes one at `tools/call`; both are authenticated by the same bearer API
key as the rest of `/v1`, and every tool is confined to the key's workspace.

The SDK mirrors this in two ways:

- `nervly.mcp.listTools()` / `nervly.mcp.callTool({ name, arguments })` — the raw
  JSON-RPC surface (`src/resources/mcp.ts`).
- `createNervlyAiToolkit(client)` — ready-made provider definitions
  (`toOpenAITools()`, `toAnthropicTools()`, `vercel()`) plus a typed `execute()`
  helper that unwraps the JSON-RPC result and raises the error object as a real
  `Error` (`src/ai/tools.ts`).

Two protocol details this example pins:

- `tools/call` requires `{ name, arguments }`; a null `params` is JSON-RPC
  `-32602`, never a valid call.
- Protocol failures arrive as **HTTP 200 carrying a JSON-RPC `error` object**.
  Failure classification reads the error object, not the HTTP status.

## Tools exercised

| Tool | What the example asserts |
|---|---|
| `tools/list` | The catalog contains `gateway_status`, `send_notification` and `check_delivery_status`, with their declared input schemas (including `send_notification`'s explicit `live` boolean). |
| `gateway_status` | A live result: `service=nervly-gateway`, a numeric `uptime`, and `nats_status=CONNECTED` (a disconnected broker is an environment failure — delivery cannot flow). |
| `send_notification` | First the **sandboxed default**: no `live` flag → `sandbox: true`, `dispatched: false`, no `eventId`. Then the explicit `live: true` dispatch, which returns the `TriggerResponse` `eventId`. |
| `check_delivery_status` | The dispatched test-mode message reads back `DELIVERED` with `normalized_code=delivered` and `test_mode=true`; a terminal failure status fails fast, and a bounded wait (`EXAMPLES_CHECK_TIMEOUT_MS`, default 30 s) fails the run instead of hanging. |
| `messages.list` (SDK) | A second surface confirms the same `eventId` is `DELIVERED` and `test_mode=true`. |
| unknown tool | `tools/call` with a bogus name surfaces JSON-RPC `-32602` `"Unknown tool: …"` inside HTTP 200 — asserted by code/message, never as a thrown HTTP failure. |
| toolkit | `createNervlyAiToolkit` exposes the same tools as OpenAI and Anthropic definitions, and `toolkit.execute("gateway_status")` returns the live status — no model required. |

**Green means an asserted end state:** the notification dispatched through the
MCP tool reads back `DELIVERED` in test mode. HTTP acceptance alone is never
enough.

## Transcript of a tool call

Shape of a real run (ids and timings vary):

```
mcp-agent run 20261007T120000Z-ab12 (target=local)
→ bootstrap (seed): login as dev@nervly.local
  minted test-mode key examples-20261007T120000Z-ab12 (id key_…)
  workspace dev-local (source=seed)
→ artifact: …/artifacts/mcp-agent/bootstrap.json
→ checks: MCP tools/list
  catalog has 8 tools; required schemas verified (gateway_status, send_notification, check_delivery_status)
→ checks: MCP tools/call gateway_status
  gateway live (uptime=412s, nats_status=CONNECTED)
→ checks: SDK toolkit wiring (createNervlyAiToolkit, no model)
  toolkit exposes 6 OpenAI / 6 Anthropic definitions; execute(gateway_status) worked
→ checks: MCP tools/call send_notification (sandboxed preview)
  preview only: sandbox=true dispatched=false would_dispatch=true (channel=email)
→ checks: MCP tools/call send_notification (live: true)
  live dispatch accepted (event evt_…)
→ checks: MCP tools/call check_delivery_status for evt_… (bound 30000ms)
  asserted end state: evt_… is DELIVERED in test mode (normalized_code=delivered)
→ checks: SDK messages.list read-back (same message, second surface)
  evt_… present via messages.list (DELIVERED, test_mode=true)
→ checks: MCP tools/call unknown tool (JSON-RPC error path)
  unknown tool answered JSON-RPC -32602 "Unknown tool: definitely_not_a_nervly_tool" inside HTTP 200
✓ all checks passed (asserted test-mode DELIVERED)
→ teardown: revoking API key examples-20261007T120000Z-ab12
  API key revoked
summary: …/artifacts/mcp-agent/summary.json
mcp-agent finished: PASS (run 20261007T120000Z-ab12)
```

The raw JSON-RPC exchange behind a `tools/call` is:

```json
{ "method": "tools/call",
  "params": { "name": "gateway_status", "arguments": {} } }
```

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "service": "nervly-gateway", "uptime": 412, "nats_status": "CONNECTED" } }
```

## Run it

Stack prerequisites: the local nervly stack is up and seeded (`make up` /
`make seed-dev` in `nervly-base`), i.e. gateway on `http://localhost:8080`,
control plane on `http://localhost:8081`.

```sh
cd nervly-js
npm run example -- mcp-agent          # human transcript, deterministic core
npm run example -- mcp-agent --json   # summary JSON on stdout
make example ARGS="mcp-agent"         # Makefile equivalent
```

Artifacts land in `artifacts/mcp-agent/` (git-ignored): `summary.json`,
`transcript.log` and `bootstrap.json`. Exit codes follow the shared contract:
`0` pass, `1` assertion failed, `2` environment/bootstrap failure, `3` guard
refusal.

## Optional LLM variant (requires a provider key)

The same tools, but chosen by a model through the SDK AI toolkit:

```sh
OPENAI_API_KEY=sk-… npm run example -- mcp-agent --llm
# or:
NERVLY_LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-… npm run example -- mcp-agent --llm
```

- **Requires a provider key.** Without one the run exits 2 before minting a key,
  naming the variable to set. The default deterministic command
  (`npm run example -- mcp-agent`) never reads a provider key and never runs this
  path.
- The variant runs the deterministic core first (so the `DELIVERED` end state is
  still asserted), then a bounded agent loop (≤ 5 model turns): the model is
  asked to check the gateway status, its tool calls execute through
  `toolkit.execute()`, results are fed back, and the final answer is recorded in
  the transcript and as an `llm variant` check in `summary.json`.
- Provider selection: `NERVLY_LLM_PROVIDER` (`openai` default, or `anthropic`),
  model override: `NERVLY_LLM_MODEL`. No provider SDK is imported — the calls
  are plain `fetch` against the provider HTTP APIs.

## Configuration and guards

The harness reads only the contract's environment table
(`nervly-base/docs/examples/harness-contract.md` §1.1). Before any network work
it refuses (exit 3) a non-local URL, a non-test key, an unsupported
`NERVLY_TARGET`, and a malformed `NERVLY_RUN_ID`.

- **Test-mode only:** the harness mints a `nervly_sk_test_*` read+write key,
  uses it, and revokes it on teardown — success, assertion failure, environment
  failure and SIGINT/SIGTERM. Live keys are refused. On a test-mode key the
  `live: true` dispatch stays test-mode (mocked providers; no carrier contact).
- `EXAMPLES_BOOTSTRAP=seed` (default) logs in as `dev@nervly.local` and mints
  one uniquely named key (`examples-<runId>`); the seed workspace is shared, so
  the run asserts only on its own subscriber/event ids.
- `NERVLY_API_KEY` is env-first: bootstrap is skipped and nothing is minted or
  revoked.
- `EXAMPLES_BOOTSTRAP=fresh` is **refused with exit 3**: the current platform
  cannot expose the email-verification token to an unprivileged harness
  (contract §1.2), so `seed` is the supported mode.
- `EXAMPLES_KEEP=1` skips revoking the key for debugging.
- The key, session and CSRF material never appear in stdout, the transcript, or
  any artifact: `grep -R "nervly_sk_test_" artifacts/` finds nothing after a run.

## Development

```
examples/mcp-agent/
  main.ts            harness entry (`npm run example -- mcp-agent`)
  harness/checks.ts  the deterministic MCP agent loop (asserted end state)
  harness/llm.ts     optional provider-key-gated LLM variant
  harness/           config, guards, bootstrap, console, redact, summary, transcript
```

Tests: `tests/mcp-agent-harness.test.ts` (guards/config/redaction/summary,
bootstrap/teardown, main flows against stubs), `tests/mcp-agent-checks.test.ts`
(the MCP call sequence and its failure taxonomy against a stubbed gateway) and
`tests/mcp-agent-llm.test.ts` (provider resolution and variant wiring). Run them
with `npx tsx --test tests/mcp-agent-*.test.ts`.
