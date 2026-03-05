# Latest batch E2E artifacts (quantified)

| Suite | Artifact | rpcUrl | chainId | block | Registry | VaultCore | orders | orderIds | orderIdSource | missingOrderIds | duplicateOrderIds | nonNumericOrderIds | checkpoints | DataPushed(total) | DataPushed(typeHash count) |
|---|---|---|---:|---:|---|---|---:|---|---|---|---|---:|---|---:|---:|
| batch-10-users | batch-10-users.1772680770335.json | http://127.0.0.1:18545 | 1337 | 258248 | 0x72F853E9E202600c5017B5A060168603c3ed7368 | 0x221416CFa5A3CD92035E537ded1dD12d4d587c03 | 5 | 8..12 (n=5) | orders[].orderId | - | - | 0 | checkpoint1_after_matches, checkpoint2_after_all_repaid, loanNftViewUserTradesFinal | 76 | 11 |
| batch-advanced-10-users | batch-advanced-10-users.1772680773870.json | http://127.0.0.1:18545 | 1337 | 279854 | 0x72F853E9E202600c5017B5A060168603c3ed7368 | 0x221416CFa5A3CD92035E537ded1dD12d4d587c03 | 19 | 8..26 (n=19) | orders[].orderId | - | - | 0 | checkpointA_after_matches, final_after_all_repaid, loanNftViewUserTradesFinal | 350 | 22 |

## Business Checks

- batch-10-users: OK — orders=5, orderIds=8..12 (n=5) (source=orders[].orderId)
- batch-advanced-10-users: OK — orders=19, orderIds=8..26 (n=19) (source=orders[].orderId)

Interpretation notes: missing/duplicate/non-numeric orderIds often indicate skipped scenario branches, failed order creation with continued flow, or non-monotonic/conditional ID allocation.

## DataPushed breakdown (top 5 typeHash)

- batch-10-users: 0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE):15, 0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE):15, 0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED):8, 0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE):7, 0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED):7
- batch-advanced-10-users: 0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE):53, 0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE):53, 0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE):34, 0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED):34, 0xe54b7b64faa0b7bd19041a6de6139f4ad40dad76018fb0290139991d3f15db06(LOAN_FLOW_UPDATED):27

## DataPushed typeHash diff (advanced vs basic)

- addedInAdvanced: 11
```text
0x16f12d608a77d21b99d0e323cf7c4ffb92bc178795974fed923e20e79827aa91(COLLATERAL_RELEASED)
0x3d9c74e68267921ffd6826ed38c2616ce50960bba033b2008e1367ee407b1ab2(GUARANTEE_STATS_UPDATE)
0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED)
0x6fadd72dc184c84f2af1cd2438a64d79bf005e269ce966b612e612df7d3531a6(LOAN_REPAID)
0x8392c738351b8bcb4e65233a0e37997c3d12270b37f35080e00e9aa72e154e28(EASY_RECYCLED_SPLIT)
0x853cf5a8b5c8d89ba3a52ea8bbd9bd3f749e726609e4f1a60efef3212a30c294(LOAN_NFT_STATUS_UPDATED)
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED)
0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e(EASY_SPENT)
0xdfadcca126ffe796f3a74b09cf7f25abd96977a37fcf95ef156fdcb0b3c37fdb(GUARANTEE_LOCKED)
0xe26a8cf2670d5931b1a06c4088f9fb1aaae25caed99f472f1460e9d7a2a84ab6(DEPOSIT_PROCESSED)
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
0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED): 7
0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED): 5
0x68cf2df4228c659304eceee516cbdcbf429b41054949d1564b8f184a1f0f1d29(LOAN_NFT_MINTED): 5
0x81e627079fd2931f916ab43d5d94b61f52d20626c71daf9615393305e8852117(LOAN_CREATED): 5
0xe54b7b64faa0b7bd19041a6de6139f4ad40dad76018fb0290139991d3f15db06(LOAN_FLOW_UPDATED): 5
0x153656eb73bcdcbba4596f50636050bd92e3125b5d5d1caf3c9fbf77a79e2e8e(LIQUIDATION_UPDATE): 2
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec(LIQUIDATION_PAYOUT): 2
```

### batch-advanced-10-users

