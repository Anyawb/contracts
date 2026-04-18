# 命名统一改造方案（安全版）

> 目标：在严格遵循架构职责边界的前提下推进命名统一。
> 核心原则：**先做纯改名，再做接口收敛**；第二阶段不是第一阶段的自动延伸，必须单独审计、单独验证、单独合入。
>
> 依据：
> - `docs/Architecture-Guide.md`
> - `docs/SmartContractStandard.md` §3.3.7（`View / Minimal / Basic / Adapter` 后缀语义唯一）

---

## 1. 总体原则

### 1.1 本方案拆分为两个独立阶段
- **阶段 1：纯改名**
	- 只允许做名称层面的整理，不做接口合并，不做依赖面重构，不引入新的共享接口收口。
- **阶段 2：接口收敛**
	- 仅在完成签名审计、职责审计、命名冲突审计后，才允许把重复局部接口抽到 `src/interfaces/` 或替换为既有共享接口。

### 1.1.1 规范一致性审计结论
- 本方案与 `SmartContractStandard.md` §3.3.7 及 `Architecture-Guide.md` 的方向一致，可继续作为命名治理基线。
- 本轮补强重点不是增加新的推荐名，而是把容易误用的边界显式写清：
	- 混合读写局部接口不得仅因想消灭 `Lite` 就直接升级为 `Minimal` / `Basic`。
	- `SystemRiskView` 是对外权威入口，但阈值配置 SSOT 仍是 `KEY_LIQUIDATION_CONFIG_MANAGER -> LiquidationConfigModule`。
	- `IPriceOracleRead` 仍是链上权威读取边界，`ValuationOracleView` 只是只读门面。
	- 单一写动作或极少量写动作的窄依赖，应优先评估动作裁剪接口命名。

### 1.1.2 当前仓库落地状态（2026-04）
- 以下阶段 2 共享只读边界已在 `src/interfaces/` 落地，并已被主要消费者接入：
	- `IHealthViewBasic`
	- `IPositionViewBasic`
	- `IStatisticsViewBasic`
	- `ISystemRiskView`
	- `IPriceOracleRead` 继续作为链上权威价格读取边界
- 当前主要视图消费者（如 `DashboardView`、`CacheOptimizedView`、`PreviewView`、`RiskView`、`HealthView`）已经按上述共享边界收敛，不再保留对应历史 `Lite` 只读局部接口。
- `ILiquidationConfigModuleLite` 仍按本方案保留为局部混合读写接口；该项尚未进入共享命名收敛，且不得描述为 `Minimal`/`Basic` 语义。
- 因此，本文后续阶段 1 / 阶段 2 规则继续作为治理与回归审计基线，同时也用于约束后续新增接口不得逆向漂移。

### 1.2 架构约束（必须始终成立）
- 任何命名调整都不得突破 `Architecture-Guide.md` 规定的职责边界。
- `Minimal` 只能表示“单一依赖方或极小依赖面”的最小必要接口，不能把多个不同调用场景强行并到一个名字下。
- 若某个只读子集当前只是单点或极小依赖面，优先使用 `Minimal` 或动作裁剪接口；只有在后续证明为稳定、多消费者共享子集后，才升级到 `Basic`。
- `Read` 不是通用的接口分层后缀；除 `SmartContractStandard.md` 已明确标准化的接口家族外，不得把它扩展成默认命名层级。
- `View` 只表示对外只读门面；`Minimal` 不等于“任意轻量接口”的通用后缀。
- Oracle 接口族必须遵循现有 `Read / Admin / Adapter / View` 分层，不能为了统一后缀重新发明一套命名。
- `SystemRiskView` 是 system-scoped risk 的对外权威只读入口；阈值配置 SSOT 仍锚定 `KEY_LIQUIDATION_CONFIG_MANAGER -> LiquidationConfigModule`，`LiquidationRiskManager` 只能承担聚合/透传语义，不能成为阶段 2 的默认共享归宿。
- `ValuationOracleView` 是价格/预言机只读门面；链上权威价格读取默认仍收敛到 `IPriceOracleRead`，且必须保留 freshness 与 `assetDecimals` 语义。
- 若局部接口只服务单一写动作或极少量写动作，优先采用动作裁剪接口命名，而不是把写接口塞进 `Minimal` / `Basic` / `View` 后缀体系。
- 已承担 `push*` 或 writer 语义的接口不得复用为只读 `View / Minimal / Basic` 命名目标；凡后缀已被写路径占用，必须先做冲突审计。

### 1.2.1 本轮按基线补强的显式约束
- 对应 `SmartContractStandard.md` §3.3.7.1：接口名必须与职责边界一一对应，不能把治理写入、只读查询、专用回写动作混进同一个“看起来更统一”的后缀体系。
- 对应 `SmartContractStandard.md` §3.3.7.2：`View / Minimal / Basic / Adapter` 后缀语义必须唯一；若仓库中某个名字已被 push / writer 接口占用，则该名字不得再作为只读收敛目标。
- 对应 `SmartContractStandard.md` §3.3.7.3：Oracle 家族必须继续区分权威源、适配层与只读门面；收敛时不得牺牲 freshness、`assetDecimals` 或 facade 层次。
- 对应 `Architecture-Guide.md`：`SystemRiskView` 与 `ValuationOracleView` 的对外门面职责只能加强，不能在命名治理过程中被弱化或并行化。

