import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

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
    e?.error?.data,
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
    "0x94235922": "MissingRole()",
    "0xdac66f88": "SettlementManager__NotLiquidatable()",
    "0xd92e233d": "ZeroAddress()",
  };
  return { selector, decoded: known[selector] ?? `CustomError(selector=${selector})` };
}

function parseEnvBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  return BigInt(raw);
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
  const [deployer, keeper, user] = await ethers.getSigners();

  const registryAddr =
    process.env.REGISTRY_ADDR ??
    process.env.REGISTRY ??
    (CONTRACT_ADDRESSES as any)?.Registry ??
    "";
  if (!registryAddr) {
    throw new Error(
      `[Config] Missing REGISTRY_ADDR. Provide env REGISTRY_ADDR=<registry> ` +
        `or ensure frontend-config/contracts-localhost.ts is up to date.`
    );
  }

  console.log("=== Funds Flow Smoke (localhost) ===\n");
  console.log("  Registry:", registryAddr);
  console.log("  Deployer:", deployer.address);
  console.log("  Keeper:", keeper.address);
  console.log("  User:", user.address);
  console.log("");

  await requireCode(registryAddr, "Registry");

  const registryAbi = [
    "function getModule(bytes32 key) external view returns (address)",
    "function getModuleOrRevert(bytes32 key) external view returns (address)",
  ];
  const registry = await ethers.getContractAt(registryAbi, registryAddr);

  const KEY_VAULT_CORE = key("VAULT_CORE");
  const KEY_SETTLEMENT_MANAGER = key("SETTLEMENT_MANAGER");
  const KEY_ACCESS_CONTROL = key("ACCESS_CONTROL");

  const vaultCoreAddr: string = await registry.getModule(KEY_VAULT_CORE);
  const settlementManagerAddr: string = await registry.getModule(KEY_SETTLEMENT_MANAGER);
  const accessControlAddr: string = await registry.getModule(KEY_ACCESS_CONTROL);

  console.log("  Registry.KEY_VAULT_CORE:", vaultCoreAddr);
  console.log("  Registry.KEY_SETTLEMENT_MANAGER:", settlementManagerAddr);
  console.log("  Registry.KEY_ACCESS_CONTROL:", accessControlAddr);
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
  if (accessControlAddr !== ethers.ZeroAddress) {
    await requireCode(accessControlAddr, "AccessControlManager");
  }

  const vaultCore = await ethers.getContractAt(
    ["function viewContractAddrVar() external view returns (address)"],
    vaultCoreAddr
  );
  const viewAddr: string = await vaultCore.viewContractAddrVar();
  console.log("  VaultCore.viewContractAddrVar():", viewAddr);
  if (viewAddr === ethers.ZeroAddress) {
    console.log("  ⚠️  [DeployCheck] viewContractAddrVar() is zero (VaultRouter/View not set).");
  }
  console.log("");

  // --- Keeper path smoke: SettlementManager.settleOrLiquidate(orderId) ---
  const orderId = parseEnvBigint("ORDER_ID", 1n);
  console.log(`--- Keeper path: settleOrLiquidate(orderId=${orderId}) ---`);

  const ACTION_LIQUIDATE = actionKey("LIQUIDATE");
  const acmAbi = [
    "function hasRole(bytes32 role, address caller) external view returns (bool)",
    "function owner() external view returns (address)",
  ];
  const settlementAbi = ["function settleOrLiquidate(uint256 orderId) external"];

  const settlementManager: any = await ethers.getContractAt(settlementAbi, settlementManagerAddr);

  if (accessControlAddr === ethers.ZeroAddress) {
    console.log("  ⚠️  [Config] Registry.KEY_ACCESS_CONTROL is zero; cannot pre-check ACTION_LIQUIDATE role.\n");
  } else {
    const acm: any = await ethers.getContractAt(acmAbi, accessControlAddr);
    const has = await acm.hasRole(ACTION_LIQUIDATE, keeper.address);
    console.log("  ACM:", shortAddr(accessControlAddr));
    console.log("  ACTION_LIQUIDATE:", ACTION_LIQUIDATE);
    console.log("  keeper hasRole(ACTION_LIQUIDATE):", has);
    if (!has) {
      console.log("");
      console.log("  ❗ MissingRole precheck:");
      console.log("     - This call requires ActionKeys.ACTION_LIQUIDATE (keccak256(\"LIQUIDATE\")).");
      console.log("     - Fix: have an admin grant role to the keeper:");
      console.log(`       AccessControlManager.grantRole(${ACTION_LIQUIDATE}, ${keeper.address})`);
      try {
        const owner = await acm.owner();
        console.log(`     - ACM owner (likely admin): ${owner}`);
      } catch {
        // ignore
      }
    }
    console.log("");
  }

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

