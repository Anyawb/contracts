import { subtask } from 'hardhat/config';
import { TASK_COMPILE_SOLIDITY_LOG_COMPILATION_ERRORS } from 'hardhat/builtin-tasks/task-names';

// This repository uses `viaIR: true`. Some solc versions can emit a known noisy warning:
// "Warning: Unreachable code." attributed to OpenZeppelin ReentrancyGuard(ReentrancyGuardUpgradeable).
// This is a compiler-analysis artifact and is safe to ignore in our context.
//
// We filter ONLY this specific warning+file combination, and keep all other warnings/errors intact.

type SolcErrorLike = {
  type?: string;
  severity?: string;
  message?: string;
  formattedMessage?: string;
  sourceLocation?: { file?: string };
};

const OZ_REENTRANCY_FILES = new Set<string>([
  '@openzeppelin/contracts/security/ReentrancyGuard.sol',
  '@openzeppelin/contracts/utils/ReentrancyGuard.sol',
  '@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol',
  '@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol',
]);

function isKnownOZUnreachableWarning(e: SolcErrorLike): boolean {
  const severity = (e.severity ?? e.type ?? '').toLowerCase();
  if (severity !== 'warning') return false;

  const msg = e.message ?? '';
  const fmt = e.formattedMessage ?? '';
  const isUnreachable =
    msg === 'Unreachable code.' ||
    msg.includes('Unreachable code') ||
    fmt.startsWith('Warning: Unreachable code.');
  if (!isUnreachable) return false;

  const file = e.sourceLocation?.file ?? '';
  if (file && OZ_REENTRANCY_FILES.has(file)) return true;

  // Fallback: some toolchains only expose the path in formattedMessage.
  for (const ozFile of OZ_REENTRANCY_FILES) {
    if (fmt.includes(ozFile)) return true;
  }
  return false;
}

subtask(TASK_COMPILE_SOLIDITY_LOG_COMPILATION_ERRORS).setAction(async (args: any, hre, runSuper) => {
  const output = args?.output as { errors?: SolcErrorLike[] } | undefined;
  if (!output?.errors?.length) return runSuper(args);

  const before = output.errors.length;
  const filteredErrors = output.errors.filter((e) => !isKnownOZUnreachableWarning(e));
  const after = filteredErrors.length;

  if (after !== before) {
    // Avoid mutating Hardhat's output object in-place, to prevent surprising side effects.
    const nextArgs = {
      ...args,
      output: {
        ...output,
        errors: filteredErrors,
      },
    };
    return runSuper(nextArgs);
  }

  return runSuper(args);
});

