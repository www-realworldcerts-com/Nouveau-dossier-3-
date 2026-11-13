import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

interface SearchRequest {
  query: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  host_name: string;
}

export async function POST(req: NextRequest) {
  try {
    const body: SearchRequest = await req.json();
    const { query } = body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return NextResponse.json(
        { error: 'Query is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    const zai = await ZAI.create();
    const results = await zai.functions.invoke('web_search', {
      query: query,
      num: 10,
    });

    // Normalize results to ensure consistent format
    const normalizedResults: SearchResult[] = Array.isArray(results)
      ? results.map((result) => {
          const r = result as unknown as Record<string, unknown>;
          return {
            title: String(r.title || ''),
            url: String(r.url || ''),
            snippet: String(r.snippet || r.content || ''),
            host_name: String(r.host_name || r.hostname || new URL(String(r.url || 'https://unknown')).hostname),
          };
        })
      : [];

    return NextResponse.json({
      results: normalizedResults,
    });
  } catch (error) {
    console.error('[JARVIS Search] Error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred while performing the web search' },
      { status: 500 }
    );
  }
}
