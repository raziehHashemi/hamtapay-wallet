export interface HttpResponse {
  status: number;
  body: unknown;
  text: string;
}

/** The request may or may not have reached the server (timeout, reset, DNS...). Outcome is UNKNOWN. */
export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

/** Small fetch wrapper with a hard timeout. Never throws on HTTP status codes, only on transport failure. */
export async function httpRequest(
  method: 'GET' | 'POST',
  url: string,
  options: { body?: unknown; timeoutMs: number; headers?: Record<string, string> },
): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const err = error as Error;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new HttpTransportError(`${method} ${url}: ${timedOut ? 'timed out' : err.message}`, timedOut);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new HttpTransportError(`${method} ${url}: body read failed: ${(error as Error).message}`, false);
  }
  let body: unknown = text;
  if (text && (response.headers.get('content-type') ?? '').includes('json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, text };
}