### 1.3 不变项
- 不改业务逻辑、权限逻辑、状态变量、存储布局、事件字段、错误参数、返回值语义。
- 不新增/删除外部函数，不修改外部函数签名。
- 不改模块 key / action key 常量值。
- 不为了命名统一新增额外外部调用、适配层、缓存层、分发层。

---

## 2. 阶段 1：纯改名

### 2.1 定义
- 阶段 1 仅处理“名字不规范”问题，不处理“接口重复”问题。
- 改动范围限定为：类型名、文件名、import 标识符、NatSpec 标题、注释中的旧称谓。
- 阶段 1 **禁止**将多个文件里的局部接口抽到共享目录。
- 阶段 1 **禁止**把一个局部接口替换为另一个现有共享接口，除非该共享接口已经被证明是同职责、同方法集、同权限假设，且有单独审计记录。

### 2.2 阶段 1 的通过标准
- 编译前后外部 ABI 不变。
- 编译前后函数 selector 不变。
- 编译前后外部调用路径不变。
- 编译前后缓存写入/读取路径、权限检查路径、best-effort push 路径不变。

### 2.3 阶段 1 的安全执行规则
- 优先处理**文件内局部接口名**，不跨文件抽象。
- 若目标名字已在仓库中被其他语义占用，则不得直接套用统一名，必须改成更精确的局部名字，或推迟到阶段 2。
- 若同名 `Lite` 接口在不同文件中方法集不同，则不得在阶段 1 中统一成一个共享名字。
- 对通用只读窄接口，阶段 1 优先改成更精确的 `...Minimal` 或动作裁剪接口名；不要把 `Read` 当成默认替代后缀。
- 对 Oracle 读接口，若未来目标是接入现有 `IPriceOracleRead`，该动作归入阶段 2，而不是阶段 1。
- 对少量写动作接口，阶段 1 不得为了去掉 `Lite` 而直接套用 `Minimal` / `Basic`；若后续要治理，必须在阶段 2 先评估动作裁剪接口名。

### 2.4 阶段 1 建议处理方式

> 下列为“安全版建议”，不是无条件全仓替换表。

- `ILiquidationConfigModuleLite`
	- **不建议**在阶段 1 直接改成 `ILiquidationConfigModuleMinimal`。
	- 原因：当前接口同时包含阈值读取与 `update*FromRiskManager(...)` 专用写入口，语义并非单纯“最小只读接口”。
	- 阶段 1 建议：默认保留局部名字；若要进一步提高清晰度，应在后续先拆分“阈值读取”和“RiskManager 专用回写”边界，再分别命名。
	- 阶段 2 预期命名方向：读侧才可评估 `ILiquidationConfigThresholdMinimal` 一类窄接口；写侧应优先评估 `ILiquidationConfigRiskManagerUpdate` 这类动作裁剪接口，而不是继续挂在 `Minimal` / `Basic` 名下。

- `IHealthViewLite`
	- **不得**直接全仓改成 `IHealthViewMinimal`。
	- 原因：仓库中已存在同名 `IHealthViewMinimal`，但其语义是写路径 push 接口，不是只读接口。
	- 阶段 1 建议：仅在各文件内部改为更精确的局部 `Minimal` 名字，例如 `IHealthViewHealthFactorMinimal`，但不做跨文件收口。

- `IPositionViewLite`
	- **不得**直接默认改成共享 `IPositionViewMinimal`。
	- 原因：当前仓库没有现成同语义共享名，且 `IPositionView` 现有共享接口并非纯只读窄接口。
	- 阶段 1 建议：按局部职责改为 `IPositionViewPositionMinimal` 一类的局部命名，不收敛。

- `IStatisticsViewLite`
	- **不得**直接全仓改成 `IStatisticsViewMinimal`。
	- 原因：`src/interfaces/IStatisticsViewMinimal.sol` 已被占用为写路径 push 接口。
	- 阶段 1 建议：局部改为 `IStatisticsViewGlobalMinimal` 一类名字，保留文件内定义。

- `ISystemRiskViewLite`
	- **不得**直接全仓改成单一的 `ISystemRiskViewMinimal`。
	- 原因：不同调用方依赖的方法集不同；有的只读 `getMinHealthFactor()`，有的同时依赖 `getMaxLtvBps()`。
	- 阶段 1 建议：保持按调用方粒度命名，例如 `ISystemRiskMinHealthMinimal`、`ISystemRiskThresholdMinimal` 等局部名字。

- `IPriceOracleLite`
	- **不建议**在阶段 1 改为 `IPriceOracleMinimal`。
	- 原因：Oracle 接口族已有标准读边界 `IPriceOracleRead`，而前端/观测门面又应优先落在 `ValuationOracleView` 一层；重新发明 `Minimal` 名字会同时削弱两层边界。
	- 阶段 1 建议：保留局部接口或仅做注释澄清；替换为 `IPriceOracleRead` 或改走 `ValuationOracleView` 的动作放到阶段 2，并先做消费者语义审计。

---

## 3. 阶段 2：接口收敛

### 3.1 定义
- 阶段 2 的目标不是“消灭重复名字”，而是把**真正同职责、同签名、同权限假设**的局部接口收敛到共享边界。
- 阶段 2 属于设计变更，虽然目标仍然是“行为不变”，但它已经不是纯机械改名。

### 3.2 阶段 2 启动前提
- 已完成阶段 1，且编译/selector/关键 smoke 全通过。
- 已输出接口签名矩阵：逐个对比参数、返回值、struct、权限假设、调用场景。
- 已输出消费者矩阵：谁在读、谁在写、谁依赖哪个最小方法集。
- 已输出命名冲突矩阵：仓库里现有 `Minimal` / `View` / `Read` 名字是否已被占用。
- 已确认收敛后不会扩大依赖面，不会把“单点依赖的窄接口”膨胀成“模糊共用接口”。

