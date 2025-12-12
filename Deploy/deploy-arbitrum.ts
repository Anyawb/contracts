import hardhat from "hardhat";
const { ethers, network } = hardhat;
import fs from "fs";
import path from "path";
import { Contract } from "ethers";

interface DeployRecord {
  [key: string]: string;
}

const DEPLOY_PATH = path.join(__dirname, "../deployments/arbitrum-goerli.json");

function loadDeploymentFile(): DeployRecord {
  if (fs.existsSync(DEPLOY_PATH)) {
    return JSON.parse(fs.readFileSync(DEPLOY_PATH, "utf-8"));
  }
  return {};
}

function saveDeploymentFile(data: DeployRecord) {
  fs.mkdirSync(path.dirname(DEPLOY_PATH), { recursive: true });
  fs.writeFileSync(DEPLOY_PATH, JSON.stringify(data, null, 2));
}

async function deploy<T extends Contract>(name: string, ...args: any[]): Promise<string> {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  console.log(`${name} deployed @`, await contract.getAddress());
  return await contract.getAddress();
}

async function main() {
  console.log("Network:", network.name);
  const deployed = loadDeploymentFile();

  // Example: deploy MockERC20
  if (!deployed.MockERC20) {
    deployed.MockERC20 = await deploy("MockERC20", "USD Token", "USD", 18);
    saveDeploymentFile(deployed);
  }

  // CollateralVault and other modules would follow similar pattern.
  // ... (省略具体实现，根据项目实际合约名和构造参数配置)

  console.log("All done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}); 