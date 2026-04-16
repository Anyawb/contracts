# Fork Test README

当前 fork 自动化统一收敛到：

- `scripts/tests/fork-test/networks/arbitrum-sepolia/`
- `scripts/tests/fork-test/networks/bnb-testnet/`

这里没有“默认网络”概念：每条 fork 入口都对应一条明确的目标链。

原则很简单：

1. fork runner 放在 `scripts/tests/fork-test/`
2. live wrapper 继续放在 `scripts/tests/live-test/networks/<network>/`
3. fork runner 只负责起本地 fork node、重定向网络 RPC、落盘日志，再调用正式 live/test wrapper

## Arbitrum Sepolia

当前入口：

- `pnpm -s run demo:backend-required:block:fork`
- `pnpm -s run test:smoke:multi-stablecoin:fork`

对应脚本：

- `scripts/tests/fork-test/networks/arbitrum-sepolia/backend-required-block.autonode.ts`
- `scripts/tests/fork-test/networks/arbitrum-sepolia/smoke-multi-stablecoin.autonode.ts`

## BNB Testnet

当前入口：

- `pnpm -s run test:live:fork:bnb-testnet`
- `pnpm -s run test:live:platform-baseline:fork:bnb-testnet`
- `pnpm -s run test:live:release-gates:fork:bnb-testnet`
- `pnpm -s run test:live:blocks-only-state-machine:fork:bnb-testnet`
- `pnpm -s run test:live:blocks-only-state-machine:layer-a:fork:bnb-testnet`
- `pnpm -s run test:live:blocks-only-state-machine:layer-b:fork:bnb-testnet`

对应脚本：

- `scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts`
- `scripts/tests/fork-test/networks/bnb-testnet/blocks-only-state-machine.layer-a.autonode.ts`
- `scripts/tests/fork-test/networks/bnb-testnet/blocks-only-state-machine.layer-b.autonode.ts`

默认会串行跑：

- `preflight`
- `warmup`
- `platform-baseline`
- `release-gates`

如果只想跑部分 case：

```bash
BNB_FORK_AUTONODE_CASES=preflight,platform-baseline \
pnpm -s run test:live:fork:bnb-testnet
```

如果上游公共 RPC 不稳定，可以显式指定：

```bash
BNB_FORK_UPSTREAM_RPC_URL=<your_archive_like_rpc> \
pnpm -s run test:live:fork:bnb-testnet
```