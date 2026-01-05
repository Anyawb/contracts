import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("VaultBusinessLogic - liquidation entry is deprecated", function () {
  async function deployFixture() {
    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const settlementToken = await (await ethers.getContractFactory("MockERC20")).deploy("Settlement Token", "SET", 0);

    const VBL = await ethers.getContractFactory("VaultBusinessLogic");
    const vbl = await upgrades.deployProxy(VBL, [await registry.getAddress(), await settlementToken.getAddress()], {
      kind: "uups",
      initializer: "initialize",
      unsafeAllow: ["constructor"],
    });

    return { vbl };
  }

  it("VBL.liquidate should revert and force using LiquidationManager", async function () {
    const { vbl } = await loadFixture(deployFixture);

    await expect(vbl.liquidate(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 1n, 1n, 0n))
      .to.be.revertedWithCustomError(vbl, "VaultBusinessLogic__UseLiquidationManagerEntry");
  });
});

