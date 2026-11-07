# Local Coding Orchestrator

A local-first TypeScript CLI for coordinating coding tasks across separate Git worktrees. It tracks dependencies and audit events in SQLite, prepares handoff packets, and can launch a bounded local Cursor CLI process after an explicit, task-specific approval. Grok Bot and optional Codex remain file-based handoffs.

## Requirements and quick start

- Node.js 22.18 or newer (uses the built-in `node:sqlite` module)
- Git, with the target project checked out as a Git repository
- macOS or Linux for automated process-group supervision
- Cursor CLI (`agent`) installed and authenticated for Cursor tasks

From this directory, install dependencies and initialize against an existing repository. Replace the example path with that repository's absolute path; the configured directory must be its Git root.

```sh
npm ci
# Edit examples/config.json and set repository to the absolute Git root.
npm start -- init examples/config.json
npm start -- status examples/config.json
```

There are no runtime npm dependencies. The configuration is immutable after a project is initialized: subsequent commands must use the same configuration.

## Task workflow

Use the task IDs from `examples/config.json`. This example assumes its plan task is named `plan` and its implementation task is named `implement`.

```sh
# Prepare a task worktree and its handoff packet.
npm start -- prepare examples/config.json plan

# Grok Bot and optional Codex: copy the packet to the service yourself,
# save its response as examples/result.json, then import it.
npm start -- import examples/config.json plan examples/result.json

# Review and accept the plan result. This is a separate approval from process launch.
npm start -- preview examples/config.json plan accept
npm start -- approve examples/config.json plan accept '<token-from-preview>'

# Prepare the implementation worktree after the plan is accepted.
npm start -- prepare examples/config.json implement

# Inspect the exact local process run before allowing it to start.
npm start -- preview examples/config.json implement run
# Review the preview's task, dependencies, prompt, executable identity, arguments,
# working directory, HEAD, and resource limits. Copy its token exactly.
npm start -- run examples/config.json implement '<token-from-preview>'

# Inspect the process outcome and result; run approval does not accept the result.
npm start -- status examples/config.json
npm start -- preview examples/config.json implement accept
npm start -- approve examples/config.json implement accept '<token-from-preview>'
```

The process-run approval is bound to the task, dependencies, prompt, executable real path and content hash, arguments, working directory, current HEAD, and configured limits. Changes to the previewed inputs require a fresh preview and token. It authorizes one bounded run only. It does not authorize accepting the result or cleaning up the worktree; those remain separate preview-and-token approval steps.

Cursor runs use the installed `agent` executable with `--print --output-format json --sandbox enabled`. Plan tasks add `--mode plan`; review tasks add `--mode ask`. No force, yolo, trust, or bypass flags are used. Cursor's enabled sandbox is distinct from Git worktree isolation, and implementation tasks can return proposed edits that were not applied. Inspect the process outcome and worktree directly before accepting anything.

The version 1 result contract is `version`, `taskId`, `outcome` (`succeeded` or `failed`), `summary`, and `evidence`; see [`examples/result.json`](examples/result.json). Results are summaries and evidence supplied by the process or operator, not proof that changes are correct. Review and commit wanted changes locally before accepting. Preview requires a clean worktree, including ignored files. Any change makes an approval token stale.

Cleanup also requires a distinct preview and explicit token approval:

```sh
npm start -- preview examples/config.json implement cleanup
npm start -- approve examples/config.json implement cleanup '<token-from-preview>'
```

If the orchestrator was killed and a task remains `running`, determine that every child process has stopped before confirming recovery:

```sh
npm start -- recover examples/config.json implement stopped
```

After fixing a failed Cursor process attempt (for example, signing in), prepare an explicit retry:

```sh
npm start -- retry examples/config.json implement
npm start -- preview examples/config.json implement run
npm start -- run examples/config.json implement '<new-token>'
```

Retry requires an unchanged, clean owned worktree and a failed Cursor attempt without a result. It preserves failure history and invalidates previous run tokens. It cannot reset a running task; use recovery first only after confirming its child processes have stopped.

Recovery marks the task failed without rerunning it. Successful runs become `result-ready`; known process failures become `failed`. Runs whose termination cannot be confirmed stay `running` until recovery. There is no automatic retry. Inspect interrupted runs and preserved branches manually.

Other commands:

