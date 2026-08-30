import type { ResolvedHarness, WorkerDriver } from "@symphony/protocol";

export class DriverRegistry {
  private readonly drivers = new Map<ResolvedHarness, WorkerDriver>();

  register(driver: WorkerDriver): void {
    if (this.drivers.has(driver.id)) throw new Error(`Driver already registered: ${driver.id}`);
    this.drivers.set(driver.id, driver);
  }

  get(id: ResolvedHarness): WorkerDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new Error(`Driver is not configured: ${id}`);
    return driver;
  }

  has(id: ResolvedHarness): boolean {
    return this.drivers.has(id);
  }

  list(): WorkerDriver[] {
    return [...this.drivers.values()];
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.list().map((driver) => driver.dispose?.()));
  }
}
