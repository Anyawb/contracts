import { ethers } from "hardhat";

/**
 * RewardConfig break-glass role helper (revocable).
 *
 * Role:
 * - ActionKeys.ACTION_REWARD_CONFIG_EMERGENCY == keccak256("ACTION_REWARD_CONFIG_EMERGENCY")
 *
 * Design goals:
 * - Idempotent grant/revoke (no RoleAlreadyGranted / RoleNotGranted reverts)
 * - Minimal assumptions about callers; scripts should ensure ACM owner signer is used.
 */

export function roleKeyRewardConfigEmergency(): string {
  return ethers.keccak256(ethers.toUtf8Bytes("ACTION_REWARD_CONFIG_EMERGENCY"));
}

export async function ensureRewardConfigEmergencyGranted(
  acm: any,
  grantee: string | undefined,
  log: (msg: string) => void = console.log
): Promise<void> {
  if (!grantee || grantee === ethers.ZeroAddress) return;
  const role = roleKeyRewardConfigEmergency();
  const has: boolean = await acm.hasRole(role, grantee);
  if (has) return;
  await (await acm.grantRole(role, grantee)).wait();
  log(`🧯 Granted ACTION_REWARD_CONFIG_EMERGENCY to ${grantee}`);
}

export async function ensureRewardConfigEmergencyRevoked(
  acm: any,
  grantee: string | undefined,
  log: (msg: string) => void = console.log
): Promise<void> {
  if (!grantee || grantee === ethers.ZeroAddress) return;
  const role = roleKeyRewardConfigEmergency();
  const has: boolean = await acm.hasRole(role, grantee);
  if (!has) return;
  await (await acm.revokeRole(role, grantee)).wait();
  log(`🧯 Revoked ACTION_REWARD_CONFIG_EMERGENCY from ${grantee}`);
}