### 3.3 阶段 2 允许的动作
- 把签名完全一致、职责完全一致的重复局部接口抽到 `src/interfaces/`。
- 用现有共享接口替换局部接口，但前提是共享接口的职责边界比局部接口更准确，而不是更宽。
- 对同名但不同依赖面的接口进行拆分命名，而不是硬合并。
- 对单一写动作或少量写动作的局部窄接口，在证据充分时收敛为动作裁剪共享接口，但前提是它比现有混合接口更准确而不是更宽。

### 3.4 阶段 2 禁止的动作
- 仅因为名字相似，就把多个局部接口合并为一个共享接口。
- 仅为了“全仓不再出现 Lite”，把已有 `Read` / `View` / `Minimal` 语义打乱。
- 把通用只读窄接口一律改叫 `...Read`，绕开 `Minimal / Basic` 的标准分层。
- 让 View 消费者依赖写接口，或让写路径模块依赖只读聚合接口。
- 新增泛化接口去包住原本更清晰的窄接口。
- 把 `update*FromRiskManager(...)` 一类专用写回入口塞进 `...Minimal` / `...Basic` / `...View` 命名体系。

### 3.5 阶段 2 的优先收敛策略
- `HealthView` 读接口：阶段 1 先保留按消费者裁剪的 `Minimal` 局部名；仅在确认相同读取子集已稳定服务多个消费者后，才抽出 `IHealthViewBasic` 一类共享边界。
- `PositionView` 读接口：阶段 1 优先按读场景单独建 `Minimal` 窄接口，不默认复用包含写方法的共享接口；若后续稳定复用，再评估 `IPositionViewBasic`。
- `StatisticsView`：读接口与写接口必须继续明确分离，禁止同名占位；阶段 1 优先使用精确的 `Minimal` 局部名，稳定共享后再提升到 `IStatisticsViewBasic`。
- `SystemRisk`：system-scoped 风险参数的共享边界必须继续收敛到专属 `View` 家族；若未来补共享接口，应命名为 `ISystemRiskView`，而不是继续扩展 `Read` 家族。单点消费者若只需少量方法，可继续保留 `...Minimal` 依赖裁剪接口。
- `PriceOracle`：链上权威读取默认收敛到 `IPriceOracleRead`；批量价格、观测性、健康检查展示等 facade 能力优先在 `ValuationOracleView` 暴露。
- `ILiquidationConfigModuleLite`：只有在出现第二个以上消费者且方法集完全一致，且已先拆清读阈值与专用写入口边界时，才考虑抽到共享接口；其中写回动作优先落到动作裁剪接口，不应继续伪装成 `Minimal` / `Basic`。

---

## 4. 已识别的风险点

### 4.1 名字已被占用
- `IHealthViewMinimal` 已在仓库中表示写路径 push 接口。
- `IStatisticsViewMinimal` 已在仓库中表示写路径 push 接口。

### 4.2 同名接口方法集不一致
- `ISystemRiskViewLite` 在不同文件中的方法集不同，至少存在：
	- 仅 `getMinHealthFactor()`
	- `getMinHealthFactor()` + `getMaxLtvBps()`

### 4.3 语义层级已在仓库中有既定规范
- Oracle 读边界已由 `IPriceOracleRead` 承担。
- 除标准已明确分层的接口家族外，`Read` 不应再被扩展为通用后缀层级。
- `View / Minimal / Basic / Adapter` 已在规范中定义清楚，不能为了迁移历史 `Lite` 名称而重新解释。

### 4.4 局部接口本身已混合读写语义
- `ILiquidationConfigModuleLite` 不是纯只读接口；它同时承载阈值读取与 `update*FromRiskManager(...)` 写回动作。
- 因此不能把它简单视为“安全改成 Minimal 的局部接口”，否则会把现有职责混杂固化进新名字。

### 4.5 facade 边界与权威源边界不能混用
- `SystemRiskView` 是 system-scoped risk 的权威只读入口；阈值、最小健康因子等 system-only 风险参数的命名收敛不得再制造与之并行的“默认权威入口”。
- `ILiquidationRiskRead` 即使继续存在，也只能被视为内部兼容/实现细节边界，不能在命名方案中与 `SystemRiskView` 并列成阶段 2 的默认收敛目标。
- `IPriceOracleRead` 是链上权威价格源读边界，并承载 freshness 与 `assetDecimals` 的 SSOT；前端/观测类展示能力在架构上优先归于 `ValuationOracleView`，但这不应改变链上权威读取默认收敛到 `IPriceOracleRead` 的原则。

---

## 5. 验证清单

### 5.1 阶段 1 验证
- `rg "\bI\w+Lite\b" src docs` 结果减少，但允许保留被明确推迟到阶段 2 的项。
- 以当前仓库状态为准，合约源码中的 `Lite` 残留应仅剩被明确延期的 `ILiquidationConfigModuleLite`；若新增其他 `Lite` 项，必须附带单独审计说明。
- `pnpm -s exec tsc -p tsconfig.scripts.json --noEmit`
- `pnpm -s exec tsc -p tsconfig.e2e.json --noEmit`
- `pnpm -s run compile`
- 抽检关键读取路径：View 读取、Liquidation 风控读取。
- 若涉及文件名或 import 路径调整：核查 Solidity import、文档内链接、脚本/说明文档中的接口路径引用是否全部同步。
- 若仓库生成 ABI / artifacts / 类型产物：确认接口改名未导致下游引用误读旧路径或旧名称。
- 若有 ABI/selector 对比工具：确认无外部 selector 变化。

