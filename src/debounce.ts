// Debounce: coalesce a burst of calls into one trailing invocation (e2e fixture).
export function debounce<A extends unknown[]>(fn: (...a: A) => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A;
  return (...args: A): void => {
    lastArgs = args;
    // Reset the timer on every call so only a quiet gap of waitMs actually fires fn.
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...lastArgs);
    }, waitMs);
  };
}
