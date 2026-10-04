/** Lets the readiness-reset notice ignore changes the user just made themselves. */
let lastSelfChange = 0;

export function noteSelfReadyChange(): void {
  lastSelfChange = Date.now();
}

export function readyChangedBySelfRecently(ms = 8000): boolean {
  return Date.now() - lastSelfChange < ms;
}
