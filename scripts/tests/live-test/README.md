# Arbitrum Sepolia Live Release Summary

本文件只保留本次正式放行闭环的运行总结。

详细执行规则、历史批次证据、脚本矩阵、fresh borrower / sweep 纪律、环境口径与 runbook 说明，已统一迁入 [docs/Usage-Guide/runbook/Arbitrum-Sepolia-Live-Platform-Baseline-Runbook.md](../../../docs/Usage-Guide/runbook/Arbitrum-Sepolia-Live-Platform-Baseline-Runbook.md)。

## 2026-03-30 正式闭环总结

本轮已按严格口径完成 Arbitrum Sepolia mock-suite 的正式放行闭环，结论如下：

1. dynamic fee 不再依赖测试期 break-glass 写入，而是先通过 [configure-dynamic-fee-arbitrum-sepolia.ts](./configure-dynamic-fee-arbitrum-sepolia.ts) 在链上正式预配置 `LIVE_DYNAMIC_FEE_TEST=200 bps`。
2. 链上预配置交易哈希为 `0x88976ac93f72ba7cd9c2a53ccd86108582a621557ea7dccdb17c0bfbd6782db3`。
3. 严格口径 round2 复验目录为 [scripts/tests/logs/manual-round2-acceptance-20260330183626](./../logs/manual-round2-acceptance-20260330183626)。
4. 本轮 [08-release-gates.log](./../logs/manual-round2-acceptance-20260330183626/08-release-gates.log) 已确认 platform baseline、fee prepaid、fee remaining、fee dynamic 四个 gate 全绿。
5. 本轮 [00-dryrun.log](./../logs/manual-round2-acceptance-20260330183626/00-dryrun.log) 已确认 `distributeDynamic.staticCall` 在严格口径下通过。
6. 本轮 [04-batch-liquidation-pressure.log](./../logs/manual-round2-acceptance-20260330183626/04-batch-liquidation-pressure.log) 已确认 batch liquidation / batch risk-query 压测通过。
7. 本轮 [99-sweep.log](./../logs/manual-round2-acceptance-20260330183626/99-sweep.log) 已确认 fresh borrower 统一回流流程执行完成。

## 放行结论

- `正式放行已闭环`：当前 mock-suite 发布范围内，主资金链、fee gate、guarantee、单笔 liquidation、batch liquidation、view consistency、ops extension、easy staking 已具备真实网络正向证据。
- `严格口径成立`：dynamic fee 已经先完成链上正式预配置，再执行严格 round2 复验，因此当前结论不依赖 `ALLOW_DYNAMIC_FEE_WRITE=1`。
- `剩余风险为非功能性`：Arbitrum Sepolia RPC 仍可能出现 `HeadersTimeoutError`、`ECONNRESET` 一类 provider 抖动；这不属于本轮协议逻辑缺口。sweep 后残留的少量原生币差额应按 gas 消耗、relayer 保底金和 dust 理解，不应再解释为“未回流”。

## 本轮新增闭环点

1. [live-batch-liquidation-pressure-arbitrum-sepolia.ts](./live-batch-liquidation-pressure-arbitrum-sepolia.ts) 已补齐 batch liquidation / batch risk-query 压测证据。
2. [live-guarantee-events-datapush-arbitrum-sepolia.ts](./live-guarantee-events-datapush-arbitrum-sepolia.ts) 已补齐 guarantee 事件 / DataPush 全量对账证据。
3. preview 与真实 settle 的对账口径已明确为“事件 + DataPush + 余额守恒为 SSOT”，不再要求 block-sensitive preview 与实际落块执行逐最小单位完全相等。

## 后续文档位置

除本次运行总结外，其余说明统一以 [docs/Usage-Guide/runbook/Arbitrum-Sepolia-Live-Platform-Baseline-Runbook.md](../../../docs/Usage-Guide/runbook/Arbitrum-Sepolia-Live-Platform-Baseline-Runbook.md) 为准。
