import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    appendAudit,
    heartbeatAgeMs,
    heartbeatPath,
    missingLiveEnv,
    readHeartbeat
} from '../swarm/loop-health.mjs';
import { ProcurementStore } from '../procurement/store.mjs';
import { evaluatePo } from '../procurement/po.mjs';
import { buildContentieuxCases } from '../procurement/contentieux.mjs';
import { RedressEngine } from './redress.mjs';
import { probeVerdictHint } from './webhook-probe.mjs';
import { storefrontVerdictHint } from './storefront-probe.mjs';
import { readLedgerRecords } from '../real/ledger/reversals.mjs';
import {
    exportedClaimsAwaitingConfirmation,
    openPayoutClaims,
    readPayoutClaims
} from '../financial/payout-claims.mjs';
import {
    SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH,
    SETTLEMENT_EVIDENCE_UNBOUND,
    openSettlementBlocks,
    readSettlementBlocks
} from './settlement-blocks.mjs';

/**
 * Silent-failure ("faillite silencieuse") protocol.
 *
 * Silent failure is the failure mode this repository has actually suffered:
 * the loop stopped, nothing recorded it, no alarm fired, and the absence of a
 * signal was mistaken for the absence of a problem. This module treats a
 * missing, stale or blocked signal as a finding, quantifies the obligations
 * that are not being met, and produces a redress plan with an owner action,
 * a deadline and a verification step for every finding.
 *
 * It never moves money. Monetary redress stays owner-gated.
 */

export const SEVERITY_RANK = { low: 1, warning: 2, medium: 2, high: 3, critical: 4 };
export const DEFAULT_MAX_SILENCE_MIN = 90;
export const DEFAULT_STALL_DAYS = 7;
export const DEFAULT_EXPORT_CONFIRM_DAYS = 3;
export const DEFAULT_SILENCE_BUDGET_HOURS = 24;
export const DEFAULT_REVERSAL_WINDOW_DAYS = 30;

