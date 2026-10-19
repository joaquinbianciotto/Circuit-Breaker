import {
  validateExternalPatch,
  type ExternalConfig, type ExternalMetrics, type ExternalSnapshot,
} from '@resilience/contracts';

export class ConflictError extends Error {}
export class ProxyError extends Error {}

/** Upstream management and snapshots, separate from protected /work requests. */
export class ExternalApi {
  private external: ExternalSnapshot | null = null;
  private externalError: string | undefined;
  private externalObservedAt: number | null = null;
  private revision = 0;
  private refreshTicket = 0;
  private controllers = new Set<AbortController>();

  constructor(private readonly url: string) {}

  get snapshot() {
    return {
      external: structuredClone(this.external),
      externalObservedAt: this.externalObservedAt,
      externalError: this.externalError,
    };
  }

  async refresh(): Promise<ExternalSnapshot | null> {
    const revision = this.revision;
    const ticket = ++this.refreshTicket;
    try {
      const [config, metrics] = await Promise.all([
        this.proxy<ExternalConfig>('/config'), this.proxy<ExternalMetrics>('/metrics'),
      ]);
      if (revision === this.revision && ticket === this.refreshTicket) {
        this.external = { config, metrics };
        this.externalObservedAt = Date.now();
        this.externalError = undefined;
      }
    } catch (error) {
      if (revision === this.revision && ticket === this.refreshTicket) {
        this.external = null;
        this.externalObservedAt = null;
        this.externalError = error instanceof Error ? error.message : 'upstream-unavailable';
      }
    }
    return structuredClone(this.external);
  }

  async configure(value: unknown): Promise<ExternalConfig> {
    this.revision++;
    const current = await this.proxy<ExternalConfig>('/config');
    const next = validateExternalPatch(value, current);
    const config = await this.proxy<ExternalConfig>('/config', 'PATCH', next);
    this.revision++;
    await this.refresh();
    return config;
  }

  async reset() {
    this.revision++;
    const external = await this.proxy<ExternalSnapshot>('/reset', 'POST', {});
    this.revision++;
    this.external = external;
    this.externalObservedAt = Date.now();
    this.externalError = undefined;
  }

  shutdown() {
    for (const controller of this.controllers) controller.abort();
  }

  private async proxy<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${this.url}${path}`, {
        method, signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) throw new ConflictError('Upstream work is active');
        throw new ProxyError(`Upstream HTTP ${response.status}`);
      }
      return result as T;
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ProxyError) throw error;
      throw new ProxyError(error instanceof Error ? error.message : 'upstream-unavailable');
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
}
