import type { BatchResponse, ExternalConfig, Policy, Snapshot } from '@resilience/contracts';

export class ApiFailure extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function json<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method, signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new ApiFailure(response.status, response.status === 409
      ? 'Engine busy (409). Let admitted operations finish, then try again.'
      : `${response.status}: ${data.message ?? 'API request failed'}`);
  }
  return data as T;
}
export const api = {
  snapshot: (signal?: AbortSignal) => json<Snapshot>('snapshot', 'GET', undefined, signal),
  send: (count: number) => json<BatchResponse>('requests', 'POST', { count }),
  policy: (policy: Policy) => json<Policy>('config', 'PATCH', policy),
  external: (config: Partial<ExternalConfig>) => json<ExternalConfig>('external', 'PATCH', config),
  reset: () => json<Snapshot>('reset', 'POST', {}),
};
