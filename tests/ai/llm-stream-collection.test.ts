import { describe, expect, it, vi } from 'vitest';

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));

import { collectStreamedLLMText } from '@/lib/ai/llm';

describe('collectStreamedLLMText', () => {
  it('collects every text chunk in order and forwards the abort signal', async () => {
    const abortSignal = new AbortController().signal;
    aiMock.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'start' };
        yield { type: 'text-delta', id: 'text-1', text: '{"title":' };
        yield { type: 'text-delta', id: 'text-1', text: '"AgentScope"}' };
        yield { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop' };
      })(),
    });

    const text = await collectStreamedLLMText(
      {
        model: 'test-model',
        prompt: 'Generate JSON',
        abortSignal,
      } as Parameters<typeof collectStreamedLLMText>[0],
      'stream-collection-test',
    );

    expect(text).toBe('{"title":"AgentScope"}');
    expect(aiMock.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal,
      }),
    );
  });

  it('propagates errors raised while consuming the stream', async () => {
    const streamError = Object.assign(new Error('upstream stream failed'), {
      statusCode: 503,
    });
    aiMock.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'partial' };
        throw streamError;
      })(),
    });

    await expect(
      collectStreamedLLMText(
        {
          model: 'test-model',
          prompt: 'Generate JSON',
        } as Parameters<typeof collectStreamedLLMText>[0],
        'stream-error-test',
      ),
    ).rejects.toBe(streamError);
  });

  it('rejects an error stream part instead of returning partial text', async () => {
    const streamError = new Error('provider emitted an error part');
    aiMock.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'partial' };
        yield { type: 'error', error: streamError };
      })(),
    });

    await expect(
      collectStreamedLLMText(
        {
          model: 'test-model',
          prompt: 'Generate JSON',
        } as Parameters<typeof collectStreamedLLMText>[0],
        'stream-error-part-test',
      ),
    ).rejects.toBe(streamError);
  });

  it('rejects finishReason error instead of returning partial text', async () => {
    aiMock.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'partial' };
        yield {
          type: 'finish',
          finishReason: 'error',
          rawFinishReason: 'upstream_error',
        };
      })(),
    });

    await expect(
      collectStreamedLLMText(
        {
          model: 'test-model',
          prompt: 'Generate JSON',
        } as Parameters<typeof collectStreamedLLMText>[0],
        'stream-finish-error-test',
      ),
    ).rejects.toThrow('upstream_error');
  });

  it('rejects an errored finish-step before the final finish event', async () => {
    aiMock.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'partial' };
        yield {
          type: 'finish-step',
          finishReason: 'error',
          rawFinishReason: 'step_error',
        };
      })(),
    });

    await expect(
      collectStreamedLLMText(
        {
          model: 'test-model',
          prompt: 'Generate JSON',
        } as Parameters<typeof collectStreamedLLMText>[0],
        'stream-step-error-test',
      ),
    ).rejects.toThrow('step_error');
  });

  it('preserves an abort event as an AbortError', async () => {
    aiMock.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'partial' };
        yield { type: 'abort', reason: 'user paused generation' };
      })(),
    });

    await expect(
      collectStreamedLLMText(
        {
          model: 'test-model',
          prompt: 'Generate JSON',
        } as Parameters<typeof collectStreamedLLMText>[0],
        'stream-abort-test',
      ),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('user paused generation'),
    });
  });

  it('rejects a stream that ends without a finish event', async () => {
    aiMock.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'partial' };
      })(),
    });

    await expect(
      collectStreamedLLMText(
        {
          model: 'test-model',
          prompt: 'Generate JSON',
        } as Parameters<typeof collectStreamedLLMText>[0],
        'stream-missing-finish-test',
      ),
    ).rejects.toThrow('ended before a finish event');
  });
});
