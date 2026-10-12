import { describe, expect, it } from 'vitest';
import { runDemo, type DemoActions } from '../src/demo';

function harness() {
  const calls: string[] = [];
  const actions: DemoActions = {
    reset: async () => { calls.push('reset'); },
    configure: async config => { calls.push(`config:${config.mode}`); },
    send: async () => { calls.push('send'); },
    waitForProbe: async () => { calls.push('wait:HALF_OPEN'); },
    stage: () => {},
  };
  return { calls, actions };
}
describe('real sequential demo orchestration', () => {
  it('waits for the authoritative probe before recovery and isolates four logical failures', async () => {
    const { calls, actions } = harness();
    await runDemo(actions, new AbortController().signal);
    expect(calls).toEqual(['reset', 'config:normal', 'send', 'config:slow', 'send',
      'reset', 'config:fail', 'send', 'send', 'send', 'send', 'send',
      'wait:HALF_OPEN', 'config:normal', 'send', 'config:intermittent', 'send']);
  });
  it('stop does not cancel an admitted send and prevents every future management/send action', async () => {
    const { calls, actions } = harness();
    const controller = new AbortController();
    let completed = false;
    actions.send = async () => { calls.push('send'); controller.abort(); await Promise.resolve(); completed = true; };
    await expect(runDemo(actions, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(completed).toBe(true);
    expect(calls).toEqual(['reset', 'config:normal', 'send']);
  });
  it('halts after a management conflict rather than fabricating scenario progress', async () => {
    const { calls, actions } = harness();
    actions.configure = async () => { throw new Error('409 busy'); };
    await expect(runDemo(actions, new AbortController().signal)).rejects.toThrow('409 busy');
    expect(calls).toEqual(['reset']);
  });
});