### 5.2 阶段 2 额外验证
- 逐文件签名 diff 记录。
- 消费者依赖面 diff 记录。
- 共享接口引入前后的 import / 调用图对比。
- 确认未新增任何运行时外部调用。
- 确认未引入更宽权限接口。
- 对 `SystemRisk` 收敛：确认外部只读语义仍锚定 `SystemRiskView`，同时阈值配置 SSOT 仍是 `KEY_LIQUIDATION_CONFIG_MANAGER -> LiquidationConfigModule`；`LiquidationRiskManager` 只能是聚合/透传面，不能被描述成权威配置入口。
- 对 `PriceOracle` 收敛：确认链上消费者默认仍收敛到 `IPriceOracleRead`，且不丢失 freshness 与 `assetDecimals` 语义；仅 facade/展示层消费者才评估 `ValuationOracleView`。
- 对少量写动作接口收敛：确认新共享边界采用动作裁剪命名，而不是把写动作包装进 `Minimal` / `Basic` / `View`。
- 完整关键路径 smoke 回归。

---

## 6. 性能与秩序护栏

### 6.1 运行时性能口径
- 阶段 1 的目标是**运行时性能严格中性**。
- 纯改名不应影响 gas、外部调用次数、缓存命中路径、事件数量、权限检查路径。
- 若某次“命名改造”需要改变 import 目标、替换共享接口、增加适配层，则该改动自动归入阶段 2，不再视为纯改名。

### 6.2 工程秩序口径
- 阶段 1 改善的是可读性与命名一致性，不追求通过“合并一切接口”来制造表面统一。
- 阶段 2 改善的是共享边界清晰度，而不是减少文件数量本身。
- 只要收敛动作可能扩大职责、模糊读写边界或让现有共享接口语义变脏，就应保持局部接口存在。

### 6.3 不允许的伪优化
- 为了减少重复接口定义而引入更宽的共享接口。
- 为了让命名更整齐而牺牲现有 `Read / View / Minimal` 分层。
- 为了“统一”而把不同调用方的方法集强行对齐。

---

## 7. 完成定义（DoD）

### 7.1 阶段 1 DoD
- 所有已处理项都属于纯改名。
- 无 selector 变化。
- 无外部调用路径变化。
- 无权限/缓存/事件/账本行为变化。
- 若涉及文件名变更，文档链接、import 路径与生成产物引用均已校验。
- 文档中已明确列出哪些 `Lite` 项被推迟到阶段 2。

### 7.2 阶段 2 DoD
- 所有收敛动作都有签名审计与消费者审计支撑。
- 共享接口命名不与现有语义冲突，且 `Minimal / Basic / Read / View` 的使用符合标准定义。
- 读写边界比改造前更清晰，而不是更模糊。
- 编译、类型检查、关键 smoke 全通过。
- 对当前仓库已落地项，至少应覆盖 `IHealthViewBasic`、`IPositionViewBasic`、`IStatisticsViewBasic`、`ISystemRiskView` 与 `IPriceOracleRead` 的 selector/消费者/关键路径验证记录。

---

## 8. 删除规则

- 只有当阶段 1 与阶段 2 都分别完成并通过验证后，才删除本文件。
- 最终 PR 描述中必须保留：
	- 阶段 1 改名清单
	- 阶段 2 收敛清单
	- selector / smoke 验证结果
	- “无行为变更”声明

---

## 9. 阶段 2 接口签名矩阵

> 说明：本矩阵用于回答“哪些局部接口未来可以安全收敛”。
> 判定口径：
> - **可直接收敛到现有共享接口**：已有共享接口同时满足同职责、同签名、不扩大依赖面。
> - **可收敛，但应新建共享只读边界**：当前没有合适共享接口，但存在重复局部接口，且方法集一致。
> - **需先做消费侧架构判定**：签名兼容只是前提，但不得突破架构指南已声明的权威入口；消费者语义判定只能在该入口之下决定是否额外暴露 facade 边界，不能反向改写 `Minimal / Basic / View` 的标准后缀语义。
> - **暂不收敛**：方法集不同、现有共享接口过宽、存在明显语义冲突，或局部接口本身仍混合多类职责。

### 9.1 收敛矩阵

