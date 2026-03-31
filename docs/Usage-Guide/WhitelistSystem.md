# RWA 借贷平台白名单系统使用指南

## 1. 文档目的

本文档描述当前仓库里已经存在并可验证的白名单系统，不再使用“示例实现”或“未来可选实现”的写法。

当前白名单体系分成三类，职责必须严格区分：

1. 地址白名单：`WhitelistRegistry`，用于“账户成员资格”判定。
2. 资产白名单：`AssetWhitelist`，用于“资产是否允许进入协议主路径”判定。
3. 权威机构白名单：`AuthorityWhitelist`，用于“机构名称是否被认可”判定。

其中，当前你要求的“全局资产集合白名单”，对应的就是 `AssetWhitelist`。

## 2. 当前代码中的真实结构

### 2.1 核心实现与接口

当前仓库里已经存在以下正式实现，不需要再单独“自行实现一个 WhitelistRegistry 示例版”：

1. `src/access/WhitelistRegistry.sol`
2. `src/access/AssetWhitelist.sol`
3. `src/AuthorityWhitelist.sol`

对应接口族如下：

1. `src/interfaces/IWhitelistRegistryRead.sol`
2. `src/interfaces/IWhitelistRegistry.sol`
3. `src/interfaces/IAssetWhitelistRead.sol`
4. `src/interfaces/IAssetWhitelistAdmin.sol`
5. `src/interfaces/IAssetWhitelist.sol`

对应模块键如下：

1. `ModuleKeys.KEY_WHITELIST_REGISTRY`
2. `ModuleKeys.KEY_ASSET_WHITELIST`
3. `ModuleKeys.KEY_AUTHORITY_WHITELIST`

这些模块都通过 `Registry` 注册和解析，`Registry` 仍然是模块地址的单一事实来源。

### 2.2 Registry 映射关系

当前结构应理解为：

```text
Registry
    ├── KEY_WHITELIST_REGISTRY  -> WhitelistRegistry
    ├── KEY_ASSET_WHITELIST     -> AssetWhitelist
    └── KEY_AUTHORITY_WHITELIST -> AuthorityWhitelist
```

业务模块不应硬编码白名单实现地址，而应通过 `Registry.getModule(...)` 或 `Registry.getModuleOrRevert(...)` 解析。

## 3. 三类白名单的职责边界

### 3.1 WhitelistRegistry：地址白名单

`WhitelistRegistry` 是“账户地址集合”的集中注册表，实现位于 `src/access/WhitelistRegistry.sol`。

它当前已经具备完整的链上管理能力，而不是只读接口：

1. `isWhitelisted(address)`
2. `getWhitelistedAccounts()`
3. `getWhitelistedCount()`
4. `addAddress(address)`
5. `removeAddress(address)`
6. `batchAddAddresses(address[])`
7. `batchRemoveAddresses(address[])`
8. `setRegistry(address)`

管理权限通过 `AccessControlManager` + `ActionKeys` 控制：

1. `ACTION_ADD_WHITELIST`
2. `ACTION_REMOVE_WHITELIST`
3. `ACTION_SET_PARAMETER`
4. `ACTION_UPGRADE_MODULE`

注意：截至当前代码检索结果，核心借贷主路径里没有发现已接入 `KEY_WHITELIST_REGISTRY` 的协议业务模块。也就是说，`WhitelistRegistry` 当前是“已实现的能力”，但不是“已确认接入借贷主路径的事实”。文档不能把它写成现在所有存取款/借还款都会自动检查。

### 3.2 AssetWhitelist：全局资产集合白名单

`AssetWhitelist` 位于 `src/access/AssetWhitelist.sol`，这是当前仓库里真实存在、并且已经接入协议主路径的资产级白名单模块。

它的职责是：判断某个资产地址是否允许进入协议资金路径。

当前它提供两类接口：

读接口：

1. `isAssetAllowed(address)`
2. `getAllowedAssets()`
3. `getAssetCount()`
4. `getAssetAtIndex(uint256)`
5. `getRegistry()`

