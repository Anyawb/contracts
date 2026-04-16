# Latest batch E2E artifacts (quantified)

| Suite | Artifact | rpcUrl | chainId | block | Registry | VaultCore | orders | orderIds | orderIdSource | missingOrderIds | duplicateOrderIds | nonNumericOrderIds | checkpoints | GuaranteeFlow | DataPushed(total) | DataPushed(typeHash count) | RewardViewPushFailed |
|---|---|---|---:|---:|---|---|---:|---|---|---|---|---:|---|---|---:|---:|---:|
| batch-10-users | batch-10-users.1775916501690.json | http://127.0.0.1:8545 | 1337 | 257448 | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | 0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf | 5 | 30..34 (n=5) | orders[].orderId | - | - | 0 | checkpoint1_after_matches, checkpoint2_after_all_repaid, loanNftViewUserTradesFinal | - | 102 | 15 | 0 |
| batch-advanced-10-users | batch-advanced-10-users.1775916507428.json | http://127.0.0.1:8545 | 1337 | 288188 | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | 0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf | 23 | 30..52 (n=23) | orders[].orderId | - | - | 0 | blocksOnlyRolloutSmoke, checkpointA_after_matches, checkpoint_pre_extras_after_all_repaid, final_after_all_repaid, final_end_of_script, loanNftViewUserTradesFinal, reward_extended_checks, statisticsSync_after_all_repaid, statisticsSync_after_matches, statisticsSync_post_extras, view_orderDetailsSummary | - | 619 | 32 | 0 |
| blocks-only-rollout-smoke.advanced-batch | blocks-only-rollout-smoke.advanced-batch.1775916507364.json | - | - | - | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | 0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf | 2 | 0,1 (n=2) | orderIds.* | - | - | 0 | liquidation, repayAndTradeClose | - | 40 | 15 | 0 |
| blocks-only-rollout-smoke.localhost-standalone | blocks-only-rollout-smoke.localhost-standalone.1775916511132.json | - | - | - | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | 0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf | 2 | 0,1 (n=2) | orderIds.* | - | - | 0 | liquidation, repayAndTradeClose | - | 40 | 15 | 0 |
| full-with-views | full-with-views.30864.json | http://127.0.0.1:8545 | 1337 | 30864 | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | - | - | - | - | - | - | 0 | after_deposit, after_match, after_match_repay | - | 2 | 2 | 0 |
| liquidation-reward-penalty | liquidation-reward-penalty.1775916538358.json | http://127.0.0.1:8545 | 1337 | - | - | - | - | - | - | - | - | 0 | - | liquidate, liquidate_rewardview_unavailable_immediate, liquidate_rewardview_unavailable_post_cache | 0 | 0 | 1 |
| price-liquidation-stress | price-liquidation-stress.1775916556796.json | http://127.0.0.1:8545 | 1337 | - | - | - | - | - | - | - | - | 0 | - | - | 0 | 0 | 1 |
| rewardview-acceptance | rewardview-acceptance.1775916566057.json | - | 1337 | - | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | - | - | - | - | - | - | 0 | - | - | 5 | 5 | 1 |
| rewardspend-acceptance | rewardspend-acceptance.1775916564113.json | - | 1337 | - | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | - | - | - | - | - | - | 0 | - | - | 2 | 2 | 0 |
| rewardmanager-governance | rewardmanager-governance.1775916567973.json | - | 1337 | - | 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 | - | - | - | - | - | - | 0 | - | - | 1 | 1 | 0 |

## Business Checks

- batch-10-users: OK — orders=5, orderIds=30..34 (n=5) (source=orders[].orderId)
- batch-advanced-10-users: OK — orders=23, orderIds=30..52 (n=23) (source=orders[].orderId)
- blocks-only-rollout-smoke.advanced-batch: OK — orders=2, orderIds=0,1 (n=2) (source=orderIds.*)
- blocks-only-rollout-smoke.localhost-standalone: OK — orders=2, orderIds=0,1 (n=2) (source=orderIds.*)
- full-with-views: OK — orders=-, orderIds=- (source=-)
- liquidation-reward-penalty: OK — orders=-, orderIds=- (source=-); notes: expectedRewardViewDegradeCoverage=1
- price-liquidation-stress: OK — orders=-, orderIds=- (source=-); notes: expectedRewardViewDegradeCoverage=1
- rewardview-acceptance: OK — orders=-, orderIds=- (source=-); notes: expectedRewardViewDegradeCoverage=1
- rewardspend-acceptance: OK — orders=-, orderIds=- (source=-)
- rewardmanager-governance: OK — orders=-, orderIds=- (source=-)

