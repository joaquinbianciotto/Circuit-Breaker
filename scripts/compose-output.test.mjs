import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComposeContainers } from './compose-output.mjs';

test('Compose JSON array returns all containers', () => {
  assert.deepEqual(parseComposeContainers('[{"Service":"frontend"},{"Service":"backend"}]'),
    [{ Service: 'frontend' }, { Service: 'backend' }]);
});
test('Compose newline-delimited JSON returns all containers', () => {
  assert.deepEqual(parseComposeContainers('{"Service":"frontend"}\n{"Service":"backend"}\n'),
    [{ Service: 'frontend' }, { Service: 'backend' }]);
});
test('Empty output is an empty set; malformed output fails closed', () => {
  assert.deepEqual(parseComposeContainers(' \n'), []);
  assert.throws(() => parseComposeContainers('{"Service":"frontend"}\nnot-json'));
});