管理接口：

1. `addAllowedAsset(address)`
2. `removeAllowedAsset(address)`
3. `batchAddAllowedAssets(address[])`
4. `batchRemoveAllowedAssets(address[])`
5. `updateAssetInfo(address)`
6. `setRegistry(address)`

权限同样通过 `AccessControlManager` + `ActionKeys` 控制。

对当前产品规划而言，这个模块就是“全局资产集合白名单”的第一阶段落点：

1. 每新增一种 RWA 资产，先进入 `AssetWhitelist`。
2. 只有进入该白名单的资产，才允许被当前主路径识别为可用资产。
3. 后续如果社区治理和产品矩阵足够成熟，才再拆分成独立产品注册表或更细粒度产品目录。

### 3.3 AuthorityWhitelist：权威机构白名单

`AuthorityWhitelist` 位于 `src/AuthorityWhitelist.sol`，用于管理“机构名称”白名单，而不是资产地址、也不是用户地址。

它适合承载：

1. 评级机构
2. 认证机构
3. 审核机构

因此它和“全局资产集合白名单”不是一回事，不能混用。

## 4. 全局资产集合白名单

### 4.1 当前定义

如果你现在要在平台上采用“先由治理侧统一准入，再允许新 RWA 产品进入协议”的方案，那么当前代码里的全局资产集合白名单就是：

1. 模块：`AssetWhitelist`
2. 模块键：`KEY_ASSET_WHITELIST`
3. 读接口：`IAssetWhitelistRead`
4. 管理接口：`IAssetWhitelistAdmin`

### 4.2 当前语义

当前语义应写清楚为：

1. 它是“协议级资产准入集合”。
2. 它解决的是“这个资产能不能进入协议路径”的问题。
3. 它不自动等价于“这个资产已经拥有完整独立产品配置”。
4. 它也不自动等价于“任何人都能像 Uniswap 一样无许可上架资产”。

换句话说，资产被加入 `AssetWhitelist`，表示它通过了当前阶段的全局准入门槛；但如果未来某个具体产品还需要额外参数、额外风控或独立目录，那些能力仍需要单独实现。

### 4.3 当前已验证的链上调用方

根据当前仓库代码检索，已经确认会读取 `AssetWhitelist` 的协议模块有：

1. `src/Vault/VaultRouter.sol`
2. `src/Vault/modules/VaultBusinessLogic.sol`
3. `src/libraries/SettlementMatchLib.sol`

它们的作用分别是：

1. `VaultRouter`：在资产相关入口处做基础资产合法性校验，内部通过 `_validateAsset` 调用 `isAssetAllowed(asset)`。
2. `VaultBusinessLogic`：在业务编排层通过 `_checkAssetWhitelist` 对资产做白名单校验。
3. `SettlementMatchLib`：在撮合结算路径里通过 `_checkAssetWhitelist` 对资产做白名单校验。

这意味着 `AssetWhitelist` 已经不是“预留能力”，而是当前借贷/撮合主链路中的真实门禁。

### 4.4 当前未验证接入的范围

截至当前代码检索结果，未发现以下事实可以被文档直接宣称：

1. 所有协议模块都统一接入了 `AssetWhitelist`。
2. `WhitelistRegistry` 已经在核心借贷主路径中普遍生效。
3. 任意新资产只要加入 `AssetWhitelist` 就自动具备完整市场、奖励、清算、产品目录等全部能力。

因此本文档只能把这些写成“后续可扩展方向”，不能写成当前已实现行为。

## 5. 部署与管理方式

### 5.1 测试网上线的实际部署方式

当前仓库里，白名单相关模块在测试网和本地环境都不是按“普通合约直接 deploy”方式部署，而是按 UUPS 代理方式部署。

以测试网部署脚本 `scripts/deploy/deploy-arbitrum-sepolia.ts` 为准，当前白名单相关模块的部署事实是：

