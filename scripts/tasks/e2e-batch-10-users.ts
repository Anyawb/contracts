import { task, types } from "hardhat/config";

/**
 * Run the basic 10-user batch E2E with optional configurable sample borrower index.
 *
 * Example:
 *   npx hardhat e2e:batch-10-users --network localhost --sample-borrower-index 2
 */
task("e2e:batch-10-users", "Basic batch E2E (10 users) with StatisticsView + PositionView version logging")
  .addOptionalParam(
    "sampleBorrowerIndex",
    "Which borrower index (0-4) to print PositionView version for",
    0,
    types.int
  )
  .setAction(async (args) => {
    const { runBatch10Users } = await import("../e2e/e2e-localhost-batch-10-users");
    await runBatch10Users({ sampleBorrowerIndex: args.sampleBorrowerIndex });
  });


