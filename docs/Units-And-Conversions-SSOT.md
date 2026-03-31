# Units & Conversions SSOT (USD-8)

> 目标：给 **合约 / 前端 / 测试 / 脚本** 提供一份“唯一正确口径”（Single Source of Truth, SSOT），避免单位与精度混用导致的估值错误。

---

## 1) 核心 SSOT 定义（必须统一）

- **价格单位（SSOT）**：`priceUsd8` 固定为 **USD-8**  
  - 示例：\($1.00 = 100000000\)
  - 注意：**price 精度永远是 8**，不随资产变化

- **数量单位（SSOT）**：`amountBaseUnits` 为 ERC-20 **base units**  
  - `amountBaseUnits = amountHuman * 10^assetDecimals`

- **资产精度（SSOT）**：`assetDecimals` 为 ERC-20 的 `decimals()`（或治理配置的固定值）  
  - 语义：**用于 amount → USD-8 的换算缩放**  
  - 非语义：**不是 price 的精度**

- **价值单位（SSOT）**：`valueUsd8` 为 **USD-8**

---

## 2) 换算公式（唯一正确公式）

### A. amount(base units) → valueUsd8

\[
\text{valueUsd8}=\frac{\text{amountBaseUnits}\times \text{priceUsd8}}{10^{\text{assetDecimals}}}
\]

### B. valueUsd8 → amount(base units)（反向推算）

\[
\text{amountBaseUnits}=\frac{\text{valueUsd8}\times 10^{\text{assetDecimals}}}{\text{priceUsd8}}
\]

> 合约实现建议：优先使用 `mulDiv`（避免 `amount * price` 溢出）。

---

## 3) 合约接口口径（推荐读取路径）

### 最推荐：走 View（前端/运维/脚本）

- **读价格 + 资产精度**：`ValuationOracleView.getAssetPriceWithDecimals(asset)`  
  - 返回：`(priceUsd8, blockNumber, assetDecimals, isValid)`
- **直接读估值**：`ValuationOracleView.getAssetValueUsd8(asset, amountBaseUnits)`  
  - 返回：`(valueUsd8, priceTimestamp, isValid)`

### Oracle SSOT（底层存储）

`IPriceOracleRead.getPrice(asset)` 返回：
- `priceUsd8`：USD-8
- `blockNumber`
- `assetDecimals`：token decimals（用于换算缩放）

---

## 4) 示例（避免理解偏差）

### 示例 1：USDC（assetDecimals=6）

- `amountHuman = 100 USDC`
- `amountBaseUnits = 100 * 10^6`
- `priceUsd8 = 1.00 * 10^8`

则：
\[
\text{valueUsd8}=\frac{100\times10^6\times10^8}{10^6}=100\times10^8
\]

### 示例 2：WETH（assetDecimals=18）

- `amountHuman = 0.5 WETH`
- `amountBaseUnits = 0.5 * 10^18`
- `priceUsd8 = 2000 * 10^8`

则：
\[
\text{valueUsd8}=\frac{0.5\times10^{18}\times2000\times10^8}{10^{18}}=1000\times10^8
\]

---

## 5) 典型错误用法（必须避免）

- **把 `assetDecimals` 当成 price 精度**：`formatUnits(price, assetDecimals)`（错误）  
  - 正确：`formatUnits(price, 8)`

- **把 amount 当成“人类单位”直接拿去乘价格**：`value = amountHuman * priceUsd8`（错误）  
  - 正确：先转 base units，或直接用 View 的 `getAssetValueUsd8`

- **混用 USD-18 / USD-8**：例如把 `1e18` 当作 \($1\)（错误）  
  - 正确：本系统 SSOT 为 USD-8

- **治理配置 `assetDecimals` 写错**：会导致估值按 \(10^d\) 级别偏离  
  - 建议：配置阶段优先自动读取 ERC-20 `decimals()`；对非标准资产必须显式配置并加测试用例

---

## 6) 检查清单（合约/前端/测试通用）

- **Oracle 配置**：
  - `priceUsd8` 是否按 8 位精度写入（例如用 `parseUnits(x, 8)`）
  - `assetDecimals` 是否等于 token `decimals()`（或治理明确 pin 住的值）
- **前端显示**：
  - 显示价格：`formatUnits(priceUsd8, 8)`
  - 显示数量：`formatUnits(amountBaseUnits, assetDecimals)`
  - 显示价值：`formatUnits(valueUsd8, 8)`
- **测试用例**：
  - 至少覆盖一个 6 decimals 资产（USDC/USDT 类）
  - 至少覆盖一个 18 decimals 资产（WETH 类）
  - 覆盖极小数值的 rounding 行为（value 可能四舍五入为 0）

