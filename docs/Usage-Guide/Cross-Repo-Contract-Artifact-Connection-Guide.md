# 跨仓合约制品连接指南

本文用于说明下面四个仓当前是如何围绕合约制品连接在一起的，以及后续应该按什么顺序改动，避免再次出现“合约仓改了，但前后端和运维仓不知道如何同步”的情况。

适用仓库：

- 合约仓：/Volumes/AI-hosts/contracts
- 前端仓：/Volumes/AI-hosts/EasiFi-workspace/lending-frontend
- 后端仓：/Volumes/AI-hosts/EasiFi-workspace/lending-backend
- 运维仓：/Volumes/AI-hosts/EasiFi-workspace/infra-devops

## 1. 总体原则

这四个仓的关系必须固定成下面的单向链路：

1. 合约仓是 SSOT，负责生成共享制品。
2. 前端仓和后端仓只消费合约仓产物，不再各自手写第二份 ABI、module keys 或 selector 映射。
3. 运维仓不重新解释协议语义，只负责在部署和 CI 中检查“是否真的按 SSOT 生成并同步了这些制品”。

一句话总结：

- 合约仓负责生成。
- 前后端仓负责消费。
- 运维仓负责治理和发布门禁。

## 2. 现在已经落地的连接关系

### 2.1 合约仓负责生成什么

合约仓目前已经承担下面这些共享制品的生成职责：

| 制品 | 作用 | 生成入口 | 输出位置 |
| --- | --- | --- | --- |
| module keys | 把 ModuleKeys.sol 里的 Registry key 变成前端/后端可消费产物 | `pnpm -s run generate:module-keys` | `frontend-config/moduleKeys.ts` |
| contract errors | 把关键 custom error selector 和语义收敛成共享映射 | `pnpm -s run generate:contract-errors` | `frontend-config/contractErrors.ts` |
| moduleKeys 校验 | 防止 `ModuleKeys.sol` 改了但产物没同步，或多行 key 再次漏掉 | `pnpm -s run check:module-keys-artifact` | 校验脚本，无产物 |

当前关键文件：

- `frontend-config/scripts/generateModuleKeys.ts`
- `frontend-config/moduleKeys.ts`
- `scripts/generateContractErrors.ts`
- `frontend-config/contractErrors.ts`
- `scripts/checks/check-module-keys-artifact.ts`

### 2.2 前端仓如何连接合约仓

前端仓当前不是直接在运行时去读合约仓源码，而是通过“本地生成后的 runtime manifest”来消费合约制品。

连接链路如下：

1. 前端脚本 `scripts/generateContractsRuntimeManifest.ts` 从合约仓读取：
   - `src/constants/ModuleKeys.sol`
   - `deployments/<network>.json`
   - `types/` 里的 TypeChain 产物
   - `frontend-config/contractErrors.ts`
2. 前端把这些内容同步成本仓 generated 制品：
   - `src/services/config/generated/contractsRuntimeManifest.ts`
   - `src/services/config/generated/contractsRuntimeArtifacts.ts`
   - `src/services/config/generated/contractsRuntimeErrors.ts`
   - `src/services/config/generated/typechain/`
3. 前端运行时统一从下面这些入口消费：
   - `src/services/config/contractsArtifactSource.ts`
   - `src/services/config/moduleKeys.ts`
   - `src/utils/contractErrors.ts`

当前已经落地的关键点：

- 前端自己的 manifest 生成脚本已经修复为支持多行 `ModuleKeys.sol` 声明，不会再次漏掉 blocks-only keys。
- 前端 `src/services/config/moduleKeys.ts` 已经正式暴露：
  - `KEY_BLOCKS_ONLY_COORDINATOR`
  - `KEY_BLOCKS_ONLY_VIEW`
  - `KEY_LENDER_POOL_VAULT`
- 前端 `src/utils/contractErrors.ts` 已经改成消费共享的 `contractsRuntimeErrors.ts`，不再维护独立手写 selector 表。
- 前端 CI 已新增 `pnpm ci:check-contract-artifacts`，用于检查 generated manifest、generated errors 和 moduleKeys 包装层里关键 direct-write 制品没有缺失。

前端仓当前关键文件：

- `scripts/generateContractsRuntimeManifest.ts`
- `src/services/config/generated/contractsRuntimeManifest.ts`
- `src/services/config/generated/contractsRuntimeArtifacts.ts`
- `src/services/config/generated/contractsRuntimeErrors.ts`
- `src/services/config/generated/typechain/`
- `src/services/config/contractsArtifactSource.ts`
- `src/services/config/moduleKeys.ts`
- `src/utils/contractErrors.ts`
- `scripts/ci/check-contract-artifacts.ts`
- `.github/workflows/ci.yml`

### 2.3 后端仓如何连接合约仓

后端仓目前没有像前端那样同步整套 ABI 和 TypeChain，而是先接入了“错误语义共享层”。这符合当前状态，因为后端最缺的是统一的 contract error 解码，而不是浏览器级合约实例工厂。

连接链路如下：

1. 后端脚本 `scripts/generateContractRuntimeErrors.ts` 从合约仓读取：
   - `frontend-config/contractErrors.ts`
2. 后端把它同步到：
   - `src/generated/contractsRuntimeErrors.ts`
3. 后端统一通过：
   - `src/errors/ContractErrorDecoder.ts`
   来做 `error.data` / `info.error.data` / revert hex selector 的统一解码。

当前已经落地的关键点：