Interpretation notes: missing/duplicate/non-numeric orderIds often indicate skipped scenario branches, failed order creation with continued flow, or non-monotonic/conditional ID allocation.

## View OrderDetails checks

These checks summarize artifacts produced by the batch suites: LoanNFTView enumeration + per-order LendingEngineView.getLoanOrder reads.
If `orderDetailsErrTotal > 0`, it usually means MissingRole()/selector mismatch/deploy mismatch and the run should NOT be treated as a clean pass.

- batch-10-users: (no orderDetails summary in artifact)
- batch-advanced-10-users: OK ok=34 err=0 fallback=0
- blocks-only-rollout-smoke.advanced-batch: (no orderDetails summary in artifact)
- blocks-only-rollout-smoke.localhost-standalone: (no orderDetails summary in artifact)
- full-with-views: (no orderDetails summary in artifact)
- liquidation-reward-penalty: (no orderDetails summary in artifact)
- price-liquidation-stress: (no orderDetails summary in artifact)
- rewardview-acceptance: (no orderDetails summary in artifact)
- rewardspend-acceptance: (no orderDetails summary in artifact)
- rewardmanager-governance: (no orderDetails summary in artifact)

## DataPushed breakdown (top 5 typeHash)

- batch-10-users: 0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE):15, 0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE):15, 0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED):8, 0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE):7, 0xa44b26eb259601cc1cd1e746737442d4ed7997bad08ecdddf902949bd78a3fa9(USER_FEE):7
- batch-advanced-10-users: 0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE):70, 0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE):70, 0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE):46, 0xa44b26eb259601cc1cd1e746737442d4ed7997bad08ecdddf902949bd78a3fa9(USER_FEE):44, 0xd45235039658fc972fd49641f2c7387d478ad8fb96765ae644127397b387a7e6(FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED):44
- blocks-only-rollout-smoke.advanced-batch: 0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE):9, 0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE):9, 0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED):5, 0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE):4, 0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED):2
- blocks-only-rollout-smoke.localhost-standalone: 0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE):9, 0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE):9, 0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED):5, 0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE):4, 0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED):2
- full-with-views: 0xd5669f4d95355184146f6d7a4d8803870594fbca04aebdcd88abb374775f43cb(REWARD_EARN_STATE_UPDATED):1, 0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED):1
- liquidation-reward-penalty: -
- price-liquidation-stress: -
- rewardview-acceptance: 0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED):1, 0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED):1, 0xd5669f4d95355184146f6d7a4d8803870594fbca04aebdcd88abb374775f43cb(REWARD_EARN_STATE_UPDATED):1, 0x20e5443370314fc535c437851da73a27acb769105b23cb97e652bfe722f9c96e(REWARD_DYNAMIC_REWARD_PARAMS_UPDATED):1, 0xcf255d9e7479de43a43316bb307c4a6123c721ad7e4cf8b48d25c160d417252d(REWARD_LEVEL_MULTIPLIER_UPDATED):1
- rewardspend-acceptance: 0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e(EASY_SPENT):1, 0x8392c738351b8bcb4e65233a0e37997c3d12270b37f35080e00e9aa72e154e28(EASY_RECYCLED_SPLIT):1
- rewardmanager-governance: 0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED):1

## Guarantee / RewardView degrade summary

