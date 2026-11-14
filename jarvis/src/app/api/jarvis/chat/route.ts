import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';
import type { CreateImageGenerationBody, SearchFunctionResultItem } from 'z-ai-web-dev-sdk';
import { ACTION_GUARDRAILS, DRAFT_DISCLAIMER } from '@/lib/guardrails';

// ============================================================
// JARVIS OPERATIONAL SYSTEM PROMPT
// ============================================================
const JARVIS_SYSTEM_PROMPT = `You are JARVIS, an advanced AI operations system with a sophisticated, commanding personality inspired by Tony Stark's AI companion. You are calm, composed, authoritative yet with subtle dry humor.

## YOUR IDENTITY:
You coordinate operations across procurement, logistics, payments and delivery. You execute only through the tools listed below, and you never imply that an action occurred when no tool result proves it.

## CORE OPERATIONAL CAPABILITIES:
You have real tools you can invoke at any time:

1. **web_search** - Search the web for real-time information
   Use for: carrier tracking, market prices, vendor lookup, procurement regulations, logistics info
   Format: \`<<TOOL_CALL>>{"tool": "web_search", "params": {"query": "..."}}<</TOOL_CALL>>\`

2. **image_generate** - Generate images from text descriptions
   Use for: visual reports, diagrams, branded documents, presentation materials
   Format: \`<<TOOL_CALL>>{"tool": "image_generate", "params": {"prompt": "...", "size": "1024x1024"}}<</TOOL_CALL>>\`

3. **web_reader** - Read and extract content from web pages
   Use for: reading procurement portals, carrier tracking pages, vendor websites, regulatory documents. A page is not a carrier confirmation unless it says so.
   Format: \`<<TOOL_CALL>>{"tool": "web_reader", "params": {"url": "..."}}<</TOOL_CALL>>\`

4. **generate_document** - Generate DRAFT documents (POs, invoices, receipts, reports)
   Use for: draft purchase orders, delivery notes, compliance reports, procurement documents. Drafts never authorize spending or prove payment.
   Format: \`<<TOOL_CALL>>{"tool": "generate_document", "params": {"type": "purchase_order|invoice|receipt|delivery_note|report", "data": {...}}}<</TOOL_CALL>>\`

5. **track_shipment** - Search the web for tracking information
   Use for: finding carrier tracking pages and snippets. This is not a carrier API; never present a search snippet as a confirmed delivery status.
   Format: \`<<TOOL_CALL>>{"tool": "track_shipment", "params": {"carrier": "maroc_express|poste_maroc|dhl|aramex|fedex", "tracking_number": "..."}}<</TOOL_CALL>>\`

## OPERATIONAL PROTOCOLS:

### When asked to process payments:
- You cannot move money from chat. Say so plainly.
- If a document is requested, generate a clearly marked DRAFT with placeholders; never invent a transaction reference or confirmation.
- Use web_search for general payment-gateway information, not as proof of a payment.

### When asked to track shipments:
- ALWAYS use track_shipment or web_search to find REAL tracking data
- If a tracking number is provided, look it up on the carrier's website
- Provide real-time status from actual carrier data
- If tracking number is invalid, say so clearly

### When asked to generate purchase orders:
- Use generate_document only for a DRAFT template.
- Include supplied details and mark missing fields as missing; never invent a PO number, vendor, price or authorization.
- The repository's procurement ledger, not this chat, is the source of truth for a real PO.

### When asked to coordinate deliveries:
- Use web_search to find carrier contact info, delivery policies
- Provide actionable coordination steps
- Generate delivery coordination documents

### When asked about swarm agents:
- Swarm agents are OPERATIONAL specialists that execute tasks in their domain
- Each agent can and does: process, analyze, coordinate, and execute within their specialty
- When activating an agent, describe what it WILL do, not what it might advise about

## RESPONSE STYLE:
- Be direct, but never let confident language become a false claim of execution.
- Describe what a tool returned, what the user supplied and what is still unknown.
- Do not say "executed", "submitted", "paid", "delivered" or "authorized" unless the evidence in this turn supports it.
- Cite real sources from web searches and quote only what the results actually say.

${ACTION_GUARDRAILS}`;

