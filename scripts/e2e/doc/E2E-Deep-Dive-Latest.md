# E2E Deep Dive (Latest)

## Inputs

- manifest: /Volumes/AI-hosts/contracts/scripts/e2e/logs/e2e-run-20260325101940431/manifest.json
- batch-advanced: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/batch-advanced-10-users.1774434755514.json
- liquidation-reward-penalty: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/liquidation-reward-penalty.1774434914524.json
- rewardview-acceptance: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/rewardview-acceptance.1774438203794.json
- rewardspend-acceptance: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/rewardspend-acceptance.1774438161420.json
- price-liquidation-stress: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/price-liquidation-stress.1774438022032.json
- blocks-only-standalone: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/blocks-only-rollout-smoke.localhost-standalone.1774434798326.json
- blocks-only-embedded: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/blocks-only-rollout-smoke.advanced-batch.1774434755468.json
- full-with-views: /Volumes/AI-hosts/contracts/scripts/e2e/artifacts/full-with-views.253193596.json
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

