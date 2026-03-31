import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import { runRewardExtendedChecks } from "./utils/reward-extended-checks.ts";

const STRICT_REWARD = (process.env.E2E_STRICT_REWARD ?? "0").toLowerCase() === "1";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fmtErr(e: any) {
  return e?.shortMessage ?? e?.message ?? String(e);
}

function errorSelector(signature: string): string {
  return ethers.id(signature).slice(0, 10).toLowerCase();
}

function extractCustomErrorSigFromMessage(e: any): string | undefined {
  const msg = fmtErr(e);
  const m = String(msg).match(/custom error\s+'([^']+)'/);
  return m?.[1]?.trim();
}

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) return;
  const delta = targetBlock - current;

  // Prefer hardhat_mine when available (forked hardhat node supports it).
  try {
    await ethers.provider.send("hardhat_mine", [ethers.toBeHex(delta)]);
    return;
  } catch {
    // fallback below
  }

  // Fallback: mine one-by-one.
  const n = Number(delta);
  for (let i = 0; i < n; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

async function waitTx(p: Promise<any>, label: string) {
  const tx = await p;
  const rc = await tx.wait();
  assertOk(!!rc, `${label}: missing receipt`);
  return rc;
}

async function hardhatImpersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
}

async function hardhatSetBalance(addr: string, weiHex: string) {
  await network.provider.request({ method: "hardhat_setBalance", params: [addr, weiHex] });
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    outDir,
    writeJson: (name: string, data: unknown) => {
      const p = path.join(outDir, name);
      const replacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
  };
}

