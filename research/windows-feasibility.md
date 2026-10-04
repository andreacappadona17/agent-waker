# Windows portability and validation from a Mac

Research for [Research: Windows portability and validation from a Mac](https://github.com/andreacappadona17/agent-waker/issues/44), checked 2026-10-04.

## Recommendation

Native Windows is conditionally feasible to develop from a Mac. Use hosted Windows CI for repeatable platform and fake-provider tests, and require a volunteer Windows machine for ordinary-user, session, power, and real-provider validation before advertising stable support. The maintainership constraint is access to that release evidence, rather than the developer's operating system.

The smallest plausible contract is a current-user, limited-privilege Task Scheduler task that runs short-lived Ticks while the user is logged on, catches overdue work on a later Tick, and stores no Windows password. Logged-out activation is outside that proposed contract. This is a recommendation for the subsequent HITL decision, not an approved support promise.

This investigation reads committed source at `be91b6cd5b9b5ce55df9db74d4c79f6a30665cc6`. It assumes the predecessor map's Linux implementation, further Adapter, and hardening are completed before implementation begins. Recheck its final code before turning the portability inventory below into build tickets. No implementation or provider execution was performed.

## What hosted CI establishes

GitHub provides fresh Windows VMs, including `windows-2025` and `windows-latest`; standard runners are free for public repositories. An explicit image label makes the initial test baseline clearer. GitHub also offers a Windows 11 ARM runner; it should be a separate compatibility claim rather than assumed coverage from an x64 job. [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#supported-runners-and-hardware-resources).

Windows hosted runners execute as administrators with UAC disabled. A passing workflow therefore does not demonstrate installation or task registration by a standard Windows user with UAC enabled. Treat Task Scheduler create/query/update/run/delete testing as a candidate integration layer to prove with a fake executable; interactive-session execution must also be established, not inferred from task registration success. [GitHub administrative privileges](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges).

The repository currently tests Ubuntu and macOS ([CI](../.github/workflows/ci.yml), lines 22–26). Windows needs real process/filesystem execution, not only mocked scheduler calls, and cannot be added to the matrix with confidence until existing POSIX assumptions are addressed.

## Task Scheduler without stored credentials

Microsoft allows a non-administrator to register a task for their own account with interactive logon without supplying a password. A low-privilege process can register a limited-privilege task but cannot request the highest run level. Task owners can normally read, update, delete, and run their tasks. This supports a per-user install/repair/uninstall design without elevation, subject to actual local policy and validation. [Task security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks).

`TASK_LOGON_INTERACTIVE_TOKEN` requires an existing logged-on interactive session. `TASK_LOGON_PASSWORD` requires a password at registration. `TASK_LOGON_S4U` stores no password but cannot access the network or encrypted files. Consequently, S4U is not a substitute for logged-out network-dependent provider activation under the map's constraints. [Task logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type).

| Concern | Verified capability | Consequence for the support decision |
| --- | --- | --- |
| Periodic short-lived Tick | Repetition interval ranges from one minute to 31 days; omitted duration repeats indefinitely. [Interval](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern-interval), [duration](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern-duration). | A repeated native task can preserve the daemonless architecture. Choose an interval matching the scheduler contract. |
| Missed schedule | `StartWhenAvailable` allows late start for eligible time triggers with an end boundary or indefinite repetition; queued catch-up has a default ten-minute delay. [Missed-run setting](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable). | Do not promise instant resume. Core due timestamps remain authoritative; a subsequent Tick can process overdue work. |
| Overlap | Policies include parallel, queue, ignore-new, and stop-existing. [Instance policy](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-multipleinstances). | `IgnoreNew` is a plausible choice, with independent state locking for manual invocations. |
| Battery at start | `DisallowStartIfOnBatteries` defaults to true. [Battery start condition](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-disallowstartifonbatteries). | Explicitly decide whether laptop battery use permits activation; do not silently inherit an AC-only schedule. |
| Switching to battery | `StopIfGoingOnBatteries` defaults to true. [Battery stop condition](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-stopifgoingonbatteries). | Explicitly decide whether unplugging should interrupt an Activation. |
| Sleeping laptop | `WakeToRun` requests waking to run the task. [Wake setting](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-waketorun). | Recommend passive catch-up after ordinary wake initially. Do not equate the API setting with verified behavior across laptop power configurations. |

These are OS capabilities. Whether the selected trigger resumes while the screen is locked, how it behaves across logout/login, and whether providers can use their existing authentication in that context remain release tests. The persisted-Tick design already describes handling overdue work on a later Tick ([ADR 0003](../docs/adr/0003-no-daemon-short-lived-ticks-state-in-timestamps.md)); the Windows driver should wake that policy rather than duplicate it.

## Portability beyond SchedulerDriver

The scheduler seam is already intentional ([ADR 0004](../docs/adr/0004-scheduler-seam-is-a-driver-not-an-adapter.md)), but adding a Windows driver alone would leave several concrete blockers:

| Area | Committed-source evidence | Required investigation or acceptance evidence |
| --- | --- | --- |
| Platform routing | [main.ts](../src/cli/main.ts), line 208; [select.ts](../src/schedulers/select.ts), lines 45–69. | Admit `win32` only once the CLI dependencies work; choose user identity without Unix UID assumptions. |
| State locking | [store.ts](../src/state/store.ts), lines 149–186, shells out to `lockf` or `flock` with an inherited file descriptor. | A Windows-compatible lock must exclude both scheduled and manual competitors, release on process death, and recover without deleting another owner's live lock. Recheck predecessor changes first. |
| Process containment | [runner.ts](../src/process/runner.ts), lines 207–216 and 239–255, uses detached POSIX process groups and negative-PID termination. | Node explicitly rejects process-group killing on Windows. Evaluate a bounded Windows tree-termination strategy and verify descendants actually exit. [`process.kill`](https://nodejs.org/api/process.html#processkillpid-signal). Microsoft's `taskkill /T` targets children, but its existence alone does not prove race-free containment. [Taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill). |
| Executable discovery | [discovery.ts](../src/process/discovery.ts), lines 96–113, joins the extensionless name and splits PATH on `:`; provider fallback paths are Unix-oriented. [Claude](../src/adapters/claude.ts), lines 186–191; [Codex](../src/adapters/codex.ts), lines 177–186. | Use platform-aware PATH parsing, case handling, installation locations, and explicitly supported executable extensions. Node supplies `path.delimiter` (`;` on Windows). [Path documentation](https://nodejs.org/api/path.html#pathdelimiter). Audit `PATHEXT` behavior rather than accepting arbitrary wrappers. |
| Wrapper execution | [runner.ts](../src/process/runner.ts), lines 210–212, enforces shell-free execution. | Windows `.cmd`/`.bat` files require command-interpreter handling. Prefer a native binary or known Node entrypoint where available; any wrapper route needs deliberate quoting and containment, not simply `shell: true`. [Node Windows spawning](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows). |
| Safe environment | [runner.ts](../src/process/runner.ts), lines 32–59 and 170–183, explicitly excludes Windows support. | Decide the minimum Windows runtime/profile/temp variables, normalize case-insensitive keys, and retain API-key exclusion. Node documents collisions between `PATH` and `Path`. [Child-process environment](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options). |
| Paths and persistence | [paths.ts](../src/cli/paths.ts), lines 33–65, treats only slash-prefixed XDG paths as absolute; [atomic.ts](../src/state/atomic.ts) uses rename, mode bits, and best-effort directory sync. | Choose Windows-owned directories and validate drive/UNC paths, Unicode, spaces, replacement durability, and access permissions. Do not assume Unix mode bits express Windows ACL privacy. [Node filesystem differences](https://nodejs.org/api/fs.html#fschmodpath-mode-callback). |
| Launcher and repair | [launchd.ts](../src/schedulers/launchd.ts), lines 118–183, contains the committed `/bin/sh` launcher; [init.ts](../src/cli/init.ts), lines 226–244, finds Unix Node paths. | Preserve verified Node/entrypoint recording, stale-path diagnostics, and repair using a Windows-compatible action/launcher; avoid importing shell profiles. Recheck any launcher extraction in the completed Linux baseline. |
| Package and tests | [package.json](../package.json) contains shell-specific scripts; [discovery tests](../test/unit/process/discovery.test.ts) create `/bin/sh` fake providers. | Exercise the packed npm artifact in ordinary PowerShell/CMD and use cross-platform fake executables. Audit install, invocation, repair, upgrade, and uninstall separately from source tests. |

## Native Windows and WSL are separate routes

WSL supports systemd, but Microsoft explicitly states that systemd services do not keep a WSL instance alive. A completed Linux driver may help users whose workflow already runs inside WSL; it does not establish Windows-host wake scheduling while the distribution is stopped. A Windows task that launches WSL would be another integration contract with distro, lifecycle, path, and authentication prerequisites, not free native support. [Microsoft WSL/systemd documentation](https://learn.microsoft.com/en-us/windows/wsl/systemd).

Claude Code documents both native Windows and WSL operation and permits native installation without Administrator. Its native Windows sandbox availability differs from WSL, so the Adapter's minimal containment must be checked per platform. [Claude setup](https://code.claude.com/docs/en/setup#set-up-on-windows).

Codex documents native Windows CLI use and two sandbox modes: the recommended elevated sandbox needs administrator-approved setup, while an unelevated fallback exists and can be constrained by enterprise policy. Agent-waker must not assume an already logged-in provider has a quota-free, unattended first sandbox setup. Record provider setup prerequisites separately from the tool's own no-admin runtime promise. [Codex Windows sandbox](https://developers.openai.com/codex/windows/).

Provider platform availability does not itself prove subscription-safe scheduled activation. The selected support matrix must specify tested provider versions, auth lanes, containment, and refusal of paid/API-key fallback without inspecting credential files.

## Proposed validation and release gate

The following is proposed evidence, not completed testing:

1. **Hosted CI:** Windows package build/install and CLI invocation; Unicode/spaced paths; fake-provider discovery and argument fidelity; environment filtering with sentinel keys; bounded output; parent/descendant timeout cleanup; atomic state replacement; competing scheduled/manual lock owners; forced-death recovery. Exercise fake quota/auth/install Observations and prove skipped Ticks do not invoke providers.
2. **Scheduler integration:** Register a uniquely named, current-user limited task; inspect its principal, action, repetition, battery and overlap settings; explicitly execute a fake Tick and verify its output; update/repair/query/remove it. A missing usable interactive token must produce a bounded test limitation, not a false pass. Always clean up test tasks.
3. **Volunteer Windows 11 machine:** Use a standard account with UAC enabled. Verify package installation and repair without elevation, reboot/login, locked desktop, logout/login, network loss/recovery, sleep/resume, battery transitions, competing invocations, and no orphan provider processes. Record OS architecture, Node/package/provider versions, trigger settings and results; logs must be sanitized.
4. **Real-provider evidence:** The volunteer signs in through the provider and authorizes a minimal subscription Activation during their normal usage. Verify unattended operation and observable Window benefit where the provider exposes it. Do not deliberately spend usage to manufacture quota fixtures; collect naturally occurring, sanitized provider evidence. Agent-waker never reads credentials, and automated tests never call real providers.
5. **Public claim:** Publish only the verified Windows/Agent combinations and documented logged-on/catch-up limitations. Until the real-machine gate passes, describe any implementation as experimental. If no tester is available, defer stable Windows rather than inferring it from administrator-run CI.

The next decision must settle whether that narrower contract serves the chosen public users, whether a tester is available, the initial architecture/OS/provider matrix, battery and wake policy, and the acceptable experimental-versus-stable release boundary. Those choices remain HITL; this research resolves technical feasibility and exposes the evidence required to make them.
