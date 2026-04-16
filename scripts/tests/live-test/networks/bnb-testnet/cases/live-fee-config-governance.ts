import { ethers } from "hardhat";

import { createFundsFlowLiveContext } from "../core/_fundsFlowLive";
import { key } from "../core/_mockLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

async function hasAnyRole(acm: any, address: string, names: string[]) {
  for (const name of names) {
    if ((await acm.hasRole(key(name), address)) as boolean) {
      return true;
    }
  }
  return false;
}

async function expectStaticRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function tryIdempotentWrite(label: string, preview: () => Promise<unknown>, write: () => Promise<any>) {
  try {
    await preview();
  } catch (error) {
    console.log(`  [Notice] skip ${label}: ${String((error as any)?.shortMessage ?? (error as any)?.message ?? error)}`);
    return false;
  }
  await (await write()).wait();
  return true;
}

async function pickUnauthorizedSigner(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>) {
  for (const signer of [ctx.lender, ctx.viewer, ctx.borrower]) {
    if (!signer) continue;
    if (String(signer.address).toLowerCase() === ctx.relayer.address.toLowerCase()) {
      continue;
    }
    const hasSetParameter = await hasAnyRole(ctx.acm, signer.address, ["ACTION_SET_PARAMETER", "SET_PARAMETER"]);
    const hasAdmin = await hasAnyRole(ctx.acm, signer.address, ["ACTION_ADMIN", "ADMIN"]);
    if (!hasSetParameter && !hasAdmin) {
      return signer;
    }
  }
  return null;
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Fee Config Governance",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  if (!ctx.feeRouterView) {
    throw new Error("FeeRouterView is not registered; fee governance architecture gate requires view cache alignment");
  }

  const feeTypeName = process.env.FEE_DYNAMIC_TYPE_NAME?.trim() || "LIVE_DYNAMIC_FEE_TEST";
  const feeType = ethers.keccak256(ethers.toUtf8Bytes(feeTypeName));
  const feeRouter = (await ethers.getContractAt(
    [
      "function getPlatformTreasury() view returns (address)",
      "function getEcosystemVault() view returns (address)",
      "function getPlatformFeeBps() view returns (uint256)",
      "function getEcosystemFeeBps() view returns (uint256)",
      "function getDynamicFee(address token,bytes32 feeType) view returns (uint256)",
      "function setFeeConfig(uint256 platformBps,uint256 ecosystemBps)",
      "function setTreasury(address platformTreasury,address ecosystemVault)",
      "function setDynamicFee(address token,bytes32 feeType,uint256 feeBps)",
    ],
    ctx.feeRouterAddr,
  )) as any;
  const feeRouterView = (await ethers.getContractAt(
    [
      "function getSupportedTokensWithMeta() view returns (address[] memory,uint256,bool)",
      "function getSystemConfigWithMeta() view returns ((address platformTreasury,address ecosystemVault,uint256 platformFeeBps,uint256 ecosystemFeeBps,address[] supportedTokens),uint256,bool)",
    ],
    ctx.feeRouterView.target,
    ctx.relayer,
  )) as any;

  const [
    platformTreasuryBefore,
    ecosystemVaultBefore,
    platformFeeBpsBefore,
    ecosystemFeeBpsBefore,
    dynamicFeeBefore,
    supportedTokensBeforeMeta,
  ] = await Promise.all([
    feeRouter.getPlatformTreasury(),
    feeRouter.getEcosystemVault(),
    feeRouter.getPlatformFeeBps(),
    feeRouter.getEcosystemFeeBps(),
    feeRouter.getDynamicFee(ctx.borrowAssetAddr, feeType),
    feeRouterView.getSupportedTokensWithMeta(),
  ]);
  const [supportedTokensBefore, supportedTokensBlockBefore, supportedTokensValidBefore] = supportedTokensBeforeMeta as [string[], bigint, boolean];
  if (!supportedTokensBefore.some((token) => token.toLowerCase() === ctx.borrowAssetAddr.toLowerCase())) {
    throw new Error(`FeeRouterView supported token set does not include borrow asset ${ctx.borrowAssetAddr}`);
  }
  if (!supportedTokensValidBefore) {
    console.log("  [Notice] FeeRouterView supported token cache is readable but marked stale before governance gate");
  }

  const unauthorizedSigner = await pickUnauthorizedSigner(ctx);
  if (unauthorizedSigner) {
    await expectStaticRevert("FeeRouter.setFeeConfig gate", () =>
      feeRouter.connect(unauthorizedSigner).setFeeConfig.staticCall(platformFeeBpsBefore, ecosystemFeeBpsBefore));
    await expectStaticRevert("FeeRouter.setTreasury gate", () =>
      feeRouter.connect(unauthorizedSigner).setTreasury.staticCall(platformTreasuryBefore, ecosystemVaultBefore));
    await expectStaticRevert("FeeRouter.setDynamicFee gate", () =>
      feeRouter.connect(unauthorizedSigner).setDynamicFee.staticCall(ctx.borrowAssetAddr, feeType, dynamicFeeBefore));
  } else {
    console.log("  [Notice] no distinct unauthorized signer found; skipping negative caller-gate coverage for fee governance");
  }

  const hasSetParameter = await hasAnyRole(ctx.acm, ctx.relayer.address, ["ACTION_SET_PARAMETER", "SET_PARAMETER"]);
  const hasAdmin = await hasAnyRole(ctx.acm, ctx.relayer.address, ["ACTION_ADMIN", "ADMIN"]);

  let configBefore: any = null;
  let configBlockBefore = 0n;
  if (hasAdmin) {
    const [config, blockNumber, isValid] = (await feeRouterView.getSystemConfigWithMeta()) as [any, bigint, boolean];
    configBefore = config;
    configBlockBefore = blockNumber;
    if (!isValid) {
      console.log("  [Notice] FeeRouterView system config cache is readable but marked stale before governance gate");
    }
  }

  if (!hasSetParameter) {
    console.log(`  [Notice] relayer ${ctx.relayer.address} lacks ACTION_SET_PARAMETER; governance coverage is limited to negative caller-gate checks`);
    logLiveScriptSuccess(__filename);
    return;
  }

  const wroteFeeConfig = await tryIdempotentWrite(
    "FeeRouter.setFeeConfig idempotent write",
    () => feeRouter.connect(ctx.relayer).setFeeConfig.staticCall(platformFeeBpsBefore, ecosystemFeeBpsBefore),
    () => feeRouter.connect(ctx.relayer).setFeeConfig(platformFeeBpsBefore, ecosystemFeeBpsBefore),
  );
  const wroteTreasury = await tryIdempotentWrite(
    "FeeRouter.setTreasury idempotent write",
    () => feeRouter.connect(ctx.relayer).setTreasury.staticCall(platformTreasuryBefore, ecosystemVaultBefore),
    () => feeRouter.connect(ctx.relayer).setTreasury(platformTreasuryBefore, ecosystemVaultBefore),
  );
  const wroteDynamic = await tryIdempotentWrite(
    "FeeRouter.setDynamicFee idempotent write",
    () => feeRouter.connect(ctx.relayer).setDynamicFee.staticCall(ctx.borrowAssetAddr, feeType, dynamicFeeBefore),
    () => feeRouter.connect(ctx.relayer).setDynamicFee(ctx.borrowAssetAddr, feeType, dynamicFeeBefore),
  );

  const [
    platformTreasuryAfter,
    ecosystemVaultAfter,
    platformFeeBpsAfter,
    ecosystemFeeBpsAfter,
    dynamicFeeAfter,
    supportedTokensAfterMeta,
  ] = await Promise.all([
    feeRouter.getPlatformTreasury(),
    feeRouter.getEcosystemVault(),
    feeRouter.getPlatformFeeBps(),
    feeRouter.getEcosystemFeeBps(),
    feeRouter.getDynamicFee(ctx.borrowAssetAddr, feeType),
    feeRouterView.getSupportedTokensWithMeta(),
  ]);
  const [supportedTokensAfter, supportedTokensBlockAfter, supportedTokensValidAfter] = supportedTokensAfterMeta as [string[], bigint, boolean];

  if (platformTreasuryAfter.toLowerCase() !== String(platformTreasuryBefore).toLowerCase()) {
    throw new Error("platform treasury changed after idempotent governance write");
  }
  if (ecosystemVaultAfter.toLowerCase() !== String(ecosystemVaultBefore).toLowerCase()) {
    throw new Error("ecosystem vault changed after idempotent governance write");
  }
  if (platformFeeBpsAfter !== platformFeeBpsBefore || ecosystemFeeBpsAfter !== ecosystemFeeBpsBefore) {
    throw new Error("fixed fee config changed after idempotent governance write");
  }
  if (dynamicFeeAfter !== dynamicFeeBefore) {
    throw new Error("dynamic fee changed after idempotent governance write");
  }
  if (supportedTokensAfter.length !== supportedTokensBefore.length) {
    throw new Error("FeeRouterView supported token list length changed after idempotent governance write");
  }
  for (const token of supportedTokensBefore) {
    if (!supportedTokensAfter.some((entry) => entry.toLowerCase() === token.toLowerCase())) {
      throw new Error(`FeeRouterView supported token disappeared after governance write: ${token}`);
    }
  }
  if (!supportedTokensValidAfter) {
    console.log("  [Notice] FeeRouterView supported token cache is readable but marked stale after governance gate");
  }
  if ((wroteFeeConfig || wroteTreasury || wroteDynamic) && supportedTokensBlockAfter < supportedTokensBlockBefore) {
    throw new Error("FeeRouterView supported token cache block regressed after governance write");
  }

  if (hasAdmin) {
    const [configAfter, configBlockAfter, configValidAfter] = (await feeRouterView.getSystemConfigWithMeta()) as [any, bigint, boolean];
    if (String(configAfter.platformTreasury ?? configAfter[0]).toLowerCase() !== String(platformTreasuryBefore).toLowerCase()) {
      throw new Error("FeeRouterView platform treasury drifted after governance write");
    }
    if (String(configAfter.ecosystemVault ?? configAfter[1]).toLowerCase() !== String(ecosystemVaultBefore).toLowerCase()) {
      throw new Error("FeeRouterView ecosystem vault drifted after governance write");
    }
    if (BigInt(configAfter.platformFeeBps ?? configAfter[2] ?? 0) !== platformFeeBpsBefore) {
      throw new Error("FeeRouterView platform fee bps drifted after governance write");
    }
    if (BigInt(configAfter.ecosystemFeeBps ?? configAfter[3] ?? 0) !== ecosystemFeeBpsBefore) {
      throw new Error("FeeRouterView ecosystem fee bps drifted after governance write");
    }
    const configTokensBefore = Array.from((configBefore?.supportedTokens ?? configBefore?.[4] ?? []) as string[]);
    const configTokensAfter = Array.from((configAfter.supportedTokens ?? configAfter[4] ?? []) as string[]);
    if (configTokensBefore.length !== configTokensAfter.length) {
      throw new Error("FeeRouterView system config token list length drifted after governance write");
    }
    for (const token of configTokensBefore) {
      if (!configTokensAfter.some((entry) => entry.toLowerCase() === token.toLowerCase())) {
        throw new Error(`FeeRouterView system config token disappeared after governance write: ${token}`);
      }
    }
    if ((wroteFeeConfig || wroteTreasury || wroteDynamic) && configBlockAfter < configBlockBefore) {
      throw new Error("FeeRouterView system config block regressed after governance write");
    }
    if (!configValidAfter) {
      console.log("  [Notice] FeeRouterView system config cache is readable but marked stale after governance gate");
    }
  } else {
    console.log(`  [Notice] relayer ${ctx.relayer.address} lacks ACTION_ADMIN; FeeRouterView admin cache alignment checks skipped`);
  }

  console.log(
    `  [FeeGovernance] hasSetParameter=${String(hasSetParameter)} hasAdmin=${String(hasAdmin)} unauthorizedSigner=${unauthorizedSigner?.address ?? "none"} feeType=${feeTypeName}`,
  );
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);