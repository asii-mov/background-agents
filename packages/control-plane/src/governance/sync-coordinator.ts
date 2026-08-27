/** Coalesces concurrent reconciliation requests into one publication attempt. */
export class GovernanceSyncCoordinator<T> {
  private active: Promise<T> | null = null;

  run(task: () => Promise<T>): Promise<T> {
    if (this.active) return this.active;
    const active = task().finally(() => {
      if (this.active === active) this.active = null;
    });
    this.active = active;
    return active;
  }
}
