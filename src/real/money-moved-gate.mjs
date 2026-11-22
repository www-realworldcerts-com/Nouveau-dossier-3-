// src/real/money-moved-gate.mjs
import { ProofValidator } from './proof-validator.mjs';
import { EvidenceIntegrityChain } from './evidence-integrity.mjs';
import { classifyRevenueProof } from './revenue-verification.mjs';
import { RedressEngine } from '../resilience/redress.mjs';

/** The only statuses that can mean money moved. */
const MOVED_STATUSES = ['VERIFIED', 'settled', 'paid_out'];

export class MoneyMovedGate {
  /**
   * HARD GATE:
   * This must be called before:
   * - settlement
   * - reporting
   * - revenue aggregation
   */
  static async assertMoneyMoved(event) {
    if (!event) {
      throw new Error('MONEY_GATE_FAIL: event_missing');
    }

    // A velocity-without-revenue freeze halts new settlements until the
    // capital-efficiency audit is done or the freeze expires.
    const redress = new RedressEngine();
    if (!redress.isSettlementAllowed()) {
      throw new Error('MONEY_GATE_FAIL: settlement_frozen_velocity_without_revenue');
    }

    if (event.status === 'hallucination') {
      throw new Error('MONEY_GATE_FAIL: hallucinated_event');
    }

    // 1. The proof object must name a transaction a provider issued. A proof
    //    the system generated about itself (`autonomous_execution`, a
    //    `PROOF_*` id) is a claim, not evidence that money moved, so the gate
    //    refuses it here instead of trusting a downstream validator to keep
    //    noticing.
    const proof = event.verification_proof || event.metadata?.verification_proof || null;
    if (proof) {
      const verdict = classifyRevenueProof(proof);
      if (!verdict.verified) {
        const id = verdict.psp_id ? `: ${verdict.psp_id}` : '';
        throw new Error(`MONEY_GATE_FAIL: proof_not_provider_backed (${verdict.reason}${id})`);
      }
    }

    // 2. Proof must be invariant-valid
    await ProofValidator.assertValid(event);

    // 3. Evidence must be immutably chained
    await EvidenceIntegrityChain.assertEventBound(event.id);

    // 4. Settlement is a one-way door: an event that is already settled must
    //    not be settled (or reported as newly moved money) a second time.
    if (event.settled === true) {
      throw new Error('MONEY_GATE_FAIL: already_settled');
    }

    // 5. The event must claim money moved. Anything else is still verifying,
    //    and this gate is not the place to confirm it.
    if (!MOVED_STATUSES.includes(event.status)) {
      throw new Error(`MONEY_GATE_FAIL: invalid_status (${event.status})`);
    }

    // If this returns, money is REAL
    return true;
  }
}
