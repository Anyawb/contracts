import { ethers } from "hardhat";

import { envBool } from "../_addressResolver";
import { createFundsFlowLiveContext } from "./_fundsFlowLive";
import { ensureRoleForAccount, key } from "./_mockLiveUtils";
import { runWithNetworkRetry } from "./_networkRetry";

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live AccessControlView",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  if (!ctx.accessControlView || !ctx.accessControlViewAddr || ctx.accessControlViewAddr === ethers.ZeroAddress) {
    throw new Error("AccessControlView is not deployed or not registered");
  }

  const expectedAcm = (await ctx.acm.getAddress()) as string;
  const [acmAddr, registryAddr] = await Promise.all([
    ctx.accessControlView.getACM(),
    ctx.accessControlView.registryAddrVar(),
  ]);
  if (String(acmAddr).toLowerCase() !== expectedAcm.toLowerCase()) {
    throw new Error(`AccessControlView ACM mismatch: expected ${expectedAcm} got ${String(acmAddr)}`);
  }
  if (String(registryAddr).toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`AccessControlView registry mismatch: expected ${ctx.registryAddr} got ${String(registryAddr)}`);
  }

  const viewUserDataRole = key("VIEW_USER_DATA");
  const [selfPermission, selfPermissionValid, selfPermissionBlock] = await ctx.accessControlView
    .connect(ctx.borrower)
    .getUserPermissionWithMeta(ctx.borrower.address, viewUserDataRole) as [boolean, boolean, bigint];
  const [selfIsAdmin, selfAdminValid, selfAdminBlock] = await ctx.accessControlView
    .connect(ctx.borrower)
    .isUserAdminWithMeta(ctx.borrower.address) as [boolean, boolean, bigint];
  const [selfLevel, selfLevelValid, selfLevelBlock] = await ctx.accessControlView
    .connect(ctx.borrower)
    .getUserPermissionLevelWithMeta(ctx.borrower.address) as [number, boolean, bigint];

  console.log(
    `  [SelfRead] permission=${String(selfPermission)} valid=${String(selfPermissionValid)} block=${selfPermissionBlock.toString()} isAdmin=${String(selfIsAdmin)} adminValid=${String(selfAdminValid)} adminBlock=${selfAdminBlock.toString()} level=${String(selfLevel)} levelValid=${String(selfLevelValid)} levelBlock=${selfLevelBlock.toString()}`,
  );

  await expectRevert("AccessControlView non-self permission read should revert", async () =>
    ctx.accessControlView.connect(ctx.borrower).getUserPermissionWithMeta(ctx.lender.address, viewUserDataRole),
  );
  await expectRevert("AccessControlView non-self level read should revert", async () =>
    ctx.accessControlView.connect(ctx.borrower).getUserPermissionLevelWithMeta(ctx.lender.address),
  );
  await expectRevert("AccessControlView non-self admin read should revert", async () =>
    ctx.accessControlView.connect(ctx.borrower).isUserAdminWithMeta(ctx.lender.address),
  );

  const acmOwner = await ctx.acm.owner() as string;
  const autoGrantRuntimeRoles = envBool("LIVE_AUTO_GRANT_RUNTIME_ROLES", true);
  const relayerHasViewUserData = await ensureRoleForAccount({
    acm: ctx.acm,
    roleName: "VIEW_USER_DATA",
    account: ctx.relayer.address,
    granter: ctx.relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${ctx.relayer.address}`,
  });
  const reader = relayerHasViewUserData
    ? ctx.relayer
    : new ethers.VoidSigner(acmOwner, ethers.provider);

  const [opsPermission, opsPermissionValid, opsPermissionBlock] = await ctx.accessControlView
    .connect(reader)
    .getUserPermissionWithMeta(ctx.borrower.address, viewUserDataRole) as [boolean, boolean, bigint];
  const [opsIsAdmin, opsAdminValid, opsAdminBlock] = await ctx.accessControlView
    .connect(reader)
    .isUserAdminWithMeta(ctx.borrower.address) as [boolean, boolean, bigint];
  const [opsLevel, opsLevelValid, opsLevelBlock] = await ctx.accessControlView
    .connect(reader)
    .getUserPermissionLevelWithMeta(ctx.borrower.address) as [number, boolean, bigint];

  if (opsPermission !== selfPermission) {
    throw new Error("AccessControlView ops read permission bit mismatches self read");
  }
  if (opsIsAdmin !== selfIsAdmin) {
    throw new Error("AccessControlView ops read admin flag mismatches self read");
  }
  if (opsLevel !== selfLevel) {
    throw new Error("AccessControlView ops read permission level mismatches self read");
  }

  console.log(
    `  [OpsRead] permissionValid=${String(opsPermissionValid)} permissionBlock=${opsPermissionBlock.toString()} adminValid=${String(opsAdminValid)} adminBlock=${opsAdminBlock.toString()} levelValid=${String(opsLevelValid)} levelBlock=${opsLevelBlock.toString()}`,
  );

  console.log("\n✅ live-access-control-view-arbitrum-sepolia PASSED\n");
}

void runWithNetworkRetry("live-access-control-view-arbitrum-sepolia", main);