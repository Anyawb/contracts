import hardhat from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadAddressMap, resolveAddress } from "../../tests/_addressResolver";
import { refreshPriceOracleBlock } from "./price-oracle-refresh";

const { ethers, network } = hardhat;
const coder = ethers.AbiCoder.defaultAbiCoder();

// Blocks-only rollout smoke intentionally mirrors the current on-chain product, not the target product matrix.
// Keep these typed-data schemas, role assumptions, and settlement expectations aligned with the dedicated
// BlocksOnlyCoordinator / BlocksOnlyView path:
// - termBlocks is the only blocks-only duration field
// - current product constraints are termBlocks == 1 and rateBps == 0
// - asset admission still depends on the global AssetWhitelist rather than a dedicated product registry
const BORROW_INTENT_TYPES = {
  BorrowIntentBlocks: [
    { name: "borrower", type: "address" },
    { name: "collateralAsset", type: "address" },
    { name: "collateralAmount", type: "uint256" },
    { name: "borrowAsset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "termBlocks", type: "uint256" },
    { name: "rateBps", type: "uint256" },
    { name: "expireAt", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const LEND_INTENT_TYPES = {
  LendIntentBlocks: [
    { name: "lenderSigner", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minTermBlocks", type: "uint256" },
    { name: "maxTermBlocks", type: "uint256" },
    { name: "minRateBps", type: "uint256" },
    { name: "expireAt", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const DATA_PUSH_TOPIC0 = ethers
  .keccak256(ethers.toUtf8Bytes("DataPushed(bytes32,bytes)"))
  .toLowerCase();
const DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED = ethers
  .keccak256(ethers.toUtf8Bytes("BLOCKS_ONLY_MATCH_FINALIZED"))
  .toLowerCase();
const DATA_TYPE_BLOCKS_ONLY_REPAID = ethers
  .keccak256(ethers.toUtf8Bytes("BLOCKS_ONLY_REPAID"))
  .toLowerCase();
const DATA_TYPE_BLOCKS_ONLY_SETTLED = ethers
  .keccak256(ethers.toUtf8Bytes("BLOCKS_ONLY_SETTLED"))
  .toLowerCase();
const DATA_TYPE_BLOCKS_ONLY_LIQUIDATED = ethers
  .keccak256(ethers.toUtf8Bytes("BLOCKS_ONLY_LIQUIDATED"))
  .toLowerCase();
const MISSING_ROLE_SELECTOR = ethers
  .id("MissingRole()")
  .slice(0, 10)
  .toLowerCase();

type SmokeSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

export type BlocksOnlyRolloutSmokeSummary = {
  deployment: {
    registry: string;
    blocksOnlyCoordinator: string;
    blocksOnlyView: string;
    vaultBusinessLogic: string;
    vaultCore: string;
    collateralManager: string;
    lendingEngine: string;
    lenderPoolVault: string;
    asset: string;
  };
  actors: {
    deployer: string;
    keeper: string;
    lender: string;
    borrower: string;
    liquidationBorrower: string;
  };
  orderIds: {
    repayAndSettle: string;
    liquidation: string;
  };
  checkpoints: {
    repayAndSettle: Record<string, string | boolean>;
    liquidation: Record<string, string | boolean>;
  };
  preflight: Record<string, boolean>;
  dataPushCounts: Record<string, number>;
  dataPushPayloadChecks: Record<string, Record<string, string | boolean>>;
  artifactPath?: string;
};

type RunBlocksOnlyRolloutSmokeOptions = {
  keeper?: SmokeSigner;
  borrower?: SmokeSigner;
  lender?: SmokeSigner;
  liquidationBorrower?: SmokeSigner;
  excludedAddresses?: string[];
  label?: string;
  writeArtifact?: boolean;
  artifactTag?: string;
  useSnapshot?: boolean;
  printSummary?: boolean;
  strictRolePreflight?: boolean;
  strictDataPushPayloads?: boolean;
};

function key(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function decodeJsonBigInt(_key: string, value: any) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function assertHasCode(addr: string, label: string) {
  const code = await ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    throw new Error(
      [
        `[BlocksOnlySmoke] ${label} has no bytecode at ${addr}`,
        "Local rollout appears stale or incomplete.",
        "Fix: LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s exec hardhat run scripts/deploy/deploylocal.ts --network localhost",
      ].join("\n"),
    );
  }
}

async function waitTx<T extends { hash?: string; wait: () => Promise<any> }>(
  txPromise: Promise<T>,
  label: string,
) {
  const tx = await txPromise;
  console.log(`  ⛓️ tx ${label}: ${tx.hash ?? "unknown"}`);
  return await tx.wait();
}

function extractDataPushTypes(receipt: any): string[] {
  const out = extractDataPushed(receipt);
  return out.map((entry) => entry.dataTypeHash);
}

function extractDataPushed(
  receipt: any,
  emitter?: string,
): Array<{ dataTypeHash: string; payload: string }> {
  const out: Array<{ dataTypeHash: string; payload: string }> = [];
  for (const log of receipt?.logs || []) {
    const topic0 = String(log?.topics?.[0] || "").toLowerCase();
    if (topic0 !== DATA_PUSH_TOPIC0) continue;
    if (
      emitter &&
      String(log?.address || "").toLowerCase() !== emitter.toLowerCase()
    ) {
      continue;
    }
    if (log.topics.length >= 2) {
      const [payload] = coder.decode(["bytes"], log.data) as [string];
      out.push({
        dataTypeHash: String(log.topics[1]).toLowerCase(),
        payload,
      });
      continue;
    }
    const [dataTypeHash, payload] = coder.decode(
      ["bytes32", "bytes"],
      log.data,
    ) as [string, string];
    out.push({ dataTypeHash: String(dataTypeHash).toLowerCase(), payload });
  }
  return out;
}

function getLastDataPushPayload(
  receipt: any,
  want: string,
  emitter?: string,
): string | undefined {
  const matched = extractDataPushed(receipt, emitter)
    .filter((entry) => entry.dataTypeHash === want.toLowerCase())
    .map((entry) => entry.payload);
  return matched.length > 0 ? matched[matched.length - 1] : undefined;
}

function assertDataPushType(
  label: string,
  receipt: any,
  want: string,
  emitter?: string,
) {
  const types = extractDataPushed(receipt, emitter).map(
    (entry) => entry.dataTypeHash,
  );
  if (!types.includes(want.toLowerCase())) {
    throw new Error(`${label}: missing DataPushed(${want})`);
  }
}

function roleHash(roleName: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(roleName)).toLowerCase();
}

async function getAccessControl(registry: any) {
  const accessControlAddr = await registry.getModuleOrRevert(
    key("ACCESS_CONTROL_MANAGER"),
  );
  return (await ethers.getContractAt(
    "AccessControlManager",
    accessControlAddr,
  )) as any;
}

async function hasNamedRole(
  accessControl: any,
  roleName: string,
  account: string,
): Promise<boolean> {
  return Boolean(await accessControl.hasRole(roleHash(roleName), account));
}

function assertAddressEq(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${label}: address mismatch expected=${expected} actual=${actual}`,
    );
  }
}

function assertBigintEq(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) {
    throw new Error(`${label}: mismatch expected=${expected} actual=${actual}`);
  }
}

async function expectMissingRole(
  label: string,
  action: () => Promise<unknown>,
) {
  try {
    await action();
  } catch (error: any) {
    const raw =
      typeof error?.data === "string"
        ? error.data
        : typeof error?.reason === "string"
          ? error.reason
          : typeof error?.message === "string"
            ? error.message
            : String(error);
    const lowered = String(raw).toLowerCase();
    if (
      lowered.includes("missingrole") ||
      lowered.includes(MISSING_ROLE_SELECTOR)
    ) {
      return;
    }
    throw new Error(
      `[BlocksOnlySmoke] ${label} reverted, but not with MissingRole(): ${raw}`,
    );
  }
  throw new Error(
    `[BlocksOnlySmoke] ${label} should have reverted with MissingRole()`,
  );
}

function auditMatchFinalizedPayload(params: {
  label: string;
  payload: string;
  coordinator: string;
  orderId: bigint;
  borrower: string;
  lender: string;
  asset: string;
  principal: bigint;
  termBlocks: bigint;
  txBlockNumber: bigint;
}): Record<string, string | boolean> {
  const [
    coordinator,
    orderId,
    borrower,
    lender,
    asset,
    principal,
    termBlocks,
    startBlock,
    maturityBlock,
  ] = coder.decode(
    [
      "address",
      "uint256",
      "address",
      "address",
      "address",
      "uint256",
      "uint256",
      "uint256",
      "uint256",
    ],
    params.payload,
  ) as [string, bigint, string, string, string, bigint, bigint, bigint, bigint];
  assertAddressEq(
    `${params.label}.coordinator`,
    coordinator,
    params.coordinator,
  );
  assertBigintEq(`${params.label}.orderId`, orderId, params.orderId);
  assertAddressEq(`${params.label}.borrower`, borrower, params.borrower);
  assertAddressEq(`${params.label}.lender`, lender, params.lender);
  assertAddressEq(`${params.label}.asset`, asset, params.asset);
  assertBigintEq(`${params.label}.principal`, principal, params.principal);
  assertBigintEq(`${params.label}.termBlocks`, termBlocks, params.termBlocks);
  assertBigintEq(
    `${params.label}.startBlock`,
    startBlock,
    params.txBlockNumber,
  );
  assertBigintEq(
    `${params.label}.maturityBlock`,
    maturityBlock,
    params.txBlockNumber + params.termBlocks,
  );
  return {
    ok: true,
    orderId: orderId.toString(),
    startBlock: startBlock.toString(),
    maturityBlock: maturityBlock.toString(),
  };
}

function auditRepaidPayload(params: {
  label: string;
  payload: string;
  coordinator: string;
  orderId: bigint;
  payer: string;
  borrower: string;
  asset: string;
  repayAmount: bigint;
  remainingDebt: bigint;
  txBlockNumber: bigint;
}): Record<string, string | boolean> {
  const [
    coordinator,
    orderId,
    payer,
    borrower,
    asset,
    repayAmount,
    remainingDebt,
    blockNumber,
  ] = coder.decode(
    [
      "address",
      "uint256",
      "address",
      "address",
      "address",
      "uint256",
      "uint256",
      "uint256",
    ],
    params.payload,
  ) as [string, bigint, string, string, string, bigint, bigint, bigint];
  assertAddressEq(
    `${params.label}.coordinator`,
    coordinator,
    params.coordinator,
  );
  assertBigintEq(`${params.label}.orderId`, orderId, params.orderId);
  assertAddressEq(`${params.label}.payer`, payer, params.payer);
  assertAddressEq(`${params.label}.borrower`, borrower, params.borrower);
  assertAddressEq(`${params.label}.asset`, asset, params.asset);
  assertBigintEq(
    `${params.label}.repayAmount`,
    repayAmount,
    params.repayAmount,
  );
  assertBigintEq(
    `${params.label}.remainingDebt`,
    remainingDebt,
    params.remainingDebt,
  );
  assertBigintEq(
    `${params.label}.blockNumber`,
    blockNumber,
    params.txBlockNumber,
  );
  return {
    ok: true,
    orderId: orderId.toString(),
    repayAmount: repayAmount.toString(),
    remainingDebt: remainingDebt.toString(),
    blockNumber: blockNumber.toString(),
  };
}

function auditSettledPayload(params: {
  label: string;
  payload: string;
  coordinator: string;
  orderId: bigint;
  borrower: string;
  asset: string;
  closeBlock: bigint;
}): Record<string, string | boolean> {
  const [coordinator, orderId, borrower, asset, closeBlock] = coder.decode(
    ["address", "uint256", "address", "address", "uint256"],
    params.payload,
  ) as [string, bigint, string, string, bigint];
  assertAddressEq(
    `${params.label}.coordinator`,
    coordinator,
    params.coordinator,
  );
  assertBigintEq(`${params.label}.orderId`, orderId, params.orderId);
  assertAddressEq(`${params.label}.borrower`, borrower, params.borrower);
  assertAddressEq(`${params.label}.asset`, asset, params.asset);
  assertBigintEq(`${params.label}.closeBlock`, closeBlock, params.closeBlock);
  return {
    ok: true,
    orderId: orderId.toString(),
    closeBlock: closeBlock.toString(),
  };
}

function auditLiquidatedPayload(params: {
  label: string;
  payload: string;
  coordinator: string;
  orderId: bigint;
  borrower: string;
  asset: string;
  liquidator: string;
  collateralAsset: string;
  collateralAmount: bigint;
  debtAmount: bigint;
  closeBlock: bigint;
}): Record<string, string | boolean> {
  const [
    coordinator,
    orderId,
    borrower,
    asset,
    liquidator,
    collateralAsset,
    collateralAmount,
    debtAmount,
    closeBlock,
  ] = coder.decode(
    [
      "address",
      "uint256",
      "address",
      "address",
      "address",
      "address",
      "uint256",
      "uint256",
      "uint256",
    ],
    params.payload,
  ) as [string, bigint, string, string, string, string, bigint, bigint, bigint];
  assertAddressEq(
    `${params.label}.coordinator`,
    coordinator,
    params.coordinator,
  );
  assertBigintEq(`${params.label}.orderId`, orderId, params.orderId);
  assertAddressEq(`${params.label}.borrower`, borrower, params.borrower);
  assertAddressEq(`${params.label}.asset`, asset, params.asset);
  assertAddressEq(`${params.label}.liquidator`, liquidator, params.liquidator);
  assertAddressEq(
    `${params.label}.collateralAsset`,
    collateralAsset,
    params.collateralAsset,
  );
  assertBigintEq(
    `${params.label}.collateralAmount`,
    collateralAmount,
    params.collateralAmount,
  );
  assertBigintEq(`${params.label}.debtAmount`, debtAmount, params.debtAmount);
  assertBigintEq(`${params.label}.closeBlock`, closeBlock, params.closeBlock);
  return {
    ok: true,
    orderId: orderId.toString(),
    collateralAmount: collateralAmount.toString(),
    debtAmount: debtAmount.toString(),
    closeBlock: closeBlock.toString(),
  };
}

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (_error) {
    return;
  }
  throw new Error(`[BlocksOnlySmoke] ${label} should have reverted`);
}

async function chooseFreshSigners(excluded: string[]): Promise<{
  borrower: SmokeSigner;
  lender: SmokeSigner;
  liquidationBorrower: SmokeSigner;
}> {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const taken = new Set([
    deployer.address.toLowerCase(),
    ...excluded.map((x) => x.toLowerCase()),
  ]);
  const candidates = signers.filter((s) => !taken.has(s.address.toLowerCase()));
  if (candidates.length < 3) {
    throw new Error(
      "[BlocksOnlySmoke] not enough free signers for borrower/lender/liquidationBorrower",
    );
  }
  return {
    borrower: candidates[0],
    lender: candidates[1],
    liquidationBorrower: candidates[2],
  };
}

async function findKeeperSigner(params: {
  accessControl: any;
  preferred?: SmokeSigner;
  strictRolePreflight: boolean;
}): Promise<{ keeper: SmokeSigner; hasActionLiquidate: boolean }> {
  if (params.preferred) {
    return {
      keeper: params.preferred,
      hasActionLiquidate: await hasNamedRole(
        params.accessControl,
        "LIQUIDATE",
        params.preferred.address,
      ),
    };
  }

  const signers = await ethers.getSigners();
  for (const signer of signers) {
    if (await hasNamedRole(params.accessControl, "LIQUIDATE", signer.address)) {
      return { keeper: signer, hasActionLiquidate: true };
    }
  }

  return {
    keeper: signers[0],
    hasActionLiquidate: await hasNamedRole(
      params.accessControl,
      "LIQUIDATE",
      signers[0].address,
    ),
  };
}

async function findUnauthorizedSigner(params: {
  accessControl: any;
  excludedAddresses: string[];
}): Promise<SmokeSigner> {
  const excluded = new Set(
    params.excludedAddresses.map((addr) => addr.toLowerCase()),
  );
  const signers = await ethers.getSigners();
  for (const signer of signers) {
    if (excluded.has(signer.address.toLowerCase())) continue;
    if (!(await hasNamedRole(params.accessControl, "LIQUIDATE", signer.address))) {
      return signer;
    }
  }
  throw new Error(
    "[BlocksOnlySmoke] could not find an unauthorized signer without ACTION_LIQUIDATE for MissingRole() preflight",
  );
}

async function buildBlocksOnlyMatch(params: {
  vblAddr: string;
  borrower: SmokeSigner;
  lender: SmokeSigner;
  asset: string;
  principal: bigint;
  collateralAmount: bigint;
  saltPrefix: string;
}) {
  // Typed-data field order must remain byte-for-byte aligned with SettlementIntentLib.hashBorrowIntentBlocks /
  // hashLendIntentBlocks. This helper intentionally builds only the currently supported one-block, zero-rate product
  // so rollout smoke cannot accidentally drift ahead of the chain-side coordinator constraints.
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const expireAt = BigInt((await ethers.provider.getBlockNumber()) + 10_000);
  const domain = {
    name: "RwaLending",
    version: "1",
    chainId,
    verifyingContract: params.vblAddr,
  } as const;

  const borrowIntent = {
    borrower: params.borrower.address,
    collateralAsset: params.asset,
    collateralAmount: params.collateralAmount,
    borrowAsset: params.asset,
    amount: params.principal,
    termBlocks: 1n,
    rateBps: 0n,
    expireAt,
    salt: ethers.keccak256(
      ethers.toUtf8Bytes(
        `${params.saltPrefix}-borrow-${params.borrower.address}`,
      ),
    ),
  };

  const lendIntent = {
    lenderSigner: params.lender.address,
    asset: params.asset,
    amount: params.principal,
    minTermBlocks: 1n,
    maxTermBlocks: 1n,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(
      ethers.toUtf8Bytes(`${params.saltPrefix}-lend-${params.lender.address}`),
    ),
  };

  const lendIntentHash = ethers.TypedDataEncoder.hashStruct(
    "LendIntentBlocks",
    LEND_INTENT_TYPES,
    lendIntent,
  );
  const sigBorrower = await params.borrower.signTypedData(
    domain,
    BORROW_INTENT_TYPES,
    borrowIntent,
  );
  const sigLender = await params.lender.signTypedData(
    domain,
    LEND_INTENT_TYPES,
    lendIntent,
  );

  return { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender };
}

async function whitelistParticipants(
  registry: any,
  deployer: SmokeSigner,
  users: string[],
) {
  const whitelistRegistryAddr = await registry.getModuleOrRevert(
    key("WHITELIST_REGISTRY"),
  );
  const whitelistRegistry = (await ethers.getContractAt(
    "WhitelistRegistry",
    whitelistRegistryAddr,
  )) as any;
  const missing: string[] = [];
  for (const user of users) {
    if (!(await whitelistRegistry.isWhitelisted(user))) missing.push(user);
  }
  if (missing.length === 1) {
    await waitTx(
      whitelistRegistry.connect(deployer).addAddress(missing[0]),
      "whitelist addAddress",
    );
  } else if (missing.length > 1) {
    await waitTx(
      whitelistRegistry.connect(deployer).batchAddAddresses(missing),
      "whitelist batchAddAddresses",
    );
  }
}

async function ensureAssetAllowed(
  registry: any,
  deployer: SmokeSigner,
  asset: string,
) {
  const assetWhitelistAddr = await registry.getModuleOrRevert(
    key("ASSET_WHITELIST"),
  );
  const assetWhitelist = (await ethers.getContractAt(
    "AssetWhitelist",
    assetWhitelistAddr,
  )) as any;
  if (!(await assetWhitelist.isAssetAllowed(asset))) {
    await waitTx(
      assetWhitelist.connect(deployer).addAllowedAsset(asset),
      "add settlement token to asset whitelist",
    );
  }
}

async function ensureActionRole(
  registry: any,
  signer: SmokeSigner,
  roleName: string,
) {
  const accessControlAddr = await registry.getModuleOrRevert(
    key("ACCESS_CONTROL_MANAGER"),
  );
  const accessControl = (await ethers.getContractAt(
    "AccessControlManager",
    accessControlAddr,
  )) as any;
  const role = ethers.keccak256(ethers.toUtf8Bytes(roleName));
  if (!(await accessControl.hasRole(role, signer.address))) {
    await waitTx(
      accessControl.connect(signer).grantRole(role, signer.address),
      `grant ${roleName} to smoke signer`,
    );
  }
}

async function ensureOracleAssetReady(params: {
  registry: any;
  priceOracle: any;
  asset: string;
  signer: SmokeSigner;
}) {
  await ensureActionRole(params.registry, params.signer, "UPDATE_PRICE");

  let isActive = false;
  try {
    const config = await params.priceOracle.getAssetConfig(params.asset);
    isActive = Boolean((config as any).isActive ?? config?.[0]);
  } catch {
    isActive = false;
  }

  if (!isActive) {
    const erc20 = new ethers.Contract(
      params.asset,
      ["function decimals() view returns (uint8)"],
      params.signer,
    );
    const assetDecimals = Number(await erc20.decimals());
    await waitTx(
      params.priceOracle
        .connect(params.signer)
        [
          "configureAsset(address,string,uint256,uint256)"
        ](params.asset, "usd-coin", assetDecimals, 10_000),
      "configure PriceOracle asset",
    );
  }

  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  await waitTx(
    params.priceOracle
      .connect(params.signer)
      .updatePrice(params.asset, ethers.parseUnits("1", 8), currentBlock),
    "prime PriceOracle asset price",
  );
}

function writeArtifact(tag: string, data: unknown): string {
  const outDir = path.join(__dirname, "..", "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `blocks-only-rollout-smoke.${tag}.${Date.now()}.json`,
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(data, decodeJsonBigInt, 2) + "\n",
    "utf8",
  );
  return outPath;
}

export async function runBlocksOnlyRolloutSmoke(
  opts?: RunBlocksOnlyRolloutSmokeOptions,
): Promise<BlocksOnlyRolloutSmokeSummary> {
  // This smoke is the closest thing to a blocks-only integration/indexer harness in the current repo.
  // It verifies the external contract-consumer assumptions that front-end, keeper, and future indexer services rely
  // on today: Registry resolution, typed-data compatibility, DataPush emission, and BlocksOnlyView runtime reads.
  const label = opts?.label ?? "Blocks-only rollout smoke";
  const useSnapshot = opts?.useSnapshot !== false;
  const printSummary = opts?.printSummary !== false;
  const strictRolePreflight = opts?.strictRolePreflight === true;
  const strictDataPushPayloads =
    opts?.strictDataPushPayloads === true ||
    process.env.E2E_STRICT_DATAPUSH === "1";
  const snap = useSnapshot
    ? await network.provider.send("evm_snapshot", [])
    : null;

  try {
    console.log(`=== ${label} ===`);
    console.log(
      `Config: strictRolePreflight=${strictRolePreflight} strictDataPushPayloads=${strictDataPushPayloads}`,
    );
    const addressMap = loadAddressMap("localhost");
    const registryAddr = resolveAddress({
      name: "Registry",
      map: addressMap,
      envVar: "REGISTRY_ADDRESS",
    });
    await assertHasCode(registryAddr, "Registry");

    const registry = (await ethers.getContractAt(
      "Registry",
      registryAddr,
    )) as any;
    const deployment = {
      registry: registryAddr,
      blocksOnlyCoordinator: String(
        await registry.getModuleOrRevert(key("BLOCKS_ONLY_COORDINATOR")),
      ),
      blocksOnlyView: String(
        await registry.getModuleOrRevert(key("BLOCKS_ONLY_VIEW")),
      ),
      vaultBusinessLogic: String(
        await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC")),
      ),
      vaultCore: String(await registry.getModuleOrRevert(key("VAULT_CORE"))),
      collateralManager: String(
        await registry.getModuleOrRevert(key("COLLATERAL_MANAGER")),
      ),
      lendingEngine: String(
        await registry.getModuleOrRevert(key("LENDING_ENGINE")),
      ),
      lenderPoolVault: String(
        await registry.getModuleOrRevert(key("LENDER_POOL_VAULT")),
      ),
      asset: String(await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))),
    };

    for (const [name, addr] of Object.entries(deployment)) {
      await assertHasCode(addr, name);
    }

    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const accessControl = await getAccessControl(registry);
    const keeperSelection = await findKeeperSigner({
      accessControl,
      preferred: opts?.keeper,
      strictRolePreflight,
    });
    const keeper = keeperSelection.keeper;
    const chosen =
      opts?.borrower && opts?.lender && opts?.liquidationBorrower
        ? {
            borrower: opts.borrower,
            lender: opts.lender,
            liquidationBorrower: opts.liquidationBorrower,
          }
        : await chooseFreshSigners([
            ...(opts?.excludedAddresses ?? []),
            keeper.address,
          ]);

    const { borrower, lender, liquidationBorrower } = chosen;
    const unauthorizedCaller = await findUnauthorizedSigner({
      accessControl,
      excludedAddresses: [
        deployer.address,
        keeper.address,
        borrower.address,
        lender.address,
        liquidationBorrower.address,
        ...(opts?.excludedAddresses ?? []),
      ],
    });
    const preflight: Record<string, boolean> = {
      keeperHasActionLiquidate: keeperSelection.hasActionLiquidate,
      coordinatorHasActionLiquidate: await hasNamedRole(
        accessControl,
        "LIQUIDATE",
        deployment.blocksOnlyCoordinator,
      ),
      coordinatorHasViewRiskData: await hasNamedRole(
        accessControl,
        "VIEW_RISK_DATA",
        deployment.blocksOnlyCoordinator,
      ),
      unauthorizedCallerRejected: false,
    };

    if (!preflight.coordinatorHasActionLiquidate) {
      throw new Error(
        "[BlocksOnlySmoke] BlocksOnlyCoordinator is missing ACTION_LIQUIDATE. Fix deploy role bindings before using this as a keeper/indexer gate.",
      );
    }
    if (!preflight.coordinatorHasViewRiskData) {
      throw new Error(
        "[BlocksOnlySmoke] BlocksOnlyCoordinator is missing VIEW_RISK_DATA. Fix deploy role bindings before using this as a keeper/indexer gate.",
      );
    }
    if (!preflight.keeperHasActionLiquidate) {
      if (strictRolePreflight) {
        throw new Error(
          `[BlocksOnlySmoke] keeper signer is missing ACTION_LIQUIDATE in strict preflight mode: ${keeper.address}`,
        );
      }
      await ensureActionRole(registry, keeper, "LIQUIDATE");
      preflight.keeperHasActionLiquidate = true;
    }

    await whitelistParticipants(registry, deployer, [
      borrower.address,
      lender.address,
      liquidationBorrower.address,
    ]);
    await ensureAssetAllowed(registry, deployer, deployment.asset);

    const priceOracleAddr = String(
      await registry.getModuleOrRevert(key("PRICE_ORACLE")),
    );
    const priceOracle = (await ethers.getContractAt(
      "src/core/PriceOracle.sol:PriceOracle",
      priceOracleAddr,
    )) as any;
    await ensureOracleAssetReady({
      registry,
      priceOracle,
      asset: deployment.asset,
      signer: deployer,
    });
    await refreshPriceOracleBlock({
      priceOracle,
      asset: deployment.asset,
      signer: deployer,
      label,
      print: true,
    });

    const usdc = (await ethers.getContractAt(
      "MockERC20",
      deployment.asset,
    )) as any;
    const vbl = (await ethers.getContractAt(
      "VaultBusinessLogic",
      deployment.vaultBusinessLogic,
    )) as any;
    const vaultCore = (await ethers.getContractAt(
      "VaultCore",
      deployment.vaultCore,
    )) as any;
    const cm = (await ethers.getContractAt(
      "CollateralManager",
      deployment.collateralManager,
    )) as any;
    const lendingEngine = (await ethers.getContractAt(
      "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
      deployment.lendingEngine,
    )) as any;
    const coordinator = (await ethers.getContractAt(
      "BlocksOnlyCoordinator",
      deployment.blocksOnlyCoordinator,
    )) as any;
    const blocksOnlyView = (await ethers.getContractAt(
      "BlocksOnlyView",
      deployment.blocksOnlyView,
    )) as any;

    const principal = ethers.parseUnits("500", 6);
    const collateralAmount = ethers.parseUnits("1000", 6);
    const reserveAmount = principal * 2n;
    const dataPushPayloadChecks: Record<
      string,
      Record<string, string | boolean>
    > = {};

    for (const user of [
      borrower.address,
      lender.address,
      liquidationBorrower.address,
    ]) {
      await waitTx(
        usdc.connect(deployer).transfer(user, ethers.parseUnits("5000", 6)),
        `fund ${user.slice(0, 10)}`,
      );
    }

    await waitTx(
      usdc
        .connect(borrower)
        .approve(deployment.collateralManager, ethers.MaxUint256),
      "approve borrower CM",
    );
    await waitTx(
      usdc
        .connect(liquidationBorrower)
        .approve(deployment.collateralManager, ethers.MaxUint256),
      "approve liqBorrower CM",
    );
    await waitTx(
      usdc
        .connect(lender)
        .approve(deployment.vaultBusinessLogic, ethers.MaxUint256),
      "approve lender VBL",
    );
    await waitTx(
      usdc
        .connect(borrower)
        .approve(deployment.blocksOnlyCoordinator, ethers.MaxUint256),
      "approve borrower coordinator",
    );

    await waitTx(
      vaultCore.connect(borrower).deposit(deployment.asset, collateralAmount),
      "deposit repay-settle collateral",
    );
    await waitTx(
      vaultCore
        .connect(liquidationBorrower)
        .deposit(deployment.asset, collateralAmount),
      "deposit liquidation collateral",
    );

    const borrowerCollateralAfterDeposit = (await cm.getCollateral(
      borrower.address,
      deployment.asset,
    )) as bigint;
    const liquidationCollateralAfterDeposit = (await cm.getCollateral(
      liquidationBorrower.address,
      deployment.asset,
    )) as bigint;
    if (
      borrowerCollateralAfterDeposit < collateralAmount ||
      liquidationCollateralAfterDeposit < collateralAmount
    ) {
      throw new Error(
        "[BlocksOnlySmoke] collateral deposit did not land in CollateralManager as expected",
      );
    }

    const countBefore = (await coordinator.getBlocksOnlyOrderCount()) as bigint;

    const repayMatch = await buildBlocksOnlyMatch({
      vblAddr: deployment.vaultBusinessLogic,
      borrower,
      lender,
      asset: deployment.asset,
      principal,
      collateralAmount,
      saltPrefix: "blocks-only-rollout-repay",
    });
    await waitTx(
      vbl
        .connect(lender)
        .reserveForLending(
          lender.address,
          deployment.asset,
          reserveAmount,
          repayMatch.lendIntentHash,
        ),
      "reserve repay-settle",
    );
    const finalizeRepayRc = await waitTx(
      vbl
        .connect(borrower)
        .finalizeMatchBlocks(
          repayMatch.borrowIntent,
          [repayMatch.lendIntent],
          repayMatch.sigBorrower,
          [repayMatch.sigLender],
        ),
      "finalizeMatchBlocks repay-settle",
    );
    assertDataPushType(
      "finalize repay-settle",
      finalizeRepayRc,
      DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED,
      deployment.blocksOnlyCoordinator,
    );
    const finalizeRepayPayload = getLastDataPushPayload(
      finalizeRepayRc,
      DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED,
      deployment.blocksOnlyCoordinator,
    );
    if (!finalizeRepayPayload) {
      throw new Error(
        "[BlocksOnlySmoke] missing finalized payload for repay flow",
      );
    }
    dataPushPayloadChecks.finalizeRepay = auditMatchFinalizedPayload({
      label: "finalizeRepay",
      payload: finalizeRepayPayload,
      coordinator: deployment.blocksOnlyCoordinator,
      orderId: countBefore,
      borrower: borrower.address,
      lender: deployment.lenderPoolVault,
      asset: deployment.asset,
      principal,
      termBlocks: 1n,
      txBlockNumber: BigInt(finalizeRepayRc.blockNumber),
    });

    const repayOrderId = countBefore;
    const repayRuntimeBefore = await blocksOnlyView
      .connect(borrower)
      .getBlocksOnlyOrder(repayOrderId);
    if (repayRuntimeBefore.remainingDebt !== principal) {
      throw new Error(
        `[BlocksOnlySmoke] repay order remainingDebt mismatch before repay: expected=${principal} actual=${repayRuntimeBefore.remainingDebt}`,
      );
    }

    await expectRevert(
      "premature settleOrLiquidateBlocks before maturity",
      async () => {
        await coordinator
          .connect(keeper)
          .settleOrLiquidateBlocks.staticCall(repayOrderId);
      },
    );
    preflight.prematureSettleRejected = true;

    const repayRc = await waitTx(
      coordinator.connect(borrower).repayBlocks(repayOrderId, principal),
      "repayBlocks",
    );
    assertDataPushType(
      "repayBlocks",
      repayRc,
      DATA_TYPE_BLOCKS_ONLY_REPAID,
      deployment.blocksOnlyCoordinator,
    );
    if (
      ((await lendingEngine.getDebt(
        borrower.address,
        deployment.asset,
      )) as bigint) !== 0n
    ) {
      throw new Error(
        "[BlocksOnlySmoke] debt should be zero after blocks-only repay",
      );
    }
    const repayPayload = getLastDataPushPayload(
      repayRc,
      DATA_TYPE_BLOCKS_ONLY_REPAID,
      deployment.blocksOnlyCoordinator,
    );
    if (!repayPayload) {
      throw new Error("[BlocksOnlySmoke] missing repayment payload");
    }
    dataPushPayloadChecks.repay = auditRepaidPayload({
      label: "repay",
      payload: repayPayload,
      coordinator: deployment.blocksOnlyCoordinator,
      orderId: repayOrderId,
      payer: borrower.address,
      borrower: borrower.address,
      asset: deployment.asset,
      repayAmount: principal,
      remainingDebt: 0n,
      txBlockNumber: BigInt(repayRc.blockNumber),
    });

    await network.provider.send("evm_mine", []);

    const repayRuntimeAtMaturity = await blocksOnlyView
      .connect(borrower)
      .getBlocksOnlyOrder(repayOrderId);
    if (
      !repayRuntimeAtMaturity.isMatured ||
      !repayRuntimeAtMaturity.canSettleOrLiquidate ||
      repayRuntimeAtMaturity.isClosed
    ) {
      throw new Error(
        "[BlocksOnlySmoke] matured repay-settle order should become settleable through BlocksOnlyView before closing",
      );
    }

    await expectMissingRole(
      "unauthorized settleOrLiquidateBlocks preflight",
      async () => {
        await coordinator
          .connect(unauthorizedCaller)
          .settleOrLiquidateBlocks.staticCall(repayOrderId);
      },
    );
    preflight.unauthorizedCallerRejected = true;

    const settleRc = await waitTx(
      coordinator.connect(keeper).settleOrLiquidateBlocks(repayOrderId),
      "settleOrLiquidateBlocks settle",
    );
    assertDataPushType(
      "settleOrLiquidateBlocks settle",
      settleRc,
      DATA_TYPE_BLOCKS_ONLY_SETTLED,
      deployment.blocksOnlyCoordinator,
    );
    const settlePayload = getLastDataPushPayload(
      settleRc,
      DATA_TYPE_BLOCKS_ONLY_SETTLED,
      deployment.blocksOnlyCoordinator,
    );
    if (!settlePayload) {
      throw new Error("[BlocksOnlySmoke] missing settled payload");
    }
    dataPushPayloadChecks.settle = auditSettledPayload({
      label: "settle",
      payload: settlePayload,
      coordinator: deployment.blocksOnlyCoordinator,
      orderId: repayOrderId,
      borrower: borrower.address,
      asset: deployment.asset,
      closeBlock: BigInt(settleRc.blockNumber),
    });
    const repayRuntimeAfter = await blocksOnlyView
      .connect(borrower)
      .getBlocksOnlyOrder(repayOrderId);
    if (
      !repayRuntimeAfter.isClosed ||
      repayRuntimeAfter.remainingDebt !== 0n ||
      repayRuntimeAfter.status !== 3n
    ) {
      throw new Error("[BlocksOnlySmoke] settled runtime state mismatch");
    }
    if (
      ((await cm.getCollateral(
        borrower.address,
        deployment.asset,
      )) as bigint) !== 0n
    ) {
      throw new Error(
        "[BlocksOnlySmoke] borrower collateral should be fully released after settled blocks-only order",
      );
    }

    const liquidationMatch = await buildBlocksOnlyMatch({
      vblAddr: deployment.vaultBusinessLogic,
      borrower: liquidationBorrower,
      lender,
      asset: deployment.asset,
      principal,
      collateralAmount,
      saltPrefix: "blocks-only-rollout-liquidation",
    });
    await waitTx(
      vbl
        .connect(lender)
        .reserveForLending(
          lender.address,
          deployment.asset,
          principal,
          liquidationMatch.lendIntentHash,
        ),
      "reserve liquidation",
    );
    const finalizeLiqRc = await waitTx(
      vbl
        .connect(liquidationBorrower)
        .finalizeMatchBlocks(
          liquidationMatch.borrowIntent,
          [liquidationMatch.lendIntent],
          liquidationMatch.sigBorrower,
          [liquidationMatch.sigLender],
        ),
      "finalizeMatchBlocks liquidation",
    );
    assertDataPushType(
      "finalize liquidation",
      finalizeLiqRc,
      DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED,
      deployment.blocksOnlyCoordinator,
    );
    const finalizeLiquidationPayload = getLastDataPushPayload(
      finalizeLiqRc,
      DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED,
      deployment.blocksOnlyCoordinator,
    );
    if (!finalizeLiquidationPayload) {
      throw new Error(
        "[BlocksOnlySmoke] missing finalized payload for liquidation flow",
      );
    }

    const liquidationOrderId = countBefore + 1n;
    await network.provider.send("evm_mine", []);
    await refreshPriceOracleBlock({
      priceOracle,
      asset: deployment.asset,
      signer: deployer,
      label: `${label} liquidation`,
      print: true,
    });

    const liquidationRc = await waitTx(
      coordinator.connect(keeper).settleOrLiquidateBlocks(liquidationOrderId),
      "settleOrLiquidateBlocks liquidation",
    );
    assertDataPushType(
      "settleOrLiquidateBlocks liquidation",
      liquidationRc,
      DATA_TYPE_BLOCKS_ONLY_LIQUIDATED,
      deployment.blocksOnlyCoordinator,
    );
    dataPushPayloadChecks.finalizeLiquidation = auditMatchFinalizedPayload({
      label: "finalizeLiquidation",
      payload: finalizeLiquidationPayload,
      coordinator: deployment.blocksOnlyCoordinator,
      orderId: liquidationOrderId,
      borrower: liquidationBorrower.address,
      lender: deployment.lenderPoolVault,
      asset: deployment.asset,
      principal,
      termBlocks: 1n,
      txBlockNumber: BigInt(finalizeLiqRc.blockNumber),
    });

    const liquidationRuntimeAfter = await blocksOnlyView
      .connect(liquidationBorrower)
      .getBlocksOnlyOrder(liquidationOrderId);
    if (
      !liquidationRuntimeAfter.isClosed ||
      liquidationRuntimeAfter.status !== 4n
    ) {
      throw new Error("[BlocksOnlySmoke] liquidated runtime state mismatch");
    }
    if (
      ((await lendingEngine.getDebt(
        liquidationBorrower.address,
        deployment.asset,
      )) as bigint) !== 0n
    ) {
      throw new Error(
        "[BlocksOnlySmoke] liquidation should clear borrower debt",
      );
    }
    const liquidationCollateralAfter = (await cm.getCollateral(
      liquidationBorrower.address,
      deployment.asset,
    )) as bigint;
    const expectedRemainingCollateral = collateralAmount - principal;
    if (liquidationCollateralAfter !== expectedRemainingCollateral) {
      throw new Error(
        `[BlocksOnlySmoke] liquidation collateral mismatch: expected=${expectedRemainingCollateral} actual=${liquidationCollateralAfter}`,
      );
    }
    const liquidationPayload = getLastDataPushPayload(
      liquidationRc,
      DATA_TYPE_BLOCKS_ONLY_LIQUIDATED,
      deployment.blocksOnlyCoordinator,
    );
    if (!liquidationPayload) {
      throw new Error("[BlocksOnlySmoke] missing liquidated payload");
    }
    dataPushPayloadChecks.liquidation = auditLiquidatedPayload({
      label: "liquidation",
      payload: liquidationPayload,
      coordinator: deployment.blocksOnlyCoordinator,
      orderId: liquidationOrderId,
      borrower: liquidationBorrower.address,
      asset: deployment.asset,
      liquidator: keeper.address,
      collateralAsset: deployment.asset,
      collateralAmount: principal,
      debtAmount: principal,
      closeBlock: BigInt(liquidationRc.blockNumber),
    });

    const [borrowerOrderCount] = (await blocksOnlyView
      .connect(borrower)
      .getBorrowerOrderCount(borrower.address)) as [bigint, boolean, bigint];
    const [borrowerOrderIds] = (await blocksOnlyView
      .connect(borrower)
      .getBorrowerOrderIdsPaginated(borrower.address, 0, 10)) as [
      bigint[],
      bigint,
      boolean,
      bigint,
    ];
    if (
      borrowerOrderCount < 1n ||
      !borrowerOrderIds.some((id) => id === repayOrderId)
    ) {
      throw new Error(
        "[BlocksOnlySmoke] borrower-scoped BlocksOnlyView pagination did not include repay-settle order",
      );
    }

    const [systemOrders, totalSystemOrders] = (await blocksOnlyView
      .connect(deployer)
      .getSystemOrdersPaginated(countBefore, 10)) as [
      Array<{ orderId: bigint; status: bigint }>,
      bigint,
      boolean,
      bigint,
    ];
    if (totalSystemOrders < countBefore + 2n) {
      throw new Error(
        "[BlocksOnlySmoke] system order count did not advance after two blocks-only orders",
      );
    }
    const returnedIds = new Set(systemOrders.map((x) => x.orderId.toString()));
    if (
      !returnedIds.has(repayOrderId.toString()) ||
      !returnedIds.has(liquidationOrderId.toString())
    ) {
      throw new Error(
        "[BlocksOnlySmoke] system BlocksOnlyView pagination missing newly created order ids",
      );
    }

    const dataPushCounts: Record<string, number> = {};
    for (const receipt of [
      finalizeRepayRc,
      repayRc,
      settleRc,
      finalizeLiqRc,
      liquidationRc,
    ]) {
      for (const typeHash of extractDataPushTypes(receipt)) {
        dataPushCounts[typeHash] = (dataPushCounts[typeHash] ?? 0) + 1;
      }
    }
    if (strictDataPushPayloads) {
      const expectedCounts: Record<string, number> = {
        [DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED]: 2,
        [DATA_TYPE_BLOCKS_ONLY_REPAID]: 1,
        [DATA_TYPE_BLOCKS_ONLY_SETTLED]: 1,
        [DATA_TYPE_BLOCKS_ONLY_LIQUIDATED]: 1,
      };
      for (const [typeHash, expected] of Object.entries(expectedCounts)) {
        const actual = dataPushCounts[typeHash] ?? 0;
        if (actual !== expected) {
          throw new Error(
            `[BlocksOnlySmoke] strict DataPush count mismatch for ${typeHash}: expected=${expected} actual=${actual}`,
          );
        }
      }
    }

    if (
      !preflight.keeperHasActionLiquidate ||
      !preflight.coordinatorHasActionLiquidate ||
      !preflight.coordinatorHasViewRiskData ||
      !preflight.unauthorizedCallerRejected
    ) {
      throw new Error(
        "[BlocksOnlySmoke] preflight invariants were not fully satisfied",
      );
    }

    const summary: BlocksOnlyRolloutSmokeSummary = {
      deployment,
      actors: {
        deployer: deployer.address,
        keeper: keeper.address,
        lender: lender.address,
        borrower: borrower.address,
        liquidationBorrower: liquidationBorrower.address,
      },
      orderIds: {
        repayAndSettle: repayOrderId.toString(),
        liquidation: liquidationOrderId.toString(),
      },
      checkpoints: {
        repayAndSettle: {
          finalized: true,
          repaid: true,
          settled: true,
          remainingDebt: repayRuntimeAfter.remainingDebt.toString(),
          isClosed: repayRuntimeAfter.isClosed,
        },
        liquidation: {
          finalized: true,
          liquidated: true,
          remainingDebt: liquidationRuntimeAfter.remainingDebt.toString(),
          isClosed: liquidationRuntimeAfter.isClosed,
        },
      },
      preflight,
      dataPushCounts,
      dataPushPayloadChecks,
    };

    if (opts?.writeArtifact !== false) {
      summary.artifactPath = writeArtifact(
        opts?.artifactTag ?? "localhost",
        summary,
      );
    }

    if (printSummary) {
      console.log(
        `  ✅ repay-settle orderId=${summary.orderIds.repayAndSettle}`,
      );
      console.log(`  ✅ liquidation orderId=${summary.orderIds.liquidation}`);
      console.log(
        `  ✅ preflight keeper=${summary.actors.keeper} actionLiquidate=${summary.preflight.keeperHasActionLiquidate} coordinatorLiquidate=${summary.preflight.coordinatorHasActionLiquidate} coordinatorRiskView=${summary.preflight.coordinatorHasViewRiskData}`,
      );
      if (summary.artifactPath)
        console.log(`  📦 blocks-only artifact: ${summary.artifactPath}`);
    }

    return summary;
  } finally {
    if (snap !== null) {
      await network.provider.send("evm_revert", [snap]);
    }
  }
}
