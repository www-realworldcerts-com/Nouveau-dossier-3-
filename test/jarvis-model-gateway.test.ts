import { describe, expect, test } from 'bun:test';
import {
  completeLocal,
  localChatUrl,
  localGatewayConfig,
  toOpenAIMessages,
} from '../jarvis/src/lib/model-gateway';

describe('JARVIS local model gateway', () => {
  test('builds a chat-completions URL from common base shapes', () => {
    expect(localChatUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1/chat/completions'
    );
    expect(localChatUrl('http://127.0.0.1:8080/v1/')).toBe(
      'http://127.0.0.1:8080/v1/chat/completions'
    );
    expect(localChatUrl('http://127.0.0.1:8080/v1/chat/completions')).toBe(
      'http://127.0.0.1:8080/v1/chat/completions'
    );
  });

  test('is off unless a local base URL is configured', () => {
    expect(localGatewayConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test('reads fallback only from an explicit opt-in', () => {
    const config = localGatewayConfig({
      JARVIS_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1',
      JARVIS_LOCAL_MODEL: 'qwen-local',
      JARVIS_LOCAL_API_KEY: 'local-key',
      JARVIS_ALLOW_CLOUD_FALLBACK: 'true',
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen-local',
      apiKey: 'local-key',
      allowCloudFallback: true,
    });
  });

  test('converts the leading assistant system prompt for OpenAI compatibility', () => {
    expect(toOpenAIMessages([
      { role: 'assistant', content: 'system rules' },
      { role: 'user', content: 'hello' },
    ])).toEqual([
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'hello' },
    ]);
  });

  test('sends a non-streaming request and reads text back', async () => {
    const config = localGatewayConfig({
      JARVIS_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1',
      JARVIS_LOCAL_MODEL: 'qwen-local',
      JARVIS_LOCAL_API_KEY: 'local-key',
    } as NodeJS.ProcessEnv)!;

    let captured: { url: string; init?: RequestInit } | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'local answer' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const answer = await completeLocal(
      config,
      [{ role: 'assistant', content: 'rules' }, { role: 'user', content: 'hi' }],
      fakeFetch
    );

    expect(answer).toBe('local answer');
    expect(captured?.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect((captured?.init?.headers as Record<string, string>).Authorization).toBe('Bearer local-key');
    const body = JSON.parse(String(captured?.init?.body));
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
  });

  test('surfaces an HTTP failure instead of returning an empty answer', async () => {
    const config = localGatewayConfig({
      JARVIS_LOCAL_BASE_URL: 'http://127.0.0.1:8080/v1',
    } as NodeJS.ProcessEnv)!;
    const fakeFetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
    await expect(completeLocal(config, [{ role: 'user', content: 'hi' }], fakeFetch)).rejects.toThrow(
      'HTTP 503'
    );
  });
});