1. `AssetWhitelist` 通过 `deployProxy('AssetWhitelist', [deployed.Registry])` 部署。
2. `WhitelistRegistry` 通过 `deployProxy('WhitelistRegistry', [deployed.Registry])` 部署。
3. `AuthorityWhitelist` 通过 `deployProxy('AuthorityWhitelist', [deployed.Registry])` 部署。

这意味着文档或运维流程里不应再使用“直接部署一个普通 WhitelistRegistry 合约即可”的表述。

### 5.2 Registry 注册与上线后核验

测试网部署脚本不会只部署白名单模块地址，还会把已部署模块注册到 `Registry`。

当前测试网脚本的做法是：

1. 维护 `NAME_TO_KEY` 映射。
2. 遍历已部署模块。
3. 对每个已部署模块调用 `registry.setModule(keyOf(upperSnake), addr)` 完成注册。

对白名单系统而言，当前实际注册键包括：

1. `WHITELIST_REGISTRY`
2. `ASSET_WHITELIST`
3. `AUTHORITY_WHITELIST`

因此，测试网上线后的最小核验顺序应是：

1. 先检查白名单模块代理地址已部署。
2. 再检查 `Registry.getModuleOrRevert(...)` 解析出的地址是否与部署地址一致。
3. 对 `WhitelistRegistry` 至少执行一次只读核验：`getRegistry()` 与 `isWhitelisted(...)`。
4. 对 `AssetWhitelist` 至少执行一次只读核验：`isAssetAllowed(asset)`。

仓库中已有可参考的核验脚本模式：

1. `scripts/tests/whitelist-registry-smoke-local.ts` 展示了 `WhitelistRegistry` 的只读与读写 smoke 校验方式。
2. `scripts/tests/preconfig-strict-smoke-local.ts` 展示了通过 `Registry` 解析 `ASSET_WHITELIST` 后，使用 `IAssetWhitelistRead` / `IAssetWhitelistAdmin` 进行校验和配置的方式。

需要注意的是：当前仓库名称上明确提供的是 localhost smoke 脚本，而不是独立命名的 testnet whitelist smoke 脚本。因此在测试网上线时，文档只能说“沿用同样的核验模式”，不能声称仓库里已经有专门的 sepolia 白名单上线脚本。

### 5.3 测试网上线执行清单

如果当前目标是 Arbitrum Sepolia 测试网上线，建议按下面顺序执行。

#### 第一步：编译

```bash
pnpm run -s compile
```

#### 第二步：执行测试网部署脚本

当前仓库没有在 `package.json` 里提供独立的 `deploy:arbitrum-sepolia` 脚本别名，因此应直接执行部署脚本：

```bash
pnpm -s exec hardhat run scripts/deploy/deploy-arbitrum-sepolia.ts --network arbitrum-sepolia
```

部署完成后，至少应确认以下三类白名单模块已经产出有效地址并被部署：

1. `WhitelistRegistry`
2. `AssetWhitelist`
3. `AuthorityWhitelist`

#### 第三步：核对 Registry 注册结果

上线后的第一批只读核对，至少应覆盖：

1. `Registry.getModuleOrRevert(WHITELIST_REGISTRY)`
2. `Registry.getModuleOrRevert(ASSET_WHITELIST)`
3. `Registry.getModuleOrRevert(AUTHORITY_WHITELIST)`

其返回地址应与部署产物中的代理地址一致。

#### 第四步：执行白名单 smoke 模式核验

当前仓库没有专门命名为 sepolia 的白名单 smoke 脚本，但已有脚本已经给出了权威核验模式：

1. `scripts/tests/whitelist-registry-smoke-local.ts`
2. `scripts/tests/preconfig-strict-smoke-local.ts`

测试网上线时，应沿用这两个脚本的检查逻辑，而不是继续依赖旧文档中的手写示例部署片段。

#### 第五步：资产准入前置检查

如果某个新资产准备在测试网上接入协议，建议按以下顺序做治理侧检查：

