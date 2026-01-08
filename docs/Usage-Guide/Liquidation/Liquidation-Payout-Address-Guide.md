# 清算残值分配收款地址指南

> ⚠️ 本文为“专题指南”。关于整改的权威口径（统一写入口、模块边界、迁移步骤等）请以总纲为准：[`SettlementManager-Refactor-Plan.md`](./SettlementManager-Refactor-Plan.md)

本指南说明在 RWA 借贷平台中，清算残值分配的收款地址如何配置，覆盖平台费、风险准备金以及出借人补偿三类地址，并给出推荐方案和部署要点。

## 业务背景
- A = 出借人；B = 抵押人（提供 RWA 抵押）。  
- 到期未还或触发清算：抵押物/残值分配给出借人等角色。  
- 提前还款：抵押物返还给抵押人，可能包含罚金与积分；与本指南关注的残值分配分开处理。

## 分配角色与默认比例
- 平台（platform）：默认 3% 用于运营/手续费。  
- 准备金（reserve）：默认 2% 用于风险准备金/保险金。  
- 出借人补偿（lender compensation）：默认 17%，应支付给当前实际出借人 A。  
- 清算人（liquidator）：默认 78%，并接收整数除不尽的余数。
- 比例总和需为 10,000 bps，可在部署后由有 `ACTION_SET_PARAMETER` 权限的角色调整。

## 地址配置选项
### 方案 A（推荐，动态出借人）
- 平台/准备金：使用固定**合约金库地址**（推荐）或多签地址（备选），主网/测试网分别配置。  
- 出借人补偿：在清算分配时由统一入口 `SettlementManager` 动态解析当前订单/仓位的出借人 A，直接转给 A，不在部署时写死。  
- 含义：`LiquidationPayoutManager` 只存平台/准备金等“固定接收者”；出借人地址由清算/结算流程（`SettlementManager`）传入或查询，最贴合业务语义。

### 方案 B（保持现有接口，出借人前置路由）
- 平台/准备金：同上，固定合约金库或多签。  
- 出借人补偿：部署时设置为“转发/结算路由”合约地址；该路由在收到补偿后再把款项转给实际出借人 A。  
- 适用：希望最小化合约接口改动，但仍要避免把补偿打到固定地址。

### 方案 C（仅用于本地/快速演示）
- 平台/准备金/出借人补偿都用部署者地址占位，便于本地或测试链快速跑通；上线前必须替换为实际地址或路由。

## 环境变量与部署脚本
- 支持的 env 变量（三网脚本均可用）：  
  - `PAYOUT_PLATFORM_ADDR`：平台收款地址（建议为合约金库地址；也可用多签）。  
  - `PAYOUT_RESERVE_ADDR`：准备金收款地址（建议为合约金库地址；也可用多签）。  
  - `PAYOUT_LENDER_ADDR`：出借人补偿地址。  
- 默认比例（可被修改）：`300/200/1700/7800`（平台/准备金/出借人/清算人）。
- 若未提供 env，脚本会回退为 deployer 地址（仅适合本地/演示）。

## 推荐落地步骤（主网/测试网）
1) 确定方案：  
   - 业务优先：用方案 A；若暂不改合约接口，则采用方案 B 并准备一个路由合约地址。  
2) 准备地址：  
   - `PAYOUT_PLATFORM_ADDR`、`PAYOUT_RESERVE_ADDR`：合约金库地址（推荐）或多签/安全托管地址。  
   - `PAYOUT_LENDER_ADDR`：方案 A 可留空（由代码查询/传入）；方案 B 填路由合约地址。  
3) 配置 env 并部署：  
   - `deploylocal.ts` / `deploy-arbitrum.ts` / `deploy-arbitrum-sepolia.ts` 会读取上述 env，部署 `LiquidationPayoutManager` 并在 Registry 注册 `KEY_LIQUIDATION_PAYOUT_MANAGER`；清算/结算统一入口由 `KEY_SETTLEMENT_MANAGER → SettlementManager` 承接。  
4) 权限与调整：  
   - 需要更新比例或收款人时，由 `ACTION_SET_PARAMETER` 角色调用 `updateRates` / `updateRecipients`。  

## 与架构指南的契合
- 残值分配走独立的 `LiquidationPayoutManager`，符合“清算逻辑内聚、配置可治理”的要求。  
- 收款地址与比例可治理、可升级，通过 Registry 解析模块地址，前端读取自动生成的 `frontend-config/contracts-*.ts`。  
- 分配事件已通过 `LiquidatorView` 以 DataPush 形式上链，便于前端/离线服务消费。  

## 需要你确认的事项
- 主网/测试网的实际平台与准备金地址（是否多签）。  
- 出借人补偿采用方案 A（动态地址）还是方案 B（路由合约），以便最终定稿部署脚本和合约接口。
