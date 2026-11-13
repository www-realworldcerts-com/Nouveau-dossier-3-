import { NextRequest, NextResponse } from 'next/server';

interface ActivateRequest {
  action: 'activate' | 'deactivate';
  activate?: boolean;
}

const AGENT_MAP: Record<string, { name: string; description: string }> = {
  'code-reviewer': {
    name: 'Code Reviewer',
    description: 'Analyzes code quality, patterns, and best practices',
  },
  'security-auditor': {
    name: 'Security Auditor',
    description: 'Scans for vulnerabilities and security issues',
  },
  'test-engineer': {
    name: 'Test Engineer',
    description: 'Generates and validates test cases',
  },
  'web-perf': {
    name: 'Web Performance',
    description: 'Monitors and optimizes web performance',
  },
  'payment-agent': {
    name: 'Payment Processing',
    description: 'Processes payments, generates POs, invoices, and receipts',
  },
  'custom-agent': {
    name: 'Custom Operations',
    description: 'Handles custom operations, automation, and cross-domain tasks',
  },
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'Agent ID is required' },
        { status: 400 }
      );
    }

    const agentInfo = AGENT_MAP[id];
    if (!agentInfo) {
      return NextResponse.json(
        { error: `Unknown agent: ${id}. Valid agents: ${Object.keys(AGENT_MAP).join(', ')}` },
        { status: 404 }
      );
    }

    let body: Partial<ActivateRequest> = {};
    try {
      body = await req.json();
    } catch {
      // Body is optional
    }

    // Support both `action` and `activate` fields from frontend
    const action = body.action || (body.activate ? 'activate' : 'deactivate');

    if (!action || !['activate', 'deactivate'].includes(action)) {
      return NextResponse.json(
        { error: 'Action must be "activate" or "deactivate"' },
        { status: 400 }
      );
    }

    const status = action === 'activate' ? 'active' : 'idle';

    // Simple, honest activation message - no LLM needed for this
    const message = action === 'activate'
      ? `${agentInfo.name} is now online and operational. Ready to execute: ${agentInfo.description.toLowerCase()}.`
      : `${agentInfo.name} has been deactivated and is now offline.`;

    return NextResponse.json({
      agentId: id,
      status,
      message,
    });
  } catch (error) {
    console.error('[JARVIS Swarm Agent Activate] Error:', error);

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'An error occurred while managing the agent' },
      { status: 500 }
    );
  }
}