- batch-10-users: OK guarantee=-; rewardViewPushFailed=0; expectedDegradeCoverage=0; unexpectedRewardViewPushFailed=0
- batch-advanced-10-users: OK guarantee=-; rewardViewPushFailed=0; expectedDegradeCoverage=0; unexpectedRewardViewPushFailed=0
- blocks-only-rollout-smoke.advanced-batch: OK guarantee=-; rewardViewPushFailed=0; expectedDegradeCoverage=0; unexpectedRewardViewPushFailed=0
- blocks-only-rollout-smoke.localhost-standalone: OK guarantee=-; rewardViewPushFailed=0; expectedDegradeCoverage=0; unexpectedRewardViewPushFailed=0
- full-with-views: OK guarantee=-; rewardViewPushFailed=0; expectedDegradeCoverage=0; unexpectedRewardViewPushFailed=0
- liquidation-reward-penalty: OK guarantee=liquidate, liquidate_rewardview_unavailable_immediate, liquidate_rewardview_unavailable_post_cache; rewardViewPushFailed=1; expectedDegradeCoverage=1; unexpectedRewardViewPushFailed=0
- price-liquidation-stress: OK guarantee=-; rewardViewPushFailed=1; expectedDegradeCoverage=1; unexpectedRewardViewPushFailed=0
- rewardview-acceptance: OK guarantee=-; rewardViewPushFailed=1; expectedDegradeCoverage=1; unexpectedRewardViewPushFailed=0
- rewardspend-acceptance: OK guarantee=-; rewardViewPushFailed=0; expectedDegradeCoverage=0; unexpectedRewardViewPushFailed=0
- rewardmanager-governance: OK guarantee=-; rewardViewPushFailed=0; expectedDegradeCoverage=0; unexpectedRewardViewPushFailed=0

## DataPushed typeHash diff (advanced vs basic)

- addedInAdvanced: 17
```text
0x16f12d608a77d21b99d0e323cf7c4ffb92bc178795974fed923e20e79827aa91(COLLATERAL_RELEASED)
0x2846e6931c57d96f71a6c07b49a0e81a6da1bbd9f706a8d6d78eb4cfe19d08ed(GUARANTEE_FORFEITED)
0x3d9c74e68267921ffd6826ed38c2616ce50960bba033b2008e1367ee407b1ab2(GUARANTEE_STATS_UPDATE)
0x575d60cad67b83ddaa02156aeff923314db67bb9f7e610ca4dbeb9312f525ca7(BLOCKS_ONLY_LIQUIDATED)
0x37115ae39026527e4999d3714461b5a301add7959d82ce1ff1e58c78aca5808e(BLOCKS_ONLY_TRADE_CLOSED)
0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED)
0x6fadd72dc184c84f2af1cd2438a64d79bf005e269ce966b612e612df7d3531a6(LOAN_REPAID)
0x8392c738351b8bcb4e65233a0e37997c3d12270b37f35080e00e9aa72e154e28(EASY_RECYCLED_SPLIT)
0x853cf5a8b5c8d89ba3a52ea8bbd9bd3f749e726609e4f1a60efef3212a30c294(LOAN_NFT_STATUS_UPDATED)
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED)
0xbac5a7574a9eb6cb5ba336ca9a2a1a3e99aa3c5435526e9bb264655e5b722d95(BLOCKS_ONLY_REPAID)
0xdc599cecc97e99d8245e5b0d4508c1d4489a39977bf9cb033217051a08b93cb1(GUARANTEE_RELEASED)
0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e(EASY_SPENT)
0xdfadcca126ffe796f3a74b09cf7f25abd96977a37fcf95ef156fdcb0b3c37fdb(GUARANTEE_LOCKED)
0xe26a8cf2670d5931b1a06c4088f9fb1aaae25caed99f472f1460e9d7a2a84ab6(DEPOSIT_PROCESSED)
0xf9a3732cf11c93a28882b09a88479a22524eef82199db4e52abd369459f72d12(BLOCKS_ONLY_MATCH_FINALIZED)
0xfcf61314ac98647e05a494ad6be172e25007444a342c7f626bfdc1286d6ae408(REPAY_AND_SETTLE)
```
- missingInAdvanced: 0

## DataPushed breakdown (all typeHash)

### batch-10-users