1. 确认该资产地址已加入 `AssetWhitelist`。
2. 确认协议路径能通过 `isAssetAllowed(asset)` 返回 `true`。
3. 确认该资产若涉及其他产品级配置，其余配置也已完成。

### 5.4 测试网上线后人工验收 checklist

下面这份 checklist 的目标不是“再讲一遍原理”，而是让上线人员、前端和监控同学在测试网上线后能逐项勾选。

#### A. Registry 绑定检查

- [ ] `Registry.getModuleOrRevert(WHITELIST_REGISTRY)` 返回的地址与部署产物中的 `WhitelistRegistry` 代理地址一致。
- [ ] `Registry.getModuleOrRevert(ASSET_WHITELIST)` 返回的地址与部署产物中的 `AssetWhitelist` 代理地址一致。
- [ ] `Registry.getModuleOrRevert(AUTHORITY_WHITELIST)` 返回的地址与部署产物中的 `AuthorityWhitelist` 代理地址一致。
- [ ] 对白名单模块做一次链上 code 检查，确认返回地址不是空地址、也不是无代码地址。

#### B. WhitelistRegistry 只读检查

- [ ] `WhitelistRegistry.getRegistry()` 返回值等于当前 `Registry` 地址。
- [ ] `WhitelistRegistry.getWhitelistedCount()` 能正常返回，且不异常 revert。
- [ ] 对一个明确应在白名单内的地址调用 `isWhitelisted(account)`，返回值符合预期。
- [ ] 对一个随机未登记地址调用 `isWhitelisted(account)`，返回值为 `false`。

#### C. AssetWhitelist 只读检查

- [ ] `AssetWhitelist.getRegistry()` 返回值等于当前 `Registry` 地址。
- [ ] `AssetWhitelist.getAssetCount()` 能正常返回，且与当前 allowlist 预期规模一致。
- [ ] `AssetWhitelist.getAllowedAssets()` 能正常返回，不异常 revert。
- [ ] 对 settlement token 调用 `isAssetAllowed(asset)`，结果符合预期。
- [ ] 对准备上线的目标 RWA 资产调用 `isAssetAllowed(asset)`，结果符合预期。
- [ ] 如需更细核对，可读取 `getAssetInfo(asset)`，确认 `isActive/addedAt/lastUpdated` 等 bookkeeping 字段符合预期。

#### D. 事件验收

- [ ] 部署完成后，检查 `VaultRouterInitialized(registry, assetWhitelist)` 事件，确认初始化时传入的 `assetWhitelist` 地址符合预期。
- [ ] 单资产加入白名单时，应看到 `AssetAdded(actionKey, asset, addedBy, blockNumber)`。
- [ ] 单资产移出白名单时，应看到 `AssetRemoved(actionKey, asset, removedBy, blockNumber)`。
- [ ] 批量加入资产时，应看到 `AssetsBatchAdded(...)`。
- [ ] 批量移出资产时，应看到 `AssetsBatchRemoved(...)`。
- [ ] 单地址加入地址白名单时，应看到 `AddressAdded(account, operator, blockNumber)`。
- [ ] 单地址移出地址白名单时，应看到 `AddressRemoved(account, operator, blockNumber)`。
- [ ] 批量地址操作时，应看到 `AddressesBatchAdded(...)` 或 `AddressesBatchRemoved(...)`。
- [ ] 任一治理写操作完成后，应同时能看到 `SystemEvents.ActionExecuted(...)`。

#### E. DataPush 验收

- [ ] 资产单条加入时，链下解码可看到 `DATA_TYPE_ASSET_WHITELIST_ADDED`。
- [ ] 资产单条移除时，链下解码可看到 `DATA_TYPE_ASSET_WHITELIST_REMOVED`。
- [ ] 资产批量加入时，链下解码可看到 `DATA_TYPE_ASSET_WHITELIST_BATCH_ADDED`。
- [ ] 资产批量移除时，链下解码可看到 `DATA_TYPE_ASSET_WHITELIST_BATCH_REMOVED`。
- [ ] 若执行 `updateAssetInfo(asset)`，链下应同步看到资产信息更新相关事件或 DataPush，不应只看到链上状态变更而链下完全静默。

