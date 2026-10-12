import { createBackend } from './app';

async function main() {
  const { app } = await createBackend();
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
  console.info(`Backend listening on ${await app.getUrl()}`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