| 局部接口 | 当前定义位置 | 当前使用点 | 签名摘要 | 共享候选 | 收敛结论 | 阶段 2 前提 |
| --- | --- | --- | --- | --- | --- | --- |
| `IHealthViewLite` | `src/Vault/view/modules/DashboardView.sol` / `CacheOptimizedView.sol` / `RiskView.sol` / `LiquidationRiskManager.sol` | Dashboard、CacheOptimized、Risk、LiquidationRiskManager | `getUserHealthFactorWithMeta(address) -> (uint256,bool,uint256)` | 阶段 1：精确局部 `Minimal`；阶段 2：`IHealthViewBasic` | **可收敛，但局部裁剪与共享边界应分层命名** | 阶段 1 不得把局部窄接口直接改叫通用 `Read`；只有在确认该读取子集稳定服务多个消费者后，才提升为 `Basic` |
| `IPositionViewLite` | `src/Vault/view/modules/DashboardView.sol` / `CacheOptimizedView.sol` | Dashboard、CacheOptimized | `getUserPositionWithMeta(address,address) -> (uint256,uint256,bool,uint256,uint64)` | 阶段 1：精确局部 `Minimal`；阶段 2：`IPositionViewBasic` | **可收敛，但默认不直连混合接口** | 阶段 1 应继续用窄 `Minimal` 裁剪依赖面；只有在多消费者稳定复用且审计通过时，才提升为 `Basic`，否则不要直接依赖 `IPositionView` |
| `IPositionViewRead` | `src/Vault/view/modules/PreviewView.sol` | PreviewView | `getUserPositionWithMeta(address,address) -> (uint256,uint256,bool,uint256,uint64)` | 阶段 1：应回收到精确局部 `Minimal`；阶段 2：`IPositionViewBasic` | **可收敛，但现有 `Read` 名称不宜作为最终共享边界** | 与 `IPositionViewLite` 一并治理；默认目标不是继续扩张 `Read` 命名，而是在证据充分时收敛为 `Basic` |
| `IStatisticsViewLite` | `src/Vault/view/modules/DashboardView.sol` / `CacheOptimizedView.sol` | Dashboard、CacheOptimized | `GlobalStatistics{totalUsers,activeUsers,totalCollateral,totalDebt,lastUpdateBlock}` + `getGlobalStatisticsWithMeta() -> (GlobalStatistics,bool,uint256)` | 阶段 1：精确局部 `Minimal`；阶段 2：`IStatisticsViewBasic` | **可收敛，但局部裁剪与共享边界应分层命名** | 不得复用现有写接口 `IStatisticsViewMinimal`；阶段 1 先保持局部 `Minimal`，只有在稳定共享后才升级到 `Basic` |
| `ISystemRiskViewLite`（最小版） | `src/Vault/view/modules/HealthView.sol` / `DashboardView.sol` | HealthView、DashboardView | `getMinHealthFactor() -> uint256` | `SystemRiskView` 专属 `View` 家族（若补共享接口，应命名为 `ISystemRiskView`） | **可收敛，但共享边界应保持 `View` 语义** | 对 system-scoped risk 参数的共享边界不得再扩展通用 `Read` 家族；单点消费者若只需少量方法，可继续保留 `...Minimal` 裁剪接口 |
| `ISystemRiskViewLite`（阈值版） | `src/Vault/view/modules/PreviewView.sol` | PreviewView | `getMinHealthFactor() -> uint256` + `getMaxLtvBps() -> uint256` | `SystemRiskView` 专属 `View` 家族（若补共享接口，应命名为 `ISystemRiskView`） | **可收敛，但共享边界应保持 `View` 语义** | `getMinHealthFactor()` / `getMaxLtvBps()` 属于架构已收口的 system-scoped risk 参数读取；阶段 2 不应再把它们提升成并行 `Read` 族默认目标 |
| `IPriceOracleLite` | `src/Vault/view/modules/DashboardView.sol` | DashboardView | `getPrice(address) -> (uint256,uint256,uint256)` | `IPriceOracleRead`（链上权威价格源读取）；`ValuationOracleView`（仅 facade/展示门面） | **需先做消费侧架构判定，但链上默认目标已确定** | 链上消费者默认收敛到 `IPriceOracleRead`，并保持 freshness 与 `assetDecimals` 语义；只有明确属于前端/观测/展示门面的消费者，才评估额外通过 `ValuationOracleView` 暴露 |
| `ILiquidationConfigModuleLite` | `src/Vault/liquidation/modules/LiquidationRiskManager.sol` | LiquidationRiskManager | `getLiquidationThreshold()` / `getMinHealthFactor()` / `getMaxLtvBps()` + 3 个 `update*FromRiskManager(...)` | 无现成同职责共享接口 | **暂不收敛，且不建议直接改名为 Minimal** | 当前只有单一消费者，且含 RiskManager 专用写入口；若未来要治理，应先拆分“阈值读取”与“RiskManager 回写动作”边界 |

### 9.2 逐项说明

#### A. 需先做消费侧架构判定

- `IPriceOracleLite`
	- 现有共享接口 `IPriceOracleRead` 的 `getPrice(...)` 与当前局部接口签名兼容，但“签名兼容”并不自动等于“应直接收敛”。
	- 结合架构指南，链上权威价格读取边界已经收口到 `IPriceOracleRead`；因此对链上消费者而言，默认目标不是开放选择题。
	- `IPriceOracleRead` 不只是名字统一点，还承载 freshness 集中裁决与 `assetDecimals` 语义；阶段 2 不得为了“接口整齐”改成丢失这些约束的 facade 依赖。
	- 若某消费者明确属于前端展示、价格观测、健康检查或批量门面，可在不改变链上权威入口的前提下评估由 `ValuationOracleView` 对外封装暴露。
	- 因此该项的阶段 2 前提不是“二选一替换接口名”，而是先区分链上权威读取与 facade 展示诉求，再分别落位。

#### B. 可收敛，但阶段 1 局部裁剪与阶段 2 共享边界应分层命名

- `IHealthViewLite`
	- 各使用点的方法集一致，重复度高，具备收敛价值。
	- 不能收敛到现有 `IHealthViewMinimal`，因为该名字已被写路径 push 接口占用。
	- 最安全的路径是：阶段 1 先用更精确的局部 `Minimal` 名称完成纯改名；阶段 2 若确认为稳定多消费者子集，再新增 `src/interfaces/IHealthViewBasic.sol`。