```text
0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE): 15
0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE): 15
0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED): 8
0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE): 7
0xa44b26eb259601cc1cd1e746737442d4ed7997bad08ecdddf902949bd78a3fa9(USER_FEE): 7
0xd45235039658fc972fd49641f2c7387d478ad8fb96765ae644127397b387a7e6(FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED): 7
0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED): 7
0xa1f4776be54271a808c0a47bd92023112658807617bdc9cda88d344e47c7168d(GLOBAL_FEE_STATS): 7
0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED): 5
0x68cf2df4228c659304eceee516cbdcbf429b41054949d1564b8f184a1f0f1d29(LOAN_NFT_MINTED): 5
0x81e627079fd2931f916ab43d5d94b61f52d20626c71daf9615393305e8852117(LOAN_CREATED): 5
0xe54b7b64faa0b7bd19041a6de6139f4ad40dad76018fb0290139991d3f15db06(LOAN_FLOW_UPDATED): 5
0xd5669f4d95355184146f6d7a4d8803870594fbca04aebdcd88abb374775f43cb(REWARD_EARN_STATE_UPDATED): 5
0x153656eb73bcdcbba4596f50636050bd92e3125b5d5d1caf3c9fbf77a79e2e8e(LIQUIDATION_UPDATE): 2
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec(LIQUIDATION_PAYOUT): 2
```

### batch-advanced-10-users

```text
0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE): 70
0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE): 70
0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE): 46
0xa44b26eb259601cc1cd1e746737442d4ed7997bad08ecdddf902949bd78a3fa9(USER_FEE): 44
0xd45235039658fc972fd49641f2c7387d478ad8fb96765ae644127397b387a7e6(FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED): 44
0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED): 44
0xa1f4776be54271a808c0a47bd92023112658807617bdc9cda88d344e47c7168d(GLOBAL_FEE_STATS): 44
0xe54b7b64faa0b7bd19041a6de6139f4ad40dad76018fb0290139991d3f15db06(LOAN_FLOW_UPDATED): 34
0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED): 25
0x68cf2df4228c659304eceee516cbdcbf429b41054949d1564b8f184a1f0f1d29(LOAN_NFT_MINTED): 23
0x81e627079fd2931f916ab43d5d94b61f52d20626c71daf9615393305e8852117(LOAN_CREATED): 23
0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED): 23
0xd5669f4d95355184146f6d7a4d8803870594fbca04aebdcd88abb374775f43cb(REWARD_EARN_STATE_UPDATED): 20
0x6fadd72dc184c84f2af1cd2438a64d79bf005e269ce966b612e612df7d3531a6(LOAN_REPAID): 18
0xfcf61314ac98647e05a494ad6be172e25007444a342c7f626bfdc1286d6ae408(REPAY_AND_SETTLE): 18
0x853cf5a8b5c8d89ba3a52ea8bbd9bd3f749e726609e4f1a60efef3212a30c294(LOAN_NFT_STATUS_UPDATED): 17
0x16f12d608a77d21b99d0e323cf7c4ffb92bc178795974fed923e20e79827aa91(COLLATERAL_RELEASED): 14
0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED): 10
0x3d9c74e68267921ffd6826ed38c2616ce50960bba033b2008e1367ee407b1ab2(GUARANTEE_STATS_UPDATE): 7
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED): 6
0xdfadcca126ffe796f3a74b09cf7f25abd96977a37fcf95ef156fdcb0b3c37fdb(GUARANTEE_LOCKED): 4
0x2846e6931c57d96f71a6c07b49a0e81a6da1bbd9f706a8d6d78eb4cfe19d08ed(GUARANTEE_FORFEITED): 2
0x153656eb73bcdcbba4596f50636050bd92e3125b5d5d1caf3c9fbf77a79e2e8e(LIQUIDATION_UPDATE): 2
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec(LIQUIDATION_PAYOUT): 2
0xf9a3732cf11c93a28882b09a88479a22524eef82199db4e52abd369459f72d12(BLOCKS_ONLY_MATCH_FINALIZED): 2
0xe26a8cf2670d5931b1a06c4088f9fb1aaae25caed99f472f1460e9d7a2a84ab6(DEPOSIT_PROCESSED): 1
0xdc599cecc97e99d8245e5b0d4508c1d4489a39977bf9cb033217051a08b93cb1(GUARANTEE_RELEASED): 1
0x8392c738351b8bcb4e65233a0e37997c3d12270b37f35080e00e9aa72e154e28(EASY_RECYCLED_SPLIT): 1
0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e(EASY_SPENT): 1
0xbac5a7574a9eb6cb5ba336ca9a2a1a3e99aa3c5435526e9bb264655e5b722d95(BLOCKS_ONLY_REPAID): 1
0x37115ae39026527e4999d3714461b5a301add7959d82ce1ff1e58c78aca5808e(BLOCKS_ONLY_TRADE_CLOSED): 1
0x575d60cad67b83ddaa02156aeff923314db67bb9f7e610ca4dbeb9312f525ca7(BLOCKS_ONLY_LIQUIDATED): 1
```

