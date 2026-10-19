import { describe, expect, it } from "vitest";
// Exercise the published dependency, not a copy of its algorithm. These internal
// test seams intentionally track the exactly pinned SDK release.
import { RecorrectionMonitor } from "../node_modules/@sendspin/sendspin-js/dist/audio/recorrection-monitor.js";
import { AudioScheduler } from "../node_modules/@sendspin/sendspin-js/dist/audio/scheduler.js";
import { StateManager } from "../node_modules/@sendspin/sendspin-js/dist/core/state-manager.js";
import { SendspinTimeFilter } from "../node_modules/@sendspin/sendspin-js/dist/core/time-filter.js";

function firstCorrection(errors: number[]): number | undefined {
  const monitor = new RecorrectionMonitor(() => {});
  for (const [index, error] of errors.entries()) {
    if (monitor.shouldRecorrect(Math.abs(error), error, 1000 + index * 250)) {
      return index * 250;
    }
  }
}

describe("installed SDK drift correction", () => {
  it.each([1, -1])(
    "recorrects sustained drift in direction %s within one second",
    (sign) => {
      // PR #117: each >25ms jump used to restart transient suppression forever.
      const errors = Array.from({ length: 9 }, (_, index) => sign * index * 30);
      expect(firstCorrection(errors)).toBeLessThanOrEqual(1000);
    },
  );

  it("recorrects sustained same-side transient jitter within one second", () => {
    // PR #122: alternating jumps must not hide a persistent positive breach.
    expect(firstCorrection([60, 100, 60, 100, 60])).toBeLessThanOrEqual(1000);
  });

  it("does not resync for large zero-crossing oscillations", () => {
    // PR #118: the scheduler passes abs(signed EWMA), not EWMA(abs(error)).
    const monitor = new RecorrectionMonitor(() => {});
    const scheduler = new AudioScheduler({
      stateManager: new StateManager(),
      timeFilter: new SendspinTimeFilter(0, 1.1, 2, 1e-12),
    }) as unknown as { applySyncErrorEma(error: number): number };
    for (let index = 0; index < 80; index++) {
      const raw = index % 2 === 0 ? 80 : -80;
      const smoothed = scheduler.applySyncErrorEma(raw);
      expect(
        monitor.shouldRecorrect(Math.abs(smoothed), raw, 1000 + index * 250),
      ).toBe(false);
    }
  });

  it("ignores an isolated spike and enforces cooldown after a real correction", () => {
    expect(firstCorrection([0, 80, 0, 0, 0, 0])).toBeUndefined();
    const monitor = new RecorrectionMonitor(() => {});
    expect(monitor.shouldRecorrect(60, 60, 1000)).toBe(false);
    expect(monitor.shouldRecorrect(60, 60, 1500)).toBe(true);
    monitor.markRecorrection(1500);
    monitor.clearBreachState();
    expect(monitor.shouldRecorrect(60, 60, 1750)).toBe(false);
    expect(monitor.shouldRecorrect(60, 60, 2250)).toBe(false);
    expect(monitor.shouldRecorrect(60, 60, 3000)).toBe(true);
  });
});
