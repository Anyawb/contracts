import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

// Covers:
// - EasyEmissionConfig.setEmissionParams() governance write
// - Best-effort RewardView DataPushed(EASY_EMISSION_PARAMS_UPDATED) lamp
// - Best-effort failure path emits RewardViewPushFailed (no revert)

describe("Reward – EasyEmissionConfig params update datapush", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_REWARD_VIEW = ethers.id("REWARD_VIEW");

  // RewardView writer keys (must all exist; RewardView.onlyWriter resolves all via Registry.getModuleOrRevert)
  const KEY_REWARD_MANAGER_CORE = ethers.id("REWARD_MANAGER_CORE");
  const KEY_EASY_EMISSION_CONTROLLER = ethers.id("EASY_EMISSION_CONTROLLER");
  const KEY_REWARD_ACCRUAL_MANAGER = ethers.id("REWARD_ACCRUAL_MANAGER");
  const KEY_EASY_STAKING = ethers.id("EASY_STAKING");
  const KEY_EASY_EMISSION_CONFIG = ethers.id("EASY_EMISSION_CONFIG");
  const KEY_EASY_CONSUMPTION = ethers.id("EASY_CONSUMPTION");
  const KEY_EASY_RECYCLE_DISTRIBUTOR = ethers.id("EASY_RECYCLE_DISTRIBUTOR");

  const ROLE_SET_PARAMETER = ethers.id("SET_PARAMETER");
  const ROLE_VIEW_SYSTEM_DATA = ethers.id("VIEW_SYSTEM_DATA");

  const DATA_TYPE_EASY_EMISSION_PARAMS_UPDATED = ethers.id("EASY_EMISSION_PARAMS_UPDATED");
  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();
  const PUSH_FAILED_IFACE = new ethers.Interface([
    "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
  ]);
  const UNAUTHORIZED_WRITER_SELECTOR = ethers.id("RewardView__UnauthorizedWriter()").slice(0, 10).toLowerCase();

  function getDataPushed(receipt: any, emitter: string) {
    return receipt.logs
      .filter((log: any) => (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0)
      .filter((log: any) => log.address.toLowerCase() === emitter.toLowerCase())
      .map((log: any) => {
        const parsed = DATA_PUSH_IFACE.parseLog(log);
        if (!parsed) throw new Error("failed to parse DataPushed log");
        return {
          dataTypeHash: (parsed.args.dataTypeHash as string).toLowerCase(),
          payload: parsed.args.payload as string,
        };
      });
  }

  function getRewardViewPushFailed(receipt: any, emitter: string) {
    return receipt.logs
      .filter((log: any) => log.address.toLowerCase() === emitter.toLowerCase())
      .map((log: any) => {
        try {
          const parsed = PUSH_FAILED_IFACE.parseLog(log);
          return parsed ? parsed.args : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async function fixture() {
    const [admin, governance, ops, rmc, ec, ram, es, econ, erd, outsider] = await ethers.getSigners();

    const ACM = await ethers.getContractFactory("AccessControlManager");
    const acm: any = await ACM.deploy(admin.address);
    await acm.waitForDeployment();

    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    const registry: any = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const RewardViewF = await ethers.getContractFactory("RewardView");
    const rewardView = await upgrades.deployProxy(RewardViewF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    });
    const rewardViewAddr = await rewardView.getAddress();

    const EasyEmissionConfigF = await ethers.getContractFactory("EasyEmissionConfig");
    const easyEmissionConfig = await upgrades.deployProxy(EasyEmissionConfigF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    });
    const easyEmissionConfigAddr = await easyEmissionConfig.getAddress();

    // Bind registry modules
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_REWARD_VIEW, rewardViewAddr);

    await registry.setModule(KEY_REWARD_MANAGER_CORE, rmc.address);
    await registry.setModule(KEY_EASY_EMISSION_CONTROLLER, ec.address);
    await registry.setModule(KEY_REWARD_ACCRUAL_MANAGER, ram.address);
    await registry.setModule(KEY_EASY_STAKING, es.address);
    await registry.setModule(KEY_EASY_EMISSION_CONFIG, easyEmissionConfigAddr);
    await registry.setModule(KEY_EASY_CONSUMPTION, econ.address);
    await registry.setModule(KEY_EASY_RECYCLE_DISTRIBUTOR, erd.address);

    // Roles
    await acm.connect(admin).grantRole(ROLE_SET_PARAMETER, governance.address);
    await acm.connect(admin).grantRole(ROLE_VIEW_SYSTEM_DATA, ops.address);

    return { admin, governance, ops, outsider, registry, acm, rewardView, easyEmissionConfig };
  }

  it("setEmissionParams emits RewardView DataPushed(EASY_EMISSION_PARAMS_UPDATED) with correct payload and updates RewardView cache", async function () {
    const { governance, ops, rewardView, easyEmissionConfig } = await loadFixture(fixture);

    const thresholdValue = 123n;
    const mintPer1000Usd = 456n;
    const kNum = 7n;
    const kDen = 8n;

    const tx = await easyEmissionConfig.connect(governance).setEmissionParams(thresholdValue, mintPer1000Usd, kNum, kDen);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("missing receipt");

    const pushes = getDataPushed(receipt, await rewardView.getAddress());
    const match = pushes.find((p) => p.dataTypeHash === DATA_TYPE_EASY_EMISSION_PARAMS_UPDATED.toLowerCase());
    expect(match, "missing DataPushed(EASY_EMISSION_PARAMS_UPDATED)").to.not.be.undefined;

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "uint8", "uint256", "uint256", "uint256", "uint256"],
      (match as any).payload
    );
    expect(decoded[0]).to.equal(thresholdValue);
    expect(decoded[1]).to.equal(18n);
    expect(decoded[2]).to.equal(mintPer1000Usd);
    expect(decoded[3]).to.equal(kNum);
    expect(decoded[4]).to.equal(kDen);
    expect(decoded[5]).to.equal(BigInt(receipt.blockNumber));

    const [t, m, kn, kd, valuationDecimals, cacheBlock, isValid] = await rewardView.connect(ops).getEasyEmissionParamsWithMeta();
    expect(t).to.equal(thresholdValue);
    expect(m).to.equal(mintPer1000Usd);
    expect(kn).to.equal(kNum);
    expect(kd).to.equal(kDen);
    expect(valuationDecimals).to.equal(18n);
    expect(cacheBlock).to.equal(BigInt(receipt.blockNumber));
    expect(isValid).to.equal(true);
  });

  it("reverts when caller lacks SET_PARAMETER role", async function () {
    const { outsider, easyEmissionConfig } = await loadFixture(fixture);

    await expect(easyEmissionConfig.connect(outsider).setEmissionParams(1n, 1n, 1n, 1n)).to.be.reverted;
  });

  it("best-effort: misconfigured RewardView writer does not revert setEmissionParams and emits RewardViewPushFailed", async function () {
    const { governance, registry, rewardView, easyEmissionConfig } = await loadFixture(fixture);

    // Misconfigure registry: RewardView expects KEY_EASY_EMISSION_CONFIG == msg.sender, but we bind it to a different address.
    const wrong = ethers.Wallet.createRandom().address;
    await registry.setModule(KEY_EASY_EMISSION_CONFIG, wrong);

    const thresholdValue = 10n;
    const mintPer1000Usd = 11n;
    const kNum = 12n;
    const kDen = 13n;

    const tx = await easyEmissionConfig.connect(governance).setEmissionParams(thresholdValue, mintPer1000Usd, kNum, kDen);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("missing receipt");

    // Main write succeeded (no revert) and config storage updated.
    const [t, m, kn, kd, valuationDecimals] = await easyEmissionConfig.getEmissionParams();
    expect(t).to.equal(thresholdValue);
    expect(m).to.equal(mintPer1000Usd);
    expect(kn).to.equal(kNum);
    expect(kd).to.equal(kDen);
    expect(valuationDecimals).to.equal(18n);

    // Push failed event emitted by RewardModuleBase.
    await expect(tx)
      .to.emit(easyEmissionConfig, "RewardViewPushFailed")
      .withArgs(
        ethers.ZeroAddress,
        await rewardView.getAddress(),
        ethers.id("EASY_EMISSION_PARAMS_UPDATED"),
        anyValue,
        anyValue
      );

    const events = getRewardViewPushFailed(receipt, await easyEmissionConfig.getAddress());
    expect(events.length).to.equal(1);
    const reasonBytes = events[0].reason as string;
    const reasonHex = ethers.hexlify(ethers.getBytes(reasonBytes));
    expect(reasonHex.slice(0, 10)).to.equal(UNAUTHORIZED_WRITER_SELECTOR);
  });
});