### blocks-only-rollout-smoke.advanced-batch

```text
0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE): 9
0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE): 9
0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED): 5
0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE): 4
0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED): 2
0xf9a3732cf11c93a28882b09a88479a22524eef82199db4e52abd369459f72d12(BLOCKS_ONLY_MATCH_FINALIZED): 2
0xbac5a7574a9eb6cb5ba336ca9a2a1a3e99aa3c5435526e9bb264655e5b722d95(BLOCKS_ONLY_REPAID): 1
0x37115ae39026527e4999d3714461b5a301add7959d82ce1ff1e58c78aca5808e(BLOCKS_ONLY_TRADE_CLOSED): 1
0xa44b26eb259601cc1cd1e746737442d4ed7997bad08ecdddf902949bd78a3fa9(USER_FEE): 1
0xd45235039658fc972fd49641f2c7387d478ad8fb96765ae644127397b387a7e6(FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED): 1
0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED): 1
0xa1f4776be54271a808c0a47bd92023112658807617bdc9cda88d344e47c7168d(GLOBAL_FEE_STATS): 1
0x153656eb73bcdcbba4596f50636050bd92e3125b5d5d1caf3c9fbf77a79e2e8e(LIQUIDATION_UPDATE): 1
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec(LIQUIDATION_PAYOUT): 1
0x575d60cad67b83ddaa02156aeff923314db67bb9f7e610ca4dbeb9312f525ca7(BLOCKS_ONLY_LIQUIDATED): 1
```

### blocks-only-rollout-smoke.localhost-standalone

```text
0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE): 9
0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE): 9
0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED): 5
0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE): 4
0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED): 2
0xf9a3732cf11c93a28882b09a88479a22524eef82199db4e52abd369459f72d12(BLOCKS_ONLY_MATCH_FINALIZED): 2
0xbac5a7574a9eb6cb5ba336ca9a2a1a3e99aa3c5435526e9bb264655e5b722d95(BLOCKS_ONLY_REPAID): 1
0x37115ae39026527e4999d3714461b5a301add7959d82ce1ff1e58c78aca5808e(BLOCKS_ONLY_TRADE_CLOSED): 1
0xa44b26eb259601cc1cd1e746737442d4ed7997bad08ecdddf902949bd78a3fa9(USER_FEE): 1
0xd45235039658fc972fd49641f2c7387d478ad8fb96765ae644127397b387a7e6(FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED): 1
0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED): 1
0xa1f4776be54271a808c0a47bd92023112658807617bdc9cda88d344e47c7168d(GLOBAL_FEE_STATS): 1
0x153656eb73bcdcbba4596f50636050bd92e3125b5d5d1caf3c9fbf77a79e2e8e(LIQUIDATION_UPDATE): 1
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec(LIQUIDATION_PAYOUT): 1
0x575d60cad67b83ddaa02156aeff923314db67bb9f7e610ca4dbeb9312f525ca7(BLOCKS_ONLY_LIQUIDATED): 1
```

### full-with-views

```text
0xd5669f4d95355184146f6d7a4d8803870594fbca04aebdcd88abb374775f43cb(REWARD_EARN_STATE_UPDATED): 1
0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED): 1
```

### liquidation-reward-penalty

No `counters.dataPushedByTypeHash` in this artifact.

### price-liquidation-stress

No `counters.dataPushedByTypeHash` in this artifact.

### rewardview-acceptance

