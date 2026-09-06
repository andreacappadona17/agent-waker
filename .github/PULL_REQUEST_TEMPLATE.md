## What does this change?

<!-- Describe the change and the problem it solves. -->

## Why?

<!-- Link the issue this closes, e.g. "Closes #12". -->

## How was it verified?

<!-- Which tests cover this? If behaviour around time, retries, or provider
     output changed, say which deterministic tests pin it down. -->

- [ ] `pnpm verify` passes locally
- [ ] New behaviour is covered by tests
- [ ] Provider output parsing changes come with fixtures

## Checklist

- [ ] The commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] No provider credentials, tokens, or account identifiers appear in code,
      tests, fixtures, or logs
- [ ] Scheduling policy still lives in `src/core/`, not in an adapter
- [ ] Documentation is updated if behaviour the user sees has changed
