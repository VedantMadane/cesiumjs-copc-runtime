import { describe, expect, it } from "vitest";
import { RequestQueue } from "./request-queue.js";

describe("RequestQueue", () => {
  it("orders pending work by priority while respecting concurrency", async () => {
    const queue = new RequestQueue(1);
    const order: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.add(async () => {
      await blocker;
      order.push("first");
    });
    const low = queue.add(
      async () => {
        order.push("low");
      },
      { priority: 1 },
    );
    const high = queue.add(
      async () => {
        order.push("high");
      },
      { priority: 10 },
    );
    release();
    await Promise.all([first, low, high]);
    expect(order).toEqual(["first", "high", "low"]);
  });

  it("aborts active work when destroyed", async () => {
    const queue = new RequestQueue(1);
    const request = queue.add(
      async (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    queue.destroy();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reprioritizes pending keyed work", async () => {
    const queue = new RequestQueue(1);
    const order: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.add(async () => {
      await blocker;
    });
    const left = queue.add(
      async () => {
        order.push("left");
      },
      { key: "left", priority: 2 },
    );
    const center = queue.add(
      async () => {
        order.push("center");
      },
      { key: "center", priority: 1 },
    );

    expect(queue.reprioritize("center", 10)).toBe(true);
    expect(queue.reprioritize("missing", 10)).toBe(false);
    release();
    await Promise.all([first, left, center]);
    expect(order).toEqual(["center", "left"]);
  });
});
