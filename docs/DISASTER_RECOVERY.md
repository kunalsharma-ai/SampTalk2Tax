# Backups and disaster recovery (SEC-021, SEC-022)

Talk2Tax keeps everything in one MongoDB database (ledgers, documents, attachments, audit trail,
settings). Recovering Talk2Tax means recovering that database, plus the server settings (the
environment variables in [DEPLOYMENT.md](DEPLOYMENT.md)) and the keys that open what is encrypted.

## What is backed up, and how

`node dist/db/backup.js` (in the API image, or `apps/api` after a build) is the backup command.
It runs outside the API, from your scheduler (cron, a Kubernetes CronJob, a CI schedule).

| Command | What it does |
| --- | --- |
| `create --out /backups [--keep 14]` | Writes every collection of `MONGODB_URL`, with its validation rules and indexes, to `/backups/talk2tax-<db>-<time>.t2tbak`, read from one snapshot so the collections agree with each other. Keeps the newest 14 files when `--keep` is given. |
| `verify --in <file>` | Reads the file end to end: the key, the SHA-256 of its contents and the count of every collection. Writes nothing. |
| `drill --in <file> [--scratch-url <url>]` | A restore drill: restores the file into a new scratch database (on the same server unless `--scratch-url` names another), checks each collection holds what the backup says, then drops the scratch database. |
| `restore --in <file> --to-url <url>` | Restores into the database `<url>` names, which must be empty. The file is checked in full first, so a damaged or altered file writes nothing. |

Each run (passed or failed) is recorded in `backup_runs` in the database `MONGODB_URL` names and
shown under **Platform admin → Backups**. The record cannot be changed or deleted.

* **Encryption.** Files are encrypted with AES-256-GCM, with a key derived from
  `BACKUP_ENCRYPTION_KEY` (at least 16 characters) by scrypt; any change to a file is detected.
  `create` refuses to write without the key unless `--unencrypted` is given. Files are created
  readable by their owner only (0600).
* **Format.** Gzip-compressed lines of MongoDB Extended JSON (canonical), so decimals (money),
  dates and file bytes come back exactly. Restoring needs Talk2Tax's backup command, not
  `mongorestore`.
* **Consistency.** The command reads from a MongoDB snapshot, which MongoDB keeps for
  `minSnapshotHistoryWindowInSeconds` (300 s by default). A backup that takes longer fails with
  "The backup took longer than MongoDB keeps a snapshot"; raise that server parameter, or use your
  provider's snapshots (below) for very large databases.

## Schedule and targets

| | Default | Setting |
| --- | --- | --- |
| Backup | Daily; overdue after 26 hours | `BACKUP_MAX_AGE_HOURS` (0 turns the check off) |
| Restore drill | Monthly; overdue after 35 days | `RESTORE_DRILL_MAX_AGE_DAYS` |
| Recovery point objective (RPO) | 24 hours with daily backups alone; minutes with provider point-in-time recovery | |
| Recovery time objective (RTO) | About 1 hour for a database of a few GB: new database, restore, migrations, start | |

An overdue backup or drill is shown on the Backups page and, on a production server, as a problem
in **System health**.

Recommended in production, alongside the command:

* **Point-in-time recovery from your MongoDB provider** (MongoDB Atlas continuous backup, or
  oplog-based backups for a self-run replica set). The backup command is the portable,
  provider-independent copy; the provider's backups close the gap between daily files.
* **Copies off the server.** Copy each file to object storage in another region with versioning
  and a retention lock (for example S3 Object Lock), then run `verify` against the copy.
* **The key kept apart.** Store `BACKUP_ENCRYPTION_KEY` in your secrets manager, not next to the
  backups. Without it the backups cannot be read.

Example daily job with the API image:

```sh
docker run --rm --user "$(id -u)" -v /srv/talk2tax-backups:/backups \
  -e MONGODB_URL -e BACKUP_ENCRYPTION_KEY \
  talk2tax-api:<tag> dist/db/backup.js create --out /backups --keep 14
```

## Recovering from a disaster

1. **Declare it and stop writes.** Turn on maintenance under Platform admin → Maintenance (or stop
   the API containers if the API is down), so nothing writes to a database you are about to
   replace.
2. **Pick the backup.** The newest file that passed `verify` (or a provider point-in-time copy if
   the damage is recent). Note its time: work after it is lost unless your provider's recovery
   covers it.
3. **Make an empty database** (a new cluster in another region if the region is lost), reachable
   over TLS.
4. **Restore:** `MONGODB_URL=<any reachable database> BACKUP_ENCRYPTION_KEY=... node dist/db/backup.js restore --in <file> --to-url mongodb+srv://.../talk2tax`
5. **Apply migrations** to the restored database: `MONGODB_URL=<new url> node dist/db/migrate.js`.
   It says "Nothing to apply" if the backup was taken on this release.
6. **Point the API at it** (`MONGODB_URL`), keeping `JWT_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`
   and any previous keys (`INTEGRATIONS_PREVIOUS_ENCRYPTION_KEYS`) exactly as before: integration secrets and
   two-step settings in the backup are sealed with them. Start the API and web app.
7. **Check:** System health is healthy, a few organisations' trial balances match what users
   expect, and sign-in works. Then end maintenance and tell customers what was lost, if anything.
8. **Afterwards:** take a fresh backup of the new database and record what happened.

Signed-in sessions survive a restore only if they existed at backup time; people may need to sign
in again.

## What is not covered

* Talk2Tax does not move backup files off the server or schedule the command itself; that is the
  operator's scheduler and storage.
* No incremental backups: each file is a full copy.
* Restores are of the whole database. Bringing back one organisation's data means restoring into a
  scratch database and copying from it by hand.
