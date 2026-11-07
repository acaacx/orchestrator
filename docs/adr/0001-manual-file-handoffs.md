# Use manual file handoffs with local orchestration (historical)

Status: Partly superseded by [ADR 0002](0002-bounded-cursor-process.md).

As of 2026-11-07, the available agent surfaces did not provide a verified common automation API for these workflows, and Grok Bot runs in the cloud without access to a local worktree. The initial orchestrator therefore persisted task state and audit history locally in SQLite, created Git worktrees, and exchanged versioned JSON handoff and result files; operators ran agents and reviewed their output themselves. This decision still applies to Grok Bot and optional Codex. Cursor now has a bounded local process path described in ADR 0002. Git worktrees remain organizational isolation, not security sandboxes.