```text
0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED): 1
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED): 1
0xd5669f4d95355184146f6d7a4d8803870594fbca04aebdcd88abb374775f43cb(REWARD_EARN_STATE_UPDATED): 1
0x20e5443370314fc535c437851da73a27acb769105b23cb97e652bfe722f9c96e(REWARD_DYNAMIC_REWARD_PARAMS_UPDATED): 1
0xcf255d9e7479de43a43316bb307c4a6123c721ad7e4cf8b48d25c160d417252d(REWARD_LEVEL_MULTIPLIER_UPDATED): 1
```

### rewardspend-acceptance

```text
0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e(EASY_SPENT): 1
0x8392c738351b8bcb4e65233a0e37997c3d12270b37f35080e00e9aa72e154e28(EASY_RECYCLED_SPLIT): 1
```

### rewardmanager-governance

```text
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED): 1
```


## Key event missing warnings

- batch-10-users: OK
- batch-advanced-10-users: OK

Notes:
- These are guard-rail checks; missing events can indicate skipped branches or missing push paths.
- Adjust required events if the suite's business scope changes.

## DataPushed typeHash legend

```text
0x153656eb73bcdcbba4596f50636050bd92e3125b5d5d1caf3c9fbf77a79e2e8e LIQUIDATION_UPDATE
0x16f12d608a77d21b99d0e323cf7c4ffb92bc178795974fed923e20e79827aa91 COLLATERAL_RELEASED
0x20e5443370314fc535c437851da73a27acb769105b23cb97e652bfe722f9c96e REWARD_DYNAMIC_REWARD_PARAMS_UPDATED
0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f WITHDRAW_PROCESSED
0x2846e6931c57d96f71a6c07b49a0e81a6da1bbd9f706a8d6d78eb4cfe19d08ed GUARANTEE_FORFEITED
0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03 USER_POSITION_UPDATE
0x3d9c74e68267921ffd6826ed38c2616ce50960bba033b2008e1367ee407b1ab2 GUARANTEE_STATS_UPDATE
0x575d60cad67b83ddaa02156aeff923314db67bb9f7e610ca4dbeb9312f525ca7 BLOCKS_ONLY_LIQUIDATED
0x37115ae39026527e4999d3714461b5a301add7959d82ce1ff1e58c78aca5808e BLOCKS_ONLY_TRADE_CLOSED
0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31 EASY_MINTED
0x68cf2df4228c659304eceee516cbdcbf429b41054949d1564b8f184a1f0f1d29 LOAN_NFT_MINTED
0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1 USER_STATS_UPDATE
0x6fadd72dc184c84f2af1cd2438a64d79bf005e269ce966b612e612df7d3531a6 LOAN_REPAID
0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd RESERVE_CONSUMED
0x81e627079fd2931f916ab43d5d94b61f52d20626c71daf9615393305e8852117 LOAN_CREATED
0x8392c738351b8bcb4e65233a0e37997c3d12270b37f35080e00e9aa72e154e28 EASY_RECYCLED_SPLIT
0x853cf5a8b5c8d89ba3a52ea8bbd9bd3f749e726609e4f1a60efef3212a30c294 LOAN_NFT_STATUS_UPDATED
0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594 RISK_STATUS_UPDATE
0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935 FEE_DISTRIBUTED
0xa1f4776be54271a808c0a47bd92023112658807617bdc9cda88d344e47c7168d GLOBAL_FEE_STATS
0xa44b26eb259601cc1cd1e746737442d4ed7997bad08ecdddf902949bd78a3fa9 USER_FEE
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc REWARD_PENALTY_LEDGER_UPDATED
0xbac5a7574a9eb6cb5ba336ca9a2a1a3e99aa3c5435526e9bb264655e5b722d95 BLOCKS_ONLY_REPAID
0xcf255d9e7479de43a43316bb307c4a6123c721ad7e4cf8b48d25c160d417252d REWARD_LEVEL_MULTIPLIER_UPDATED
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec LIQUIDATION_PAYOUT
0xd45235039658fc972fd49641f2c7387d478ad8fb96765ae644127397b387a7e6 FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED
0xd5669f4d95355184146f6d7a4d8803870594fbca04aebdcd88abb374775f43cb REWARD_EARN_STATE_UPDATED
0xdc599cecc97e99d8245e5b0d4508c1d4489a39977bf9cb033217051a08b93cb1 GUARANTEE_RELEASED
0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e EASY_SPENT
0xdfadcca126ffe796f3a74b09cf7f25abd96977a37fcf95ef156fdcb0b3c37fdb GUARANTEE_LOCKED
0xe26a8cf2670d5931b1a06c4088f9fb1aaae25caed99f472f1460e9d7a2a84ab6 DEPOSIT_PROCESSED
0xe54b7b64faa0b7bd19041a6de6139f4ad40dad76018fb0290139991d3f15db06 LOAN_FLOW_UPDATED
0xf9a3732cf11c93a28882b09a88479a22524eef82199db4e52abd369459f72d12 BLOCKS_ONLY_MATCH_FINALIZED
0xfcf61314ac98647e05a494ad6be172e25007444a342c7f626bfdc1286d6ae408 REPAY_AND_SETTLE
```

