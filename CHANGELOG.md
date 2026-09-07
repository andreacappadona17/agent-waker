# Changelog

## [0.2.0](https://github.com/andreacappadona17/agent-waker/compare/agent-waker-v0.1.0...agent-waker-v0.2.0) (2026-09-07)


### Features

* **adapters:** add the adapter contract and registry ([73f3361](https://github.com/andreacappadona17/agent-waker/commit/73f3361843ef1aab56165c81b2347ec4b1edf390))
* **adapters:** add the Claude Code adapter ([fb30391](https://github.com/andreacappadona17/agent-waker/commit/fb30391cc150b1dff470119ca5c28e89dce2aa25))
* **adapters:** add the Codex adapter ([b13b110](https://github.com/andreacappadona17/agent-waker/commit/b13b110e291b65d3303b39e6cb4400e2e920fe49))
* **cli:** add detect, logs, schedule set, enable and disable ([0758ac2](https://github.com/andreacappadona17/agent-waker/commit/0758ac2e65cc0bb59da1d8645cb4606416127bbb))
* **cli:** add doctor ([4b7d65a](https://github.com/andreacappadona17/agent-waker/commit/4b7d65aff67b401a07d448ad7011f1378f49f234))
* **cli:** add init and uninstall ([85d63cd](https://github.com/andreacappadona17/agent-waker/commit/85d63cd564bed5fb8b16b39d10d28918c3ee91cc))
* **cli:** add the command router, status and tick ([2871be8](https://github.com/andreacappadona17/agent-waker/commit/2871be8cf47313ec22421fdff7168d089ab4367c))
* **cli:** give logs a reader and an agent filter ([e9d2810](https://github.com/andreacappadona17/agent-waker/commit/e9d28108c988ec27ff2152f9ed387b28971b5ba8))
* **cli:** let init choose which agents to manage ([29b1c18](https://github.com/andreacappadona17/agent-waker/commit/29b1c1846d549329e115cd06c5bb440de8590b52))
* **cli:** make run report what it did ([108102e](https://github.com/andreacappadona17/agent-waker/commit/108102e205248481580ceadefb56914be8c080e4))
* **cli:** refuse an unsupported platform, and check what doctor could not ([2e1e7f8](https://github.com/andreacappadona17/agent-waker/commit/2e1e7f80318186f1bf3a1053e125cb9094ea8a75))
* **config:** validate config.yaml against the schema ([287b857](https://github.com/andreacappadona17/agent-waker/commit/287b857259a9f39240dc79803976c4c8f1b7d35a))
* **core:** add retry arithmetic ([81fceaa](https://github.com/andreacappadona17/agent-waker/commit/81fceaa92fd629ab32ca33be507ef780749eca78))
* **core:** add the observation-to-phase table ([4874d18](https://github.com/andreacappadona17/agent-waker/commit/4874d1805b34df2f51ed48f3cf996d9fb9f25743))
* **core:** add the orchestrator tick ([9e8adb8](https://github.com/andreacappadona17/agent-waker/commit/9e8adb816df540db3df466191b7fbdb71654050f))
* **core:** add the state model and the daily cycle ([ec1dab1](https://github.com/andreacappadona17/agent-waker/commit/ec1dab1e93196e2588c9cc3cc6b9a67a5e5f3633))
* **core:** add timezone-aware time service ([9ed4dca](https://github.com/andreacappadona17/agent-waker/commit/9ed4dca934fd4831c80b2c9516ebedff8f7fddc4))
* **logging:** add the structured event log ([64f86ef](https://github.com/andreacappadona17/agent-waker/commit/64f86ef9be45767837dc2e7ee30ea89cd37418d0))
* **process:** add executable discovery ([097b5c5](https://github.com/andreacappadona17/agent-waker/commit/097b5c59c2d3fd42ecf8e93a52d5bfaaf1b93582))
* **process:** add the process runner ([a883df4](https://github.com/andreacappadona17/agent-waker/commit/a883df4e975ab71f0fffb1017847c14953bf5946))
* **schedulers:** add the launchd driver ([e37f396](https://github.com/andreacappadona17/agent-waker/commit/e37f396eda9e543124c67f61ba990f51d6d4bc90))
* **state:** add the state store ([d07c8da](https://github.com/andreacappadona17/agent-waker/commit/d07c8da442000d32c6f789268101b209bf9a0c94))
* **telemetry:** export traces and logs over OTLP ([d88619c](https://github.com/andreacappadona17/agent-waker/commit/d88619ce7c21a7675b61026286b1a2acc9ab4af4))


### Bug Fixes

* **process:** trim captured output to a byte budget ([6017b19](https://github.com/andreacappadona17/agent-waker/commit/6017b196e32a5771ce00e0b7ff7d920c27219151))
