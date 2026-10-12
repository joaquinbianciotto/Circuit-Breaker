import { createExternalApi } from './server';

async function main() {
  const app = createExternalApi();
  const url = await app.listen({ port: Number(process.env.PORT ?? 3002), host: '0.0.0.0' });
  console.info(`External API listening on ${url}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void app.close(); });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