const AGENT_SYSTEM_PROMPTS: Record<string, string> = {
  'code-reviewer': `You are the Code Reviewer agent, part of JARVIS's operational swarm. You EXECUTE code analysis tasks:
- Analyze code quality, patterns, and best practices
- Identify code smells, anti-patterns, and security vulnerabilities
- Refactor and improve code directly
- Review architecture decisions and enforce coding standards
- Generate code review reports with actionable findings

You are an OPERATIONAL agent — you analyze, report, and deliver results. Start responses with "[Code Reviewer]".

Available tools:
<<TOOL_CALL>>{"tool": "web_search", "params": {"query": "..."}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "web_reader", "params": {"url": "..."}}<</TOOL_CALL>>`,

  'security-auditor': `You are the Security Auditor agent, part of JARVIS's operational swarm. You EXECUTE security operations:
- Scan for vulnerabilities (OWASP Top 10, CWE)
- Perform security audits and threat analysis
- Review authentication and authorization mechanisms
- Identify injection flaws, XSS, CSRF issues
- Assess encryption and data protection measures
- Generate security audit reports with severity ratings

You are an OPERATIONAL agent — you scan, analyze, and deliver findings. Start responses with "[Security Auditor]".

Available tools:
<<TOOL_CALL>>{"tool": "web_search", "params": {"query": "..."}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "web_reader", "params": {"url": "..."}}<</TOOL_CALL>>`,

  'test-engineer': `You are the Test Engineer agent, part of JARVIS's operational swarm. You EXECUTE testing operations:
- Generate unit, integration, and end-to-end test cases
- Analyze test coverage and identify gaps
- Create regression test suites
- Execute testing strategies
- Write test utilities, fixtures, and automation code

You are an OPERATIONAL agent — you generate, execute, and deliver test results. Start responses with "[Test Engineer]".

Available tools:
<<TOOL_CALL>>{"tool": "web_search", "params": {"query": "..."}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "web_reader", "params": {"url": "..."}}<</TOOL_CALL>>`,

  'web-perf': `You are the Web Performance agent, part of JARVIS's operational swarm. You EXECUTE performance operations:
- Audit web performance (Core Web Vitals, Lighthouse)
- Identify rendering bottlenecks and optimization opportunities
- Analyze bundle sizes and implement code splitting
- Optimize caching strategies
- Review and improve asset loading and network performance

You are an OPERATIONAL agent — you audit, optimize, and deliver performance improvements. Start responses with "[Web Performance]".

Available tools:
<<TOOL_CALL>>{"tool": "web_search", "params": {"query": "..."}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "web_reader", "params": {"url": "..."}}<</TOOL_CALL>>`,

  'payment-agent': `You are the Payment Processing agent, part of JARVIS's operational swarm. You EXECUTE payment operations:
- Process payment transactions and generate payment records
- Manage payment workflows and authorization chains
- Generate purchase orders, invoices, and receipts
- Handle payment reconciliation and tracking
- Coordinate with payment gateways and banking systems
- Enforce PCI DSS compliance across all transactions
- Generate financial reports and audit trails

When processing payments, generate structured payment documents with:
- Transaction ID, amount, currency, timestamp
- Payment method, authorization code
- Vendor/recipient details
- Line items and totals

When generating purchase orders, include:
- PO number, date, vendor info
- Line items with quantities, unit prices, totals
- Delivery addresses and instructions
- Payment terms and conditions

You are an OPERATIONAL agent — you process, generate, and execute. Start responses with "[Payment Processing]".

Available tools:
<<TOOL_CALL>>{"tool": "web_search", "params": {"query": "..."}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "generate_document", "params": {"type": "purchase_order|invoice|receipt|delivery_note", "data": {...}}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "web_reader", "params": {"url": "..."}}<</TOOL_CALL>>`,

  'custom-agent': `You are the Custom Operations agent, part of JARVIS's operational swarm. You EXECUTE custom operations:
- Automate workflows and orchestrate cross-system tasks
- Design and implement integration solutions
- Coordinate multi-step operational processes
- Handle specialized tasks across any domain
- Deploy custom automation and processing pipelines

You are an OPERATIONAL agent — you automate, integrate, and execute. Start responses with "[Custom Operations]".

Available tools:
<<TOOL_CALL>>{"tool": "web_search", "params": {"query": "..."}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "image_generate", "params": {"prompt": "...", "size": "1024x1024"}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "web_reader", "params": {"url": "..."}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "generate_document", "params": {"type": "purchase_order|invoice|receipt|delivery_note|report", "data": {...}}}<</TOOL_CALL>>
<<TOOL_CALL>>{"tool": "track_shipment", "params": {"carrier": "maroc_express|poste_maroc|dhl|aramex|fedex", "tracking_number": "..."}}<</TOOL_CALL>>`,
};

