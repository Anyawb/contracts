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

如果上游公共 RPC 不稳定，可以显式指定单个 RPC：

```bash
BNB_FORK_UPSTREAM_RPC_URL=<your_archive_like_rpc> \
pnpm -s run test:live:fork:bnb-testnet
```

如果你想要“私有 RPC 优先 + 公共池兜底”的自动切换，推荐这样配：

```bash
BNB_FORK_PRIVATE_RPC_URLS="https://<private-rpc-1>,https://<private-rpc-2>" \
BNB_FORK_RPC_POOL_URLS="https://<public-rpc-a>,https://<public-rpc-b>" \
BNB_FORK_UPSTREAM_CHAIN_ID=97 \
BNB_FORK_RUN_MAX_ATTEMPTS=6 \
pnpm -s run test:live:fork:bnb-testnet
```

说明：

- `BNB_FORK_PRIVATE_RPC_URLS`: 私有 RPC 列表，优先级最高（支持逗号或换行分隔）
- `BNB_FORK_RPC_POOL_URLS`: 公共/备用 RPC 列表，会排在私有 RPC 后面
- `BNB_FORK_UPSTREAM_CHAIN_ID`: 上游探测链 ID，BNB Testnet 默认 `97`
- `BNB_FORK_RPC_PROBE_TIMEOUT_MS`: 单个 RPC 探测超时（默认 `8000`）
- `BNB_FORK_RPC_POOL_START_INDEX`: 从池中哪个下标开始探测（默认 `0`）

runner 在每次 run attempt 开始前会先探测池中 RPC，选健康节点启动 fork；如果运行期间出现 429/连接重置/节点不可达，会在下一次重试自动切到池里的下一个 RPC。