export const FINDING_CATALOG = {
    LOOP_HEARTBEAT_MISSING: {
        domain: 'operations',
        severity: 'critical',
        title: 'Swarm loop has never recorded a heartbeat',
        impact: 'No tick is proven to run: sales, payouts and PO tracking are all unowned.',
        containment: 'Treat every autonomous claim as stale; no settlement may be reported as successful.',
        obligation: 'Restore a scheduled loop and prove it with a fresh heartbeat.',
        remedy: 'Configure the live environment, run a bounded tick, confirm the heartbeat file is fresh.',
        mitigation: 'Dead-man switch: the tick workflow fails when the heartbeat is older than 90 minutes.',
        verification: '`node scripts/swarm-tick.mjs --check-only` exits 0.',
        owner_action: 'Set live credentials and run `npm run swarm:tick`.',
        sla_hours: 1
    },
    LOOP_HEARTBEAT_STALE: {
        domain: 'operations',
        severity: 'critical',
        title: 'Swarm loop heartbeat is stale',
        impact: 'The loop may have stopped silently; nothing is executing or earning.',
        containment: 'Fail the pipeline, page the owner and block money-moving tasks.',
        obligation: 'Restart the loop and record why it stopped.',
        remedy: 'Inspect the last tick log, fix the failing step, run a tick and confirm the heartbeat.',
        mitigation: 'Scheduled workflow with `--check-only --max-silence-min 90` plus the supervisor backoff.',
        verification: 'A heartbeat younger than the silence budget exists and the next scheduled tick succeeds.',
        owner_action: 'Run `npm run swarm:doctor`, then `npm run swarm:tick`.',
        sla_hours: 1
    },
    LOOP_BLOCKED: {
        domain: 'revenue',
        severity: 'high',
        title: 'Loop ticks but is blocked from earning',
        impact: 'The system looks alive — fresh heartbeat, green process — while no revenue or delivery can happen.',
        containment: 'Label the loop "running but non-earning"; stop reporting healthy status.',
        obligation: 'Provide the missing configuration so ticks can execute revenue work.',
        remedy: 'Add the missing environment variables/secrets listed in the evidence, then run a live tick.',
        mitigation: 'Doctor preflight and this sentinel classify blocked ticks as findings, not success.',
        verification: 'A tick reports `ok` with `revenue_enabled: true` and missing_env empty.',
        owner_action: 'Set the missing secrets and rerun the tick workflow.',
        sla_hours: 4
    },
    REVENUE_STALL: {
        domain: 'revenue',
        severity: 'high',
        title: 'No confirmed revenue for longer than the stall window',
        impact: 'Operating costs and pre-paid obligations continue while inflow is zero: the definition of silent bankruptcy.',
        containment: 'Halt new settlements and require a capital-efficiency audit before resuming.',
        obligation: 'Restore a revenue path or stop incurring obligations.',
        remedy: 'Audit pricing/publish/checkout, publish approved offers, verify a real payment and record it.',
        mitigation: 'Velocity-without-revenue circuit breaker in the self-redress engine.',
        verification: 'A new externally confirmed revenue event appears in the ledger within the stall window.',
        owner_action: 'Review the sales pipeline and confirm one end-to-end paid order.',
        sla_hours: 24
    },
    PROCUREMENT_DELIVERY_STALL: {
        domain: 'procurement',
        severity: 'high',
        title: 'Placed purchase orders have not been delivered',
        impact: 'Owner funds are committed and the swarm cannot show a successful delivery.',
        containment: 'Keep the POs open; never mark them delivered without carrier evidence.',
        obligation: 'Obtain delivery or a refund for every stalled PO.',
        remedy: 'Contact the carrier/supplier with the tracking number, ingest scans, record POD, verify 3-way match.',
        mitigation: 'PO delivery evidence gate and AMANA scan ingestion.',
        verification: 'Each stalled PO reaches delivered/verified with POD, weight, city and invoice match.',
        owner_action: 'Provide carrier tracking/POD or escalate the order with the supplier.',
        sla_hours: 48
    },
    PROCUREMENT_CONTENTIEUX: {
        domain: 'procurement',
        severity: 'high',
        title: 'Purchase orders need contentieux action',
        impact: 'Paid or committed orders are late, held or unverifiable, so owner funds are exposed without a delivery.',
        containment: 'Keep every listed case open; do not close a PO or release payment without the missing evidence.',
        obligation: 'Resolve every contentieux case by obtaining delivery or a refund.',
        remedy: 'Open the case file, request the missing evidence from the supplier/carrier, and escalate per the case next action.',
        mitigation: 'Contentieux case generation in every audit, with case IDs, amounts and aging.',
        verification: 'The next audit reports zero contentieux cases and no PO older than the stall window.',
        owner_action: 'Work the high-severity cases first and provide carrier POD or supplier refund evidence.',
        sla_hours: 48
    },
    DELIVERY_UNVERIFIED: {
        domain: 'procurement',
        severity: 'medium',
        title: 'Deliveries recorded without completed verification',
        impact: 'Goods may be missing or short while the PO looks fulfilled.',
        containment: 'Keep the PO on hold; no closure and no payout against it.',
        obligation: 'Complete the 3-way match or reject the delivery.',
        remedy: 'Attach the goods receipt and supplier invoice, resolve holds, re-run verification.',
        mitigation: 'Verified-only closure (`close` requires status verified).',
        verification: '`npm run procurement -- verify` exits 0 and the PO status is verified.',
        owner_action: 'Supply the goods receipt and invoice, or confirm the dispute.',
        sla_hours: 24
    },
    FULFILLMENT_BACKLOG: {
        domain: 'fulfillment',
        severity: 'high',
        title: 'Customer fulfillment queue has aged pending items',
        impact: 'Customers paid but received nothing; silent churn and refund exposure.',
        containment: 'Stop new sales promises until the backlog is cleared.',
        obligation: 'Deliver or refund every pending order.',
        remedy: 'Work the fulfillment queue oldest-first and record proof of delivery/refund.',
        mitigation: 'Backlog age detection in this sentinel.',
        verification: 'No order whose latest queue line is PENDING_DELIVERY is older than the stall window.',
        owner_action: 'Fulfil or refund the oldest pending orders.',
        sla_hours: 48
    },
    FULFILLMENT_QUEUE_STALLED: {
        domain: 'fulfillment',
        severity: 'high',
        title: 'Fulfillment queue stopped advancing',
        impact: 'Orders are still owed delivery, but no attempt, retry or delivery line has been written for longer than the stall window. The drain is not running, is stuck, or keeps skipping the order without recording an attempt, so the queue looks merely old while nothing will move it.',
        containment: 'Treat the drain as down: do not report fulfilment as healthy or the pending orders as progressing, and stop promising delivery dates until it advances again.',
        obligation: 'Restore a drain that appends a queue line for every attempt, and deliver or refund every order still pending.',
        remedy: 'Check that the supervisor/tick runs the fulfilment drain (it drains before the audit) and read its output for the failing step; fix the cause, run `npm run fulfillment:drain -- --apply`, and confirm each order\'s latest queue line moves.',
        mitigation: 'Every drain attempt appends a queue line with attempt bookkeeping, and every audit compares each undelivered order\'s latest line against the stall window.',
        verification: 'No undelivered order outside the pending-delivery backlog has its latest queue line older than the stall window.',
        owner_action: 'Check the drain output and whether the loop is running it, then rerun the drain and confirm the queue advances.',
        sla_hours: 24
    },
    FULFILLMENT_DELIVERY_EXHAUSTED: {
        domain: 'fulfillment',
        severity: 'critical',
        title: 'Paid order stopped being delivered after exhausting its retries',
        impact: 'The buyer was charged, delivery kept failing, and the drain has stopped retrying: without a human the order never delivers, so the customer sees a paid order with no product and a refund or chargeback follows.',
        containment: 'Treat the fulfilment queue as unhealthy while a dead order sits in it; do not report the order as delivered or fulfilled.',
        obligation: 'Deliver the purchased access manually or refund the captured payment.',
        remedy: 'Read the recorded last_reason (payer email, FULFILLMENT_ACCESS_SECRET, Resend), fix the cause, deliver by hand, then append a DELIVERED line for the order id; refund instead if delivery is impossible.',
        mitigation: 'The drain caps retries and writes DELIVERY_EXHAUSTED to the queue; every audit reads the queue and records it as an incident finding, so it is not left in drain/supervisor output only.',
        verification: 'The latest queue line for each order is DELIVERED (or a recorded refund) and the next audit reports no FULFILLMENT_DELIVERY_EXHAUSTED finding.',
        owner_action: 'Deliver or refund the listed orders and record the outcome in the fulfilment queue.',
        sla_hours: 4
    },
    REVENUE_REVERSED_AFTER_FULFILLMENT: {
        domain: 'revenue',
        severity: 'high',
        title: 'A delivered order was refunded, reversed or disputed',
        impact: 'The buyer paid, received the product, and the money was returned. A refund after delivery erases revenue that was already earned, and a dispute or reversal is a chargeback the provider already took back: unanswered, it becomes a permanent loss plus a fee.',
        containment: 'Do not re-charge the buyer or delete the reversal row; treat the delivered order as disputed until the reason is reviewed.',
        obligation: 'Decide whether each reversal is an accepted refund, and answer every dispute with delivery evidence.',
        remedy: 'Read the reversal and its capture row, confirm what was delivered to the buyer, then either accept the refund or submit the access pass, delivery time and support thread to PayPal for the dispute.',
        mitigation: 'Every audit nets reversal rows against their capture and matches them to the fulfilment queue by capture id, so a reversed delivered order is an incident finding instead of only a smaller revenue total.',
        verification: 'Each listed order has a recorded decision (refund accepted or dispute contested) and the next audit reports no REVENUE_REVERSED_AFTER_FULFILLMENT finding for it.',
        owner_action: 'Review the reversed orders and record whether the refund is accepted or the dispute is contested with delivery evidence.',
        sla_hours: 24
    },
    REVENUE_SETTLEMENT_BLOCKED: {
        domain: 'revenue',
        severity: 'critical',
        title: 'A payout succeeded but its revenue row was not marked paid_out',
        impact: 'PayPal paid the recipient while the ledger still says the money is unpaid. The payout is gone and the revenue it settled keeps being counted as outstanding, so every balance and every later payout decision is computed from a row that is already wrong.',
        containment: 'Do not replay the payout and do not hand-edit the revenue row without the provider evidence; treat the row as unknown until it is reconciled.',
        obligation: 'Reconcile the revenue row against the provider payout and record the outcome.',
        remedy: 'Read the recorded reason (self-issued proof, no provider id, gate refusal, update failure), confirm the capture against PayPal, then settle the row through the gated path or correct the proof so the gate can pass.',
        mitigation: 'The webhook appends every refused settlement to data/resilience/settlement-blocks.ndjson and every audit reads it back; a later successful settlement of the same row appends a closing line.',
        verification: 'The listed revenue rows are paid_out with a provider-confirmed proof and the next audit reports no REVENUE_SETTLEMENT_BLOCKED finding.',
        owner_action: 'Reconcile each listed revenue row against the PayPal payout and settle or correct it.',
        sla_hours: 4
    },
    SETTLEMENT_EVIDENCE_UNBOUND: {
        domain: 'revenue',
        severity: 'critical',
        title: 'A revenue row was recorded without the evidence its payout requires',
        impact: 'The buyer paid and the revenue row exists, but the block that authorises paying it out was never written, so the row can never settle through the gated path. The failure used to reach stderr only, which a serverless host discards: the order simply never paid out and no one was told.',
        containment: 'Do not settle the row by hand and do not rebuild the block from the row itself; that is the reconstruction the evidence chain exists to prevent.',
        obligation: 'Bind the evidence from the provider capture and settle the row through the gated path.',
        remedy: 'Confirm the capture against PayPal, fix the evidence-chain volume (EVIDENCE_CHAIN_PATH must be writable and durable), then replay the capture so bindSettlementEvidence writes the block; the row settles normally afterwards.',
        mitigation: 'Capture ingest appends an evidence_unbound line to the settlement block log, and every audit reads that log back; a later settlement of the same row closes it.',
        verification: 'The listed revenue rows have a bound evidence block, are paid_out, and the next audit reports no SETTLEMENT_EVIDENCE_UNBOUND finding.',
        owner_action: 'Check that the evidence-chain volume is writable, then replay the listed captures.',
        sla_hours: 24
    },
    SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH: {
        domain: 'revenue',
        severity: 'critical',
        title: 'A revenue row claims an amount the verified webhook never recorded',
        impact: 'The capture was recorded at an amount PayPal did not confirm, so the evidence its payout is checked against is refused and the row can never settle through the gated path. Binding it would authorise a payment the provider never took, and the revenue total it feeds is wrong.',
        containment: 'Do not settle the row from its own numbers and do not overwrite the amount to make the bind pass; treat the revenue total and any payout decision for this capture as wrong until it is reconciled.',
        obligation: 'Reconcile the revenue row against the verified capture and record the correction with its provider evidence.',
        remedy: 'Read the recorded difference, confirm the capture against PayPal, then correct the ledger to the provider amount (a reversal row plus a corrected capture row, keeping the webhook id as evidence) and replay the capture so bindSettlementEvidence binds the block.',
        mitigation: 'Capture ingest refuses to bind an amount the verified webhook contradicts and appends an evidence_amount_mismatch line to data/resilience/settlement-blocks.ndjson; every audit reads that log back, and a later settlement of the same row closes it.',
        verification: 'The listed revenue rows match their verified capture amounts, have a bound evidence block, and the next audit reports no SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH finding.',
        owner_action: 'Confirm each listed capture against PayPal and correct the revenue row to the provider amount.',
        sla_hours: 24
    },
    PAYOUT_CLAIM_UNRESOLVED: {
        domain: 'revenue',
        severity: 'critical',
        title: 'A settlement batch may have been paid but its outcome was never recorded',
        impact: 'The settlement daemon writes a claim before a rail can move money. This one is still open: the process died, or the rail failed, before any outcome was recorded, so money may already have left while the revenue rows still read unpaid. The daemon withholds those rows, so the revenue stays unsettled and every later payout decision is made from a ledger that may be missing a payment.',
        containment: 'Do not settle or re-pay the listed rows from the ledger, and do not delete the claim. Treat the batch as possibly paid until the provider says otherwise.',
        obligation: 'Reconcile the claimed batch with the provider and record the outcome.',
        remedy: 'Check the provider for the batch and for the listed payout items. If it was paid, record the outcome: a rail batch is settled by recording its payout items so the next daemon cycle marks the rows, while a batch whose CSV file the owner uploaded is confirmed with `node auto_settlement_daemon.js --confirm-payout <batch_id> --note …`, which marks its `export_ready` rows paid_out. Only if nothing was sent, close the claim with `node auto_settlement_daemon.js --resolve-claim <batch_id>` so its rows are payable again.',
        mitigation: 'The daemon claims a batch before calling its rail, reconciles every claim before paying anything and reads payout items as evidence; an unresolved claim is reported here, exposed in daemon health and its rows withheld from every later batch.',
        verification: 'The listed claims are closed, their revenue rows are marked paid_out or export_ready, and the next audit reports no PAYOUT_CLAIM_UNRESOLVED finding.',
        owner_action: 'Check the batch with the provider, then record its payout items, confirm an exported file with --confirm-payout, or close the claim as not sent.',
        sla_hours: 4
    },
    PAYOUT_EXPORT_UNCONFIRMED: {
        domain: 'revenue',
        severity: 'high',
        title: 'An exported payout batch was never confirmed as paid',
        impact: 'The daemon wrote a CSV instruction and stopped, because only a human can upload it. Nobody recorded whether the transfer happened, so the batch\'s revenue rows still read export_ready: if the file was paid, the ledger counts money the owner already received as unsettled, and if it was never uploaded, nobody is paying an obligation the system thinks it has already met.',
        containment: 'Do not export or pay the listed rows again, and do not mark them paid from the daemon\'s guess; treat each batch as unpaid until someone says what happened to its file.',
        obligation: 'Find out whether each exported batch was uploaded and paid, then record the answer against the batch.',
        remedy: 'Open the recorded export file (exports/…), check the owner account for the transfer, then run `node auto_settlement_daemon.js --confirm-payout <batch_id> --note …` if it was paid, or `--resolve-claim <batch_id>` if it was never sent, which releases its rows to be exported again.',
        mitigation: 'Every audit reads the claim store and ages closed manual-CSV claims; a confirmation stamps the claim paid and a not-sent closure removes the batch from the queue, so neither can stay here unnoticed.',
        verification: 'Each listed batch has a paid or not-sent resolution, and the next audit reports no PAYOUT_EXPORT_UNCONFIRMED finding.',
        owner_action: 'Compare the listed export files with the owner account, then confirm or close each batch.',
        sla_hours: 24
    },
    SILENT_EXCEPTION_SWALLOW: {
        domain: 'code',
        severity: 'medium',
        title: 'Empty catch blocks swallow failures',
        impact: 'Errors disappear and components appear healthy while doing nothing.',
        containment: 'Treat swallowed errors as unknown state until logged.',
        obligation: 'Make every failure observable.',
        remedy: 'Log or rethrow inside each empty catch block; never leave a silent catch.',
        mitigation: 'Static scan in this sentinel fails the audit when silent catches exist.',
        verification: 'The scan reports zero empty catch blocks in src/ and scripts/.',
        owner_action: 'Assign each listed file and add logging/rethrow.',
        sla_hours: 72
    },
    AUDIT_BLINDSPOT: { 
        domain: 'governance',
        severity: 'medium',
        title: 'No audit record within the governance window',
        impact: 'Actions cannot be reconstructed; silent failures leave no evidence trail.',
        containment: 'Freeze policy changes until auditing is restored.',
        obligation: 'Record every autonomous action with a timestamp.',
        remedy: 'Restore audit writes on tick/redress paths and backfill the missing window.',
        mitigation: 'Mandatory audit append in the redress engine and freeze release.',
        verification: 'A new audit entry exists within the governance window.',
        owner_action: 'Check that `audits/autonomous/` is writable and the tick is appending.',
        sla_hours: 72
    },
    STOREFRONT_NOT_TRANSACTIONAL: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Storefront has no transactional runtime',
        impact: 'The domain can answer 200 while serving static HTML from a directory with no API routes: checkout and webhook delivery are impossible, so every marketing visit is dead-end traffic.',
        containment: 'Stop treating the live domain as a working sales channel; do not report sales readiness.',
        obligation: 'Deploy the application build to the domain, or wire the static site to a hosted checkout/payment rail.',
        remedy: 'Confirm which Vercel project is attached to the domain; repoint it at the application repository and root, or add hosted payment links and a reachable webhook.',
        mitigation: 'Storefront capability probe on every tick distinguishes a static build from a working application.',
        verification: 'The homepage exposes an application runtime and /api/webhooks/paypal returns 400 invalid_json.',
        owner_action: 'Repoint the Vercel project serving www.realworldcerts.com at the app root, or attach a hosted checkout to the static site.',
        sla_hours: 24
    },
    STOREFRONT_UNREACHABLE: {
        domain: 'revenue',
        severity: 'warning',
        title: 'Storefront reachability could not be verified',
        impact: 'A network error or edge 5xx hides whether the domain can transact. It is not evidence of a broken deployment, but a sustained outage still blocks sales.',
        containment: 'Do not claim the storefront is healthy or broken while reachability is unknown; retry on the next tick.',
        obligation: 'Confirm the domain answers before drawing any conclusion about the deployed build.',
        remedy: 'Check DNS, the Vercel deployment status and upstream errors; rerun the probe once the edge recovers.',
        mitigation: 'Transport failures are retried with backoff and reported separately from deployment findings.',
        verification: 'A later probe returns application or static_only with an HTTP response from the origin.',
        owner_action: 'Check the Vercel deployment/edge status if this persists beyond one tick.',
        sla_hours: 72
    },
    STOREFRONT_HTTP_ERROR: {
        domain: 'revenue',
        severity: 'warning',
        title: 'Storefront answered with an unexpected HTTP status',
        impact: 'The origin responded, so this is not a network blip, but the page or API is not serving the expected 200/404 contract.',
        containment: 'Do not treat the deployment as verified while the unexpected status persists.',
        obligation: 'Identify which layer returns the status and restore the expected response.',
        remedy: 'Check the deployment logs for the storefront and its health routes (/api/healthz, /health); fix the failing page or API.',
        mitigation: 'HTTP errors are reported separately from static builds and from transport failures.',
        verification: 'The homepage returns 200 and a health route returns 200 or 404.',
        owner_action: 'Inspect the Vercel deployment logs for the failing response.',
        sla_hours: 48
    },
    PAYPAL_UNFULFILLED_ORDERS: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Paid PayPal orders are missing fulfilment',
        impact: 'Buyers were charged and PayPal captured the payment, but no delivery was queued. Missed webhooks become silent revenue loss and refund exposure.',
        containment: 'Stop reporting fulfilment as healthy; do not mark these orders delivered.',
        obligation: 'Deliver or refund every captured order that is absent from the fulfilment queue.',
        remedy: 'Run the reconciliation with --apply (idempotent), then deliver each queued order and fix the webhook path that missed it.',
        mitigation: 'Dry-run reconciliation in every tick; any drift is a critical finding.',
        verification: 'A later dry run reports missing_count 0 and every order has a fulfilment record.',
        owner_action: 'Run `npm run reconcile:paypal -- --apply`, then deliver/refund the listed orders.',
        sla_hours: 4
    },
    PAYPAL_RECONCILIATION_UNAVAILABLE: {
        domain: 'revenue',
        severity: 'medium',
        title: 'PayPal reconciliation could not verify fulfilment',
        impact: 'Paid-but-unfulfilled orders cannot be seen, so webhook drift is unknown.',
        containment: 'Do not read "no missing orders" as verified while this check is failing.',
        obligation: 'Restore read access so every captured order can be compared with the queue.',
        remedy: 'Fix PayPal credentials or reporting API access, then rerun the dry run.',
        mitigation: 'A failed reconciliation is recorded as a finding, never silently skipped.',
        verification: 'The reconciliation returns a report with search_error null.',
        owner_action: 'Check PayPal credentials and reporting API access.',
        sla_hours: 24
    },
    PAYPAL_ORDER_PRICE_DRIFT: {
        domain: 'revenue',
        severity: 'high',
        title: 'Captured order price differs from the canonical catalog',
        impact: 'A buyer was charged an amount that no longer matches the price book. That creates refund exposure, customer disputes and a mismatch between revenue and the catalog.',
        containment: 'Do not change catalog or Shopify prices automatically; treat the captured amount as the source of the payment dispute until reviewed.',
        obligation: 'Reconcile every captured order to the canonical price and make the owner-approved refund or adjustment.',
        remedy: 'Review the listed order and capture ids, refund or collect the difference under owner authorization, and fix the stale checkout or price deployment that produced it.',
        mitigation: 'Every tick runs the read-only PayPal reconciliation and the purchase-time price assertion rejects stale checkout amounts before a charge.',
        verification: 'A later reconciliation reports price_mismatch_count 0 and the order amount matches the canonical catalog in its currency.',
        owner_action: 'Review the affected orders and decide whether to refund, collect the difference or accept the captured amount.',
        sla_hours: 4
    },
    PAYPAL_QUOTE_METADATA_DRIFT: {
        domain: 'revenue',
        severity: 'high',
        title: 'Captured order has missing, malformed or stale quote metadata',
        impact: 'A captured order cannot prove which signed catalog revision authorized its checkout. A legacy or bypassed checkout, a corrupted metadata field, or a price book change after order creation is invisible without this evidence.',
        containment: 'Do not rewrite order metadata or prices automatically; treat the affected orders as unverified until the quote or catalog revision is reviewed.',
        obligation: 'Identify why each order lacks valid quote metadata or references a different catalog revision, and decide whether its capture is acceptable.',
        remedy: 'Review the listed order ids, allowlist only genuine pre-quote legacy orders, repair the checkout or deployment that omitted/corrupted the metadata, and rerun reconciliation.',
        mitigation: 'ACP checkout requires a signed quote, stores its id/version/digest in PayPal metadata, and reconciliation reports missing, malformed and stale metadata without changing prices.',
        verification: 'A later reconciliation reports quote_metadata_finding_count 0 for the affected orders, with genuine legacy orders explicitly allowlisted.',
        owner_action: 'Review the quote metadata findings and allowlist only orders created before quote enforcement.',
        sla_hours: 4
    },
    REVENUE_REVERSAL_WITHOUT_CAPTURE: {
        domain: 'revenue',
        severity: 'critical',
        title: 'A refund, reversal or dispute has no matching capture in the ledger',
        impact: 'Money that PayPal returned is still counted as revenue, or a chargeback is invisible: the ledger reports revenue the business no longer holds.',
        containment: 'Do not net the reversal against unrelated revenue; keep the original capture untouched until the missing record is found.',
        obligation: 'Locate or reconstruct the capture the reversal refers to, then record the reversal against it.',
        remedy: 'Run `npm run ledger:reverse -- --event=<paypal-event.json> --apply` once the capture exists, or import the missing capture from PayPal and reverse it.',
        mitigation: 'Every reversal is keyed to the original capture id and unmatched reversals are reported at critical severity, never dropped.',
        verification: 'A later reversal run reports the capture matched and the ledger nets the refund to zero.',
        owner_action: 'Provide the PayPal capture id or replay the original capture webhook, then rerun the reversal.',
        sla_hours: 4
    },
    PAYMENT_WEBHOOK_UNREACHABLE: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Payment webhook cannot deliver to the application',
        impact: 'A buyer can pay and never receive the product: the payment succeeds, fulfilment never runs, and PayPal eventually stops retrying. Silent revenue loss with no alarm.',
        containment: 'Treat webhook fulfilment as unavailable; do not rely on the backup delivery path.',
        obligation: 'Restore a reachable, authenticated webhook endpoint and deliver every missed order.',
        remedy: 'Deploy a build containing the webhook route, configure its credentials, remove or bypass the protection layer, then replay missed notifications.',
        mitigation: 'Public reachability probe expects HTTP 400 invalid_json; 404/401/503 are findings, not benign responses.',
        verification: 'POST not-json to the public webhook URL returns 400, and a signed PayPal sandbox notification is fulfilled idempotently.',
        owner_action: 'Fix the deployment surface (route deployed, protection bypass or preview-only SSO) and verify with the P8 acceptance probe.',
        sla_hours: 4
    },
    CHECKOUT_GATE_BLOCKED: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Deployed checkout gate is blocked',
        impact: 'Every checkout order creation answers 503 before PayPal is called: the store takes no money while the loop, the heartbeat and the deployment all look alive.',
        containment: 'Do not report the storefront as selling; treat every checkout attempt as lost until the gate is open.',
        obligation: 'Restore a checkout whose replay protection is durable, then prove a buyer can start an order again.',
        remedy: 'Mount a volume shared by every instance and point CHECKOUT_ATTEMPT_STORE_DIR at it, or set CHECKOUT_REPLAY_PROTECTION=provider, then redeploy.',
        mitigation: 'Every audit reads the deployed /health gate, so a blocked checkout is a finding in the incident ledger, not only a red workflow run.',
        verification: 'The deployed /health reports blocks_checkout=false and the next audit reports no CHECKOUT_GATE_BLOCKED finding.',
        owner_action: 'Fix the configuration named in block_reason, redeploy, then rerun the tick audit.',
        sla_hours: 4
    },
    MONEY_READINESS_UNCONFIGURED: {
        domain: 'revenue',
        severity: 'critical',
        title: 'Deployed checkout cannot complete a paid order',
        impact: 'The storefront answers and accepts a checkout, but the deployment itself reports it cannot quote, create, capture or deliver a paid order. A buyer can be charged and receive nothing, which is a chargeback and a refund rather than a sale.',
        containment: 'Do not report the store as taking paid orders; treat every checkout as at risk until the deployment reports can_take_paid_order=true.',
        obligation: 'Configure the missing quote, PayPal, fulfillment and Resend settings on the deployment itself, then prove the same deployment reports readiness.',
        remedy: 'Set the variables named in `missing` (PRICE_QUOTE_SECRET, PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET, PAYPAL_ENABLE_ORDER_CREATE, FULFILLMENT_ACCESS_SECRET, RESEND_API_KEY), redeploy, then confirm /health returns money_readiness.ok=true.',
        mitigation: 'The verdict is read from the deployment\'s own /health, so an audit runner without credentials cannot report the store as ready.',
        verification: 'The deployed /health reports money_readiness.can_take_paid_order=true with an empty `missing` list, and the next audit reports no MONEY_READINESS_UNCONFIGURED finding.',
        owner_action: 'Add the named credentials to the deployment, redeploy, then rerun the tick audit.',
        sla_hours: 5
    },
    SHOPIFY_PRICE_DRIFT: {
        domain: 'revenue',
        severity: 'high',
        title: 'Catalog, edge/origin checkout and Shopify prices diverge',
        impact: 'A buyer can be shown one price at checkout and charged another on Shopify, the CDN edge can serve a stale price, or a course can be missing a live price entirely. That creates lost sales, refund exposure and broken price promises.',
        containment: 'Do not change prices while the drift is open; treat the edge, origin, checkout and Shopify as inconsistent until every row is reconciled.',
        obligation: 'Reconcile the canonical catalog, the buyer-facing edge payload, the direct origin payload and every live Shopify variant to the same price.',
        remedy: 'Run `npm run shopify:price-audit -- --json` to identify each drift, purge the stale edge payload or use shopify:reprice for active prices, then rerun the audit until it reports ok.',
        mitigation: 'The audit is read-only and compares the edge, a cache-busted edge, the direct origin and Shopify; it never writes prices itself.',
        verification: 'The audit returns status ok with edge, origin and Shopify prices matching the canonical catalog and no stale marker.',
        owner_action: 'Review the drift rows and authorize a checkout refresh or shopify:reprice for the affected courses.',
        sla_hours: 4
    },
    SHOPIFY_PRICE_DRIFT_UNCHECKED: {
        domain: 'revenue',
        severity: 'medium',
        title: 'Price drift could not be verified',
        impact: 'Without both the checkout payload and live Shopify reads, a price divergence can go unnoticed while checkout and the store continue selling.',
        containment: 'Do not report price consistency as verified while the audit is unavailable.',
        obligation: 'Restore read access to the checkout payload and Shopify Admin API.',
        remedy: 'Set the Shopify Admin credentials, confirm the storefront checkout payload URL responds, set CHECKOUT_PRICE_ORIGIN_URL to the direct deployment origin, then rerun the price audit.',
        mitigation: 'Missing credentials, a missing origin or a failed read is reported explicitly instead of producing a clean audit from the edge alone.',
        verification: 'The audit returns status ok or drift with no unavailable reasons and both edge and origin responses checked.',
        owner_action: 'Check SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, CHECKOUT_PRICE_ORIGIN_URL and the storefront /data/store-prices.json route.',
        sla_hours: 24
    }
};