## Orders (from artifact)

### batch-10-users

```text
orderId=30 suffix=- guarantee=- principalRaw=1000000000
orderId=31 suffix=- guarantee=- principalRaw=1000000000
orderId=32 suffix=- guarantee=- principalRaw=1000000000
orderId=33 suffix=- guarantee=- principalRaw=1000000000
orderId=34 suffix=- guarantee=- principalRaw=1000000000
```

### batch-advanced-10-users

```text
orderId=30 suffix=p1 guarantee=false principalRaw=1000000000
orderId=31 suffix=p2 guarantee=false principalRaw=1000000000
orderId=32 suffix=p3 guarantee=false principalRaw=1000000000
orderId=33 suffix=p4a guarantee=false principalRaw=500000000
orderId=34 suffix=p4b guarantee=false principalRaw=500000000
orderId=35 suffix=p5 guarantee=false principalRaw=1000000000
orderId=36 suffix=early-repay guarantee=false principalRaw=1000000000
orderId=37 suffix=th-below guarantee=false principalRaw=999999999
orderId=38 suffix=th-at guarantee=false principalRaw=1000000000
orderId=39 suffix=partial guarantee=false principalRaw=1000000000
orderId=40 suffix=cb-1 guarantee=false principalRaw=1000000000
orderId=41 suffix=cb-2 guarantee=false principalRaw=1000000000
orderId=42 suffix=ma-usdc guarantee=false principalRaw=1000000000
orderId=43 suffix=ma-alt guarantee=false principalRaw=999999999
orderId=44 suffix=release-demo guarantee=false principalRaw=100000000
orderId=45 suffix=nft-transfer guarantee=false principalRaw=200000000
orderId=46 suffix=guarantee-early guarantee=true principalRaw=200000000
orderId=47 suffix=guarantee-boundary-cross-usdc guarantee=true principalRaw=220000000
orderId=48 suffix=guarantee-boundary-cross-alt guarantee=false principalRaw=180000000
orderId=49 suffix=guarantee-boundary-same-plain guarantee=false principalRaw=180000000
orderId=50 suffix=guarantee-boundary-same-guaranteed guarantee=true principalRaw=220000000
orderId=51 suffix=guarantee-default guarantee=true principalRaw=150000000
orderId=52 suffix=liq-demo guarantee=false principalRaw=200000000
```

### blocks-only-rollout-smoke.advanced-batch

```text
orderId=0 source=orderIds.0
orderId=1 source=orderIds.1
```

### blocks-only-rollout-smoke.localhost-standalone

```text
orderId=0 source=orderIds.0
orderId=1 source=orderIds.1
```

### full-with-views

No `orders[]` array in this artifact.

### liquidation-reward-penalty

No `orders[]` array in this artifact.

### price-liquidation-stress

No `orders[]` array in this artifact.

### rewardview-acceptance

No `orders[]` array in this artifact.

### rewardspend-acceptance

No `orders[]` array in this artifact.

### rewardmanager-governance

No `orders[]` array in this artifact.


Latest manifest: /Volumes/AI-hosts/contracts/scripts/e2e/logs/e2e-run-20260411140811945/manifest.json
Run window: 2026-04-11T14:08:11.946Z -> 2026-04-11T14:09:41.034Z
Artifacts filtered to latest run window (2026-04-11T14:08:11.946Z -> 2026-04-11T14:09:41.034Z).
Generated at: 2026-04-11T14:09:42.811Z
