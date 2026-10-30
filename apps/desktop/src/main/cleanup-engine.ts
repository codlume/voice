import type { S1Mini } from "@voice/cleanup";
import { LAYOUTS, WRITING_STYLES } from "@voice/cleanup/style";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createEngineProcess,
  serveEngine,
  type ForkEngine,
  type ParentPort,
} from "./engine-process.ts";

export type CleanupEngine = Pick<S1Mini, "load" | "clean" | "keepGpuBusy" | "dispose">;

const CleanSchema = Schema.Struct({
  type: Schema.Literal("clean"),
  id: Schema.Int,
  raw: Schema.String,
  style: Schema.Struct({
    style: Schema.Literals(WRITING_STYLES),
    layout: Schema.Literals(LAYOUTS),
  }),
  budgetMs: Schema.optionalKey(Schema.Finite),
});
const KeepGpuBusySchema = Schema.Struct({ type: Schema.Literal("keepGpuBusy"), ms: Schema.Finite });
const ResultSchema = Schema.Struct({
  text: Schema.String,
  chunks: Schema.Finite,
  cleaned: Schema.Finite,
  queueMs: Schema.Finite,
  generateMs: Schema.Finite,
});

const decodeClean = Schema.decodeUnknownOption(CleanSchema);
const decodeKeepGpuBusy = Schema.decodeUnknownOption(KeepGpuBusySchema);

export function serve(
  port: ParentPort,
  createEngine: (options: { modelPath: string }) => CleanupEngine,
) {
  serveEngine(port, {
    name: "cleanup model",
    create: createEngine,
    decodeWork: decodeClean,
    work: (engine, { type: _type, id: _id, raw, style, ...budget }, signal) =>
      engine.clean(raw, style, { ...budget, signal }),
    notify: (engine, data) => {
      const notice = Option.getOrUndefined(decodeKeepGpuBusy(data));
      if (notice) engine?.keepGpuBusy(notice.ms);
    },
  });
}

export function createS1MiniProcess({
  modelPath,
  fork,
  onLost,
}: {
  modelPath: string;
  fork: ForkEngine;
  onLost: (message: string) => void;
}): CleanupEngine {
  const engine = createEngineProcess<
    typeof CleanSchema.Type,
    typeof ResultSchema.Type,
    typeof KeepGpuBusySchema.Type
  >({
    name: "cleanup model",
    modelPath,
    fork,
    decodeResult: Schema.decodeUnknownOption(ResultSchema),
    onLost,
  });

  return {
    load: engine.load,
    keepGpuBusy: (ms) => engine.post({ type: "keepGpuBusy", ms }),
    clean: (raw, style, { signal, ...budget } = {}) =>
      engine.run((id) => ({ type: "clean", id, raw, style, ...budget }), signal),
    dispose: engine.dispose,
  };
}