const REVENUE_DIRS = ['data/sales', 'data/finance/events', 'data/commerce'];
const DATE_KEYS = new Set(['timestamp', 'created_at', 'at', 'settled_at', 'date', 'updated_at']);

const iso = value => new Date(value).toISOString();
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function walkFiles(dir, visit, state, maxFiles) {
    if (state.scanned >= maxFiles) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (state.scanned >= maxFiles) return;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(file, visit, state, maxFiles);
        else if (entry.isFile() && /\.json$/i.test(entry.name)) {
            state.scanned += 1;
            visit(file);
        }
    }
}

/**
 * Latest externally-confirmed revenue timestamp. Only records that look
 * financial (amount/revenue/total or a settled_at field) are considered, so a
 * setup report cannot masquerade as revenue activity.
 */
export function readRevenueEvidence(root = process.cwd(), { maxFiles = 300 } = {}) {
    let latest = 0;
    const sources = [];
    const state = { scanned: 0 };
    for (const rel of REVENUE_DIRS) {
        walkFiles(path.join(root, rel), file => {
            const data = readJson(file);
            if (!data) return;
            const visit = (node, depth = 0) => {
                if (!node || typeof node !== 'object' || depth > 4) return;
                if (Array.isArray(node)) {
                    for (const item of node) visit(item, depth + 1);
                    return;
                }
                const financial = ['amount', 'revenue', 'total', 'settled_at']
                    .some(key => (key === 'settled_at' ? key in node : Number.isFinite(Number(node[key]))));
                if (financial) {
                    for (const [key, value] of Object.entries(node)) {
                        if (!DATE_KEYS.has(key) || typeof value !== 'string') continue;
                        const time = Date.parse(value);
                        if (Number.isFinite(time) && time > latest) {
                            latest = time;
                            sources.length = 0;
                            sources.push(file);
                        }
                    }
                }
                for (const value of Object.values(node)) {
                    if (value && typeof value === 'object') visit(value, depth + 1);
                }
            };
            visit(data);
        }, state, maxFiles);
    }
    return {
        last_activity_at: latest ? iso(latest) : null,
        sources: [...new Set(sources)],
        scanned_files: state.scanned
    };
}

