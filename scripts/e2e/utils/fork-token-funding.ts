import hardhat from "hardhat";

const { ethers } = hardhat;

const ADMIN_TOKEN_ABI = [
  "function owner() view returns (address)",
  "function masterMinter() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function configureMinter(address,uint256) returns (bool)",
  "function mint(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

async function impersonateForkAccount(addr: string) {
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  await ethers.provider.send("hardhat_setBalance", [addr, "0x3635C9ADC5DEA00000"]);
  return await ethers.getSigner(addr);
}

async function stopImpersonating(addr: string) {
  try {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [addr]);
  } catch {
    // best-effort cleanup
  }
}

async function tryMint(token: any, signer: any, recipient: string, amount: bigint): Promise<boolean> {
  try {
    await (await token.connect(signer).mint(recipient, amount)).wait();
    return true;
  } catch {
    return false;
  }
}

async function tryTransfer(token: any, signer: any, signerAddress: string, recipient: string, amount: bigint): Promise<boolean> {
  try {
    const bal = (await token.balanceOf(signerAddress)) as bigint;
    if (bal < amount) return false;
    await (await token.connect(signer).transfer(recipient, amount)).wait();
    return true;
  } catch {
    return false;
  }
}

async function tryAdminFunding(tokenAddress: string, deployer: any, recipient: string, amount: bigint): Promise<boolean> {
  const adminReader = new ethers.Contract(tokenAddress, ADMIN_TOKEN_ABI, ethers.provider);
  const owner = await (async () => {
    try {
      return (await adminReader.owner()) as string;
    } catch {
      return "";
    }
  })();
  const masterMinter = await (async () => {
    try {
      return (await adminReader.masterMinter()) as string;
    } catch {
      return "";
    }
  })();

  const candidates = Array.from(
    new Set([owner, masterMinter].filter((addr) => !!addr && addr !== ethers.ZeroAddress).map((addr) => ethers.getAddress(addr)))
  );

  for (const adminAddr of candidates) {
    const adminSigner = await impersonateForkAccount(adminAddr);
    const adminToken = new ethers.Contract(tokenAddress, ADMIN_TOKEN_ABI, adminSigner);
    try {
      try {
        await (await adminToken.configureMinter(deployer.address, ethers.MaxUint256)).wait();
      } catch {
        // not all tokens expose/configure minters
      }

      if (await tryMint(adminToken, adminSigner, recipient, amount)) {
        return true;
      }
      if (await tryMint(new ethers.Contract(tokenAddress, ADMIN_TOKEN_ABI, deployer), deployer, recipient, amount)) {
        return true;
      }
      if (await tryTransfer(adminToken, adminSigner, adminAddr, recipient, amount)) {
        return true;
      }
    } finally {
      await stopImpersonating(adminAddr);
    }
  }

  return false;
}

export async function fundErc20Users(params: {
  token: any;
  deployer: any;
  recipients: string[];
  amount: bigint;
  label: string;
}) {
  const tokenAddress = await params.token.getAddress();
  for (const recipient of params.recipients) {
    if (await tryMint(params.token, params.deployer, recipient, params.amount)) {
      continue;
    }
    if (await tryTransfer(params.token, params.deployer, params.deployer.address, recipient, params.amount)) {
      continue;
    }
    if (await tryAdminFunding(tokenAddress, params.deployer, recipient, params.amount)) {
      continue;
    }
    throw new Error(
      `[${params.label}] unable to fund ${recipient} with token ${tokenAddress}; deployer lacks balance and no fork admin mint/transfer path succeeded`
    );
  }
}