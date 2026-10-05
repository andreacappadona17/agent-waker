# Gemini CLI setup and adapter behavior

The adapter supports **Gemini CLI 0.62.0 only**. Other builds fail closed before
native auth validation or activation. Install and maintain the provider yourself
using its [official release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.62.0).
Gemini is disabled when omitted from an existing configuration.

## Dedicated native login

The provider owns authentication in `~/.agent-waker-gemini/.gemini/`. Agent waker
never reads, copies or migrates credentials, including native settings that may
contain MCP secrets. This profile is dedicated to scheduling: each auth check, help check
and activation atomically replaces its native `settings.json` with the complete
controlled settings object. Explicit checked, absent system-scope paths prevent
host defaults and overrides from loading. A profile-wide file lock covers control replacement and the child lifetime;
overlapping readiness/activation checks decline startup. Customization there is
reset. The ordinary
Gemini profile is separate. Uninstall retains the dedicated profile and login.

First run `agent-waker detect` with the pinned CLI installed. This prepares the
profile controls and reports that native login is needed. Then sign in yourself:

```bash
profile="$HOME/.agent-waker-gemini"
(
  cd "$profile/work" || exit
  env -i PATH="$PATH" HOME="$profile" GEMINI_CLI_HOME="$profile" \
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=false \
    GEMINI_CLI_SYSTEM_SETTINGS_PATH="$profile/absent-system-settings.json" \
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH="$profile/absent-system-defaults.json" \
    gemini --ignore-env -e none \
      --allowed-mcp-server-names "agent-waker-no-mcp-$(node -p 'require("node:crypto").randomUUID()')"
)
```

Choose the native Google-account OAuth login, finish its browser flow, and quit
without entering a prompt. Then use `agent-waker doctor gemini` and
`agent-waker enable gemini`, or select Gemini during `agent-waker init`.
Accounts requiring an explicit Google Cloud project may remain unsupported:
project and Cloud credential overrides are deliberately omitted.

## Native containment and limitations

The child uses the runner's credential-free environment allowlist and dedicated
HOME/XDG directories. The profile's controlled empty `.env` stops native upward
environment discovery; `--ignore-env` alone does not skip trusted `.gemini/.env`.
Unexpected customization directories (including `.gemini/agents`), trusted environment files, symlinks or a
nonempty activation directory cause a refusal. Native parent-memory traversal is
disabled. Existing private project-memory directories under `.gemini/tmp/` are
refused using metadata only, covering registry and legacy migrated identifiers;
credentials and unrelated session history are retained. XDG cleanup roots must not
contain the retained profile, including through existing symlink ancestors.

Pinned settings enforce `oauth-personal`, disable external auth and credit
overage (`never`), and disable core tools, skills, hooks, discovery/call commands,
MCP server commands, sandbox startup, IDE integration and checkpointing.
`experimental.enableAgents: false` stops native local/remote subagent discovery
before user definitions can trigger startup card or authentication requests.
Extensions are disabled by `-e none`. A nonempty CLI MCP allowlist permits only
a fresh unpredictable UUID-bearing sentinel on each invocation; native MCP filtering rejects other names before
client creation, including remotely required servers. Provider usage statistics
and telemetry are disabled. No API/Vertex billing or paid-seat inference is used.

Native auth validation uses `model.maxSessionTurns: 0` with the legacy runtime
forced. It validates OAuth before generation, then requires exit 53 and the exact
`[ERROR]` JSON `FatalTurnLimitedError` type/message/code sentinel. This is zero
generation, but native OAuth may refresh tokens and contact Code Assist metadata
services. Unknown, incomplete and truncated evidence fails closed. Activation
replaces user settings to allow one turn, a fixed plain prompt, closed stdin
and an empty cwd. Native retries or fallback can make several service requests
within this single bounded activation; one turn is not one HTTP request.

A native JSON success response with exit zero takes precedence over quota diagnostics. Failed
terminal responses require explicit captured quota-exhaustion or quota-reset
wording; HTTP 429, `TerminalQuotaError` or capacity text alone is insufficient.
Exact absolute resets and weekly-window detection are unsupported. Auth/install
failures never enter quota backoff.

## Validation and sources

The real app and ProcessRunner are exercised with an executable source-synthetic
provider fixture. These checks establish application integration; they do not
claim a live Gemini activation or a captured current-version login. The genuine
historical stderr fixture has separate
[provenance](../../test/fixtures/gemini/README.md).

Controls are grounded in pinned upstream [settings](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/config/settings.ts),
[configuration](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/config/config.ts),
[auth/startup](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/gemini.tsx),
[zero-turn handler](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/utils/errors.ts),
[MCP filtering](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/core/src/tools/mcp-client-manager.ts),
[subagent startup](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/core/src/agents/registry.ts),
and [OAuth storage](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/core/src/code_assist/oauth2.ts).

## Related

- [Supported agents](../../README.md#supported-agents)
- [Contributing and conformance](../../CONTRIBUTING.md#adding-an-agent-adapter)
- [Fixture provenance](../../test/fixtures/gemini/README.md)
