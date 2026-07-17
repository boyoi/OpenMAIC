const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_BYTES = 2_048;

export const STREAMED_HTTP_STATUS_FIELD = '_httpStatus';

interface JsonHeartbeatOptions {
  initialDelayMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatBytes?: number;
}

type ResponseOutcome = { type: 'response'; response: Response } | { type: 'heartbeat' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function serializeStreamedResponse(response: Response): Promise<string> {
  const body = await response.text();
  if (response.ok) return body;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      return JSON.stringify({
        ...parsed,
        [STREAMED_HTTP_STATUS_FIELD]: response.status,
      });
    }
  } catch {
    // Fall through to a safe generic JSON error body.
  }

  return JSON.stringify({
    success: false,
    error: response.statusText || 'Request failed',
    [STREAMED_HTTP_STATUS_FIELD]: response.status,
  });
}

/**
 * Return short requests normally, but keep long JSON requests alive through
 * reverse proxies by streaming JSON-safe whitespace until the final body is
 * ready. Leading whitespace is valid JSON, so existing response.json() clients
 * continue to work unchanged.
 */
export async function withJsonHeartbeat(
  responsePromise: Promise<Response>,
  options: JsonHeartbeatOptions = {},
): Promise<Response> {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatBytes = Math.max(options.heartbeatBytes ?? DEFAULT_HEARTBEAT_BYTES, 1);

  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race<ResponseOutcome>([
    responsePromise.then((response) => ({ type: 'response', response })),
    new Promise<ResponseOutcome>((resolve) => {
      delayTimer = setTimeout(() => resolve({ type: 'heartbeat' }), initialDelayMs);
    }),
  ]);

  if (outcome.type === 'response') {
    if (delayTimer) clearTimeout(delayTimer);
    return outcome.response;
  }

  const encoder = new TextEncoder();
  const heartbeat = encoder.encode(`${' '.repeat(heartbeatBytes)}\n`);
  let open = true;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        open = false;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      };

      const enqueueHeartbeat = () => {
        if (!open) return;
        try {
          controller.enqueue(heartbeat);
        } catch {
          stop();
        }
      };

      enqueueHeartbeat();
      heartbeatTimer = setInterval(enqueueHeartbeat, heartbeatIntervalMs);

      void responsePromise
        .then(serializeStreamedResponse)
        .then((body) => {
          if (!open) return;
          controller.enqueue(encoder.encode(body));
          stop();
          controller.close();
        })
        .catch(() => {
          if (!open) return;
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                success: false,
                error: 'Request failed',
                [STREAMED_HTTP_STATUS_FIELD]: 500,
              }),
            ),
          );
          stop();
          controller.close();
        });
    },
    cancel() {
      open = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'Content-Encoding': 'identity',
      'X-Accel-Buffering': 'no',
      'X-OpenMAIC-Heartbeat': '1',
    },
  });
}