- 后端已经有共享 error artifact 同步脚本。
- 后端已经有统一的 `ContractErrorDecoder.ts`，不必再在各个 worker、API 或 reconciliation 服务里各自写 selector 表。
- 后端 CI 已新增 `pnpm ci:check:contract-artifacts`，用于检查共享 error artifact 至少包含钱包直连和 blocks-only 所需的关键错误。

后端仓当前关键文件：

- `scripts/generateContractRuntimeErrors.ts`
- `src/generated/contractsRuntimeErrors.ts`
- `src/errors/ContractErrorDecoder.ts`
- `scripts/ci/check-contract-artifacts.ts`
- `.github/workflows/ci.yml`

### 2.4 运维仓如何连接合约仓

运维仓不负责生成新的协议语义，它的职责是确保部署前真的跑过“生成 + 校验”这条链路。

当前连接链路如下：

1. 部署脚本 `deployment/scripts/deploy-contracts.sh` 在真正部署前，会先进入合约仓并执行：
   - `pnpm -s run generate:module-keys`
   - `pnpm -s run generate:contract-errors`
   - `pnpm -s run check:module-keys-artifact`
2. 运维 CI 通过：
   - `scripts/ci/check-contract-artifact-governance.sh`
   - `.github/workflows/ci.yml`
   来检查这几个门禁命令确实仍然挂在部署链路上。

当前已经落地的关键点：

- 运行部署脚本前会先刷新共享制品。
- 运维治理脚本会检查部署流程里是否保留了共享制品门禁。
- 如果本机能访问合约仓，还会实际运行合约仓的 moduleKeys 校验并确认 `frontend-config/contractErrors.ts` 存在。

运维仓当前关键文件：

- `deployment/scripts/deploy-contracts.sh`
- `scripts/ci/check-contract-artifact-governance.sh`
- `.github/workflows/ci.yml`

## 3. 这四个仓现在怎么配合工作

### 日常改动顺序

如果协议层新增了 key、错误码、ABI 字段或 direct-write 入口，正确顺序必须是：

1. 先改合约仓源码。
2. 在合约仓重新生成：
   - `moduleKeys.ts`
   - `contractErrors.ts`
3. 再去前端仓同步 runtime manifest / runtime errors / typechain subset。
4. 再去后端仓同步 contract errors 产物。
5. 最后由运维仓部署前门禁和 CI 进行确认。

不能倒过来做。前后端仓也不应该先手写兼容逻辑，再等合约仓补产物。

### 变更责任边界

| 场景 | 应该改哪个仓 | 不应该改哪个仓 |
| --- | --- | --- |
| 新增 ModuleKey | 合约仓 | 前后端仓不要手写新 keccak |
| 新增 custom error 或变更错误语义 | 合约仓 | 前后端仓不要各自维护第二份 selector 表 |
| 钱包直连页面如何展示错误 | 前端仓 | 合约仓不负责 UI 文案分层 |
| worker / API 如何归类链上 revert | 后端仓 | 合约仓不负责后端业务流程分支 |
| 部署前是否执行产物门禁 | 运维仓 | 前后端仓不要替代部署门禁 |

## 4. 当前仍然需要继续完成的部分

虽然连接关系已经搭好，但还有两块属于“下一步工程工作”，不是这次制品治理本身：

### 前端还需要继续做

前端已经有共享 error-map 和 moduleKeys 产物了，但还需要把这些能力真正接到业务页面和 wallet-direct 写交易 UX：

1. 在成交、还款、blocks-only 到期处理、AI Credits 购买等页面，把 `contractErrors.ts` 解码结果映射成统一 UX 文案和重试策略。
2. 把关键 selector 映射到页面动作，例如：
   - `SettlementIntentLib__IntentExpired` -> 重新签名
   - `VaultBusinessLogic__InsufficientCollateral` -> 引导先补抵押
   - `BlocksOnlyCoordinator__NotMatured` -> 提示尚未到 maturityBlock
3. 把 blocks-only 新增的 key 真正接入启动 preflight 和运行时 Registry 解析。

### 后端还需要继续做

后端已经有共享 error decoder 了，但还需要把它接入真实业务出口：

1. 在 write API、command worker、reconcile worker 里统一使用 `ContractErrorDecoder.ts`。
2. 把 decode 结果写入：
   - API 错误响应
   - command execution 审计日志
   - metrics / tracing 标签
3. 对 direct-write 相关错误建立明确的 retry / no-retry 分类，而不是全部按“链上失败”粗处理。

## 5. 推荐的验证动作

每次改完以后，至少跑下面这些命令：

### 合约仓

- `pnpm -s run generate:module-keys`
- `pnpm -s run generate:contract-errors`
- `pnpm -s run check:module-keys-artifact`

### 前端仓

- `pnpm -s run generate:contracts-runtime-manifest`
- `pnpm -s run ci:check-contract-artifacts`

### 后端仓

- `pnpm -s run generate:contract-errors`
- `pnpm -s run ci:check:contract-artifacts`

### 运维仓

- `bash scripts/ci/check-contract-artifact-governance.sh`

## 6. 判断是否“真正连通”的标准

只有同时满足下面几点，才能认为这四个仓的连接关系是健康的：

1. 合约仓新增的 ModuleKey 和 custom error 能在前端、后端产物里同步出现。
2. 前端不再手写第二份 error selector 表。
3. 后端不再手写第二份 error selector 表。
4. 运维仓部署前会强制执行合约制品门禁。
5. 钱包直连和 blocks-only 的关键 key 缺失时，前后端和运维都能在 CI 或 preflight 阶段阻断，而不是线上才报错。

如果未来你再看到某个仓打算“临时手写一个 selector / key / 地址字符串 先跑起来”，那就说明这个连接关系又开始偏离 SSOT 了，应当优先回到合约仓产物链修正。