```text
0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03(USER_POSITION_UPDATE): 53
0x6e0299e135b1d645c46c700570c1c27ab6a0a7781418695a598326b500f117a1(USER_STATS_UPDATE): 53
0x86111788e77bb400bd62c6515e2779b88b2bb53207e85905d0150307c51e5594(RISK_STATUS_UPDATE): 34
0x8a55b3f337a3fa2648f7825aae9107114f1e8eb125ed2260df0ff68319911935(FEE_DISTRIBUTED): 34
0xe54b7b64faa0b7bd19041a6de6139f4ad40dad76018fb0290139991d3f15db06(LOAN_FLOW_UPDATED): 27
0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f(WITHDRAW_PROCESSED): 18
0x7425ee05fdfa721ead972f11aad7cd954fffd1912cf467b9b7ff2aed9a6841cd(RESERVE_CONSUMED): 17
0x68cf2df4228c659304eceee516cbdcbf429b41054949d1564b8f184a1f0f1d29(LOAN_NFT_MINTED): 17
0x81e627079fd2931f916ab43d5d94b61f52d20626c71daf9615393305e8852117(LOAN_CREATED): 17
0x6fadd72dc184c84f2af1cd2438a64d79bf005e269ce966b612e612df7d3531a6(LOAN_REPAID): 16
0xfcf61314ac98647e05a494ad6be172e25007444a342c7f626bfdc1286d6ae408(REPAY_AND_SETTLE): 16
0x853cf5a8b5c8d89ba3a52ea8bbd9bd3f749e726609e4f1a60efef3212a30c294(LOAN_NFT_STATUS_UPDATED): 15
0x16f12d608a77d21b99d0e323cf7c4ffb92bc178795974fed923e20e79827aa91(COLLATERAL_RELEASED): 14
0x5f8ec6f2bdfc2bbca932eee7f8594f977d14c9d6e3c2cbe5f518448bc1965e31(EASY_MINTED): 7
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc(REWARD_PENALTY_LEDGER_UPDATED): 3
0xdfadcca126ffe796f3a74b09cf7f25abd96977a37fcf95ef156fdcb0b3c37fdb(GUARANTEE_LOCKED): 2
0x3d9c74e68267921ffd6826ed38c2616ce50960bba033b2008e1367ee407b1ab2(GUARANTEE_STATS_UPDATE): 2
0xe26a8cf2670d5931b1a06c4088f9fb1aaae25caed99f472f1460e9d7a2a84ab6(DEPOSIT_PROCESSED): 1
0x8392c738351b8bcb4e65233a0e37997c3d12270b37f35080e00e9aa72e154e28(EASY_RECYCLED_SPLIT): 1
0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e(EASY_SPENT): 1
0x153656eb73bcdcbba4596f50636050bd92e3125b5d5d1caf3c9fbf77a79e2e8e(LIQUIDATION_UPDATE): 1
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec(LIQUIDATION_PAYOUT): 1
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
0x28270f3353110ea76292a3ea7672ad3c81f96556a1c5da0ead6e31d6af0ac52f WITHDRAW_PROCESSED
0x2b2ebfafb19dde69e4ed76ee4ff9e727ccd9ec6474d55f5a11ebf8d0c479ff03 USER_POSITION_UPDATE
0x3d9c74e68267921ffd6826ed38c2616ce50960bba033b2008e1367ee407b1ab2 GUARANTEE_STATS_UPDATE
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
0xb5847338cda2f0c11bed263297d250ddd3c9e60dbcd55a7a38621d32a89c1afc REWARD_PENALTY_LEDGER_UPDATED
0xd0c71fa35c2cf4c6d97c50c984d26d5d48addff351d88cc7be51a7db6ae31aec LIQUIDATION_PAYOUT
0xde64cf55996ede8aba93be3b76df745551c559d3af08a04a2d9ab5f7ce82471e EASY_SPENT
0xdfadcca126ffe796f3a74b09cf7f25abd96977a37fcf95ef156fdcb0b3c37fdb GUARANTEE_LOCKED
0xe26a8cf2670d5931b1a06c4088f9fb1aaae25caed99f472f1460e9d7a2a84ab6 DEPOSIT_PROCESSED
0xe54b7b64faa0b7bd19041a6de6139f4ad40dad76018fb0290139991d3f15db06 LOAN_FLOW_UPDATED
0xfcf61314ac98647e05a494ad6be172e25007444a342c7f626bfdc1286d6ae408 REPAY_AND_SETTLE
```

## Orders (from artifact)

### batch-10-users

```text
orderId=8 suffix=- guarantee=- principalRaw=1000000000
orderId=9 suffix=- guarantee=- principalRaw=1000000000
orderId=10 suffix=- guarantee=- principalRaw=1000000000
orderId=11 suffix=- guarantee=- principalRaw=1000000000
orderId=12 suffix=- guarantee=- principalRaw=1000000000
```

### batch-advanced-10-users

```text
orderId=8 suffix=p1 guarantee=false principalRaw=1000000000
orderId=9 suffix=p2 guarantee=false principalRaw=1000000000
orderId=10 suffix=p3 guarantee=false principalRaw=1000000000
orderId=11 suffix=p4a guarantee=false principalRaw=500000000
orderId=12 suffix=p4b guarantee=false principalRaw=500000000
orderId=13 suffix=p5 guarantee=false principalRaw=1000000000
orderId=14 suffix=early-repay guarantee=false principalRaw=1000000000
orderId=15 suffix=th-below guarantee=false principalRaw=999999999
orderId=16 suffix=th-at guarantee=false principalRaw=1000000000
orderId=17 suffix=partial guarantee=false principalRaw=1000000000
orderId=18 suffix=cb-1 guarantee=false principalRaw=1000000000
orderId=19 suffix=cb-2 guarantee=false principalRaw=1000000000
orderId=20 suffix=ma-usdc guarantee=false principalRaw=1000000000
orderId=21 suffix=ma-alt guarantee=false principalRaw=999999999
orderId=22 suffix=release-demo guarantee=false principalRaw=100000000
orderId=23 suffix=nft-transfer guarantee=false principalRaw=200000000
orderId=24 suffix=guarantee-early guarantee=true principalRaw=200000000
orderId=25 suffix=guarantee-default guarantee=true principalRaw=150000000
orderId=26 suffix=liq-demo guarantee=false principalRaw=200000000
```


Generated at: 2026-03-05T03:20:28.380Z
