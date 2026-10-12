import Fastify from 'fastify';
import {
  DEFAULT_EXTERNAL_CONFIG, ValidationError, validateExternalPatch,
  type ExternalConfig, type ExternalMetrics, type UpstreamLog,
} from '@resilience/contracts';

export function createExternalApi() {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  let config: ExternalConfig = { ...DEFAULT_EXTERNAL_CONFIG };
  let received = 0;
  let completed = 0;
  let cancelled = 0;
  let active = 0;
  let intermittentIndex = 0;
  const finished: UpstreamLog[] = [];
  const pending = new Set<UpstreamLog>();
  const timers = new Set<NodeJS.Timeout>();
  // Deterministic seed; probability mode is reproducible after reset too.
  let seed = 123456789;
  function random() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  }
  function metrics(): ExternalMetrics {
    return { received, completed, cancelled, active, logs: structuredClone([...finished, ...pending]) };
  }
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ValidationError ? 400
      : error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : 'Unexpected upstream error';
    reply.code(status).send({ statusCode: status, message });
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/config', async () => ({ ...config }));
  app.get('/metrics', async () => metrics());
  app.patch('/config', async (request) => {
    config = validateExternalPatch(request.body, config);
    return { ...config };
  });
  app.post('/reset', async (_request, reply) => {
    if (active > 0) return reply.code(409).send({ statusCode: 409, message: 'Upstream work is active' });
    config = { ...DEFAULT_EXTERNAL_CONFIG };
    received = completed = cancelled = intermittentIndex = 0;
    finished.length = 0;
    seed = 123456789;
    return { config, metrics: metrics() };
  });
  function archive(log: UpstreamLog) {
    finished.push(log);
    if (finished.length > 200) finished.shift();
  }
  app.get('/work', (request, reply) => {
    const settings = { ...config };
    const log: UpstreamLog = {
      requestId: typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : null,
      attemptId: typeof request.headers['x-attempt-id'] === 'string' ? request.headers['x-attempt-id'] : null,
      receivedAt: Date.now(), outcome: 'active',
    };
    received++;
    if (active >= 100) {
      completed++;
      archive({ ...log, outcome: 'completed', status: 503, finishedAt: Date.now() });
      return reply.code(503).send({ message: 'Upstream capacity reached' });
    }
    active++;
    pending.add(log);
    let fails = settings.mode === 'fail';
    if (settings.mode === 'intermittent') {
      fails = settings.intermittent === 'alternating'
        ? (++intermittentIndex % 2 === 1) : random() < settings.failureRate;
    }
    const status = fails ? settings.errorStatus : 200;
    // A positive explicit latency overrides the slow-mode convenience default.
    const latency = settings.mode === 'slow' && settings.latencyMs === 0 ? 1500 : settings.latencyMs;
    let done = false;
    let timer: NodeJS.Timeout;
    function finish(outcome: 'completed' | 'cancelled') {
      if (done) return;
      done = true;
      clearTimeout(timer);
      timers.delete(timer);
      active--;
      if (outcome === 'completed') completed++; else cancelled++;
      log.outcome = outcome;
      log.finishedAt = Date.now();
      if (outcome === 'completed') log.status = status;
      pending.delete(log);
      archive(log);
      reply.raw.off('close', onClose);
      reply.raw.off('finish', onFinish);
    }
    function onClose() {
      // IncomingMessage close means the request body ended, NOT client abort.
      if (!reply.raw.writableEnded) finish('cancelled');
    }
    function onFinish() { finish('completed'); }
    reply.raw.on('close', onClose);
    reply.raw.on('finish', onFinish);
    timer = setTimeout(() => {
      reply.code(status).send({ ok: !fails, requestId: log.requestId, attemptId: log.attemptId });
    }, latency);
    timers.add(timer);
    return reply;
  });
  app.addHook('onClose', async () => { for (const timer of timers) clearTimeout(timer); });
  return app;
}
