// Optional native-browser verification. Uses an already installed Playwright module;
// no downloads, mocks or global package installation. --docker uses the existing
// production stack at localhost:3000, never starts/stops/restarts a container.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../../..');
const artifact = resolve(root, 'apps/frontend/.verification');
await mkdir(artifact, { recursive: true });
process.env.TMPDIR = artifact;
const require = createRequire(import.meta.url);
const runner = process.argv[2];
if (!runner) throw new Error('Pass the absolute path to an existing Playwright module.');
const { chromium } = require(runner);
const production = process.argv[3] === '--docker';
const base = production ? 'http://localhost:3000' : 'http://localhost:3100';
const screenshot = name => resolve(artifact, `${production ? 'docker-' : ''}${name}.png`);
const children = [];
const handles = [];
let context;
async function start(name, args, env = {}) {
  const handle = await open(resolve(artifact, `${name}.log`), 'w');
  handles.push(handle);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', handle.fd, handle.fd], env: { ...process.env, ...env } });
  children.push(child);
  child.on('error', error => console.error(`${name}: ${error.message}`));
  return child;
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not become ready: ${url}`);
}
const results = [];
let backend;
try {
  if (!production) {
    for (const url of ['http://localhost:3102/health', 'http://localhost:3101/api/health', 'http://localhost:3100']) {
      let occupied = false;
      try { await fetch(url, { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
      if (occupied) throw new Error(`Refusing to reuse an existing local service: ${url}`);
    }
    await start('upstream', ['apps/external-api/dist/main.js'], { PORT: '3102' });
    backend = await start('backend', ['apps/backend/dist/main.js'], { PORT: '3101', EXTERNAL_API_URL: 'http://localhost:3102' });
    await start('vite', ['node_modules/vite/bin/vite.js', '--config', 'apps/frontend/vite.config.ts', '--host', '127.0.0.1', '--port', '3100', 'apps/frontend'], { LAB_API_PROXY: 'http://localhost:3101' });
    await ready('http://localhost:3102/health');
    await ready('http://localhost:3101/api/health');
    await ready('http://localhost:3100');
  } else {
    await ready(`${base}/api/health`);
    const reset = await fetch(`${base}/api/reset`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    assert(reset.ok, 'Docker browser verification requires an idle lab; stop other scenario writers.');
  }
  context = await chromium.launchPersistentContext(resolve(artifact, production ? 'docker-browser-profile' : 'browser-profile'), {
    headless: true, viewport: { width: 1440, height: 1100 },
  });
  const page = context.pages()[0];
  const errors = [];
  const expectedNetworkErrors = [];
  const streamHeaders = [];
  let deliberateDisconnect = false;
  page.on('request', request => {
    if (request.url().endsWith('/api/events')) void request.allHeaders().then(headers => streamHeaders.push(headers));
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (deliberateDisconnect && /net::ERR_|502 \(Bad Gateway\)/.test(message.text())) expectedNetworkErrors.push(message.text());
    else errors.push(message.text());
  });
  // A reused persistent profile must inspect this deployment, not cached entry HTML.
  const network = await context.newCDPSession(page);
  await network.send('Network.enable');
  await network.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('[data-testid="connection-state"]')?.textContent.includes('CONNECTED'));
  const snapshot = () => page.evaluate(async () => (await fetch('/api/snapshot')).json());
  const settle = () => page.waitForFunction(() => !document.querySelector('[data-testid="mutation-status"]')?.textContent.endsWith('…'));
  const reset = async () => { await page.getByTestId('reset-simulation').click(); await settle(); };
  await page.getByRole('button', { name: 'Normal Response', exact: false }).click();
  await settle();
  await page.getByTestId('playback-speed').selectOption('0.25');
  await page.getByTestId('send-request').click();
  await settle();
  assert.equal((await snapshot()).histories.at(-1).outcome, 'success');
  await page.waitForFunction(() => document.querySelector('[data-testid="signal"][data-route="success"]'));
  results.push('Real normal request succeeds; quarter-speed playback reaches the observed success terminal.');
  await page.screenshot({ path: screenshot('desktop'), fullPage: true });

  await reset();
  await page.getByTestId('live-catch-up').click();
  await page.getByTestId('playback-speed').selectOption('0.25');
  await page.getByRole('button', { name: 'Intermittent Failure', exact: false }).click();
  await settle();
  await page.getByTestId('send-request').click();
  await page.waitForFunction(() => {
    const signal = document.querySelector('[data-testid="signal"][data-route="wait"][data-phase="1.000"]');
    if (!signal) return false;
    const head = signal.querySelector('circle');
    return Math.abs(Number(head.getAttribute('cx')) - 614) < 2 && Math.abs(Number(head.getAttribute('cy')) - 520) < 2;
  });
  await page.waitForFunction(() => {
    const head = document.querySelector('[data-testid="signal"][data-route="retry"] circle');
    const path = document.querySelector('#route-retry');
    if (!head || !path) return false;
    const x = Number(head.getAttribute('cx'));
    const y = Number(head.getAttribute('cy'));
    const length = path.getTotalLength();
    let closest = Infinity;
    for (let distance = 0; distance <= length; distance += 2) {
      const point = path.getPointAtLength(distance);
      closest = Math.min(closest, Math.hypot(point.x - x, point.y - y));
    }
    return closest < 3;
  });
  await settle();
  const retried = await snapshot();
  assert.equal(retried.histories.at(-1).attempts.length, 2);
  assert.equal(new Set(retried.external.metrics.logs.map(log => log.requestId)).size, 1);
  results.push('An identified retry parks at WAIT and returns along the actual SVG feedback conductor; HTTP logs keep one logical ID.');
  await page.getByTestId('live-catch-up').click();

  await page.getByTestId('playback-speed').selectOption('0.25');
  await page.getByRole('button', { name: 'Slow Response', exact: false }).click();
  await settle();
  await page.getByTestId('send-request').click();
  await settle();
  const slow = await snapshot();
  assert(slow.events.some(event => event.type === 'ATTEMPT_TIMEOUT'));
  assert(slow.external.metrics.cancelled > 0);
  assert.equal(slow.policy.attemptTimeoutMs, 800);
  assert(slow.histories.at(-1).attempts.every(attempt =>
    attempt.finishedAt - attempt.startedAt >= 700 && attempt.finishedAt - attempt.startedAt <= 850));
  results.push('Quarter-speed visuals leave real 800ms timeouts unchanged; upstream records actual abort/cancellation.');

  await reset();
  await page.getByTestId('pause-playback').click();
  await page.getByRole('button', { name: 'Always Fail', exact: false }).click();
  await settle();
  await page.getByTestId('send-batch').click();
  await settle();
  const opened = await snapshot();
  assert.equal(opened.state, 'OPEN');
  assert.equal(opened.metrics.rollingCompleted, 4);
  assert.equal(await page.getByTestId('machine').getAttribute('data-state'), 'CLOSED');
  assert((await page.getByTestId('live-state').textContent()).includes('OPEN'));
  assert((await page.getByTestId('playback-mode').textContent()).includes('PAUSED'));
  const received = opened.external.metrics.received;
  await page.getByTestId('send-request').click();
  await settle();
  const rejected = await snapshot();
  assert.equal(rejected.histories.at(-1).outcome, 'rejected');
  assert.equal(rejected.external.metrics.received, received);
  results.push('Paused figure remains historical CLOSED while LIVE is OPEN; OPEN rejection creates no HTTP.');
  await page.getByTestId('live-catch-up').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="machine"]')?.getAttribute('data-state') === 'OPEN');
  assert(await page.locator('[data-testid="signal"][data-route="reject"]').count());
  await page.waitForFunction(() => document.querySelector('[data-testid="live-state"]')?.textContent.includes('HALF_OPEN'), null, { timeout: 12000 });
  await page.getByTestId('recover-service').click();
  await settle();
  await page.getByTestId('send-batch').click();
  await settle();
  const recovered = await snapshot();
  assert.equal(recovered.state, 'CLOSED');
  assert.equal(recovered.histories.filter(history => history.probe && history.outcome === 'success').length, 1);
  assert.equal(recovered.histories.slice(-4).filter(history => history.outcome === 'rejected').length, 3);
  results.push('HALF_OPEN admits exactly one successful probe in a concurrent batch; other arrivals reject.');

  await page.getByTestId('auto-demo').click();
  await page.waitForFunction(() => document.querySelector('.demo-stage')?.textContent.startsWith('Complete'), null, { timeout: 60000 });
  assert.equal((await snapshot()).state, 'CLOSED');
  results.push('Auto Demo completes its deterministic real normal / timeout / open / reject / probe / intermittent sequence.');
  const beforeHover = (await snapshot()).external.metrics.received;
  await page.getByTestId('inspect-timeout').hover();
  assert.equal((await snapshot()).external.metrics.received, beforeHover);
  await page.getByTestId('policy-editor').locator('summary').click();
  await page.getByTestId('policy-attemptTimeoutMs').fill('850');
  await page.getByRole('button', { name: 'Apply Policy', exact: true }).click();
  await settle();
  assert.equal((await snapshot()).policy.attemptTimeoutMs, 850);
  assert.equal((await snapshot()).metrics.rollingCompleted, 0);
  const editor = page.getByTestId('external-editor');
  await editor.locator('summary').click();
  await editor.getByLabel(/^Mode/).selectOption('fail');
  await editor.getByLabel('Error status', { exact: true }).fill('422');
  await editor.getByLabel(/^Latency/).fill('180');
  await editor.getByRole('button', { name: 'Apply External Configuration', exact: true }).click();
  await settle();
  assert.equal((await snapshot()).external.config.errorStatus, 422);
  await page.getByTestId('send-request').click();
  await settle();
  const clientError = (await snapshot()).histories.at(-1);
  assert.equal(clientError.outcome, 'failure');
  assert.equal(clientError.attempts.length, 1);
  results.push('Custom external configuration uses real PATCH; a visible 422 failure has one attempt and no retry.');
  deliberateDisconnect = true;
  await page.context().setOffline(true);
  await page.waitForFunction(() => document.querySelector('[data-testid="connection-state"]')?.textContent.includes('OFFLINE'));
  assert(await page.getByTestId('send-request').isDisabled());
  await page.context().setOffline(false);
  await page.waitForFunction(() => document.querySelector('[data-testid="connection-state"]')?.textContent.includes('CONNECTED'));
  deliberateDisconnect = false;
  const ids = await page.locator('tr[data-event-id]').evaluateAll(rows => rows.map(row => row.dataset.eventId));
  assert.equal(ids.length, new Set(ids).size);
  results.push('Hover issues no HTTP, policy PATCH clears the real baseline, and browser offline/online holds controls with no duplicate events.');
  const oldEpoch = (await snapshot()).epoch;
  if (!production) {
    deliberateDisconnect = true;
    const exited = new Promise(resolve => backend.once('exit', resolve));
    backend.kill('SIGTERM');
    await exited;
    await page.waitForFunction(() => document.querySelector('[data-testid="connection-state"]')?.textContent.includes('OFFLINE'));
    assert(await page.getByTestId('send-request').isDisabled());
    await start('backend-restarted', ['apps/backend/dist/main.js'], { PORT: '3101', EXTERNAL_API_URL: 'http://localhost:3102' });
    await ready('http://localhost:3101/api/health');
    await page.waitForFunction(previous => {
      const machine = document.querySelector('[data-testid="machine"]');
      return machine && machine.getAttribute('data-epoch') !== previous;
    }, oldEpoch);
    deliberateDisconnect = false;
    assert(streamHeaders.some(headers => headers['last-event-id']?.startsWith(`${oldEpoch}:`)));
    assert.equal(await page.locator('tr[data-event-id]').count(), 0);
    await page.waitForFunction(() => document.querySelector('[data-testid="attempt-timer"]')?.textContent === '— ms');
    results.push('Owned backend restart exercises native Last-Event-ID reconnect and generation snapshot replacement with no fabricated request starts.');
  } else {
    await reset();
    await page.waitForFunction(previous => document.querySelector('[data-testid="machine"]')?.getAttribute('data-epoch') !== previous, oldEpoch);
    assert.equal(await page.locator('tr[data-event-id]').count(), 0);
    results.push('Docker generation reset replaces browser state without restarting containers; Node harness separately verifies Last-Event-ID replay.');
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByTestId('focus-toggle').click();
  assert.equal(await page.locator('.dock').count(), 0);
  assert(await page.getByRole('button', { name: 'Send Batch', exact: true }).count());
  for (const width of [1366, 1920]) {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : 1080 });
    const geometry = await page.getByTestId('machine').evaluate(svg => {
      const box = element => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      };
      const labels = [...svg.querySelectorAll('.svg-label, .svg-small, .svg-readout, .state-value')]
        .filter(element => element.getClientRects().length && getComputedStyle(element).display !== 'none')
        .map(element => {
          const matrix = element.getScreenCTM();
          return { text: element.textContent, major: element.matches('.svg-label, .state-value'),
            font: parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.a, matrix.b), ...box(element) };
        });
      const components = [...svg.querySelectorAll('.dial-rim, .contact-lever, .http-winding, .capacitor, .meter-rim, .reject-symbol, .socket')]
        .map(element => ({ name: element.getAttribute('class'), ...box(element) }));
      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
      // The selected elapsed readout belongs inside the timeout dial.
      const collisions = labels.flatMap(label => components.filter(component =>
        !(component.name === 'dial-rim' && label.text.endsWith(' ms')) && overlaps(label, component))
        .map(component => `${label.text} / ${component.name}`));
      const labelCollisions = labels.flatMap((label, index) => labels.slice(index + 1)
        .filter(other => overlaps(label, other)).map(other => `${label.text} / ${other.text}`));
      const bounds = box(svg);
      const clipped = labels.filter(label => label.x < bounds.x || label.right > bounds.right
        || label.y < bounds.y || label.bottom > bounds.bottom
        || label.x < 0 || label.right > innerWidth || label.y < 0 || label.bottom > innerHeight).map(label => label.text);
      const controls = [...document.querySelectorAll('.focus-controls button, .focus-controls input, .focus-controls select, .focus-button')];
      return { bounds, majors: Math.min(...labels.filter(label => label.major).map(label => label.font)),
        annotations: Math.min(...labels.filter(label => !label.major).map(label => label.font)),
        controls: Math.min(...controls.map(element => parseFloat(getComputedStyle(element).fontSize))),
        clipped, collisions, labelCollisions, pageFits: document.documentElement.scrollHeight <= innerHeight
          && document.documentElement.scrollWidth <= innerWidth };
    });
    console.log(`Focus ${width}: ${JSON.stringify(geometry)}`);
    assert(geometry.majors >= 16, `Focus ${width} major labels must render at least 16px (actual ${geometry.majors.toFixed(2)}px)`);
    assert(geometry.annotations >= 12, `Focus ${width} core annotations must render at least 12px`);
    assert(geometry.controls >= 13, `Focus ${width} minimal controls must render at least 13px`);
    assert(geometry.pageFits, `Focus ${width} must fit the viewport`);
    assert.deepEqual(geometry.clipped, [], `Focus ${width} labels must remain inside the instrument and viewport`);
    assert.deepEqual(geometry.collisions, [], `Focus ${width} labels must not overlap major components`);
    assert.deepEqual(geometry.labelCollisions, [], `Focus ${width} labels must not overlap one another`);
    await page.screenshot({ path: screenshot(`projector-${width}`), fullPage: false });
  }
  await page.screenshot({ path: screenshot('focus'), fullPage: true });
  await page.keyboard.press('Escape');
  assert(await page.locator('.dock').count());
  assert(await page.getByTestId('focus-toggle').evaluate(element => element === document.activeElement));
  await page.getByTestId('inspect-retry').focus();
  await page.keyboard.press('Enter');
  assert((await page.getByTestId('component-inspection').textContent()).includes('Retry feedback'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[data-testid="machine"]')?.getAttribute('data-reduced-motion') === 'true');
  await page.getByRole('button', { name: 'Slow Response', exact: false }).click();
  await settle();
  await page.getByTestId('send-request').click();
  await page.waitForFunction(() => {
    const signal = document.querySelector('[data-testid="signal"][data-route="http"]');
    const head = signal?.querySelector('circle');
    return head?.getAttribute('cx') === '800' && head.getAttribute('cy') === '300';
  });
  const reducedPosition = () => page.locator('[data-testid="signal"][data-route="http"]').first().evaluate(signal => {
    const circles = [...signal.querySelectorAll('circle')];
    return { x: circles[0].getAttribute('cx'), y: circles[0].getAttribute('cy'),
      trails: circles.slice(1).map(circle => getComputedStyle(circle).opacity) };
  });
  const staticHead = await reducedPosition();
  await page.waitForTimeout(100);
  assert.deepEqual(await reducedPosition(), staticHead);
  assert.deepEqual(staticHead, { x: '800', y: '300', trails: ['0', '0', '0'] });
  await page.screenshot({ path: screenshot('reduced-motion'), fullPage: true });
  await settle();
  await reset();
  results.push('Reduced-motion HTTP marker stays at (800,300) for 100ms with all trails invisible.');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: screenshot('mobile'), fullPage: true });
  results.push('Focus/Escape, keyboard inspection, reduced-motion handling and 390px mobile containment pass.');
  assert.deepEqual(errors, []);
  console.log(results.join('\n'));
  if (production) {
    const restored = await fetch(`${base}/api/reset`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    assert(restored.ok);
    assert.equal((await restored.json()).policy.attemptTimeoutMs, 800);
    await page.waitForFunction(async () => {
      const current = await (await fetch('/api/snapshot')).json();
      return current.state === 'CLOSED' && Object.values(current.metrics).every(value => value === 0)
        && current.external && ['received', 'completed', 'cancelled', 'active'].every(key => current.external.metrics[key] === 0);
    });
    const defaults = await snapshot();
    assert.deepEqual(defaults.policy, { attemptTimeoutMs: 800, retries: 2, backoffMs: 200,
      operationDeadlineMs: 3000, errorThresholdPercentage: 50, minimumVolume: 4,
      rollingWindowMs: 20000, recoveryMs: 7000 });
    assert.deepEqual(defaults.external.config, { mode: 'normal', latencyMs: 0, errorStatus: 503,
      failureRate: 0.5, intermittent: 'alternating' });
    assert.deepEqual(defaults.histories, []);
    assert.deepEqual(defaults.events, []);
    assert.deepEqual(defaults.external.metrics.logs, []);
    console.log('Final defaults: CLOSED, idle, zero engine/upstream metrics, empty histories/events/logs, all policy/upstream defaults.');
  }
  console.log(`Unexpected browser console/page errors: 0. Intentional disconnect diagnostics: ${expectedNetworkErrors.length}. ${production ? 'Production Docker URL verified; defaults restored, containers left running.' : 'Native local-process self-check only.'}`);
} finally {
  if (context) await context.close();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
  for (const handle of handles) await handle.close();
}
