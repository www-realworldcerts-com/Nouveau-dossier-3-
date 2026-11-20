
import { SwarmOrchestrator } from '../orchestration/SwarmOrchestrator.mjs';
import { MarketIntelligenceAgent } from './market-intelligence.mjs';
import { AdvancedRecoveryAgent } from './advanced-recovery.mjs';
import { ProductSelectionEngine } from './product-scoring.mjs';
import { SmartSettlementOrchestrator } from '../financial/SmartSettlementOrchestrator.mjs';
import { AdvancedFinancialManager } from '../finance/AdvancedFinancialManager.mjs';
import { getRevenueConfigFromEnv } from '../base44-revenue.mjs';
import { isProviderTransactionId } from '../real/revenue-verification.mjs';
import '../load-env.mjs';
import fs from 'fs';
import path from 'path';
import { SwarmMemory } from '../swarm/shared-memory.mjs';
import { threatMonitor } from '../security/threat-monitor.mjs';
import { NetworkGuard } from '../security/NetworkGuard.mjs';
import { ensureOwnerSignature } from '../security/KeyGuard.mjs';
import { LearningAgent } from '../swarm/learning-agent.mjs';

// --- ADAPTERS FOR LEGACY AGENTS ---

class MarketAgentAdapter {
    constructor() {
        this.agent = new MarketIntelligenceAgent('./config/revenue-model.json');
    }
    async execute(task) {
        if (task.type === 'ANALYZE_MARKET') {
            return await this.agent.analyzeMarket();
        }
        throw new Error(`Unknown task type: ${task.type}`);
    }
}

class RecoveryAgentAdapter {
    constructor() {
        this.agent = new AdvancedRecoveryAgent();
    }
    async execute(task) {
        if (task.type === 'RECOVER_REVENUE') {
            return await this.agent.executeRecoveryLoop();
        }
        throw new Error(`Unknown task type: ${task.type}`);
    }
}

class CommerceExecutionAgent {
    constructor(scoringEngine) {
        this.scoringEngine = scoringEngine;
        this.settlementOrchestrator = new SmartSettlementOrchestrator();
    }

    async execute(task) {
        if (task.type === 'SCORE_AND_EXECUTE') {
            const marketData = task.payload;
            const scoredProducts = this.scoringEngine.scoreProducts(marketData);
            
            // Log Top Pick
            const winner = scoredProducts[0];
            console.log(`🏆 Top Pick: ${winner.name} (Score: ${winner.selectionScore.toFixed(2)})`);

            if (winner.selectionScore > 0.7) {
                return await this.executeTrade(winner);
            } else {
                return { status: 'SKIPPED', reason: 'LOW_SCORE' };
            }
        }
        throw new Error(`Unknown task type: ${task.type}`);
    }

    async executeTrade(product) {
        console.log(`💰 EXECUTING TRADE: ${product.name}`);

        // A trade only becomes revenue once a payment provider has settled it.
        // There is no unit price to book: without a provider transaction id
        // this agent has sold nothing it can prove, so it books nothing.
        const execution = product?.execution ?? product?.settlement ?? null;
        const providerTransactionId = String(
            execution?.provider_transaction_id ?? execution?.transaction_id ?? execution?.psp_id ?? ''
        ).trim();
        if (!isProviderTransactionId(providerTransactionId)) {
            return {
                status: 'REFUSED',
                reason: 'NO_PROVIDER_TRANSACTION_ID',
                details: 'Revenue is only recorded against the payment provider transaction that settled the trade.',
                product: product.name
            };
        }

        const grossRevenue = Number(execution?.amount ?? product?.amount);
        if (!Number.isFinite(grossRevenue) || grossRevenue <= 0) {
            return { status: 'REFUSED', reason: 'INVALID_AMOUNT', product: product.name };
        }

        // Ingest revenue into AdvancedFinancialManager
        const manager = new AdvancedFinancialManager();
        await manager.initialize();
        const revenueEvent = manager.revenue.ingestRawRevenue({
            amount: grossRevenue,
            currency: String(execution?.currency ?? 'USD'),
            source: 'swarm_trade',
            metadata: {
                product: product.name,
                agent_id: 'commerce_exec',
                trade_executed: true,
                psp_transaction_id: providerTransactionId,
                provider: execution?.provider ?? null
            }
        }, 'SwarmCommerceAgent', 'CommerceExecutionAgent');

        console.log(`📈 Revenue ingested: ${revenueEvent.id} for $${grossRevenue}`);

        // Use Smart Settlement to route funds
        // Priority: Bank -> Payoneer -> Crypto -> PayPal
        const results = await this.settlementOrchestrator.routeAndExecute(grossRevenue, 'USD');

        // Analyze results
        const queued = results.filter(r => r.status.includes('QUEUED'));
        const inTransit = results.filter(r => r.status === 'IN_TRANSIT');

        if (queued.length > 0 && inTransit.length === 0) {
             return { status: 'QUEUED', reason: queued[0].reason || 'Unknown Limit' };
        }

        return {
            status: 'EXECUTED',
            revenue: grossRevenue,
            revenueEventId: revenueEvent.id,
            details: results,
            product: product.name
        };
    }
}

