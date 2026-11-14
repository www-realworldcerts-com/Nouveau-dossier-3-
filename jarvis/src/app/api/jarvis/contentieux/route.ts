import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { findSwarmFile } from '@/lib/swarm-files';

/**
 * Contentieux report produced by the silent-failure audit on every tick.
 * JARVIS only reads the report; it never mutates a PO or records evidence.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  const file = findSwarmFile('data/resilience/contentieux.json');

  if (!file) {
    return NextResponse.json({
      available: false,
      message: 'No contentieux report yet. Run the tick audit (npm run resilience) to generate one.',
    });
  }

  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    return NextResponse.json({
      available: true,
      generated_at: report.generated_at || null,
      totals: {
        cases: report.totals?.cases ?? 0,
        amount_mad: report.totals?.amount_mad ?? report.totals?.amount_at_stake_mad ?? 0,
        high: report.totals?.high ?? report.totals?.high_severity ?? 0,
      },
      cases: Array.isArray(report.cases) ? report.cases : [],
    });
  } catch (error) {
    console.error('[JARVIS Contentieux] Error reading report:', error);
    return NextResponse.json(
      { available: false, message: 'The contentieux report could not be read.' },
      { status: 500 }
    );
  }
}