#### F. 真实路径验收

- [ ] 对一个已 allowlist 的资产执行一次最小真实路径探测，确认协议主路径不会因为白名单而误拒绝。
- [ ] 对一个未 allowlist 的资产执行一次只读或可控探测，确认主路径能稳定给出拒绝信号，而不是静默错误。
- [ ] 若本次上线涉及替换 `AssetWhitelist` 地址，必须额外确认 `VaultRouter` 的行为是否已经与新地址一致。

说明：当前 `VaultRouter` 没有公开 getter 直接返回缓存的 `_assetWhitelistAddr`，因此这一步不能依赖假想读函数，而应依赖两类证据：

1. 部署阶段的 `VaultRouterInitialized` 事件。
2. 白名单资产与非白名单资产的真实行为探测结果。

#### G. 失败信号 checklist

下面这些信号一旦出现，不应被当作“偶发文案错误”，而应直接进入排查：

- [ ] `Registry.getModuleOrRevert(...)` 直接失败，说明模块未注册或注册地址失效。
- [ ] `isAssetAllowed(asset) == false`，但该资产本应已上线，说明资产准入未真正完成。
- [ ] `AssetNotAllowed()` 出现在 `VaultRouter`、`VaultBusinessLogic` 或 `SettlementMatchLib` 路径，说明主路径仍拒绝该资产。
- [ ] `WhitelistRegistry__AlreadyWhitelisted(account)`，说明重复添加同一地址。
- [ ] `WhitelistRegistry__NotWhitelisted(account)`，说明移除或检查对象状态和预期不一致。
- [ ] `WhitelistRegistry__EmptyAccountsArray()`，说明批量参数为空。
- [ ] `AssetWhitelist__AssetAlreadyAllowed(asset)`，说明重复加入同一资产。
- [ ] `AssetWhitelist__AssetNotAllowed(asset)`，说明移除或更新的资产并不在 allowlist 中。
- [ ] `AssetWhitelist__EmptyAssetsArray()`，说明批量资产参数为空。
- [ ] `AssetWhitelist__IndexOutOfBounds(index, length)`，说明链下枚举逻辑与链上长度不一致。
- [ ] `ZeroAddress()` 或 `NotAContract(...)`，说明部署参数、Registry 地址或模块地址本身就有问题。
- [ ] 治理写操作因 `AccessControlManager.requireRole(...)` 失败而 revert，说明 `ADD_WHITELIST`、`REMOVE_WHITELIST`、`SET_PARAMETER` 等角色未正确授权。

### 5.5 运行时生效范围与运维注意事项

当前代码里，`AssetWhitelist` 的运行时消费方式并不完全一致：

1. `VaultBusinessLogic` 和 `SettlementMatchLib` 会在运行时通过 `Registry` 解析白名单模块。
2. `VaultRouter` 则在初始化时缓存 `initialAssetWhitelist` 到本地存储 `_assetWhitelistAddr`，并直接使用该缓存地址做资产校验。

这带来一个非常具体的运维含义：

1. 如果只是替换 `Registry` 中的 `KEY_ASSET_WHITELIST`，并不自动保证 `VaultRouter` 会同步切换到新白名单地址。
2. 文档不能把“替换 Registry 模块地址”写成“所有资产白名单调用方都会自动切换”。
3. 测试网上线后若计划替换 `AssetWhitelist` 实现或地址，必须额外评估 `VaultRouter` 的缓存地址影响。

这一点是当前代码的真实行为，不是未来假设。

### 5.6 AssetWhitelist 管理

当前 `AssetWhitelist` 已具备正式治理接口，不需要再写“假设你的实现合约有 add/remove 方法”。

典型治理动作如下：