export function readProcurementPos(root = process.cwd()) {
    const dir = path.join(root, 'data', 'procurement');
    if (!fs.existsSync(path.join(dir, 'pos.ndjson'))) return [];
    return new ProcurementStore({ dir }).listPos();
}

export function readFulfillmentQueue(root = process.cwd(), { queueFile } = {}) {
    // Same file the webhook and the drain use, including its env override.
    const file = queueFile || path.join(root, 'logs', 'fulfillment_queue.log');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

/**
 * Reversal rows written by `reversals.mjs` (refund, reversal or dispute).
 *
 * Only the `reversal_*.json` files are read: the rest of the ledger is
 * thousands of batch files this audit has no business scanning on every tick.
 */
export function readRevenueReversals(root = process.cwd(), { ledgerDir } = {}) {
    const dir = ledgerDir
        || process.env.REVENUE_LEDGER_DIR
        || process.env.LEDGER_DIR
        || path.join(root, 'data', 'autonomous', 'ledger');
    return readLedgerRecords(dir, {
        fileFilter: name => name.toLowerCase().startsWith('reversal_')
    });
}

/**
 * One reversal list from several ledgers.
 *
 * Production reversals land in Base44; the loop's own reversals land in the
 * local ledger. The same refund can be in both (a local run and a deployed
 * webhook), so records are deduplicated by their event id, falling back to
 * the capture the reversal names. Sources are merged in the order given, and
 * the first record for an id wins, so a caller that passes the production
 * ledger first gets its row rather than the local copy.
 */
export function mergeRevenueReversals(sources = [], { base44 = null } = {}) {
    const records = [];
    const seen = new Set();
    const parts = [];
    for (const source of sources) {
        if (!source) continue;
        if (source.directory) parts.push(source.directory);
        for (const entry of source.records || []) {
            const record = entry?.record ?? {};
            const identity = record.event_id
                ? `event:${record.event_id}`
                : (record.reversal_of
                    ? `capture:${record.reversal_of}|${record.status || ''}|${record.amount ?? ''}`
                    : null);
            if (identity) {
                if (seen.has(identity)) continue;
                seen.add(identity);
            }
            records.push(entry);
        }
    }
    return {
        directory: parts.join(' + ') || null,
        records,
        ...(base44 ? { base44 } : {})
    };
}

export function scanSilentCatchBlocks(root = process.cwd(), { dirs = ['src', 'scripts'] } = {}) {
    const pattern = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\}/g;
    const samples = [];
    let count = 0;
    const walk = dir => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'test', 'tests'].includes(entry.name)) continue;
                walk(file);
                continue;
            }
            if (!/\.(?:mjs|cjs|js)$/i.test(entry.name)) continue;
            const content = fs.readFileSync(file, 'utf8');
            for (const match of content.matchAll(pattern)) {
                count += 1;
                if (samples.length < 10) {
                    const line = content.slice(0, match.index).split('\n').length;
                    samples.push(`${path.relative(root, file)}:${line}`);
                }
            }
        }
    };
    for (const rel of dirs) walk(path.join(root, rel));
    return { count, samples, dirs };
}

export function latestAuditAt(root = process.cwd()) {
    const dir = path.join(root, 'audits', 'autonomous');
    if (!fs.existsSync(dir)) return null;
    let latest = 0;
    for (const name of fs.readdirSync(dir)) {
        try {
            latest = Math.max(latest, fs.statSync(path.join(dir, name)).mtimeMs);
        } catch {
            // ignore unreadable entries
        }
    }
    return latest ? iso(latest) : null;
}

export function readTickMonotony(root = process.cwd()) {
    const file = path.join(root, 'data', 'swarm-tick-log.ndjson');
    if (!fs.existsSync(file)) return { samples: 0, duplicate_rate: 0 };
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-20)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    if (rows.length < 5) return { samples: rows.length, duplicate_rate: 0 };
    const statuses = rows.map(row => String(row.status || row.outcome || 'unknown'));
    const unique = new Set(statuses).size;
    return { samples: rows.length, duplicate_rate: round(1 - unique / statuses.length, 2) };
}

const DRIFT_CODES = new Set(['SHOPIFY_PRICE_DRIFT', 'PAYPAL_ORDER_PRICE_DRIFT']);
const MAX_RESOLVED_DRIFTS = 200;

function driftFingerprint(code, subject) {
    const identity = String(subject || 'unknown').trim();
    const digest = crypto.createHash('sha256')
        .update(`${code}|${identity}`)
        .digest('hex')
        .slice(0, 12);
    return `${code.toLowerCase()}:${digest}`;
}

function driftRows(finding) {
    if (finding.code === 'SHOPIFY_PRICE_DRIFT') return finding.evidence?.drift || [];
    if (finding.code === 'PAYPAL_ORDER_PRICE_DRIFT') return finding.evidence?.mismatches || [];
    return [];
}

function attachDriftFingerprints(findings) {
    for (const finding of findings) {
        if (!DRIFT_CODES.has(finding.code)) continue;
        const rows = driftRows(finding);
        if (!rows.length) continue;
        const seen = new Set();
        const drifts = [];
        for (const row of rows) {
            const subject = finding.code === 'PAYPAL_ORDER_PRICE_DRIFT'
                ? (row.order_id || row.product_id || 'unknown')
                : (row.course_id || 'catalog');
            const fingerprint = driftFingerprint(finding.code, subject);
            if (seen.has(fingerprint)) continue;
            seen.add(fingerprint);
            drifts.push({
                fingerprint,
                subject,
                ...(row.product_id ? { product_id: row.product_id } : {}),
                ...(row.sources ? { sources: row.sources } : {}),
                ...(row.reasons ? { reasons: row.reasons } : {}),
                ...(row.expected !== undefined ? { expected: row.expected } : {}),
                ...(row.actual !== undefined ? { actual: row.actual } : {})
            });
        }
        finding.drifts = drifts;
        finding.drift_fingerprints = drifts.map(drift => drift.fingerprint);
    }
}

function canResolveDrifts(code, evidence) {
    if (code !== 'SHOPIFY_PRICE_DRIFT') return false;
    const report = evidence.shopify_price_drift;
    if (!report) return false;
    if (report.status === 'ok') return true;
    return report.status === 'drift'
        && !(report.unavailable || []).length
        && !(report.unchecked || []).length;
}

