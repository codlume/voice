import { Worker } from "node:worker_threads";
import { decodeWorkerEvent, type WorkerRequest } from "@voice/contracts/worker";
import type { Settings, Status } from "@voice/contracts/desktop";

export class StorageWorker {
  state: Status["storage"] = "starting";
  worker: Worker | undefined;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (settings: Settings | undefined) => void; reject: (error: Error) => void }
  >();
  private opening: Promise<Settings> | undefined;
  constructor(
    private readonly options: { entry: string; filename: string; migrations: string },
    private readonly changed: () => void,
  ) {}

  start(): Promise<Settings> {
    if (this.opening) return this.opening;
    this.state = "starting";
    this.changed();
    const worker = new Worker(this.options.entry, {
      workerData: { filename: this.options.filename, migrations: this.options.migrations },
    });
    this.worker = worker;
    this.opening = new Promise<Settings>((resolve, reject) => {
      const timeout = setTimeout(() => fail(), 15_000);
      const fail = () => {
        clearTimeout(timeout);
        if (this.worker !== worker) return;
        this.state = "failed";
        const error = new Error("Settings storage unavailable");
        reject(error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        this.changed();
      };
      worker.on("message", (payload: unknown) => {
        if (this.worker !== worker) return;
        try {
          const event = decodeWorkerEvent(payload);
          if (event.type === "ready") {
            clearTimeout(timeout);
            this.state = "ready";
            resolve(event.settings);
            this.changed();
          } else if (event.type === "failed") {
            fail();
          } else {
            const pending = this.pending.get(event.id);
            this.pending.delete(event.id);
            pending?.resolve(event.type === "result" ? event.settings : undefined);
          }
        } catch {
          fail();
        }
      });
      worker.once("error", fail);
      worker.once("exit", fail);
    });
    return this.opening;
  }

  private request(request: WorkerRequest) {
    const worker = this.worker;
    if (!worker || this.state !== "ready")
      return Promise.reject(new Error("Settings storage unavailable"));
    return new Promise<Settings | undefined>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      worker.postMessage(request);
    });
  }
  async set(settings: Settings) {
    const result = await this.request({ id: ++this.nextId, type: "set", settings });
    if (!result) throw new Error("Missing settings result");
    return result;
  }
  async close() {
    const worker = this.worker;
    if (!worker) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.state === "ready")
        await Promise.race([
          this.request({ id: ++this.nextId, type: "close" }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          }),
        ]);
    } finally {
      clearTimeout(timer);
      this.worker = undefined;
      this.opening = undefined;
      for (const request of this.pending.values()) request.reject(new Error("Storage closed"));
      this.pending.clear();
      await worker.terminate();
    }
  }
  async restart() {
    await this.close();
    return this.start();
  }
}
