// src/real/evidence-integrity.mjs
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Configurable so a deployment can put the chain on a durable volume and a
// test can keep it out of the repository. Resolved per call, not at import.
function chainPath() {
    const configured = String(process.env.EVIDENCE_CHAIN_PATH ?? '').trim();
    return configured ? path.resolve(configured) : path.join(process.cwd(), 'data', 'evidence-chain.json');
}

// Appends are read-modify-write, so two captures recorded at once both read the
// same last block and each append the other's predecessor away: the chain forks
// and one branch is lost, which a later settlement then checks against. Every
// append holds this lock, which is a file next to the chain so it also excludes
// a second process on the same volume.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 10;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class EvidenceIntegrityChain {
    
    static async assertEventBound(eventId) {
        const block = await this.fetchBlockForEvent(eventId);

        if (!block) {
            // Auto-create block for legacy/migration if missing?
            // "Hard-Binding" implies NO. 
            // But for the purpose of the "upgrade", we might need to initialize it.
            // For now, fail as per spec.
            throw new Error(
                `INVARIANT_FAIL: evidence_block_missing (${eventId})`
            );
        }

        const recomputedHash = this.calculateBlockHash(block);

        if (recomputedHash !== block.hash) {
            throw new Error(
                `INVARIANT_FAIL: evidence_chain_tampered (${eventId})`
            );
        }

        return true;
    }

    static async fetchBlockForEvent(eventId) {
        const chain = await this.#loadChain();
        return chain.find(b => b.eventId === eventId);
    }

    static calculateBlockHash(block) {
        // Simple hash of content + prevHash
        const content = {
            eventId: block.eventId,
            proof: block.proof,
            prevHash: block.prevHash,
            timestamp: block.timestamp
        };
        return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
    }

    // Helper to add blocks (needed for the system to work)
    static async addBlock(eventId, proof) {
        return this.#withChainLock(async () => {
            const chain = await this.#loadChain();
            const lastBlock = chain[chain.length - 1];
            const prevHash = lastBlock ? lastBlock.hash : 'GENESIS';

            const newBlock = {
                eventId,
                proof,
                prevHash,
                timestamp: new Date().toISOString()
            };

            newBlock.hash = this.calculateBlockHash(newBlock);

            chain.push(newBlock);
            await this.#saveChain(chain);
            return newBlock;
        });
    }

    static async #withChainLock(fn) {
        const file = chainPath();
        const lock = `${file}.lock`;
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const deadline = Date.now() + LOCK_WAIT_MS;
        let handle = null;
        while (handle === null) {
            try {
                handle = fs.openSync(lock, 'wx');
            } catch (err) {
                if (err.code !== 'EEXIST') throw err;
                // A writer that died mid-append must not wedge the chain forever.
                let stale = false;
                try {
                    stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
                } catch {
                    // Released between the open and the stat: try again at once.
                }
                if (stale) {
                    // Steal by rename, not unlink: if the holder released it in
                    // the meantime this fails and we must not delete the fresh
                    // lock a third writer has just taken.
                    const stolen = `${lock}.stale-${process.pid}-${Date.now()}`;
                    try {
                        fs.renameSync(lock, stolen);
                        fs.unlinkSync(stolen);
                    } catch {}
                    continue;
                }
                if (Date.now() > deadline) {
                    throw new Error(`INVARIANT_FAIL: evidence_chain_lock_timeout (${file})`);
                }
                await sleep(LOCK_POLL_MS);
            }
        }

        try {
            return await fn();
        } finally {
            try { fs.closeSync(handle); } catch {}
            try { fs.unlinkSync(lock); } catch {}
        }
    }

    static async #loadChain() {
        const file = chainPath();
        if (!fs.existsSync(file)) {
            return [];
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }

    static async #saveChain(chain) {
        const file = chainPath();
        // The first block of a fresh deploy has no data/ directory yet.
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Write beside the chain and rename, so a reader never sees a half
        // written file and no partial chain is left behind by a crash.
        const staging = `${file}.tmp`;
        fs.writeFileSync(staging, JSON.stringify(chain, null, 2));
        fs.renameSync(staging, file);
    }
}
