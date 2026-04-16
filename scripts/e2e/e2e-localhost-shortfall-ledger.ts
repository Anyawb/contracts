import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import { fundErc20Users } from "./utils/fork-token-funding.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

const ONE_HOUR_BLOCKS = 1_800n;
const SHORTFALL_COLLATERAL_PRICE_PPM = BigInt(process.env.E2E_SHORTFALL_COLLATERAL_PRICE_PPM ?? "200000");

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertOk(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    writeJson: (name: string, data: unknown) => {
      const filePath = path.join(outDir, name);
      const replacer = (_k: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
      fs.writeFileSync(filePath, `${JSON.stringify(data, replacer, 2)}\n`, "utf8");
      return filePath;
    },
  };
}

async function latestBlockNumber() {
  return BigInt(await ethers.provider.getBlockNumber());
}

async function mineToBlock(targetBlock: bigint) {
  const current = await latestBlockNumber();
  if (targetBlock <= current) return;
  const delta = targetBlock - current;
  try {
    await ethers.provider.send("hardhat_mine", [ethers.toBeHex(delta)]);
  } catch {
    for (let remaining = delta; remaining > 0n; remaining -= 1n) {
      await ethers.provider.send("evm_mine", []);
    }
  }
}

async function waitTx(txPromise: Promise<any>, label: string) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  assertOk(receipt, `${label}: missing receipt`);
  return receipt;
}

async function assertHasCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`[ShortfallE2E] no bytecode at ${label}: ${address}`);
  }
}

const coder = ethers.AbiCoder.defaultAbiCoder();
const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

function extractDataPushed(receipt: any, emitter: string): Array<{ dataTypeHash: string; payload: string }> {
  const normalizedEmitter = emitter.toLowerCase();
  const pushes: Array<{ dataTypeHash: string; payload: string }> = [];
  for (const log of receipt?.logs ?? []) {
    if (String(log.address ?? "").toLowerCase() !== normalizedEmitter) continue;
    const topics = (log.topics ?? []) as string[];
    if (!topics.length || String(topics[0]).toLowerCase() !== DATA_PUSH_TOPIC0) continue;
    try {
      if (topics.length >= 2) {
        const [payload] = coder.decode(["bytes"], log.data) as unknown as [string];
        pushes.push({ dataTypeHash: String(topics[1]), payload });
      } else {
        const [dataTypeHash, payload] = coder.decode(["bytes32", "bytes"], log.data) as unknown as [string, string];
        pushes.push({ dataTypeHash: String(dataTypeHash), payload: String(payload) });
      }
    } catch {
      // ignore malformed logs
    }
  }
  return pushes;
}

function buildLendIntentHash(lendIntent: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)",
    ),
  );
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        lendIntent.lenderSigner,
        lendIntent.asset,
        lendIntent.amount,
        lendIntent.minTermDays,
        lendIntent.maxTermDays,
        lendIntent.minRateBps,
        lendIntent.expireAt,
        lendIntent.salt,
      ],
    ),
  );
}

function extractOrderIdFromReceipt(receipt: any, orderEngine: any, orderEngineAddr: string): bigint | null {
  for (const log of receipt?.logs ?? []) {
    try {
      if (String(log.address ?? "").toLowerCase() !== orderEngineAddr.toLowerCase()) continue;
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        return BigInt(parsed.args.orderId);
      }
    } catch {
      // ignore unrelated logs
    }
  }
  return null;
}