export function detectSilentFailures({
    root = process.cwd(),
    now = new Date(),
    env = process.env,
    heartbeat,
    maxSilenceMin = DEFAULT_MAX_SILENCE_MIN,
    stallDays = DEFAULT_STALL_DAYS,
    revenue,
    procurement,
    fulfillment,
    silentCatches,
    auditLatest,
    tickMonotony,
    webhookProbes,
    paypalReconciliation,
    storefrontProbe,
    shopifyPriceDrift,
    checkoutGate,
    reversals,
    reversalWindowDays = DEFAULT_REVERSAL_WINDOW_DAYS,
    settlementBlocks,
    payoutClaims,
    exportConfirmDays = DEFAULT_EXPORT_CONFIRM_DAYS
} = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const findings = [];
    const add = (code, detail, evidence, severity) => {
        const meta = FINDING_CATALOG[code];
        findings.push({
            code,
            domain: meta.domain,
            severity: severity || meta.severity,
            title: meta.title,
            detail,
            evidence: evidence || null,
            detected_at: iso(at)
        });
    };

    const hb = heartbeat === undefined ? readHeartbeat(heartbeatPath(root)) : heartbeat;
    let heartbeatStatus = null;
    let heartbeatAge = null;
    if (!hb) {
        add('LOOP_HEARTBEAT_MISSING', 'No heartbeat file exists: no tick has ever been recorded.', {
            path: heartbeatPath(root)
        });
    } else {
        heartbeatAge = heartbeatAgeMs(hb, at.getTime());
        heartbeatStatus = hb.status || (hb.ok === false ? 'blocked' : 'ok');
        if (heartbeatAge > maxSilenceMin * 60000) {
            add('LOOP_HEARTBEAT_STALE', `Last heartbeat was ${round(heartbeatAge / 60000)} minutes ago (budget ${maxSilenceMin} minutes).`, {
                last_tick: hb.at || hb.tick_at || null,
                status: heartbeatStatus,
                last_error: hb.last_error || null
            });
        } else if (heartbeatStatus === 'blocked' || hb.ok === false) {
            const missing = hb.missing_env || missingLiveEnv(env);
            add('LOOP_BLOCKED', hb.blocked_reason || `Tick reports blocked with missing env: ${missing.join(', ')}`, {
                heartbeat_status: heartbeatStatus,
                missing_env: missing,
                revenue_enabled: hb.revenue_enabled ?? null,
                last_success_at: hb.last_success_at ?? null
            });
        }
    }

    const rev = revenue === undefined ? readRevenueEvidence(root) : revenue;
    let stallDaysObserved = null;
    if (rev?.last_activity_at) {
        stallDaysObserved = round((at.getTime() - Date.parse(rev.last_activity_at)) / 86400000, 1);
        if (stallDaysObserved >= stallDays) {
            add('REVENUE_STALL', `No financially-relevant record for ${stallDaysObserved} days (stall window ${stallDays} days).`, {
                last_activity_at: rev.last_activity_at,
                sources: rev.sources || [],
                stalled_days: stallDaysObserved
            });
        }
    }

    const pos = procurement === undefined ? readProcurementPos(root) : procurement;
    const views = pos.map(po => evaluatePo(po, { now: at }));
    const stalled = views.filter(view => ['placed', 'shipped'].includes(view.status) && view.waiting_days >= stallDays);
    const unverified = views.filter(view => {
        if (!['delivered', 'on_hold'].includes(view.status)) return false;
        const po = pos.find(candidate => candidate.po_ref === view.po_ref);
        const since = Date.parse(po?.delivered_at || po?.updated_at || po?.created_at || '');
        const age = Number.isFinite(since) ? (at.getTime() - since) / 86400000 : Infinity;
        return age >= Math.max(1, stallDays / 2);
    });
    if (stalled.length) {
        add('PROCUREMENT_DELIVERY_STALL', `${stalled.length} PO(s) placed but not delivered within ${stallDays} days.`, {
            po_refs: stalled.map(view => view.po_ref),
            waiting_days: stalled.map(view => ({ po_ref: view.po_ref, days: view.waiting_days })),
            value_mad: round(stalled.reduce((sum, view) => sum + Number(view.subtotal_mad || 0), 0), 2)
        });
    }
    if (unverified.length) {
        add('DELIVERY_UNVERIFIED', `${unverified.length} delivery record(s) not verified/closed.`, {
            po_refs: unverified.map(view => view.po_ref),
            statuses: unverified.map(view => ({ po_ref: view.po_ref, status: view.status, holds: view.holds }))
        });
    }

    const contentieux = buildContentieuxCases(pos, { now: at, minDays: stallDays });
    if (contentieux.cases.length) {
        const severityRank = { low: 1, medium: 2, high: 3 };
        const highest = [...contentieux.cases].sort((a, b) => severityRank[b.severity] - severityRank[a.severity])[0];
        const oldest = Math.max(...contentieux.cases.map(item => item.waiting_days));
        add(
            'PROCUREMENT_CONTENTIEUX',
            `${contentieux.cases.length} contentieux case(s), ${contentieux.totals.amount_mad} MAD at stake, oldest ${round(oldest)} days.`,
            {
                case_ids: contentieux.cases.map(item => item.case_id),
                cases: contentieux.cases.map(item => ({
                    case_id: item.case_id,
                    po_ref: item.po_ref,
                    supplier: item.supplier,
                    status: item.status,
                    amount_mad: item.amount_mad,
                    waiting_days: item.waiting_days,
                    severity: item.severity,
                    holds: item.holds.map(hold => hold.code),
                    next_action: item.next_action
                })),
                amount_at_stake_mad: contentieux.totals.amount_mad,
                oldest_waiting_days: round(oldest),
                high_severity: contentieux.totals.high
            },
            highest.severity
        );
    }

    const queue = fulfillment === undefined
        ? readFulfillmentQueue(root, { queueFile: env?.FULFILLMENT_QUEUE_FILE || undefined })
        : fulfillment;
    // The queue is append-only, so only an order's latest line says where it
    // stands. This is the same view the drain uses: an order delivered or
    // exhausted later must not keep counting as a pending backlog entry.
    const latestByOrder = new Map();
    for (const entry of queue) {
        const orderId = entry?.order_id ? String(entry.order_id) : null;
        if (orderId) latestByOrder.set(orderId, entry);
    }
    const latest = [...latestByOrder.values()];
    const pending = latest.filter(entry => String(entry.status || '').toUpperCase() === 'PENDING_DELIVERY');
    const pendingDays = pending.map(entry => {
        const time = Date.parse(entry.timestamp || '');
        return Number.isFinite(time) ? (at.getTime() - time) / 86400000 : Infinity;
    });
    const oldestPending = pendingDays.length ? Math.max(...pendingDays) : 0;
    if (pending.length && oldestPending >= stallDays) {
        add('FULFILLMENT_BACKLOG', `${pending.length} customer order(s) pending delivery, oldest ${round(oldestPending)} days.`, {
            pending_count: pending.length,
            oldest_days: round(oldestPending)
        });
    }

    // A running drain appends a queue line for every attempt it makes — success,
    // failure or the next retry time — so an undelivered order whose latest line
    // is older than the stall window has nothing advancing it: the drain is not
    // running, or it is stuck. An unpaid order records only a throttled
    // `drain.last_skip_at` heartbeat and keeps aging, which is the intended
    // signal that a human has to resolve it.
    // `PENDING_DELIVERY` is FULFILLMENT_BACKLOG's finding — it is reported there
    // by the same age — so it is excluded here to keep the two disjoint. Terminal
    // lines are excluded because they are already done.
    const terminalStatuses = ['DELIVERED', 'DELIVERY_EXHAUSTED'];
    const stalledQueue = latest
        .filter(entry => {
            const status = String(entry.status || '').toUpperCase();
            return !terminalStatuses.includes(status) && status !== 'PENDING_DELIVERY';
        })
        .map(entry => {
            const time = Date.parse(entry.timestamp || '');
            // Every writer stamps an ISO timestamp, so a line that cannot be
            // aged is a corrupt append, not proof the queue stopped advancing.
            if (!Number.isFinite(time)) return null;
            const days = (at.getTime() - time) / 86400000;
            return {
                order_id: String(entry.order_id),
                status: entry.status || null,
                attempts: Number(entry.drain?.attempts) || 0,
                last_line_at: entry.timestamp,
                stalled_days: round(days),
                next_attempt_at: entry.drain?.next_attempt_at || null,
                days
            };
        })
        .filter(entry => entry && entry.days >= stallDays)
        .map(({ days, ...entry }) => entry);
    if (stalledQueue.length) {
        const oldest = Math.max(...stalledQueue.map(order => order.stalled_days));
        add('FULFILLMENT_QUEUE_STALLED', `${stalledQueue.length} undelivered order(s) have had no queue line for at least ${stallDays} days (oldest ${oldest}) — nothing is advancing ${stalledQueue.map(order => order.order_id).join(', ')}.`, {
            stalled_count: stalledQueue.length,
            stall_window_days: stallDays,
            orders: stalledQueue
        });
    }

    // The drain stops retrying an order after its attempt cap and records
    // DELIVERY_EXHAUSTED as the queue's latest line. Detect it from the same
    // latest-line view so a dead paid order becomes an incident finding, and a
    // later DELIVERED line for that order clears it.
    const exhausted = latest
        .filter(entry => String(entry.status || '').toUpperCase() === 'DELIVERY_EXHAUSTED')
        .map(entry => ({
            order_id: String(entry.order_id),
            attempts: Number(entry.drain?.attempts) || null,
            last_reason: entry.drain?.last_reason || null,
            action_required: entry.action_required || null,
            exhausted_at: entry.timestamp || null
        }));
    if (exhausted.length) {
        add('FULFILLMENT_DELIVERY_EXHAUSTED', `${exhausted.length} paid order(s) stopped being retried after delivery failed: ${exhausted.map(order => order.order_id).join(', ')}.`, {
            exhausted_count: exhausted.length,
            orders: exhausted
        });
    }

    // The drain records each unpaid-order skip, throttled to once an hour per
    // order, on the order's latest line. The newest of those records is what
    // separates "the drain ran and found nothing paid" from "the drain never
    // ran": the queue alone cannot say which, because both leave the delivery
    // state untouched.
    const notPaidSkips = latest
        .map(entry => ({
            order_id: String(entry.order_id),
            at: entry.drain?.last_skip_at || null,
            reason: entry.drain?.last_skip_reason || null
        }))
        .filter(item => item.at && Number.isFinite(Date.parse(item.at)));
    const lastSkipAt = notPaidSkips.length
        ? notPaidSkips.map(item => item.at).sort().pop()
        : null;

    // A reversal nets a capture to zero, but the buyer keeps the product. No
    // other step reads reversal rows back once they are written, so a chargeback
    // or refund on a delivered order would otherwise appear only as a smaller
    // revenue number. The join key is the capture id the fulfilment path now
    // records on the queue line of a delivered order.
    const ledgerReversals = reversals === undefined ? readRevenueReversals(root) : reversals;
    const deliveredByCapture = new Map();
    for (const entry of latest) {
        const captureId = String(entry.capture_id || '').trim();
        if (!captureId) continue;
        if (String(entry.status || '').toUpperCase() !== 'DELIVERED') continue;
        deliveredByCapture.set(captureId, entry);
    }
    const reversedAfterFulfillment = [];
    let undatedReversals = 0;
    for (const { record } of ledgerReversals.records || []) {
        const captureId = String(record?.reversal_of ?? '').trim();
        if (!captureId) continue;
        const delivered = deliveredByCapture.get(captureId);
        if (!delivered) continue;
        const reversedAt = record?.occurred_at ?? record?.created_at ?? null;
        const reversedMs = Date.parse(reversedAt || '');
        // An undateable row cannot be placed in the window; count it rather than
        // either inventing a date or dropping it silently.
        if (!Number.isFinite(reversedMs)) {
            undatedReversals += 1;
            continue;
        }
        if ((at.getTime() - reversedMs) / 86400000 > reversalWindowDays) continue;
        const amount = Number(record?.amount);
        reversedAfterFulfillment.push({
            order_id: String(delivered.order_id),
            capture_id: captureId,
            reversal_event_id: record?.event_id ?? null,
            reversal_type: String(record?.status || 'reversal').toLowerCase(),
            amount: Number.isFinite(amount) ? Math.abs(amount) : null,
            currency: String(record?.currency || '').toUpperCase() || null,
            reversed_at: reversedAt,
            delivered_at: delivered.timestamp || null,
            product: delivered.product || null
        });
    }
    if (reversedAfterFulfillment.length) {
        add('REVENUE_REVERSED_AFTER_FULFILLMENT', `${reversedAfterFulfillment.length} delivered order(s) had their payment refunded, reversed or disputed within ${reversalWindowDays} days: ${reversedAfterFulfillment.map(order => order.order_id).join(', ')}. The buyer kept the product.`, {
            count: reversedAfterFulfillment.length,
            window_days: reversalWindowDays,
            undated_reversals: undatedReversals,
            ledger: ledgerReversals.directory || null,
            base44: ledgerReversals.base44 || null,
            orders: reversedAfterFulfillment
        });
    }

    // A payout PayPal reported as succeeded whose revenue row stayed unpaid used
    // to leave a trace only in stderr. The webhook appends that refusal to an
    // append-only log, so the block is a finding until a later settlement of the
    // same revenue row closes it.
    const settlementBlockLog = settlementBlocks === undefined
        ? readSettlementBlocks(root, { env })
        : settlementBlocks;
    const openSettlements = openSettlementBlocks(settlementBlockLog.records || []).map(record => {
        const blockedAt = record.at || null;
        const blockedMs = Date.parse(blockedAt || '');
        return {
            outcome: record.outcome || null,
            revenue_event_id: record.revenue_event_id || null,
            psp_transaction_id: record.psp_transaction_id || null,
            reason: record.reason || null,
            error: record.error || null,
            webhook_event_id: record.webhook_event_id || null,
            source: record.source || null,
            blocked_at: blockedAt,
            age_hours: Number.isFinite(blockedMs) ? round((at.getTime() - blockedMs) / 3600000) : null
        };
    });
    // A row with no bound evidence is a different incident: no payout went out,
    // the row is simply unsettleable until the block is written.
    const unboundEvidence = openSettlements
        .filter(row => row.outcome === SETTLEMENT_EVIDENCE_UNBOUND)
        .map(row => ({
            revenue_event_id: row.revenue_event_id,
            psp_transaction_id: row.psp_transaction_id,
            reason: row.reason,
            error: row.error,
            source: row.source,
            unbound_at: row.blocked_at,
            age_hours: row.age_hours
        }));
    if (unboundEvidence.length) {
        add(
            'SETTLEMENT_EVIDENCE_UNBOUND',
            `${unboundEvidence.length} revenue row(s) were recorded without the settlement evidence their payout is checked against: ` +
                `${unboundEvidence.map(row => row.revenue_event_id).filter(Boolean).join(', ')}. ` +
                `They cannot settle until the block is written.`,
            {
                count: unboundEvidence.length,
                log: settlementBlockLog.path || null,
                rows: unboundEvidence
            }
        );
    }

    // The mirror incident: the row's evidence was refused because the provider
    // recorded another amount. No payout went out either, but the ledger number
    // is wrong, so the remedy is different from a missing block.
    const mismatchedEvidence = openSettlements
        .filter(row => row.outcome === SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH)
        .map(row => ({
            revenue_event_id: row.revenue_event_id,
            psp_transaction_id: row.psp_transaction_id,
            reason: row.reason,
            error: row.error,
            source: row.source,
            recorded_at: row.blocked_at,
            age_hours: row.age_hours
        }));
    if (mismatchedEvidence.length) {
        add(
            'SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH',
            `${mismatchedEvidence.length} revenue row(s) claim an amount the verified webhook never recorded: ` +
                `${mismatchedEvidence.map(row => row.revenue_event_id).filter(Boolean).join(', ')}. ` +
                `Their evidence cannot be bound, so they cannot settle and the ledger total is wrong.`,
            {
                count: mismatchedEvidence.length,
                log: settlementBlockLog.path || null,
                rows: mismatchedEvidence
            }
        );
    }

    // A claim the daemon could not reconcile is money whose fate is unknown: the
    // batch may already have been paid while its rows still read unpaid, and the
    // daemon withholds those rows rather than pay twice. The claim store is the
    // state, so closing the claim (provider payout items or an owner
    // confirmation) removes the finding.
    const payoutClaimStore = payoutClaims === undefined
        ? readPayoutClaims(root, { env })
        : payoutClaims;
    const openClaims = openPayoutClaims(payoutClaimStore.claims || []).map(claim => {
        const claimedMs = Date.parse(claim.claimed_at || '');
        return {
            batch_id: claim.batch_id ?? null,
            rail: claim.rail ?? null,
            status: claim.status ?? null,
            revenue_event_ids: claim.revenue_event_ids ?? [],
            amount: claim.amount ?? null,
            currency: claim.currency ?? null,
            claimed_at: claim.claimed_at ?? null,
            age_hours: Number.isFinite(claimedMs) ? round((at.getTime() - claimedMs) / 3600000) : null,
            error: claim.error ?? null
        };
    });
    if (payoutClaimStore.error) {
        add(
            'PAYOUT_CLAIM_UNRESOLVED',
            `The payout claim store could not be read (${payoutClaimStore.error}), so an in-flight payout cannot be ruled out.`,
            { count: null, store_error: payoutClaimStore.error, log: payoutClaimStore.path || null, rows: [] }
        );
    } else if (openClaims.length) {
        add(
            'PAYOUT_CLAIM_UNRESOLVED',
            `${openClaims.length} settlement batch(es) may already have been paid without their outcome being recorded: ` +
                `${openClaims.map(claim => claim.batch_id).filter(Boolean).join(', ')}. ` +
                `Their revenue rows are withheld until the provider is reconciled.`,
            {
                count: openClaims.length,
                log: payoutClaimStore.path || null,
                rows: openClaims
            }
        );
    }

    // A CSV batch stops at `export_ready` by design: only a human can upload the
    // file. That leaves the last step of the payout unowned, so an export nobody
    // confirms ages here until the ledger and reality are reconciled.
    const awaitingExports = payoutClaimStore.error
        ? []
        : exportedClaimsAwaitingConfirmation(payoutClaimStore.claims || []).map(claim => {
            // The claim closed when the file was written, so that is the age of
            // the row it left at `export_ready`.
            const exportedAt = claim.closed_at || claim.claimed_at || null;
            const exportedMs = Date.parse(exportedAt || '');
            return {
                batch_id: claim.batch_id ?? null,
                rail: claim.rail ?? null,
                amount: claim.amount ?? null,
                currency: claim.currency ?? null,
                revenue_event_ids: claim.revenue_event_ids ?? [],
                export_filename: claim.execution?.export_filename ?? null,
                exported_at: exportedAt,
                age_days: Number.isFinite(exportedMs) ? round((at.getTime() - exportedMs) / 86400000) : null
            };
        });
    // An age that cannot be read is not treated as young: an unconfirmed export
    // is money nobody owns either way.
    const staleExports = awaitingExports.filter(row => row.age_days === null || row.age_days >= exportConfirmDays);
    if (staleExports.length) {
        add(
            'PAYOUT_EXPORT_UNCONFIRMED',
            `${staleExports.length} exported payout batch(es) passed the ${exportConfirmDays}-day confirmation window without being confirmed or closed: ` +
                `${staleExports.map(row => `${row.batch_id} (${row.age_days === null ? 'age unknown' : `${row.age_days} days`})`).join(', ')}. ` +
                'Their revenue rows stay export_ready until someone says whether the transfer happened.',
            {
                count: staleExports.length,
                threshold_days: exportConfirmDays,
                log: payoutClaimStore.path || null,
                rows: staleExports
            }
        );
    }

    const blockedSettlements = openSettlements.filter(
        row => row.outcome !== SETTLEMENT_EVIDENCE_UNBOUND && row.outcome !== SETTLEMENT_EVIDENCE_AMOUNT_MISMATCH
    );
    if (blockedSettlements.length) {
        add(
            'REVENUE_SETTLEMENT_BLOCKED',
            `${blockedSettlements.length} payout(s) succeeded while the revenue row was not marked paid_out: ` +
                `${blockedSettlements.map(row => row.revenue_event_id).join(', ')}.`,
            {
                count: blockedSettlements.length,
                log: settlementBlockLog.path || null,
                blocks: blockedSettlements
            }
        );
    }

    const catches = silentCatches === undefined ? scanSilentCatchBlocks(root) : silentCatches;
    if (catches?.count > 0) {
        add('SILENT_EXCEPTION_SWALLOW', `${catches.count} empty catch block(s) hide failures.`, {
            count: catches.count,
            samples: catches.samples || []
        });
    }

    const audit = auditLatest === undefined ? latestAuditAt(root) : auditLatest;
    const auditAgeDays = audit ? (at.getTime() - Date.parse(audit)) / 86400000 : null;
    if (hb && heartbeatAge !== null && heartbeatAge <= maxSilenceMin * 60000 && audit && auditAgeDays > 7) {
        add('AUDIT_BLINDSPOT', `No audit entry for ${round(auditAgeDays)} days while the loop reports ticks.`, {
            latest_audit_at: audit,
            age_days: round(auditAgeDays)
        });
    }

    if (paypalReconciliation && typeof paypalReconciliation === 'object') {
        if (paypalReconciliation.report) {
            const report = paypalReconciliation.report;
            if (Number(report.missing_count) > 0) {
                add('PAYPAL_UNFULFILLED_ORDERS', `${report.missing_count} captured order(s) are absent from the fulfilment queue.`, {
                    order_ids: (report.missing || []).map(order => order.order_id),
                    missing: report.missing || [],
                    window: report.window || null
                });
            }
            if (Number(report.price_mismatch_count) > 0) {
                add('PAYPAL_ORDER_PRICE_DRIFT', `${report.price_mismatch_count} captured order(s) were charged a price different from the canonical catalog.`, {
                    order_ids: (report.price_mismatches || []).map(order => order.order_id),
                    mismatches: report.price_mismatches || [],
                    price_unchecked: report.price_unchecked || [],
                    price_catalog_error: report.price_catalog_error || null,
                    window: report.window || null
                });
            }
            if (Number(report.quote_metadata_finding_count) > 0) {
                const rows = report.quote_metadata_findings || [];
                add('PAYPAL_QUOTE_METADATA_DRIFT', `${rows.length} captured order(s) have missing, malformed or stale quote metadata.`, {
                    order_ids: rows.map(order => order.order_id),
                    findings: rows,
                    legacy_order_ids: (report.quote_metadata_legacy || []).map(order => order.order_id),
                    window: report.window || null
                });
            }
        } else if (paypalReconciliation.error) {
            add('PAYPAL_RECONCILIATION_UNAVAILABLE', paypalReconciliation.error, {
                reason: paypalReconciliation.error
            });
        }
    }

    if (shopifyPriceDrift && typeof shopifyPriceDrift === 'object') {
        if (shopifyPriceDrift.status === 'drift') {
            const affected = shopifyPriceDrift.affected_courses ?? shopifyPriceDrift.drift.length;
            add(
                'SHOPIFY_PRICE_DRIFT',
                `${affected} course(s) with a real price divergence between the catalog, checkout and Shopify.`,
                {
                    checked_at: shopifyPriceDrift.checked_at,
                    catalog_file: shopifyPriceDrift.catalog_file,
                    store_currency: shopifyPriceDrift.store_currency,
                    checkout_url: shopifyPriceDrift.checkout?.url || null,
                    checkout: shopifyPriceDrift.checkout || null,
                    checked: shopifyPriceDrift.checked,
                    affected_courses: affected,
                    drift: shopifyPriceDrift.drift,
                    unchecked: shopifyPriceDrift.unchecked || [],
                    unavailable: shopifyPriceDrift.unavailable || []
                }
            );
        } else if (shopifyPriceDrift.status === 'unavailable') {
            const unchecked = [
                ...(shopifyPriceDrift.unavailable || []),
                ...(shopifyPriceDrift.unchecked || []).map(row =>
                    `${row.source}:${row.course_id || 'catalog'} ${row.reason}`
                )
            ];
            add(
                'SHOPIFY_PRICE_DRIFT_UNCHECKED',
                unchecked.join('; ') || 'Price audit did not complete.',
                {
                    checked_at: shopifyPriceDrift.checked_at,
                    catalog_file: shopifyPriceDrift.catalog_file,
                    checkout_url: shopifyPriceDrift.checkout?.url || null,
                    checkout: shopifyPriceDrift.checkout || null,
                    checked: shopifyPriceDrift.checked,
                    unchecked: shopifyPriceDrift.unchecked || [],
                    unavailable: shopifyPriceDrift.unavailable || []
                }
            );
        }
    }

    if (storefrontProbe && typeof storefrontProbe === 'object' && !storefrontProbe.ok) {
        const verdict = storefrontProbe.verdict;
        const code = verdict === 'unreachable'
            ? 'STOREFRONT_UNREACHABLE'
            : (verdict === 'http_error' ? 'STOREFRONT_HTTP_ERROR' : 'STOREFRONT_NOT_TRANSACTIONAL');
        add(code, `${storefrontProbe.url} -> ${verdict}: ${storefrontVerdictHint(verdict)}`, {
            status: storefrontProbe.status,
            health_status: storefrontProbe.health_status,
            health_path: storefrontProbe.health_path || null,
            health_error: storefrontProbe.health_error || null,
            app_runtime: storefrontProbe.app_runtime,
            api_alive: storefrontProbe.api_alive,
            checkout_link: storefrontProbe.checkout_link,
            verdict,
            attempts: storefrontProbe.attempts || null,
            error: storefrontProbe.error || null
        });
    }

    const probes = webhookProbes || [];
    const failingProbes = probes.filter(probe => !probe.ok);
    if (failingProbes.length) {
        add('PAYMENT_WEBHOOK_UNREACHABLE', failingProbes.map(probe => `${probe.url} -> ${probe.status ?? 'no response'} (${probe.verdict}: ${probeVerdictHint(probe.verdict)})`).join('; '), {
            probes: failingProbes
        });
    }

    if (checkoutGate && typeof checkoutGate === 'object' && checkoutGate.reported && checkoutGate.blocks) {
        add('CHECKOUT_GATE_BLOCKED', `${checkoutGate.url} reports blocks_checkout=true (${checkoutGate.block_reason || 'no reason given'}): every checkout order creation answers 503.`, {
            status: checkoutGate.status,
            block_reason: checkoutGate.block_reason,
            replay_protection: checkoutGate.replay_protection
        });
    }

    // The gate only says a checkout can be started. The deployment's own money
    // readiness says whether a started checkout can ever be paid and delivered;
    // an unreported verdict is not a failure, so an older deployment is not
    // accused of something it never claimed.
    if (checkoutGate?.money?.reported && checkoutGate.money.can_take_paid_order === false) {
        const missing = Array.isArray(checkoutGate.money.missing) ? checkoutGate.money.missing : [];
        add('MONEY_READINESS_UNCONFIGURED', `${checkoutGate.url} reports can_take_paid_order=false${missing.length ? ` (missing ${missing.join(', ')})` : ''}: a paid order cannot be quoted, created, captured or delivered.`, {
            status: checkoutGate.status,
            can_take_paid_order: false,
            missing
        });
    }

    const monotony = tickMonotony === undefined ? readTickMonotony(root) : tickMonotony;
    const duplicates = pos.length
        ? Object.entries(pos.reduce((acc, po) => {
            if (!po.external_id) return acc;
            acc[po.external_id] = (acc[po.external_id] || 0) + 1;
            return acc;
        }, {})).filter(([, count]) => count > 1)
            .map(([external_id, count]) => ({ external_id, count }))
        : [];

    attachDriftFingerprints(findings);

    return {
        findings,
        evidence: {
            heartbeat: hb ? { status: heartbeatStatus, age_ms: heartbeatAge } : { status: 'missing', age_ms: null },
            revenue: { ...rev, stalled_days: stallDaysObserved },
            procurement: {
                total: pos.length,
                stalled: stalled.length,
                unverified: unverified.length,
                stalled_value_mad: round(stalled.reduce((sum, view) => sum + Number(view.subtotal_mad || 0), 0), 2),
                contentieux: {
                    cases: contentieux.cases.length,
                    amount_at_stake_mad: contentieux.totals.amount_mad,
                    oldest_waiting_days: contentieux.cases.length
                        ? round(Math.max(...contentieux.cases.map(item => item.waiting_days)))
                        : 0,
                    high_severity: contentieux.totals.high
                },
                contentieux_cases: contentieux.cases
            },
            fulfillment: {
                pending: pending.length,
                oldest_days: round(oldestPending),
                delivery_exhausted: exhausted.length,
                queue_stalled: stalledQueue.length,
                not_paid_skips: notPaidSkips.length,
                reversed_after_fulfillment: reversedAfterFulfillment.length,
                undated_reversals: undatedReversals,
                last_skip_at: lastSkipAt,
                skip_age_hours: lastSkipAt
                    ? round((at.getTime() - Date.parse(lastSkipAt)) / 3600000)
                    : null
            },
            reversals: {
                ledger: ledgerReversals.directory || null,
                scanned: (ledgerReversals.records || []).length,
                base44: ledgerReversals.base44 || null
            },
            settlement_blocks: {
                // Every line still open, whatever stopped it: a blocked payout
                // and an unsettleable capture are both work in this log.
                open: openSettlements.length,
                unbound_evidence: unboundEvidence.length,
                amount_mismatch: mismatchedEvidence.length,
                path: settlementBlockLog.path || null
            },
            payout_claims: {
                open: openClaims.length,
                awaiting_confirmation: awaitingExports.length,
                path: payoutClaimStore.path || null,
                store_error: payoutClaimStore.error || null
            },
            silent_catches: catches,
            audit: { latest_at: audit, age_days: auditAgeDays === null ? null : round(auditAgeDays) },
            webhook_probes: probes,
            checkout_gate: checkoutGate || null,
            paypal_reconciliation: paypalReconciliation || null,
            storefront_probe: storefrontProbe || null,
            shopify_price_drift: shopifyPriceDrift || null,
            monotony,
            duplicates: { count: duplicates.reduce((sum, row) => sum + (row.count - 1), 0), cycles: duplicates, cycle_id: duplicates.length ? 'procurement' : null }
        }
    };
}

