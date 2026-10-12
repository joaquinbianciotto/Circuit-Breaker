import type { ExternalConfig } from '@resilience/contracts';

export interface DemoActions {
  reset: () => Promise<void>;
  configure: (config: Partial<ExternalConfig>) => Promise<void>;
  send: () => Promise<void>;
  waitForProbe: (signal: AbortSignal) => Promise<void>;
  stage: (label: string) => void;
}
/** Every step changes the real lab. Stop only prevents future actions. */
export async function runDemo(actions: DemoActions, signal: AbortSignal) {
  const step = async (label: string, action: () => Promise<void>) => {
    signal.throwIfAborted();
    actions.stage(label);
    await action();
    signal.throwIfAborted();
  };
  await step('01 / Restore defaults', actions.reset);
  await step('02 / Normal response', () => actions.configure({ mode: 'normal', latencyMs: 260 }));
  await step('02 / Admit one operation', actions.send);
  await step('03 / Timeout & bounded retries', () => actions.configure({ mode: 'slow', latencyMs: 1500 }));
  await step('03 / Observe HTTP aborts', actions.send);
  await step('04 / Clear the completed baseline', actions.reset);
  await step('04 / Force 503 failures', () => actions.configure({ mode: 'fail', errorStatus: 503, latencyMs: 220 }));
  for (let i = 1; i <= 4; i++) await step(`04 / Logical failure ${i} of 4`, actions.send);
  await step('05 / OPEN admission rejection', actions.send);
  await step('06 / Wait for actual HALF_OPEN event', () => actions.waitForProbe(signal));
  await step('06 / Recover the upstream', () => actions.configure({ mode: 'normal', latencyMs: 260 }));
  await step('06 / Exclusive recovery probe', actions.send);
  await step('07 / Alternating failure / retry', () => actions.configure({ mode: 'intermittent', intermittent: 'alternating', latencyMs: 240 }));
  await step('07 / Retry the same logical operation', actions.send);
  actions.stage('Complete / All outcomes came from real HTTP');
}
