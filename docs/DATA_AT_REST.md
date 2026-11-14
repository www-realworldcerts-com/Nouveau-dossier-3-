# Data at rest: financial data and backups

Bank details, IBANs, payout recipients and settlement records are encrypted with
**AES-256-GCM** before they are written to disk. Ciphertext is authenticated, so
a modified value fails to decrypt instead of being used as a payment destination.

The implementation lives in:

- `src/security/data-at-rest.mjs` — field encryption, key loading, atomic writes
- `src/security/backup-crypto.mjs` — encrypted backup directories and restore
- `scripts/encrypt-sensitive-data.mjs` — dry-run-first migration/rotation/rollback
- `scripts/system-backup.mjs` and `scripts/restore-backup.mjs`

## Key management

The key is never committed and never written by this repository. Prefer a
Docker/Kubernetes secret file:

```bash
# Generate once, then store it in your secret manager. Do not commit it.
openssl rand -base64 32
```

Set one of:

```bash
export DATA_ENCRYPTION_KEY='<base64 or 64-char hex key>'
# or
export DATA_ENCRYPTION_KEY_FILE=/run/secrets/data_encryption_key
```

For rotation, keep the old key available while re-encrypting:

```bash
export DATA_ENCRYPTION_KEY_PREVIOUS='<old key>'
```

`DATA_ENCRYPTION_KEY_PREVIOUS` accepts one key, a comma-separated list, or a
JSON array. Decryption tries the current key and then each previous key; write
operations always use the current key.

## What is encrypted

Fields are encrypted by semantic name, not by file. This preserves IDs, amounts,
statuses and reconciliation keys so runtime code can still process records:

- `iban`, `rib`, `swift`, `bic`, bank account numbers, sort/routing codes
- `recipient`, `payee`, `beneficiary`, `bank`, `paypal`/`payoneer` identities
- personal emails and phone numbers
- bank/account holder/beneficiary names
- destination objects or destination strings

The payout ledger, settlement ledger and payout-history batches decrypt on read
and encrypt on write when a key is configured. A missing or wrong key on an
encrypted record fails closed; payout history is never silently treated as empty.

Useful commands:

```bash
# Read-only audit, no key required to count plaintext fields
npm run encrypt:data -- --root data/financial

# Encrypt existing financial JSON; writes an encrypted copy first
DATA_ENCRYPTION_KEY='...' npm run encrypt:data -- --apply

# Roll back encrypted fields to plaintext (for emergency recovery)
DATA_ENCRYPTION_KEY='...' npm run decrypt:data

# Re-encrypt with a new key after rotation
DATA_ENCRYPTION_KEY='<new>' DATA_ENCRYPTION_KEY_PREVIOUS='<old>' \
  npm run encrypt:data -- --rotate

# Verification: report any sensitive plaintext still present
npm run encrypt:data -- --verify
```

The default migration roots are `data/financial`, `data/autonomous/ledger`,
`data/fallback`, `data/finance/payouts` and `backups`. Pass `--root` to narrow a
run. `--apply` and `--rotate` first write an encrypted backup of every original
file under `backups/encryption-migration-<timestamp>/`. Dry-run and `--verify`
never print field values, only paths and counts.

### Migration order

1. **Back up the key** in the secret manager and test restoring one record in a
   non-production copy.
2. Run the read-only audit and review the file list and field counts.
3. Deploy the key to every process that reads or writes the financial stores.
4. Run `--apply` during a maintenance window. The app can read encrypted values
   after the key is present.
5. Run `--verify`, then exercise payout export, statement import and
   reconciliation against a copy or sandbox.
6. Keep the previous key until every old ciphertext has been rewritten with
   `--rotate`.

Do not delete plaintext originals until the encrypted copies have been restored
and verified at least once.

## Backups

`npm run backup` now refuses to run without a key and writes only encrypted
files (`<backup>/<relative-path>.enc`) plus an encrypted manifest. The
autonomous daemon's entity backup writes `.json.enc` files too.

```bash
DATA_ENCRYPTION_KEY='...' npm run backup
DATA_ENCRYPTION_KEY='...' npm run restore:backup -- \
  --backup backups/2026-01-01T00-00-00-000Z --out /tmp/restore
```

Restore refuses to overwrite existing files unless `--force` is supplied and
rejects path traversal. Backups contain bank and payout data, so the previous
plaintext backups in the repository must be treated as exposed: rotate any
account details that were committed and purge them from Git history rather than
only deleting the files in a new commit.

## Remaining source literals

Encryption cannot protect a bank account that is hardcoded in JavaScript.
`src/policy/RecipientRegistry.mjs` still contains owner account identifiers.
They must be moved to an environment/secret-manager lookup or an encrypted
configuration file, then removed from the working tree and from Git history.
The same applies to account numbers in older documentation, changelogs and
exports. Rotating those accounts is the only reliable response once the
repository has been pushed.
