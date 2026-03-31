const seedCase = [
  "seed-mock-asset-prices",
  "pnpm -s exec hardhat run scripts/deploy/seed-mock-asset-prices.ts --network arbitrumSepolia",
];

const liquidationSeedCase = [
  "seed-liquidatable-order-arbitrum-sepolia",
  "pnpm -s exec hardhat run scripts/tests/live-test/seed-liquidatable-order-arbitrum-sepolia.ts --network arbitrumSepolia",
];

const seededLiquidationCaseLabels = [
  "live-liquidation-arbitrum-sepolia",
  "live-liquidation-fallback-arbitrum-sepolia",
];

const liveTestCases = [
  ["live-ignite-minimal-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-ignite-minimal-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-read-pressure", "pnpm -s exec hardhat run scripts/tests/live-test/live-read-pressure.ts --network arbitrumSepolia"],
  ["live-view-registry-routes-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-view-registry-routes-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-liquidation-registry-preflight-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-liquidation-registry-preflight-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-view-facade-consistency-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-view-facade-consistency-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-prime-viewcache-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-prime-viewcache-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-platform-baseline-arbitrum-sepolia", "pnpm -s run test:live:platform-baseline:arbitrum-sepolia"],
  ["live-fee-accounting-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-fee-accounting-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-view-consistency-gate-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-view-consistency-gate-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-view-facade-gate-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-view-facade-gate-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-warmup-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["test__smoke__multi-stablecoin__arbitrum-sepolia-live", "pnpm -s run test:smoke:multi-stablecoin:arbitrum-sepolia-live"],
  ["live-cancel-reserve-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-cancel-reserve-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-withdraw-collateral-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-withdraw-collateral-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-guarantee-flow-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-guarantee-flow-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-blocks-only-liquidation-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-blocks-only-liquidation-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-liquidation-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-liquidation-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-liquidation-fallback-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-liquidation-fallback-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-liquidation-view-assertions-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-liquidation-view-assertions-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-fee-prepaid-gate-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-fee-prepaid-gate-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-fee-remaining-gate-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-fee-remaining-gate-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-fee-dynamic-gate-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-fee-dynamic-gate-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-reward-config-governance-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-reward-config-governance-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["live-view-reward-loanflow-boundary-arbitrum-sepolia", "pnpm -s exec hardhat run scripts/tests/live-test/live-view-reward-loanflow-boundary-arbitrum-sepolia.ts --network arbitrumSepolia"],
  ["test__live__release-gates__arbitrum-sepolia", "pnpm -s run test:live:release-gates:arbitrum-sepolia"],
];

module.exports = {
  seedCase,
  liquidationSeedCase,
  liveTestCases,
  seededLiquidationCaseLabels,
};