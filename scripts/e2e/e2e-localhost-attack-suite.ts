import { ethers, network } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

type AnyFn = () => Promise<unknown>;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function fmtErr(e: any) {
  const msg = e?.shortMessage ?? e?.message ?? String(e);
  return msg;
}

async function mustRevert(label: string, fn: AnyFn) {
  try {
    await fn();
    throw new Error(`[FAIL] Expected revert, but succeeded: ${label}`);
  } catch (e: any) {
    const msg = fmtErr(e);
    // If we threw the sentinel error above, rethrow.
    if (msg.includes("Expected revert, but succeeded")) throw e;
    console.log(`  ✅ [revert as expected] ${label}`);
  }
}

async function mustSucceed(label: string, fn: AnyFn) {
  try {
    await fn();
    console.log(`  ✅ [ok] ${label}`);
  } catch (e: any) {
    throw new Error(`[FAIL] ${label}: ${fmtErr(e)}`);
  }
}

async function snapshot(): Promise<string> {
  return await network.provider.send("evm_snapshot", []);
}

async function revertTo(id: string) {
  await network.provider.send("evm_revert", [id]);
}

function buildTypedDataDomain(chainId: number, verifyingContract: string) {
  return {
    name: "RwaLending",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

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
} as const;

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
} as const;

async function tryUpgradeToAsAttacker(proxyAddr: string, attackerAddr: string, attackerSigner: any) {
  // UUPS proxies expose upgradeTo/upgradeToAndCall via implementation ABI.
  // If the target is not UUPS (or not a proxy), this may fail with "function selector" errors.
  const uups = await ethers.getContractAt(
    [
      "function upgradeTo(address newImplementation) external",
      "function upgradeToAndCall(address newImplementation, bytes data) external payable",
    ],
    proxyAddr,
    attackerSigner
  );

  await mustRevert(`UUPS upgrade attempt on ${proxyAddr}`, async () => {
    await (await uups.upgradeTo(attackerAddr)).wait();
  });
}

