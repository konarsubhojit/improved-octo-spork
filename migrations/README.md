# Oracle migrations

`001_mvp.sql` targets Oracle Autonomous Transaction Processing and intentionally does not provision a
database. Apply it manually with a migration-only account, then grant the runtime roles only the
tables and operations each role needs.

The scheduler claim transaction should select due `jobs` using
`FOR UPDATE SKIP LOCKED`, increment `fence`, set a bounded `lease_until`, and commit before processing.
Every result update must match `job_id`, `lease_owner`, and `fence`; expired leases are reclaimable.
This pattern requires validation against the exact existing Oracle service before production use.

No down migration is supplied because it would destroy live data. Backups, RPO/RTO, and restore
testing are intentionally deferred.
