import { ethers, network } from "hardhat";
import type { Interface } from "ethers";
import { envBool, loadAddressMap, resolveAddress } from "./_addressResolver";

function key(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function actionKey(actionName: string): string {
  // Matches Solidity: bytes32 public constant ACTION_* = keccak256("<ACTION_NAME>");
  return ethers.keccak256(ethers.toUtf8Bytes(actionName));
}

function shortAddr(a: string): string {
  if (!a) return a;
  return a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function extractRevertData(e: any): string | null {
  const candidates = [
    e?.data,
    e?.data?.data,
    e?.data?.result,
    e?.error?.data,
    e?.error?.data?.data,
    e?.error?.data?.result,
    e?.info?.error?.data,
    e?.info?.error?.message, // sometimes contains "reverted with custom error" only
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x")) return c;
  }
  return null;
}

function decodeRevert(data: string | null): { selector: string; decoded: string } {
  if (!data || data === "0x") return { selector: "<empty>", decoded: "<empty revert data>" };
  if (!data.startsWith("0x") || data.length < 10) return { selector: "<unknown>", decoded: data };

  const selector = data.slice(0, 10).toLowerCase();
  const payload = `0x${data.slice(10)}`;
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // Error(string)
  if (selector === "0x08c379a0") {
    try {
      const [msg] = coder.decode(["string"], payload);
      return { selector, decoded: `Error("${msg}")` };
    } catch {
      return { selector, decoded: "Error(<failed to decode string>)" };
    }
  }

  // Panic(uint256)
  if (selector === "0x4e487b71") {
    try {
      const [code] = coder.decode(["uint256"], payload);
      return { selector, decoded: `Panic(${code.toString()})` };
    } catch {
      return { selector, decoded: "Panic(<failed to decode>)" };
    }
  }

  // Known custom errors encountered in local smoke flows.
  const known: Record<string, string> = {
    [ethers.id("MissingRole()").slice(0, 10)]: "MissingRole()",
    [ethers.id("SettlementManager__NotLiquidatable()").slice(0, 10)]: "SettlementManager__NotLiquidatable()",
    [ethers.id("SettlementManager__InvalidOrderId()").slice(0, 10)]: "SettlementManager__InvalidOrderId()",
    [ethers.id("SettlementManager__NoCollateral()").slice(0, 10)]: "SettlementManager__NoCollateral()",
    [ethers.id("SettlementManager__OrderMismatch()").slice(0, 10)]: "SettlementManager__OrderMismatch()",
    [ethers.id("ZeroAddress()").slice(0, 10)]: "ZeroAddress()",
    [ethers.id("AmountIsZero()").slice(0, 10)]: "AmountIsZero()",
    [ethers.id("ModuleNotRegistered(bytes32)").slice(0, 10)]: "ModuleNotRegistered(bytes32)",
    [ethers.id("PriceOracle__AssetNotSupported()").slice(0, 10)]: "PriceOracle__AssetNotSupported()",
    [ethers.id("PriceOracle__StalePrice()").slice(0, 10)]: "PriceOracle__StalePrice()",
    [ethers.id("PriceOracle__InvalidPrice()").slice(0, 10)]: "PriceOracle__InvalidPrice()",
    [ethers.id("PriceOracle__InvalidTimestamp()").slice(0, 10)]: "PriceOracle__InvalidTimestamp()",
    [ethers.id("CollateralManager__ZeroAddress()").slice(0, 10)]: "CollateralManager__ZeroAddress()",
    [ethers.id("CollateralManager__InvalidAmount()").slice(0, 10)]: "CollateralManager__InvalidAmount()",
    [ethers.id("CollateralManager__InsufficientCollateral()").slice(0, 10)]: "CollateralManager__InsufficientCollateral()",
    [ethers.id("CollateralManager__UnauthorizedAccess()").slice(0, 10)]: "CollateralManager__UnauthorizedAccess()",
    [ethers.id("LiquidationManager__OnlySettlementManager()").slice(0, 10)]: "LiquidationManager__OnlySettlementManager()",
    [ethers.id("LiquidationPayoutManager__InvalidRates()").slice(0, 10)]: "LiquidationPayoutManager__InvalidRates()",
    [ethers.id("LiquidationPayoutManager__AccessControlMismatch(address,address)").slice(0, 10)]: "LiquidationPayoutManager__AccessControlMismatch(address,address)",
    [ethers.id("AccessControlManager__InvalidRole()").slice(0, 10)]: "AccessControlManager__InvalidRole()",
    [ethers.id("AccessControlManager__RoleAlreadyGranted()").slice(0, 10)]:
      "AccessControlManager__RoleAlreadyGranted()",
    [ethers.id("AccessControlManager__RoleNotGranted()").slice(0, 10)]: "AccessControlManager__RoleNotGranted()",
    [ethers.id("AccessControlManager__OnlyOwnerAllowed()").slice(0, 10)]: "AccessControlManager__OnlyOwnerAllowed()",
    [ethers.id("OnlyKeeperAllowed()").slice(0, 10)]: "OnlyKeeperAllowed()",
    [ethers.id("ContractPaused()").slice(0, 10)]: "ContractPaused()",
    [ethers.id("InvalidKeeperAddress()").slice(0, 10)]: "InvalidKeeperAddress()",
  };
  return { selector, decoded: known[selector] ?? `CustomError(selector=${selector})` };
}

async function callAs(from: string, to: string, data: string): Promise<string> {
  return await ethers.provider.call({ to, from, data });
}

const YEAR = 365n * 24n * 60n * 60n;
function calcInterest(principal: bigint, rate: bigint, term: bigint): bigint {
  return (principal * rate * term) / (YEAR * 10000n);
}

async function readAddressSlot(contractAddr: string, slotIndex: number): Promise<string> {
  const raw = await ethers.provider.getStorage(contractAddr, slotIndex);
  if (!raw || raw.length < 66) return ethers.ZeroAddress;
  const addr = `0x${raw.slice(-40)}`;
  try {
    return ethers.getAddress(addr);
  } catch {
    return ethers.ZeroAddress;
  }
}

async function readEip1967Implementation(proxyAddr: string): Promise<string> {
  const implSlot =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const raw = await ethers.provider.getStorage(proxyAddr, implSlot);
  if (!raw || raw.length < 66) return ethers.ZeroAddress;
  const addr = `0x${raw.slice(-40)}`;
  try {
    return ethers.getAddress(addr);
  } catch {
    return ethers.ZeroAddress;
  }
}

async function findAddressSlot(
  contractAddr: string,
  target: string,
  maxSlots: number
): Promise<number | null> {
  for (let i = 0; i <= maxSlots; i += 1) {
    const v = await readAddressSlot(contractAddr, i);
    if (v.toLowerCase() === target.toLowerCase()) return i;
  }
  return null;
}

async function findRegistryInStorage(
  contractAddr: string,
  registryIface: Interface,
  key: string,
  expectedModule: string,
  maxSlots: number
): Promise<{ slot: number; addr: string } | null> {
  for (let i = 0; i <= maxSlots; i += 1) {
    const addr = await readAddressSlot(contractAddr, i);
    if (addr === ethers.ZeroAddress) continue;
    const res = await tryCallAs(ethers.ZeroAddress, addr, registryIface, "getModule", [key]);
    if (res.ok) {
      const moduleAddr = (res.decoded.length === 1 ? res.decoded[0] : res.decoded) as string;
      if (moduleAddr.toLowerCase() === expectedModule.toLowerCase()) {
        return { slot: i, addr };
      }
    }
  }
  return null;
}

async function tryCallAs(
  from: string,
  to: string,
  iface: Interface,
  fn: string,
  args: unknown[]
): Promise<{ ok: true; decoded: any } | { ok: false; selector: string; decoded: string; raw: string | null }> {
  const data = iface.encodeFunctionData(fn, args);
  try {
    const res = await callAs(from, to, data);
    return { ok: true, decoded: iface.decodeFunctionResult(fn, res) };
  } catch (e: any) {
    const raw = extractRevertData(e);
    const { selector, decoded } = decodeRevert(raw);
    if (decoded === "<empty revert data>" && typeof e?.message === "string") {
      const match = e.message.match(/reverted with custom error '([^']+)'/i);
      if (match?.[1]) {
        return { ok: false, selector: "<message>", decoded: `${match[1]}()`, raw };
      }
      const msg = e.message.match(/reverted with reason string '([^']+)'/i);
      if (msg?.[1]) {
        return { ok: false, selector: "<message>", decoded: `Error("${msg[1]}")`, raw };
      }
    }
    return { ok: false, selector, decoded, raw };
  }
}

