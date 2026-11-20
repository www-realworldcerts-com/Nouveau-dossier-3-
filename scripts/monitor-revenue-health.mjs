#!/usr/bin/env node
// scripts/monitor-revenue-health.mjs
// Real-time monitoring script for revenue system health

import { buildBase44Client } from '../src/base44-client.mjs';
import { getRevenueConfigFromEnv } from '../src/base44-revenue.mjs';
import { classifyRevenueEvent } from '../src/real/revenue-verification.mjs';
import '../src/load-env.mjs';

async function monitorRevenueHealth() {
    console.log('📊 Revenue System Health Check');
    console.log('='.repeat(60));
    console.log(`Timestamp: ${new Date().toISOString()}\n`);

    try {
        const base44 = await buildBase44Client();
        const revenueConfig = getRevenueConfigFromEnv();
        const revenueEntity = base44.asServiceRole.entities[revenueConfig.entityName];

        // Fetch recent revenue events
        console.log('🔍 Fetching revenue events from Base44...');
        const events = await revenueEntity.list("-created_date", 100, 0);

        if (!events || events.length === 0) {
            console.log('ℹ️  No revenue events found in ledger');
            return;
        }

        // Calculate metrics. `verified` means a payment-provider transaction id
        // backs the event, never just a status string the system wrote itself.
        const verdicts = events.map(e => ({ event: e, verdict: classifyRevenueEvent(e) }));
        const verified = verdicts.filter(v => v.verdict.verified).map(v => v.event);
        const unverified = verdicts.filter(v => !v.verdict.verified).map(v => v.event);
        const selfIssued = verdicts.filter(v => v.verdict.reason === 'self_issued_proof').map(v => v.event);
        const settled = verified.filter(e => e.settled === true);
        const pending = verified.filter(e => !e.settled);
        const failed = events.filter(e => e.status === 'FAILED' || e.status === 'ERROR');

        const totalRevenue = verified.reduce((sum, e) => sum + Number(e.amount || 0), 0);
        const unverifiedRevenue = unverified.reduce((sum, e) => sum + Number(e.amount || 0), 0);
        const selfIssuedRevenue = selfIssued.reduce((sum, e) => sum + Number(e.amount || 0), 0);
        const settledRevenue = settled.reduce((sum, e) => sum + Number(e.amount || 0), 0);
        const pendingRevenue = pending.reduce((sum, e) => sum + Number(e.amount || 0), 0);

        // Display metrics
        console.log('\n📈 Revenue Metrics (Last 100 events):');
        console.log(`   Total Events: ${events.length}`);
        console.log(`   Verified: ${verified.length} (provider transaction id present)`);
        console.log(`   Unverified: ${unverified.length}`);
        console.log(`   Self-issued proofs: ${selfIssued.length}`);
        console.log(`   Settled: ${settled.length}`);
        console.log(`   Pending Settlement: ${pending.length}`);
        console.log(`   Failed: ${failed.length}`);

        console.log('\n💰 Financial Summary:');
        console.log(`   Verified Revenue: $${totalRevenue.toFixed(2)}`);
        console.log(`   Unverified Revenue (not counted as revenue): $${unverifiedRevenue.toFixed(2)}`);
        if (selfIssued.length) {
            console.log(`   Of which self-issued proofs: $${selfIssuedRevenue.toFixed(2)}`);
        }
        console.log(`   Settled: $${settledRevenue.toFixed(2)} (${totalRevenue > 0 ? ((settledRevenue / totalRevenue) * 100).toFixed(1) : 0}%)`);
        console.log(`   Pending: $${pendingRevenue.toFixed(2)}`);

        // Alert if pending revenue is high
        const alertThreshold = Number(process.env.ALERT_PENDING_REVENUE_THRESHOLD || 1000);
        if (pendingRevenue > alertThreshold) {
            console.warn(`\n⚠️  HIGH PENDING REVENUE ALERT`);
            console.warn(`   Pending: $${pendingRevenue.toFixed(2)} (threshold: $${alertThreshold})`);
            console.warn(`   Action: Review and approve pending settlements`);
        }

        // Check recent settlements (last 24 hours)
        const recentSettled = settled.filter(e => {
            if (!e.settled_at) return false;
            const settledAt = new Date(e.settled_at);
            const hoursSince = (Date.now() - settledAt.getTime()) / (1000 * 60 * 60);
            return hoursSince < 24;
        });

        if (recentSettled.length > 0) {
            console.log(`\n✅ Recent Settlements (Last 24h):`);
            console.log(`   Events: ${recentSettled.length}`);
            const recentAmount = recentSettled.reduce((sum, e) => sum + Number(e.amount || 0), 0);
            console.log(`   Amount: $${recentAmount.toFixed(2)}`);

            // Show breakdown by payout batch
            const batches = {};
            recentSettled.forEach(e => {
                const batchId = e.payout_batch_id || 'UNKNOWN';
                if (!batches[batchId]) {
                    batches[batchId] = { count: 0, amount: 0 };
                }
                batches[batchId].count++;
                batches[batchId].amount += Number(e.amount || 0);
            });

            console.log('\n   Batches:');
            Object.entries(batches).forEach(([batchId, data]) => {
                console.log(`   - ${batchId}: ${data.count} events, $${data.amount.toFixed(2)}`);
            });
        }

        // Check for old pending events
        const oldPending = pending.filter(e => {
            const createdAt = new Date(e.created_at || e.timestamp);
            const hoursSince = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
            return hoursSince > 24;
        });

        if (oldPending.length > 0) {
            console.warn(`\n⚠️  OLD PENDING EVENTS ALERT`);
            console.warn(`   ${oldPending.length} events pending for > 24 hours`);
            const oldAmount = oldPending.reduce((sum, e) => sum + Number(e.amount || 0), 0);
            console.warn(`   Amount: $${oldAmount.toFixed(2)}`);
            console.warn(`   Action: Check autonomous daemon status`);
        }

        // System health summary
        console.log('\n' + '='.repeat(60));
        const healthScore = settled.length / Math.max(verified.length, 1);
        if (healthScore >= 0.9) {
            console.log('✅ System Health: EXCELLENT');
        } else if (healthScore >= 0.7) {
            console.log('✅ System Health: GOOD');
        } else if (healthScore >= 0.5) {
            console.warn('⚠️  System Health: FAIR - Review pending settlements');
        } else {
            console.error('❌ System Health: POOR - Immediate action required');
        }
        console.log(`   Settlement Rate: ${(healthScore * 100).toFixed(1)}%`);

    } catch (error) {
        console.error('\n❌ Health check failed:', error.message);
        if (error.message.includes('Base44')) {
            console.error('   Check Base44 configuration and connectivity');
        }
        process.exit(1);
    }
}

// Run monitoring
monitorRevenueHealth().catch(error => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
});
