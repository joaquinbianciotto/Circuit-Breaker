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
  const until = async predicate => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await page.waitForTimeout(30);
    }
    throw new Error('Timed out waiting for an authoritative API observation.');
  };
  const settle = () => until(async () => {
    const held = await page.evaluate(() =>
      document.querySelector('[data-testid="mutation-status"]')?.textContent.endsWith('…') ||
      document.querySelector('.focus-controls .button')?.disabled ||
      document.querySelector('[data-testid="send-request"]')?.disabled);
    return !held && (await snapshot()).metrics.active === 0;
  });
  const reset = async () => {
    const epoch = (await snapshot()).epoch;
    await page.getByTestId('reset-simulation').click();
    await until(async () => (await snapshot()).epoch !== epoch);
    await settle();
  };
  const completed = (before, amount) => until(async () => {
    const added = (await snapshot()).histories.filter(history => !before.includes(history.requestId));
    return added.length === amount && added.every(history => history.finishedAt !== undefined && history.outcome);
  });
  const send = async (amount = 1, focus = false) => {
    const before = (await snapshot()).histories.map(history => history.requestId);
    await (focus ? page.getByRole('button', { name: 'Send Request', exact: true })
      : page.getByTestId(amount === 1 ? 'send-request' : 'send-batch')).click();
    await completed(before, amount);
    await settle();
  };
  // Collect painted coordinates BEFORE sends; post-response DOM inspection misses fast starts.
  await page.evaluate(() => {
    window.journeyFrames = [];
    const collect = () => {
      for (const signal of document.querySelectorAll('[data-testid="signal"]')) {
        const head = signal.querySelector('circle');
        window.journeyFrames.push({ id: signal.dataset.requestId, route: signal.dataset.route, time: performance.now(),
          attempt: signal.dataset.attemptId, x: Number(head.getAttribute('cx')), y: Number(head.getAttribute('cy')) });
      }
      requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);
  });
  const assertJourneys = async (histories) => {
    await page.waitForFunction(ids => ids.every(id => window.journeyFrames.some(frame =>
      frame.id === id && ['success', 'failure', 'reject'].includes(frame.route) && frame.x >= 973)),
      histories.map(history => history.requestId), { timeout: 15000 });
    const frames = await page.evaluate(() => window.journeyFrames);
    for (const history of histories) {
      const samples = frames.filter(frame => frame.id === history.requestId);
      assert.equal(samples[0].route, 'inlet', `${history.requestId} must start at REQUEST IN`);
      assert(samples.some(frame => frame.route === 'inlet' && frame.x === 86 && frame.y === 300));
      const routes = samples.map(frame => frame.route).filter((route, index, all) => index === 0 || route !== all[index - 1]);
      const outcome = history.outcome === 'rejected' ? 'reject' : history.outcome;
      assert.equal(routes.at(-1), outcome);
      if (outcome === 'reject') {
        assert.deepEqual(routes, ['inlet', 'reject']);
        assert(samples.some(frame => frame.route === 'reject' && frame.x >= 973 && frame.y === 612));
      } else {
        assert.equal(routes[1], 'http');
        assert(samples.some(frame => frame.route === 'http' && frame.x >= 410 && frame.x <= 800 && frame.y >= 282 && frame.y <= 318));
        assert(samples.some(frame => frame.route === outcome && frame.x >= 973 && frame.y === (outcome === 'success' ? 236 : 386)));
        assert.equal(routes.filter(route => route === 'inlet').length, 1, 'Retries never re-enter admission');
        for (const attempt of history.attempts) assert(samples.some(frame => frame.route === 'http' && frame.attempt === attempt.attemptId));
      }
    }
  };
  const visualSpeed = page.getByRole('combobox', { name: 'Visual speed', exact: true });
  assert.equal(await visualSpeed.count(), 1);
  assert.equal(await visualSpeed.inputValue(), '1');
  assert.deepEqual(await visualSpeed.locator('option').evaluateAll(options => options.map(option =>
    ({ value: option.value, label: option.textContent }))), [
    { value: '1', label: '1×' }, { value: '0.5', label: '0.5×' }, { value: '0.25', label: '0.25×' },
  ]);
  assert.equal(await visualSpeed.getAttribute('aria-describedby'), 'visual-speed-help');
  assert(await page.locator('#visual-speed-help').isVisible());
  assert.equal(await page.locator('[data-testid="pause-playback"], [data-testid="live-catch-up"], [data-testid="inspect-meter"], .meter-rim').count(), 0);
  assert(!(await page.getByTestId('machine').textContent()).includes('LIVE BACKEND ROLLING LEDGER'));
  await page.getByRole('button', { name: 'Normal Response', exact: false }).click();
  await settle();
  await send();
  const normal = (await snapshot()).histories.at(-1);
  assert.equal(normal.outcome, 'success');
  await assertJourneys([normal]);
  results.push('Real success paints REQUEST IN, HTTP and the success socket in order.');
  await reset();
  // Reset restores genuine zero-latency defaults; no visibility latency is added.
  const streamsBeforeSpeed = streamHeaders.length;
  await visualSpeed.selectOption('0.5');
  assert.equal(await visualSpeed.inputValue(), '0.5');
  await visualSpeed.selectOption('0.25');
  await send();
  const zero = (await snapshot()).histories.at(-1);
  assert.equal((await snapshot()).external.config.latencyMs, 0);
  await assertJourneys([zero]);
  const inletDuration = id => page.evaluate(id => {
    const samples = window.journeyFrames.filter(frame => frame.id === id);
    return samples.find(frame => frame.route === 'http').time - samples.find(frame => frame.route === 'inlet').time;
  }, id);
  const defaultInlet = await inletDuration(normal.requestId);
  const quarterInlet = await inletDuration(zero.requestId);
  assert(quarterInlet >= 1000 && quarterInlet <= 1600, `Quarter-speed inlet duration: ${quarterInlet}ms`);
  assert(quarterInlet > defaultInlet * 3 && quarterInlet < defaultInlet * 5, 'Quarter speed visibly slows the same route');
  assert(zero.finishedAt - zero.startedAt < quarterInlet, 'HTTP completion remains independent of the slower visual inlet');
  assert.equal(streamHeaders.length, streamsBeforeSpeed, 'Speed changes must not restart SSE');
  await visualSpeed.selectOption('1');
  assert((await snapshot()).histories.some(history => history.requestId === zero.requestId), 'Speed changes must retain observed history');
  results.push('Native Visual speed options slow quarter-speed inlet approximately 4× without restarting SSE or delaying authoritative completion.');
  await reset();
  await page.getByTestId('batch-count').fill('10');
  await send(10);
  const batch = (await snapshot()).histories;
  assert.equal(batch.length, 10);
  assert(batch.every(history => history.outcome === 'success'));
  await assertJourneys(batch);
  results.push('Zero-latency single and all ten completed batch IDs paint inlet, HTTP and terminal before trimming.');
  await page.screenshot({ path: screenshot('desktop'), fullPage: true });

  await reset();
  await page.getByRole('button', { name: 'Intermittent Failure', exact: false }).click();
  await settle();
  const retryBefore = (await snapshot()).histories.map(history => history.requestId);
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
  await completed(retryBefore, 1);
  await settle();
  const retried = await snapshot();
  assert.equal(retried.histories.at(-1).attempts.length, 2);
  assert.equal(new Set(retried.external.metrics.logs.map(log => log.requestId)).size, 1);
  results.push('An identified retry parks at WAIT and returns along the actual SVG feedback conductor; HTTP logs keep one logical ID.');
  await assertJourneys([retried.histories.at(-1)]);
  await page.getByRole('button', { name: 'Slow Response', exact: false }).click();
  await settle();
  await send();
  const slow = await snapshot();
  assert(slow.events.some(event => event.type === 'ATTEMPT_TIMEOUT'));
  assert(slow.external.metrics.cancelled > 0);
  assert.equal(slow.policy.attemptTimeoutMs, 800);
  assert(slow.histories.at(-1).attempts.every(attempt =>
    attempt.finishedAt - attempt.startedAt >= 700 && attempt.finishedAt - attempt.startedAt <= 850));
  results.push('Minimum visible stages leave real 800ms timeouts unchanged; upstream records actual abort/cancellation.');

  await reset();
  await page.getByTestId('batch-count').fill('4');
  await page.getByRole('button', { name: 'Always Fail', exact: false }).click();
  await settle();
  await send(4);
  const opened = await snapshot();
  assert.equal(opened.state, 'OPEN');
  assert.equal(opened.metrics.rollingCompleted, 4);
  assert.equal(await page.getByTestId('machine').getAttribute('data-state'), 'OPEN');
  assert((await page.getByTestId('live-state').textContent()).includes('OPEN'));
  await assertJourneys(opened.histories);
  const received = opened.external.metrics.received;
  await send();
  const rejected = await snapshot();
  assert.equal(rejected.histories.at(-1).outcome, 'rejected');
  assert.equal(rejected.external.metrics.received, received);
  await assertJourneys([rejected.histories.at(-1)]);
  results.push('Gate stays live OPEN; rejected request paints inlet then shunt without HTTP.');
  await page.waitForFunction(() => document.querySelector('[data-testid="machine"]')?.getAttribute('data-state') === 'OPEN');
  assert(await page.locator('[data-testid="signal"][data-route="reject"]').count());
  await page.waitForFunction(() => document.querySelector('[data-testid="live-state"]')?.textContent.includes('HALF_OPEN'), null, { timeout: 12000 });
  await page.getByTestId('recover-service').click();
  await settle();
  await send(4);
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
  await send();
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
  assert(await visualSpeed.isVisible());
  assert(await page.locator('#visual-speed-help').isVisible());
  assert.equal(await visualSpeed.inputValue(), '1');
  await visualSpeed.selectOption('0.25');
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
      const components = [...svg.querySelectorAll('.dial-rim, .contact-lever, .http-winding, .capacitor, .reject-symbol, .socket')]
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
      const controls = [...document.querySelectorAll('.focus-controls button, .focus-controls input, .visual-speed-control select, .focus-button')];
      const clippedToolbar = [...document.querySelectorAll('.live-readout span, .visual-speed-control label, .visual-speed-control select, .focus-button')]
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return !rect.width || !rect.height || rect.left < 0 || rect.right > innerWidth
            || rect.top < 0 || rect.bottom > innerHeight;
        }).map(element => element.textContent);
      return { bounds, page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        clippedToolbar, majors: Math.min(...labels.filter(label => label.major).map(label => label.font)),
        annotations: Math.min(...labels.filter(label => !label.major).map(label => label.font)),
        controls: Math.min(...controls.map(element => parseFloat(getComputedStyle(element).fontSize))),
        clipped, collisions, labelCollisions, pageFits: document.documentElement.scrollHeight <= innerHeight
          && document.documentElement.scrollWidth <= innerWidth };
    });
    console.log(`Focus ${width}: ${JSON.stringify(geometry)}`);
    if (!geometry.pageFits) console.log('Focus overflow diagnostics:', JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll('main, main *')].filter(element => !(element instanceof SVGElement))
        .flatMap(element => {
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height || (rect.bottom <= innerHeight && rect.right <= innerWidth)) return [];
          const style = getComputedStyle(element);
          return [{ tag: element.tagName, class: element.className, top: rect.top, bottom: rect.bottom,
            left: rect.left, right: rect.right, position: style.position, margin: style.margin }];
        }))));
    assert(geometry.majors >= 16, `Focus ${width} major labels must render at least 16px (actual ${geometry.majors.toFixed(2)}px)`);
    assert(geometry.annotations >= 12, `Focus ${width} core annotations must render at least 12px`);
    assert(geometry.controls >= 13, `Focus ${width} minimal controls must render at least 13px`);
    assert(geometry.pageFits, `Focus ${width} must fit the viewport`);
    assert.deepEqual(geometry.clippedToolbar, [], `Focus ${width} helper and controls must remain visible inside the viewport`);
    assert.deepEqual(geometry.clipped, [], `Focus ${width} labels must remain inside the instrument and viewport`);
    assert.deepEqual(geometry.collisions, [], `Focus ${width} labels must not overlap major components`);
    assert.deepEqual(geometry.labelCollisions, [], `Focus ${width} labels must not overlap one another`);
    await page.screenshot({ path: screenshot(`projector-${width}`), fullPage: false });
  }
  await page.screenshot({ path: screenshot('focus'), fullPage: true });
  await send(1, true);
  await assertJourneys([(await snapshot()).histories.at(-1)]);
  results.push('Focus View keeps the visual-only helper and speed selector, and paints a complete quarter-speed journey.');
  await page.keyboard.press('Escape');
  assert.equal(await visualSpeed.inputValue(), '0.25', 'Focus toggles must preserve the selected rate');
  assert(await page.locator('.dock').count());
  assert(await page.getByTestId('focus-toggle').evaluate(element => element === document.activeElement));
  await visualSpeed.selectOption('1');
  await page.getByTestId('inspect-retry').focus();
  await page.keyboard.press('Enter');
  assert((await page.getByTestId('component-inspection').textContent()).includes('Retry feedback'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[data-testid="machine"]')?.getAttribute('data-reduced-motion') === 'true');
  await page.getByRole('button', { name: 'Slow Response', exact: false }).click();
  await settle();
  const reducedBefore = (await snapshot()).histories.map(history => history.requestId);
  await page.getByTestId('send-request').click();
  const identified = await page.waitForFunction(before => {
    const signal = [...document.querySelectorAll('[data-testid="signal"]')].find(signal =>
      !before.includes(signal.dataset.requestId) && signal.dataset.route === 'http' && signal.dataset.attemptId);
    return signal ? { id: signal.dataset.requestId, attempt: signal.dataset.attemptId } : false;
  }, reducedBefore);
  const { id: reducedId, attempt: reducedAttempt } = await identified.jsonValue();
  await identified.dispose();
  assert(!reducedBefore.includes(reducedId), 'Reduced checks must exercise the newly sent request');
  const reducedSignal = page.locator(`[data-testid="signal"][data-request-id="${reducedId}"]`);
  const reducedPosition = () => reducedSignal.evaluate(signal => {
    const circles = [...signal.querySelectorAll('circle')];
    const label = signal.querySelector('text');
    return { route: signal.dataset.route, attempt: signal.dataset.attemptId,
      x: circles[0].getAttribute('cx'), y: circles[0].getAttribute('cy'),
      labelX: label.getAttribute('x'), labelY: label.getAttribute('y'),
      lane: Number(signal.dataset.lane), trails: circles.slice(1).map(circle => getComputedStyle(circle).opacity) };
  });
  const assertReducedPoint = (position, route, x, y) => {
    assert.equal(position.route, route);
    assert.equal(position.x, String(x));
    assert.equal(position.y, String(y));
    assert.equal(position.labelX, String(x));
    assert.equal(position.labelY, String(y - 16 - (position.lane % 10) * 15));
    assert.deepEqual(position.trails, ['0', '0', '0']);
  };
  const staticHead = await reducedPosition();
  assertReducedPoint(staticHead, 'http', 800, 300);
  assert.equal(staticHead.attempt, reducedAttempt);
  await page.waitForTimeout(100);
  assert.deepEqual(await reducedPosition(), staticHead, 'The same new request and attempt must remain static HTTP');
  await page.screenshot({ path: screenshot('reduced-motion'), fullPage: true });
  for (const [route, x, y] of [['wait', 614, 520], ['retry', 552, 300]]) {
    await page.waitForFunction(({ id, route }) => [...document.querySelectorAll('[data-testid="signal"]')]
      .some(signal => signal.dataset.requestId === id && signal.dataset.route === route), { id: reducedId, route });
    assertReducedPoint(await reducedPosition(), route, x, y);
  }
  await completed(reducedBefore, 1);
  await settle();
  const reducedHistory = (await snapshot()).histories.find(history => history.requestId === reducedId);
  assert(reducedHistory);
  await assertJourneys([reducedHistory]);
  await reset();
  results.push('New reduced request keeps the same HTTP attempt at (800,300) for 100ms; WAIT (614,520) and retry (552,300) have aligned labels and zero trails.');
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
