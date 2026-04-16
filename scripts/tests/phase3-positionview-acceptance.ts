import hardhat from "hardhat";

const { ethers, upgrades } = hardhat;

/**
 * Phase 3 acceptance (PositionView):
 * - Strict optimistic concurrency via nextVersion
 * - Idempotent replay via requestId (O(1) lastAppliedRequestId)
 * - Optional monotonic ordering via seq (reject out-of-order)
 * - Observability: DataPushed on success paths
 *
 * Run:
 *   pnpm -s hardhat run scripts/tests/phase3-positionview-acceptance.ts
 */
async function main() {
  const [admin, user, vbl] = await ethers.getSigners();

  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_ACM = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_VC = ethers.id("VAULT_CORE");
  const KEY_VBL = ethers.id("VAULT_BUSINESS_LOGIC");

  const ACTION_ADMIN = ethers.id("ACTION_ADMIN");
  const ACTION_VIEW_PUSH = ethers.id("ACTION_VIEW_PUSH");

  const Registry = await ethers.getContractFactory("MockRegistry");
  const registry = await Registry.deploy();

  const Access = await ethers.getContractFactory("MockAccessControlManager");
  const access = await Access.deploy();
  await access.grantRole(ACTION_ADMIN, admin.address);

  const Collateral = await ethers.getContractFactory("MockCollateralManager");
  const collateral = await Collateral.deploy();
  const Lending = await ethers.getContractFactory("MockLendingEngineBasic");
  const lending = await Lending.deploy();

  const MockVaultCoreView = await ethers.getContractFactory("MockVaultCoreView");
  const vaultCoreView = await MockVaultCoreView.deploy();
  await vaultCoreView.setViewContractAddr(admin.address);

  await registry.setModule(KEY_ACM, await access.getAddress());
  await registry.setModule(KEY_CM, await collateral.getAddress());
  await registry.setModule(KEY_LE, await lending.getAddress());
  await registry.setModule(KEY_VC, await vaultCoreView.getAddress());
  await registry.setModule(KEY_VBL, vbl.address);

  await access.grantRole(ACTION_VIEW_PUSH, await collateral.getAddress());
  await access.grantRole(ACTION_VIEW_PUSH, await lending.getAddress());
  await access.grantRole(ACTION_VIEW_PUSH, admin.address);
  await access.grantRole(ACTION_VIEW_PUSH, vbl.address);

  const PositionView = await ethers.getContractFactory("PositionView");
  const pv = await upgrades.deployProxy(PositionView, [await registry.getAddress()], { kind: "uups" });

  const asset = ethers.Wallet.createRandom().address;
  const DATA_TYPE_USER_POSITION_UPDATE = ethers.id("USER_POSITION_UPDATE");

  // 1) Success path should emit DataPushed and set version=1.
  await collateral.depositCollateral(user.address, asset, 10n);
  await lending.setUserDebt(user.address, asset, 1n);

  const req1 = ethers.id("pv-req-1");
  const tx1 = await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
    user.address,
    asset,
    10n,
    1n,
    req1,
    10n,
    1n
  );
  const r1 = await tx1.wait();
  if (!r1) throw new Error("missing receipt");
  const v1 = await pv.getPositionVersion(user.address, asset);
  if (v1 !== 1n) throw new Error(`expected version=1, got ${v1}`);

  const dataPushedFragment = pv.interface.getEvent("DataPushed");
  if (!dataPushedFragment) {
    throw new Error("expected PositionView interface to expose DataPushed");
  }
  const dataPushedTopic = dataPushedFragment.topicHash;
  const dataPushedLogs = r1.logs
    .filter((l) => l.address.toLowerCase() === (pv.target as string).toLowerCase())
    .filter((l) => l.topics?.[0] === dataPushedTopic);
  if (dataPushedLogs.length === 0) throw new Error("expected DataPushed on success");
  const parsed = pv.interface.parseLog(dataPushedLogs[0]);
  if (!parsed) {
    throw new Error("expected PositionView DataPushed log to be decodable");
  }
  if (parsed.args[0] !== DATA_TYPE_USER_POSITION_UPDATE) {
    throw new Error(`unexpected dataTypeHash: ${parsed.args[0]}`);
  }

  // 2) Idempotent replay: nextVersion == currentVersion and same requestId => ignored.
  const txReplay = await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
    user.address,
    asset,
    10n,
    1n,
    req1,
    1n, // seq smaller (should still be ignored due to idempotency)
    1n // nextVersion == currentVersion
  );
  await txReplay.wait();
  const vAfterReplay = await pv.getPositionVersion(user.address, asset);
  if (vAfterReplay !== 1n) throw new Error(`idempotent replay must not change version, got ${vAfterReplay}`);

  // 3) seq must be strictly increasing (non-idempotent): out-of-order should revert.
  const req2 = ethers.id("pv-req-2");
  let reverted = false;
  try {
    await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
      user.address,
      asset,
      10n,
      1n,
      req2,
      9n, // out-of-order (<= 10)
      2n
    );
  } catch {
    reverted = true;
  }
  if (!reverted) throw new Error("expected out-of-order seq to revert");

  console.log("✅ Phase3 PositionView acceptance passed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

