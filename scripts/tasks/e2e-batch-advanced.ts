import { task, types } from "hardhat/config";

/**
 * Run the advanced 10-user batch E2E with optional configurable sample borrower index.
 *
 * Example:
 *   npx hardhat e2e:batch-advanced --network localhost --sample-borrower-index 2
 */
task("e2e:batch-advanced", "Advanced batch E2E (10 users) with PositionView/UserView assertions")
  .addOptionalParam(
    "sampleBorrowerIndex",
    "Which borrower index (0-4) to print PositionView version for",
    0,
    types.int
  )
  .setAction(async (args) => {
    const { runAdvancedBatch } = await import("../e2e/e2e-localhost-batch-advanced-10-users");
    await runAdvancedBatch({ sampleBorrowerIndex: args.sampleBorrowerIndex });
  });


