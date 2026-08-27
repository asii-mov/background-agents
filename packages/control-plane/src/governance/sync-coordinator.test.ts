import { describe, expect, it, vi } from "vitest";
import { GovernanceSyncCoordinator } from "./sync-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("GovernanceSyncCoordinator", () => {
  it("coalesces concurrent publication attempts", async () => {
    const pending = deferred<string>();
    const task = vi.fn(() => pending.promise);
    const coordinator = new GovernanceSyncCoordinator<string>();

    const first = coordinator.run(task);
    const second = coordinator.run(task);
    pending.resolve("published");

    await expect(Promise.all([first, second])).resolves.toEqual(["published", "published"]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("allows a clean retry after failure", async () => {
    const coordinator = new GovernanceSyncCoordinator<string>();
    await expect(coordinator.run(async () => Promise.reject(new Error("failed")))).rejects.toThrow(
      "failed"
    );
    await expect(coordinator.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
