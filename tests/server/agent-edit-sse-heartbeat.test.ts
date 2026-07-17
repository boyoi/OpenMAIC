import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@earendil-works/pi-agent-core';

const mocks = vi.hoisted(() => ({
  isMaicEditorEnabled: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  buildSystemPrompt: vi.fn(),
  buildToolset: vi.fn(),
  callLLM: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isMaicEditorEnabled: mocks.isMaicEditorEnabled,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));
vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
  buildSystemPrompt: mocks.buildSystemPrompt,
}));
vi.mock('@/lib/agent/tools/registry', () => ({
  buildToolset: mocks.buildToolset,
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
    debug: vi.fn(),
  }),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRequest(signal: AbortSignal) {
  return {
    signal,
    json: async () => ({ message: 'repair this slide' }),
  } as unknown as Parameters<typeof import('@/app/api/agent/edit/route').POST>[0];
}

function decode(result: ReadableStreamReadResult<Uint8Array>): string {
  return result.value ? new TextDecoder().decode(result.value) : '';
}

describe('agent edit SSE heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isMaicEditorEnabled.mockReturnValue(true);
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: { id: 'test-model' },
      modelInfo: { outputWindow: 4096 },
      thinkingConfig: undefined,
      modelString: 'openai:test-model',
    });
    mocks.createCallLlmStreamFn.mockReturnValue(vi.fn());
    mocks.buildSystemPrompt.mockReturnValue('system');
    mocks.buildToolset.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a silent long-running agent turn alive and disables proxy buffering', async () => {
    const prompt = deferred<void>();
    const agent = {
      subscribe: vi.fn((_listener: (event: AgentEvent) => void) => vi.fn()),
      prompt: vi.fn(() => prompt.promise),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
    };
    mocks.buildAgent.mockReturnValue(agent);

    const { POST } = await import('@/app/api/agent/edit/route');
    const response = await POST(makeRequest(new AbortController().signal));
    const reader = response.body!.getReader();

    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(decode(await reader.read())).toBe(': connected\n\n');

    const nextChunk = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(decode(await nextChunk)).toBe(': heartbeat\n\n');

    prompt.resolve();
    expect(decode(await reader.read())).toBe('event: close\ndata: {}\n\n');
    expect(await reader.read()).toMatchObject({ done: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the upstream run and heartbeat when the browser closes the stream', async () => {
    const prompt = deferred<void>();
    const unsubscribe = vi.fn();
    const agent = {
      subscribe: vi.fn(() => unsubscribe),
      prompt: vi.fn(() => prompt.promise),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
    };
    mocks.buildAgent.mockReturnValue(agent);

    const { POST } = await import('@/app/api/agent/edit/route');
    const response = await POST(makeRequest(new AbortController().signal));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    prompt.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('aborts and closes the stream when the request signal is cancelled', async () => {
    const prompt = deferred<void>();
    const requestAbort = new AbortController();
    const agent = {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(() => prompt.promise),
      waitForIdle: vi.fn(async () => undefined),
      abort: vi.fn(),
    };
    mocks.buildAgent.mockReturnValue(agent);

    const { POST } = await import('@/app/api/agent/edit/route');
    const response = await POST(makeRequest(requestAbort.signal));
    const reader = response.body!.getReader();
    await reader.read();
    requestAbort.abort();

    expect(await reader.read()).toMatchObject({ done: true });
    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    prompt.resolve();
    await Promise.resolve();
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