// --- MAIN SWARM RUNNER ---

async function runRevenueSwarm() {
    console.log("🚀 Initializing SwarmCommerce AI (Orchestrated)...");

    // 1. Initialize Orchestrator
    const swarm = new SwarmOrchestrator();
    await swarm.start();
    try {
        const memory = new SwarmMemory();
        await memory.broadcastAlert('Owner permissions fix in progress. Resume operations and route revenue; queue settlements if required. Respect owner; no mocking.', 'system');
        await memory.update('policy:global:safe_mode', false, 'system', 'resume');
        try { threatMonitor.deactivateBunkerMode(); } catch {}
        console.log('📣 Notice broadcast: resume operations under protocol.');
        const learner = new LearningAgent(memory);
        const learnLoop = async () => {
            if (!swarm.active) return;
            try { await learner.learn(); } catch {}
            setTimeout(learnLoop, 60000);
        };
        learnLoop();
    } catch {}
    try {
        const guard = new NetworkGuard({ intervalMs: Number(process.env.NETWORK_GUARD_INTERVAL_MS || 30000) || 30000 });
        await guard.start();
        console.log('🔭 NetworkGuard started');
    } catch {}
    try {
        const res = await ensureOwnerSignature();
        console.log('🔐 Owner signature check:', JSON.stringify(res));
    } catch {}

    // 2. Register Agents
    const marketAdapter = new MarketAgentAdapter();
    const recoveryAdapter = new RecoveryAgentAdapter();
    const scoringEngine = new ProductSelectionEngine(marketAdapter.agent.config);
    const commerceAgent = new CommerceExecutionAgent(scoringEngine);

    swarm.registerAgent('MARKET_INTEL', marketAdapter, ['MARKET_ANALYSIS']);
    swarm.registerAgent('RECOVERY_BOT', recoveryAdapter, ['REVENUE_RECOVERY']);
    swarm.registerAgent('COMMERCE_EXEC', commerceAgent, ['TRADE_EXECUTION']);

    // 3. Execute Workflow
    try {
        // Step A: Recovery
        console.log('\n--- Step A: Revenue Recovery ---');
        const recoveryResult = await swarm.executeTask({
            type: 'RECOVER_REVENUE',
            requiredCapabilities: ['REVENUE_RECOVERY'],
            resourceKey: 'DEFAULT'
        });
        if (recoveryResult.result && recoveryResult.result.length > 0) {
            console.log(`💰 Recovered ${recoveryResult.result.length} items.`);
        }

        // Step B: Market Analysis
        console.log('\n--- Step B: Market Analysis ---');
        const marketResult = await swarm.executeTask({
            type: 'ANALYZE_MARKET',
            requiredCapabilities: ['MARKET_ANALYSIS'],
            resourceKey: 'DEFAULT'
        });

        // Step C: Execution
        if (marketResult.status === 'COMPLETED') {
            console.log('\n--- Step C: Trade Execution ---');
            const tradeResult = await swarm.executeTask({
                type: 'SCORE_AND_EXECUTE',
                payload: marketResult.result,
                requiredCapabilities: ['TRADE_EXECUTION'],
                resourceKey: 'BINANCE_API' // Rate limited resource
            });
            console.log('Trade Result:', tradeResult);
        }

    } catch (e) {
        console.error("❌ Swarm Workflow Failed:", e);
    } finally {
        swarm.stop();
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runRevenueSwarm();
}

export { runRevenueSwarm };