export function listMitigations() {
    return [
        { id: 'heartbeat_contract', control: 'Every tick writes a heartbeat; absent signal counts as failure.', status: 'implemented', where: 'src/swarm/loop-health.mjs' },
        { id: 'dead_man_switch', control: 'Scheduled CI fails when no heartbeat was written for 90 minutes.', status: 'implemented', where: '.github/workflows/swarm-tick.yml' },
        { id: 'silence_budget', control: 'Unresolved findings escalate to critical after 24 hours.', status: 'implemented', where: 'src/resilience/silent-failure.mjs' },
        { id: 'fail_loud_sentinel', control: 'Silent-failure audit exits non-zero at or above the configured severity.', status: 'implemented', where: 'scripts/silent-failure.mjs' },
        { id: 'error_swallow_ban', control: 'Static scan reports empty catch blocks.', status: 'implemented', where: 'src/resilience/silent-failure.mjs' },
        { id: 'delivery_verification_gate', control: 'POs cannot close without POD evidence and 3-way match.', status: 'implemented', where: 'src/procurement/' },
        { id: 'pre_paid_invariant', control: 'Owner-initiated procurement must be pre-paid by the swarm; recipients are never charged.', status: 'implemented', where: 'src/procurement/po.mjs' },
        { id: 'owner_gated_freeze_release', control: 'A stale money-safety freeze is cleared only with --ack-owner and an audit entry.', status: 'implemented', where: 'scripts/swarm-doctor.mjs' },
        { id: 'self_redress_actions', control: 'Reversible velocity breaker, routing entropy, cycle mutex and context hydration.', status: 'implemented', where: 'src/resilience/redress.mjs' },
        { id: 'settlement_freeze_gate', control: 'Settlement assertions fail while the velocity breaker is active.', status: 'implemented', where: 'src/real/money-moved-gate.mjs' },
        { id: 'audit_trail', control: 'Every trigger, clear and incident is appended to audits/autonomous/.', status: 'implemented', where: 'src/resilience/redress.mjs' },
        { id: 'owner_gated_money', control: 'No redress or audit path moves money; monetary remedies require explicit owner authorization.', status: 'implemented', where: 'docs/SILENT_FAILURE_REMEDIATION.md' }
    ];
}

