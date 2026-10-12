import type { Route } from './model';

// Conductors terminate at actual sockets; pulses sample these exact painted paths.
export const CONDUCTORS: Record<Exclude<Route, 'wait'>, string> = {
  inlet: 'M86 300 H310',
  http: 'M410 300 H552 H568 L578 282 L593 318 L608 282 L623 318 L638 282 L653 318 L668 282 L683 318 L698 282 L713 318 L728 282 L743 318 L754 300 H800',
  retry: 'M800 300 V494 Q800 520 774 520 H614 M599 520 H480 V350 H552 V300',
  success: 'M800 300 H852 V236 H974',
  failure: 'M800 300 H852 V386 H974',
  reject: 'M256 300 V612 H974',
};
export const WAIT_POINT = { x: 614, y: 520 };
