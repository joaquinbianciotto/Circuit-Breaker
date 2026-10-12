import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const children: ChildProcess[] = [];
async function start(entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)), 5000);
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1].replace('0.0.0.0', '127.0.0.1')); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${errors}`)); });
  });
}

it('starts both compiled Node entrypoints and performs real backend-to-upstream HTTP', async () => {
  try {
    const external = await start('apps/external-api/dist/main.js', { PORT: '0' });
    const backend = await start('apps/backend/dist/main.js', { PORT: '0', EXTERNAL_API_URL: external });
    expect((await fetch(`${backend}/api/health`)).status).toBe(200);
    const response = await fetch(`${backend}/api/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 1 }),
    });
    expect((await response.json()).results[0]).toMatchObject({ outcome: 'success', attempts: 1 });
    const snapshot = await (await fetch(`${backend}/api/snapshot`)).json();
    expect(snapshot.external.metrics).toMatchObject({ received: 1, completed: 1, active: 0, cancelled: 0 });
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
    children.length = 0;
  }
});
