import { describe, expect, it } from "vitest";
import { __test__ } from "@/lib/telegram/usageLimits.js";

describe("Telegram usage limits", () => {
  it("allows usage below the new daily limits, including above the old limits", () => {
    const limits = __test__.getEffectiveHardLimits();
    expect(limits).toEqual({ hardCostUsd: 1000, hardTokens: 600_000_000 });
    expect(__test__.isHardLimitReached({ totalCost: 710, totalTokens: 310_000_000 }, limits)).toBe(false);
    expect(__test__.isHardLimitReached({ totalCost: 999.99, totalTokens: 599_999_999 }, limits)).toBe(false);
  });

  it.each([
    { totalCost: 1000, totalTokens: 0 },
    { totalCost: 0, totalTokens: 600_000_000 },
  ])("temporarily disables when either daily limit is reached: %j", (totals) => {
    expect(__test__.isHardLimitReached(totals, __test__.getEffectiveHardLimits())).toBe(true);
  });

  it("does not let an older manual-clear override lower the new limits", () => {
    expect(__test__.getEffectiveHardLimits({ hardCostUsd: 800, hardTokens: 400_000_000 }))
      .toEqual({ hardCostUsd: 1000, hardTokens: 600_000_000 });
  });

  it("keeps warning thresholds unchanged and announces the new limits", () => {
    expect(__test__.WARNING_COST_USD).toBe(400);
    expect(__test__.WARNING_TOKENS).toBe(180_000_000);
    const key = { name: "test-user" };
    for (const message of [
      __test__.buildManualWarningMessage(key),
      __test__.buildWarningMessage(key, { totalCost: 400, totalTokens: 180_000_000 }),
    ]) {
      expect(message).toContain("$1000.00");
      expect(message).toContain("600,000,000 token");
    }
  });

  it("raises today's hard limit after manual clear so the next request is not disabled immediately", () => {
    const totals = { totalCost: 1010, totalTokens: 610_000_000 };
    expect(__test__.isHardLimitReached(totals, __test__.getEffectiveHardLimits())).toBe(true);

    const hardLimits = __test__.getEffectiveHardLimits({
      hardCostUsd: totals.totalCost + __test__.MANUAL_CLEAR_EXTRA_COST_USD,
      hardTokens: totals.totalTokens + __test__.MANUAL_CLEAR_EXTRA_TOKENS,
    });

    expect(__test__.isHardLimitReached(totals, hardLimits)).toBe(false);
    expect(__test__.isHardLimitReached({
      totalCost: hardLimits.hardCostUsd,
      totalTokens: totals.totalTokens,
    }, hardLimits)).toBe(true);
  });
});
