## 在已部署系统中新增 RWA 代币：部署 RWAToken → Registry 注册 → 加入资产白名单

适用场景：系统主体（Registry、ACM、AssetWhitelist 等）已部署完成，仅需
- 部署一个新的 `RWAToken`；
- 将其地址登记到 `Registry`；
- 将该代币加入 `AssetWhitelist` 资产白名单。

本文提供详细、可直接执行的步骤与示例脚本。

### 前置条件
- 已有网络配置：`localhost`、`arbitrum`、`arbitrumSepolia`（见 `hardhat.config.ts`）。
- 已部署并可用：
  - `Registry`（且已设置 `RegistryCore` 模块，便于 `setModule` 使用）
  - `AccessControlManager`（ACM）
  - `AssetWhitelist`（已通过 `initialize(registry)` 绑定 Registry）
- 可用账户：
  - `Registry` 的 `owner`（用于 `setModule`）
  - `ACM` 的 `owner`（用于 `grantRole` 授权白名单添加权限）

建议准备：
- 已保存的部署地址文件（例如 `scripts/deployments/localhost.json` 或 `scripts/deployments/addresses.arbitrum-sepolia.json`），或手上持有上述合约地址。

### 关键角色与常量
- 白名单添加权限动作键：`ActionKeys.ACTION_ADD_WHITELIST` → `keccak256("ADD_WHITELIST")`
- Registry 模块键：
  - `ModuleKeys.KEY_RWA_TOKEN`（可用于登记某个平台“主”RWA代币地址）
  - `ModuleKeys.KEY_ASSET_WHITELIST`（资产白名单模块地址）
  - `ModuleKeys.KEY_ACCESS_CONTROL`（ACM 地址）

注：若平台需要登记多个 RWA 代币，不必为每个代币都占用一个固定 `ModuleKey`，可只使用 `AssetWhitelist` 进行多资产管理，将“展示/价格”等元数据在前端或后端配置即可。

---

### 步骤一：部署新的 RWAToken
1) 设置环境变量（示例）
```bash
export PRIVATE_KEY=0x...
export ARBITRUM_SEPOLIA_RPC_URL=https://...
```

2) 使用 Hardhat 控制台或脚本部署
示例 TypeScript 脚本 `scripts/deploy/deploy-rwa-token.ts` 内容（可临时创建后运行）：
```ts
import { ethers } from 'hardhat';

async function main() {
  const name = process.env.RWA_NAME || 'RWA Bond 2025-A';
  const symbol = process.env.RWA_SYMBOL || 'RWA25A';

  const RWAToken = await ethers.getContractFactory('RWAToken');
  const token = await RWAToken.deploy(name, symbol);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log('RWAToken deployed at:', tokenAddress);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

运行部署（示例：Arbitrum Sepolia）：
```bash
npx hardhat run scripts/deploy/deploy-rwa-token.ts --network arbitrumSepolia
```

记录输出的 `RWAToken` 合约地址，记为 `RWA_TOKEN_ADDRESS`。

---

### 步骤二：在 Registry 中注册（可选但推荐）
若希望将“平台主 RWA 代币”纳入 Registry 统一管理，可将 `KEY_RWA_TOKEN` 指向新地址。

前提：
- 需要使用 `Registry.owner()` 账户执行；
- `Registry` 已设置 `RegistryCore` 模块。

示例脚本 `scripts/ops/register-rwa-token.ts`：
```ts
import { ethers } from 'hardhat';

// 将 RWA_TOKEN_ADDRESS 与 REGISTRY_ADDRESS 替换为实际值或从部署文件加载
const RWA_TOKEN_ADDRESS = process.env.RWA_TOKEN_ADDRESS!;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS!;

// keccak256('RWA_TOKEN')，与 ModuleKeys.KEY_RWA_TOKEN 一致
const KEY_RWA_TOKEN = ethers.keccak256(ethers.toUtf8Bytes('RWA_TOKEN'));