async function tryExecAs(
  from: string,
  to: string,
  iface: Interface,
  fn: string,
  args: unknown[],
  sendTx: boolean
): Promise<{ ok: true; decoded: any } | { ok: false; selector: string; decoded: string; raw: string | null }> {
  if (!sendTx) {
    return await tryCallAs(from, to, iface, fn, args);
  }
  const data = iface.encodeFunctionData(fn, args);
  try {
    if (from === ethers.ZeroAddress) {
      throw new Error("sendTx requires a signer address");
    }
    const signer = await ethers.getSigner(from);
    const tx = await signer.sendTransaction({ to, data });
    const receipt = await tx.wait();
    return { ok: true, decoded: receipt };
  } catch (e: any) {
    const raw = extractRevertData(e);
    const { selector, decoded } = decodeRevert(raw);
    if (decoded === "<empty revert data>" && typeof e?.message === "string") {
      const match = e.message.match(/reverted with custom error '([^']+)'/i);
      if (match?.[1]) {
        return { ok: false, selector: "<message>", decoded: `${match[1]}()`, raw };
      }
      const msg = e.message.match(/reverted with reason string '([^']+)'/i);
      if (msg?.[1]) {
        return { ok: false, selector: "<message>", decoded: `Error("${msg[1]}")`, raw };
      }
    }
    return { ok: false, selector, decoded, raw };
  }
}

async function tryCallRawAs(
  from: string,
  to: string,
  data: string
): Promise<{ ok: true; decoded: string } | { ok: false; selector: string; decoded: string; raw: string | null }> {
  try {
    const res = await callAs(from, to, data);
    return { ok: true, decoded: res };
  } catch (e: any) {
    const raw = extractRevertData(e);
    const { selector, decoded } = decodeRevert(raw);
    if (decoded === "<empty revert data>" && typeof e?.message === "string") {
      const match = e.message.match(/reverted with custom error '([^']+)'/i);
      if (match?.[1]) {
        return { ok: false, selector: "<message>", decoded: `${match[1]}()`, raw };
      }
      const msg = e.message.match(/reverted with reason string '([^']+)'/i);
      if (msg?.[1]) {
        return { ok: false, selector: "<message>", decoded: `Error("${msg[1]}")`, raw };
      }
    }
    return { ok: false, selector, decoded, raw };
  }
}

async function tryExecRawAs(
  from: string,
  to: string,
  data: string,
  sendTx: boolean
): Promise<{ ok: true; decoded: any } | { ok: false; selector: string; decoded: string; raw: string | null }> {
  if (!sendTx) {
    return await tryCallRawAs(from, to, data);
  }
  try {
    if (from === ethers.ZeroAddress) {
      throw new Error("sendTx requires a signer address");
    }
    const signer = await ethers.getSigner(from);
    const tx = await signer.sendTransaction({ to, data });
    const receipt = await tx.wait();
    return { ok: true, decoded: receipt };
  } catch (e: any) {
    const raw = extractRevertData(e);
    const { selector, decoded } = decodeRevert(raw);
    if (decoded === "<empty revert data>" && typeof e?.message === "string") {
      const match = e.message.match(/reverted with custom error '([^']+)'/i);
      if (match?.[1]) {
        return { ok: false, selector: "<message>", decoded: `${match[1]}()`, raw };
      }
      const msg = e.message.match(/reverted with reason string '([^']+)'/i);
      if (msg?.[1]) {
        return { ok: false, selector: "<message>", decoded: `Error("${msg[1]}")`, raw };
      }
    }
    return { ok: false, selector, decoded, raw };
  }
}

function parseEnvBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  return BigInt(raw);
}

function requireOk<T>(
  res: { ok: true; decoded: T } | { ok: false; selector: string; decoded: string; raw: string | null },
  label: string
): T {
  if (res.ok) return res.decoded;
  const selector = res.selector ?? "<unknown>";
  const raw = res.raw ?? "<no revert data>";
  throw new Error(`[StrictCheck] ${label} failed: ${res.decoded} (selector=${selector}, raw=${raw})`);
}

function requireFail(
  res: { ok: true; decoded: any } | { ok: false; selector: string; decoded: string; raw: string | null },
  label: string
): { selector: string; decoded: string; raw: string | null } {
  if (!res.ok) return res;
  throw new Error(`[StrictCheck] ${label} expected revert but succeeded`);
}

