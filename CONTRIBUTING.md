# Contributing to agent waker

How to work on this repository. For what agent waker does, read
[README.md](README.md) first.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

Node.js and pnpm versions are pinned by `.nvmrc`, `engines` and
`packageManager`, so `nvm use` and `pnpm install` pick the right ones.

You also need a container runtime. `gitleaks`, `syft` and `actionlint` run
through [`scripts/tool.sh`](scripts/tool.sh) as digest-pinned images, with no
fallback to a locally installed binary: a different version means a different
ruleset, and a secret scanner that quietly changes behaviour is worse than one
that refuses to run. To commit before installing a runtime — CI still runs the
scan — use `HUSKY=0 git commit`.

## Setup

```bash
git clone https://github.com/andreacappadona17/agent-waker.git
cd agent-waker
pnpm install
pnpm verify
```

## Repository layout

There is very little code yet. `src/` holds a single module, and there is no
runnable CLI, so "try my change" currently means "run the tests".

```text
src/     product code
test/    unit and integration tests, mirroring src/
scripts/ repository tooling
```

## Everyday commands

`pnpm verify` runs everything CI runs, and is what the pre-push hook runs.
`pnpm vitest` watches tests while you work. `pnpm run` lists the rest.

`verify` covers formatting, lint, types, build and tests. It deliberately
excludes the security scans: those need a live advisory database or a
registry-hosted image, so they can fail on a day you changed nothing. CI runs
them separately.

## Git hooks

pre-commit runs lint-staged and a gitleaks scan of the staged content.
pre-push runs `pnpm verify`.

The split is by cost. Checks that scale with the diff stay on commit; checks
that scale with the whole repository move to push, so committing stays fast as
the codebase grows. A hook people bypass is worse than no hook.

## Dependency policy

`pnpm-workspace.yaml` refuses packages published less than two days ago, because
compromised npm releases are usually detected and pulled within 24 to 48 hours.
This is enforced on every `pnpm install --frozen-lockfile`, CI included.

When an install fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, pin the newest
version that satisfies the policy and say so in the commit message, rather than
adding a `minimumReleaseAgeExclude` entry. That list is deliberately empty.

The exception that will eventually be needed is an urgent security fix, which
Renovate raises immediately but this policy would hold red for two days. Then,
add a single entry naming the exact version, reference the advisory in the pull
request, and remove it once the fix ages out.

TypeScript is pinned below 6.1 because typescript-eslint declares a peer range
of `>=4.8.4 <6.1.0`. Dependency updates come from
[Renovate](https://docs.renovatebot.com/), which needs its GitHub App installed
on the repository.

## How we work

**Test first.** Every behavioural change starts with a failing test. The
scheduling core is pure and takes an injected clock so its behaviour can be
tested exactly, including timezone and daylight-saving transitions.

**Never call a real provider in a test.** Tests must not consume anyone's usage
quota. Provider behaviour is reproduced with sanitized fixtures and fake agent
executables. A test that shells out to the real `claude` or `codex` binary will
not be merged.

**Keep policy in the core and facts in the adapters.** The core decides when an
agent is due and how retries advance; an adapter only reports what a provider
said. An adapter returning "retry in 10 minutes" is wrong; it should report
"blocked, rolling window, resets at 08:23". When a response cannot be
classified confidently, report it as unknown rather than guessing a reset time.

**Keep credentials out of state, logs and fixtures.** Strip tokens, account
identifiers and e-mail addresses from fixtures before committing. If a fake
fixture trips gitleaks, add a narrow commented entry to `.gitleaks.toml` rather
than widening the rules.

## Adding an agent adapter

The most natural contribution, but not open yet: the contract an adapter
implements has not been built. If you want a particular agent supported, open an
issue now so the contract can account for it.

## Commits and releases

Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint. [release-please](https://github.com/googleapis/release-please) keeps
a release pull request up to date from them; merging it bumps the version,
writes `CHANGELOG.md` and cuts a GitHub release. Do not edit versions or the
changelog by hand.

Two things must happen before a release can be more than a GitHub release:

- `private` has to come out of `package.json`, and the package needs an entry
  point (`bin`, `exports`, `types`). Publishing is additionally gated on the
  repository variable `NPM_PUBLISH_ENABLED`.
- The repository has to be public, or have Advanced Security enabled. CodeQL and
  Scorecard skip themselves while it is private.

## Continuous integration

CI runs the same pnpm scripts you run locally, which run the same digest-pinned
containers, so a tool cannot have one version locally and another in CI. Every
third-party action is pinned to a commit SHA, and `pnpm lint:workflows` fails if
one is not.

SonarQube is opt-in: set the repository variable `SONAR_ENABLED=true` and add a
`SONAR_TOKEN` secret.

## Pull requests

One logical change per pull request, with the template filled in — especially
how the change was verified. Maintainers may ask for a simpler implementation;
this project prefers boring, direct code.

## Related

- [SECURITY.md](SECURITY.md) — reporting vulnerabilities
