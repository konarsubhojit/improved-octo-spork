# Reminders and two-way service monitoring

This repository is migrating from the archived AWS trial-reminder prototype to an invite-only
personal reminder and service-monitoring application for an **existing** GCP micro VM, Oracle
Autonomous Transaction Processing database, and Gmail SMTP. Nothing here provisions, deploys,
sends live email, or performs a live probe.

The MVP foundation includes:

- local-wall-time and fixed-elapsed recurrence with five-occurrence previews;
- independent pull and push monitor state machines;
- 256-bit push credentials (only SHA-256 hashes are persisted), bounded idempotent heartbeat ingress;
- expiring one-use invite/session primitives, CSRF checks, and workspace isolation helpers;
- durable job lease/fence, notification suppression/retry/quota primitives;
- an Oracle-compatible tenant-scoped schema and atomic push receipt adapter;
- an OpenAPI contract and prebuilt React dashboard shell.

## Current implementation boundary

This remains an incremental MVP. A runnable vertical slice now exists for invite verification +
authenticated reminder create/list/edit/pause/resume/delete, recipient subscription preferences,
workspace service + push monitor create/list/rotate, and Oracle-backed scheduler/email-worker loops.
Push heartbeat ingress and Oracle receipt persistence are also implemented. **Outbound pull execution is
fail-closed**, because this repository
does not yet demonstrate the required DNS pinning, TLS/SNI validation, redirect/header/body/time
bounds, process isolation, and independent egress containment. Do not enable it by substituting a
normal `fetch`.

The former unauthenticated AWS Function URL, DynamoDB implementation, and SAM template are retained
only as migration reference in [`docs/legacy-aws.md`](docs/legacy-aws.md) and `template.yaml`. They
must not be deployed or exposed as an alternate API.

## Scheduling and state policy

- Due instants are UTC; IANA zone and original local recurrence are retained.
- Calendar schedules preserve wall time. A nonexistent time advances to the first valid instant
  after the gap; a duplicated time uses the earlier occurrence once.
- Missing monthly dates are skipped. An elapsed 24 hours is distinct from daily local time.
- A one-time occurrence less than 24 hours overdue is late; at 24 hours it is missed. Recurring
  consumers must coalesce backlog to at most one recent late occurrence.
- Pull: three completed target failures cause `down`; two successes recover. Infrastructure failure
  or missing coverage becomes `unknown` and does not count against the target.
- Push: receipt time is authoritative. At interval age it remains healthy, then is failing during
  grace, then down. One fresh heartbeat recovers. New monitors remain unknown until a first receipt
  unless “start expecting now” is explicitly selected.
- Pull and push incidents are separate. Maintenance observes but suppresses notifications. Pause,
  resume, configuration edits, and deletion invalidate stale queued work.

## Email policy

Only verified recipients with explicit active consent are eligible. Verification is the sole
bounded pre-consent exception. Workers must recheck the occurrence/configuration version,
cancellation, consent, maintenance, and quotas immediately before submission.

The application ceiling is 100 recipient-attempts per rolling 24 hours, with 20 places withheld
from reminders for verification/incidents, plus 2,500 per calendar month. Reservations must be
atomic in Oracle. Retry uses bounded exponential backoff with jitter and stops after five attempts.
SMTP acceptance is not delivery or reading. An interrupted/ambiguous submission is
`outcome-unknown` and may have produced a duplicate; exactly-once email is not promised. Automated
bounce and delivery tracking are deferred.

## Local development

Node.js 24 is used by the current toolchain.

```bash
npm ci
npm run typecheck
npm run test:core
npm test
npm run build
# Manual role entrypoints (local only, no deployment from this repo):
PROCESS_ROLE=api npm exec tsx src/runtime/api.ts
PROCESS_ROLE=scheduler npm exec tsx src/runtime/scheduler.ts
PROCESS_ROLE=email-worker npm exec tsx src/runtime/email-worker.ts
# Manual migration/bootstrap helpers:
PROCESS_ROLE=scheduler npm exec tsx src/runtime/migrate.ts
PROCESS_ROLE=scheduler npm exec tsx src/runtime/bootstrap.ts <workspace-id> <workspace-name> <invite-email>
```

Tests use no credentials, SMTP, Oracle, DNS, HTTP targets, or cloud resources. The React build emits
static files under ignored `dist/`.

Configuration names are shown in `.env.example` with dummy values. Never commit an `.env`, Oracle
wallet, app password, token, recipient address, or cloud credential. The probe role rejects database
and email credentials. Heartbeat token paths must be redacted from reverse-proxy access logs and
must never appear in application logs, traces, error reports, analytics, or UI history.

## Oracle schema and API

- [`migrations/001_mvp.sql`](migrations/001_mvp.sql) contains versioned Oracle DDL. It has not been
  executed against Oracle. Review identifiers, JSON checks, timestamp bindings, conditional unique
  indexes, wallet/connectivity, and the documented `FOR UPDATE SKIP LOCKED` claim transaction on the
  exact existing service first.
- [`docs/openapi.yaml`](docs/openapi.yaml) documents reminder CRUD/preview/pause/resume,
  subscriptions, services/monitors, authorization, rotation, test checks, maintenance, incidents,
  notification history, authentication, and ingestion. Current implementation covers invite verify,
  sign-out, reminders list/create/edit/pause/resume/delete + preview, recipients list/subscription
  updates, services list/create, push monitor list/create/rotate, dashboard, scheduler, and
  email-worker vertical slice. Deadline-evaluator incident/recovery orchestration remains incomplete.

All owned rows carry `workspace_id`; composite foreign keys prevent cross-workspace references.
Every runtime query must be workspace-scoped and parameter-bound. Optimistic edit and schedule/config
versions are distinct from push deadline versions.

## Manual production prerequisites (do not execute from this repository)

1. Validate that the existing GCP VM, public IP, Oracle Always Free service, traffic, storage, and
   Gmail use remain within account-specific limits. “Free” is an intent, not a guarantee; there is no
   paid fallback.
2. Configure a trusted HTTPS origin and proxy headers. Bind API, scheduler, email worker, and
   internal probe job/result interfaces privately by default.
3. Create separate least-privilege Oracle users. Only the email worker receives Gmail SMTP
   credentials; only the probe process receives network jobs, never Oracle or Gmail credentials.
4. Put secrets outside environment files in the public repository. Configure TLS to Gmail on 587
   (STARTTLS) or 465 using an app password, not Gmail API/OAuth.
5. Independently validate probe egress restrictions and pinned-address connection behavior before
   implementing/enabling execution. Deny deployment, internal, metadata, private, reserved,
   loopback, link-local, and multicast destinations on every resolution.
6. Configure a supervisor for separate roles, roughly 10-second due scans, bounded concurrency,
   lease reclamation, readiness and metrics. The objectives (not guarantees) are 99% of due reminders
   queued within 60 seconds and heartbeat evaluation lag at most 30 seconds under normal load.
7. Arrange independent external monitoring for public ingress before relying on push coverage.

Initial unvalidated pilot limits are 10 users, 50 reminders, 10 pull monitors, 10 push monitors, and
five-minute checks (one-minute hard minimum for pull). Suggested configurable retention is seven
days for raw observations, 90 days for incidents/notifications, and 180 days for audit events.
Deletion revokes tokens and queued work immediately; target live-data purge is within 30 days.
Backups, disaster recovery, RPO/RTO, and tested restore are explicitly deferred.

No live Oracle migration execution, live SMTP delivery, network probing, load, failover, or
deployment validation has been performed in this task. Do not merge or deploy until those
prerequisites and the remaining contract-only endpoints are reviewed and completed.
