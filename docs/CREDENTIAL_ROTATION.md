# Credential Exposure Rotation Checklist

Use this when a credential has appeared in an export, log, backup, commit, or
message. Do not paste the exposed value into tickets, chat, or this repository.

## 1. Contain

- [ ] Stop exports, ticks, and deployments that use the affected credential.
- [ ] Remove the file from shared drives, CI artifacts, and chat attachments.
- [ ] Preserve a private incident note with the file path and discovery time —
      not the credential value.

## 2. Rotate at the provider

- [ ] Open the PayPal Developer Dashboard for the affected application.
- [ ] Revoke the exposed client secret and generate a new one.
- [ ] Rotate the client ID too if it was exposed alongside the secret.
- [ ] Review recent API activity and login history for unexpected calls.
- [ ] Repeat for any other provider whose key was stored in the same export
      (the repository scan also found Bitget and Binance keys under `exports/`).

## 3. Replace every copy

- [ ] Update the local `.env` (gitignored, mode `0600`).
- [ ] Update Vercel project environment variables.
- [ ] Update GitHub Actions repository secrets.
- [ ] Update Base44 or other external stores that receive the same credentials.
- [ ] Search deployment manifests, CI variables, and password managers for the
      old value; remove the old entries.

## 4. Verify

- [ ] Redeploy or restart every service that reads the credential.
- [ ] Confirm `/health` and the PayPal token exchange succeed without printing
      the credential.
- [ ] Send a signed webhook test and confirm signature verification.
- [ ] Run a capped sandbox or canary transaction before restoring live volume.
- [ ] Confirm the old credential no longer authenticates.

## 5. Clean the repository

- [ ] Redact the value from every tracked file, including exports, ledgers,
      backups, notes, and doomsday dumps.
- [ ] Run the export guard test:
      `node --test test/export-secrets.test.mjs`.
- [ ] Search the full working tree and Git history for the old value.
- [ ] If the repository or any clone is public, treat the credential as
      compromised even after redaction.
- [ ] Purge history only with an approved, coordinated rewrite
      (`git filter-repo` or BFG), then force-push and re-clone.
- [ ] Invalidate CI caches and old artifacts that may still contain the value.

## 6. Prevent recurrence

- [ ] Route every mission/export write through
      `src/security/export-sanitizer.mjs`.
- [ ] Keep the repository-wide export and secret scans in the test suite.
- [ ] Run the full tracked-file scan before pushing:
      `npm run security:scan`.
- [ ] Enable the pre-commit hook once per clone:
      `npm run security:hooks`.
- [ ] Keep the `Secret Scan` GitHub workflow enabled for pushes and pull
      requests.
- [ ] Never place real credentials in mission parameters, titles, examples, or
      completion notes.
- [ ] Prefer secret references (`${PAYPAL_CLIENT_SECRET}`) over literal values.
- [ ] Rotate on a schedule and after any staff, contractor, or agent access
      change.
