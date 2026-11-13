#!/usr/bin/env node
/**
 * Generate `slug,price_mad` rows from the real catalog.
 *
 * The catalog actually deployed at www.realworldcerts.com lives at
 * `site/realworldcerts/data/catalog.json` (302 items). It has no hours, mode
 * or price fields — only title, slug, category, description and
 * lecture/practice/quiz counts. Pricing is therefore delegated to the
 * repository's deterministic rules engine (`src/sales/pricing.mjs` and
 * `config/pricing.json`), which classifies from title/category/description.
 *
 * A legacy price book shaped like `{ courses: { <slug>: { mode: ... } } }`
 * is also accepted, for the `rank/output/data/pricing/prices.json` layout used
 * by older deployments.
 *
 * Usage:
 *   node scripts/generate-price-table.mjs
 *   node scripts/generate-price-table.mjs --catalog <path-or-url> \
 *     --out data/sales/pricing-table.csv --review data/sales/manual-review.csv
 *
 * Exits 1 when no catalog can be found or parsed; flagged courses are normal
 * output, written to the review CSV.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    loadPricingConfig,
    priceByRules,
    resolveConfigPath,
    exceptionReasons,
    resolveTier
} from '../src/sales/pricing.mjs';

export const CATALOG_CANDIDATES = [
    'site/realworldcerts/data/catalog.json',
    'rank/output/site-data/catalog.json',
    'rank/output/data/pricing/prices.json',
    'site/realworldcerts/data/pricing/prices.json',
    'data/catalog.json',
    'data/catalog.ndjson',
    'catalog.ndjson',
    'catalog.json'
];

export function findCatalogPath({ explicit, root = process.cwd() } = {}) {
    if (explicit) return explicit;
    if (process.env.CATALOG_PATH) return process.env.CATALOG_PATH;
    for (const relative of CATALOG_CANDIDATES) {
        const candidate = path.resolve(root, relative);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function parseCatalog(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.items)) return parsed.items;
    if (Array.isArray(parsed?.courses)) return parsed.courses;
    if (parsed?.courses && typeof parsed.courses === 'object') {
        return Object.entries(parsed.courses).map(([slug, meta]) => ({ slug, ...(meta || {}) }));
    }
    throw new Error('Catalog must be an array, { items: [] }, { courses: [] } or { courses: { slug: {} } }');
}

function toCourse(raw) {
    const slug = String(raw.slug || raw.handle || raw.course_id || raw.id || '').trim();
    if (!slug) return null;
    const hours = Number(raw.duration_hours ?? raw.hours ?? raw.durationHours);
    return {
        ...raw,
        course_id: String(raw.course_id || slug),
        slug,
        title: String(raw.title || raw.name || slug).trim(),
        tier: raw.tier ? String(raw.tier).toLowerCase() : null,
        exam_board: raw.exam_board || raw.examBoard || null,
        level: raw.level ? String(raw.level).toLowerCase() : null,
        duration_hours: Number.isFinite(hours) && hours > 0 ? hours : null,
        description: typeof raw.description === 'string' ? raw.description : '',
        price_mad: Number.isFinite(Number(raw.price_mad)) && raw.price_mad !== null && raw.price_mad !== ''
            ? Number(raw.price_mad)
            : null,
        price_status: raw.price_status || raw.mode || (raw.price_mad ? 'priced' : 'quote_required')
    };
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Pure builder so the rules can be tested without touching the filesystem.
 * Returns ready rows (slug, price_mad) and review rows (slug, reason).
 */
export function buildPriceTable(rawCatalog, { config = loadPricingConfig(resolveConfigPath()), includePriced = false } = {}) {
    const rows = parseCatalog(rawCatalog).map(toCourse).filter(Boolean);
    const ready = [];
    const review = [];
    const seen = new Set();
    let duplicates = 0;

    for (const course of rows) {
        if (seen.has(course.slug)) {
            duplicates += 1;
            review.push({ slug: course.slug, reason: 'duplicate_slug' });
            continue;
        }
        seen.add(course.slug);

        const priced = Number.isFinite(course.price_mad) && course.price_mad > 0;
        if (priced && !includePriced) continue;
        if (priced && includePriced) {
            ready.push({ slug: course.slug, price_mad: course.price_mad.toFixed(2) });
            continue;
        }

        const tier = resolveTier(course, config);
        const reasons = exceptionReasons(course, tier, config).map(item => item.reason);
        if (reasons.length) {
            review.push({ slug: course.slug, reason: reasons.join('; ') });
            continue;
        }

        try {
            const valuation = priceByRules(course, config);
            if (!Number.isFinite(valuation.price_mad) || valuation.price_mad <= 0) {
                review.push({ slug: course.slug, reason: 'rules_engine_returned_no_price' });
                continue;
            }
            ready.push({ slug: course.slug, price_mad: Number(valuation.price_mad).toFixed(2) });
        } catch (error) {
            review.push({ slug: course.slug, reason: `pricing_error: ${error.message}` });
        }
    }

    ready.sort((a, b) => a.slug.localeCompare(b.slug));
    review.sort((a, b) => a.slug.localeCompare(b.slug));
    return { ready, review, total: rows.length, duplicates };
}

export function renderCsv(rows, header) {
    return [header.join(','), ...rows.map(row => header.map(key => csvCell(row[key])).join(','))].join('\n') + '\n';
}

async function readCatalogSource(source) {
    if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Catalog fetch failed (${response.status}) for ${source}`);
        return parseCatalog(await response.text());
    }
    const raw = fs.readFileSync(source, 'utf8');
    if (source.endsWith('.ndjson') || /^\s*\{[^\n]*\}\s*\n\s*\{/.test(raw)) {
        return raw.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    }
    return parseCatalog(raw);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i++; }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help === true) {
        process.stdout.write('Usage: node scripts/generate-price-table.mjs [--catalog <path|url>] [--out <csv>] [--review <csv>] [--all]\n');
        return;
    }

    const catalogPath = findCatalogPath({ explicit: typeof args.catalog === 'string' ? args.catalog : undefined });
    if (!catalogPath) {
        process.stderr.write(`No catalog found. Looked for:\n${CATALOG_CANDIDATES.map(item => `  - ${item}`).join('\n')}\nPass --catalog <path-or-url>.\n`);
        process.exitCode = 1;
        return;
    }

    const root = process.cwd();
    const outPath = path.resolve(root, typeof args.out === 'string' ? args.out : 'data/sales/pricing-table.csv');
    const reviewPath = path.resolve(root, typeof args.review === 'string' ? args.review : 'data/sales/manual-review.csv');

    const catalog = await readCatalogSource(catalogPath);
    const { ready, review, total, duplicates } = buildPriceTable(catalog, { includePriced: args.all === true });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(outPath, renderCsv(ready, ['slug', 'price_mad']));
    fs.writeFileSync(reviewPath, renderCsv(review, ['slug', 'reason']));

    process.stdout.write(`${JSON.stringify({
        ok: true,
        catalog: catalogPath,
        courses: total,
        priced: ready.length,
        review: review.length,
        duplicates,
        out: outPath,
        review_out: reviewPath
    })}\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    main().catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
