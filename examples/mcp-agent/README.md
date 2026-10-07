# MCP Agent Example App (stub)

> **Scaffolding stub.** This directory will hold the MCP agent example. Only this
> README exists today; the app and its final run command arrive with the shared
> harness contract and walking skeleton (ticket 6 in `nervly-base`). Nothing here
> is runnable yet.

## Purpose

Drives the gateway's MCP endpoint (`POST /v1/mcp`) the way an AI agent would, and
shows the SDK's agent toolkit (`createNervlyAiToolkit`, `toOpenAITools`,
`toAnthropicTools`) wired to a model.

- **Deterministic core (CI-runnable):** exercise `tools/list`, `tools/call`
  `gateway_status`, and `tools/call` `send_notification` (asserting the test-mode
  `DELIVERED` end state), plus an unknown-tool error path — via the SDK's MCP
  methods (or raw JSON-RPC 2.0 if that proves clearer), with no model required.
- **Optional LLM variant (documented, key-optional):** the same tools through the
  SDK agent toolkit against a model provider, requiring a provider key and
  excluded from the CI gate.

**Green means an asserted end state:** the notification sent through the MCP tool
reads back `DELIVERED` in test mode.

## Planned run command

The planned entrypoint is the repo-wide example convention `npm run example`; the
shared harness contract fixes its final form, including how this example is
selected.

```sh
npm run example   # from the nervly-js repo root (provisional)
```
