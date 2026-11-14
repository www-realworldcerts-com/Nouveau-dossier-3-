# Autonomous Revenue Swarm

## Overview
This system is an autonomous revenue generation and settlement engine designed to operate with minimal human intervention. It leverages a swarm of specialized agents to identify opportunities, execute tasks, and settle funds to verified owner accounts.

## 🧩 Subprojects

- **[JARVIS](jarvis/README.md)** — Next.js 16 agent dashboard (chat, voice, swarm,
  uploads). Has its own Bun lockfile; run its commands from `jarvis/`.
- Open both projects in one IDE window with [`swarm.code-workspace`](swarm.code-workspace).
- Agent/Copilot conventions live in [`.github/copilot-instructions.md`](.github/copilot-instructions.md)
  and [`jarvis/AGENTS.md`](jarvis/AGENTS.md).

## 📚 Documentation
Comprehensive documentation is available in the `docs/` directory:

- **[Testing Strategy](docs/TESTING_STRATEGY.md)**: Details on unit, integration, and live-mode testing.
- **[Security Policy](docs/SECURITY_POLICY.md)**: "No Private Key" policy, owner-only settlement, and audit trails.
- **[Disaster Recovery](docs/DISASTER_RECOVERY.md)**: Backup procedures, restoration guides, and Bunker Mode.
- **[Operational Manual](docs/OPERATIONAL_MANUAL.md)**: Monitoring, deployment, and rate limit management.
- **[Compliance Framework](docs/COMPLIANCE_FRAMEWORK.md)**: GDPR, KYC, AML, and tax reporting standards.

## 🚀 Quick Start

### Installation
```bash
git clone <repo_url>
npm install
```

### Running the System
```bash
npm start
```
*Starts the Swarm Orchestrator with full health monitoring and rate limiting.*

### Testing
```bash
npm test
```
*Runs the full system integrity suite.*

### Disaster Recovery Backup
```bash
DATA_ENCRYPTION_KEY='...' npm run backup
```
*Creates an encrypted snapshot of critical data. Restore with `npm run restore:backup`.*

## 🔐 Encryption at rest

Financial stores and backups are encrypted with AES-256-GCM when
`DATA_ENCRYPTION_KEY` (or `DATA_ENCRYPTION_KEY_FILE`) is set. The read-only audit
and the dry-run-first migration/rotation/rollback commands are documented in
[docs/DATA_AT_REST.md](docs/DATA_AT_REST.md). Never commit the key.

## 🛡️ Core Principles
1. **No Simulation**: All actions must be real.
2. **Owner Only**: Funds only move to verified accounts.
3. **Proof of Settlement**: All status updates require external proof.

## 🤝 Agent Payment API

- Programmatic usage:
  - Module: src/api/external-payment-api.mjs
  - Methods: requestAutoSettlement, requestPayPalPayout, updatePayoutStatus, getGatewayBalance
- HTTP service:
  - Module: src/api/external-payment-server.mjs
  - Endpoints:
    - POST /api/settlement/auto
    - POST /api/payout/paypal
    - POST /api/payout/status
    - GET /api/balance/paypal
    - GET /api/audit/verify?date=YYYY-MM-DD
- Requirements:
  - SWARM_LIVE=true
  - AUDIT_HMAC_SECRET set for append-only audit signing
  - AGENT_API_TOKENS set with one or more bearer tokens

## 🔌 Agent IPC Interface (Firewall-Independent)

- Named pipe server:
  - Module: src/api/external-payment-ipc-server.mjs
  - Default pipe: \\\\.\\pipe\\SwarmExternalPayment
- Client helper:
  - Module: src/api/external-payment-ipc-client.mjs
  - Example:
    ```javascript
    import { ipcCall } from './src/api/external-payment-ipc-client.mjs';
    const token = process.env.AGENT_API_TOKENS.split(',')[0];
    const res = await ipcCall({
      path: '/settlement/auto',
      token,
      body: { payoutBatchId: 'BATCH_TEST', items: [{ amount: 25, currency: 'USD', recipient_email: 'younestsouli2019@gmail.com' }] }
    });
    console.log(res);
    ```
