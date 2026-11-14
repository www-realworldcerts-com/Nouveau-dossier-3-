import { NextResponse } from 'next/server';
import { buildRuntimeStatus } from '@/lib/swarm-state';

export const dynamic = 'force-dynamic';

const startTime = Date.now();

export async function GET() {
  try {
    const runtime = buildRuntimeStatus();
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    return NextResponse.json(
      {
        status: runtime.status === 'operational' ? 'online' : runtime.status,
        version: '2.0.0',
        uptime,
        runtime,
        services: {
          llm: 'unknown',
          tts: 'unknown',
          stt: 'unknown',
          search: 'unknown',
          imageGen: 'unknown',
          swarm: runtime.status,
        },
        security: {
          authRequired: false,
          note: 'JARVIS API routes do not yet enforce authentication.',
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[JARVIS Status] Error:', error);
    return NextResponse.json(
      {
        status: 'unknown',
        version: '2.0.0',
        uptime: 0,
        error: 'Runtime status could not be derived.',
      },
      { status: 503 }
    );
  }
}
