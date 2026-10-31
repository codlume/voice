type Signalled = { signal: AbortSignal };

/**
 * Transforms go first on the one loaded model. A Transform aborts the generate step that is
 * running, such as a meeting summary step, and the step runs again from the start once no
 * Transform is waiting. So a Transform waits only as long as the model takes to stop a step, not
 * for the step to finish. Steps must be safe to repeat.
 */
export function transformsFirst<T extends Signalled, TR, G extends Signalled, GR>(
  transform: (request: T) => Promise<TR>,
  generate: (request: G) => Promise<GR>,
): { transform: (request: T) => Promise<TR>; generate: (request: G) => Promise<GR> } {
  const steps = new Set<AbortController>();
  let transforms = 0;
  let idle: Promise<void> = Promise.resolve();
  let release: (() => void) | undefined;

  return {
    async transform(request) {
      if (transforms++ === 0) idle = new Promise((resolve) => (release = resolve));
      for (const step of steps) step.abort(new Error("A Transform went first"));
      try {
        return await transform(request);
      } finally {
        if (--transforms === 0) release?.();
      }
    },

    async generate(request) {
      for (;;) {
        if (transforms > 0) {
          await untilAborted(idle, request.signal);
          continue;
        }
        request.signal.throwIfAborted();
        const step = new AbortController();
        steps.add(step);
        try {
          return await generate({
            ...request,
            signal: AbortSignal.any([request.signal, step.signal]),
          });
        } catch (error) {
          if (!step.signal.aborted || request.signal.aborted) throw error;
        } finally {
          steps.delete(step);
        }
      }
    },
  };
}

function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}
