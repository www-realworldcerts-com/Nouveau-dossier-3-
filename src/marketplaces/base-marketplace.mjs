#!/usr/bin/env node
// src/marketplaces/base-marketplace.mjs
// Base class for all marketplace integrations

import { OWNER_ACCOUNTS } from '../../opus/swarm_prime_directive.js';

/**
 * PSP Proof structure - REQUIRED for all revenue
 */
export class PSPProof {
    constructor({ provider, transactionId, amount, currency, timestamp, verificationUrl, metadata = {} }) {
        this.provider = provider; // 'upwork', 'fiverr', 'paypal', 'stripe'
        this.transactionId = transactionId;
        this.amount = amount;
        this.currency = currency;
        this.timestamp = timestamp || new Date().toISOString();
        this.verificationUrl = verificationUrl;
        this.metadata = metadata;
    }

    validate() {
        if (!this.provider) throw new Error('PSP proof missing provider');
        if (!this.transactionId) throw new Error('PSP proof missing transaction ID');
        if (!this.amount || this.amount <= 0) throw new Error('PSP proof missing valid amount');
        if (!this.currency) throw new Error('PSP proof missing currency');
        return true;
    }

    toJSON() {
        return {
            provider: this.provider,
            transaction_id: this.transactionId,
            amount: this.amount,
            currency: this.currency,
            timestamp: this.timestamp,
            verification_url: this.verificationUrl,
            metadata: this.metadata,
            validated_at: new Date().toISOString()
        };
    }
}

/**
 * Base Marketplace Connector
 * All marketplace integrations MUST extend this class
 */
export class BaseMarketplace {
    constructor(name, config = {}) {
        this.name = name;
        this.config = config;
        this.stats = {
            missions_found: 0,
            missions_executed: 0,
            missions_paid: 0,
            total_revenue: 0,
            failures: 0
        };
    }

    /**
     * Find available missions/jobs
     * MUST be implemented by subclass
     */
    async findMissions(agentType) {
        throw new Error(`${this.name}: findMissions() not implemented`);
    }

    /**
     * Execute a mission (complete the work)
     * MUST be implemented by subclass
     */
    async executeMission(mission) {
        throw new Error(`${this.name}: executeMission() not implemented`);
    }

    /**
     * Wait for and verify payment
     * MUST return PSPProof or throw error
     */
    async waitForPayment(mission, timeoutMs = 48 * 60 * 60 * 1000) {
        throw new Error(`${this.name}: waitForPayment() not implemented`);
    }

    /**
     * Complete workflow: Find → Execute → Get Paid
     * Returns PSP-verified revenue or null
     */
    async generateRevenue(agentType) {
        try {
            console.log(`[${this.name}] Finding mission for ${agentType.role}...`);

            // Step 1: Find mission
            const missions = await this.findMissions(agentType);
            if (!missions || missions.length === 0) {
                console.log(`[${this.name}] No missions found for ${agentType.role}`);
                return null;
            }

            this.stats.missions_found++;
            const mission = missions[0];
            console.log(`[${this.name}] Found mission: ${mission.title} ($${mission.budget})`);

            // Step 2: Execute mission
            console.log(`[${this.name}] Executing mission...`);
            const executionResult = await this.executeMission(mission);

            if (!executionResult.success) {
                console.error(`[${this.name}] Mission execution failed:`, executionResult.error);
                this.stats.failures++;
                return null;
            }

            this.stats.missions_executed++;
            console.log(`[${this.name}] Mission completed successfully`);

            // Step 3: Wait for payment
            console.log(`[${this.name}] Waiting for payment...`);
            const pspProof = await this.waitForPayment(mission);

            if (!pspProof) {
                console.error(`[${this.name}] Payment not received`);
                this.stats.failures++;
                return null;
            }

            // Validate PSP proof
            pspProof.validate();

            this.stats.missions_paid++;
            this.stats.total_revenue += pspProof.amount;

            console.log(`[${this.name}] ✅ REAL REVENUE: $${pspProof.amount} ${pspProof.currency}`);
            console.log(`[${this.name}] Transaction ID: ${pspProof.transactionId}`);

            return {
                amount: pspProof.amount,
                currency: pspProof.currency,
                source: `${this.name} - ${agentType.role}`,
                revenueEventId: `${this.name.toUpperCase()}_${pspProof.transactionId}`,
                pspProof: pspProof.toJSON()
            };

        } catch (error) {
            console.error(`[${this.name}] Revenue generation failed:`, error.message);
            this.stats.failures++;
            return null;
        }
    }

    getStats() {
        return {
            marketplace: this.name,
            ...this.stats,
            success_rate: this.stats.missions_found > 0
                ? (this.stats.missions_paid / this.stats.missions_found * 100).toFixed(1) + '%'
                : '0%'
        };
    }
}

export default BaseMarketplace;
