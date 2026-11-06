import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchUsageForConnection: vi.fn(),
  getProviderConnections: vi.fn(),
  getTelegramUsageShareSummary: vi.fn(),
  isUsageEligibleConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getTelegramUsageShareSummary: mocks.getTelegramUsageShareSummary,
}));

vi.mock("@/lib/usage/connectionUsage.js", () => ({
  fetchUsageForConnection: mocks.fetchUsageForConnection,
  isUsageEligibleConnection: mocks.isUsageEligibleConnection,
}));

async function loadReportModule() {
  return import("../../src/lib/telegram/report.js");
}

describe("telegram report builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete global.__telegramReportRuntime;

    mocks.isUsageEligibleConnection.mockReturnValue(true);
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "github", name: "alice@example.com", authType: "oauth", isActive: true },
      { id: "c2", provider: "codex", name: "Workspace A", authType: "oauth", isActive: true },
      { id: "c3", provider: "claude", name: "Workspace B", authType: "oauth", isActive: true },
    ]);
    mocks.fetchUsageForConnection
      .mockResolvedValueOnce({
        quotas: {
          chat: { used: 95, total: 100, resetAt: "2026-05-23T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        quotas: {
          chat: { used: 50, total: 100, resetAt: "2026-05-24T00:00:00.000Z" },
        },
      })
      .mockRejectedValueOnce(new Error("provider down"));

    mocks.getTelegramUsageShareSummary.mockResolvedValue({
      period: "Today",
      windowStartLabel: "2026-05-22 00:00:00 Asia/Ho_Chi_Minh",
      windowEndLabel: "2026-05-22 09:30:00 Asia/Ho_Chi_Minh",
      totalTelegramKeys: 12,
      keysWithUsage: 11,
      totalCost: 12.3456,
      totalRequests: 42,
      totalTokens: 1000,
      items: Array.from({ length: 11 }, (_, index) => ({
        cost: index === 0 ? 3.14159 : 0.1234,
        name: `user${index + 1}`,
        telegramUserId: String(index + 1),
        totalTokens: index === 0 ? 300 : 70,
        share: index === 0 ? 0.3 : 0.07,
        models: index === 0 ? ["cx/gpt-5.4", "ds/deepseek-v4-flash"] : ["cx/gpt-5.4-mini"],
      })),
    });
  });

  it("builds an HTML-safe report with bold quota and usage headings", async () => {
    const { buildTelegramReport } = await loadReportModule();
    const report = await buildTelegramReport("today", new Date("2026-05-22T02:30:00.000Z"));

    expect(report).toContain("<b>Quota Remaining Today</b>:");
    expect(report).toContain("- github / alice@example.com: 5%");
    expect(report).toContain("- codex / Workspace A: 50%");
    expect(report).toContain("<b>Key usage (Today)</b>:");
    expect(report).toContain("user1: 300 tokens - cx/gpt-5.4, ds/deepseek-v4-flash");
    expect(report).toContain("user11: 70 tokens - cx/gpt-5.4-mini");
    expect(report).not.toContain("$");
    expect(report).not.toContain("Model:");
    expect(report).not.toContain("As of:");
    expect(report).not.toContain("Window:");
  });

  it("coalesces concurrent quota snapshot fetches", async () => {
    let resolveFetch;
    mocks.fetchUsageForConnection.mockReset();
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "github", name: "alice@example.com", authType: "oauth", isActive: true },
    ]);
    mocks.getTelegramUsageShareSummary.mockResolvedValue({
      period: "Today",
      totalCost: 0,
      totalTelegramKeys: 1,
      keysWithUsage: 0,
      totalRequests: 0,
      totalTokens: 0,
      items: [],
    });
    mocks.fetchUsageForConnection.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { buildTelegramReport } = await loadReportModule();
    const promiseA = buildTelegramReport("today", new Date("2026-05-22T02:30:00.000Z"));
    const promiseB = buildTelegramReport("7d", new Date("2026-05-22T02:30:00.000Z"));

    await Promise.resolve();
    await Promise.resolve();

    resolveFetch({
      quotas: {
        chat: { used: 25, total: 100, resetAt: "2026-05-23T00:00:00.000Z" },
      },
    });

    await Promise.all([promiseA, promiseB]);

    expect(mocks.fetchUsageForConnection).toHaveBeenCalledTimes(1);
    expect(mocks.getTelegramUsageShareSummary).toHaveBeenCalledTimes(2);
  });

  it("returns usage after a quota provider times out", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchUsageForConnection.mockReset();
      mocks.getProviderConnections.mockResolvedValue([
        { id: "c1", provider: "codex", name: "Slow account", authType: "oauth", isActive: true },
      ]);
      mocks.fetchUsageForConnection.mockReturnValue(new Promise(() => {}));

      const { buildTelegramReport, __test__ } = await loadReportModule();
      const reportPromise = buildTelegramReport("today", new Date("2026-05-22T02:30:00.000Z"));

      await vi.advanceTimersByTimeAsync(__test__.QUOTA_FETCH_TIMEOUT_MS);
      const report = await reportPromise;

      expect(report).toContain("<b>Quota Remaining Today</b>: unavailable");
      expect(report).toContain("<b>Key usage (Today)</b>:");
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats single-account quota as one compact line", async () => {
    const { __test__ } = await loadReportModule();
    expect(__test__.buildQuotaLine({
      lowest: [
        { remaining: 57, quotaName: "weekly", resetIn: "4d 15h 7m" },
      ],
    })).toBe("<b>Quota Remaining Today</b>: 57% (weekly, reset 4d 15h 7m)");
  });

  it("marks aggregated and incomplete usage without exposing source paths", async () => {
    const { __test__ } = await loadReportModule();
    const text = __test__.buildUsageLines({
      period: "Today", sourceCount: 4, unavailableSources: 1, items: [],
    }).join("\n");
    expect(text).toContain("Tổng hợp 4 instance.");
    expect(text).toContain("1 nguồn chưa đọc được");
    expect(text).toContain("số liệu chưa đầy đủ");
  });

  it("escapes model labels and handles history without model metadata", async () => {
    const { __test__ } = await loadReportModule();
    const text = __test__.buildUsageLines({
      period: "Today",
      items: [
        { name: "<alice>", totalTokens: 1, share: 0.5, models: ["cx/<model>&test"] },
        { name: "bob", totalTokens: 1, share: 0.5 },
      ],
    }).join("\n");
    expect(text).toContain("&lt;alice&gt;: 1 tokens - cx/&lt;model&gt;&amp;test");
    expect(text).toContain("bob: 1 tokens - unknown");
    expect(text).not.toContain("<model>");
  });

  it.each(["Today", "7D"])("shows only tokens and models per user for %s", async (period) => {
    const { __test__ } = await loadReportModule();
    expect(__test__.buildUsageLines({
      period,
      items: [{
        name: "nhatanhdh", totalTokens: 181192408, share: 0.218, cost: 2.52,
        models: ["cx/gpt-6-luna"],
      }],
    })).toEqual([
      `<b>Key usage (${period})</b>:`,
      "nhatanhdh: 181,192,408 tokens - cx/gpt-6-luna",
    ]);
  });

  it("adjusts weekly quota by remaining workday budget and buffer", async () => {
    const { __test__ } = await loadReportModule();
    expect(__test__.countFutureVietnamBusinessDays(
      "2026-05-27T01:14:00.000Z",
      new Date("2026-05-22T09:30:00.000Z"),
    )).toBe(2);

    expect(__test__.getAdjustedWorkdayQuotaRemaining(
      52,
      "weekly",
      "2026-05-27T01:14:00.000Z",
      new Date("2026-05-22T09:30:00.000Z"),
    )).toEqual({
      remaining: 50,
      isAdjusted: true,
    });
  });

  it("shows adjusted workday quota line without buffer explanation", async () => {
    const { __test__ } = await loadReportModule();
    expect(__test__.buildQuotaLine({
      lowest: [
        { remaining: 50, quotaName: "weekly", isAdjusted: true },
      ],
    })).toBe("<b>Quota Remaining Today</b>: 50%");
  });
});
