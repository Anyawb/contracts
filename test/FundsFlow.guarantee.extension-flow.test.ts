import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * Funds-Flow (SSOT) – Guarantee extension flow
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §5 (Extension Flow)
 */

describe("Funds-Flow – Guarantee extension flow", function () {
  const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");

  const DATA_TYPE_GUARANTEE_LOCKED = ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_LOCKED"));
  const DATA_TYPE_GUARANTEE_RELEASED = ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_RELEASED"));
  const DATA_TYPE_GUARANTEE_FORFEITED = ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_FORFEITED"));

  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

  function getDataPushTypes(receipt: any): string[] {
    return receipt.logs
      .filter((log: any) => (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0)
      .map((log: any) => DATA_PUSH_IFACE.parseLog(log).args.dataTypeHash.toLowerCase());
  }

  async function deployFixture() {
    const [owner, user, feeReceiver] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACMF.deploy();

    const TokenF = await ethers.getContractFactory("MockERC20");
    const token = await TokenF.deploy("Mock USDC", "USDC", 18, ethers.parseUnits("1000000", 18));

    const VaultCoreMockF = await ethers.getContractFactory("MockVaultCore");
    const vaultCore = await VaultCoreMockF.deploy();

    const GuaranteeFundManagerF = await ethers.getContractFactory("GuaranteeFundManager");
    const gfm = await upgrades.deployProxy(
      GuaranteeFundManagerF,
      [vaultCore.target, registry.target, owner.address],
      { kind: "uups", initializer: "initialize" }
    );

    await registry.setModule(KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(KEY_ACCESS_CONTROL, acm.target);

    await vaultCore.setGuaranteeFundManager(gfm.target);

    await token.transfer(user.address, ethers.parseUnits("1000", 18));
    await token.connect(user).approve(gfm.target, ethers.parseUnits("1000", 18));

    return { owner, user, feeReceiver, registry, token, vaultCore, gfm };
  }

  it("lockGuarantee emits events + DataPush and updates custody", async function () {
    const { user, token, vaultCore, gfm } = await loadFixture(deployFixture);

    const amount = ethers.parseUnits("100", 18);

    const tx = await vaultCore.lockGuarantee(user.address, token.target, amount);
    const receipt = await tx.wait();

    await expect(tx)
      .to.emit(gfm, "GuaranteeLocked")
      .withArgs(user.address, token.target, amount, anyValue);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_GUARANTEE_LOCKED.toLowerCase());

    expect(await gfm.getLockedGuarantee(user.address, token.target)).to.equal(amount);
    expect(await token.balanceOf(gfm.target)).to.equal(amount);
  });

  it("releaseGuarantee refunds custody and emits DataPush", async function () {
    const { user, token, vaultCore, gfm } = await loadFixture(deployFixture);

    const amount = ethers.parseUnits("50", 18);

    await vaultCore.lockGuarantee(user.address, token.target, amount);

    const userBalBefore = await token.balanceOf(user.address);

    const tx = await vaultCore.releaseGuarantee(user.address, token.target, amount);
    const receipt = await tx.wait();

    await expect(tx)
      .to.emit(gfm, "GuaranteeReleased")
      .withArgs(user.address, token.target, amount, anyValue);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_GUARANTEE_RELEASED.toLowerCase());

    expect(await gfm.getLockedGuarantee(user.address, token.target)).to.equal(0n);
    expect(await token.balanceOf(user.address)).to.equal(userBalBefore + amount);
  });

  it("forfeitGuarantee transfers to receiver and emits DataPush", async function () {
    const { user, feeReceiver, token, vaultCore, gfm } = await loadFixture(deployFixture);

    const amount = ethers.parseUnits("80", 18);

    await vaultCore.lockGuarantee(user.address, token.target, amount);

    const receiverBalBefore = await token.balanceOf(feeReceiver.address);

    const tx = await vaultCore.forfeitGuarantee(user.address, token.target, feeReceiver.address);
    const receipt = await tx.wait();

    await expect(tx)
      .to.emit(gfm, "GuaranteeForfeited")
      .withArgs(user.address, token.target, amount, feeReceiver.address, anyValue);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_GUARANTEE_FORFEITED.toLowerCase());

    expect(await gfm.getLockedGuarantee(user.address, token.target)).to.equal(0n);
    expect(await token.balanceOf(feeReceiver.address)).to.equal(receiverBalBefore + amount);
  });
});
