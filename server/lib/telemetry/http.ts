export interface TelemetryTransport {
  postJson(path: string, body: unknown): Promise<boolean>;
}

export interface TelemetryHttpTransportOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
const DEFAULT_MAX_RETRIES = 2;

function shouldRetry(status: number): boolean {
  return status >= 500 && status <= 599;
}

export function createTelemetryHttpTransport(options: TelemetryHttpTransportOptions): TelemetryTransport {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseUrl = options.baseUrl;

  return {
    async postJson(path, body) {
      try {
        const serialized = JSON.stringify(body);
        if (Buffer.byteLength(serialized, 'utf8') > maxRequestBytes) {
          return false;
        }

        const url = new URL(path, baseUrl).toString();

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          try {
            const response = await fetchImpl(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: serialized,
              signal: AbortSignal.timeout(timeoutMs),
            });

            if (response.ok) {
              return true;
            }

            if (!shouldRetry(response.status) || attempt === maxRetries) {
              return false;
            }
          } catch {
            if (attempt === maxRetries) {
              return false;
            }
          }
        }
      } catch {
        return false;
      }

      return false;
    },
  };
}
