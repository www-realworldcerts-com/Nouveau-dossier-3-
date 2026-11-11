import fs from 'node:fs';
import path from 'node:path';

/**
 * Catalog access layer. The source of truth is an ndjson file (one course per
 * line) so it works for the local catalog today and for an export of the
 * Shopify product list tomorrow. Prices are written to a separate append-only
 * ndjson log that publish and status read back.
 */

export function readNdjson(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    const rows = [];
    for (const [index, line] of text.split('\n').entries()) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            rows.push(JSON.parse(trimmed));
        } catch (error) {
            throw new Error(`Invalid ndjson at ${filePath}:${index + 1}: ${error.message}`);
        }
    }
    return rows;
}

export function appendNdjson(filePath, rows) {
    if (!rows.length) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.appendFileSync(filePath, payload);
}

export function writeNdjson(filePath, rows) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    fs.writeFileSync(filePath, payload);
}

export function normalizeCourse(raw, index = 0) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Course record ${index} is not an object`);
    }
    const courseId = String(raw.course_id || raw.id || raw.handle || '').trim();
    if (!courseId) {
        throw new Error(`Course record ${index} is missing course_id`);
    }
    const title = String(raw.title || raw.name || courseId).trim();
    return {
        ...raw,
        course_id: courseId,
        title,
        tier: raw.tier ? String(raw.tier).toLowerCase() : null,
        exam_board: raw.exam_board || raw.examBoard || null,
        level: raw.level ? String(raw.level).toLowerCase() : null,
        price_mad: Number.isFinite(Number(raw.price_mad)) && raw.price_mad !== null && raw.price_mad !== ''
            ? Number(raw.price_mad)
            : null,
        price_status: raw.price_status || (raw.price_mad ? 'priced' : 'quote_required'),
        shopify_product_id: raw.shopify_product_id || null
    };
}

export function readCatalog(catalogPath) {
    if (!catalogPath) throw new Error('A catalog path is required (--catalog or CATALOG_PATH)');
    if (!fs.existsSync(catalogPath)) {
        throw new Error(`Catalog not found: ${catalogPath}`);
    }
    if (catalogPath.endsWith('.json')) {
        const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        const rows = Array.isArray(parsed) ? parsed : parsed.courses;
        if (!Array.isArray(rows)) throw new Error(`Catalog JSON must be an array or { courses: [] }: ${catalogPath}`);
        return rows.map(normalizeCourse);
    }
    return readNdjson(catalogPath).map(normalizeCourse);
}

/** Latest price per course, derived from the append-only price log. */
export function latestPrices(priceLogPath) {
    const map = new Map();
    for (const row of readNdjson(priceLogPath)) {
        if (!row?.course_id || !Number.isFinite(Number(row.price_mad))) continue;
        map.set(row.course_id, row);
    }
    return map;
}

export function mergePrices(courses, priceLogPath) {
    const prices = latestPrices(priceLogPath);
    return courses.map(course => {
        const record = prices.get(course.course_id);
        if (!record) return course;
        return {
            ...course,
            price_mad: Number(record.price_mad),
            price_status: 'priced',
            price_currency: record.currency || 'MAD',
            price_source: record.source || null,
            price_updated_at: record.published_at || null
        };
    });
}

export function slugify(value) {
    return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'course';
}