- `IStatisticsViewLite`
	- Dashboard 与 CacheOptimizedView 的局部定义一致，也具备收敛价值。
	- 不能复用现有 `IStatisticsViewMinimal`，因为后者是写路径 push 接口。
	- 最安全方案是：阶段 1 先改成精确局部 `Minimal` 名称；若后续证明是稳定共享子集，再新增 `src/interfaces/IStatisticsViewBasic.sol`。

- `IPositionViewLite` / `IPositionViewRead`
	- 现有共享接口 `IPositionView` 的确包含相同签名的 `getUserPositionWithMeta(...)`。
	- 但 `IPositionView` 是明确的混合读写接口，包含多组 `pushUserPositionUpdate*` 写路径；若让 DashboardView、PreviewView 这类只读消费者直接依赖它，会弱化本文已经写明的读写分层护栏。
	- 因此阶段 2 的默认方案应是在阶段 1 完成局部 `Minimal` 收敛后，再评估 `src/interfaces/IPositionViewBasic.sol` 这类共享基础子集；现有 `IPositionViewRead` 更适合作为待治理的历史局部名，而不是最终共享边界名。

#### C. `SystemRisk` 必须继续收敛到单一权威入口，且共享家族应保持 `View` 语义

- `ISystemRiskViewLite`（最小版）
	- 架构文档已把 system-scoped risk 的阈值、最小健康因子等参数收口到 `SystemRiskView`，因此命名方案不应再把其他接口写成并行默认入口。
	- 若仓库继续保留 `ILiquidationRiskRead` 之类的同类读取能力，应明确标注为内部兼容或实现细节，而不是阶段 2 的共享命名目标。
	- 阶段 2 的正确方向是让对这些 system-only 参数的共享边界统一锚定 `SystemRiskView` 专属 `View` 家族；若未来需要正式共享接口，应命名为 `ISystemRiskView`，而不是继续扩张 `Read` 命名。

- `ISystemRiskViewLite`（阈值版）
	- PreviewView 需要的两个只读方法都属于架构已明确收口的 system-scoped 参数读取，因此默认目标同样应是 `SystemRiskView`。
	- 若存在内部实现仍经由其他读取边界取值，这类路径只能记为兼容事实，不能反向推动命名方案把默认权威面拆回多路。
	- 对 gate 的担忧应通过文档注明 `SystemRiskView` 的默认公开只读属性与“可选增强”语义来解决；单点消费者若只需其中少量方法，应继续使用 `...Minimal` 裁剪接口，而不是为 system-risk 另造共享 `Read` 家族。

#### D. 暂不收敛或仅保守保留

- `ILiquidationConfigModuleLite`
	- 当前接口同时包含读阈值与 `update*FromRiskManager(...)` 专用写入口。
	- 这不是通用配置接口，也不是纯只读接口，而是 RiskManager 定制窄边界。
	- 若未来无第二个同语义消费者，不应为了减少一个局部接口而硬抽共享接口；更不应在未拆清职责前直接改名成 `Minimal`。

### 9.3 阶段 2 推荐实施顺序

1. 先把 `IHealthViewLite` / `IStatisticsViewLite` / `IPositionViewLite` 一类历史局部名改成精确的 `Minimal` 名字，完成阶段 1 纯改名。
2. 再在签名与消费者审计充分后，把真正稳定复用的只读子集提升为 `IHealthViewBasic` / `IStatisticsViewBasic` / `IPositionViewBasic` 一类共享边界，而不是继续扩张通用 `Read` 命名。
3. 对 `ISystemRiskViewLite` 两个变体统一锚定到 `SystemRiskView` 专属 `View` 家族；如需单点依赖裁剪，则保留 `...Minimal`，不要另造 system-risk 共享 `Read` 家族。
4. 对 `IPriceOracleLite` 先区分链上权威读取与 facade 展示诉求：链上消费者默认收敛到 `IPriceOracleRead`，仅 facade/展示侧再评估 `ValuationOracleView`。
5. `ILiquidationConfigModuleLite` 默认保留局部，不列为优先收敛对象；如后续要处理，先拆职责，再决定命名。

### 9.4 收敛后的性能判断标准

- 仅把多个相同局部接口替换为同签名共享接口：运行时性能应保持中性。
- 若收敛引入新的 facade、adapter、额外 external call 或更复杂的模块解析路径，则该方案应判定为失败。
- 阶段 2 的收益应主要体现在：
	- 命名与职责边界更清晰
	- 减少重复接口定义
	- 降低后续改签名时的漏改风险
- 对 Health/Position/Statistics 一类共享只读子集，不应把 `Read` 继续扩展成通用默认后缀；单点依赖用 `Minimal`，稳定共享后再升 `Basic`。
- 对 Oracle 收敛，必须优先保护 `IPriceOracleRead` 的权威读取地位，以及 freshness / `assetDecimals` 的 SSOT；facade 暴露只能作为额外门面，不得反客为主。
- 对 `SystemRisk` 收敛，必须优先保护 `SystemRiskView` 的唯一权威入口地位；若内部仍有其他读取边界，也不得在命名层把它们提升为并行默认面。
- 阶段 2 不以 gas 优化为主要目标；若出现 gas 或调用图变化，应优先保护现有秩序而不是追求形式统一。

---

## 10. 最终推荐命名表