function findParsedEvent(receipt: any, contract: any, eventName: string) {
  const emitter = String(contract.target ?? contract.address ?? "").toLowerCase();
  for (const log of receipt?.logs ?? []) {
    if (String(log.address ?? "").toLowerCase() !== emitter) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === eventName) {
        return parsed;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function ensureRole(acm: any, admin: any, roleName: string, account: string) {
  const role = key(roleName);
  if (!((await acm.hasRole(role, account)) as boolean)) {
    await waitTx(acm.connect(admin).grantRole(role, account), `grantRole ${roleName}`);
  }
}

export async function runLocalhostShortfallLedgerE2E() {
  const snapshot = await network.provider.send("evm_snapshot", []);
  const artifacts = mkArtifactsWriter();
  const out: Record<string, unknown> = {
    name: "localhost-shortfall-ledger",
    generatedAt: new Date().toISOString(),
    chainId: String((await ethers.provider.getNetwork()).chainId),
    shortfallCollateralPricePpm: SHORTFALL_COLLATERAL_PRICE_PPM.toString(),
    steps: [],
  };

  try {
    const addressMap = loadAddressMap("localhost");
    const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });
    await assertHasCode(registryAddr, "Registry");

    const [deployer, borrower, lender] = await ethers.getSigners();
    const registry = (await ethers.getContractAt(
      ["function getModuleOrRevert(bytes32) view returns (address)", "function getModule(bytes32) view returns (address)"],
      registryAddr,
    )) as any;

    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const assetWhitelistAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
    const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
    const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
    const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
    const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
    const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
    const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
    const liquidatorViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
    const ergmAddr = (await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
    const settlementTokenAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

    const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;
    const assetWhitelistAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", assetWhitelistAddr)) as any;
    const assetWhitelistRead = (await ethers.getContractAt("IAssetWhitelistRead", assetWhitelistAddr)) as any;
    const priceOracle = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddr)) as any;
    const feeRouter = (await ethers.getContractAt("FeeRouter", feeRouterAddr)) as any;
    const settlementManager = (await ethers.getContractAt(
      "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
      settlementManagerAddr,
    )) as any;
    const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
    const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
    const collateralManager = (await ethers.getContractAt("CollateralManager", cmAddr)) as any;
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
    const lendingEngine = (await ethers.getContractAt(
      "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
      lendingEngineAddr,
    )) as any;
    const liquidatorView = (await ethers.getContractAt("LiquidatorView", liquidatorViewAddr)) as any;
    const settlementToken = (await ethers.getContractAt("MockERC20", settlementTokenAddr)) as any;
    const ergm = ergmAddr && ergmAddr !== ethers.ZeroAddress
      ? ((await ethers.getContractAt("EarlyRepaymentGuaranteeManager", ergmAddr)) as any)
      : null;

    await runViewPreflight({
      registryAddr,
      acmAddr,
      adminSigner: deployer,
      assetForPriceCheck: settlementTokenAddr,
    });

    await ensureRole(acm, deployer, "ADD_WHITELIST", deployer.address);
    await ensureRole(acm, deployer, "SET_PARAMETER", deployer.address);
    await ensureRole(acm, deployer, "UPDATE_PRICE", deployer.address);
    await ensureRole(acm, deployer, "ORDER_CREATE", vblAddr);
    await ensureRole(acm, deployer, "DEPOSIT", vblAddr);
    await ensureRole(acm, deployer, "BORROW", orderEngineAddr);
    await ensureRole(acm, deployer, "REPAY", settlementManagerAddr);
    await ensureRole(acm, deployer, "LIQUIDATE", deployer.address);
    await ensureRole(acm, deployer, "VIEW_SYSTEM_DATA", deployer.address);
    await ensureRole(acm, deployer, "VIEW_PRICE_DATA", deployer.address);
    await ensureRole(acm, deployer, "VIEW_RISK_DATA", deployer.address);
    await ensureRole(acm, deployer, "ACTION_VIEW_PUSH", settlementManagerAddr);

    if (!(await assetWhitelistRead.isAssetAllowed(settlementTokenAddr))) {
      await waitTx(assetWhitelistAdmin.connect(deployer).addAllowedAsset(settlementTokenAddr), "allow settlement token");
    }
    if (!(await feeRouter.isTokenSupported(settlementTokenAddr))) {
      await waitTx(feeRouter.connect(deployer).addSupportedToken(settlementTokenAddr), "support settlement token");
    }

    const settlementDecimals = Number(await settlementToken.decimals());
    const settlementConfig = await priceOracle.getAssetConfig(settlementTokenAddr);
    if (!settlementConfig.isActive) {
      await waitTx(
        priceOracle.connect(deployer).configureAsset(settlementTokenAddr, "usd-coin", settlementDecimals, 3600),
        "configure settlement token",
      );
    }
    await waitTx(
      priceOracle.connect(deployer).updatePrice(
        settlementTokenAddr,
        ethers.parseUnits("1", settlementDecimals),
        await ethers.provider.getBlockNumber(),
      ),
      "price settlement token",
    );

    if (ergm) {
      try {
        await waitTx(ergm.connect(deployer).setGuaranteeEnabled(settlementTokenAddr, false), "disable guarantee on settlement");
      } catch {
        // best-effort only
      }
    }

    const tokenFactory = await ethers.getContractFactory("MockERC20");
    const collateralToken = await tokenFactory.connect(deployer).deploy(
      "MockTier1Collateral",
      "MT1C",
      6,
      ethers.parseUnits("1000000000", 6),
    );
    await collateralToken.waitForDeployment();
    const collateralTokenAddr = await collateralToken.getAddress();

    if (!(await assetWhitelistRead.isAssetAllowed(collateralTokenAddr))) {
      await waitTx(assetWhitelistAdmin.connect(deployer).addAllowedAsset(collateralTokenAddr), "allow collateral token");
    }
    if (!(await feeRouter.isTokenSupported(collateralTokenAddr))) {
      await waitTx(feeRouter.connect(deployer).addSupportedToken(collateralTokenAddr), "support collateral token");
    }
    await waitTx(
      priceOracle.connect(deployer).configureAsset(collateralTokenAddr, "mock-tier1-collateral", 6, 3600),
      "configure collateral token",
    );
    await waitTx(
      priceOracle.connect(deployer).updatePrice(
        collateralTokenAddr,
        ethers.parseUnits("1", 6),
        await ethers.provider.getBlockNumber(),
      ),
      "price collateral token bootstrap",
    );

    if (ergm) {
      try {
        await waitTx(ergm.connect(deployer).setGuaranteeEnabled(collateralTokenAddr, false), "disable guarantee on collateral");
      } catch {
        // best-effort only
      }
    }

    await fundErc20Users({
      token: settlementToken,
      deployer,
      recipients: [borrower.address, lender.address],
      amount: ethers.parseUnits("500000", settlementDecimals),
      label: "shortfall settlement funding",
    });
    await fundErc20Users({
      token: collateralToken,
      deployer,
      recipients: [borrower.address],
      amount: ethers.parseUnits("500000", 6),
      label: "shortfall collateral funding",
    });

    const principal = ethers.parseUnits("1000", settlementDecimals);
    const collateralAmount = ethers.parseUnits("3000", 6);
    const termDays = 5;
    const rateBps = 1000n;
    const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

    const domain = {
      name: "RwaLending",
      version: "1",
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      verifyingContract: vblAddr,
    } as const;

    const typesBorrow = {
      BorrowIntent: [
        { name: "borrower", type: "address" },
        { name: "collateralAsset", type: "address" },
        { name: "collateralAmount", type: "uint256" },
        { name: "borrowAsset", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "termDays", type: "uint16" },
        { name: "rateBps", type: "uint256" },
        { name: "expireAt", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
    };

    const typesLend = {
      LendIntent: [
        { name: "lenderSigner", type: "address" },
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "minTermDays", type: "uint16" },
        { name: "maxTermDays", type: "uint16" },
        { name: "minRateBps", type: "uint256" },
        { name: "expireAt", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
    };

    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: collateralTokenAddr,
      collateralAmount,
      borrowAsset: settlementTokenAddr,
      amount: principal,
      termDays,
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`shortfall-borrow-${Date.now()}`)),
    };
    const lendIntent = {
      lenderSigner: lender.address,
      asset: settlementTokenAddr,
      amount: principal,
      minTermDays: termDays,
      maxTermDays: termDays,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`shortfall-lend-${Date.now()}`)),
    };

    await waitTx(settlementToken.connect(lender).approve(vblAddr, principal), "approve reserve");
    await waitTx(
      vbl.connect(lender).reserveForLending(lender.address, settlementTokenAddr, principal, buildLendIntentHash(lendIntent)),
      "reserve for lending",
    );
    await waitTx(collateralToken.connect(borrower).approve(cmAddr, collateralAmount), "approve collateral");
    await waitTx(vaultCore.connect(borrower).deposit(collateralTokenAddr, collateralAmount), "deposit collateral");

    const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);
    const finalizeReceipt = await waitTx(
      vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]),
      "finalizeMatch",
    );

    const orderId = extractOrderIdFromReceipt(finalizeReceipt, orderEngine, orderEngineAddr);
    assertOk(orderId !== null, "LoanOrderCreated not found in finalize receipt");

    const orderBefore = await orderEngine.getLoanOrderForView(orderId);
    await mineToBlock(BigInt(orderBefore.maturity) + 1n);

    const crashedCollateralPrice = (ethers.parseUnits("1", 6) * SHORTFALL_COLLATERAL_PRICE_PPM) / 1_000_000n;
    assertOk(crashedCollateralPrice > 0n, "crashed collateral price must be positive");
    const nowBlock = await ethers.provider.getBlockNumber();
    await waitTx(
      priceOracle.connect(deployer).updatePrice(collateralTokenAddr, crashedCollateralPrice, nowBlock),
      "crash collateral price",
    );
    await waitTx(
      priceOracle.connect(deployer).updatePrice(settlementTokenAddr, ethers.parseUnits("1", settlementDecimals), nowBlock),
      "refresh settlement price",
    );

    const debtBefore = (await lendingEngine.getDebt(borrower.address, settlementTokenAddr)) as bigint;
    assertOk(debtBefore > 0n, "expected positive debt before shortfall liquidation");
    const collateralBefore = (await collateralManager.getCollateral(borrower.address, collateralTokenAddr)) as bigint;
    assertOk(collateralBefore >= collateralAmount, "expected collateral to remain locked before liquidation");

    const liquidationReceipt = await waitTx(
      settlementManager.connect(deployer).settleOrLiquidate(orderId),
      "settleOrLiquidate shortfall",
    );
    const liquidationPushes = extractDataPushed(liquidationReceipt, liquidatorViewAddr);
    const shortfallOpened = findParsedEvent(liquidationReceipt, settlementManager, "LiquidationShortfallOpened");
    assertOk(shortfallOpened, "missing LiquidationShortfallOpened event on liquidation receipt");

    const ledgerAfterLiquidation = await settlementManager.getShortfallLedger(orderId);
    const hasActiveShortfall = (await settlementManager.hasActiveShortfall(orderId)) as boolean;
    const orderStatus = (await orderEngine.getOrderStatusForView(orderId)) as bigint;
    const debtAfterLiquidation = (await lendingEngine.getDebt(borrower.address, settlementTokenAddr)) as bigint;

    assertOk(ledgerAfterLiquidation.status === 1n, `unexpected shortfall status after liquidation: ${ledgerAfterLiquidation.status.toString()}`);
    assertOk(ledgerAfterLiquidation.pricingMode === 0n, `unexpected pricingMode after liquidation: ${ledgerAfterLiquidation.pricingMode.toString()}`);
    assertOk(ledgerAfterLiquidation.coveredDebt > 0n, "coveredDebt should stay positive after partial liquidation");
    assertOk(ledgerAfterLiquidation.remainingDebt > 0n, "remainingDebt should remain positive after shortfall liquidation");
    assertOk(ledgerAfterLiquidation.shortfallAmount === ledgerAfterLiquidation.remainingDebt, "shortfallAmount must equal remainingDebt on open shortfall");
    assertOk(ledgerAfterLiquidation.coveredDebt + ledgerAfterLiquidation.remainingDebt === debtBefore, "coveredDebt + remainingDebt must equal debt before liquidation");
    assertOk(hasActiveShortfall, "shortfall should be active immediately after liquidation");
    assertOk(orderStatus === 5n, `expected DefaultedWithShortfall (5), got ${orderStatus.toString()}`);
    assertOk(debtAfterLiquidation === ledgerAfterLiquidation.remainingDebt, "debt ledger should equal shortfall remainingDebt after liquidation");
    assertOk(
      liquidationPushes.some((push) => {
        const typeHash = push.dataTypeHash.toLowerCase();
        return typeHash === key("LIQUIDATION_UPDATE").toLowerCase() || typeHash === key("LIQUIDATION_PAYOUT").toLowerCase();
      }),
      "missing LIQUIDATION_* DataPushed on shortfall liquidation",
    );

    assertOk(
      ((await acm.hasRole(key("SET_PARAMETER"), deployer.address)) as boolean),
      "deployer must hold SET_PARAMETER for admin-driven shortfall recovery/write-off",
    );

    const recoveryAmount = ledgerAfterLiquidation.remainingDebt > 1n
      ? ledgerAfterLiquidation.remainingDebt / 2n
      : ledgerAfterLiquidation.remainingDebt;
    const recoveryReceipt = await waitTx(
      settlementManager.connect(deployer).applyShortfallRecovery(
        orderId,
        4,
        recoveryAmount,
        ethers.keccak256(ethers.toUtf8Bytes("localhost-shortfall-admin-recovery")),
      ),
      "applyShortfallRecovery (admin ledger recovery)",
    );
    const recoveryEvent = findParsedEvent(recoveryReceipt, settlementManager, "LiquidationShortfallRecoveryApplied");
    assertOk(recoveryEvent, "missing LiquidationShortfallRecoveryApplied event");

    const ledgerAfterRecovery = await settlementManager.getShortfallLedger(orderId);
    assertOk(ledgerAfterRecovery.status === 2n || ledgerAfterRecovery.status === 5n, `unexpected status after admin recovery: ${ledgerAfterRecovery.status.toString()}`);
    assertOk(ledgerAfterRecovery.recoveredAmount === recoveryAmount, "recoveredAmount should match admin-applied recovery amount");
    assertOk(ledgerAfterRecovery.remainingDebt === ledgerAfterLiquidation.remainingDebt - recoveryAmount, "remainingDebt should decrease by admin-applied recovery amount");
    assertOk(ledgerAfterRecovery.shortfallAmount === ledgerAfterLiquidation.shortfallAmount - recoveryAmount, "shortfallAmount should decrease by admin-applied recovery amount");

    const writeOffReceipt = await waitTx(
      settlementManager.connect(deployer).setShortfallStatus(
        orderId,
        6,
        ethers.keccak256(ethers.toUtf8Bytes("localhost-shortfall-admin-writeoff")),
      ),
      "setShortfallStatus WRITTEN_OFF (admin ledger write-off)",
    );
    const statusChanged = findParsedEvent(writeOffReceipt, settlementManager, "LiquidationShortfallStatusChanged");
    assertOk(statusChanged, "missing LiquidationShortfallStatusChanged on write-off");

    const ledgerAfterWriteOff = await settlementManager.getShortfallLedger(orderId);
    const debtAfterWriteOff = (await lendingEngine.getDebt(borrower.address, settlementTokenAddr)) as bigint;
    assertOk(ledgerAfterWriteOff.status === 6n, `expected WRITTEN_OFF status (6), got ${ledgerAfterWriteOff.status.toString()}`);
    assertOk(ledgerAfterWriteOff.remainingDebt === 0n, "remainingDebt should be zero after write-off");
    assertOk(ledgerAfterWriteOff.shortfallAmount === 0n, "shortfallAmount should be zero after write-off");
    assertOk(ledgerAfterWriteOff.recoverySource === 5n, `expected GOVERNANCE_WRITE_OFF source (5), got ${ledgerAfterWriteOff.recoverySource.toString()}`);
    assertOk(!(await settlementManager.hasActiveShortfall(orderId)), "written-off shortfall must not remain active");
    assertOk(debtAfterWriteOff === 0n, "debt ledger should be fully cleared after write-off");

    out.steps = [
      {
        step: "create-shortfall-order",
        orderId: orderId.toString(),
        principal: principal.toString(),
        collateralAmount: collateralAmount.toString(),
      },
      {
        step: "liquidation-opens-shortfall",
        debtBefore: debtBefore.toString(),
        coveredDebt: ledgerAfterLiquidation.coveredDebt.toString(),
        remainingDebt: ledgerAfterLiquidation.remainingDebt.toString(),
        status: orderStatus.toString(),
        pricingMode: ledgerAfterLiquidation.pricingMode.toString(),
        liquidationPushTypes: liquidationPushes.map((push) => push.dataTypeHash.toLowerCase()),
      },
      {
        step: "admin-applies-shortfall-recovery",
        entrypoint: "SettlementManager.applyShortfallRecovery",
        recoverySource: "MANUAL_SETTLEMENT",
        requiredRole: "SET_PARAMETER",
        recoveryAmount: recoveryAmount.toString(),
        remainingDebt: ledgerAfterRecovery.remainingDebt.toString(),
        status: ledgerAfterRecovery.status.toString(),
      },
      {
        step: "admin-writes-off-shortfall",
        entrypoint: "SettlementManager.setShortfallStatus",
        requiredRole: "SET_PARAMETER",
        remainingDebt: ledgerAfterWriteOff.remainingDebt.toString(),
        shortfallAmount: ledgerAfterWriteOff.shortfallAmount.toString(),
        recoverySource: ledgerAfterWriteOff.recoverySource.toString(),
        debtAfterWriteOff: debtAfterWriteOff.toString(),
      },
    ];

    const artifactPath = artifacts.writeJson(`shortfall-ledger.${Date.now()}.json`, out);
    console.log(`[E2E] shortfall ledger artifact: ${artifactPath}`);
  } catch (error) {
    const artifactPath = artifacts.writeJson(`shortfall-ledger.FAIL.${Date.now()}.json`, {
      ...out,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`[E2E] shortfall ledger failed; artifact: ${artifactPath}`);
    throw error;
  } finally {
    await network.provider.send("evm_revert", [snapshot]);
  }
}

async function main() {
  await runLocalhostShortfallLedgerE2E();
}

main().catch((error) => {
  console.error("\n❌ e2e-localhost-shortfall-ledger FAILED\n");
  console.error(error);
  process.exit(1);
});