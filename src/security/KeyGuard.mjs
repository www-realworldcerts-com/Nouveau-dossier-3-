import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { computeConstitutionHashFromFile } from '../bootstrap/constitution-validator.mjs';

/**
 * Owner-signature preflight used by the revenue runner.
 *
 * The module was missing, which made `src/revenue/swarm-runner.mjs` (and every
 * script importing it) fail at module load. This implementation reports the
 * truth instead of assuming success: it checks the constitution hash and, when
 * an owner public key is available, verifies the Ed25519 signature over it.
 * Verification is never reported as `verified: true` without a real check.
 */

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function loadPublicKey(root) {
    if (process.env.OWNER_PUBLIC_KEY) return process.env.OWNER_PUBLIC_KEY;
    const keyPath = process.env.OWNER_PUBLIC_KEY_PATH
        ? path.resolve(process.env.OWNER_PUBLIC_KEY_PATH)
        : path.join(root, 'owner_public.key');
    return readText(keyPath);
}

export function verifySignature({ signature, constitutionHash, publicKey }) {
    try {
        return crypto.verify(
            null,
            Buffer.from(constitutionHash),
            { key: publicKey, format: 'pem', type: 'spki' },
            Buffer.from(String(signature).trim(), 'base64')
        );
    } catch (error) {
        return { error: error.message };
    }
}

export async function ensureOwnerSignature(options = {}) {
    const root = options.root || process.cwd();
    const constitutionPath = options.constitutionPath || path.join(root, 'swarm.constitution.json');
    const hashPath = options.hashPath || path.join(root, 'constitution.hash.txt');
    const signaturePath = options.signaturePath || path.join(root, 'owner.signature');

    let constitutionHash = null;
    try {
        constitutionHash = computeConstitutionHashFromFile(constitutionPath);
    } catch (error) {
        return { ok: false, verified: false, reason: `constitution_unreadable:${error.message}` };
    }

    const recordedHash = readText(hashPath)?.trim() || null;
    const hashMatches = recordedHash === constitutionHash;
    const signature = readText(signaturePath)?.trim() || null;
    if (!signature) {
        return { ok: false, verified: false, reason: 'signature_missing', constitutionHash, hashMatches };
    }
    if (!hashMatches) {
        return { ok: false, verified: false, reason: 'constitution_hash_mismatch', constitutionHash, recordedHash };
    }

    const publicKey = options.publicKey || loadPublicKey(root);
    if (!publicKey) {
        return {
            ok: true,
            verified: false,
            reason: 'public_key_missing',
            constitutionHash,
            hashMatches,
            hint: 'Set OWNER_PUBLIC_KEY or place owner_public.key to verify the owner signature.'
        };
    }

    const result = verifySignature({ signature, constitutionHash, publicKey });
    if (result === true) {
        return { ok: true, verified: true, reason: 'verified', constitutionHash, hashMatches };
    }
    return {
        ok: false,
        verified: false,
        reason: typeof result === 'object' ? `signature_invalid:${result.error}` : 'signature_invalid',
        constitutionHash,
        hashMatches
    };
}
