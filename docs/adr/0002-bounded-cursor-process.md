# Launch Cursor through a bounded local process

Status: Accepted

## Context

The initial file handoff workflow kept all agent execution manual. Cursor provides a local CLI suitable for headless invocation, while Grok Bot remains cloud-hosted and has no direct access to a local task worktree. A process launch adds operational risk: a changed prompt, executable, working tree, or limit must not silently inherit an earlier approval, and process failure must not cause an automatic rerun.

## Decision

Keep Grok Bot and optional Codex as file-based handoffs. Add a Cursor-only, explicit run flow: inspect a run preview, approve its one-run token, then invoke the configured local `agent` executable. The approval binds the task and dependencies, generated prompt, executable real path and content hash, arguments, working directory, HEAD, and resource limits. Credential-bearing environment values are not placed in configuration or logs.

Cursor is invoked with `--print --output-format json --sandbox enabled`; plan tasks use `--mode plan`, review tasks use `--mode ask`. Do not use force, yolo, trust, or bypass flags. Use the process runner's bounded timeout and output limits. Track `running`, `result-ready`, and `failed` states; interrupted execution whose termination is uncertain stays `running` for explicit recovery. Do not automatically retry. Recovery after interruption requires explicit operator confirmation that all child processes have stopped.

Run authorization, result acceptance, and worktree cleanup are separate operations, each requiring its own applicable preview and token approval. Cursor CLI sandboxing and Git worktree separation are distinct controls; neither makes the worktree itself a security sandbox. Implementation output may be a proposal rather than applied edits, so operators inspect the worktree before accepting a result.

## Consequences

The orchestrator can supervise a local Cursor process without treating its output as proof of correct changes. Runs are auditable and bound to reviewed inputs, while failed or interrupted work remains available for manual inspection. Process execution requires a separately installed and authenticated Cursor CLI. The local process boundary does not provide isolation from the host or grant remote agents access to local files.

## References

- [Cursor CLI headless mode](https://cursor.com/docs/cli/headless)
- [ADR 0001: manual file handoffs](0001-manual-file-handoffs.md)
