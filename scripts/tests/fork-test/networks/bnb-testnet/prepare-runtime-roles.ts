import fs from "fs";
import path from "path";

import hre, { network } from "hardhat";

import { loadAddressMap, resolveAddress } from "../../../_addressResolver";
import { key, type MockAssetPackAsset } from "../../../live-test/networks/bnb-testnet/core/_mockLiveUtils";
import { prepareBnbLiveEnv } from "../../../live-test/networks/bnb-testnet/_bootstrap";

const { ethers } = hre;
const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  return value.length ? value : undefined;
}

function resolveActorAddress(pkEnv: string): string | undefined {
  const privateKey = envStr(pkEnv);
  if (!privateKey) {
    return undefined;
  }
  return new ethers.Wallet(privateKey).address;
}

async function impersonateWithBalance(address: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [address, ethers.toBeHex(ethers.parseEther("10"))],
  });
  return await ethers.getSigner(address);
}

async function ensureRole(params: {
  acm: any;
  granter: any;
  roleName: string;
  account: string;
}) {
  const role = key(params.roleName);
  const hasRole = (await params.acm.hasRole(role, params.account)) as boolean;
  if (hasRole) {
    console.log(`[ForkRole] already granted ${params.roleName} -> ${params.account}`);
    return;
  }

  await (await params.acm.connect(params.granter).grantRole(role, params.account)).wait();
  console.log(`[ForkRole] granted ${params.roleName} -> ${params.account}`);
}

async function ensureRelayerTokenBalance(params: {
  relayer: string;
  funder: any;
  asset: MockAssetPackAsset;
  desiredUnits: string;
}) {
  const token = (await ethers.getContractAt(
    [
      "function balanceOf(address owner) view returns (uint256)",
      "function transfer(address to,uint256 amount) returns (bool)",
    ],
    params.asset.address,
  )) as any;
  const desiredBalance = ethers.parseUnits(params.desiredUnits, params.asset.decimals);
  const currentBalance = (await token.balanceOf(params.relayer)) as bigint;
  if (currentBalance >= desiredBalance) {
    console.log(`[ForkFunds] relayer already funded ${params.asset.symbol}=${currentBalance.toString()}`);
    return;
  }

  const gap = desiredBalance - currentBalance;
  await (await token.connect(params.funder).transfer(params.relayer, gap)).wait();
  console.log(`[ForkFunds] funded relayer ${params.asset.symbol} gap=${gap.toString()}`);
}

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error(`prepare-runtime-roles must run on localhost/hardhat; got ${network.name}`);
  }

  prepareBnbLiveEnv();

  const liveNetworkName = envStr("LIVE_NETWORK_ALIAS") ?? network.name;
  const addressMap = loadAddressMap(liveNetworkName, { preferMockSuite: true });
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });
  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function getModule(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;
  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const priceUpdaterAddr = (await registry.getModule(key(PRICE_UPDATER_REGISTRY_RAW_KEY))) as string;
  const acm = (await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
      "function grantRole(bytes32 role,address account)",
    ],
    acmAddr,
  )) as any;

  const [relayer] = await ethers.getSigners();
  const viewerAddress = envStr("VIEWER_ADDRESS") ?? relayer.address;
  const borrowerAddress = resolveActorAddress("BORROWER_PRIVATE_KEY") ?? relayer.address;
  const lenderAddress = resolveActorAddress("LENDER_PRIVATE_KEY") ?? relayer.address;
  const acmOwner = (await acm.owner()) as string;
  const ownerSigner = await impersonateWithBalance(acmOwner);
  const mockAssetPackFile = path.resolve(process.cwd(), process.env.MOCK_ASSET_PACK_OUTPUT ?? "deployments/mock-assets.bnb-testnet.json");
  const mockAssetPack = JSON.parse(fs.readFileSync(mockAssetPackFile, "utf8")) as {
    deployer?: string;
    settlementToken?: string;
    assets?: MockAssetPackAsset[];
  };

  const roleNames = (envStr("BNB_FORK_RUNTIME_ROLES")
    ?? "VIEW_PRICE_DATA,VIEW_USER_DATA,VIEW_RISK_DATA,VIEW_SYSTEM_DATA,ACTION_VIEW_SYSTEM_STATUS,LIQUIDATE,DEPOSIT,ACTION_VIEW_PUSH,UPDATE_PRICE,SET_PARAMETER")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const userTargets = [...new Set([relayer.address, viewerAddress, borrowerAddress, lenderAddress])];

  console.log(`=== BNB Fork Runtime Role Prep (${network.name}) ===`);
  console.log(`LiveNetworkName=${liveNetworkName}`);
  console.log(`Registry=${registryAddr}`);
  console.log(`AccessControlManager=${acmAddr}`);
  console.log(`AcmOwner=${acmOwner}`);
  console.log(`Targets=${userTargets.join(",")}`);
  console.log(`Roles=${roleNames.join(",")}`);

  for (const account of userTargets) {
    for (const roleName of roleNames) {
      await ensureRole({
        acm,
        granter: ownerSigner,
        roleName,
        account,
      });
    }
  }

  await ensureRole({
    acm,
    granter: ownerSigner,
    roleName: "REPAY",
    account: settlementManagerAddr,
  });
  await ensureRole({
    acm,
    granter: ownerSigner,
    roleName: "VIEW_SYSTEM_DATA",
    account: settlementManagerAddr,
  });

  if (priceUpdaterAddr && priceUpdaterAddr !== ethers.ZeroAddress) {
    await ensureRole({
      acm,
      granter: ownerSigner,
      roleName: "UPDATE_PRICE",
      account: priceUpdaterAddr,
    });
    await ensureRole({
      acm,
      granter: ownerSigner,
      roleName: "SET_PARAMETER",
      account: priceUpdaterAddr,
    });
  }

  const tokenFunderAddress = envStr("BNB_FORK_TOKEN_FUNDER") ?? mockAssetPack.deployer;
  if (!tokenFunderAddress) {
    throw new Error(`Unable to resolve BNB fork token funder from ${mockAssetPackFile}`);
  }
  const tokenFunder = await impersonateWithBalance(tokenFunderAddress);
  const settlementToken = String(mockAssetPack.settlementToken ?? "").toLowerCase();
  const seenAssets = new Set<string>();
  for (const asset of mockAssetPack.assets ?? []) {
    const assetKey = asset.address.toLowerCase();
    if (seenAssets.has(assetKey)) {
      continue;
    }
    seenAssets.add(assetKey);
    const desiredUnits = assetKey === settlementToken
      ? envStr("BNB_FORK_RELAYER_SETTLEMENT_UNITS") ?? "100000"
      : envStr("BNB_FORK_RELAYER_ASSET_UNITS") ?? "1000";
    await ensureRelayerTokenBalance({
      relayer: relayer.address,
      funder: tokenFunder,
      asset,
      desiredUnits,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});