export function buildRedressPlan(findings, { now = new Date(), evidence = {}, resolvedDrifts = [] } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const sorted = [...findings].sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
    const severity = sorted.length ? sorted[0].severity : 'none';
    const digest = crypto.createHash('sha256')
        .update(`${sorted.map(finding => finding.code).join('|')}|${at.toISOString().slice(0, 10)}`)
        .digest('hex')
        .slice(0, 8);

    return {
        protocol: 'faillite-silencieuse/remediation-v1',
        incident_id: `SF-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${digest}`,
        generated_at: iso(at),
        classification: sorted.length ? 'silent_failure_detected' : 'clear',
        severity,
        summary: sorted.length
            ? `${sorted.length} silent-failure finding(s); highest severity ${severity}`
            : 'No silent-failure signals detected',
        resolved_drifts: resolvedDrifts,
        findings: sorted.map(finding => {
            const meta = FINDING_CATALOG[finding.code] || {};
            const deadline = new Date(at.getTime() + Number(meta.sla_hours || 24) * 3600000);
            return {
                ...meta,
                ...finding,
                severity: finding.severity || meta.severity,
                sla_hours: meta.sla_hours || 24,
                sla_deadline: iso(deadline),
                silent_hours: finding.silent_hours ?? 0,
                occurrences: finding.occurrences ?? 1,
                first_seen: finding.first_seen || iso(at),
                escalated: Boolean(finding.escalated)
            };
        }),
        redress: {
            obligations: sorted.map(finding => ({
                code: finding.code,
                obligation: FINDING_CATALOG[finding.code]?.obligation || 'Resolve the finding.',
                owner_action: FINDING_CATALOG[finding.code]?.owner_action || 'Owner review required.',
                deadline: iso(new Date(at.getTime() + Number(FINDING_CATALOG[finding.code]?.sla_hours || 24) * 3600000))
            })),
            exposure: {
                stalled_po_value_mad: evidence.procurement?.stalled_value_mad || 0,
                unverified_po_value_mad: evidence.procurement?.unverified_value_mad || 0,
                contentieux_amount_mad: evidence.procurement?.contentieux?.amount_at_stake_mad || 0,
                contentieux_cases: evidence.procurement?.contentieux?.cases || 0,
                pending_fulfillments: evidence.fulfillment?.pending || 0,
                exhausted_fulfillments: evidence.fulfillment?.delivery_exhausted || 0,
                stalled_fulfillments: evidence.fulfillment?.queue_stalled || 0,
                reversed_after_fulfillment: evidence.fulfillment?.reversed_after_fulfillment || 0,
                revenue_stalled_days: evidence.revenue?.stalled_days ?? null,
                swallowed_exceptions: evidence.silent_catches?.count || 0
            },
            money_movement: 'none — this protocol never moves money; monetary remedies require explicit owner authorization',
            postconditions: [
                'Every finding has a completed owner action and a passing verification.',
                'The next audit reports no finding at or above the configured severity.',
                'The incident record and audit entries are retained as evidence.'
            ],
            residual_risk: sorted.length
                ? 'Open until every owner action is completed and verified; escalation continues while findings persist.'
                : 'None detected at audit time.'
        },
        mitigations: listMitigations()
    };
}

