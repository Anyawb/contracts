import hardhat from 'hardhat';

const { ethers } = hardhat;

/**
 * Reward write-entry SSOT (for tests/scripts).
 *
 * IMPORTANT (time semantics SSOT):
 * - `maturity` in `onLoanEventByOrder` is a **maturityBlock** (block number), NOT a timestamp in seconds.
 */
export const REWARD_ON_LOAN_EVENT_BY_ORDER_FULL_SIGNATURE =
  'onLoanEventByOrder(address,uint256,uint256,uint256,uint8)' as const;

/// @dev Baseline used across this repo (assumes ~12s/block). UI/keeper should map ETA offchain.
export const BLOCKS_PER_DAY = 7200n;

/**
 * Compute the 4-byte selector for a function signature.
 * Example: selectorFromSignature("foo(uint256)") => "0x2fbebd38"
 */
export function selectorFromSignature(signature: string): string {
  return ethers.id(signature).slice(0, 10);
}

/**
 * Helper for tests: produce a maturityBlock that is `days` in the future.
 * This avoids any timestamp-based accidental usage in tests.
 */
export async function maturityBlockAfterDays(days: bigint): Promise<bigint> {
  const now = await ethers.provider.getBlockNumber();
  return BigInt(now) + days * BLOCKS_PER_DAY;
}

