# Disaster Recovery & Business Continuity

## Overview
This document outlines the procedures for recovering the Swarm Financial System in the event of data loss, corruption, or catastrophic failure.

## Backup Strategy

### Automated Backups
- **Script**: `scripts/system-backup.mjs`
- **Frequency**: Daily (Recommended cron job)
- **Scope**:
  - `data/`: All ledgers, queues, and market data.
  - `config/`: Agent configurations.
  - `exports/`: Generated settlement artifacts.

### Execution
Backups contain bank details and payout records and are encrypted at rest.
Set `DATA_ENCRYPTION_KEY` (or `DATA_ENCRYPTION_KEY_FILE`) first:
```bash
DATA_ENCRYPTION_KEY='...' npm run backup
```
*Creates a timestamped directory of AES-256-GCM encrypted `.enc` files in
`backups/YYYY-MM-DD-HH-mm-ss/`; the key is never included.*

Restore with:
```bash
DATA_ENCRYPTION_KEY='...' npm run restore:backup -- \
  --backup backups/2026-01-04-12-00-00 --out /tmp/swarm-restore
```
See [DATA_AT_REST.md](DATA_AT_REST.md) for migration, rotation and key handling.

## Recovery Procedures

### Scenario 1: Ledger Corruption
1. **Stop the Swarm**: `Ctrl+C` or `pm2 stop all`.
2. **Locate Backup**: Find the most recent valid snapshot in `backups/`.
3. **Restore**:
   ```bash
   DATA_ENCRYPTION_KEY='...' npm run restore:backup -- \
     --backup backups/2026-01-04-12-00-00 --out /tmp/restore
   cp /tmp/restore/data/financial/settlement_ledger.json data/financial/
   ```
4. **Verify**: Run `scripts/check-settlement-status.mjs` to ensure integrity.
5. **Restart**: `npm start`.

### Scenario 2: Total System Loss
1. **Clone Repository**: `git clone <repo_url>`
2. **Restore Environment**: Re-create `.env` from secure storage (LastPass/1Password).
3. **Restore Data**: Decrypt the latest backup with `npm run restore:backup` and copy the verified output into the project root.
4. **Install Dependencies**: `npm install`
5. **Run Integrity Check**: `npm test`

## Bunker Mode
In case of internet censorship or API blocking (403/451):
1. System automatically enters **Bunker Mode**.
2. All transactions are QUEUED locally.
3. `Doomsday Export` is triggered to save state to local disk.
