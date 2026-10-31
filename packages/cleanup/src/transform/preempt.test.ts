import { expect, test } from "vite-plus/test";

import { transformsFirst } from "./preempt.ts";

type Request = { name: string; signal: AbortSignal };

/** One model, one call at a time, like the engine: a step stops when its signal aborts. */
function fakeModel() {
  const log: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const steps = new Map<string, () => void>();
  const serialize = <T>(task: () => Promise<T>) => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const model = transformsFirst(
    (request: Request) =>
      serialize(async () => {
        log.push(`transform ${request.name}`);
        return request.name;
      }),
    (request: Request) =>
      serialize(
        () =>
          new Promise<string>((resolve, reject) => {
            log.push(`step ${request.name}`);
            request.signal.throwIfAborted();
            steps.set(request.name, () => resolve(request.name));
            request.signal.addEventListener("abort", () => {
              log.push(`stopped ${request.name}`);
              steps.delete(request.name);
              reject(request.signal.reason);
            });
          }),
      ),
  );
  const finish = async (name: string) => {
    for (let tries = 0; !steps.has(name) && tries < 50; tries++) await Promise.resolve();
    steps.get(name)!();
    steps.delete(name);
  };
  return { model, log, finish };
}

const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a Transform stops the running step, goes first, and the step runs again after it", async () => {
  const { model, log, finish } = fakeModel();
  const step = model.generate({ name: "part 1", signal: signal() });
  await tick();

  expect(await model.transform({ name: "dictation", signal: signal() })).toBe("dictation");
  await finish("part 1");

  expect(await step).toBe("part 1");
  expect(log).toEqual(["step part 1", "stopped part 1", "transform dictation", "step part 1"]);
});

test("a step asked for while a Transform runs waits for it, and for any Transform after it", async () => {
  const { model, log, finish } = fakeModel();
  const first = model.transform({ name: "a", signal: signal() });
  const step = model.generate({ name: "part 1", signal: signal() });
  const second = model.transform({ name: "b", signal: signal() });
  await Promise.all([first, second]);
  await finish("part 1");

  expect(await step).toBe("part 1");
  expect(log).toEqual(["transform a", "transform b", "step part 1"]);
});

test("the caller's abort still rejects with its reason, waiting or running", async () => {
  const { model } = fakeModel();
  const running = new AbortController();
  const step = model.generate({ name: "part 1", signal: running.signal });
  await tick();
  running.abort(new Error("Meeting deleted"));
  await expect(step).rejects.toThrow("Meeting deleted");

  const waiting = new AbortController();
  const transform = model.transform({ name: "dictation", signal: signal() });
  const queued = model.generate({ name: "part 2", signal: waiting.signal });
  waiting.abort(new Error("Voice is closing"));
  await expect(queued).rejects.toThrow("Voice is closing");
  await transform;
});