| Command | Purpose |
| --- | --- |
| `npm start -- help` | Show CLI usage |
| `npm start -- status examples/config.json` | Show task and process state |
| `npm start -- audit examples/config.json` | Show the append-only event history |
| `npm start -- cancel examples/config.json TASK_ID` | Cancel an eligible task |
| `npm test` | Run the Node test suite |
| `npm run check` | Type-check source and tests |

## State, boundaries, and limitations

The orchestrator stores `state.sqlite`, handoff JSON, and worktrees below `local-orchestrator/` in the Git common directory. SQLite transactions record state changes and audit events. The tool removes only a worktree whose path and branch it verifies; it does not force-remove a worktree or delete a branch.

Git worktrees share the repository's Git object database and are not security sandboxes. Cursor's `--sandbox enabled` applies Cursor CLI's own sandbox behavior; approval tokens constrain only the orchestrator's process launch and its accept/cleanup operations. They do not constrain a remote service or every action a process could take outside the worktree. Stop the agent before reviewing or cleaning up. Commit wanted files first; inspect ignored artifacts and consciously remove anything you do not want before previewing cleanup.

Cursor authentication is provided through `agent login` or an inherited `CURSOR_API_KEY`. The orchestrator does not put credentials in configuration, prompts, result files, or logs. Keep credentials out of task text. Grok Bot work happens in the cloud and cannot access the local worktree directly; no Grok Bot automation API is used or claimed. Codex is optional and remains a manual file handoff. This flow does not deploy to production.

References: [Cursor CLI headless mode](https://cursor.com/docs/cli/headless), [Cursor CLI](https://cursor.com/docs/cli/overview), [Grok Bots](https://cursor.com/docs/grok-bot), and [Grok Build CLI announcement](https://x.ai/news/grok-build-cli). Grok Build CLI is a separate product from Grok Bot.

## Architecture

- `src/contracts.ts` validates the fixed config and result formats, task identifiers, and dependency graph.
- `src/adapters.ts` contains trusted adapter behavior. Task JSON cannot load modules or choose commands.
- `src/engine.ts` owns SQLite state, Git worktree operations, previews, approvals, process supervision, and audit events.
- `src/cli.ts` exposes the explicit command-line workflow.

The original manual-handoff decision is recorded in [ADR 0001](docs/adr/0001-manual-file-handoffs.md); its transport choice is partly superseded by [ADR 0002](docs/adr/0002-bounded-cursor-process.md).

Dependencies pass accepted result summaries and evidence in the next handoff packet. They do **not** inherit predecessor commits. Every task starts from the commit captured at initialization; integrating code between branches remains a manual reviewed operation. The MVP uses a fixed task graph, one configuration per Git common directory, and no scheduler, automatic retries, merges, pushes, or deployments.

## Recovery and validation

The target repository needs at least one commit. Keep the configuration and local state: deleting state loses ownership and audit information. Audit history is application-append-only, not tamper-proof against the local user.

- Review run state with `status` and `audit`; do not rerun automatically after failure or interruption.
- Use `recover ... stopped` only after confirming that the launched process and its children have stopped.
- Retry interrupted cleanup only with the same approved token, even if the directory has already been removed. If files or commits changed, obtain a new preview first.
- A cancelled task that never created a worktree can still complete the preview/approve cleanup flow without filesystem removal.
- Concurrent mutations wait up to three seconds for SQLite's writer lock, then fail safely; retry after the other command completes.
- Inspect failed results and preserved branches manually. The MVP does not reset or rerun failed tasks automatically.

Validation details belong to the implementation's current run and are reported separately; no live paid model execution is claimed here. Node 22.18 is the declared minimum.

## Extending the registry

Grok Bot supports `plan` and `review`; Cursor and optional Codex support `plan`, `implement`, and `review`. Enable Codex by adding `codex` to `enabledAdapters` before initialization and assigning a task to it. It remains a manual adapter.

To add a future Claude Code harness, implement the exported `Adapter` interface, register it in a `Registry`, and pass that registry to `new Engine(config, registry)`. Add it to `builtins()` for CLI selection. The current automated execution policy is deliberately Cursor-specific; a new automated harness needs its own reviewed executable, arguments, result conversion, and approval policy. Task JSON cannot import modules or supply arbitrary executable commands.

Validated on macOS with Node 26.8.1 and Git 2.54.0: TypeScript checking and all 17 tests pass. Automated tests use real child processes with a fake Cursor executable, including process-group shutdown, timeout/output limits, stale approval, worktree ownership, and CLI behavior. A live paid Cursor model call was not performed.
