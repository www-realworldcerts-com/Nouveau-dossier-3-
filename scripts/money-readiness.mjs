#!/usr/bin/env node
/**
 * CI gate for the money path.
 *
 * `doctor:money` is the authority on whether a deployment can take a paid
 * order, but it cannot run unchanged on a CI runner: the runner holds the
 * deployment's secrets only when they are configured, so a bare run reports
 * every credential step as failing — and a repository that never configured
 * them still passed, because nothing called the doctor.
 *
 * This wrapper calls the doctor and splits its failures in two:
 *
 *   structural  the money path is broken *here*, with the config this process
 *               actually has (catalog unreadable, checkout gate blocking, an
 *               attempt store that cannot be written, a dead access route).
 *               Always fails the build; no secret would change the verdict.
 *
 *   credential  every env name the step blames is absent from this process.
 *               That is a runner without the deployment's configuration, not
 *               evidence of a broken checkout, so it fails by default — a
 *               deploy that cannot take a paid order must not ship green — and
 *               `--allow-unverified` downgrades it to a warning for pull
 *               requests from forks, which GitHub never gives secrets to.
 *
 * The split is deliberately conservative: a step whose env names are set but
 * whose check still fails is structural, never "unverified".
 *
 * Always exits 0 or 1, and prints what to configure either way.
 *
 *   node scripts/money-readiness.mjs [--allow-unverified] [--github-actions] [--json]
 */

import { spawnSync } from 'node:child_process';

// The env names that mean "this runner does not have the deployment's
// configuration". A value that is present is never waved through, and a name
// that is not listed here (a catalog path, a gate URL, a store directory) is
// always structural, because an absent one of those breaks the money path
// rather than proving the runner is unconfigured.
const CREDENTIAL_VARS = new Set([
    'PRICE_QUOTE_SECRET',
    'PRICE_QUOTE_KEY_ID',
    'PRICE_QUOTE_PREVIOUS_SECRET',
    'PAYPAL_ENABLE_ORDER_CREATE',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_MODE',
    'PAYPAL_WEBHOOK_ID',
    'SWARM_LIVE',
    'NO_PLATFORM_WALLET',
    'BASE44_OFFLINE',
    'OWNER_PAYPAL_EMAIL',
    'OWNER_PAYONEER_ID',
    'OWNER_BANK_ACCOUNT',
    'FULFILLMENT_ENABLED',
    'FULFILLMENT_ACCESS_SECRET',
    'RESEND_API_KEY'
]);

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const allowUnverified = args.has('--allow-unverified');
const annotate = args.has('--github-actions');

function has(name) {
    return Boolean(String(process.env[name] ?? '').trim());
}

/** `PAYPAL_ENABLE_ORDER_CREATE=true` -> `PAYPAL_ENABLE_ORDER_CREATE`. */
function envName(entry) {
    return String(entry ?? '').split('=')[0].trim();
}

function escapeAnnotation(text) {
    return String(text ?? '')
        .replace(/%/g, '%25')
        .replace(/\r/g, '')
        .replace(/\n/g, ' ')
        .replace(/:/g, '%3A');
}

function note(level, message) {
    if (!annotate) return;
    const line = `::${level}::money readiness: ${escapeAnnotation(message)}`;
    if (level === 'error') console.error(line);
    else console.log(line);
}

const doctor = spawnSync(
    process.execPath,
    ['scripts/doctor-money.mjs', '--offline', '--json'],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
);

let steps = null;
let doctorReport = null;
try {
    doctorReport = JSON.parse(doctor.stdout);
    steps = Array.isArray(doctorReport?.steps) ? doctorReport.steps : null;
} catch {
    steps = null;
}

const structural = [];
const credentialGated = [];

if (!steps) {
    structural.push({
        id: 'doctor',
        title: 'Money path preflight',
        env: [],
        detail: `doctor:money did not produce a readable report (exit ${doctor.status}): `
            + `${String(doctor.stderr || doctor.stdout || '').trim().slice(-400) || 'no output'}`
    });
} else {
    for (const step of steps.filter(entry => entry?.status === 'fail')) {
        const names = (step.env ?? []).map(envName).filter(Boolean);
        const absentCredentials = names.length > 0
            && names.every(name => CREDENTIAL_VARS.has(name) && !has(name));
        const record = {
            id: step.id,
            title: step.title,
            env: step.env ?? [],
            detail: step.detail
        };
        if (absentCredentials) credentialGated.push(record);
        else structural.push(record);
    }
}

const needs = [...new Set(credentialGated.flatMap(entry => entry.env))];
const verified = structural.length === 0 && credentialGated.length === 0;
const pass = structural.length === 0 && (credentialGated.length === 0 || allowUnverified);

if (asJson) {
    console.log(JSON.stringify({
        ok: verified,
        verified,
        allow_unverified: allowUnverified,
        passed: pass,
        doctor_exit: doctor.status,
        structural_failures: structural,
        credential_gated: credentialGated,
        needs,
        summary: doctorReport?.summary ?? null
    }, null, 2));
} else {
    console.log('Money readiness gate');
    console.log('='.repeat(64));
    if (verified) {
        console.log('doctor:money reports the whole paid-order path configured.');
    }
    for (const entry of structural) {
        console.log(`[FAIL] ${entry.title}: ${entry.detail}`);
        if (entry.env.length) console.log(`       env: ${entry.env.join(', ')}`);
        note('error', `${entry.title} is broken in this configuration: ${entry.detail}`);
    }
    for (const entry of credentialGated) {
        const mark = allowUnverified ? 'SKIP' : 'FAIL';
        console.log(`[${mark}] ${entry.title}: ${entry.detail}`);
        if (entry.env.length) console.log(`       env: ${entry.env.join(', ')}`);
        if (allowUnverified) {
            note('warning', `${entry.title} not verified: this runner has no ${entry.env.map(envName).join(', ')}`);
        } else {
            note('error', `${entry.title} cannot take a paid order: set ${entry.env.map(envName).join(', ')}`);
        }
    }
    console.log('-'.repeat(64));
    if (verified) {
        console.log('PASS: a paid order can be quoted, created, captured and delivered.');
    } else if (structural.length) {
        console.log(`${structural.length} structural failure(s): this deployment cannot complete a paid order.`);
    } else if (allowUnverified) {
        console.log(`NOT VERIFIED: ${credentialGated.length} step(s) need deployment credentials absent from this runner.`);
    } else {
        console.log(`${credentialGated.length} failure(s): this deployment cannot complete a paid order.`);
        console.log(`Set ${needs.map(envName).join(', ')} where it is deployed, then re-run this gate.`);
    }
}

process.exit(pass ? 0 : 1);