async function main() {
  console.log("=== Attack E2E Suite (localhost) ===\n");

  const signers = await ethers.getSigners();
  if (signers.length < 3) throw new Error(`Need at least 3 signers (have ${signers.length})`);

  const deployer = signers[0];
  const attacker = signers[1];
  const victim = signers[2];

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Attacker: ${attacker.address}`);
  console.log(`Victim:   ${victim.address}\n`);

  // Core contracts from deployment output
  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry, deployer)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager, deployer)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC, deployer)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore, deployer)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic, deployer)) as any;
  const priceOracle = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle, deployer)) as any;
  const collateralManager = (await ethers.getContractAt(
    "CollateralManager",
    CONTRACT_ADDRESSES.CollateralManager,
    deployer
  )) as any;
  const assetWhitelist = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist, deployer)) as any;
  const dynKeyRegistryAddr = CONTRACT_ADDRESSES.RegistryDynamicModuleKey;
  const dynKeyRegistry = dynKeyRegistryAddr
    ? ((await ethers.getContractAt("RegistryDynamicModuleKey", dynKeyRegistryAddr, deployer)) as any)
    : undefined;
  const priceUpdater = CONTRACT_ADDRESSES.CoinGeckoPriceUpdater
    ? ((await ethers.getContractAt(
        "src/core/CoinGeckoPriceUpdater.sol:CoinGeckoPriceUpdater",
        CONTRACT_ADDRESSES.CoinGeckoPriceUpdater,
        deployer
      )) as any)
    : undefined;

  const liquidationManagerAddr = await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"));
  const liquidationManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/LiquidationManager.sol:LiquidationManager",
    liquidationManagerAddr,
    deployer
  )) as any;

  console.log("== Section 1: Registry owner-only admin calls ==");
  {
    const regAsAttacker = registry.connect(attacker);
    await mustRevert("attacker: Registry.setModule()", async () => {
      await (await regAsAttacker.setModule(key("FEE_ROUTER"), attacker.address)).wait();
    });
    await mustRevert("attacker: Registry.setRegistryCore()", async () => {
      await (await regAsAttacker.setRegistryCore(attacker.address)).wait();
    });
    await mustRevert("attacker: Registry.setUpgradeManager()", async () => {
      await (await regAsAttacker.setUpgradeManager(attacker.address)).wait();
    });
    await mustRevert("attacker: Registry.setRegistryAdmin()", async () => {
      await (await regAsAttacker.setRegistryAdmin(attacker.address)).wait();
    });
  }
  console.log("");

  console.log("== Section 2: AccessControl privilege escalation attempts ==");
  {
    const roleAdmin = ethers.keccak256(ethers.toUtf8Bytes("ACTION_ADMIN"));
    const acmAsAttacker = acm.connect(attacker);
    await mustRevert("attacker: ACM.grantRole(ACTION_ADMIN, attacker)", async () => {
      await (await acmAsAttacker.grantRole(roleAdmin, attacker.address)).wait();
    });
  }
  console.log("");

  console.log("== Section 3: VaultCore / VBL restricted entrypoints ==");
  {
    const vaultCoreAsAttacker = vaultCore.connect(attacker);

    await mustRevert("attacker: VaultCore.borrowFor(victim,...)", async () => {
      await (await vaultCoreAsAttacker.borrowFor(victim.address, await usdc.getAddress(), 1n, 5)).wait();
    });
    await mustRevert("attacker: VaultCore.repayFor(victim,...)", async () => {
      await (await vaultCoreAsAttacker.repayFor(victim.address, await usdc.getAddress(), 1n)).wait();
    });

    // NOTE: attacker might already have collateral from prior E2E runs. So we assert the stronger property:
    // cannot withdraw MORE than current collateral.
    const asset = await usdc.getAddress();
    const curCol: bigint = await collateralManager.getCollateral(attacker.address, asset);
    await mustRevert(`attacker: VaultCore.withdraw(USDC, curCollateral+1) (cur=${curCol})`, async () => {
      await (await vaultCoreAsAttacker.withdraw(asset, curCol + 1n)).wait();
    });
    // And if attacker has zero collateral, withdrawing 1 should revert too.
    if (curCol === 0n) {
      await mustRevert("attacker: VaultCore.withdraw(USDC, 1) when collateral=0", async () => {
        await (await vaultCoreAsAttacker.withdraw(asset, 1n)).wait();
      });
    }

    const vblAsAttacker = vbl.connect(attacker);
    await mustRevert("attacker: VBL.liquidate(...) (requires ACTION_LIQUIDATE)", async () => {
      await (await vblAsAttacker.liquidate(victim.address, await usdc.getAddress(), await usdc.getAddress(), 1n, 1n, 0n)).wait();
    });
  }
  console.log("");

  console.log("== Section 4: Oracle manipulation attempts ==");
  {
    const poAsAttacker = priceOracle.connect(attacker);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await mustRevert("attacker: PriceOracle.updatePrice(USDC,...)", async () => {
      await (await poAsAttacker.updatePrice(await usdc.getAddress(), 1n, now)).wait();
    });
    await mustRevert("attacker: PriceOracle.configureAsset(USDC,...)", async () => {
      await (await poAsAttacker.configureAsset(await usdc.getAddress(), "x", 8, 60n)).wait();
    });
    await mustRevert("attacker: PriceOracle.setAssetActive(...)", async () => {
      await (await poAsAttacker.setAssetActive(await usdc.getAddress(), true)).wait();
    });
  }
  console.log("");

  console.log("== Section 5: LiquidationManager admin calls ==");
  {
    const lmAsAttacker = liquidationManager.connect(attacker);
    await mustRevert("attacker: LiquidationManager.pause()", async () => {
      await (await lmAsAttacker.pause()).wait();
    });
    await mustRevert("attacker: LiquidationManager.unpause()", async () => {
      await (await lmAsAttacker.unpause()).wait();
    });
  }
  console.log("");

  console.log("== Section 6: UUPS upgrade attack attempts (broad scan) ==");
  {
    // Try to call upgradeTo on a set of commonly-proxied modules. If a target is not UUPS,
    // the attempt will still revert; this section is mainly to ensure "no silent upgrade success".
    const candidates: Array<[string, string | undefined]> = [
      ["Registry", CONTRACT_ADDRESSES.Registry],
      ["RegistryCore", CONTRACT_ADDRESSES.RegistryCore],
      ["RegistryUpgradeManager", CONTRACT_ADDRESSES.RegistryUpgradeManager],
      ["RegistryAdmin", CONTRACT_ADDRESSES.RegistryAdmin],
      ["AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager],
      ["AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist],
      ["AuthorityWhitelist", CONTRACT_ADDRESSES.AuthorityWhitelist],
      ["PriceOracle", CONTRACT_ADDRESSES.PriceOracle],
      ["FeeRouter", CONTRACT_ADDRESSES.FeeRouter],
      ["VaultStorage", CONTRACT_ADDRESSES.VaultStorage],
      ["VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic],
      ["VaultCore", CONTRACT_ADDRESSES.VaultCore],
      ["CollateralManager", CONTRACT_ADDRESSES.CollateralManager],
      ["LendingEngine", CONTRACT_ADDRESSES.LendingEngine],
      ["VaultLendingEngine", CONTRACT_ADDRESSES.VaultLendingEngine],
      ["LiquidationRiskManager", CONTRACT_ADDRESSES.LiquidationRiskManager],
      ["LiquidationManager", liquidationManagerAddr],
      ["SystemView", CONTRACT_ADDRESSES.SystemView],
      ["PositionView", CONTRACT_ADDRESSES.PositionView],
      ["StatisticsView", CONTRACT_ADDRESSES.StatisticsView],
      ["HealthView", CONTRACT_ADDRESSES.HealthView],
      ["RewardPoints", CONTRACT_ADDRESSES.RewardPoints],
      ["RewardManagerCore", CONTRACT_ADDRESSES.RewardManagerCore],
      ["RewardCore", CONTRACT_ADDRESSES.RewardCore],
      ["RewardManager", CONTRACT_ADDRESSES.RewardManager],
      ["RewardConfig", CONTRACT_ADDRESSES.RewardConfig],
      ["RewardView", CONTRACT_ADDRESSES.RewardView],
    ];

    for (const [name, addr] of candidates) {
      if (!addr) continue;
      console.log(`  - ${name}`);
      await tryUpgradeToAsAttacker(addr, attacker.address, attacker);
    }
  }
  console.log("");

  console.log("== Section 7: Defense-in-depth: reentrancy attempt via malicious view callback (VBL path) ==");
  {
    const snap = await snapshot();
    try {
      // Grant liquidate role to deployer (local test only; snapshotted).
      // ActionKeys.ACTION_LIQUIDATE == keccak256("LIQUIDATE")
      const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));
      await mustSucceed("deployer: grant LIQUIDATE to deployer (for test)", async () => {
        if (!(await acm.hasRole(ACTION_LIQUIDATE, deployer.address))) {
          await (await acm.grantRole(ACTION_LIQUIDATE, deployer.address)).wait();
        }
      });

      // Deploy controlled mocks.
      const mockCM = await (await ethers.getContractFactory("MockCollateralManager", deployer)).deploy();
      await mockCM.waitForDeployment();
      const mockLE = await (await ethers.getContractFactory("MockLendingEngineBasic", deployer)).deploy();
      await mockLE.waitForDeployment();
      const reentrantView = await (await ethers.getContractFactory("MockEventsViewReentrant", deployer)).deploy(await vbl.getAddress());
      await reentrantView.waitForDeployment();

      // Configure mock state so VBL.liquidate passes CM/LE checks.
      const collateralAsset = await usdc.getAddress();
      const debtAsset = await usdc.getAddress();
      const cAmt = 100n;
      const dAmt = 50n;
      await (await mockCM.depositCollateral(victim.address, collateralAsset, cAmt)).wait();
      await (await mockLE.setUserDebt(victim.address, debtAsset, dAmt)).wait();
      // MockLendingEngineBasic.forceReduceDebt() also updates total debt; set it to avoid underflow.
      await (await mockLE.setTotalDebtByAsset(debtAsset, dAmt)).wait();
      await (await reentrantView.setReentryParams(victim.address, collateralAsset, debtAsset, cAmt, dAmt)).wait();

      // Swap modules used by VBL.liquidate to our mocks.
      await mustSucceed("deployer: Registry.setModule(KEY_CM -> MockCollateralManager)", async () => {
        await (await registry.setModule(key("COLLATERAL_MANAGER"), await mockCM.getAddress())).wait();
      });
      await mustSucceed("deployer: Registry.setModule(KEY_LE -> MockLendingEngineBasic)", async () => {
        await (await registry.setModule(key("LENDING_ENGINE"), await mockLE.getAddress())).wait();
      });
      await mustSucceed("deployer: Registry.setModule(KEY_LIQUIDATION_VIEW -> MockEventsViewReentrant)", async () => {
        await (await registry.setModule(key("LIQUIDATION_VIEW"), await reentrantView.getAddress())).wait();
      });

      // Now liquidate: reentrantView will attempt to re-enter VBL.liquidate during push, which must revert via nonReentrant.
      await mustRevert("VBL.liquidate should revert on re-entrant callback (nonReentrant)", async () => {
        await (await vbl.liquidate(victim.address, collateralAsset, debtAsset, cAmt, dAmt, 0n)).wait();
      });
    } finally {
      await revertTo(snap);
    }
  }

  console.log("\n== Section 8: EIP-712 / intents / signatures (replay, expiry, chainId, ERC-1271) ==");
  {
    const snap = await snapshot();
    try {
      const asset = await usdc.getAddress();
      const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter, deployer)) as any;
      const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
      const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr, deployer)) as any;
      const poolAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
      const block = await ethers.provider.getBlock("latest");
      const now = BigInt(block!.timestamp);

      // Minimal role setup for local environment.
      const ensureRole = async (roleName: string, who: string) => {
        const r = key(roleName);
        if (!(await acm.hasRole(r, who))) {
          await (await acm.grantRole(r, who)).wait();
        }
      };
      await mustSucceed("role: SET_PARAMETER to deployer", async () => ensureRole("SET_PARAMETER", deployer.address));
      await mustSucceed("role: UPDATE_PRICE to deployer", async () => ensureRole("UPDATE_PRICE", deployer.address));
      await mustSucceed("role: ADD_WHITELIST to deployer", async () => ensureRole("ADD_WHITELIST", deployer.address));
      // finalizeMatch creates LoanOrders via ORDER_ENGINE, so VBL must hold ORDER_CREATE.
      await mustSucceed("role: ORDER_CREATE to VaultBusinessLogic", async () => ensureRole("ORDER_CREATE", await vbl.getAddress()));
      // SettlementMatchLib.finalizeAtomicFull routes fees through FeeRouter.distributeNormal, which requires ACTION_DEPOSIT on msg.sender (VBL).
      await mustSucceed("role: DEPOSIT to VaultBusinessLogic (FeeRouter distribute)", async () => ensureRole("DEPOSIT", await vbl.getAddress()));
      // LendingEngine mints LoanNFT; LoanNFT requires MINTER_ROLE_VALUE == ACTION_BORROW on msg.sender (the ORDER_ENGINE).
      await mustSucceed("role: BORROW to ORDER_ENGINE (LoanNFT minter)", async () => ensureRole("BORROW", orderEngineAddr));

      // Ensure asset is allowed + oracle supported + fresh price.
      if (!(await assetWhitelist.isAssetAllowed(asset))) {
        await (await assetWhitelist.connect(deployer).addAllowedAsset(asset)).wait();
      }
      if (!(await feeRouter.isTokenSupported(asset))) {
        await (await feeRouter.connect(deployer).addSupportedToken(asset)).wait();
      }
      {
        const cfg = await priceOracle.getAssetConfig(asset);
        if (!cfg.isActive) {
          await (await priceOracle.connect(deployer).configureAsset(asset, "usd-coin", 8, 3600n)).wait();
        }
      }
      await (await priceOracle.connect(deployer).updatePrice(asset, ethers.parseUnits("1", 8), Number(now))).wait();

      // Fund borrower + lender and set approvals.
      await (await usdc.connect(deployer).transfer(victim.address, ethers.parseUnits("100000", 6))).wait();
      await (await usdc.connect(deployer).transfer(attacker.address, ethers.parseUnits("100000", 6))).wait();

      const collateralAmt = ethers.parseUnits("5000", 6);
      const principal = ethers.parseUnits("1000", 6);
      const termDays = 5;
      const rateBps = 1000n;

      // Borrower must pre-deposit collateral via VaultCore.
      await (await usdc.connect(victim).approve(CONTRACT_ADDRESSES.CollateralManager, collateralAmt)).wait();
      await (await vaultCore.connect(victim).deposit(asset, collateralAmt)).wait();

      const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
      const borrowIntent = {
        borrower: victim.address,
        collateralAsset: asset,
        collateralAmount: collateralAmt,
        borrowAsset: asset,
        amount: principal,
        termDays,
        rateBps,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes("attack-borrow-salt-1")),
      };
      const lendIntent = {
        lenderSigner: attacker.address,
        asset,
        amount: principal,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt,
        salt: ethers.keccak256(ethers.toUtf8Bytes("attack-lend-salt-1")),
      };

      // Reserve replay attacks (same lendHash) / cancel replay (same lendHash)
      {
        const replayAmount = ethers.parseUnits("10", 6);
        const replayLend = {
          ...lendIntent,
          amount: replayAmount,
          salt: ethers.keccak256(ethers.toUtf8Bytes("attack-reserve-replay-1")),
        };
        await (await usdc.connect(attacker).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, replayAmount)).wait();
        const replayHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
            [
              ethers.keccak256(
                ethers.toUtf8Bytes(
                  "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
                )
              ),
              replayLend.lenderSigner,
              replayLend.asset,
              replayLend.amount,
              replayLend.minTermDays,
              replayLend.maxTermDays,
              replayLend.minRateBps,
              replayLend.expireAt,
              replayLend.salt,
            ]
          )
        );

        await mustSucceed("reserveForLending: initial reserve (replay test)", async () => {
          await (await vbl.connect(attacker).reserveForLending(attacker.address, asset, replayAmount, replayHash)).wait();
        });
        await mustRevert("reserveForLending replay (same lendHash)", async () => {
          await (await vbl.connect(attacker).reserveForLending(attacker.address, asset, replayAmount, replayHash)).wait();
        });
        await mustSucceed("cancelReserve: first cancel", async () => {
          await (await vbl.connect(attacker).cancelReserve(replayHash)).wait();
        });
        await mustRevert("cancelReserve replay (same lendHash)", async () => {
          await (await vbl.connect(attacker).cancelReserve(replayHash)).wait();
        });
        // After cancel, same hash can be reserved again (state cleared).
        await (await usdc.connect(attacker).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, replayAmount)).wait();
        await mustSucceed("reserveForLending after cancel (same lendHash)", async () => {
          await (await vbl.connect(attacker).reserveForLending(attacker.address, asset, replayAmount, replayHash)).wait();
        });
        await mustSucceed("cancelReserve after re-reserve", async () => {
          await (await vbl.connect(attacker).cancelReserve(replayHash)).wait();
        });
      }

      // Reserve funds
      await (await usdc.connect(attacker).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, principal)).wait();
      const lendHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
          [
            ethers.keccak256(
              ethers.toUtf8Bytes(
                "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
              )
            ),
            lendIntent.lenderSigner,
            lendIntent.asset,
            lendIntent.amount,
            lendIntent.minTermDays,
            lendIntent.maxTermDays,
            lendIntent.minRateBps,
            lendIntent.expireAt,
            lendIntent.salt,
          ]
        )
      );
      await (await vbl.connect(attacker).reserveForLending(attacker.address, asset, principal, lendHash)).wait();

      const chainId = Number((await ethers.provider.getNetwork()).chainId);
      const domainOk = buildTypedDataDomain(chainId, CONTRACT_ADDRESSES.VaultBusinessLogic);
      const sigBorrowerOk = await victim.signTypedData(domainOk, typesBorrow as any, borrowIntent as any);
      const sigLenderOk = await attacker.signTypedData(domainOk, typesLend as any, lendIntent as any);

      await mustSucceed("finalizeMatch: valid borrower/lender signatures", async () => {
        const tx = await vbl.connect(deployer).finalizeMatch(borrowIntent as any, [lendIntent] as any, sigBorrowerOk, [sigLenderOk]);
        const receipt = await tx.wait();
        // Invariant: LoanOrder.lender MUST be LenderPoolVault (Option A).
        let orderId: bigint | null = null;
        for (const log of receipt!.logs) {
          try {
            const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed?.name === "LoanOrderCreated") {
              orderId = parsed.args.orderId as bigint;
              break;
            }
          } catch {
            // ignore
          }
        }
        if (orderId === null) throw new Error("LoanOrderCreated not found (invariant check)");
        const ord = await orderEngine.connect(deployer)._getLoanOrderForView(orderId);
        const lenderInOrder = (ord.lender as string) ?? "";
        if (lenderInOrder.toLowerCase() !== poolAddr.toLowerCase()) {
          throw new Error(`LoanOrder.lender mismatch: got=${lenderInOrder} expectedPool=${poolAddr} orderId=${orderId.toString()}`);
        }
      });

      // Replay (same intents) must revert.
      await mustRevert("finalizeMatch replay (same intent hashes)", async () => {
        await (await vbl.connect(deployer).finalizeMatch(borrowIntent as any, [lendIntent] as any, sigBorrowerOk, [sigLenderOk])).wait();
      });

      // Expired intent must revert (even with valid sig).
      const expiredBorrow = { ...borrowIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-borrow-expired")), expireAt: now - 1n };
      const expiredLend = { ...lendIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-lend-expired")), expireAt: now - 1n };
      const sigBorrowExpired = await victim.signTypedData(domainOk, typesBorrow as any, expiredBorrow as any);
      const sigLendExpired = await attacker.signTypedData(domainOk, typesLend as any, expiredLend as any);
      await mustRevert("finalizeMatch with expired intents", async () => {
        await (await vbl.connect(deployer).finalizeMatch(expiredBorrow as any, [expiredLend] as any, sigBorrowExpired, [sigLendExpired])).wait();
      });

      // Cross-chain chainId mismatch: sign with chainId+1, should fail signature verification.
      const domainWrongChain = buildTypedDataDomain(chainId + 1, CONTRACT_ADDRESSES.VaultBusinessLogic);
      const bi2 = { ...borrowIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-borrow-wrong-chain")) };
      const li2 = { ...lendIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-lend-wrong-chain")) };
      const sigBorrowWrongChain = await victim.signTypedData(domainWrongChain, typesBorrow as any, bi2 as any);
      const sigLenderWrongChain = await attacker.signTypedData(domainWrongChain, typesLend as any, li2 as any);
      await mustRevert("finalizeMatch with signatures from wrong chainId", async () => {
        await (await vbl.connect(deployer).finalizeMatch(bi2 as any, [li2] as any, sigBorrowWrongChain, [sigLenderWrongChain])).wait();
      });

      // Wrong verifyingContract: sign for VaultCore instead of VBL.
      const domainWrongVC = buildTypedDataDomain(chainId, CONTRACT_ADDRESSES.VaultCore);
      const bi3 = { ...borrowIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-borrow-wrong-vc")) };
      const li3 = { ...lendIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-lend-wrong-vc")) };
      const sigBorrowWrongVC = await victim.signTypedData(domainWrongVC, typesBorrow as any, bi3 as any);
      const sigLenderWrongVC = await attacker.signTypedData(domainWrongVC, typesLend as any, li3 as any);
      await mustRevert("finalizeMatch with signatures bound to wrong verifyingContract", async () => {
        await (await vbl.connect(deployer).finalizeMatch(bi3 as any, [li3] as any, sigBorrowWrongVC, [sigLenderWrongVC])).wait();
      });

      // Wrong signer: attacker signs borrow intent pretending to be victim.
      const bi4 = { ...borrowIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-borrow-wrong-signer")) };
      const li4 = { ...lendIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-lend-wrong-signer")) };
      const sigBorrowWrongSigner = await attacker.signTypedData(domainOk, typesBorrow as any, bi4 as any);
      const sigLenderOk4 = await attacker.signTypedData(domainOk, typesLend as any, li4 as any);
      await mustRevert("finalizeMatch with borrower signature by wrong EOA", async () => {
        await (await vbl.connect(deployer).finalizeMatch(bi4 as any, [li4] as any, sigBorrowWrongSigner, [sigLenderOk4])).wait();
      });

      // ERC-1271 boundary: contract borrower wallet.
      const Wallet = await ethers.getContractFactory("MockERC1271Wallet", deployer);
      const wValid = await Wallet.deploy(0); // AlwaysValid
      await wValid.waitForDeployment();
      const wInvalid = await Wallet.deploy(1); // AlwaysInvalid
      await wInvalid.waitForDeployment();

      // Fund + deposit collateral from wallet (via exec).
      await (await usdc.connect(deployer).transfer(await wValid.getAddress(), ethers.parseUnits("20000", 6))).wait();
      await (await wValid.exec(asset, 0, usdc.interface.encodeFunctionData("approve", [CONTRACT_ADDRESSES.CollateralManager, collateralAmt]))).wait();
      await (await wValid.exec(CONTRACT_ADDRESSES.VaultCore, 0, vaultCore.interface.encodeFunctionData("deposit", [asset, collateralAmt]))).wait();

      // Reserve again for a new loan
      const bi5 = { ...borrowIntent, borrower: await wValid.getAddress(), salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-valid-borrow")) };
      const li5 = { ...lendIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-valid-lend")) };
      await (await usdc.connect(attacker).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, principal)).wait();
      const lendHash5 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
          [
            ethers.keccak256(
              ethers.toUtf8Bytes(
                "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
              )
            ),
            li5.lenderSigner,
            li5.asset,
            li5.amount,
            li5.minTermDays,
            li5.maxTermDays,
            li5.minRateBps,
            li5.expireAt,
            li5.salt,
          ]
        )
      );
      await (await vbl.connect(attacker).reserveForLending(attacker.address, asset, principal, lendHash5)).wait();

      // For ERC-1271 wallets, "signature bytes" can be arbitrary; wallet defines policy.
      await mustSucceed("finalizeMatch: ERC-1271 borrower (AlwaysValid wallet) accepts arbitrary signature", async () => {
        const sigBorrow1271 = "0x"; // empty
        const sigLender1271 = await attacker.signTypedData(domainOk, typesLend as any, li5 as any);
        await (await vbl.connect(deployer).finalizeMatch(bi5 as any, [li5] as any, sigBorrow1271, [sigLender1271])).wait();
      });

      // AlwaysInvalid wallet must reject even if caller provides any signature.
      const bi6 = { ...borrowIntent, borrower: await wInvalid.getAddress(), salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-invalid-borrow")) };
      const li6 = { ...lendIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-invalid-lend")) };
      const sigLender6 = await attacker.signTypedData(domainOk, typesLend as any, li6 as any);
      await mustRevert("finalizeMatch: ERC-1271 borrower (AlwaysInvalid wallet) rejects", async () => {
        await (await vbl.connect(deployer).finalizeMatch(bi6 as any, [li6] as any, "0x", [sigLender6])).wait();
      });

      // ERC-1271 lenderSigner: contract lender is the signer, but LoanOrder.lender must still be Pool.
      {
        const wLender = await Wallet.deploy(3); // ValidOnlyForDigest
        await wLender.waitForDeployment();
        const wLenderAddr = await wLender.getAddress();

        // Fund wallet with principal and approve VBL via exec.
        await (await usdc.connect(deployer).transfer(wLenderAddr, ethers.parseUnits("5000", 6))).wait();
        await (await wLender.exec(asset, 0, usdc.interface.encodeFunctionData("approve", [CONTRACT_ADDRESSES.VaultBusinessLogic, principal]))).wait();

        const biLender1271 = { ...borrowIntent, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-lender-borrow")) };
        const liLender1271 = { ...lendIntent, lenderSigner: wLenderAddr, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-lender-lend")) };

        const lendHashL = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
            [
              ethers.keccak256(
                ethers.toUtf8Bytes(
                  "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
                )
              ),
              liLender1271.lenderSigner,
              liLender1271.asset,
              liLender1271.amount,
              liLender1271.minTermDays,
              liLender1271.maxTermDays,
              liLender1271.minRateBps,
              liLender1271.expireAt,
              liLender1271.salt,
            ]
          )
        );

        // Reserve from wallet address (msg.sender = wallet; transferFrom pulls from wallet).
        await mustSucceed("reserveForLending: ERC-1271 lenderSigner wallet reserves", async () => {
          await (
            await wLender.exec(
              CONTRACT_ADDRESSES.VaultBusinessLogic,
              0,
              vbl.interface.encodeFunctionData("reserveForLending", [wLenderAddr, asset, principal, lendHashL])
            )
          ).wait();
        });

        // Configure digest allowlist in wallet to match the typed-data digest used by VBL for lender verification.
        const lenderDigest = ethers.TypedDataEncoder.hash(domainOk as any, typesLend as any, liLender1271 as any);
        await (await wLender.setAllowedDigest(lenderDigest)).wait();

        const sigBorrowL = await victim.signTypedData(domainOk, typesBorrow as any, biLender1271 as any);
        await mustSucceed("finalizeMatch: ERC-1271 lenderSigner wallet validates digest (signature can be empty)", async () => {
          const tx = await vbl.connect(deployer).finalizeMatch(biLender1271 as any, [liLender1271] as any, sigBorrowL, ["0x"]);
          const receipt = await tx.wait();
          // Invariant: order.lender must be Pool
          let orderId: bigint | null = null;
          for (const log of receipt!.logs) {
            try {
              const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
              if (parsed?.name === "LoanOrderCreated") {
                orderId = parsed.args.orderId as bigint;
                break;
              }
            } catch {
              // ignore
            }
          }
          if (orderId === null) throw new Error("LoanOrderCreated not found (ERC-1271 lenderSigner)");
          const ord = await orderEngine.connect(deployer)._getLoanOrderForView(orderId);
          const lenderInOrder = (ord.lender as string) ?? "";
          if (lenderInOrder.toLowerCase() !== poolAddr.toLowerCase()) {
            throw new Error(`LoanOrder.lender mismatch: got=${lenderInOrder} expectedPool=${poolAddr} orderId=${orderId.toString()}`);
          }
        });

        // Negative: wrong digest should be rejected by wallet policy.
        await (await wLender.setAllowedDigest(ethers.keccak256(ethers.toUtf8Bytes("wrong-digest")))).wait();
        const biL2 = { ...biLender1271, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-lender-borrow-2")) };
        const liL2 = { ...liLender1271, salt: ethers.keccak256(ethers.toUtf8Bytes("attack-1271-lender-lend-2")) };
        // reserve again for new hash
        await (await wLender.exec(asset, 0, usdc.interface.encodeFunctionData("approve", [CONTRACT_ADDRESSES.VaultBusinessLogic, principal]))).wait();
        const lendHashL2 = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
            [
              ethers.keccak256(
                ethers.toUtf8Bytes(
                  "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
                )
              ),
              liL2.lenderSigner,
              liL2.asset,
              liL2.amount,
              liL2.minTermDays,
              liL2.maxTermDays,
              liL2.minRateBps,
              liL2.expireAt,
              liL2.salt,
            ]
          )
        );
        await (
          await wLender.exec(
            CONTRACT_ADDRESSES.VaultBusinessLogic,
            0,
            vbl.interface.encodeFunctionData("reserveForLending", [wLenderAddr, asset, principal, lendHashL2])
          )
        ).wait();
        const sigBorrowL2 = await victim.signTypedData(domainOk, typesBorrow as any, biL2 as any);
        await mustRevert("finalizeMatch: ERC-1271 lenderSigner wallet rejects when digest not allowed", async () => {
          await (await vbl.connect(deployer).finalizeMatch(biL2 as any, [liL2] as any, sigBorrowL2, ["0x"])).wait();
        });
      }
    } finally {
      await revertTo(snap);
    }
  }

  console.log("\n== Section 9: Dynamic module keys / module replacement abuse ==");
  {
    const snap = await snapshot();
    try {
      if (!dynKeyRegistry) {
        console.log("  (skip) RegistryDynamicModuleKey not deployed");
      } else {
        const dynAsAttacker = dynKeyRegistry.connect(attacker);
        await mustRevert("attacker: registerModuleKey()", async () => {
          await (await dynAsAttacker.registerModuleKey("new_key_from_attacker")).wait();
        });
        await mustRevert("attacker: batchRegisterModuleKeys()", async () => {
          await (await dynAsAttacker.batchRegisterModuleKeys(["a", "b", "c"])).wait();
        });
        await mustRevert("attacker: pause()", async () => {
          await (await dynAsAttacker.pause()).wait();
        });
        await mustRevert("attacker: setRegistrationAdmin()", async () => {
          await (await dynAsAttacker.setRegistrationAdmin(attacker.address)).wait();
        });

        // As admin (deployer), validate normalization/name collisions and batch limits.
        const dynAsAdmin = dynKeyRegistry.connect(deployer);
        await mustSucceed("admin: registerModuleKey('attack_test_key')", async () => {
          await (await dynAsAdmin.registerModuleKey("attack_test_key")).wait();
        });
        await mustRevert("admin: registerModuleKey('  Attack_Test_Key  ') (normalized collision)", async () => {
          await (await dynAsAdmin.registerModuleKey("  Attack_Test_Key  ")).wait();
        });
        await mustRevert("admin: registerModuleKey('ab') (too short)", async () => {
          await (await dynAsAdmin.registerModuleKey("ab")).wait();
        });
        await mustRevert("admin: registerModuleKey('bad*chars') (invalid char)", async () => {
          await (await dynAsAdmin.registerModuleKey("bad*chars")).wait();
        });

        // Batch size limit (MAX_BATCH_SIZE = 20). Try 21.
        const batch21 = Array.from({ length: 21 }, (_, i) => `k_${i}_x`);
        await mustRevert("admin: batchRegisterModuleKeys(21) exceeds MAX_BATCH_SIZE", async () => {
          await (await dynAsAdmin.batchRegisterModuleKeys(batch21)).wait();
        });

        // Registry hook itself should remain owner-only
        const regAsAttacker = registry.connect(attacker);
        await mustRevert("attacker: Registry.setDynamicModuleKeyRegistry()", async () => {
          await (await regAsAttacker.setDynamicModuleKeyRegistry(attacker.address)).wait();
        });
      }
    } finally {
      await revertTo(snap);
    }
  }

  console.log("\n== Section 10: Price manipulation chain (updater perms, timestamp rollback/future DoS, maxPriceAge DoS) ==");
  {
    const snap = await snapshot();
    try {
      const asset = await usdc.getAddress();
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const poAsAttacker = priceOracle.connect(attacker);
      await mustRevert("attacker: PriceOracle.configureAsset()", async () => {
        await (await poAsAttacker.configureAsset(asset, "x", 8, 3600n)).wait();
      });
      await mustRevert("attacker: PriceOracle.updatePrice()", async () => {
        await (await poAsAttacker.updatePrice(asset, 1n, now)).wait();
      });
      await mustRevert("attacker: PriceOracle.configureAsset()", async () => {
        await (await poAsAttacker.configureAsset(asset, "x", 8, 1n)).wait();
      });

      if (priceUpdater) {
        const upAsAttacker = priceUpdater.connect(attacker);
        await mustRevert("attacker: CoinGeckoPriceUpdater.updateAssetPrice()", async () => {
          await (await upAsAttacker.updateAssetPrice(asset, 1n, now)).wait();
        });
      }

      // Admin-only "timestamp future" DoS check: if updater sets timestamp > block.timestamp,
      // PriceOracle.getPrice() will underflow and revert in Solidity 0.8.
      const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
      if (!(await acm.hasRole(ACTION_UPDATE_PRICE, deployer.address))) {
        await (await acm.grantRole(ACTION_UPDATE_PRICE, deployer.address)).wait();
      }
      {
        const cfg = await priceOracle.getAssetConfig(asset);
        if (!cfg.isActive) {
          const ACTION_SET_PARAMETER = key("SET_PARAMETER");
          if (!(await acm.hasRole(ACTION_SET_PARAMETER, deployer.address))) {
            await (await acm.grantRole(ACTION_SET_PARAMETER, deployer.address)).wait();
          }
          await (await priceOracle.connect(deployer).configureAsset(asset, "usd-coin", 8, 3600n)).wait();
        }
      }

      await mustSucceed("admin: updatePrice(asset, price=1, timestamp=now)", async () => {
        await (await priceOracle.connect(deployer).updatePrice(asset, 1n, now)).wait();
      });

      await mustSucceed("admin: updatePrice(asset, timestamp in the past) (allowed behavior)", async () => {
        await (await priceOracle.connect(deployer).updatePrice(asset, 1n, now - 10)).wait();
      });

      // After fix: future timestamps are rejected at write-time, and read-path never panics.
      await mustRevert("admin: updatePrice(asset, timestamp in the future) should revert (prevent DoS)", async () => {
        await (await priceOracle.connect(deployer).updatePrice(asset, 1n, now + 3600)).wait();
      });
      await mustSucceed("PriceOracle.getPrice should NOT panic (even if future timestamp attempted)", async () => {
        await priceOracle.getPrice(asset);
      });
    } finally {
      await revertTo(snap);
    }
  }

  console.log("\n== Section 11: Batch/DoS + cache push failure semantics (best-effort vs atomic) ==");
  {
    const snap = await snapshot();
    try {
      // 11.1 RegistryView / batch size sanity (DoS guard)
      const registryViewAddr = await registry.getModuleOrRevert(key("REGISTRY_VIEW"));
      const registryView = (await ethers.getContractAt("RegistryView", registryViewAddr, deployer)) as any;
      await mustRevert("RegistryView.getRegisteredModuleKeysPaginated(limit huge) should revert BatchTooLarge", async () => {
        await registryView.getRegisteredModuleKeysPaginated(0n, 1000n);
      });

      // 11.2 LiquidationManager batch size guard
      const bigN = 1000;
      const assetAddr = await usdc.getAddress();
      const addrs = Array.from({ length: bigN }, () => victim.address);
      const assets = Array.from({ length: bigN }, () => assetAddr);
      const amts = Array.from({ length: bigN }, () => 1n);
      await mustRevert("LiquidationManager.batchLiquidate(len huge) should revert BatchTooLarge", async () => {
        await (await liquidationManager.connect(deployer).batchLiquidate(addrs, assets, assets, amts, amts, amts)).wait();
      });

      // 11.3 Cache push failure: LiquidationManager is best-effort (should NOT revert),
      // while VBL.liquidate is atomic (should revert) — validated with mocks.
      // ActionKeys.ACTION_LIQUIDATE == keccak256("LIQUIDATE")
      const ACTION_LIQUIDATE = key("LIQUIDATE");
      if (!(await acm.hasRole(ACTION_LIQUIDATE, deployer.address))) {
        await (await acm.grantRole(ACTION_LIQUIDATE, deployer.address)).wait();
      }

      const mockCM = await (await ethers.getContractFactory("MockCollateralManager", deployer)).deploy();
      await mockCM.waitForDeployment();
      const mockLE = await (await ethers.getContractFactory("MockLendingEngineBasic", deployer)).deploy();
      await mockLE.waitForDeployment();
      const revertingView = await (await ethers.getContractFactory("RevertingLiquidationEventsView", deployer)).deploy();
      await revertingView.waitForDeployment();

      const asset = await usdc.getAddress();
      const cAmt = 100n;
      const dAmt = 50n;
      await (await mockCM.depositCollateral(victim.address, asset, cAmt)).wait();
      await (await mockLE.setUserDebt(victim.address, asset, dAmt)).wait();
      await (await mockLE.setTotalDebtByAsset(asset, dAmt)).wait();

      // Point LiquidationManager path to mocks + reverting view.
      await (await registry.setModule(key("COLLATERAL_MANAGER"), await mockCM.getAddress())).wait();
      await (await registry.setModule(key("LENDING_ENGINE"), await mockLE.getAddress())).wait();
      await (await registry.setModule(key("LIQUIDATION_VIEW"), await revertingView.getAddress())).wait();

      // LiquidationManager should succeed and emit CacheUpdateFailed (best-effort).
      const tx = await liquidationManager.connect(deployer).liquidate(victim.address, asset, asset, cAmt, dAmt, 0n);
      const rc = await tx.wait();
      const colAfter: bigint = await mockCM.getCollateral(victim.address, asset);
      const debtAfter: bigint = await mockLE.getDebt(victim.address, asset);
      if (colAfter !== 0n || debtAfter !== 0n) {
        throw new Error(`[FAIL] LiquidationManager best-effort expected state changes, got col=${colAfter} debt=${debtAfter}`);
      }
      const cacheFailTopic = liquidationManager.interface.getEvent("CacheUpdateFailed").topicHash;
      const sawCacheFail = rc!.logs.some((l: any) => l.topics?.[0] === cacheFailTopic);
      if (!sawCacheFail) {
        throw new Error("[FAIL] Expected CacheUpdateFailed event on best-effort push failure");
      }
      console.log("  ✅ [ok] LiquidationManager best-effort push: state updated + CacheUpdateFailed emitted");

      // VBL.liquidate is atomic; with reverting view it must revert and roll back.
      await (await mockCM.depositCollateral(victim.address, asset, cAmt)).wait();
      await (await mockLE.setUserDebt(victim.address, asset, dAmt)).wait();
      await (await mockLE.setTotalDebtByAsset(asset, dAmt)).wait();
      await mustRevert("VBL.liquidate should revert on LIQUIDATION_VIEW failure (atomic)", async () => {
        await (await vbl.connect(deployer).liquidate(victim.address, asset, asset, cAmt, dAmt, 0n)).wait();
      });
      const colAfterVbl: bigint = await mockCM.getCollateral(victim.address, asset);
      const debtAfterVbl: bigint = await mockLE.getDebt(victim.address, asset);
      if (colAfterVbl !== cAmt || debtAfterVbl !== dAmt) {
        throw new Error(`[FAIL] VBL.atomic expected rollback, got col=${colAfterVbl} debt=${debtAfterVbl}`);
      }
      console.log("  ✅ [ok] VBL atomic push: reverted + state rolled back");
    } finally {
      await revertTo(snap);
    }
  }

  console.log("\n✅ Attack E2E Suite finished.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

