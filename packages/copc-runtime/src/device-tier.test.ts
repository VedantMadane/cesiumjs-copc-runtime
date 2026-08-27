import { describe, expect, it } from "vitest";
import { budgetFor, classifyDevice } from "./device-tier.js";

describe("device tiers", () => {
  it("uses medium defaults when capability signals are unavailable", () => {
    expect(classifyDevice({})).toBe("medium");
  });

  it("keeps mobile and constrained devices on the low tier", () => {
    expect(classifyDevice({ mobile: true, memoryGigabytes: 16, hardwareConcurrency: 12 })).toBe("low");
    expect(classifyDevice({ memoryGigabytes: 4, hardwareConcurrency: 8 })).toBe("low");
  });

  it("selects high only with both memory and CPU evidence", () => {
    expect(classifyDevice({ memoryGigabytes: 8, hardwareConcurrency: 8 })).toBe("high");
    expect(classifyDevice({ memoryGigabytes: 8 })).toBe("medium");
  });

  it("assigns increasing budgets", () => {
    expect(budgetFor("low").pointBudget).toBeLessThan(budgetFor("medium").pointBudget);
    expect(budgetFor("medium").pointBudget).toBeLessThan(budgetFor("high").pointBudget);
  });
});