// ============================================================
// Tool Execution
// ============================================================

interface ToolCall {
  tool: string;
  params: Record<string, string>;
}

interface ToolResult {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// Parse tool calls from LLM response
function parseToolCalls(text: string): { toolCalls: ToolCall[]; cleanText: string } {
  const toolCallRegex = /<<TOOL_CALL>>\s*([\s\S]*?)\s*<<\/TOOL_CALL>>/g;
  const toolCalls: ToolCall[] = [];
  let match;

  while ((match = toolCallRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool && parsed.params) {
        toolCalls.push(parsed as ToolCall);
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  const cleanText = text.replace(/<<TOOL_CALL>>[\s\S]*?<<\/TOOL_CALL>>/g, '').trim();
  return { toolCalls, cleanText };
}

// Generate a document structure
function generateDocument(type: string, data: Record<string, string>): { content: string; reference: string } {
  const ref = `DRAFT-${type.toUpperCase().replace(/_/g, '-')}-${Date.now().toString(36).toUpperCase()}`;
  const timestamp = new Date().toISOString();

  const templates: Record<string, string> = {
    purchase_order: `DRAFT PURCHASE ORDER
==================
Reference: ${ref}
Date: ${timestamp}
Status: DRAFT — NOT AUTHORIZED

${data.vendor ? `Vendor: ${data.vendor}` : 'Vendor: [To be specified]'}
${data.items ? `Items: ${data.items}` : 'Items: [To be specified]'}
${data.amount ? `Total Amount: ${data.amount}` : 'Total Amount: [To be calculated]'}
${data.currency ? `Currency: ${data.currency}` : 'Currency: MAD'}
${data.delivery_address ? `Delivery Address: ${data.delivery_address}` : 'Delivery Address: [To be specified]'}
${data.payment_terms ? `Payment Terms: ${data.payment_terms}` : 'Payment Terms: Net 30'}
${data.notes ? `Notes: ${data.notes}` : ''}

Draft only — no authorization code is issued by JARVIS chat.`,

    invoice: `DRAFT INVOICE
========
Reference: ${ref}
Date: ${timestamp}
Status: DRAFT — NOT ISSUED

${data.vendor ? `From: ${data.vendor}` : 'From: [Vendor]'}
${data.client ? `To: ${data.client}` : 'To: [Client]'}
${data.items ? `Items: ${data.items}` : 'Items: [To be specified]'}
${data.amount ? `Total Amount: ${data.amount}` : 'Total Amount: [To be calculated]'}
${data.currency ? `Currency: ${data.currency}` : 'Currency: MAD'}
${data.due_date ? `Due Date: ${data.due_date}` : 'Due Date: Net 30'}

Generated by: JARVIS Operations System`,

    receipt: `DRAFT PAYMENT RECEIPT
===============
Reference: ${ref}
Date: ${timestamp}
Status: DRAFT — NOT A PAYMENT CONFIRMATION

${data.payer ? `Payer: ${data.payer}` : 'Payer: [Record]'}
${data.payee ? `Payee: ${data.payee}` : 'Payee: [Record]'}
${data.amount ? `Amount: ${data.amount}` : 'Amount: [Record]'}
${data.currency ? `Currency: ${data.currency}` : 'Currency: MAD'}
${data.method ? `Payment Method: ${data.method}` : 'Payment Method: Secure Transfer'}
${data.reference ? `Original Reference: ${data.reference}` : ''}

Draft only — no payment confirmation is issued by JARVIS chat.`,

    delivery_note: `DRAFT DELIVERY NOTE
=============
Reference: ${ref}
Date: ${timestamp}

${data.carrier ? `Carrier: ${data.carrier}` : 'Carrier: [To be assigned]'}
${data.tracking_number ? `Tracking Number: ${data.tracking_number}` : 'Tracking: [To be assigned]'}
${data.origin ? `Origin: ${data.origin}` : 'Origin: [Warehouse]'}
${data.destination ? `Destination: ${data.destination}` : 'Destination: [Delivery Address]'}
${data.items ? `Items: ${data.items}` : 'Items: [As per PO]'}
${data.instructions ? `Special Instructions: ${data.instructions}` : ''}

Zero out-of-pocket protocol: DRAFT / UNVERIFIED
Recipient payment required: UNVERIFIED

Generated by: JARVIS Logistics Operations`,

    report: `DRAFT OPERATIONS REPORT
=================
Reference: ${ref}
Date: ${timestamp}
Type: ${data.report_type || 'General Operations'}

${data.summary ? `Summary: ${data.summary}` : ''}
${data.findings ? `Findings: ${data.findings}` : ''}
${data.recommendations ? `Recommendations: ${data.recommendations}` : ''}

Generated by: JARVIS Operations System`,
  };

  return {
    content: `${templates[type] || templates.report}\n\n---\n${DRAFT_DISCLAIMER}`,
    reference: ref,
  };
}

type ImageSize = NonNullable<CreateImageGenerationBody['size']>;
const IMAGE_SIZES: readonly ImageSize[] = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
];

function isImageSize(value: unknown): value is ImageSize {
  return typeof value === 'string' && (IMAGE_SIZES as readonly string[]).includes(value);
}

// Carrier tracking URL patterns
const CARRIER_TRACKING: Record<string, { name: string; searchPrefix: string }> = {
  maroc_express: { name: 'Maroc Express Logistics', searchPrefix: 'Maroc Express tracking' },
  poste_maroc: { name: 'Poste Maroc', searchPrefix: 'Poste Maroc suivi colis' },
  dhl: { name: 'DHL Express', searchPrefix: 'DHL tracking' },
  aramex: { name: 'Aramex', searchPrefix: 'Aramex tracking' },
  fedex: { name: 'FedEx', searchPrefix: 'FedEx tracking' },
};

// Execute a single tool call
async function executeTool(zai: ZAI, toolCall: ToolCall): Promise<ToolResult> {
  try {
    switch (toolCall.tool) {
      case 'web_search': {
        const query = toolCall.params.query;
        if (!query) return { tool: toolCall.tool, success: false, error: 'Missing query parameter' };
        const results = await zai.functions.invoke('web_search', { query, num: 8 });
        const normalizedResults = Array.isArray(results)
          ? results.map((result: SearchFunctionResultItem) => ({
              title: result.name,
              url: result.url,
              snippet: result.snippet,
              host_name: result.host_name,
            }))
          : [];
        return { tool: toolCall.tool, success: true, data: normalizedResults };
      }

      case 'image_generate': {
        const prompt = toolCall.params.prompt;
        if (!prompt) return { tool: toolCall.tool, success: false, error: 'Missing prompt parameter' };
        const selectedSize = isImageSize(toolCall.params.size) ? toolCall.params.size : '1024x1024';
        const response = await zai.images.generations.create({ prompt, size: selectedSize });
        if (!response.data || response.data.length === 0 || !response.data[0].base64) {
          return { tool: toolCall.tool, success: false, error: 'Image generation returned no data' };
        }
        return { tool: toolCall.tool, success: true, data: { image: response.data[0].base64, prompt, size: selectedSize } };
      }

      case 'web_reader': {
        const url = toolCall.params.url;
        if (!url) return { tool: toolCall.tool, success: false, error: 'Missing url parameter' };
        const result = await zai.functions.invoke('page_reader', { url });
        return { tool: toolCall.tool, success: true, data: result };
      }

      case 'generate_document': {
        const type = toolCall.params.type || 'report';
        const dataStr = toolCall.params.data || '{}';
        let data: Record<string, string>;
        try {
          data = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
        } catch {
          data = { raw: String(dataStr) };
        }
        const doc = generateDocument(type, data);
        return { tool: toolCall.tool, success: true, data: doc };
      }

      case 'track_shipment': {
        const carrier = toolCall.params.carrier || '';
        const trackingNumber = toolCall.params.tracking_number || '';
        if (!trackingNumber) return { tool: toolCall.tool, success: false, error: 'Missing tracking_number parameter' };

        const carrierInfo = CARRIER_TRACKING[carrier];
        const searchQuery = carrierInfo
          ? `${carrierInfo.searchPrefix} ${trackingNumber}`
          : `track shipment ${trackingNumber} ${carrier}`;

        const results = await zai.functions.invoke('web_search', {
          query: searchQuery,
          num: 5,
        });

        const searchResults = Array.isArray(results)
          ? results.map((result: SearchFunctionResultItem) => ({
              title: result.name,
              url: result.url,
              snippet: result.snippet,
            }))
          : [];

        return {
          tool: toolCall.tool,
          success: true,
          data: {
            carrier: carrierInfo?.name || carrier,
            tracking_number: trackingNumber,
            search_results: searchResults,
            carrier_name: carrierInfo?.name || 'Unknown',
          },
        };
      }

      default:
        return { tool: toolCall.tool, success: false, error: `Unknown tool: ${toolCall.tool}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error executing tool';
    console.error(`[JARVIS Tool ${toolCall.tool}] Error:`, message);
    return { tool: toolCall.tool, success: false, error: message };
  }
}

// ============================================================
// Chat API Route
// ============================================================

interface FileContext {
  name: string;
  type: string;
  analysis?: string;
  content?: string;
}

interface ChatRequest {
  message: string;
  history?: Array<{ role: string; content: string }>;
  agentId?: string;
  fileContexts?: FileContext[];
}

export async function POST(req: NextRequest) {
  try {
    const body: ChatRequest = await req.json();
    const { message, history = [], agentId, fileContexts = [] } = body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const zai = await ZAI.create();

    let systemPrompt = JARVIS_SYSTEM_PROMPT;
    let metadata: Record<string, unknown> = {};

    if (agentId && AGENT_SYSTEM_PROMPTS[agentId]) {
      systemPrompt = `${AGENT_SYSTEM_PROMPTS[agentId]}\n\n${ACTION_GUARDRAILS}`;
      const agentNames: Record<string, string> = {
        'code-reviewer': 'Code Reviewer',
        'security-auditor': 'Security Auditor',
        'test-engineer': 'Test Engineer',
        'web-perf': 'Web Performance',
        'payment-agent': 'Payment Processing',
        'custom-agent': 'Custom Operations',
      };
      metadata = { type: 'agent', agentId, agentName: agentNames[agentId] || agentId };
    }

    let enrichedMessage = message;
    if (fileContexts.length > 0) {
      const fileParts = fileContexts.map((f) => {
        let part = `[Attached File: ${f.name} (${f.type})]`;
        if (f.content) part += `\nFile Content:\n\`\`\`\n${f.content.slice(0, 8000)}\n\`\`\``;
        if (f.analysis) part += `\nJARVIS Analysis: ${f.analysis}`;
        return part;
      });
      enrichedMessage = `${message}\n\n---\nAttached Files Context:\n${fileParts.join('\n\n')}`;
      if (!agentId) metadata = { type: 'file_upload', ...metadata };
    }

    const messages = [
      { role: 'assistant' as const, content: systemPrompt },
      ...history.map((h) => ({ role: h.role as 'user' | 'assistant' | 'system', content: h.content })),
      { role: 'user' as const, content: enrichedMessage },
    ];

    // PASS 1: Get LLM response with potential tool calls
    const completion = await zai.chat.completions.create({ messages, thinking: { type: 'disabled' } });
    const rawResponse = completion.choices?.[0]?.message?.content || "I'm unable to process that request at the moment.";

    // Parse and execute tool calls
    const { toolCalls, cleanText } = parseToolCalls(rawResponse);
    const toolResults: ToolResult[] = [];
    for (const toolCall of toolCalls) {
      const result = await executeTool(zai, toolCall);
      toolResults.push(result);
    }

    // PASS 2: If tools were executed, refine response with real data
    let finalResponse = cleanText;
    let responseMetadata = { ...metadata };

    if (toolResults.length > 0) {
      const toolResultsContext = toolResults.map((result) => {
        if (result.success) {
          if (result.tool === 'web_search') {
            const searchResults = result.data as Array<{ title: string; url: string; snippet: string; host_name: string }>;
            const formattedResults = searchResults.slice(0, 6).map((r, i) =>
              `${i + 1}. **${r.title}** (${r.host_name})\n   ${r.snippet}\n   URL: ${r.url}`
            ).join('\n\n');
            return `[Web Search Results]:\n${formattedResults}`;
          } else if (result.tool === 'image_generate') {
            return `[Image Generated]: Image successfully generated from prompt.`;
          } else if (result.tool === 'web_reader') {
            return `[Web Page Content]: ${JSON.stringify(result.data).slice(0, 3000)}`;
          } else if (result.tool === 'generate_document') {
            const doc = result.data as { content: string; reference: string };
            return `[Document Generated]: Reference: ${doc.reference}\n\n${doc.content}`;
          } else if (result.tool === 'track_shipment') {
            const trackData = result.data as { carrier: string; tracking_number: string; search_results: Array<{ title: string; url: string; snippet: string }>; carrier_name: string };
            const trackResults = trackData.search_results.map((r, i) =>
              `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
            ).join('\n');
            return `[Shipment Tracking Results]: Carrier: ${trackData.carrier_name}, Tracking: ${trackData.tracking_number}\n${trackResults}`;
          }
          return `[${result.tool} Result]: ${JSON.stringify(result.data).slice(0, 2000)}`;
        }
        return `[${result.tool} Error]: ${result.error}`;
      }).join('\n\n---\n\n');

      const refinedMessages = [
        { role: 'assistant' as const, content: systemPrompt },
        ...history.map((h) => ({ role: h.role as 'user' | 'assistant' | 'system', content: h.content })),
        { role: 'user' as const, content: enrichedMessage },
        { role: 'assistant' as const, content: cleanText || 'Processing your request now.' },
        {
          role: 'user' as const,
          content: `Here are the real results from the tools executed:\n\n${toolResultsContext}\n\nBased on these real results, provide a comprehensive operational response. Be authoritative and action-oriented. Cite actual sources and data from the tool results.`,
        },
      ];

      const refinedCompletion = await zai.chat.completions.create({ messages: refinedMessages, thinking: { type: 'disabled' } });
      finalResponse = refinedCompletion.choices?.[0]?.message?.content || cleanText || 'Processing complete.';
    }

    // Build response metadata
    const searchResults: Array<{ title: string; url: string }> = [];
    let imageUrl: string | undefined;
    const generatedDocuments: Array<{ reference: string; type: string }> = [];
    const trackingResults: Array<{ carrier: string; trackingNumber: string }> = [];

    for (const result of toolResults) {
      if (result.success) {
        if (result.tool === 'web_search') {
          const data = result.data as Array<{ title: string; url: string }>;
          data.slice(0, 5).forEach((r) => searchResults.push({ title: r.title, url: r.url }));
          responseMetadata.type = 'search';
        } else if (result.tool === 'image_generate') {
          const data = result.data as { image: string; prompt: string };
          imageUrl = `data:image/png;base64,${data.image}`;
          responseMetadata.type = 'image_gen';
        } else if (result.tool === 'generate_document') {
          const data = result.data as { reference: string; content: string };
          generatedDocuments.push({ reference: data.reference, type: 'document' });
          responseMetadata.type = 'document';
        } else if (result.tool === 'track_shipment') {
          const data = result.data as { carrier: string; tracking_number: string };
          trackingResults.push({ carrier: data.carrier, trackingNumber: data.tracking_number });
          responseMetadata.type = 'tracking';
        } else if (result.tool === 'web_reader') {
          responseMetadata.type = 'search';
        }
      }
    }

    if (searchResults.length > 0) responseMetadata.sources = searchResults;
    if (imageUrl) responseMetadata.imageUrl = imageUrl;
    if (generatedDocuments.length > 0) responseMetadata.documents = generatedDocuments;
    if (trackingResults.length > 0) responseMetadata.tracking = trackingResults;
    if (toolResults.length > 0) responseMetadata.toolsUsed = toolResults.map((r) => r.tool);

    return NextResponse.json({
      response: finalResponse,
      timestamp: Date.now(),
      metadata: Object.keys(responseMetadata).length > 0 ? responseMetadata : undefined,
    });
  } catch (error) {
    console.error('[JARVIS Chat] Error:', error);
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
    }
    return NextResponse.json({ error: 'An internal error occurred' }, { status: 500 });
  }
}
