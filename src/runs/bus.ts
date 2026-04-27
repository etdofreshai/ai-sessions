import type { RunEvent } from "./types.js";

// Async-iterable bus for streaming RunEvents from producer to one consumer.
// Backpressure-naive: events are buffered if no consumer is awaiting.
export class EventBus {
  private waiters: Array<(e: RunEvent | null) => void> = [];
  private buffer: RunEvent[] = [];
  private done = false;

  push(e: RunEvent): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w(e);
    else this.buffer.push(e);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length) this.waiters.shift()!(null);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<RunEvent, void> {
    while (true) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.done) return;
      const e = await new Promise<RunEvent | null>((r) => this.waiters.push(r));
      if (e === null) return;
      yield e;
    }
  }
}
