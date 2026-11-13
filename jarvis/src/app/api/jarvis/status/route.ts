import { NextResponse } from 'next/server';

// Track server start time for uptime calculation
const startTime = Date.now();

interface ServiceStatus {
  llm: string;
  tts: string;
  stt: string;
  search: string;
  imageGen: string;
  swarm: string;
}

interface SecurityInfo {
  encryption: boolean;
  authRequired: boolean;
  protocol: string;
}

interface SystemStatus {
  status: string;
  version: string;
  uptime: number;
  services: ServiceStatus;
  security: SecurityInfo;
}

export async function GET() {
  try {
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    const status: SystemStatus = {
      status: 'online',
      version: '2.0.0',
      uptime,
      services: {
        llm: 'operational',
        tts: 'operational',
        stt: 'operational',
        search: 'operational',
        imageGen: 'operational',
        swarm: 'connected',
      },
      security: {
        encryption: true,
        authRequired: true,
        protocol: 'WSS/TLS',
      },
    };

    return NextResponse.json(status);
  } catch (error) {
    console.error('[JARVIS Status] Error:', error);

    return NextResponse.json(
      {
        status: 'degraded',
        version: '2.0.0',
        uptime: 0,
        services: {
          llm: 'unknown',
          tts: 'unknown',
          stt: 'unknown',
          search: 'unknown',
          imageGen: 'unknown',
          swarm: 'disconnected',
        },
        security: {
          encryption: true,
          authRequired: true,
          protocol: 'WSS/TLS',
        },
      },
      { status: 503 }
    );
  }
}
