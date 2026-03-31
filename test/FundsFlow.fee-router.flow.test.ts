import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Funds-Flow (SSOT) – FeeRouter flow
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §7 (Fee Flow)
 */

describe("Funds-Flow – FeeRouter flow", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");

  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));

  const DATA_TYPE_FEE_DISTRIBUTED = ethers.keccak256(ethers.toUtf8Bytes("FEE_DISTRIBUTED"));

  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

  function getDataPushTypes(receipt: any): string[] {
    return receipt.logs
      .filter((log: any) => (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0)
      .map((log: any) => DATA_PUSH_IFACE.parseLog(log).args.dataTypeHash.toLowerCase());
  }

  async function deployFixture() {
    const [admin, operator, treasury, eco] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACMF.deploy();

    const FeeRouterF = await ethers.getContractFactory("FeeRouter");
    const feeRouter = await upgrades.deployProxy(
      FeeRouterF,
      [registry.target, treasury.address, eco.address, 300, 200],
      { kind: "uups", initializer: "initialize" }
    );

    const TokenF = await ethers.getContractFactory("MockERC20");
    const token = await TokenF.deploy("Mock USDC", "USDC", 18, ethers.parseUnits("1000000", 18));

    await registry.setModule(KEY_ACCESS_CONTROL, acm.target);
    await acm.grantRole(ACTION_SET_PARAMETER, admin.address);
    await acm.grantRole(ACTION_DEPOSIT, operator.address);

    await feeRouter.connect(admin).addSupportedToken(token.target);

    await token.transfer(operator.address, ethers.parseUnits("10000", 18));
    await token.connect(operator).approve(feeRouter.target, ethers.parseUnits("10000", 18));

    return { admin, operator, treasury, eco, registry, acm, feeRouter, token };
  }

  it("distributeNormal routes fee to treasury/eco and emits DataPushed", async function () {
    const { operator, treasury, eco, feeRouter, token } = await loadFixture(deployFixture);

    const amount = 10_000n;

    const treasuryBefore = await token.balanceOf(treasury.address);
    const ecoBefore = await token.balanceOf(eco.address);

    const tx = await feeRouter.connect(operator).distributeNormal(token.target, amount);
    const receipt = await tx.wait();

    await expect(tx).to.emit(feeRouter, "FeeDistributed").withArgs(token.target, 300n, 200n);

    const treasuryAfter = await token.balanceOf(treasury.address);
    const ecoAfter = await token.balanceOf(eco.address);

    expect(treasuryAfter - treasuryBefore).to.equal(300n);
    expect(ecoAfter - ecoBefore).to.equal(200n);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_FEE_DISTRIBUTED.toLowerCase());
  });

  it("distributePrepaid uses FeeRouter balance and emits DataPushed", async function () {
    const { operator, treasury, eco, feeRouter, token } = await loadFixture(deployFixture);

    const amount = 5_000n;
    const feeType = ethers.keccak256(ethers.toUtf8Bytes("FEE_TYPE_PREPAID"));

    await token.transfer(feeRouter.target, amount);

    const treasuryBefore = await token.balanceOf(treasury.address);
    const ecoBefore = await token.balanceOf(eco.address);

    const tx = await feeRouter.connect(operator).distributePrepaid(token.target, amount, feeType, operator.address);
    const receipt = await tx.wait();

    await expect(tx).to.emit(feeRouter, "FeeDistributed").withArgs(token.target, 3000n, 2000n);

    const treasuryAfter = await token.balanceOf(treasury.address);
    const ecoAfter = await token.balanceOf(eco.address);

    expect(treasuryAfter - treasuryBefore).to.equal(3000n);
    expect(ecoAfter - ecoBefore).to.equal(2000n);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_FEE_DISTRIBUTED.toLowerCase());
  });

  it("reverts when caller lacks ACTION_DEPOSIT", async function () {
    const { admin, feeRouter, token, acm } = await loadFixture(deployFixture);

    await acm.revokeRole(ACTION_DEPOSIT, admin.address);

    await expect(feeRouter.connect(admin).distributeNormal(token.target, 100))
      .to.be.revertedWithCustomError(acm, "MissingRole");
  });
});
