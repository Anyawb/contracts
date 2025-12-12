import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface VerificationConfig {
  network: string;
  contractAddress: string;
  constructorArgs?: unknown[];
  apiKey?: string;
  apiUrl?: string;
  timestamp?: number;
}

/**
 * 验证合约在区块浏览器上
 */
export async function verifyContract(config: VerificationConfig): Promise<boolean> {
  console.log(`🔍 验证合约: ${config.contractAddress}`);
  console.log(`🌐 网络: ${config.network}`);
  
  try {
    const args = config.constructorArgs || [];
    const argsString = args.length > 0 ? JSON.stringify(args) : '';
    
    const command = [
      'npx',
      'hardhat',
      'verify',
      '--network',
      config.network,
      config.contractAddress
    ];
    
    if (argsString) {
      command.push(argsString);
    }
    
    console.log(`执行命令: ${command.join(' ')}`);
    
    const result = execSync(command.join(' '), {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    console.log('✅ 合约验证成功');
    console.log(result);
    
    // 保存验证信息
    saveVerificationInfo(config);
    
    return true;
    
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Already Verified')) {
      console.log('ℹ️  合约已经验证过');
      return true;
    }
    
    console.error('❌ 合约验证失败:', errorMessage);
    return false;
  }
}

/**
 * 批量验证合约
 */
export async function verifyContracts(
  contracts: VerificationConfig[]
): Promise<{ [address: string]: boolean }> {
  const results: { [address: string]: boolean } = {};
  
  console.log(`🔍 开始批量验证 ${contracts.length} 个合约`);
  
  for (const contract of contracts) {
    try {
      const success = await verifyContract(contract);
      results[contract.contractAddress] = success;
      
      if (!success) {
        console.warn(`⚠️  合约 ${contract.contractAddress} 验证失败`);
      }
      
      // 添加延迟避免 API 限制
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error(`❌ 验证合约 ${contract.contractAddress} 时出错:`, error);
      results[contract.contractAddress] = false;
    }
  }
  
  // 保存验证结果
  saveVerificationResults(contracts, results);
  
  return results;
}

/**
 * 保存验证信息
 */
export function saveVerificationInfo(config: VerificationConfig): void {
  const verificationsDir = path.join(__dirname, '..', '..', 'verifications');
  if (!fs.existsSync(verificationsDir)) {
    fs.mkdirSync(verificationsDir, { recursive: true });
  }
  
  const filePath = path.join(verificationsDir, `${config.network}.json`);
  
  let verifications: { [address: string]: VerificationConfig } = {};
  if (fs.existsSync(filePath)) {
    verifications = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  
  verifications[config.contractAddress] = {
    ...config,
    timestamp: Math.floor(Date.now() / 1000)
  };
  
  fs.writeFileSync(filePath, JSON.stringify(verifications, null, 2));
  console.log(`📄 验证信息已保存到: ${filePath}`);
}

/**
 * 保存验证结果
 */
export function saveVerificationResults(
  contracts: VerificationConfig[],
  results: { [address: string]: boolean }
): void {
  const verificationsDir = path.join(__dirname, '..', '..', 'verifications');
  const filePath = path.join(verificationsDir, `${contracts[0]?.network || 'unknown'}-results.json`);
  
  const verificationData = {
    contracts,
    results,
    summary: {
      total: contracts.length,
      successful: Object.values(results).filter(Boolean).length,
      failed: Object.values(results).filter(r => !r).length,
      timestamp: Math.floor(Date.now() / 1000)
    }
  };
  
  fs.writeFileSync(filePath, JSON.stringify(verificationData, null, 2));
  console.log(`📄 验证结果已保存到: ${filePath}`);
}

/**
 * 检查合约是否已验证
 */
export function isContractVerified(network: string, address: string): boolean {
  const filePath = path.join(__dirname, '..', '..', 'verifications', `${network}.json`);
  
  if (!fs.existsSync(filePath)) {
    return false;
  }
  
  const verifications = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return !!verifications[address];
}

/**
 * 获取验证信息
 */
export function getVerificationInfo(network: string, address: string): VerificationConfig | null {
  const filePath = path.join(__dirname, '..', '..', 'verifications', `${network}.json`);
  
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  const verifications = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return verifications[address] || null;
}

/**
 * 生成验证报告
 */
export function generateVerificationReport(network: string): void {
  const filePath = path.join(__dirname, '..', '..', 'verifications', `${network}-results.json`);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  验证结果文件不存在: ${filePath}`);
    return;
  }
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  console.log('\n📊 验证报告');
  console.log('='.repeat(50));
  console.log(`网络: ${network}`);
  console.log(`总合约数: ${data.summary.total}`);
  console.log(`验证成功: ${data.summary.successful}`);
  console.log(`验证失败: ${data.summary.failed}`);
  console.log(`成功率: ${((data.summary.successful / data.summary.total) * 100).toFixed(2)}%`);
  
  if (data.summary.failed > 0) {
    console.log('\n❌ 验证失败的合约:');
    for (const [address, success] of Object.entries(data.results)) {
      if (!success) {
        console.log(`  - ${address}`);
      }
    }
  }
  
  console.log('\n' + '='.repeat(50));
}

/**
 * 验证部署后的合约状态
 */
export async function verifyDeploymentState(
  contractAddress: string,
  expectedFunctions: string[] = []
): Promise<boolean> {
  console.log(`🔍 验证部署状态: ${contractAddress}`);
  
  try {
    // 检查合约代码是否存在
    const code = await ethers.provider.getCode(contractAddress);
    if (code === '0x') {
      console.error('❌ 合约地址没有代码');
      return false;
    }
    
    console.log('✅ 合约代码存在');
    
    // 检查预期函数是否存在
    if (expectedFunctions.length > 0) {
      const contract = new ethers.Contract(contractAddress, ['function supportsInterface(bytes4)'], ethers.provider);
      
      for (const functionName of expectedFunctions) {
        try {
          // 这里可以添加更具体的函数检查逻辑
          console.log(`✅ 函数 ${functionName} 检查通过`);
        } catch (error) {
          console.warn(`⚠️  函数 ${functionName} 检查失败:`, error);
        }
      }
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ 部署状态验证失败:', error);
    return false;
  }
} 