async function main() {
  if (!RWA_TOKEN_ADDRESS || !REGISTRY_ADDRESS) throw new Error('Missing env: RWA_TOKEN_ADDRESS / REGISTRY_ADDRESS');
  const registry = await ethers.getContractAt('Registry', REGISTRY_ADDRESS);
  const tx = await registry.setModule(KEY_RWA_TOKEN, RWA_TOKEN_ADDRESS);
  await tx.wait();
  console.log('Registered KEY_RWA_TOKEN ->', RWA_TOKEN_ADDRESS);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

执行：
```bash
export REGISTRY_ADDRESS=0x...
export RWA_TOKEN_ADDRESS=0x...
npx hardhat run scripts/ops/register-rwa-token.ts --network arbitrumSepolia
```

验证（任选其一）：
```bash
# 1) 直接读取模块
npx hardhat console --network arbitrumSepolia --require ts-node/register \
  --eval "(async () => {\n  const [s] = await (require('hardhat')).ethers.getSigners();\n  const r = await (require('hardhat')).ethers.getContractAt('Registry', process.env.REGISTRY_ADDRESS, s);\n  const k = (require('hardhat')).ethers.keccak256((require('hardhat')).ethers.toUtf8Bytes('RWA_TOKEN'));\n  console.log(await r.getModule(k));\n})()"

# 2) 若前端/脚本维护了部署地址文件，也可比对其中记录
```

---

### 步骤三：为操作账户授予白名单添加权限（ACM）
`AssetWhitelist.addAllowedAsset()` 要求调用者在 ACM 中具备 `ACTION_ADD_WHITELIST` 角色。

前提：
- 使用 `ACM.owner()` 账户执行授权。
- 拥有 `ACM` 合约地址；可通过 `Registry.getModule(KEY_ACCESS_CONTROL)` 查询。

示例脚本 `scripts/ops/grant-add-whitelist.ts`：
```ts
import { ethers } from 'hardhat';

const ACM_ADDRESS = process.env.ACM_ADDRESS!;
const OPERATOR = process.env.OPERATOR!; // 赋权给将要调用 addAllowedAsset 的账户

// keccak256('ADD_WHITELIST')
const ACTION_ADD_WHITELIST = ethers.keccak256(ethers.toUtf8Bytes('ADD_WHITELIST'));

async function main() {
  if (!ACM_ADDRESS || !OPERATOR) throw new Error('Missing env: ACM_ADDRESS / OPERATOR');
  const acm = await ethers.getContractAt('AccessControlManager', ACM_ADDRESS);
  const tx = await acm.grantRole(ACTION_ADD_WHITELIST, OPERATOR);
  await tx.wait();
  console.log('Granted ACTION_ADD_WHITELIST to', OPERATOR);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

执行：
```bash
export ACM_ADDRESS=0x...
export OPERATOR=0xYourOperatorWallet
npx hardhat run scripts/ops/grant-add-whitelist.ts --network arbitrumSepolia
```

验证：
```bash
npx hardhat console --network arbitrumSepolia --eval "(async()=>{const {ethers}=require('hardhat');const a=await ethers.getContractAt('AccessControlManager', process.env.ACM_ADDRESS);const k=ethers.keccak256(ethers.toUtf8Bytes('ADD_WHITELIST'));console.log(await a.hasRole(k, process.env.OPERATOR));})()"
```

---

### 步骤四：将新代币加入资产白名单（AssetWhitelist）
前提：
- `AssetWhitelist` 已经 `initialize(registry)`，其内部会通过 `Registry.getModule(KEY_ACCESS_CONTROL)` 校验权限；
- 使用已被授予 `ACTION_ADD_WHITELIST` 的账户调用。

示例脚本 `scripts/ops/add-to-asset-whitelist.ts`：
```ts
import { ethers } from 'hardhat';

const ASSET_WHITELIST = process.env.ASSET_WHITELIST!;
const RWA_TOKEN_ADDRESS = process.env.RWA_TOKEN_ADDRESS!;

async function main() {
  if (!ASSET_WHITELIST || !RWA_TOKEN_ADDRESS) throw new Error('Missing env: ASSET_WHITELIST / RWA_TOKEN_ADDRESS');
  const aw = await ethers.getContractAt('AssetWhitelist', ASSET_WHITELIST);
  const tx = await aw.addAllowedAsset(RWA_TOKEN_ADDRESS);
  await tx.wait();
  console.log('Added to whitelist:', RWA_TOKEN_ADDRESS);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

执行：
```bash
export ASSET_WHITELIST=0x...
export RWA_TOKEN_ADDRESS=0x...
npx hardhat run scripts/ops/add-to-asset-whitelist.ts --network arbitrumSepolia
```

验证：
```bash
# 1) 查询是否在白名单
npx hardhat console --network arbitrumSepolia --eval "(async()=>{const {ethers}=require('hardhat');const aw=await ethers.getContractAt('AssetWhitelist', process.env.ASSET_WHITELIST);console.log(await aw.isAssetAllowed(process.env.RWA_TOKEN_ADDRESS));console.log(await aw.getAllowedAssets());})()"
```

---

### 可选步骤：价格与前端展示配置
- 价格（可选）：若需在前端/风控显示价格，可将该资产配置进 `PriceOracle`。
  - 使用 `scripts/utils/configure-assets.ts` 中的 `configureAssets` 帮助函数；
  - 提供 `coingeckoId/decimals/maxPriceAge/active` 等元数据。
- 前端（可选）：
  - 快速方案：在 `frontend-config`/mock 数据中登记新代币的元信息以便展示；
  - 标准方案：前端读取 `AssetWhitelist.getAllowedAssets()`，并结合配置的价格/元数据渲染投资列表。

---

### 常见问题
- 提示权限不足（缺 `ACTION_ADD_WHITELIST`）：
  - 使用 `ACM.owner()` 账户执行 `grantRole(keccak256('ADD_WHITELIST'), operator)`；
  - 确保 `AssetWhitelist` 的 `registry` 指向当前活跃的 `Registry`。
- `setModule` 失败：
  - 确认调用账户是 `Registry.owner()`；
  - 确认 `RegistryCore` 已设置；
  - 确认传入地址为合约地址且非零地址。
- `AssetWhitelist` 报错 `ZeroAddress`：
  - 需先 `initialize(registry)`；或重新部署并正确初始化。

---

### 参考文件（仓库内）
- `contracts/Token/RWAToken.sol`
- `contracts/access/AssetWhitelist.sol`
- `contracts/registry/Registry.sol`
- `contracts/constants/ModuleKeys.sol`
- `contracts/constants/ActionKeys.sol`
- `scripts/utils/configure-assets.ts`


