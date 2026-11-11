import fs from 'node:fs';
import path from 'node:path';

/**
 * Rules-based pricing engine for the RealWorldCerts catalog.
 *
 * Prices are stored in MAD (the blueprint's reference currency). The engine
 * prices the bulk of the catalog from a tier map; courses that match an
 * exception pattern are handed to the LLM valuation worker instead.
 */

export const DEFAULT_PRICING_CONFIG = {
    currency: 'MAD',
    base_mad: 3500,
    tiers: {
        foundation: { baseline_mad: 900, min_mad: 500, max_mad: 1500 },
        preptest: { baseline_mad: 1500, min_mad: 1000, max_mad: 2500 },
        professional: { baseline_mad: 2500, min_mad: 1500, max_mad: 3500 },
        certified: { baseline_mad: 3500, min_mad: 2500, max_mad: 5000 },
        premium: { baseline_mad: 4900, min_mad: 4000, max_mad: 7000 },
        default: { baseline_mad: 3500, min_mad: 2000, max_mad: 6000 }
    },
    tier_keywords: {
        foundation: ['foundation', 'foundational', 'initiation', 'débutant', 'debutant', 'basics'],
        preptest: ['prep', 'prépa', 'prepa', 'exam', 'examen', 'concours', 'test'],
        professional: ['professional', 'professionnel', 'career', 'carrière', 'carriere'],
        certified: ['certified', 'certification', 'certificat', 'certificate'],
        premium: ['master', 'advanced', 'expert', 'premium', 'executive']
    },
    exception_patterns: {
        premium_exam_boards: ['ACCA', 'CFA', 'PMP', 'CIMA', 'CIPD', 'AWS', 'CISCO', 'CFP', 'PRINCE2'],
        premium_title_keywords: ['advanced', 'expert', 'master', 'premium', 'executive'],
        baseline_band_mad: [2000, 6000],
        flag_awkward_prices: true
    },
    rounding: {
        below_mad: 2000,
        step_below: 50,
        step_above: 100
    },
    approval: {
        auto_approve_rules: true,
        poll_interval_ms: 30000
    },
    fx: {
        eur_per_mad: 0.092,
        usd_per_mad: 0.1
    },
    self_improve: {
        min_views: 100,
        window_days: 30,
        price_cut_pct: 15
    }
};

const LEVEL_MULTIPLIERS = {
    beginner: 0.95,
    intermediate: 1,
    advanced: 1.2,
    expert: 1.35
};

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
    if (!isPlainObject(override)) return override === undefined ? base : override;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(override)) {
        out[key] = isPlainObject(value) && isPlainObject(base?.[key])
            ? deepMerge(base[key], value)
            : value;
    }
    return out;
}