> 说明：本表是执行层面的默认命名建议，用于回答“如果后续真的要统一，最终应取什么名字”。
> 口径：
> - **局部名**：阶段 1 可在文件内采用的名字，不代表共享接口已经成立。
> - **共享名**：阶段 2 在完成签名与消费者审计后，默认推荐采用的共享接口名。
> - **可选升级名**：仅当阶段 1 的局部 `Minimal` 接口后续被证明为稳定共享子集时，才考虑升级为 `Basic`；不是从通用 `Read` 自动升级。

### 10.1 推荐表

| 历史局部名 | 阶段 1 局部推荐名 | 阶段 2 默认共享名 | 可选升级名 | 适用消费者 | 明确不推荐 |
| --- | --- | --- | --- | --- | --- |
| `IHealthViewLite` | `IHealthViewHealthFactorMinimal` | `IHealthViewBasic` | 无 | 健康因子只读子集，且已证明为稳定多消费者共享 | `IHealthViewRead`、`IHealthViewMinimal` |
| `IStatisticsViewLite` | `IStatisticsViewGlobalMinimal` | `IStatisticsViewBasic` | 无 | 全局统计只读子集，且已证明为稳定多消费者共享 | `IStatisticsViewRead`、`IStatisticsViewMinimal` |
| `IPositionViewLite` | `IPositionViewPositionMinimal` | `IPositionViewBasic` | 无 | 仓位只读子集，且已证明为稳定多消费者共享 | `IPositionViewRead` 作为最终共享名、直接默认依赖 `IPositionView`、新造 `IPositionViewMinimal` |
| `IPositionViewRead` | `IPositionViewPositionMinimal` | `IPositionViewBasic` | 无 | 仓位只读子集，且已证明为稳定多消费者共享 | 保留 `IPositionViewRead` 作为长期共享名、直接默认依赖 `IPositionView` |
| `ISystemRiskViewLite`（仅 `getMinHealthFactor()`） | `ISystemRiskMinHealthMinimal` | `ISystemRiskView` 家族（由 `SystemRiskView` 承载） | 无 | system-scoped risk 最小阈值读取 | `ISystemRiskMinHealthRead`、`ISystemRiskViewMinimal`、把 `ILiquidationRiskRead` 写成并行默认目标 |
| `ISystemRiskViewLite`（`getMinHealthFactor()` + `getMaxLtvBps()`） | `ISystemRiskThresholdMinimal` | `ISystemRiskView` 家族（由 `SystemRiskView` 承载） | 无 | system-scoped risk 参数读取 | `ISystemRiskThresholdRead`、`ISystemRiskViewMinimal`、把 `ILiquidationRiskRead` 写成并行默认目标 |
| `IPriceOracleLite` | 保留局部名或注释澄清 | 链上权威读取：`IPriceOracleRead`；facade/展示：可额外由 `ValuationOracleView` 暴露 | 无 | 链上价格权威读取 / 前端观测门面 | `IPriceOracleMinimal`、把 facade 写成链上默认收敛目标 |
| `ILiquidationConfigModuleLite` | 默认保留局部名 | 默认不抽共享接口；若未来拆分后再分别命名 | 无 | RiskManager 专用配置/回写边界 | 直接改成 `ILiquidationConfigModuleMinimal` |

### 10.2 使用规则

- `...Read`：仅用于 `SmartContractStandard.md` 已经显式标准化的接口家族，例如 `IPriceOracleRead`、`IWhitelistRegistryRead` 一类；不得扩展成通用默认后缀。
- `...Basic`：仅在多个消费者长期稳定复用同一子集、且该子集已经明显超出“单点依赖裁剪”语义时才使用。
- `...Minimal`：默认用于单一依赖方或极小依赖面的本地/专用接口；阶段 1 的局部纯改名应优先落在这一层。
- `...View`：保留给 facade/门面层；若接口名的真实语义是“权威源读取”或“单点窄依赖”，就不应为了统一而伪装成 `View`。

### 10.3 落地优先级

1. 优先把 `IHealthViewLite`、`IStatisticsViewLite`、`IPositionViewLite`、`IPositionViewRead` 等历史局部名回收到精确的 `Minimal` 命名。
2. 在确认存在稳定多消费者共享子集后，再分别引入 `IHealthViewBasic`、`IStatisticsViewBasic`、`IPositionViewBasic`。
3. `SystemRisk` 相关名字在落地时必须统一锚定 `SystemRiskView` / `ISystemRiskView` 家族，并把任何内部兼容读取边界单列说明，避免重新形成并行权威入口。
4. `IPriceOracleRead` 是链上默认权威读取边界；若是前端/观测场景，可额外通过 `ValuationOracleView` 暴露，但不得把 facade 改写成链上默认收敛目标。
5. `ILiquidationConfigModuleLite` 在未拆职责前不进入共享命名清单。

### 10.4 当前落地映射（2026-04）

- `IHealthViewLite` -> 已由共享只读边界 `IHealthViewBasic` 承接。
- `IStatisticsViewLite` -> 已由共享只读边界 `IStatisticsViewBasic` 承接。
- `IPositionViewLite` / `IPositionViewRead` -> 已由共享只读边界 `IPositionViewBasic` 承接。
- `ISystemRiskViewLite` 变体 -> 已统一锚定到 `ISystemRiskView` / `SystemRiskView` 家族。
- `IPriceOracleLite` -> 链上消费者继续锚定 `IPriceOracleRead`；facade/展示语义保留在 `ValuationOracleView`。
- `ILiquidationConfigModuleLite` -> 仍保留为局部混合读写接口，后续如需治理，必须先拆职责再命名。

---

