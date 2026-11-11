import { clampPrice, fallbackValuation, getTierConfig, roundMad } from './pricing.mjs';

/**
 * LLM valuation worker for the exception courses (blueprint Appendix A).
 * Speaks the OpenAI-compatible chat completions protocol so any compatible
 * endpoint works. The API key is read from the environment and never logged.
 */

export const SYSTEM_PROMPT = `You are a pricing analyst for a Moroccan test-preparation catalog.
Your task is to propose a fair price in Moroccan Dirham (MAD) for a single course, given its metadata and the catalog's tier-map baseline.

Rules:
1. Propose a price within the course's tier bounds (provided in the user prompt).
2. If the metadata suggests premium positioning (exam board, advanced level), you may propose a price up to 1.5x the tier baseline, but never above the tier ceiling.
3. Round to the nearest 50 MAD for prices below 2000 MAD; round to the nearest 100 MAD for prices at or above 2000 MAD.
4. Always provide a reasoning trace of 2 to 4 sentences explaining the price.
5. Provide a confidence score between 0 and 1.

Respond in JSON only:
{"price_mad": integer, "confidence": float, "reasoning": string}`;

export function buildUserPrompt(course, tierName, reason, config) {
    const tier = getTierConfig(tierName, config);
    return `Course metadata:
course_id: ${course.course_id}
title: ${course.title}
tier: ${tierName}
exam_board: ${course.exam_board || 'none'}
level: ${course.level || 'unspecified'}
duration_hours: ${course.duration_hours ?? 'unspecified'}

Tier baseline: ${tier.baseline_mad} MAD
Tier bounds: ${tier.min_mad} to ${tier.max_mad} MAD

Why this course was queued for LLM valuation: ${reason}`;
}

export function parseValuation(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('Empty LLM response');
    }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        throw new Error('LLM response did not contain a JSON object');
    }
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    const price = Number(parsed.price_mad);
    if (!Number.isInteger(price) || price <= 0) {
        throw new Error(`LLM returned invalid price_mad: ${parsed.price_mad}`);
    }
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error(`LLM returned invalid confidence: ${parsed.confidence}`);
    }
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '';
    if (reasoning.length < 20) {
        throw new Error('LLM reasoning trace missing or too short');
    }
    return { price_mad: price, confidence, reasoning };
}

export function validateValuation(valuation, tier) {
    const problems = [];
    if (valuation.price_mad < tier.min_mad || valuation.price_mad > tier.max_mad) {
        problems.push(`price ${valuation.price_mad} MAD outside tier bounds ${tier.min_mad}-${tier.max_mad}`);
    }
    if (valuation.price_mad % (valuation.price_mad < 2000 ? 50 : 100) !== 0) {
        problems.push(`price ${valuation.price_mad} MAD violates rounding rules`);
    }
    return { ok: problems.length === 0, problems };
}

export function llmSettingsFromEnv() {
    return {
        apiKey: process.env.OPENAI_API_KEY || process.env.SALES_LLM_API_KEY || '',
        baseUrl: (process.env.SALES_LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://freebuff.com/api/v1/paid').replace(/\/+$/, ''),
        model: process.env.SALES_LLM_MODEL || 'gpt-4o-mini',
        timeoutMs: Number(process.env.SALES_LLM_TIMEOUT_MS || 30000)
    };
}

async function callChat({ baseUrl, apiKey, model, timeoutMs, messages, fetchImpl }) {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages,
            response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM response missing choices[0].message.content');
    return content;
}

/**
 * Valuate an exception course. Returns a price decision object. On any failure
 * (missing key, network error, out-of-bounds or unparseable output after retries)
 * the deterministic fallback is returned with `needs_review: true` so the
 * approval gate surfaces it instead of silently publishing.
 */
export async function valuateCourse({
    course,
    tierName,
    reason,
    config,
    fetchImpl = globalThis.fetch,
    settings = llmSettingsFromEnv(),
    maxRetries = 3
}) {
    const tier = getTierConfig(tierName, config);
    const base = {
        course_id: course.course_id,
        tier: tierName,
        reasons: reason ? [reason] : []
    };
    if (!settings.apiKey) {
        return { ...base, ...fallbackValuation(course, tierName, base.reasons.map(r => ({ id: 'no_key', reason: r })), config) };
    }

    let feedback = '';
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
            const content = await callChat({
                baseUrl: settings.baseUrl,
                apiKey: settings.apiKey,
                model: settings.model,
                timeoutMs: settings.timeoutMs || 30000,
                fetchImpl,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: buildUserPrompt(course, tierName, reason, config) + feedback }
                ]
            });
            const parsed = parseValuation(content);
            const validation = validateValuation(parsed, tier);
            if (validation.ok) {
                return {
                    ...base,
                    price_mad: parsed.price_mad,
                    confidence: parsed.confidence,
                    trace: parsed.reasoning,
                    source: 'llm',
                    attempts: attempt,
                    needs_review: true
                };
            }
            feedback = `\n\nPrevious answer was rejected: ${validation.problems.join('; ')}. Fix it and respond with JSON only.`;
        } catch (error) {
            feedback = `\n\nPrevious answer was rejected: ${error.message}. Respond with JSON only.`;
        }
    }

    const fallback = fallbackValuation(course, tierName, [{ id: 'llm_failed' }], config);
    return {
        ...base,
        ...fallback,
        trace: `${fallback.reasoning} (LLM rejected after ${maxRetries} attempts.)`,
        attempts: maxRetries
    };
}

export { clampPrice, roundMad };
