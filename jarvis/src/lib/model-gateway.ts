/**
 * Local-first model gateway.
 *
 * Strata and similar tools expose an OpenAI-compatible endpoint on localhost.
 * When JARVIS_LOCAL_BASE_URL is set, chat completions use it. Cloud (ZAI) is a
 * fallback only when JARVIS_ALLOW_CLOUD_FALLBACK=true, so prompts are never
 * silently sent to a vendor just because a local server is down.
 */

export interface GatewayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LocalGatewayConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  allowCloudFallback: boolean;
}

export class ModelGatewayError extends Error {
  readonly status = 503;

  constructor(message = 'The local model endpoint is unavailable and cloud fallback is disabled.') {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

function enabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function localGatewayConfig(env: NodeJS.ProcessEnv = process.env): LocalGatewayConfig | null {
  const baseUrl = env.JARVIS_LOCAL_BASE_URL?.trim();
  if (!baseUrl) return null;

  const timeout = Number(env.JARVIS_LOCAL_TIMEOUT_MS || 120_000);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: env.JARVIS_LOCAL_MODEL?.trim() || 'local-model',
    apiKey: env.JARVIS_LOCAL_API_KEY?.trim() || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    allowCloudFallback: enabled(env.JARVIS_ALLOW_CLOUD_FALLBACK),
  };
}

/** Accept a server root, .../v1, or a full chat-completions URL. */
export function localChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * OpenAI-compatible servers expect a system message, while the ZAI client in
 * this app receives the system prompt as a leading assistant message.
 */
export function toOpenAIMessages(messages: GatewayMessage[]): GatewayMessage[] {
  return messages.map((message, index) =>
    index === 0 && message.role === 'assistant' ? { ...message, role: 'system' } : message
  );
}

export async function completeLocal(
  config: LocalGatewayConfig,
  messages: GatewayMessage[],
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetchImpl(localChatUrl(config.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: toOpenAIMessages(messages),
      stream: false,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Local model returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Local model returned no text');
  }
  return content;
}
