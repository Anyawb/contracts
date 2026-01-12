# Registry / RegistryView 字节码大小报告（Scheme A 实验）

> 目的：在“单一 Proxy 入口（Registry）+ 共享 RegistryStorage”的 Scheme A 口径下，确保关键合约的 **deployed/runtime bytecode** 不触碰 EIP-170 的 24KB 上限。
>
> 说明：本报告的 `deployed` 指 **runtime code size（EIP-170）**；`creation` 为创建字节码（不含 constructor args，仅供参考）。

## 生成方式

在仓库根目录执行：

```bash
pnpm -s exec hardhat run scripts/check-registry-contract-size.ts
```

## 基线数据（从资金链分支切出实验分支后）

来源分支：`experiment/registry-scheme-a`（基于 `资金链` 的 `7be0d27`）

| 合约 | Deployed (bytes) | Deployed (KB) | Usage of 24KB | Creation (bytes) |
| --- | ---: | ---: | ---: | ---: |
| `Registry` | 17969 | 17.55 | 73.12% | 18209 |
| `RegistryDynamicModuleKey` | 16963 | 16.57 | 69.02% | 17203 |
| `Vault RegistryView` (`src/Vault/view/modules/RegistryView.sol:RegistryView`) | 10128 | 9.89 | 41.21% | 10368 |

## 当前数据（完成 Scheme A 最小改造后）

当前阶段的“代码组织改造”主要是：将 Registry 的 tests/compat 枚举逻辑抽到 `RegistryCompatQueryLibrary`，并让 `deploylocal` 默认不再部署 compat proxies。  
该改造 **不应显著影响** `Registry` 的 deployed bytecode；复测结果与基线一致（数值相同）。

## 结论（基线）
- `Registry` 实现合约字节码 **< 20KB**，当前处于可接受范围。
- 后续若引入更多“枚举/分页/聚合”能力，建议优先放到 **多个小 View**（而不是不断膨胀 `Registry` 或单一 `RegistryView`）。