## 11. 本轮最终审计结论（2026-04）

### 11.1 结论摘要

- 本轮“命名治理 + NatSpec 治理 + Solidity 格式统一”已完成预期主目标，当前仓库在命名边界、注释边界与排版边界上均较治理前明显收敛。
- 命名治理层面，当前仓库已基本遵循 `SmartContractStandard.md` §3.3.7 与 `Architecture-Guide.md` 的职责分层；未发现新的 `Lite / Minimal / Basic / View / Adapter` 语义漂移点。
- NatSpec 治理层面，已完成对生产 Solidity 与高频 mocks/test-support Solidity 的全局注释审计与批量修复，已清理本轮识别出的中文注释残留、旧 section 分隔符，以及命名改造后的明显注释漏改。
- 格式统一层面，已对全仓 Solidity 执行一次 Prettier 写回；`pnpm -s run format:check:sol` 当前通过，说明 `.sol` 文件排版已统一到仓库当前 Prettier 规则。

### 11.2 命名治理结论

- 当前共享只读边界已经按方案落地并稳定存在：
	- `IHealthViewBasic`
	- `IPositionViewBasic`
	- `IStatisticsViewBasic`
	- `ISystemRiskView`
	- `IPriceOracleRead`
- 这些接口当前已覆盖主要消费者场景，命名方向与标准文档保持一致，没有出现把局部窄依赖重新膨胀为模糊共享接口的回退。
- `SystemRisk` 与 `PriceOracle` 两个敏感家族的权威入口语义保持稳定：
	- system-scoped risk 只读门面继续锚定 `SystemRiskView` / `ISystemRiskView`
	- 链上权威价格读取继续锚定 `IPriceOracleRead`
	- `ValuationOracleView` 继续保留为 facade / 展示门面，而非反向替代权威读取边界
- 本轮确认的唯一显式保留例外仍然是 `ILiquidationConfigModuleLite`：
	- 该接口当前仍为 RiskManager 专用的局部混合读写边界
	- 其语义不属于通用 `Minimal` / `Basic` / `View` 共享命名目标
	- 如后续继续治理，必须先拆分阈值读取与 `update*FromRiskManager(...)` 专用写回动作，再决定命名

### 11.3 NatSpec 与注释治理结论

- 本轮已按 `docs/Usage-Guide/Audit-Grade-NatSpec-Guide.md` 对 Solidity 源码执行全局注释检查与分批修复。
- 已完成的治理动作包括：
	- 将本轮识别出的中文注释、中文 NatSpec 统一为英文
	- 将历史 `// ============ ... ============` 与 `/* ============ ... ============ */` 分隔符统一为 SSOT 风格
	- 修正命名治理后的注释漂移，尤其是局部接口和轻量边界说明
	- 对高频生产文件与 mocks/test-support 文件补足审计级说明口径，避免注释继续误导职责边界
- 本轮复扫结果显示，`src/**/*.sol` 中已不再命中中文注释与旧分隔符模式，说明这一类显性注释债务已完成收口。

### 11.4 格式统一结论

- 已修正仓库 Solidity Prettier 脚本，使其显式加载 `prettier-plugin-solidity`，与审计级 NatSpec 指南保持一致。
- 已执行全仓 Solidity Prettier 写回：
	- `pnpm -s run format:sol`
	- `pnpm -s run format:check:sol`
- 当前 `format:check:sol` 结果为通过，说明本轮范围内的 Solidity 文件已经完成一次性排版统一。

### 11.5 验证结果

- Compile：通过
	- 本轮复验结果：`Compiled 212 Solidity files successfully`
- Full lint：通过（无 error）
	- 当前结果：`0 errors, 104 warnings`
	- 说明：全量 lint 已恢复为“仅剩 warning”的稳定状态，本轮新增阻塞错误已清除
- Solidity format check：通过
	- 当前结果：`All matched files use Prettier code style!`
- 历史验证闭环：此前已完成 selector 对比与关键 view/liquidation smoke，且结论为通过；本轮未引入与该结论相冲突的证据

### 11.6 当前非阻塞残项

- Full lint 仍存在 104 条 warning，主要集中于以下历史规则：
	- `max-line-length`
	- `gas-small-strings`
	- `gas-struct-packing`
	- `max-states-count`
	- 个别 `no-unused-import` / `immutable-vars-naming`
- 这些 warning 在本轮复验中均未表现为阻塞项，也不构成“命名治理 / NatSpec 治理 / 格式统一”目标未完成的证据。
- Compile 过程中仍有一条 OpenZeppelin upgrades 的非阻塞提示：
	- `src/Mocks/VaultUpgradeTestMocks.sol:85` 建议在特定 reinitializer 场景下添加 `@custom:oz-upgrades-validate-as-initializer`
	- 当前该提示不影响编译通过，不属于本轮命名/注释/格式治理阻塞项

### 11.7 最终判断

- 以本文件和相关标准文档为基线，本轮命名治理已达到“可审计、可维护、无新增边界漂移”的完成标准。
- 本轮 NatSpec 治理已完成显性注释债务清理，生产代码与高频 mocks 的注释口径已经与当前命名体系和审计级指南对齐。
- 本轮格式统一已完成全仓 Solidity Prettier 收口，当前排版状态一致。
- 因此，本轮可以正式认定为：
	- **命名治理：完成**
	- **NatSpec / 注释治理：完成**
	- **Solidity 格式统一：完成**
	- **静态验证收口：完成（lint 仅剩历史 warning）**
