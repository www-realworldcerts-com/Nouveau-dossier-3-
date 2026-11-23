#!/usr/bin/env node
/**
 * CI gate for the money path.
 *
 * `doctor:money` is the authority on whether a deployment can take a paid
 * order, but a bare run cannot gate CI: a runner holds the deployment's
 * secrets only when they are configured, so every credential step reports a
 * failure that no code change can clear.
 *
 * So this wrapper runs the doctor offline and splits its failures by what the
 * runner actually has:
 *
 *   structural  the money path is broken in the configuration this process
 *               was given (unreadable catalog, a blocking checkout gate, an
 *               unwritable attempt store, a dead access route). Always fails.
 *
 *   unconfigured  a credential step whose every blamed variable is unset.
 *               That is a runner without the deployment's env, not a broken
 *               checkout, so it fails by default — a deploy that cannot take a
 *               paid order must not ship green — and `--allow-unverified`
 *               downgrades it to a warning for fork pull requests, which never
 *               receive Actions secrets.
 *
 * A blamed variable that *is* set makes the step structural: present-but-wrong
 * configuration is never excused as unverified. Annotations are emitted
 * whenever GITHUB_ACTIONS is set, so CI needs no extra flag.
 *
 *   node scripts/money-readiness.mjs [--allow-unverified] [--json]
 */

import { spawnSync } from 'node:child_process';

// The steps that need the deployment's credentials, by the doctor's own ids.
// `capture` is included because the doctor derives it from `orders`: if orders
// is unconfigured, capture fails too, and it must be excused with it.
const CREDENTIAL_STEPS = new Set(['quote', 'orders', 'capture', 'fulfillment']);

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const allowUnverified = args.has('--allow-unverified');
const annotate = process.env.GITHUB_ACTIONS === 'true';

const doctor = spawnSync(
    process.execPath,
    ['scripts/doctor-money.mjs', '--offline', '--json'],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
);

let steps = null;
try {
    steps = JSON.parse(doctor.stdout).steps;
} catch { /* reported below as the doctor step failing */ }

// The doctor blames entries like `PAYPAL_CLIENT_ID`, `SWARM_LIVE=true` or
// `OWNER_PAYPAL_EMAIL (or OWNER_PAYONEER_ID / OWNER_BANK_ACCOUNT)`; the leading
// identifier is the variable that decides whether the runner has it.
function envName(entry) {
    return String(entry ?? '').match(/[A-Za-z][A-Za-z0-9_]*/)?.[0] ?? '';
}

function isSet(entry) {
    return Boolean(String(process.env[envName(entry)] ?? '').trim());
}

function escapeAnnotation(text) {
    return String(text ?? '').replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, ' ');
}

const entries = [];
if (!Array.isArray(steps)) {
    entries.push({
        id: 'doctor',
        title: 'Money path preflight',
        detail: `doctor:money did not produce a readable report (exit ${doctor.status}): `
            + `${String(doctor.stderr || doctor.stdout || '').trim().slice(-400) || 'no output'}`,
        env: [],
        unconfigured: false,
        level: 'error'
    });
}

for (const step of Array.isArray(steps) ? steps : []) {
    if (step?.status !== 'fail') continue;
    const env = step.env ?? [];
    const unconfigured = CREDENTIAL_STEPS.has(step.id)
        && env.length > 0
        && env.every(entry => !isSet(entry));
    entries.push({
        id: step.id,
        title: step.title,
        detail: step.detail,
        env,
        unconfigured,
        level: unconfigured && allowUnverified ? 'warning' : 'error',
        message: unconfigured
            ? (allowUnverified
                ? `${step.title} not verified: this runner has no ${env.map(envName).join(', ')}`
                : `${step.title} cannot take a paid order: set ${env.map(envName).join(', ')}`)
            : `${step.title} is broken in this configuration: ${step.detail}`
    });
}

const structural = entries.filter(entry => !entry.unconfigured);
const unconfigured = entries.filter(entry => entry.unconfigured);
const blocked = entries.filter(entry => entry.level === 'error');
const needs = [...new Set(unconfigured.flatMap(entry => entry.env.map(envName)))];

if (asJson) {
    console.log(JSON.stringify({
        ok: entries.length === 0,
        passed: blocked.length === 0,
        allow_unverified: allowUnverified,
        doctor_exit: doctor.status,
        structural_failures: structural,
        credential_gated: unconfigured,
        needs
    }, null, 2));
} else {
    console.log('Money readiness gate');
    console.log('='.repeat(64));
    if (entries.length === 0) console.log('doctor:money reports the whole paid-order path configured.');
    for (const entry of entries) {
        console.log(`[${entry.level === 'warning' ? 'SKIP' : 'FAIL'}] ${entry.title}: ${entry.detail}`);
        if (entry.env.length) console.log(`       env: ${entry.env.join(', ')}`);
    }
    console.log('-'.repeat(64));
    if (entries.length === 0) {
        console.log('PASS: a paid order can be quoted, created, captured and delivered.');
    } else if (structural.length) {
        console.log(`${structural.length} structural failure(s): this deployment cannot complete a paid order.`);
    } else if (allowUnverified) {
        console.log(`NOT VERIFIED: ${unconfigured.length} step(s) need deployment credentials absent from this runner.`);
    } else {
        console.log(`${unconfigured.length} failure(s): this deployment cannot complete a paid order.`);
        console.log(`Set ${needs.join(', ')} where it is deployed, then re-run this gate.`);
    }
}

if (annotate) {
    for (const entry of blocked.concat(entries.filter(entry => entry.level === 'warning'))) {
        console.error(`::${entry.level}::money readiness: ${escapeAnnotation(entry.message)}`);
    }
}

process.exit(blocked.length === 0 ? 0 : 1);
