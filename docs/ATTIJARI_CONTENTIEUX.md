# Attijari transfers and procurement contentieux

Two different problems share the same bank context: getting money out through
Attijariwafa, and pursuing suppliers for orders that were paid but not delivered.

## Attijari CSV transfers

`attijari.txt` records that the account is an **Attijari Particulier** account.
Bulk CSV transfer (virements de masse) is an **Attijari Entreprise / Cash
Management** feature. A personal Attijarinet account cannot upload a bank-wire
CSV: transfers are unit operations, or the owner must ask the branch whether a
small-business package is available.

The generator is therefore an export tool, not a payment method:

```bash
export ATTIJARI_ACCOUNT=<account digits>       # never commit it
npm run attijari:csv -- --batch data/autonomous/ledger/payout_BATCH_<id>.json --dry-run
npm run attijari:csv -- --batch data/autonomous/ledger/payout_BATCH_<id>.json
```

It validates account length, positive amounts, a single currency per file and
required references, escapes descriptions, and writes
`exports/bank-wire/bank_wire_<batch_id>.csv`. The account is masked in output.
`--dry-run` validates without writing.

**Do not** treat a generated CSV as proof of payment. There is no Attijari API
integration in this repository, so a transfer is only confirmed by the bank
statement or the beneficiary. Keep the batch file, CSV and bank receipt together
as the payment evidence.

### Payout ledger and statement import

Every exported item is reserved in `data/financial/payout_ledger.json` by both
its `earning_id` and `item_id`. A second export that reuses either identifier is
refused, including a reused identifier found in any existing file under
`data/autonomous/ledger/`. This closes the double-payment gap in the batch
exporter.

```bash
# export records each item as submitted
npm run attijari:csv -- --batch payout.json --dry-run   # validates + duplicate check
npm run attijari:csv -- --batch payout.json             # writes CSV + ledger

# import a bank/Payoneer statement and settle the matching payouts
npm run import:payout-statement -- --source attijari --file statement.csv --dry-run
npm run import:payout-statement -- --source payoneer --file transactions.csv
```

Matching is **reference first**: a statement reference or description containing
the payout reference/`item_id`/`earning_id` wins. Only when no reference matches
is amount + currency + date window (default 10 days) used, and only if exactly
one submitted payout fits. Ambiguous rows are reported and never applied.

Supported statuses and transitions:

| Statement status | Ledger status | Allowed from |
| --- | --- | --- |
| credited | `credited` | `submitted` |
| failed | `failed` | `submitted` |
| returned | `returned` | `submitted` or `credited` |

`settlements[]` on each payout stores the statement line, source, amount,
currency, fee, net amount, FX rate, FX difference and amount difference. Fees are
also summed in `fees[]`. `fx_rate` is the statement row's rate when supplied,
otherwise the derived `statement amount / payout amount`; `fx_difference` is
`statement amount - payout amount * fx_rate` and is only present when the
statement supplied a rate. Re-importing the same row is skipped by fingerprint.

Statements may be CSV (comma, semicolon or tab) or JSON arrays. Common Attijari
and Payoneer headers are recognised automatically; `--map` accepts a JSON object
such as `{"reference":"Reference ID","amount":"Montant"}` for other exports.
`--no-history` is for isolated tests only: it disables the cross-batch check.

The importer is read-only toward the bank: it never sends a transfer, and a
statement row is operational evidence, not a legal admission.

Because the primary account is personal and cannot use bulk files, the practical
alternatives recorded in `attijari.txt` are:

1. unit transfers through Attijarinet, or
2. Payoneer as the receiving/settlement rail (the notes list a primary and a
   fallback account).

Whichever rail is used, do not record a payout as settled until the receiving
account shows the funds.

## Procurement contentieux

`npm run contentieux` builds a dispute case file from purchase orders that are
late, held, or delivered without verification:

```bash
npm run contentieux -- --min-days 7
npm run contentieux -- --json --out exports/contentieux.json
npm run contentieux -- --out exports/contentieux.md
```

Rules:

- `on_hold` POs are always included; other statuses are included after
  `--min-days` (default 7).
- Each case gets an ID (`CTX-<po_ref>`), the amount at stake in MAD, the waiting
  time, the hold meanings, an evidence checklist and the next action.
- Severity is `high` for holds, amounts of 2000 MAD or more, or 30+ days;
  `medium` for 500 MAD or 14+ days; `low` otherwise.
- The report is read-only. It never advances a PO, records a POD or closes a PO.
- Evidence must come from the carrier/supplier. The generator will not fill in a
  POD, weight or receipt to make a case look complete.

The operational escalation is: request the missing evidence in writing, keep the
PO open, then either obtain delivery or claim a refund. A supplier claim should
quote the `PO` reference, supplier, amount, order date, tracking number and the
specific missing evidence. For a bank dispute (for example a transfer that left
the account but was not credited), use the bank's contentieux service with the
transfer reference, date, amount, beneficiary and the bank statement line.

This is an operational record, not legal advice.
