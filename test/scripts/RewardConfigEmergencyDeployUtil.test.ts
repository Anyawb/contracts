import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ensureRewardConfigEmergencyGranted,
  ensureRewardConfigEmergencyRevoked,
  roleKeyRewardConfigEmergency,
} from "../../scripts/deploy/utils/reward-config-emergency";

describe("deploy util - RewardConfig break-glass role", function () {
  it("computes the correct role key", async function () {
    expect(roleKeyRewardConfigEmergency()).to.equal(ethers.id("ACTION_REWARD_CONFIG_EMERGENCY"));
  });

  it("grant/revoke should be idempotent", async function () {
    const [governance, alice] = await ethers.getSigners();

    const AccessControlManager = await ethers.getContractFactory("AccessControlManager");
    const acm = await AccessControlManager.deploy(governance.address);
    await acm.waitForDeployment();

    const role = roleKeyRewardConfigEmergency();

    expect(await acm.hasRole(role, alice.address)).to.equal(false);

    await ensureRewardConfigEmergencyGranted(acm, alice.address, () => {});
    expect(await acm.hasRole(role, alice.address)).to.equal(true);

    // Grant again should not revert
    await ensureRewardConfigEmergencyGranted(acm, alice.address, () => {});
    expect(await acm.hasRole(role, alice.address)).to.equal(true);

    await ensureRewardConfigEmergencyRevoked(acm, alice.address, () => {});
    expect(await acm.hasRole(role, alice.address)).to.equal(false);

    // Revoke again should not revert
    await ensureRewardConfigEmergencyRevoked(acm, alice.address, () => {});
    expect(await acm.hasRole(role, alice.address)).to.equal(false);
  });
});

