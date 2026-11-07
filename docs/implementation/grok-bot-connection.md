# Grok Bot to local Cursor: implementation handoff

Status: Proposed, 2026-11-07. This document is the next-session implementation plan. No relay, daemon, Bot connection, deployment, or remote execution capability has been implemented by this planning work.

## Outcome and first gate

A user messages Grok Bot; the Bot uses a bounded bridge client on its cloud computer to submit a coding request to an authenticated HTTPS relay. An outbound-only local daemon imports it into the allowlisted repository's inbox. A human reviews it locally, authorizes preparation, resolves native Cursor workspace trust when needed, and approves the exact Cursor run preview. A worker executes that approved run and publishes a sanitized status. The Bot polls status and explains the outcome in the conversation. Local acceptance, commits, merges, pushes, and cleanup remain separate human operations.

The first implementation gate is a real Grok Bot capability test. [Cursor's Grok Bot overview](https://cursor.com/docs/grok-bot) establishes a persistent cloud computer with terminal, browser, and filesystem; that supports this architectural hypothesis but does not verify this account's outbound HTTPS, client installation, secure credential provisioning, or a specific Bot API/MCP integration. Ordinary chat text cannot itself call our endpoint. From the actual Bot, prove authenticated submit and status polling against a harmless test relay before implementing the full connection. Do not present a local curl test as Bot integration.

[Working with Grok Bot](https://cursor.com/docs/grok-bot/work) describes shared account computer resources and command-line credentials; do not treat Bot names as isolated security principals. Provision the submit credential through a secure secret mechanism, never ordinary chat. Test that the installed bridge can access it without exposing it to conversation output. Use an operator-provided authenticated staging endpoint or implement a minimal inert probe first; production hosting is unnecessary for this gate. If this cannot be demonstrated, stop the live integration claim and record the concrete missing capability while continuing independent local work against fake transport. A same-schema manual file importer is a useful degraded fallback, not completion of the requested automatic connection.

## Starting point and bootstrap

Start from the latest `main` branch of [acaacx/orchestrator](https://github.com/acaacx/orchestrator). The explicit retry and safe startup-diagnostic fixes are included in commit `48ae898`; the accepted FAQ is included in `e8fb3a7`. No local patch bundle or prior chat is required. Do not apply the old handoff patches on top of these commits.

```sh
git clone https://github.com/acaacx/orchestrator.git
cd orchestrator
git switch -c feature/grok-bot-connection
npm ci
npm run check
npm test
```

Inspect repository instructions before implementation. When continuing an existing checkout, preserve unrelated changes and existing `.git/local-orchestrator` state. The latest recorded validation passed TypeScript checking and all 19 tests. A real Cursor task also completed after login and native worktree trust, changed only the README, and was accepted locally. Demo credentials, conversation payloads, database, and machine-specific configuration are intentionally not repository inputs; create a disposable local fixture for new integration tests.

Current `src/contracts.ts` fixes a version-1 task graph at initialization. `src/engine.ts` stores one canonical immutable config and SQLite database per Git common directory, and lists tasks through `config.tasks`. Simply adding requests to that JSON will fail or omit them. Existing `grok-bot` in `src/adapters.ts` is a manual completion handoff for plan/review tasks. New remote intake creates locally governed Cursor tasks; it is a distinct feature, not an automated implementation of that existing adapter.

The current engine provides worktree ownership verification, preview hashes, bounded execution, process-group shutdown, and separate acceptance/cleanup. Preserve these. A live Cursor run applied FAQ changes without `--force`; therefore absence of force is not a read-only guarantee. [Headless documentation](https://cursor.com/docs/cli/headless) describes print mode and force behavior, but the implementation must inspect actual diffs. [Output format documentation](https://cursor.com/docs/cli/reference/output-format) supports structured completion parsing; a successful response does not prove correctness or acceptance.

## Architecture and authority

Implement portable TypeScript modules: shared bridge schemas, a runnable Node relay with SQLite, a bounded cloud bridge client, and a local connector/worker integrated through explicit engine methods. Use one relay instance with persistent disk for the MVP; do not run multiple SQLite replicas. Hosting provider remains unspecified. Provide local/test startup first; choosing hosting, configuring TLS/domain/backups, or incurring billing is a separate explicit deployment step. No autonomous production deployment belongs to this plan.

The laptop opens no public listener and requires no inbound tunnel. It polls the relay with bounded long-poll requests and backoff/jitter. Relay unavailability delays delivery; local Cursor execution does not depend on a continuous relay connection. An offline laptop leaves requests durably queued. Queue age is visible; never silently expire an accepted request.

Keep authority narrower than transport. Submit/status credentials can create requests and read their own account/project scope only. Connector credentials can lease, acknowledge, and publish status for assigned projects only. Neither role can invoke run, approve, cancel, cleanup, choose a filesystem path, supply executable arguments, set environment variables, or select arbitrary adapters. `botId` is optional descriptive metadata, never authentication. Resolve `repoAlias` through a local allowlist with canonical Git-root verification; enforce the account/project binding locally as well as on the relay.

Local CLI approvals are sufficient for the MVP; no approval UI is required. A one-shot local `approve-run` command may enqueue exactly the preview the human just reviewed for the local worker. Existing deterministic preview hashes establish freshness, not caller authority. Never expose a hash as a remote bearer approval token. Keep the approval channel under the local user's OS permissions, with private state/socket permissions if needed, and record the human action before execution. Persist a one-use grant with expiry and task/preview revision binding; consume it atomically when claiming the run. Remote task text remains untrusted instructions reviewed before authorization. Never pass relay/connector credentials into Cursor’s environment. Exclude control/credential directories through the runner sandbox where supported. Worktrees share Git metadata and the local user’s permissions; these controls do not isolate a hostile process running under the same OS identity.

## Versioned contract to implement first

Publish strict runtime schemas plus OpenAPI and fixtures. Reject unknown fields recursively and unsupported `schemaVersion`; do not silently reinterpret versions. Proposed submit body:

```json
{
  "schemaVersion": 1,
  "requestId": "c804274a-37da-4f53-88bf-d4120f1e6e46",
  "repoAlias": "orchestrator",
  "title": "Improve FAQ wording",
  "prompt": "Describe the requested change and acceptance criteria.",
  "capability": "implement"
}
```

`requestId` is a client-generated UUID created once per intent and persisted before submission. `Idempotency-Key` must equal it on every retry. Limits: 64 KiB UTF-8 request body, title 200 characters, prompt 32,000 characters, alias `[a-z][a-z0-9-]{0,47}`, and capability enum `plan|implement|review`. Optional `botId` is a bounded string. Reject path, shell command, callback URL, attachment, dependency, branch, model, and environment fields in v1. Local policy chooses task IDs, adapter, base commit, limits, and dependency behavior.

| Endpoint | Role and semantics |
| --- | --- |
| `POST /v1/requests` | Submit role; atomic durable insert; `201` new or `200` identical replay with the same receipt. |
| `GET /v1/requests/{requestId}` | Submit role, own scope only; sanitized status with revision and timestamps. |
| `POST /v1/leases` | Connector; `{schemaVersion, connectorId, maxItems:1, waitSeconds}`; `200` lease or `204` empty. |
| `POST /v1/leases/{leaseId}/ack` | Connector; `{schemaVersion, leaseToken, requestId, localTaskId}` after durable local import. |
| `PUT /v1/requests/{requestId}/status` | Connector; `{schemaVersion, revision, state, summary, checks}`; monotonic revision, identical replay safe. |

Server derives tenant/project from credentials, not request metadata. Receipts expose `schemaVersion`, `requestId`, `state`, `revision`, `createdAt`, `updatedAt`; lease responses additionally carry the request, opaque lease token, and expiry. No arbitrary list endpoint is necessary initially. If added, require scope checks and cursor pagination with a maximum page size.

Use one error envelope: `{error:{code,message,requestId}}`; omit requestId when unavailable. Return `400` malformed JSON, `401` bad credential, `403` role violation, `404` absent or out-of-scope resource, `409` idempotency digest/revision/lease conflict, `413` size limit, `422` schema failure, `429` rate limit with Retry-After, and `503` temporary storage failure. Errors never include raw request bodies, secrets, stacks, or process output.

Hash canonical validated JSON and enforce a unique `(principalScope, requestId)` constraint transactionally. Same ID/digest returns the original receipt even while pending; different digest returns `409`. Retain identity/digest tombstones beyond the supported retry window, initially indefinitely until explicit archival policy exists. Lease duration starts at 60 seconds; import should be brief. Expired leases become deliverable again with a fresh fencing token; stale acknowledgments cannot mutate them.

## Suggested module boundaries

- `src/bridge/contracts.ts`: request, receipt, lease, status, and error schemas with shared fixtures.
- `src/relay/server.ts`, `store.ts`, and `auth.ts`: HTTP boundary, transactional queue/leases, and scoped credentials; no engine imports or execution capability.
- `src/bridge/client.ts`: Bot-side submit/status commands and stable request-ID storage. No approval or arbitrary-command operation.
- `src/connector/daemon.ts`, `transport.ts`, and `outbox.ts`: outbound polling, ingestion acknowledgments, and durable status publication.
- `src/engine.ts` plus an extracted store/migration module: dynamic task insertion, legacy migration, execution reservations, and one-use local approval grants.
- `src/cli.ts`: local inbox, review/approve, daemon, trust guidance, retry, and recovery commands. Keep current manual commands compatible.
- `test/bridge.test.ts`, `relay.test.ts`, `migration.test.ts`, and `connector.test.ts`: protocol, authority, crash, and offline tests using fake transport and the existing fake Cursor runner. Add a separate opt-in live integration script; routine tests must not spend model credits.

## Persistence, scheduling, and result safety

Migrate the local database transactionally with a schema version, backup, and rollback instructions. Separate stable project metadata from dynamically inserted tasks. Preserve legacy tasks, captured bases, branches, results, and audit events unchanged; legacy config still opens the migrated project. New ingestion uses a unique `(relayIdentity, principalScope, requestId)` mapping to a generated local task ID. Insert task, mapping, and intake event in one local transaction, then acknowledge the relay. Crash after import but before acknowledgment must redeliver to that same mapping, never allocate another worktree.

Capture each new task’s base commit locally when approved preparation begins and freeze it in its run preview; remote requests cannot select refs. Write status transitions and pending publication records in the same local transaction. A durable outbox retries publication after disconnection until the relay acknowledges the revision, so a crash cannot silently lose a final result. Relay acknowledgment ends delivery leasing, not status retention.

Queue delivery is at least once. Exactly-once local import effects come from transactional uniqueness, not a delivery promise. Cursor execution has external effects and cannot be made exactly once by acknowledging a message. Persist run intent before spawning; after restart, uncertain runs require inspection and explicit recovery, never automatic rerun. Add a database-backed per-Git-common-directory execution reservation across all daemon/CLI paths so one Cursor run per repository holds even when several processes race. An expired delivery lease must not release a live execution reservation.

Use relay states `QUEUED`, `AWAITING_LOCAL_APPROVAL`, `PREPARING`, `TRUST_REQUIRED`, `AWAITING_RUN_APPROVAL`, `RUNNING`, `RESULT_READY`, `FAILED`, `RECOVERY_REQUIRED`, `ACCEPTED`, `CANCELLED`. These are an explicit projection, not a rewrite of engine statuses. Local request approval allows automatic preparation; it does not authorize launching Cursor. Present native workspace trust instructions when needed, then obtain a fresh exact run preview and local launch approval. Keep `--sandbox enabled`; add no blanket trust, force, yolo, or bypass flag. Existing trusted worktree setup was a one-off native action and grants no trust to future worktrees.

A successful run publishes `RESULT_READY`, not `ACCEPTED`. Keep full result and diagnostic artifacts local. Remote status permits an allowlisted deterministic summary capped at 2 KiB and at most ten check labels with pass/fail/unknown; never forward raw model output, diffs, file contents, paths, stdout/stderr, credentials, or prompts. Default summary can say only “Cursor run finished; local review required.” Richer prose requires local review/redaction. Relay logs use IDs and event types only. Audit ingestion, role, local approval, run attempt, recovery, and status publication without secrets. Store hashed relay tokens; keep client secrets in OS secret storage or private credential files, out of argv/config/prompts. Document revocation, rotation overlap, rate limits, and immediate denial after revocation.

## Ordered implementation and acceptance

1. **Capability spike:** first provide a minimal inert authenticated staging probe or use an operator-provided endpoint; real Bot securely provisions the bridge credential, submits one harmless request over HTTPS, and polls its receipt. Verify wrong credentials and forbidden operations fail. Record evidence and supported installation steps. If outbound capability is unavailable, block the live gate, not independent local contract/queue development; use fake transport until staging access is resolved.
2. **Contracts and relay:** implement schemas, SQLite queue, authentication and local startup. Test concurrent duplicate submissions, digest mismatch, cross-scope reads, size/unknown-field rejection, lease expiry/fencing, token revocation, restart durability, and disk-write failure before returning success.
3. **Engine migration and intake:** introduce dynamic insertion and local alias configuration. Test a legacy database fixture preserves events/results, migration rollback, duplicate delivery after crash-before-ack, disallowed aliases, Git common-directory identity, and concurrent import. Keep existing tests passing.
4. **Local worker and approvals:** add inbox/status/approve-request/approve-run commands and daemon operation. Test no worktree before request approval, no spawn before run approval, stale preview refusal, native trust blocking, repository-wide concurrency, timeout/output limits, offline relay, and restart during an unknown run. Recovery and retry must remain explicit local actions.
5. **Status and Bot workflow:** implement bounded bridge `submit`/`status` operations only; persist request IDs and poll with backoff. Test summary leakage fixtures, duplicate status revisions, delayed delivery, and revoked connector behavior. Do not invent a chat webhook or claim unsolicited Bot notifications.
6. **Live end-to-end gate:** on a disposable repository, message the Bot once, observe durable queueing while the laptop is offline, reconnect, approve locally, trust the specific worktree if needed, preview/approve a bounded run, inspect its diff and checks, and read sanitized status through the Bot. Confirm no remote approval/cancel/cleanup route exists. Accept locally only after review; leave merge/push separate.

Next session should record the adopted relay boundary in `docs/adr/0003-...md`, cross-reference ADR 0001's transport scope without rewriting history, update README's fixed-graph and observed Cursor limitations, and provide operating/recovery instructions. Completion requires the actual Bot-to-local round trip plus failure/restart evidence; a working relay and manual importer alone are partial delivery.
