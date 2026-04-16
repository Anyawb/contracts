import { expect } from "chai";

import {
  waitForFreshOrderReadRecovery,
} from "../../scripts/tests/live-test/networks/bnb-testnet/core/_fundsFlowLive";

describe("funds flow live order bridge convergence helper", function () {
  it("retries transient fresh-order unreadable windows and accepts later recovery", async function () {
    let attempts = 0;
    let now = 0;

    await waitForFreshOrderReadRecovery({
      sourceLabel: "finalizeMatch",
      orderId: 745n,
      timeoutMs: 50,
      pollMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      probe: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(
            "[SSOT_DEPLOYMENT_MISMATCH][ORDER_ENGINE_VIEW_ADAPTER_DIVERGENCE] transient fresh-order unreadable window",
          );
        }
      },
    });

    expect(attempts).to.equal(3);
  });

  it("fails fast on non-retryable probe errors", async function () {
    const expected = new Error("non-retryable business failure");

    try {
      await waitForFreshOrderReadRecovery({
        sourceLabel: "repay",
        orderId: 1n,
        timeoutMs: 50,
        pollMs: 10,
        now: () => 0,
        sleep: async () => undefined,
        probe: async () => {
          throw expected;
        },
      });
      expect.fail("expected waitForFreshOrderReadRecovery to reject");
    } catch (error: any) {
      expect(String(error?.message ?? error)).to.contain("non-retryable business failure");
    }
  });
});