async function requireCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(
      `[DeployCheck] ${label} has no code at ${address}. ` +
        `If localhost is not deployed yet, run: pnpm -s run deploy:localhost`
    );
  }
}

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("[Config] No signer available from Hardhat runtime.");
  }
  const deployer = signers[0];
  const keeper = signers[1] ?? deployer;
  const user = signers[2] ?? deployer;
  const strictTx =
    String(process.env.STRICT_TX ?? "") === "1" || String(process.env.REAL_TX ?? "") === "1";
  const allowAggregatedDebt = String(process.env.ALLOW_AGGREGATED_DEBT ?? "") === "1";

  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);

  const addressMap = loadAddressMap(network.name);
  const registryAddrRaw =
    process.env.REGISTRY_ADDR ??
    process.env.REGISTRY ??
    process.env.REGISTRY_ADDRESS ??
    "";
  const registryAddr =
    registryAddrRaw ||
    resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

  console.log(`=== Funds Flow Smoke (${network.name}) ===\n`);
  console.log(`  Config: READ_ONLY=${readOnly} ENABLE_WRITE=${enableWrite}`);
  console.log("  Registry:", registryAddr);
  console.log("  Deployer:", deployer.address);
  console.log("  Keeper:", keeper.address);
  console.log("  User:", user.address);
  if (signers.length < 3) {
    console.log(`  Signers: only ${signers.length} available; reusing deployer for missing keeper/user accounts.`);
  }
  console.log("");
  if (strictTx) {
    console.log("  STRICT_TX enabled: VaultCore strict checks will send transactions.\n");
  }
  if (allowAggregatedDebt) {
    console.log("  ALLOW_AGGREGATED_DEBT enabled: ledger/order mismatches will be logged, not fatal.\n");
  }

  await requireCode(registryAddr, "Registry");

  const registryAbi = [
    "function getModule(bytes32 key) external view returns (address)",
    "function getModuleOrRevert(bytes32 key) external view returns (address)",
  ];
  const registry = await ethers.getContractAt(registryAbi, registryAddr);

  const KEY_VAULT_CORE = key("VAULT_CORE");
  const KEY_SETTLEMENT_MANAGER = key("SETTLEMENT_MANAGER");
  const KEY_ACCESS_CONTROL_MANAGER = key("ACCESS_CONTROL_MANAGER");
  const KEY_ORDER_ENGINE = key("ORDER_ENGINE");
  const KEY_LENDING_ENGINE = key("LENDING_ENGINE");
  const KEY_COLLATERAL_MANAGER = key("COLLATERAL_MANAGER");
  const KEY_FEE_ROUTER = key("FEE_ROUTER");
  const KEY_LENDER_POOL_VAULT = key("LENDER_POOL_VAULT");
  const KEY_VAULT_BUSINESS_LOGIC = key("VAULT_BUSINESS_LOGIC");
  const KEY_LIQUIDATION_RISK_MANAGER = key("LIQUIDATION_RISK_MANAGER");
  const KEY_POSITION_VIEW = key("POSITION_VIEW");
  const KEY_LOAN_NFT = key("LOAN_NFT");
  const KEY_PRICE_ORACLE = key("PRICE_ORACLE");
  const KEY_LIQUIDATION_MANAGER = key("LIQUIDATION_MANAGER");
  const KEY_LIQUIDATION_PAYOUT_MANAGER = key("LIQUIDATION_PAYOUT_MANAGER");

  const vaultCoreAddr: string = await registry.getModule(KEY_VAULT_CORE);
  const settlementManagerAddr: string = await registry.getModule(KEY_SETTLEMENT_MANAGER);
  const accessControlAddr: string = await registry.getModule(KEY_ACCESS_CONTROL_MANAGER);

  console.log("  Registry.KEY_VAULT_CORE:", vaultCoreAddr);
  console.log("  Registry.KEY_SETTLEMENT_MANAGER:", settlementManagerAddr);
  console.log("  Registry.KEY_ACCESS_CONTROL_MANAGER:", accessControlAddr);
  console.log("");

  if (vaultCoreAddr === ethers.ZeroAddress || settlementManagerAddr === ethers.ZeroAddress) {
    throw new Error(
      `[DeployCheck] Registry is missing required modules. ` +
        `Expected non-zero: VAULT_CORE and SETTLEMENT_MANAGER. ` +
        `Run: pnpm -s run deploy:localhost`
    );
  }

  await requireCode(vaultCoreAddr, "VaultCore");
  await requireCode(settlementManagerAddr, "SettlementManager");
  if (accessControlAddr === ethers.ZeroAddress) {
    throw new Error(
      "[Config] Registry.KEY_ACCESS_CONTROL_MANAGER is zero. " +
        "Bind AccessControlManager before running this smoke test."
    );
  }

  if (readOnly || !enableWrite) {
    console.log("  ℹ️  [skip] write-heavy keeper-path scenario in read-only mode.");
    console.log("      To run the full scenario, use --network localhost and set ENABLE_WRITE=1.");
    console.log("\n✅ Funds Flow Smoke (read-only) PASSED\n");
    return;
  }
  await requireCode(accessControlAddr, "AccessControlManager");

  const vaultCore = await ethers.getContractAt(
    [
      "function viewContractAddrVar() external view returns (address)",
      "function registryAddrVar() external view returns (address)",
    ],
    vaultCoreAddr
  );
  const viewAddr: string = await vaultCore.viewContractAddrVar();
  console.log("  VaultCore.viewContractAddrVar():", viewAddr);
  if (viewAddr === ethers.ZeroAddress) {
    throw new Error("[StrictCheck] viewContractAddrVar() is zero (VaultRouter/View not set).");
  }
  const vaultCoreRegistry: string = await vaultCore.registryAddrVar();
  if (vaultCoreRegistry.toLowerCase() !== registryAddr.toLowerCase()) {
    throw new Error(
      `[StrictCheck] VaultCore.registryAddrVar mismatch. expected=${registryAddr} actual=${vaultCoreRegistry}`
    );
  }
  console.log("");

  // --- Keeper path smoke: SettlementManager.settleOrLiquidate(orderId) ---
  const orderId = parseEnvBigint("ORDER_ID", 1n);
  console.log(`--- Keeper path: settleOrLiquidate(orderId=${orderId}) ---`);

  const ACTION_LIQUIDATE = actionKey("LIQUIDATE");
  const ACTION_VIEW_SYSTEM_DATA = actionKey("VIEW_SYSTEM_DATA");
  const ACTION_REPAY = actionKey("REPAY");
  const acmAbi = [
    "function hasRole(bytes32 role, address caller) external view returns (bool)",
  ];
  const settlementAbi = ["function settleOrLiquidate(uint256 orderId) external"];

  const settlementManager: any = await ethers.getContractAt(settlementAbi, settlementManagerAddr);
  let acm: any = null;

  acm = await ethers.getContractAt(acmAbi, accessControlAddr);
  const keeperHas = await acm.hasRole(ACTION_LIQUIDATE, keeper.address);
  console.log("  ACM:", shortAddr(accessControlAddr));
  console.log("  ACTION_LIQUIDATE:", ACTION_LIQUIDATE);
  console.log("  keeper hasRole(ACTION_LIQUIDATE):", keeperHas);
  if (!keeperHas) {
    throw new Error(
      "[AccessControl] Missing ACTION_LIQUIDATE for keeper. " +
        "Production-like mode: this smoke does not auto-grant roles. " +
        "Grant the role before running (see scripts/tests/README.md)."
    );
  }
  console.log("");

  if (acm) {
    const hasView = await acm.hasRole(ACTION_VIEW_SYSTEM_DATA, settlementManagerAddr);
    console.log("  settlementManager hasRole(ACTION_VIEW_SYSTEM_DATA):", hasView);
    if (!hasView) {
      throw new Error(
        "[AccessControl] SettlementManager missing ACTION_VIEW_SYSTEM_DATA. " +
          "Production-like mode: this smoke does not auto-grant roles. " +
          "Grant the role before running (see scripts/tests/README.md)."
      );
    }
    const hasRepay = await acm.hasRole(ACTION_REPAY, settlementManagerAddr);
    console.log("  settlementManager hasRole(ACTION_REPAY):", hasRepay);
    if (!hasRepay) {
      throw new Error(
        "[AccessControl] SettlementManager missing ACTION_REPAY. " +
          "Production-like mode: this smoke does not auto-grant roles. " +
          "Grant the role before running (see scripts/tests/README.md)."
      );
    }
    console.log("");
  }

  console.log("  Preflight checks:");
  const orderEngineAddr: string = await registry.getModule(KEY_ORDER_ENGINE);
  const lendingEngineAddr: string = await registry.getModule(KEY_LENDING_ENGINE);
  const collateralManagerAddr: string = await registry.getModule(KEY_COLLATERAL_MANAGER);
  const feeRouterAddr: string = await registry.getModule(KEY_FEE_ROUTER);
  const lenderPoolVaultAddr: string = await registry.getModule(KEY_LENDER_POOL_VAULT);
  const vaultBusinessLogicAddr: string = await registry.getModule(KEY_VAULT_BUSINESS_LOGIC);
  const riskManagerAddr: string = await registry.getModule(KEY_LIQUIDATION_RISK_MANAGER);
  const positionViewAddr: string = await registry.getModule(KEY_POSITION_VIEW);
  const loanNftAddr: string = await registry.getModule(KEY_LOAN_NFT);
  const priceOracleAddr: string = await registry.getModule(KEY_PRICE_ORACLE);
  const liquidationManagerAddr: string = await registry.getModule(KEY_LIQUIDATION_MANAGER);
  const liquidationPayoutAddr: string = await registry.getModule(KEY_LIQUIDATION_PAYOUT_MANAGER);

  console.log("  - ORDER_ENGINE:", shortAddr(orderEngineAddr));
  console.log("  - LENDING_ENGINE:", shortAddr(lendingEngineAddr));
  console.log("  - COLLATERAL_MANAGER:", shortAddr(collateralManagerAddr));
  console.log("  - FEE_ROUTER:", shortAddr(feeRouterAddr));
  console.log("  - LENDER_POOL_VAULT:", shortAddr(lenderPoolVaultAddr));
  console.log("  - VAULT_BUSINESS_LOGIC:", shortAddr(vaultBusinessLogicAddr));
  console.log("  - LIQUIDATION_RISK_MANAGER:", shortAddr(riskManagerAddr));
  console.log("  - POSITION_VIEW:", shortAddr(positionViewAddr));
  console.log("  - PRICE_ORACLE:", shortAddr(priceOracleAddr));
  console.log("  - LIQUIDATION_MANAGER:", shortAddr(liquidationManagerAddr));
  console.log("  - LIQUIDATION_PAYOUT_MANAGER:", shortAddr(liquidationPayoutAddr));
  if (loanNftAddr !== ethers.ZeroAddress) {
    console.log("  - LOAN_NFT:", shortAddr(loanNftAddr));
  }
  console.log("  - registry (full):", registryAddr);
  console.log("  - liquidationManager (full):", liquidationManagerAddr);
  console.log("  - settlementManager (full):", settlementManagerAddr);
  const lmImpl = await readEip1967Implementation(liquidationManagerAddr);
  const smImpl = await readEip1967Implementation(settlementManagerAddr);
  console.log("  - liquidationManager impl:", lmImpl);
  console.log("  - settlementManager impl:", smImpl);

  if (
    orderEngineAddr === ethers.ZeroAddress ||
    lendingEngineAddr === ethers.ZeroAddress ||
    collateralManagerAddr === ethers.ZeroAddress ||
    feeRouterAddr === ethers.ZeroAddress ||
    lenderPoolVaultAddr === ethers.ZeroAddress ||
    vaultBusinessLogicAddr === ethers.ZeroAddress ||
    riskManagerAddr === ethers.ZeroAddress ||
    positionViewAddr === ethers.ZeroAddress ||
    priceOracleAddr === ethers.ZeroAddress ||
    liquidationManagerAddr === ethers.ZeroAddress ||
    liquidationPayoutAddr === ethers.ZeroAddress
  ) {
    throw new Error("[DeployCheck] Registry missing funds-flow modules.");
  }

  await requireCode(orderEngineAddr, "OrderEngine");
  await requireCode(lendingEngineAddr, "LendingEngine");
  await requireCode(collateralManagerAddr, "CollateralManager");
  await requireCode(feeRouterAddr, "FeeRouter");
  await requireCode(lenderPoolVaultAddr, "LenderPoolVault");
  await requireCode(vaultBusinessLogicAddr, "VaultBusinessLogic");
  await requireCode(riskManagerAddr, "LiquidationRiskManager");
  await requireCode(positionViewAddr, "PositionView");
  await requireCode(priceOracleAddr, "PriceOracle");
  await requireCode(liquidationManagerAddr, "LiquidationManager");
  await requireCode(liquidationPayoutAddr, "LiquidationPayoutManager");
  const vaultRouterResolved = viewAddr;
  console.log("  - vaultRouter resolved (full):", vaultRouterResolved);
  if (!vaultRouterResolved || vaultRouterResolved === ethers.ZeroAddress) {
    throw new Error("[StrictCheck] vaultRouter resolved is zero. Check VaultCore.viewContractAddrVar.");
  }
  if (liquidationManagerAddr === ethers.ZeroAddress || settlementManagerAddr === ethers.ZeroAddress) {
    console.log("  ⚠️  [Config] liquidation/settlement manager is zero address.");
  }
  const registryVarIface = new ethers.Interface(["function registryAddrVar() view returns (address)"]);
  const smReg = await tryCallAs(
    ethers.ZeroAddress,
    settlementManagerAddr,
    registryVarIface,
    "registryAddrVar",
    []
  );
  if (smReg.ok) {
    const addr = (smReg.decoded.length === 1 ? smReg.decoded[0] : smReg.decoded) as string;
    console.log("  - settlementManager registryAddrVar:", addr);
    if (addr.toLowerCase() !== registryAddr.toLowerCase()) {
      throw new Error("[StrictCheck] SettlementManager registry mismatch.");
    }
  } else {
    throw new Error(`[StrictCheck] SettlementManager registryAddrVar read failed: ${smReg.decoded}`);
  }
  const lmReg = await tryCallAs(
    ethers.ZeroAddress,
    liquidationManagerAddr,
    registryVarIface,
    "registryAddrVar",
    []
  );
  if (lmReg.ok) {
    const addr = (lmReg.decoded.length === 1 ? lmReg.decoded[0] : lmReg.decoded) as string;
    console.log("  - liquidationManager registryAddrVar:", addr);
    if (addr.toLowerCase() !== registryAddr.toLowerCase()) {
      throw new Error("[StrictCheck] LiquidationManager registry mismatch.");
    }
  } else {
    throw new Error(`[StrictCheck] LiquidationManager registryAddrVar read failed: ${lmReg.decoded}`);
  }
  const registryIface = new ethers.Interface(["function getModule(bytes32 key) view returns (address)"]);
  const cmRegistrySlot0 = await readAddressSlot(collateralManagerAddr, 0);
  const cmRegistrySlot1 = await readAddressSlot(collateralManagerAddr, 1);
  console.log("  - collateralManager registry slot0:", shortAddr(cmRegistrySlot0));
  console.log("  - collateralManager registry slot1:", shortAddr(cmRegistrySlot1));
  const cmRegistrySlot = await findAddressSlot(collateralManagerAddr, registryAddr, 80);
  if (cmRegistrySlot === null) {
    console.log("  - collateralManager registry slot: <not found within 0..80>");
  } else {
    console.log(`  - collateralManager registry slot: ${cmRegistrySlot}`);
  }
  const cmRegistryGuess = await findRegistryInStorage(
    collateralManagerAddr,
    registryIface,
    KEY_LIQUIDATION_MANAGER,
    liquidationManagerAddr,
    80
  );
  if (cmRegistryGuess) {
    console.log(
      `  - collateralManager registry guessed: ${shortAddr(cmRegistryGuess.addr)} (slot ${cmRegistryGuess.slot})`
    );
    const cmLm = await tryCallAs(
      ethers.ZeroAddress,
      cmRegistryGuess.addr,
      registryIface,
      "getModule",
      [KEY_LIQUIDATION_MANAGER]
    );
    if (cmLm.ok) {
      const addr = (cmLm.decoded.length === 1 ? cmLm.decoded[0] : cmLm.decoded) as string;
      console.log(`  - CM registry liquidationManager: ${addr}`);
      console.log(
        `  - CM registry liquidationManager matches: ${addr.toLowerCase() === liquidationManagerAddr.toLowerCase()}`
      );
    } else {
      console.log(`  - CM registry liquidationManager read failed: ${cmLm.decoded}`);
    }
    const cmSm = await tryCallAs(
      ethers.ZeroAddress,
      cmRegistryGuess.addr,
      registryIface,
      "getModule",
      [KEY_SETTLEMENT_MANAGER]
    );
    if (cmSm.ok) {
      const addr = (cmSm.decoded.length === 1 ? cmSm.decoded[0] : cmSm.decoded) as string;
      console.log(`  - CM registry settlementManager: ${addr}`);
      console.log(
        `  - CM registry settlementManager matches: ${addr.toLowerCase() === settlementManagerAddr.toLowerCase()}`
      );
    } else {
      console.log(`  - CM registry settlementManager read failed: ${cmSm.decoded}`);
    }
    const cmVr = await tryCallAs(
      ethers.ZeroAddress,
      cmRegistryGuess.addr,
      registryIface,
      "getModule",
      [KEY_VAULT_CORE]
    );
    if (cmVr.ok) {
      const addr = (cmVr.decoded.length === 1 ? cmVr.decoded[0] : cmVr.decoded) as string;
      console.log(`  - CM registry vaultCore: ${addr}`);
    } else {
      console.log(`  - CM registry vaultCore read failed: ${cmVr.decoded}`);
    }
    if (cmRegistryGuess.addr.toLowerCase() !== registryAddr.toLowerCase()) {
      throw new Error("[StrictCheck] CollateralManager registry differs from Registry.");
    }
  } else {
    throw new Error("[StrictCheck] CollateralManager registry not found within slot scan.");
  }
  if (acm && liquidationManagerAddr !== ethers.ZeroAddress) {
    const hasLiquidate = await acm.hasRole(ACTION_LIQUIDATE, liquidationManagerAddr);
    console.log("  liquidationManager hasRole(ACTION_LIQUIDATE):", hasLiquidate);
    if (!hasLiquidate) {
      throw new Error(
        "[AccessControl] Missing ACTION_LIQUIDATE for LiquidationManager. " +
          "Grant role before running this smoke test."
      );
    }
    console.log("");
  }

  const orderEngineIface = new ethers.Interface([
    "function getLoanOrderForView(uint256) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
  ]);
  const loanNftIface = new ethers.Interface([
    "function getUserTokens(address user) view returns (uint256[])",
    "function getLoanMetadata(uint256 tokenId) view returns (tuple(uint256 principal,uint256 rate,uint256 term,uint256 oraclePrice,uint256 loanId,bytes32 collateralHash,uint8 status))",
  ]);
  const leIface = new ethers.Interface([
    "function getDebt(address user, address asset) view returns (uint256)",
    "function getReducibleDebtAmount(address user, address asset) view returns (uint256)",
    "function calculateDebtValue(address user, address asset) view returns (uint256)",
    "function getUserTotalDebtValue(address user) view returns (uint256)",
  ]);
  const leWriteIface = new ethers.Interface([
    "function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays)",
    "function repay(address user, address asset, uint256 amount)",
  ]);
  const cmIface = new ethers.Interface([
    "function getUserCollateralAssets(address user) view returns (address[])",
    "function getCollateral(address user, address asset) view returns (uint256)",
  ]);
  const cmWriteIface = new ethers.Interface([
    "function depositCollateral(address user, address asset, uint256 amount)",
    "function withdrawCollateral(address user, address asset, uint256 amount)",
  ]);
  const riskIface = new ethers.Interface(["function isLiquidatable(address user) view returns (bool)"]);
  const pvIface = new ethers.Interface(["function getAssetValue(address asset, uint256 amount) view returns (uint256)"]);
  const poIface = new ethers.Interface([
    "function getPrice(address asset) view returns (uint256 price, uint256 blockNumber, uint256 assetDecimals)",
    "function getPriceData(address asset) view returns (tuple(uint256 price,uint256 blockNumber,uint256 assetDecimals,bool isValid))",
    "function getAssetConfig(address asset) view returns (tuple(string sourceId,uint256 assetDecimals,bool isActive,uint256 maxPriceAgeBlocks))",
    "function isPriceValid(address asset) view returns (bool)",
  ]);
  const erc20Abi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];
  const erc20Iface = new ethers.Interface(erc20Abi);
  const vaultCoreIface = new ethers.Interface([
    "function deposit(address asset, uint256 amount)",
    "function withdraw(address asset, uint256 amount)",
    "function borrow(address asset, uint256 amount)",
    "function repay(uint256 orderId, address asset, uint256 amount)",
    "function batchDeposit(address[] assets, uint256[] amounts)",
    "function batchWithdraw(address[] assets, uint256[] amounts)",
    "function batchBorrow(address[] assets, uint256[] amounts)",
    "function batchRepay(uint256[] orderIds, address[] assets, uint256[] amounts)",
  ]);
  const payoutIface = new ethers.Interface([
    "function getRecipients() view returns (tuple(address platform,address reserve,address lenderCompensation))",
    "function getRates() view returns (tuple(uint256 platformBps,uint256 reserveBps,uint256 lenderBps,uint256 liquidatorBps))",
  ]);
  const feeRouterIface = new ethers.Interface(["function isTokenSupported(address token) view returns (bool)"]);
  const liquidationManagerIface = new ethers.Interface([
    "function liquidateFromSettlementManager(address liquidator,address targetUser,address collateralAsset,address debtAsset,uint256 collateralAmount,uint256 debtAmount,uint256 bonus)",
  ]);
  const cmWithdrawIface = new ethers.Interface([
    "function withdrawCollateralTo(address user,address asset,uint256 amount,address receiver)",
  ]);
  const leForceIface = new ethers.Interface([
    "function forceReduceDebt(address user,address asset,uint256 amount)",
  ]);

  const orderRes = await tryCallAs(
    settlementManagerAddr,
    orderEngineAddr,
    orderEngineIface,
    "getLoanOrderForView",
    [orderId]
  );
  if (!orderRes.ok) {
    console.log(`  ❌ OrderEngine view failed: ${orderRes.decoded}`);
    if (orderRes.selector !== "<empty>") {
      console.log(`     selector: ${orderRes.selector}`);
    }
    if (orderRes.raw) {
      console.log(`     raw: ${orderRes.raw}`);
    }
    throw new Error("[Preflight] Cannot read order from OrderEngine. Fix view permissions or orderId.");
  }

  const order = orderRes.decoded[0] as {
    principal: bigint;
    rate: bigint;
    term: bigint;
    borrower: string;
    lender: string;
    asset: string;
    startBlock: bigint;
    maturity: bigint;
    repaidAmount: bigint;
  };
  const orderInterest = calcInterest(order.principal, order.rate, order.term);
  const orderTotalDue = order.principal + orderInterest;
  const orderRemainingDue = orderTotalDue > order.repaidAmount ? orderTotalDue - order.repaidAmount : 0n;
  const repaidPrincipal = order.repaidAmount > order.principal ? order.principal : order.repaidAmount;
  const remainingPrincipal = order.principal - repaidPrincipal;
  console.log("  - order.borrower:", order.borrower);
  console.log("  - order.asset:", order.asset);
  console.log("  - order.maturity:", order.maturity.toString());
  console.log("  - order.principal:", order.principal.toString());
  console.log("  - order.rate:", order.rate.toString());
  console.log("  - order.term:", order.term.toString());
  console.log("  - order.repaidAmount:", order.repaidAmount.toString());
  console.log("  - order.totalDue:", orderTotalDue.toString());
  console.log("  - order.remainingDue:", orderRemainingDue.toString());
  if (order.borrower.toLowerCase() === keeper.address.toLowerCase()) {
    throw new Error(
      "[Config] keeper == borrower. LiquidationManager path will fail because CM only allows receiver==user " +
        "for VaultRouter/SettlementManager. Use a different keeper or borrower."
    );
  }
  if (order.borrower === ethers.ZeroAddress || order.asset === ethers.ZeroAddress) {
    throw new Error(
      `[Preflight] Invalid orderId=${orderId}: OrderEngine returned zero borrower/asset. ` +
        `Use a valid orderId created by the order engine.`
    );
  }

  const debtRes = await tryCallAs(
    settlementManagerAddr,
    lendingEngineAddr,
    leIface,
    "getDebt",
    [order.borrower, order.asset]
  );
  const reducibleRes = await tryCallAs(
    settlementManagerAddr,
    lendingEngineAddr,
    leIface,
    "getReducibleDebtAmount",
    [order.borrower, order.asset]
  );
  const debtValueRes = await tryCallAs(
    settlementManagerAddr,
    lendingEngineAddr,
    leIface,
    "calculateDebtValue",
    [order.borrower, order.asset]
  );
  const totalDebtValueRes = await tryCallAs(
    settlementManagerAddr,
    lendingEngineAddr,
    leIface,
    "getUserTotalDebtValue",
    [order.borrower]
  );
  const riskRes = await tryCallAs(
    settlementManagerAddr,
    riskManagerAddr,
    riskIface,
    "isLiquidatable",
    [order.borrower]
  );

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) {
    throw new Error("[StrictCheck] Latest block is null; cannot compute price age.");
  }
  const nowBlock = BigInt(latestBlock.number);
  const debt = (requireOk(debtRes, "LendingEngine.getDebt")[0] ?? 0n) as bigint;
  const reducibleDebt = (requireOk(reducibleRes, "LendingEngine.getReducibleDebtAmount")[0] ?? 0n) as bigint;
  const debtValue = (requireOk(debtValueRes, "LendingEngine.calculateDebtValue")[0] ?? 0n) as bigint;
  const totalDebtValue = (requireOk(totalDebtValueRes, "LendingEngine.getUserTotalDebtValue")[0] ?? 0n) as bigint;
  const overdue = nowBlock > order.maturity && debt > 0n;
  if (loanNftAddr === ethers.ZeroAddress) {
    throw new Error("[StrictCheck] LoanNFT is not registered; cannot validate order/ledger consistency.");
  }
  const userTokensRes = await tryCallAs(
    ethers.ZeroAddress,
    loanNftAddr,
    loanNftIface,
    "getUserTokens",
    [order.borrower]
  );
  const userTokens = (requireOk(userTokensRes, "LoanNFT.getUserTokens")[0] ?? []) as bigint[];
  if (userTokens.length > 50) {
    throw new Error(
      `[StrictCheck] borrower has ${userTokens.length} LoanNFTs; refuse to scan. ` +
        "Provide a borrower with <= 50 active loans or add pagination."
    );
  }
  let matchingOrders: { orderId: bigint; remainingPrincipal: bigint; remainingDue: bigint }[] = [];
  let sumRemainingPrincipal = 0n;
  for (const tokenId of userTokens) {
    const metaRes = await tryCallAs(
      ethers.ZeroAddress,
      loanNftAddr,
      loanNftIface,
      "getLoanMetadata",
      [tokenId]
    );
    if (!metaRes.ok) continue;
    const meta = (metaRes.decoded.length === 1 ? metaRes.decoded[0] : metaRes.decoded) as {
      loanId: bigint;
      status: bigint;
    };
    // LoanStatus.Active == 0 (uint8); ethers decodes uint8 as bigint.
    if (meta.status !== 0n) continue;
    const orderRes = await tryCallAs(
      settlementManagerAddr,
      orderEngineAddr,
    orderEngineIface,
    "getLoanOrderForView",
      [meta.loanId]
    );
    if (!orderRes.ok) continue;
    const ord = (orderRes.decoded.length === 1 ? orderRes.decoded[0] : orderRes.decoded) as {
      principal: bigint;
      rate: bigint;
      term: bigint;
      borrower: string;
      asset: string;
      repaidAmount: bigint;
    };
    if (ord.borrower.toLowerCase() !== order.borrower.toLowerCase()) continue;
    if (ord.asset.toLowerCase() !== order.asset.toLowerCase()) continue;
    const remainingPrincipal = ord.principal > ord.repaidAmount ? ord.principal - ord.repaidAmount : 0n;
    if (remainingPrincipal == 0n) continue;
    const remainingDue = remainingPrincipal + calcInterest(ord.principal, ord.rate, ord.term);
    matchingOrders.push({ orderId: meta.loanId, remainingPrincipal, remainingDue });
    sumRemainingPrincipal += remainingPrincipal;
  }
  if (matchingOrders.length !== 1) {
    const detail = matchingOrders
      .map((m) => `orderId=${m.orderId.toString()} remainingPrincipal=${m.remainingPrincipal.toString()}`)
      .join(", ");
    if (!allowAggregatedDebt) {
      throw new Error(
        `[StrictCheck] expected exactly 1 active order for borrower/asset, got ${matchingOrders.length}. ` +
          `orders=[${detail}]. Use an orderId that is the only active order for this borrower/asset.`
      );
    }
    console.log(`  ⚠️  [StrictCheck] multiple active orders detected: ${detail}`);
  }
  if (matchingOrders.length === 1 && matchingOrders[0].remainingPrincipal !== debt) {
    throw new Error(
      `[StrictCheck] ledger mismatch: remainingPrincipal(${matchingOrders[0].remainingPrincipal.toString()}) ` +
        `!= currentDebt(${debt.toString()}).`
    );
  }
  console.log("  - debt:", debt.toString());
  const dueDebtDelta = orderRemainingDue > debt ? orderRemainingDue - debt : debt - orderRemainingDue;
  const expectedDelta = orderRemainingDue > remainingPrincipal
    ? orderRemainingDue - remainingPrincipal
    : remainingPrincipal - orderRemainingDue;
  console.log("  - orderRemainingDue vs currentDebt delta:", dueDebtDelta.toString());
  console.log("  - expected delta (interest + post-repay gap):", expectedDelta.toString());
  console.log("  - reducibleDebt:", reducibleDebt.toString());
  console.log("  - debtValue:", debtValue.toString());
  console.log("  - totalDebtValue:", totalDebtValue.toString());
  console.log("  - orderTotalDue vs currentDebt:", `${orderTotalDue.toString()} vs ${debt.toString()}`);
  console.log("  - orderTotalDue vs totalDebtValue:", `${orderTotalDue.toString()} vs ${totalDebtValue.toString()}`);
  if (dueDebtDelta != expectedDelta) {
    const baseMsg =
      debt > orderRemainingDue
        ? "currentDebt > remainingDue: likely multiple orders or aggregated debt"
        : "remainingDue > currentDebt (beyond interest gap): possible OrderEngine repay not reflected in LendingEngine";
    if (!allowAggregatedDebt) {
      throw new Error(
        `[Diag] ${baseMsg}. ` +
          "Single-order consistency is required. " +
          "Use an orderId that is the only active order for this borrower/asset, " +
          "or set ALLOW_AGGREGATED_DEBT=1 to downgrade this to a non-fatal info log."
      );
    }
    const diagTag = strictTx ? "ℹ️" : "⚠️";
    console.log(`  ${diagTag}  [Diag] ${baseMsg}.`);
  } else if (dueDebtDelta != 0n) {
    console.log("  ℹ️  [Diag] remainingDue != currentDebt is expected (interest/principal gap).");
  }
  console.log("  - overdue:", overdue);
  console.log("  - riskLiquidatable:", riskRes.ok ? Boolean(riskRes.decoded[0]) : "<unknown>");
  if (!riskRes.ok) {
    console.log(`  - riskLiquidatable read failed: ${riskRes.decoded}`);
    if (riskRes.raw) console.log(`    raw: ${riskRes.raw}`);
  }

  const assetsRes = await tryCallAs(
    settlementManagerAddr,
    collateralManagerAddr,
    cmIface,
    "getUserCollateralAssets",
    [order.borrower]
  );
  if (assetsRes.ok) {
    const assets = assetsRes.decoded[0] as string[];
    let bestAsset = ethers.ZeroAddress;
    let bestValue = 0n;
    let bestBal = 0n;
    for (const asset of assets) {
      const balRes = await tryCallAs(
        settlementManagerAddr,
        collateralManagerAddr,
        cmIface,
        "getCollateral",
        [order.borrower, asset]
      );
      if (!balRes.ok) continue;
      const bal = balRes.decoded[0] as bigint;
      if (bal === 0n) continue;
      const valRes = await tryCallAs(
        settlementManagerAddr,
        positionViewAddr,
        pvIface,
        "getAssetValue",
        [asset, bal]
      );
      let v = 0n;
      if (!valRes.ok) {
        console.log(`  - asset value read failed for ${shortAddr(asset)}: ${valRes.decoded}`);
        if (valRes.raw) console.log(`    raw: ${valRes.raw}`);
      } else {
        v = valRes.decoded[0] as bigint;
      }
      const priceRes = await tryCallAs(
        settlementManagerAddr,
        priceOracleAddr,
        poIface,
        "getPrice",
        [asset]
      );
      const cfgRes = await tryCallAs(
        settlementManagerAddr,
        priceOracleAddr,
        poIface,
        "getAssetConfig",
        [asset]
      );
      if (cfgRes.ok) {
        const cfg = (cfgRes.decoded.length === 1 ? cfgRes.decoded[0] : cfgRes.decoded) as {
          sourceId: string;
          assetDecimals: bigint;
          isActive: boolean;
          maxPriceAgeBlocks: bigint;
        };
        const sourceId = cfg.sourceId ?? "";
        const decimals = cfg.assetDecimals ?? 0n;
        const isActive = cfg.isActive ?? false;
        const maxPriceAge = cfg.maxPriceAgeBlocks ?? 0n;
        console.log(
          `  - asset config ${shortAddr(asset)}: active=${isActive} decimals=${decimals.toString()} maxAge=${maxPriceAge.toString()} id=${sourceId}`
        );
      } else {
        console.log(`  - asset config read failed for ${shortAddr(asset)}: ${cfgRes.decoded}`);
        if (cfgRes.raw) console.log(`    raw: ${cfgRes.raw}`);
      }
      const dataRes = await tryCallAs(
        settlementManagerAddr,
        priceOracleAddr,
        poIface,
        "getPriceData",
        [asset]
      );
      if (dataRes.ok) {
        const data = (dataRes.decoded.length === 1 ? dataRes.decoded[0] : dataRes.decoded) as {
          price: bigint;
          blockNumber: bigint;
          assetDecimals: bigint;
          isValid: boolean;
        };
        const price = data.price ?? 0n;
        const blockNumber = data.blockNumber ?? 0n;
        const decimals = data.assetDecimals ?? 0n;
        const isValid = data.isValid ?? false;
        console.log(
          `  - price data ${shortAddr(asset)}: price=${price.toString()} decimals=${decimals.toString()} block=${blockNumber.toString()} valid=${isValid}`
        );
        const ageBlocks = nowBlock > blockNumber ? nowBlock - blockNumber : 0n;
        console.log(`  - price age ${shortAddr(asset)}: ${ageBlocks.toString()} blocks`);
      } else {
        console.log(`  - price data read failed for ${shortAddr(asset)}: ${dataRes.decoded}`);
        if (dataRes.raw) console.log(`    raw: ${dataRes.raw}`);
      }
      if (priceRes.ok) {
        const [price, blockNumber, decimals] = priceRes.decoded as [bigint, bigint, bigint];
        console.log(
          `  - price ${shortAddr(asset)}: price=${price.toString()} decimals=${decimals.toString()} block=${blockNumber.toString()}`
        );
      } else {
        console.log(`  - price read failed for ${shortAddr(asset)}: ${priceRes.decoded}`);
        if (priceRes.raw) console.log(`    raw: ${priceRes.raw}`);
      }
      console.log(`  - collateral ${shortAddr(asset)}: amount=${bal.toString()} value=${v.toString()}`);
      if (v > bestValue) {
        bestValue = v;
        bestAsset = asset;
        bestBal = bal;
      }
    }
    console.log("  - collateralAssets:", assets.length);
    if (bestAsset === ethers.ZeroAddress) {
      console.log("  - bestCollateral: <none>");
    } else {
      console.log(
        `  - bestCollateral: ${shortAddr(bestAsset)} amount=${bestBal.toString()} value=${bestValue.toString()}`
      );
    }

    // Strict checks for core entrypoints (VaultCore / CollateralManager / LendingEngine).
    if (bestAsset === ethers.ZeroAddress) {
      throw new Error("[StrictCheck] No collateral asset available for entrypoint checks.");
    }
    if (bestBal === 0n) {
      throw new Error("[StrictCheck] Collateral balance is zero; cannot verify entrypoints.");
    }
    const strictCollateralAmount = 1n;
    if (bestBal < strictCollateralAmount) {
      throw new Error("[StrictCheck] Collateral balance below strict check amount.");
    }
    const debtAsset = order.asset;
    const strictBorrowAmount = 1n;
    const smAbi = ["function requireFullRepayRelease() view returns (bool)"];
    const smContract = await ethers.getContractAt(smAbi, settlementManagerAddr);
    const requireFullRepayRelease = (await smContract.requireFullRepayRelease()) as boolean;
    const strictRepayAmount =
      debt > 0n && (!requireFullRepayRelease || dueDebtDelta === expectedDelta)
        ? requireFullRepayRelease
          ? orderRemainingDue
          : 1n
        : 0n;
    const strictRepayAmountLedger =
      strictRepayAmount > 0n ? (requireFullRepayRelease ? debt : strictRepayAmount) : 0n;
    let strictRepaySkipReason = "";
    if (requireFullRepayRelease && dueDebtDelta !== expectedDelta) {
      strictRepaySkipReason = "delta-mismatch";
      const msg =
        debt > orderRemainingDue
          ? "  ℹ️  [StrictCheck] currentDebt > remainingDue (likely multiple orders); skip repay entrypoints."
          : "  ⚠️  [StrictCheck] remainingDue/currentDebt delta unexpected under strict full-repay mode; skip repay entrypoints.";
      console.log(msg);
      console.log(
        `     remainingDue=${orderRemainingDue.toString()} currentDebt=${debt.toString()} delta=${dueDebtDelta.toString()}`
      );
    }
    if (strictRepayAmount === 0n) {
      const reason = strictRepaySkipReason ? ` (${strictRepaySkipReason})` : "";
      console.log(`  ℹ️  [StrictCheck] Skip repay entrypoints${reason}.`);
    }
    if (requireFullRepayRelease && orderRemainingDue == 0n) {
      console.log(
        "  ⚠️  [StrictCheck] remainingDue is zero while strict full-repay mode is enabled; skip repay entrypoints."
      );
    }

    console.log("\n=== STRICT: VaultCore entrypoints ===");
    let borrowerSigner: any = null;
    try {
      borrowerSigner = await ethers.getSigner(order.borrower);
    } catch {
      borrowerSigner = null;
    }

    const cmAllowanceRes = await tryCallAs(
      ethers.ZeroAddress,
      bestAsset,
      erc20Iface,
      "allowance",
      [order.borrower, collateralManagerAddr]
    );
    const cmAllowance = (requireOk(cmAllowanceRes, "ERC20.allowance (borrower -> CollateralManager)")[0] ??
      0n) as bigint;
    if (cmAllowance < strictCollateralAmount) {
      if (!borrowerSigner) {
        throw new Error(
          "[StrictCheck] Missing ERC20 allowance for CollateralManager (deposit path) and borrower signer unavailable."
        );
      }
      console.log("  ⚠️  [StrictCheck] CollateralManager allowance low; auto-approving...");
      const token = (await ethers.getContractAt(erc20Abi, bestAsset)) as any;
      const tx = await token.connect(borrowerSigner).approve(collateralManagerAddr, ethers.MaxUint256);
      await tx.wait();
      const cmAllowanceAfter = await token.allowance(order.borrower, collateralManagerAddr);
      console.log("  - CM allowance after approve:", cmAllowanceAfter.toString());
      if (cmAllowanceAfter < strictCollateralAmount) {
        throw new Error(
          "[StrictCheck] Missing ERC20 allowance for CollateralManager after auto-approve."
        );
      }
    }
    const collateralBalRes = await tryCallAs(
      ethers.ZeroAddress,
      bestAsset,
      erc20Iface,
      "balanceOf",
      [order.borrower]
    );
    const collateralBal = (requireOk(collateralBalRes, "ERC20.balanceOf (borrower collateral)")[0] ??
      0n) as bigint;
    if (collateralBal < strictCollateralAmount) {
      throw new Error("[StrictCheck] Insufficient collateral token balance for deposit check.");
    }

    const coreDepositRes = await tryExecAs(
      order.borrower,
      vaultCoreAddr,
      vaultCoreIface,
      "deposit",
      [bestAsset, strictCollateralAmount],
      strictTx
    );
    requireOk(coreDepositRes, `VaultCore.deposit (${strictTx ? "tx" : "static"})`);
    const coreWithdrawRes = await tryExecAs(
      order.borrower,
      vaultCoreAddr,
      vaultCoreIface,
      "withdraw",
      [bestAsset, strictCollateralAmount],
      strictTx
    );
    requireOk(coreWithdrawRes, `VaultCore.withdraw (${strictTx ? "tx" : "static"})`);

    console.log("\n=== STRICT: VaultCore batch entrypoints ===");
    const batchAssets = [bestAsset];
    const batchDebtAssets = [debtAsset];
    const batchAmounts = [strictCollateralAmount];
    const batchBorrowAmounts = [strictBorrowAmount];
    const batchRepayAmounts = [strictRepayAmount];
    const batchOrderIds = [orderId];

    // IMPORTANT: VaultCore.batchRepay pulls tokens via transferFrom(msg.sender,...),
    // so msg.sender must approve VaultCore as spender BEFORE calling batchRepay.
    if (strictRepayAmount > 0n) {
      const debtAllowancePreRes = await tryCallAs(
        ethers.ZeroAddress,
        debtAsset,
        erc20Iface,
        "allowance",
        [order.borrower, vaultCoreAddr]
      );
      const debtAllowancePre = (requireOk(debtAllowancePreRes, "ERC20.allowance (borrower -> VaultCore)")[0] ??
        0n) as bigint;
      if (debtAllowancePre < strictRepayAmount) {
        if (!borrowerSigner) {
          throw new Error(
            "[StrictCheck] Missing ERC20 allowance for VaultCore (batchRepay path) and borrower signer unavailable."
          );
        }
        console.log("  ⚠️  [StrictCheck] VaultCore allowance low (batchRepay); auto-approving...");
        const token = (await ethers.getContractAt(erc20Abi, debtAsset)) as any;
        const tx = await token.connect(borrowerSigner).approve(vaultCoreAddr, ethers.MaxUint256);
        await tx.wait();
        const debtAllowanceAfter = await token.allowance(order.borrower, vaultCoreAddr);
        console.log("  - VaultCore allowance after approve:", debtAllowanceAfter.toString());
        if (debtAllowanceAfter < strictRepayAmount) {
          throw new Error("[StrictCheck] Missing ERC20 allowance for VaultCore after auto-approve (batchRepay).");
        }
      }
    }

    const batchDepositRes = await tryExecAs(
      order.borrower,
      vaultCoreAddr,
      vaultCoreIface,
      "batchDeposit",
      [batchAssets, batchAmounts],
      strictTx
    );
    requireOk(batchDepositRes, `VaultCore.batchDeposit (${strictTx ? "tx" : "static"})`);
    const batchWithdrawRes = await tryExecAs(
      order.borrower,
      vaultCoreAddr,
      vaultCoreIface,
      "batchWithdraw",
      [batchAssets, batchAmounts],
      strictTx
    );
    requireOk(batchWithdrawRes, `VaultCore.batchWithdraw (${strictTx ? "tx" : "static"})`);
    const batchBorrowRes = await tryExecAs(
      order.borrower,
      vaultCoreAddr,
      vaultCoreIface,
      "batchBorrow",
      [batchDebtAssets, batchBorrowAmounts],
      strictTx
    );
    if (!batchBorrowRes.ok) {
      const overdueMsg = overdue
        ? " (borrower already has an overdue order; new batchBorrow can be legitimately blocked)"
        : "";
      console.log(
        `  ❗ [StrictCheck] batchBorrow failed: ${batchBorrowRes.decoded}${overdueMsg}`
      );
    } else {
      console.log(`  - VaultCore.batchBorrow (${strictTx ? "tx" : "static"}): ok`);
    }
    if (strictRepayAmount > 0n) {
      const batchRepayRes = await tryExecAs(
        order.borrower,
        vaultCoreAddr,
        vaultCoreIface,
        "batchRepay",
        [batchOrderIds, batchDebtAssets, batchRepayAmounts],
        strictTx
      );
      if (!batchRepayRes.ok) {
        console.log(`  ❗ [StrictCheck] batchRepay failed: ${batchRepayRes.decoded}`);
        console.log("     hint: ensure remainingDue is used under strict full-repay mode.");
      } else {
        console.log(`  - VaultCore.batchRepay (${strictTx ? "tx" : "static"}): ok`);
      }
    }

    console.log("\n=== STRICT: CollateralManager entrypoints ===");
    const cmDepositRes = await tryCallAs(
      vaultRouterResolved,
      collateralManagerAddr,
      cmWriteIface,
      "depositCollateral",
      [order.borrower, bestAsset, strictCollateralAmount]
    );
    requireOk(cmDepositRes, "CM.depositCollateral (onlyVaultRouter)");
    const cmWithdrawRes = await tryCallAs(
      vaultRouterResolved,
      collateralManagerAddr,
      cmWriteIface,
      "withdrawCollateral",
      [order.borrower, bestAsset, strictCollateralAmount]
    );
    requireOk(cmWithdrawRes, "CM.withdrawCollateral (onlyVaultRouter)");

    // VaultCore.borrow is intentionally removed: borrowing must be orchestrated via SSOT matchflow
    // (VaultBusinessLogic.finalizeMatch / borrowWithRate -> VaultCore.borrowFor -> ORDER_ENGINE).
    // Therefore a raw call to the legacy selector MUST revert (unknown selector).
    const borrowSelector = ethers.id("borrow(address,uint256)").slice(0, 10);
    const borrowArgs = ethers.AbiCoder.defaultAbiCoder()
      .encode(["address", "uint256"], [debtAsset, strictBorrowAmount])
      .slice(2);
    const coreBorrowRawRes = await tryExecRawAs(
      order.borrower,
      vaultCoreAddr,
      borrowSelector + borrowArgs,
      strictTx
    );
    const fail = requireFail(coreBorrowRawRes, `VaultCore.borrow removed (${strictTx ? "tx" : "static"})`);
    console.log(`  - VaultCore.borrow removed (${strictTx ? "tx" : "static"}): reverted as expected (${fail.decoded})`);

    const debtAllowanceRes = await tryCallAs(
      ethers.ZeroAddress,
      debtAsset,
      erc20Iface,
      "allowance",
      [order.borrower, vaultCoreAddr]
    );
    const debtAllowance = (requireOk(debtAllowanceRes, "ERC20.allowance (borrower -> VaultCore)")[0] ??
      0n) as bigint;
    if (strictRepayAmount > 0n && debtAllowance < strictRepayAmount) {
      if (!borrowerSigner) {
        throw new Error(
          "[StrictCheck] Missing ERC20 allowance for VaultCore (repay path) and borrower signer unavailable."
        );
      }
      console.log("  ⚠️  [StrictCheck] VaultCore allowance low; auto-approving...");
      const token = (await ethers.getContractAt(erc20Abi, debtAsset)) as any;
      const tx = await token.connect(borrowerSigner).approve(vaultCoreAddr, ethers.MaxUint256);
      await tx.wait();
      const debtAllowanceAfter = await token.allowance(order.borrower, vaultCoreAddr);
      console.log("  - VaultCore allowance after approve:", debtAllowanceAfter.toString());
      if (debtAllowanceAfter < strictRepayAmount) {
        throw new Error(
          "[StrictCheck] Missing ERC20 allowance for VaultCore after auto-approve."
        );
      }
    }
    const debtBalRes = await tryCallAs(
      ethers.ZeroAddress,
      debtAsset,
      erc20Iface,
      "balanceOf",
      [order.borrower]
    );
    const debtBal = (requireOk(debtBalRes, "ERC20.balanceOf (borrower debt asset)")[0] ?? 0n) as bigint;
    if (strictRepayAmount > 0n && debtBal < strictRepayAmount) {
      throw new Error("[StrictCheck] Insufficient debt token balance for repay check.");
    }
    if (strictRepayAmount > 0n) {
      const coreRepayRes = await tryExecAs(
        order.borrower,
        vaultCoreAddr,
        vaultCoreIface,
        "repay",
        [orderId, debtAsset, strictRepayAmount],
        strictTx
      );
      requireOk(coreRepayRes, `VaultCore.repay (${strictTx ? "tx" : "static"})`);
    }

    console.log("\n=== STRICT: LendingEngine entrypoints ===");
    const leBorrowRes = await tryCallAs(
      vaultCoreAddr,
      lendingEngineAddr,
      leWriteIface,
      "borrow",
      [order.borrower, debtAsset, strictBorrowAmount, 0, 0]
    );
    requireOk(leBorrowRes, "LendingEngine.borrow (onlyVaultCore)");
    if (strictRepayAmountLedger > 0n) {
      const leRepayRes = await tryCallAs(
        settlementManagerAddr,
        lendingEngineAddr,
        leWriteIface,
        "repay",
        [order.borrower, debtAsset, strictRepayAmountLedger]
      );
      requireOk(leRepayRes, "LendingEngine.repay (SettlementManager)");
    }
    console.log("");

    // Liquidation parameter preview (mirror SettlementManager logic)
    if (debt > 0n && bestAsset !== ethers.ZeroAddress) {
      const debtAmount = reducibleDebt;
      const totalDebt = debt;
      const debtValueTotal = debtValue;
      const targetDebtValue = totalDebt > 0n ? (debtValueTotal * debtAmount) / totalDebt : 0n;
      let collateralAmount: bigint;
      if (bestValue == 0n || targetDebtValue == 0n) {
        collateralAmount = bestBal;
      } else {
        collateralAmount = (bestBal * targetDebtValue + bestValue - 1n) / bestValue;
        if (collateralAmount == 0n) collateralAmount = 1n;
        if (collateralAmount > bestBal) collateralAmount = bestBal;
      }
      console.log(
        `  - liquidation params: debtAmount=${debtAmount.toString()} targetDebtValue=${targetDebtValue.toString()} collateralAmount=${collateralAmount.toString()}`
      );

      const recipientsRes = await tryCallAs(
        settlementManagerAddr,
        liquidationPayoutAddr,
        payoutIface,
        "getRecipients",
        []
      );
  const feeRouterSupported = await tryCallAs(
    ethers.ZeroAddress,
    feeRouterAddr,
    feeRouterIface,
    "isTokenSupported",
    [order.asset]
  );
  if (feeRouterSupported.ok) {
    console.log("  - feeRouter supports debt asset:", Boolean(feeRouterSupported.decoded[0]));
  } else {
    console.log(`  - feeRouter.isTokenSupported failed: ${feeRouterSupported.decoded}`);
  }
      const ratesRes = await tryCallAs(
        settlementManagerAddr,
        liquidationPayoutAddr,
        payoutIface,
        "getRates",
        []
      );
      if (recipientsRes.ok) {
        const rec = (recipientsRes.decoded.length === 1 ? recipientsRes.decoded[0] : recipientsRes.decoded) as {
          platform: string;
          reserve: string;
          lenderCompensation: string;
        };
        console.log(
          `  - payout recipients: platform=${shortAddr(rec.platform)} reserve=${shortAddr(rec.reserve)} lender=${shortAddr(
            rec.lenderCompensation
          )}`
        );
      } else {
        console.log(`  - payout recipients read failed: ${recipientsRes.decoded}`);
      }
      if (ratesRes.ok) {
        const rates = (ratesRes.decoded.length === 1 ? ratesRes.decoded[0] : ratesRes.decoded) as {
          platformBps: bigint;
          reserveBps: bigint;
          lenderBps: bigint;
          liquidatorBps: bigint;
        };
        console.log(
          `  - payout rates: platform=${rates.platformBps.toString()} reserve=${rates.reserveBps.toString()} lender=${rates.lenderBps.toString()} liquidator=${rates.liquidatorBps.toString()}`
        );
      } else {
        console.log(`  - payout rates read failed: ${ratesRes.decoded}`);
      }

      const shouldLiquidate = overdue || (riskRes.ok && Boolean(riskRes.decoded[0]));
      if (shouldLiquidate) {
        const liquidateRes = await tryCallAs(
          settlementManagerAddr,
          liquidationManagerAddr,
          liquidationManagerIface,
          "liquidateFromSettlementManager",
          [keeper.address, order.borrower, bestAsset, order.asset, collateralAmount, debtAmount, 0]
        );
        requireOk(liquidateRes, "LiquidationManager.liquidateFromSettlementManager (static)");
        console.log("  - liquidationManager staticCall: ok");
      }

      const cmCall = await tryCallAs(
        liquidationManagerAddr,
        collateralManagerAddr,
        cmWithdrawIface,
        "withdrawCollateralTo",
        [order.borrower, bestAsset, collateralAmount, keeper.address]
      );
      requireOk(cmCall, "CM.withdrawCollateralTo (LiquidationManager)");
      const cmSettleCall = await tryCallAs(
        settlementManagerAddr,
        collateralManagerAddr,
        cmWithdrawIface,
        "withdrawCollateralTo",
        [order.borrower, bestAsset, 1n, order.borrower]
      );
      requireOk(cmSettleCall, "CM.withdrawCollateralTo (SettlementManager borrower)");
      const cmSettleSeizeCall = await tryCallAs(
        settlementManagerAddr,
        collateralManagerAddr,
        cmWithdrawIface,
        "withdrawCollateralTo",
        [order.borrower, bestAsset, collateralAmount, keeper.address]
      );
      requireOk(cmSettleSeizeCall, "CM.withdrawCollateralTo (SettlementManager seize)");
      console.log("  - CM.withdrawCollateralTo (settlement seize): ok");
      if (vaultRouterResolved && vaultRouterResolved !== ethers.ZeroAddress) {
        const cmVaultRouterCall = await tryCallAs(
          vaultRouterResolved,
          collateralManagerAddr,
          cmWithdrawIface,
          "withdrawCollateralTo",
          [order.borrower, bestAsset, 1n, order.borrower]
        );
        requireOk(cmVaultRouterCall, "CM.withdrawCollateralTo (VaultRouter borrower)");
        console.log("  - CM.withdrawCollateralTo (vaultRouter): ok");
      }

      const leCall = await tryCallAs(
        liquidationManagerAddr,
        lendingEngineAddr,
        leForceIface,
        "forceReduceDebt",
        [order.borrower, order.asset, debtAmount]
      );
      requireOk(leCall, "LE.forceReduceDebt (LiquidationManager)");
    }
  } else {
    console.log(`  ❌ CollateralManager read failed: ${assetsRes.decoded}`);
  }
  console.log("");

  try {
    // Use staticCall to avoid sending tx in a smoke check.
    await settlementManager.connect(keeper).settleOrLiquidate.staticCall(orderId);
    console.log("  ✅ OK: settleOrLiquidate would succeed (staticCall).");
  } catch (e: any) {
    const data = extractRevertData(e);
    const { selector, decoded } = decodeRevert(data);
    console.log(`  ❌ Reverted: ${decoded}`);
    console.log(`     selector: ${selector}`);
    if (selector === "0x94235922") {
      console.log("     hint: grant ActionKeys.ACTION_LIQUIDATE to the keeper (see above).");
    } else if (selector === "0xdac66f88") {
      console.log("     hint: order is not liquidatable (wrong orderId or conditions not met).");
      console.log("           This is expected unless the order is overdue/under-collateralized.");
    } else {
      console.log(`     raw: ${data ?? "<no revert data>"}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

