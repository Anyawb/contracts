const { loadNetworkProfile } = require('./shared/network-profile');

const network = process.env.LIVE_TEST_NETWORK;
if (!network || !network.trim()) {
  throw new Error('LIVE_TEST_NETWORK is required for live test case resolution');
}
const profile = loadNetworkProfile(network);
const slug = profile.LIVE_PROFILE_SLUG;
const networkKey = profile.LIVE_PROFILE_NETWORK;
const isBnbFirstPath = networkKey === 'bnbTestnet';

function liveRun(caseName) {
  return `pnpm -s exec hardhat run scripts/tests/live-test/networks/${slug}/${caseName}.ts --network ${networkKey}`;
}

const seedCase = isBnbFirstPath
  ? ["seed-skip-bnb-first-path", `node -e "console.log('seed skipped for ${networkKey} first path')"`]
  : [
      "seed-mock-asset-prices",
      `pnpm -s exec hardhat run scripts/deploy/seed-mock-asset-prices.ts --network ${networkKey}`,
    ];

const liquidationSeedCase = isBnbFirstPath
  ? [`seed-liquidatable-order-${slug}`, `node -e "console.log('liquidation seed skipped for ${networkKey} first path')"`]
  : [
      `seed-liquidatable-order-${slug}`,
      liveRun('seed-liquidatable-order'),
    ];

const seededLiquidationCaseLabels = isBnbFirstPath
  ? []
  : [
      `live-liquidation-${slug}`,
      `live-liquidation-fallback-${slug}`,
    ];

const arbitrumStyleCases = [
  [`live-ignite-minimal-${slug}`, liveRun('live-ignite-minimal')],
  ["live-read-pressure", liveRun('live-read-pressure')],
  [`live-settlement-role-bridge-${slug}`, liveRun('live-settlement-role-bridge')],
  [`live-view-registry-routes-${slug}`, liveRun('live-view-registry-routes')],
  [`live-liquidation-registry-preflight-${slug}`, liveRun('live-liquidation-registry-preflight')],
  [`live-view-facade-consistency-${slug}`, liveRun('live-view-facade-consistency')],
  [`live-prime-viewcache-${slug}`, liveRun('live-prime-viewcache')],
  [`live-platform-baseline-${slug}`, liveRun('live-platform-baseline')],
  [`live-fee-accounting-${slug}`, liveRun('live-fee-accounting')],
  [`live-view-consistency-gate-${slug}`, liveRun('live-view-consistency-gate')],
  [`live-view-facade-gate-${slug}`, liveRun('live-view-facade-gate')],
  [`live-warmup-${slug}`, liveRun('live-warmup')],
  [`test__smoke__multi-stablecoin__${slug}-live`, liveRun('live-smoke-multi-stablecoin')],
  [`live-cancel-reserve-${slug}`, liveRun('live-cancel-reserve')],
  [`live-withdraw-collateral-${slug}`, liveRun('live-withdraw-collateral')],
  [`live-guarantee-flow-${slug}`, liveRun('live-guarantee-flow')],
  [`live-blocks-only-liquidation-${slug}`, liveRun('live-blocks-only-liquidation')],
  [`live-liquidation-${slug}`, liveRun('live-liquidation')],
  [`live-liquidation-fallback-${slug}`, liveRun('live-liquidation-fallback')],
  [`live-liquidation-view-assertions-${slug}`, liveRun('live-liquidation-view-assertions')],
  [`live-fee-prepaid-gate-${slug}`, liveRun('live-fee-prepaid-gate')],
  [`live-fee-remaining-gate-${slug}`, liveRun('live-fee-remaining-gate')],
  [`live-fee-dynamic-gate-${slug}`, liveRun('live-fee-dynamic-gate')],
  [`live-reward-config-governance-${slug}`, liveRun('live-reward-config-governance')],
  [`live-view-reward-loanflow-boundary-${slug}`, liveRun('live-view-reward-loanflow-boundary')],
  [`test__live__release-gates__${slug}`, liveRun('live-release-gates')],
];

const bnbFirstPathCases = [
  [`live-preflight-${slug}`, liveRun('live-preflight')],
  [`live-settlement-role-bridge-${slug}`, liveRun('live-settlement-role-bridge')],
  [`live-warmup-${slug}`, liveRun('live-warmup')],
  [`live-platform-baseline-${slug}`, liveRun('live-platform-baseline')],
  [`live-guarantee-baseline-${slug}`, liveRun('live-guarantee-baseline')],
  [`test__live__release-gates__${slug}`, liveRun('live-release-gates')],
  [`test__live__release-gates-layer-b__${slug}`, liveRun('live-release-gates-layer-b')],
  [`live-blocks-only-state-machine-${slug}`, liveRun('live-blocks-only-liquidation')],
];

const liveTestCases = isBnbFirstPath ? bnbFirstPathCases : arbitrumStyleCases;

module.exports = {
  seedCase,
  liquidationSeedCase,
  liveTestCases,
  seededLiquidationCaseLabels,
};