export function runSilentFailureAudit({
    root = process.cwd(),
    now = new Date(),
    env = process.env,
    heartbeat,
    maxSilenceMin = DEFAULT_MAX_SILENCE_MIN,
    stallDays = DEFAULT_STALL_DAYS,
    silenceBudgetHours = DEFAULT_SILENCE_BUDGET_HOURS,
    write = false,
    engine = null,
    webhookProbes = [],
    paypalReconciliation = null,
    storefrontProbe = null,
    shopifyPriceDrift = null,
    checkoutGate = null,
    reversals,
    reversalWindowDays = DEFAULT_REVERSAL_WINDOW_DAYS,
    settlementBlocks,
    payoutClaims,
    exportConfirmDays = DEFAULT_EXPORT_CONFIRM_DAYS
} = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const detected = detectSilentFailures({ root, now: at, env, heartbeat, maxSilenceMin, stallDays, webhookProbes, paypalReconciliation, storefrontProbe, shopifyPriceDrift, checkoutGate, reversals, reversalWindowDays, settlementBlocks, payoutClaims, exportConfirmDays });
    const stamp = iso(at);
    const stateFile = path.join(root, 'data', 'resilience', 'silent-state.json');
    const previous = readJson(stateFile) || { findings: {} };
    const previousDrifts = previous.drifts && typeof previous.drifts === 'object' && !Array.isArray(previous.drifts)
        ? previous.drifts
        : {};
    const previousResolved = Array.isArray(previous.resolved_drifts) ? previous.resolved_drifts : [];
    const nextFindings = {};
    const openDrifts = {};
    const activeFingerprints = new Set();
    const resolvedDrifts = [...previousResolved];
    const newlyResolvedDrifts = [];

    for (const finding of detected.findings) {
        const prior = previous.findings?.[finding.code];
        const priorDriftFirstSeen = Object.values(previousDrifts)
            .filter(drift => drift.code === finding.code)
            .map(drift => Date.parse(drift.first_seen))
            .filter(Number.isFinite)
            .sort((a, b) => a - b)[0];
        const firstSeen = prior?.first_seen || (priorDriftFirstSeen ? iso(priorDriftFirstSeen) : stamp);
        const silentHours = round((at.getTime() - Date.parse(firstSeen)) / 3600000, 1);
        finding.first_seen = firstSeen;
        finding.silent_hours = silentHours;
        finding.occurrences = Number(prior?.occurrences || 0) + 1;
        if (silentHours >= silenceBudgetHours) {
            finding.escalated = true;
            if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK.critical) finding.severity = 'critical';
            finding.detail = `${finding.detail} (unresolved for ${silentHours}h; silence budget ${silenceBudgetHours}h exceeded)`;
        }

        finding.new_drifts = [];
        finding.newly_escalated_drifts = [];
        for (const drift of finding.drifts || []) {
            const priorDrift = previousDrifts[drift.fingerprint];
            const driftFirstSeen = priorDrift?.first_seen || stamp;
            const driftSilentHours = round((at.getTime() - Date.parse(driftFirstSeen)) / 3600000, 1);
            const driftEscalated = Boolean(priorDrift?.escalated) || driftSilentHours >= silenceBudgetHours;
            const entry = {
                ...drift,
                code: finding.code,
                status: 'open',
                first_seen: driftFirstSeen,
                last_seen: stamp,
                occurrences: Number(priorDrift?.occurrences || 0) + 1,
                silent_hours: driftSilentHours,
                severity: driftEscalated
                    ? 'critical'
                    : (FINDING_CATALOG[finding.code]?.severity || finding.severity),
                escalated: driftEscalated,
                escalated_at: priorDrift?.escalated_at || (driftEscalated ? stamp : null)
            };
            openDrifts[drift.fingerprint] = entry;
            activeFingerprints.add(drift.fingerprint);
            Object.assign(drift, {
                status: entry.status,
                first_seen: entry.first_seen,
                last_seen: entry.last_seen,
                occurrences: entry.occurrences,
                silent_hours: entry.silent_hours,
                severity: entry.severity,
                escalated: entry.escalated,
                escalated_at: entry.escalated_at
            });
            if (!priorDrift) finding.new_drifts.push(drift.fingerprint);
            if (driftEscalated && !priorDrift?.escalated) finding.newly_escalated_drifts.push(drift.fingerprint);
        }

        nextFindings[finding.code] = {
            first_seen: firstSeen,
            last_seen: stamp,
            occurrences: finding.occurrences,
            severity: finding.severity,
            drift_fingerprints: finding.drift_fingerprints || [],
            new_drift_fingerprints: finding.new_drifts,
            open_drift_count: (finding.drifts || []).length,
            escalated_drift_count: (finding.drifts || []).filter(drift => drift.escalated).length
        };
    }

    for (const [fingerprint, priorDrift] of Object.entries(previousDrifts)) {
        if (activeFingerprints.has(fingerprint)) continue;
        if (canResolveDrifts(priorDrift.code, detected.evidence)) {
            const resolved = {
                ...priorDrift,
                status: 'resolved',
                resolved_at: stamp
            };
            resolvedDrifts.push(resolved);
            newlyResolvedDrifts.push(resolved);
        } else {
            // An audit that could not verify this source must not silently
            // resolve a previously observed drift.
            openDrifts[fingerprint] = {
                ...priorDrift,
                status: 'open',
                unchecked_at: stamp
            };
        }
    }

    const cappedResolvedDrifts = resolvedDrifts.slice(-MAX_RESOLVED_DRIFTS);
    const plan = buildRedressPlan(detected.findings, {
        now: at,
        evidence: detected.evidence,
        resolvedDrifts: newlyResolvedDrifts
    });
    let triggered = [];
    let written = null;

    if (write) {
        const incidentDir = path.join(root, 'data', 'resilience', 'incidents');
        fs.mkdirSync(incidentDir, { recursive: true });
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({
            updated_at: stamp,
            findings: nextFindings,
            drifts: openDrifts,
            resolved_drifts: cappedResolvedDrifts
        }, null, 2));
        fs.writeFileSync(
            path.join(root, 'data', 'resilience', 'contentieux.json'),
            JSON.stringify({
                generated_at: stamp,
                total_pos: detected.evidence.procurement?.total || 0,
                min_days: stallDays,
                totals: detected.evidence.procurement?.contentieux || { cases: 0, amount_at_stake_mad: 0, oldest_waiting_days: 0, high_severity: 0 },
                cases: detected.evidence.procurement?.contentieux_cases || []
            }, null, 2)
        );
        if (detected.findings.length) {
            const incidentFile = path.join(incidentDir, `${plan.incident_id}.json`);
            fs.writeFileSync(incidentFile, JSON.stringify({ plan, evidence: detected.evidence }, null, 2));
            appendAudit(root, {
                level: 'policy',
                message: 'Silent-failure audit recorded',
                data: {
                    incident_id: plan.incident_id,
                    severity: plan.severity,
                    codes: detected.findings.map(finding => finding.code)
                }
            }, at);
            written = { incident: incidentFile, state: stateFile };
        } else {
            written = { incident: null, state: stateFile };
        }

        const redressEngine = engine || new RedressEngine({ root });
        triggered = redressEngine.evaluate({
            revenue_stall_days: detected.evidence.revenue?.stalled_days ?? 0,
            heartbeat_ok: detected.evidence.heartbeat?.status === 'ok',
            stall_days: stallDays,
            duplicate_rate: detected.evidence.monotony?.duplicate_rate || 0,
            duplicate_settlements_on_cycle: detected.evidence.duplicates?.count || 0,
            current_cycle_id: detected.evidence.duplicates?.cycle_id || null,
            context_drift_detected: false
        }).triggered;
    }

    return {
        findings: detected.findings,
        evidence: detected.evidence,
        plan,
        state: {
            updated_at: stamp,
            findings: nextFindings,
            drifts: openDrifts,
            resolved_drifts: cappedResolvedDrifts
        },
        resolved_drifts: newlyResolvedDrifts,
        triggered,
        written
    };
}

export default runSilentFailureAudit;
