# E2E Deep Dive (Latest)

## Inputs

- manifest: /Volumes/AI-hosts/contracts/scripts/e2e/logs/e2e-run-20260411140811945/manifest.json
- batch-advanced: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/batch-advanced-10-users.1775916507428.json
- liquidation-reward-penalty: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/liquidation-reward-penalty.1775916538358.json
- rewardview-acceptance: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/rewardview-acceptance.1775916566057.json
- rewardspend-acceptance: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/rewardspend-acceptance.1775916564113.json
- price-liquidation-stress: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/price-liquidation-stress.1775916556796.json
- blocks-only-standalone: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/blocks-only-rollout-smoke.localhost-standalone.1775916511132.json
- blocks-only-embedded: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/blocks-only-rollout-smoke.advanced-batch.1775916507364.json
- full-with-views: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/full-with-views.30864.json
- fork-arbitrum-stale-price-keeper: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/fork-arbitrum-stale-price-keeper.1774434004814.json

## Checks

- Price/clearing markers: OK
- Reward DataPushed coverage: OK
- Blocks-only rollout smoke coverage: OK
- Full-with-views repay checkpoint validity: OK
- Fork stale-price keeper observability: OK
- Multi-asset order separation: OK
- Attack-suite ABI smoke: OK
- Stress mode: multi
- Stress multi-asset-crash: OK
- Stress guarantee-extension flow: OK
- RewardView degrade observability: OK (expected coverage: liquidation-reward-penalty=1, rewardview-acceptance=1, price-liquidation-stress=1)

