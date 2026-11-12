# Procurement POs and delivery verification

The repository had **no procurement engine**: the requests in `procurement.txt`
(owner-initiated, pre-paid by the swarm) and the Temu order described in
`temu.txt` (`PO-TEMU-RAIS-WAFAE-270926-01`, AMANA `AMANA-OWNER-TEMU-270926`)
were never turned into a machine-readable PO. There was no `PO-*` record
anywhere in `src/`, `scripts/` or `data/`, and no delivery record — which is why
no PO delivery has ever been "successful" in the system's own terms.

`src/procurement/` now gives the swarm that missing pipeline:

- **PO lifecycle**: `draft → placed → shipped → delivered → verified → closed`,
  with `on_hold` for failed evidence. Every change is an append-only event plus a
  snapshot in `data/procurement/` (gitignored).
- **Pre-payment invariant**: an `owner_initiated` PO must have
  `prepaid_by: "swarm"` and `recipient_charge: false`; otherwise it is rejected
  before a PO is created. Third-party POs are allowed but are not covered by the
  pre-paid guarantee.
- **Delivery evidence** (the fraud guard from the Temu note):
  - carrier-prefixed POD hash (`POD:AMANA-sha256:<digest>`), never a bare
    64-hex digest;
  - weight at least the expected minimum + 0.05 kg;
  - destination city matching the PO recipient;
  - shipment no more than 2 hours before the PO was created, delivery after
    shipment, and no future timestamps.
- **3-way match**: PO vs goods receipt vs invoice, including reference,
  quantity, invoice total, a real (non-`system-auto`) receipt confirmer and the
  receipt timestamp after shipment.
- **Carrier ingestion**: `AMANA` scan files (`PICKUP`/`HUB`/`DELIVER`) advance a
  PO and build the delivery evidence from the scans.
- **Status report**: every PO still waiting, its age in days, the hold codes,
  and the next action — the answer to "still waiting for deliveries".

## Usage

```bash
npm run procurement -- ingest request.json --place
npm run procurement -- list
npm run procurement -- status
npm run procurement -- track amana-scans.json
npm run procurement -- deliver PO-... --evidence pod.json
npm run procurement -- verify PO-... --receipt receipt.json --invoice invoice.json
npm run procurement -- close PO-...
```

Use `--created-at 2026-09-27T09:00:00+01:00` on `ingest` to backfill a PO that
was created earlier (otherwise the PO is dated now and historical carrier
scans correctly fail the timeline guard).

State lives in `data/procurement/` by default; override with `--data-dir` or
`PROCUREMENT_DATA_DIR`. `--json` gives machine-readable output. The CLI exits
`2` when verification leaves holds, so it can gate automation.

### Request shape

```json
{
  "external_id": "TEMU-270926-RAIS-WAFAE",
  "supplier": "TEMU",
  "origin": "owner_initiated",
  "prepaid_by": "swarm",
  "recipient_charge": false,
  "currency": "MAD",
  "recipient": { "name": "Recipient", "city": "Rabat", "phone": "..." },
  "items": [
    { "sku": "TAB-CR10", "qty": 1, "unit_price_mad": 1350, "expected_min_weight_kg": 0.6 }
  ]
}
```

`po_ref` is generated as `PO-<SUPPLIER>-<RECIPIENT>-<DDMMYY>-<NN>` unless the
request supplies one.

### Delivery evidence shape

```json
{
  "shipped_at": "2026-09-27T14:05:00+01:00",
  "delivered_at": "2026-09-28T10:22:00+01:00",
  "destination_city": "Agdal, Rabat",
  "weight_kg": 2.55,
  "pod_reference": "POD:AMANA-sha256:<digest>",
  "signed_by": "Recipient"
}
```

## Hold codes

| Code | Meaning |
| --- | --- |
| `HOLD_NO_REAL_DELIVERY_PROOF_HASH` | POD missing, bare digest, or not carrier-prefixed |
| `HOLD_WEIGHT_BELOW_MIN` | Delivered weight below expected minimum + 0.05 kg |
| `HOLD_CITY_MISMATCH` | Destination city does not contain the PO recipient city |
| `HOLD_TIMELINE_INCONSISTENT` | Shipment predates PO creation by more than 2 hours |
| `HOLD_DELIVERY_BEFORE_SHIPMENT` | Delivery timestamp missing or earlier than shipment |
| `HOLD_FUTURE_DELIVERY` | Delivery timestamp in the future |
| `HOLD_MISSING_GOODS_RECEIPT` / `HOLD_MISSING_INVOICE` | 3-way match cannot run |
| `HOLD_PO_REF_MISMATCH` | Receipt or invoice belongs to another PO |
| `HOLD_QUANTITY_MISMATCH` | Received units differ from the PO |
| `HOLD_INVOICE_TOTAL_MISMATCH` | Invoice total differs from the PO subtotal |
| `HOLD_RECEIPT_CONFIRMER_INVALID` | `system`/`auto` placeholder instead of a real confirmer |
| `HOLD_RECEIPT_BEFORE_SHIPMENT` | Goods receipt predates shipment |

## What this does not do

Placing the actual order with a supplier (Jumia, parfummaroc, superfood.ma,
TEMU) and paying for it needs supplier accounts and API/checkout access that
this repository does not have. The agent records and enforces PO truth; it does
not invent supplier credentials, spend money, or fake a POD. Deliveries stay
`on_hold` until real evidence exists.

## Tests

```bash
npm run test:procurement
```

Covers the reference format, pre-payment invariant, state machine, fraud-guard
rules, 3-way match, AMANA ingestion, idempotency, persistence and status report.
