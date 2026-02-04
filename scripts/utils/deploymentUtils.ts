import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

export interface DeploymentInfo {
  name: string;
  address: string;
  constructorArgs?: unknown[];
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  deployedAtMs: number;
}

export interface DeploymentConfig {
  network: string;
  deployer: string;
  contracts: {
    [key: string]: {
      factory: string;
      args?: unknown[];
      verify?: boolean;
    };
  };
}

/**
 * 部署合约并记录信息
 */
export async function deployContract(
  contractName: string,
  constructorArgs: unknown[] = [],
  _shouldVerify: boolean = true
): Promise<DeploymentInfo> {
  console.log(`🚀 部署合约: ${contractName}`);
  
  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.deploy(...constructorArgs);
  await contract.waitForDeployment();
  
  const address = await contract.getAddress();
  const deployment = contract.deploymentTransaction();
  
  if (!deployment) {
    throw new Error('部署交易未找到');
  }
  
  const receipt = await deployment.wait();
  
  const deploymentInfo: DeploymentInfo = {
    name: contractName,
    address,
    constructorArgs,
    transactionHash: deployment.hash,
    blockNumber: receipt!.blockNumber,
    gasUsed: receipt!.gasUsed.toString(),
    deployedAtMs: Date.now()
  };
  
  console.log(`✅ ${contractName} 部署成功: ${address}`);
  console.log(`   Gas 使用: ${deploymentInfo.gasUsed}`);
  console.log(`   交易哈希: ${deploymentInfo.transactionHash}`);
  
  // 保存部署信息
  saveDeploymentInfo(deploymentInfo);
  
  return deploymentInfo;
}

/**
 * 批量部署合约
 */
export async function deployContracts(
  config: DeploymentConfig
): Promise<{ [key: string]: DeploymentInfo }> {
  const results: { [key: string]: DeploymentInfo } = {};
  
  console.log(`🌐 开始部署到网络: ${config.network}`);
  console.log(`👤 部署者: ${config.deployer}`);
  
  for (const [name, contractConfig] of Object.entries(config.contracts)) {
    try {
      const deploymentInfo = await deployContract(
        contractConfig.factory,
        contractConfig.args || [],
        contractConfig.verify || false
      );
      results[name] = deploymentInfo;
    } catch (error) {
      console.error(`❌ 部署 ${name} 失败:`, error);
      throw error;
    }
  }
  
  // 保存完整的部署配置
  saveDeploymentConfig(config, results);
  
  return results;
}

/**
 * 保存部署信息到文件
 */
export function saveDeploymentInfo(info: DeploymentInfo): void {
  const deploymentsDir = path.join(__dirname, '..', '..', 'deployments');
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  const network = process.env.HARDHAT_NETWORK || 'localhost';
  const filePath = path.join(deploymentsDir, `${network}.json`);
  
  let deployments: { [key: string]: DeploymentInfo } = {};
  if (fs.existsSync(filePath)) {
    deployments = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  
  deployments[info.name] = info;
  fs.writeFileSync(filePath, JSON.stringify(deployments, null, 2));
  
  console.log(`📄 部署信息已保存到: ${filePath}`);
}

/**
 * 保存部署配置
 */
export function saveDeploymentConfig(
  config: DeploymentConfig,
  results: { [key: string]: DeploymentInfo }
): void {
  const deploymentsDir = path.join(__dirname, '..', '..', 'deployments');
  const filePath = path.join(deploymentsDir, `${config.network}-config.json`);
  
  const deploymentData = {
    config,
    results,
    generatedAtMs: Date.now()
  };
  
  fs.writeFileSync(filePath, JSON.stringify(deploymentData, null, 2));
  console.log(`📄 部署配置已保存到: ${filePath}`);
}

/**
 * 加载部署信息
 */
export function loadDeploymentInfo(network: string): { [key: string]: DeploymentInfo } {
  const filePath = path.join(__dirname, '..', '..', 'deployments', `${network}.json`);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  部署文件不存在: ${filePath}`);
    return {};
  }
  
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 获取合约实例
 */
export async function getContractInstance(
  contractName: string,
  address: string
): Promise<Contract> {
  const factory = await ethers.getContractFactory(contractName);
  return factory.attach(address) as Contract;
}

/**
 * 检查合约是否已部署
 */
export function isContractDeployed(network: string, contractName: string): boolean {
  const deployments = loadDeploymentInfo(network);
  return !!deployments[contractName];
}

/**
 * 获取合约地址
 */
export function getContractAddress(network: string, contractName: string): string | null {
  const deployments = loadDeploymentInfo(network);
  return deployments[contractName]?.address || null;
}

/**
 * 验证部署参数
 */
export function validateDeploymentConfig(config: DeploymentConfig): void {
  if (!config.network) {
    throw new Error('网络配置缺失');
  }
  
  if (!config.deployer) {
    throw new Error('部署者地址缺失');
  }
  
  if (!config.contracts || Object.keys(config.contracts).length === 0) {
    throw new Error('合约配置缺失');
  }
  
  for (const [name, contractConfig] of Object.entries(config.contracts)) {
    if (!contractConfig.factory) {
      throw new Error(`合约 ${name} 的工厂配置缺失`);
    }
  }
  
  console.log('✅ 部署配置验证通过');
} 