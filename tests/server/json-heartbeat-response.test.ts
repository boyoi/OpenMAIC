import { describe, expect, it } from 'vitest';
import {
  STREAMED_HTTP_STATUS_FIELD,
  withJsonHeartbeat,
} from '@/lib/server/json-heartbeat-response';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('withJsonHeartbeat', () => {
  it('returns short responses without changing their status', async () => {
    const response = await withJsonHeartbeat(
      Promise.resolve(Response.json({ success: false }, { status: 401 })),
      { initialDelayMs: 50 },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ success: false });
  });

  it('streams JSON-safe heartbeats before the final successful body', async () => {
    const pending = deferred<Response>();
    const response = await withJsonHeartbeat(pending.promise, {
      initialDelayMs: 0,
      heartbeatIntervalMs: 5,
      heartbeatBytes: 8,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-openmaic-heartbeat')).toBe('1');

    pending.resolve(Response.json({ success: true, content: { title: 'AgentScope' } }));

    await expect(response.json()).resolves.toEqual({
      success: true,
      content: { title: 'AgentScope' },
    });
  });

  it('preserves a delayed error status in the streamed JSON body', async () => {
    const pending = deferred<Response>();
    const response = await withJsonHeartbeat(pending.promise, {
      initialDelayMs: 0,
      heartbeatIntervalMs: 5,
      heartbeatBytes: 8,
    });

    pending.resolve(Response.json({ success: false, error: 'rate limited' }, { status: 429 }));

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'rate limited',
      [STREAMED_HTTP_STATUS_FIELD]: 429,
    });
  });
});