1. `addAllowedAsset(asset)`：新增一个资产。
2. `removeAllowedAsset(asset)`：移除一个资产。
3. `batchAddAllowedAssets(assets)`：批量新增资产。
4. `batchRemoveAllowedAssets(assets)`：批量移除资产。
5. `updateAssetInfo(asset)`：刷新资产的治理侧 bookkeeping 信息。

这些写操作都要求通过 `Registry` 解析 `AccessControlManager` 并完成权限校验。

### 5.7 WhitelistRegistry 管理

当前 `WhitelistRegistry` 也已经是正式可管理实现，不需要“用户自己再实现管理函数”。

可直接使用的治理动作如下：

1. `addAddress(account)`
2. `removeAddress(account)`
3. `batchAddAddresses(accounts)`
4. `batchRemoveAddresses(accounts)`
5. `setRegistry(newRegistryAddr)`

### 5.8 事件与审计

这两个模块都已经具备较完整的事件审计能力：

1. `WhitelistRegistry` 会发出地址增删和批量变更事件。
2. `AssetWhitelist` 会发出资产增删、批量变更、资产信息更新事件。
3. 两者都会发出 `SystemEvents.ActionExecuted`。
4. `AssetWhitelist` 还会通过 `DataPushLibrary` 发出资产白名单变更数据推送事件。

因此运维和索引侧应优先消费真实链上事件，而不是依赖手工维护的离线名单。

## 6. 使用建议

### 6.1 新增 RWA 资产的当前推荐流程

现阶段推荐流程应写成：

1. 治理侧审核待接入的 RWA 资产。
2. 审核通过后，将资产地址写入 `AssetWhitelist`。
3. 由协议业务模块通过 `KEY_ASSET_WHITELIST` 在运行时做统一校验。
4. 如某个产品需要额外产品级配置，再在该产品模块中单独补充。

### 6.2 文档上不应再写的内容

以下写法在当前仓库语义下是不准确的，后续不要再继续使用：

1. “WhitelistRegistry 需要项目方自行实现。”
2. “VaultCore 的存款、借款、还款、提款默认都由地址白名单统一 gate。”
3. “只要注册 `KEY_WHITELIST_REGISTRY`，协议主路径就已经自动接入地址白名单。”
4. “AssetWhitelist 只是一个附属示例白名单。”

## 7. 故障排查

### 7.1 资产被拒绝

可能原因：

1. 资产地址未加入 `AssetWhitelist`。
2. Registry 中 `KEY_ASSET_WHITELIST` 未正确注册。
3. 调用方使用了错误的资产地址。

检查顺序建议：

1. 检查 Registry 中 `KEY_ASSET_WHITELIST` 指向的模块地址。
2. 检查 `isAssetAllowed(asset)` 返回值。
3. 再检查业务模块自身是否还有额外限制。

### 7.2 地址白名单未生效

可能原因：

1. `WhitelistRegistry` 虽然存在，但当前业务路径没有接入它。
2. 相关模块只接入了 `AssetWhitelist`，没有接入账户白名单检查。
3. 文档或前端错误地假设“所有路径都会自动检查地址白名单”。

### 7.3 模块未注册

如果 `Registry.getModuleOrRevert(...)` 失败，通常表示对应白名单模块尚未注册到 Registry，或注册地址已经失效。

## 8. 结论

当前仓库里的白名单系统不是单一模块，而是三类不同职责的白名单并存。

其中，对你当前产品规划最关键的结论是：

1. “全局资产集合白名单”在现有代码里应落到 `AssetWhitelist`。
2. `AssetWhitelist` 已经接入当前借贷/撮合主路径，是当前真实生效的资产准入门槛。
3. `WhitelistRegistry` 已有实现，但目前没有证据表明它已经成为核心借贷主路径的统一账户门禁。
4. 因此，现阶段文档应以 `AssetWhitelist` 作为新 RWA 资产准入的 SSOT，而不要把地址白名单写成当前主路径的既成事实。
