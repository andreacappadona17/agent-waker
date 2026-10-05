# Gemini fixtures

`quota-23665-published.txt` is the first published stderr fence from
[upstream issue 23665](https://github.com/google-gemini/gemini-cli/issues/23665),
read via the public GitHub API on 2026-10-05. Markdown fence delimiters and their
adjacent newline are excluded; all content bytes are preserved.

UTF-8: 1,952 bytes. SHA-256:
`229c82d5dc810fad6638ad681955d7d8113ebc2923b9534aaf53278de7b150f0`.

The report identifies Linux CLI v0.34.0, commit `49a86550c`, Google-account
Code Assist for individuals, and headless
`--prompt "tell me the weather" --model gemini-3.1-flash-lite-preview --approval-mode=yolo`.
The failure occurred inside web search. It contains no email or token; published
local stack paths remain test data. It does **not** establish a terminal exit
status, JSON terminal envelope, current-version response or tool-free activation.
Tests supplying an exit code around these bytes explicitly label it synthetic.

Current v0.62.0 auth and terminal envelopes, help text and executable integration
responses are source-synthetic examples, never live captures. The auth sentinel
comes from the pinned native handler; success/error documents follow its JSON
formatter. Raw historical stack text is not emitted as adapter detail.

## Related

- [Adapter setup and sources](../../../docs/gemini-cli/gemini-development.md)
- [Contributing](../../../CONTRIBUTING.md)

`native-memory-discovery.txt` retains the original selected functions from pinned
[v0.62.0 memoryDiscovery.ts](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/core/src/utils/memoryDiscovery.ts),
with its Apache-2.0 attribution. The executable app fixture transpiles them using
the existing TypeScript dependency. Native parent traversal and identity
checks run unchanged; filename/path/logging helpers are substituted for the
contained fixture environment. Loader and remote MCP branches are source-faithful
synthetic equivalents, covering POSIX root ownership for every ancestor, native
scope precedence and exact nonempty MCP allowlist matching. This remains an
executable fixture, not a complete native CLI or live account check.

`native-agent-startup.txt` retains the pinned native `enableAgents` schema field,
original [deep merge functions](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/utils/deepMerge.ts),
and selected [registry startup statements](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/core/src/agents/registry.ts),
with Apache-2.0 attribution. Its small wrapper preserves the enablement gate,
user discovery/registration and remote card-load call; other agent paths, hashing
and post-card processing are omitted. The public adapter/process regression
substitutes directory parsing for a known native-compatible Markdown definition
and records card-client intent without network access. It runs effective
schema-default/user settings merging, proves the default-true card-load path,
then verifies customized-profile refusal and no discovery/card load under false.
This remains source-backed startup evidence, not native account execution.
