#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { storefrontPricePayload } from '../src/sales/course-catalog.mjs';

/**
 * Build the canonical catalog from the deployed course snapshot.
 *
 * The course metadata comes from data/catalog.json. Prices are preserved from
 * an existing canonical catalog, then from the retired price book, and finally
 * fall back to --price. Once written, config/course-catalog.json is the only
 * source; this script is the import/update tool, not a second runtime source.
 */

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) args[key] = true;
        else {
            args[key] = value;
            i += 1;
        }
    }
    return args;
}

export function buildCatalog({ source, existing = null, price = 19, currency = 'USD', fulfillmentCostCents = 200, fx } = {}) {
    const items = Array.isArray(source) ? source : Array.isArray(source?.items) ? source.items : [];
    if (!items.length) throw new Error('No catalog items found');
    const existingBySlug = new Map((existing?.courses || []).map(course => [course.slug, course]));
    const seen = new Set();
    const courses = [];
    let duplicates = 0;

    for (const item of items) {
        const slug = String(item?.slug || '').trim();
        if (!slug) continue;
        if (seen.has(slug)) {
            duplicates += 1;
            continue;
        }
        seen.add(slug);
        const title = String(item.title || slug).trim();
        const inherited = existingBySlug.get(slug);
        const priceCents = Number.isInteger(inherited?.price_cents)
            ? inherited.price_cents
            : Math.round(Number(price) * 100);
        if (!Number.isInteger(priceCents) || priceCents <= 0) {
            throw new Error(`Invalid price for ${slug}`);
        }
        courses.push({
            slug,
            title,
            description: String(item.description || ''),
            category: String(item.category || ''),
            image: item.image || null,
            language: item.language || null,
            lecture_count: Number(item.lectureCount || 0),
            practice_test_count: Number(item.practiceTestCount || 0),
            quiz_count: Number(item.quizCount || 0),
            price_cents: priceCents,
            status: inherited?.status || 'active'
        });
    }

    if (!courses.length) throw new Error('No catalog items with slugs found');
    return {
        version: 1,
        currency: String(currency).toUpperCase(),
        fulfillment_cost_cents: Math.max(0, Math.round(Number(fulfillmentCostCents))),
        fx: fx || { USD: 1, MAD: 10, EUR: 0.92 },
        courses,
        duplicate_count: duplicates
    };
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = parseArgs(process.argv);
    const sourcePath = path.resolve(args.catalog || 'data/catalog.json');
    const outPath = path.resolve(args.out || 'config/course-catalog.json');
    const publicPath = path.resolve(args.public || 'data/store-prices.json');
    const existing = readJson(outPath);

    try {
        const catalog = buildCatalog({
            source: readJson(sourcePath),
            existing,
            price: Number(args.price ?? 19),
            currency: args.currency || 'USD',
            fulfillmentCostCents: Number(args['fulfillment-cost-cents'] ?? 200)
        });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n');
        fs.mkdirSync(path.dirname(publicPath), { recursive: true });
        fs.writeFileSync(publicPath, JSON.stringify(storefrontPricePayload(outPath), null, 2) + '\n');
        console.log(JSON.stringify({
            ok: true,
            courses: catalog.courses.length,
            duplicates_collapsed: catalog.duplicate_count,
            currency: catalog.currency,
            fulfillment_cost_cents: catalog.fulfillment_cost_cents,
            canonical: outPath,
            public: publicPath
        }, null, 2));
    } catch (error) {
        console.error(`generate-course-catalog: ${error.message}`);
        process.exit(1);
    }
}
