export type DeviceTier = "low" | "medium" | "high";

export interface DeviceProbe {
  readonly memoryGigabytes?: number;
  readonly hardwareConcurrency?: number;
  readonly mobile?: boolean;
  readonly devicePixelRatio?: number;
}

export interface DeviceBudget {
  readonly pointBudget: number;
  readonly maximumScreenSpaceError: number;
  readonly cacheSize: number;
  readonly workerCount: number;
  readonly requestConcurrency: number;
}

const BUDGETS: Readonly<Record<DeviceTier, DeviceBudget>> = {
  low: {
    pointBudget: 1_000_000,
    maximumScreenSpaceError: 4,
    cacheSize: 256 * 1024 * 1024,
    workerCount: 1,
    requestConcurrency: 4,
  },
  medium: {
    pointBudget: 2_000_000,
    maximumScreenSpaceError: 2,
    cacheSize: 512 * 1024 * 1024,
    workerCount: 2,
    requestConcurrency: 8,
  },
  high: {
    pointBudget: 6_000_000,
    maximumScreenSpaceError: 1.5,
    cacheSize: 1024 * 1024 * 1024,
    workerCount: 4,
    requestConcurrency: 12,
  },
};

export function classifyDevice(probe: DeviceProbe = probeDevice()): DeviceTier {
  if (probe.mobile === true) return "low";
  const memory = probe.memoryGigabytes;
  const cores = probe.hardwareConcurrency;
  const pixelRatio = probe.devicePixelRatio ?? 1;
  if (
    (memory !== undefined && memory <= 4) ||
    (cores !== undefined && cores <= 4) ||
    pixelRatio >= 3
  ) {
    return "low";
  }
  if (memory !== undefined && memory >= 8 && cores !== undefined && cores >= 8) return "high";
  return "medium";
}

export function budgetFor(tier: DeviceTier): DeviceBudget {
  return BUDGETS[tier];
}

export function probeDevice(): DeviceProbe {
  if (typeof navigator === "undefined") return {};
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return {
    ...(memory === undefined ? {} : { memoryGigabytes: memory }),
    hardwareConcurrency: navigator.hardwareConcurrency,
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
    devicePixelRatio:
      typeof globalThis.devicePixelRatio === "number" ? globalThis.devicePixelRatio : 1,
  };
}