export function loadPricingConfig(configPath) {
    if (!configPath || !fs.existsSync(configPath)) {
        return structuredClone(DEFAULT_PRICING_CONFIG);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return deepMerge(structuredClone(DEFAULT_PRICING_CONFIG), raw);
}

export function resolveConfigPath(explicitPath) {
    if (explicitPath) return path.resolve(explicitPath);
    const configured = process.env.SALES_PRICING_CONFIG;
    if (configured) return path.resolve(configured);
    return path.resolve('config/pricing.json');
}

/** Appendix C.1 — nearest 50 MAD below 2000, nearest 100 MAD at or above. */
export function roundMad(value, config = DEFAULT_PRICING_CONFIG) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Cannot round invalid price: ${value}`);
    }
    const { below_mad: below, step_below: stepBelow, step_above: stepAbove } = config.rounding;
    const step = value < below ? stepBelow : stepAbove;
    return Math.round(value / step) * step;
}

export function isAwkwardPrice(value, config = DEFAULT_PRICING_CONFIG) {
    if (!Number.isFinite(value) || value <= 0) return true;
    const step = value < config.rounding.below_mad
        ? config.rounding.step_below
        : config.rounding.step_above;
    return value % step !== 0;
}

export function clampPrice(value, tier) {
    return Math.min(Math.max(value, tier.min_mad), tier.max_mad);
}

export function getTierConfig(tierName, config = DEFAULT_PRICING_CONFIG) {
    return config.tiers[tierName] || config.tiers.default;
}

/**
 * Resolve a course's tier from its metadata, falling back to title keywords.
 * Explicit `tier` wins so the founder can always override classification.
 */
export function resolveTier(course, config = DEFAULT_PRICING_CONFIG) {
    const explicit = String(course.tier || '').trim().toLowerCase();
    if (explicit && config.tiers[explicit]) return explicit;

    const haystack = [
        course.title,
        course.category,
        course.description,
        course.level
    ].filter(Boolean).join(' ').toLowerCase();

    for (const [tier, keywords] of Object.entries(config.tier_keywords)) {
        if (keywords.some(keyword => haystack.includes(String(keyword).toLowerCase()))) {
            if (config.tiers[tier]) return tier;
        }
    }
    return 'default';
}

/**
 * Exception reasons follow the blueprint's conservative pattern set:
 * premium exam board, premium title, baseline outside the sane band, or an
 * awkward pre-rounding price that deserves a psychological-price review.
 */
export function exceptionReasons(course, tierName, config = DEFAULT_PRICING_CONFIG) {
    const patterns = config.exception_patterns;
    const tier = getTierConfig(tierName, config);
    const reasons = [];
    const board = String(course.exam_board || '').trim().toUpperCase();
    const boards = patterns.premium_exam_boards.map(b => String(b).toUpperCase());
    if (board && boards.includes(board)) {
        reasons.push({ id: 'premium_exam_board', reason: `premium exam board ${board}` });
    }

    const title = String(course.title || '').toLowerCase();
    const keyword = patterns.premium_title_keywords.find(k => title.includes(String(k).toLowerCase()));
    if (keyword) {
        reasons.push({ id: 'premium_title', reason: `premium positioning keyword "${keyword}"` });
    }

    const [bandMin, bandMax] = patterns.baseline_band_mad;
    if (tierName === 'default' && (tier.baseline_mad < bandMin || tier.baseline_mad > bandMax)) {
        reasons.push({
            id: 'baseline_out_of_band',
            reason: `tier baseline ${tier.baseline_mad} MAD outside ${bandMin}-${bandMax} MAD band`
        });
    }

    if (patterns.flag_awkward_prices && isAwkwardPrice(tier.baseline_mad, config)) {
        reasons.push({
            id: 'awkward_price',
            reason: `tier baseline ${tier.baseline_mad} MAD rounds awkwardly`
        });
    }
    return reasons;
}

export function needsPricing(course) {
    if (course.price_mad === 0) return true;
    if (course.price_mad === null || course.price_mad === undefined) return true;
    const status = String(course.price_status || '').toLowerCase();
    return status === 'quote_required' || status === 'unpriced';
}

export function priceToEur(priceMad, config = DEFAULT_PRICING_CONFIG) {
    return Math.round(priceMad * config.fx.eur_per_mad);
}

/**
 * Convert a MAD catalog price into the Shopify store currency. The publisher
 * writes this number into the variant price, so publishing MAD amounts into a
 * USD store would overcharge by roughly 10x. Unknown currencies throw rather
 * than guess.
 */
export function storePriceFor(priceMad, storeCurrency, config = DEFAULT_PRICING_CONFIG) {
    const catalogCurrency = String(config.currency || 'MAD').toUpperCase();
    const target = String(storeCurrency || catalogCurrency).toUpperCase();
    const amount = Number(priceMad);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Cannot convert invalid price: ${priceMad}`);
    }
    if (target === catalogCurrency) {
        return { amount: Math.round(amount), currency: target, converted: false, rate: 1 };
    }
    const rate = config.fx?.[`${target.toLowerCase()}_per_mad`];
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`No FX rate for ${target}; add fx.${target.toLowerCase()}_per_mad to the pricing config`);
    }
    return { amount: Math.round(amount * rate), currency: target, converted: true, rate };
}

/**
 * Deterministic fallback used when the LLM worker is unavailable. It keeps the
 * pipeline moving (rules-priced courses may auto-approve) while flagging the
 * decision for human review.
 */
export function fallbackValuation(course, tierName, reasons, config = DEFAULT_PRICING_CONFIG) {
    const tier = getTierConfig(tierName, config);
    const level = String(course.level || '').toLowerCase();
    let multiplier = LEVEL_MULTIPLIERS[level] ?? 1;
    if (reasons.some(r => r.id === 'premium_exam_board')) multiplier += 0.1;
    const proposed = clampPrice(roundMad(tier.baseline_mad * multiplier, config), tier);
    const reasoning = `Deterministic fallback: tier ${tierName} baseline ${tier.baseline_mad} MAD adjusted x${multiplier.toFixed(2)} for level "${level || 'unknown'}"; LLM valuation unavailable, founder review recommended.`;
    return {
        price_mad: proposed,
        confidence: 0.4,
        reasoning,
        trace: reasoning,
        source: 'fallback',
        needs_review: true
    };
}

export function priceByRules(course, config = DEFAULT_PRICING_CONFIG) {
    const tierName = resolveTier(course, config);
    const tier = getTierConfig(tierName, config);
    const price = clampPrice(roundMad(tier.baseline_mad, config), tier);
    return {
        course_id: course.course_id,
        price_mad: price,
        source: 'rules',
        tier: tierName,
        confidence: 0.9,
        reasons: exceptionReasons(course, tierName, config).map(r => r.reason),
        trace: `Tier map: tier "${tierName}" baseline ${tier.baseline_mad} MAD, rounded to ${price} MAD (bounds ${tier.min_mad}-${tier.max_mad}).`,
        needs_review: false
    };
}
