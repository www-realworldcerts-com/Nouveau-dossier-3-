import fs from 'fs'
import path from 'path'
import { readEncryptedJson, writeJsonAtomic } from '../src/security/data-at-rest.mjs'

function readJson(p) {
  if (!fs.existsSync(p)) return null
  try {
    return readEncryptedJson(p)
  } catch {
    return null
  }
}

function writeJson(p, data) {
  writeJsonAtomic(p, data)
}

function nowIso() {
  return new Date().toISOString()
}

function parseArgs() {
  const args = process.argv.slice(2)
  const result = {}
  for (const a of args) {
    const [k, v] = a.startsWith('--') ? a.substring(2).split('=') : [null, null]
    if (k) result[k] = v
  }
  return result
}

function generateReceipt(batch) {
  const ts = Date.now()
  const outDir = path.join('exports', 'receipts')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `payoneer_awaiting_bank_confirmation_${batch.data.batch_id}_${ts}.json`)

  const receipt = {
    kind: 'payoneer_reconciliation',
    batch_id: batch.data.batch_id,
    amount: batch.data.amount,
    currency: batch.data.currency,
    rail: batch.data.rail,
    previous_status: batch.data.status,
    current_status: 'awaiting_bank_confirmation',
    created_at: nowIso(),
    next_check_at: batch.data.metadata?.next_check_at || null,
    metadata: {
      documentation: batch.data.metadata?.documentation || null,
      note: batch.data.metadata?.note || null
    },
    owner_accounts: {
      bank_rib: process.env.OWNER_BANK_RIB || '007810000448500030594182',
      payoneer_id: process.env.OWNER_PAYONEER_ID || 'younestsouli2019@gmail.com'
    },
    actions: [
      'monitor auto-withdrawal from Payoneer receiving account',
      'verify bank credit via statement import or provider API',
      'attach bank reference ID to batch',
      'mark settled when bank confirmation present'
    ],
    sla: {
      verification_window_hours: 72,
      escalation: 'agent_audit_if_exceeded'
    }
  }

  writeJson(file, receipt)
  return file
}

function reconcile(batchId) {
  const ledgerPath = path.join('data', 'autonomous', 'ledger', `batch_${batchId}.json`)
  const batch = readJson(ledgerPath)
  if (!batch || !batch.data) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'batch_not_found', batchId }) + '\n')
    process.exit(2)
  }

  const status = String(batch.data.status || '').toLowerCase()
  const acceptable = ['pending_platform_hold', 'auto_withdrawal_scheduled']
  if (!acceptable.includes(status)) {
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'status_not_eligible', status }) + '\n')
    return
  }

  const nextCheckAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  batch.data.status = 'awaiting_bank_confirmation'
  batch.data.metadata = {
    ...(batch.data.metadata || {}),
    reconciliation_reason: 'no_bank_confirmation',
    reconciliation_updated_at: nowIso(),
    next_check_at: nextCheckAt
  }
  writeJson(ledgerPath, batch)

  const receiptPath = generateReceipt(batch)
  process.stdout.write(JSON.stringify({ ok: true, ledger_updated: ledgerPath, receipt: receiptPath }) + '\n')
}

function main() {
  const args = parseArgs()
  const batchId = args.batch || process.env.BATCH_ID || 'BATCH_PAYONEER_X_1767529200'
  reconcile(batchId)
}

main()