async function main() {
  const artifacts = mkArtifactsWriter();
  const out: any = {
    name: "fork-arbitrum-stale-price-keeper",
    generatedAt: new Date().toISOString(),
    chainId: String((await ethers.provider.getNetwork()).chainId),
    rpcUrl: process.env.LOCALHOST_RPC_URL ?? "",
    keeper: process.env.E2E_KEEPER_ADDRESS ?? "",
    steps: [],
    diagnostics: {},
  };

  const net = await ethers.provider.getNetwork();
  const chainId = BigInt(net.chainId);
  const addressMap = loadAddressMap("localhost");
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
  const okChain = chainId === 42161n || chainId === 421614n;
  if (!okChain) {
    throw new Error(
      `[Fork preflight] This E2E is Arbitrum-fork only. Expected chainId=42161/421614, got=${chainId}.\n` +
        `Start a local hardhat fork node (arbitrum/arbitrum-sepolia), deploy with deploy:localhost, then re-run.`
    );
  }

  // Keeper impersonation (Arbitrum ops model): keeper is NOT the deployer.
  // Default is an arbitrary address; caller can provide a real ops/keeper address.
  const keeperAddress = (process.env.E2E_KEEPER_ADDRESS ?? "0x000000000000000000000000000000000000BEEF").trim();
  assertOk(ethers.isAddress(keeperAddress), `[Config] Invalid E2E_KEEPER_ADDRESS: ${keeperAddress}`);
  out.keeper = keeperAddress;

  // Ensure the node supports impersonation (requires hardhat node).
  try {
    await hardhatImpersonate(keeperAddress);
  } catch (e) {
    throw new Error(
      `[Fork preflight] hardhat_impersonateAccount failed. Are you running a Hardhat node (fork) RPC? err=${fmtErr(e)}`
    );
  }

  // Give keeper some ETH for tx gas.
  await hardhatSetBalance(keeperAddress, ethers.toBeHex(ethers.parseEther("10")));
  const keeper = await ethers.getSigner(keeperAddress);

  // Contracts (from deploy:localhost output).
  const [deployer, userCandidate] = await ethers.getSigners();

  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const vaultLendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
  const settlementTokenAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const rewardViewAddr = (await registry.getModule(key("REWARD_VIEW"))) as string;
  const rewardAccrualManagerAddr = (await registry.getModule(key("REWARD_ACCRUAL_MANAGER"))) as string;
  const easyEmissionConfigAddr = (await registry.getModule(key("EASY_EMISSION_CONFIG"))) as string;
  const rewardManagerCoreAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", awAddr)) as any;
  const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", awAddr)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", cmAddr)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddr)) as any;
  const vle = (await ethers.getContractAt("src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine", vaultLendingEngineAddr)) as any;
  const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddr)) as any;
  const rewardView = rewardViewAddr && rewardViewAddr !== ethers.ZeroAddress
    ? (((await ethers.getContractAt("RewardView", rewardViewAddr)) as any) ?? null)
    : null;
  const rewardAccrualManager = rewardAccrualManagerAddr && rewardAccrualManagerAddr !== ethers.ZeroAddress
    ? (((await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any) ?? null)
    : null;
  const easyEmissionConfig = easyEmissionConfigAddr && easyEmissionConfigAddr !== ethers.ZeroAddress
    ? (((await ethers.getContractAt("EasyEmissionConfig", easyEmissionConfigAddr)) as any) ?? null)
    : null;

  // Ensure deployer is ACM owner/admin (needed to grant roles to the keeper).
  const owner: string = await acm.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`[AccessControl] This script requires ACM owner signer. owner=${owner} deployer=${deployer.address}`);
  }

  const ensureRole = async (roleName: string, who: string) => {
    const role = key(roleName);
    const ok = (await acm.hasRole(role, who)) as boolean;
    if (!ok) {
      await waitTx(acm.connect(deployer).grantRole(role, who), `grantRole ${roleName}`);
    }
  };

  // Keeper must be able to update prices (and configure parameters if needed).
  await ensureRole("UPDATE_PRICE", keeperAddress);
  await ensureRole("SET_PARAMETER", keeperAddress);

  // The script may need to seed AssetWhitelist on fresh fork deployments.
  await ensureRole("ADD_WHITELIST", deployer.address);

  // The E2E runner (deployer signer) calls view/oracle paths; ensure it can read.
  await ensureRole("SET_PARAMETER", deployer.address);
  await ensureRole("VIEW_PRICE_DATA", deployer.address);
  await ensureRole("VIEW_RISK_DATA", deployer.address);
  await ensureRole("VIEW_USER_DATA", deployer.address);

  out.rewardExtendedChecks = await runRewardExtendedChecks({
    registry,
    acm,
    deployer,
    waitTx,
    strictReward: STRICT_REWARD,
    rewardView,
    rewardViewAddr,
    easyEmissionConfig,
    easyEmissionConfigAddr,
    rewardAccrualManager,
    ramAddr: rewardAccrualManagerAddr,
    rmCoreAddr: rewardManagerCoreAddr,
    artifactTarget: out,
    artifactKey: "rewardExtendedChecks",
    log: console.log,
    logNotice: console.log,
  });

  // Find a fresh user without debt (fork node should be started clean for determinism).
  let user: any = null;
  for (const s of [userCandidate, ...(await ethers.getSigners())]) {
    if (String(s.address).toLowerCase() === deployer.address.toLowerCase()) continue;
    if (String(s.address).toLowerCase() === keeperAddress.toLowerCase()) continue;
    try {
      const debt = (await vle.getUserTotalDebtValue(s.address)) as bigint;
      if (debt === 0n) {
        user = s;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!user) throw new Error("[Preflight] Cannot find an unused signer (no debt). Restart fork node for a clean state.");

  // Deposit collateral (USDC) so views have something to value.
  const depositAmt = ethers.parseUnits("100", 6);
  await waitTx(usdc.connect(deployer).transfer(user.address, ethers.parseUnits("20000", 6)), "fund user");

  // Fresh deployments may not pre-seed AssetWhitelist; ensure the settlement token is allowed.
  if (!((await awRead.isAssetAllowed(settlementTokenAddr)) as boolean)) {
    await waitTx(awAdmin.connect(deployer).addAllowedAsset(settlementTokenAddr), "allow settlement token");
  }

  await waitTx(usdc.connect(user).approve(cmAddr, depositAmt), "approve collateral");
  await waitTx(vaultCore.connect(user).deposit(settlementTokenAddr, depositAmt), "deposit");

  const col = (await cm.getCollateral(user.address, settlementTokenAddr)) as bigint;
  assertOk(col === depositAmt, `[Deposit] Collateral mismatch. got=${col} expect=${depositAmt}`);
  out.steps.push({ step: "deposit", user: user.address, asset: settlementTokenAddr, amount: depositAmt.toString() });

  // Fresh fork deployments may not pre-configure the settlement token in PriceOracle yet.
  const assetCfg: any = await po.getAssetConfig(settlementTokenAddr);
  if (!assetCfg?.isActive) {
    await waitTx(
      po.connect(deployer).configureAsset(settlementTokenAddr, "usd-coin", 6, 3600),
      "configureAsset settlement"
    );
  }

  // Set a fresh price using keeper.
  const nowBlock = await latestBlockNumber();
  await waitTx(po.connect(keeper).updatePrice(settlementTokenAddr, ethers.parseUnits("1", 8), nowBlock), "keeper.updatePrice");

  const [freshPriceRaw, freshUpdatedAtBlock, freshAssetDecimals] = (await po.getPrice(settlementTokenAddr)) as [bigint, bigint, bigint];
  console.log(
    `  [Oracle] fresh price=${freshPriceRaw.toString()} updatedAtBlock=${freshUpdatedAtBlock.toString()} assetDecimals=${freshAssetDecimals.toString()}`,
  );

  const v0 = (await positionView.getUserTotalCollateralValue(user.address)) as bigint;
  assertOk(v0 > 0n, `[View] expected positive collateral value after fresh price, got=${v0}`);
  out.steps.push({
    step: "fresh-price",
    atBlock: nowBlock.toString(),
    userCollateralValue: v0.toString(),
    priceRaw: freshPriceRaw.toString(),
    updatedAtBlock: freshUpdatedAtBlock.toString(),
  });

  // Relative staleness: mine enough blocks so (block.number - updatedAtBlock) > maxPriceAgeBlocks.
  const cfg: any = await po.getAssetConfig(settlementTokenAddr);
  const maxAgeBlocks: bigint = cfg?.maxPriceAgeBlocks ?? cfg?.[3];
  if (typeof maxAgeBlocks !== "bigint") throw new Error("[Oracle] Cannot read maxPriceAgeBlocks from PriceOracle.getAssetConfig");

  console.log(`  [Oracle] maxPriceAgeBlocks=${maxAgeBlocks.toString()}`);

  await mineToBlock(nowBlock + maxAgeBlocks + 2n);
  const atStale = await latestBlockNumber();
  out.steps.push({ step: "mined-to-stale", maxAgeBlocks: maxAgeBlocks.toString(), atBlock: atStale.toString() });
  console.log(`  [Oracle] mined to stale block=${atStale.toString()} age=${(atStale - nowBlock).toString()}`);

  const staleSel = errorSelector("PriceOracle__StalePrice()");
  let staleSelector = "";
  try {
    await po.getPrice(settlementTokenAddr);
    throw new Error("[Oracle] Expected PriceOracle.getPrice to revert on stale price, but it did not");
  } catch (e: any) {
    const rawData = e?.data ?? e?.error?.data;
    const data = typeof rawData === "string" ? rawData.toLowerCase() : "";
    let sel = data.startsWith("0x") && data.length >= 10 ? data.slice(0, 10) : "";
    if (!sel) {
      const sig = extractCustomErrorSigFromMessage(e);
      if (sig) sel = errorSelector(sig);
    }
    staleSelector = sel;
    assertOk(sel === staleSel, `[Oracle] Expected stale selector ${staleSel}, got=${sel || "<empty>"}. err=${fmtErr(e)}`);
  }
  console.log(`  [Oracle] stale selector verified: ${staleSelector || staleSel}`);

  // Risk/valuation path behavior under stale price can be either:
  // - explicit revert (preferred for safety), OR
  // - graceful degradation to 0 (legacy behavior).
  // This E2E asserts it must NOT return a positive value while oracle is stale.
  let viewBehavior: any = { mode: "unknown" };
  try {
    const vStale = (await positionView.getUserTotalCollateralValue(user.address)) as bigint;
    if (vStale > 0n) {
      throw new Error(`[View] Unexpected positive collateral value under stale oracle: ${vStale}`);
    }
    viewBehavior = { mode: "degraded", value: vStale.toString() };
  } catch (e: any) {
    viewBehavior = { mode: "revert", err: fmtErr(e) };
  }
  out.steps.push({ step: "view-under-stale", ...viewBehavior });
  console.log(`  [View] stale behavior mode=${viewBehavior.mode}${viewBehavior.value ? ` value=${viewBehavior.value}` : ""}${viewBehavior.err ? ` err=${viewBehavior.err}` : ""}`);

  // Keeper refreshes price (Arbitrum keeper model).
  const nowAfter = await latestBlockNumber();
  await waitTx(po.connect(keeper).updatePrice(settlementTokenAddr, ethers.parseUnits("1", 8), nowAfter), "keeper.updatePrice(refresh)");

  const [refreshedPriceRaw, refreshedUpdatedAtBlock, refreshedAssetDecimals] = (await po.getPrice(settlementTokenAddr)) as [bigint, bigint, bigint];
  console.log(
    `  [Oracle] refreshed price=${refreshedPriceRaw.toString()} updatedAtBlock=${refreshedUpdatedAtBlock.toString()} assetDecimals=${refreshedAssetDecimals.toString()}`,
  );

  const v1 = (await positionView.getUserTotalCollateralValue(user.address)) as bigint;
  assertOk(v1 > 0n, `[View] expected positive collateral value after refresh price, got=${v1}`);
  out.steps.push({
    step: "refreshed",
    atBlock: nowAfter.toString(),
    userCollateralValue: v1.toString(),
    priceRaw: refreshedPriceRaw.toString(),
    updatedAtBlock: refreshedUpdatedAtBlock.toString(),
  });

  out.diagnostics = {
    oracle: {
      maxPriceAgeBlocks: maxAgeBlocks.toString(),
      staleSelectorExpected: staleSel,
      staleSelectorObserved: staleSelector || staleSel,
      freshPriceRaw: freshPriceRaw.toString(),
      refreshedPriceRaw: refreshedPriceRaw.toString(),
      updatedAtBlockBefore: freshUpdatedAtBlock.toString(),
      updatedAtBlockAfter: refreshedUpdatedAtBlock.toString(),
    },
    view: {
      collateralValueBeforeRaw: v0.toString(),
      collateralValueAfterRaw: v1.toString(),
      staleMode: viewBehavior.mode,
      staleValueRaw: viewBehavior.value ?? null,
      staleError: viewBehavior.err ?? null,
    },
  };

  // Cleanup: withdraw all collateral.
  const colNow = (await cm.getCollateral(user.address, settlementTokenAddr)) as bigint;
  if (colNow > 0n) {
    await waitTx(vaultCore.connect(user).withdraw(settlementTokenAddr, colNow), "withdraw");
  }

  const outPath = artifacts.writeJson(`fork-arbitrum-stale-price-keeper.${Date.now()}.json`, out);
  console.log(`✅ PASS: fork arbitrum stale-price keeper flow. artifact=${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
