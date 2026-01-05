#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';

interface ContractInfo {
  name: string;
  path: string;
  interfaces: string[];
  dependencies: string[];
  hasInitializer: boolean;
  hasUpgradeable: boolean;
}

interface ConsistencyReport {
  totalContracts: number;
  interfaceIssues: string[];
  dependencyIssues: string[];
  upgradeableIssues: string[];
  missingImplementations: string[];
}

/**
 * 检查合约一致性
 * 验证接口实现、模块依赖、升级机制等
 */
async function checkContractConsistency(): Promise<void> {
  logger.info('🔍 开始检查合约一致性...');
  
  const contractsDir = path.resolve(process.cwd(), 'contracts');
  const report: ConsistencyReport = {
    totalContracts: 0,
    interfaceIssues: [],
    dependencyIssues: [],
    upgradeableIssues: [],
    missingImplementations: []
  };
  
  try {
    // 1. 扫描所有合约文件
    const contracts = await scanContracts(contractsDir);
    report.totalContracts = contracts.length;
    
    logger.info(`📋 发现 ${contracts.length} 个合约文件`);
    
    // 2. 检查接口实现
    await checkInterfaceImplementations(contracts, report);
    
    // 3. 检查模块依赖
    await checkModuleDependencies(contracts, report);
    
    // 4. 检查升级机制
    await checkUpgradeableContracts(contracts, report);
    
    // 5. 检查常量库使用
    await checkConstantsUsage(contracts, report);
    
    // 6. 生成报告
    generateReport(report);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('❌ 合约一致性检查失败:', error instanceof Error ? error : new Error(errorMessage));
    throw error;
  }
}

async function scanContracts(dir: string): Promise<ContractInfo[]> {
  const contracts: ContractInfo[] = [];
  
  function scanDirectory(currentDir: string) {
    const files = fs.readdirSync(currentDir);
    
    for (const file of files) {
      const filePath = path.join(currentDir, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory()) {
        scanDirectory(filePath);
      } else if (file.endsWith('.sol')) {
        const contractInfo = analyzeContract(filePath);
        if (contractInfo) {
          contracts.push(contractInfo);
        }
      }
    }
  }
  
  scanDirectory(dir);
  return contracts;
}

function analyzeContract(filePath: string): ContractInfo | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath, '.sol');
    
    const contractInfo: ContractInfo = {
      name: fileName,
      path: filePath,
      interfaces: [],
      dependencies: [],
      hasInitializer: false,
      hasUpgradeable: false
    };
    
    // 检查接口实现
    const interfaceMatches = content.match(/implements\s+([A-Za-z0-9_,\s]+)/g);
    if (interfaceMatches) {
      interfaceMatches.forEach(match => {
        const interfaces = match.replace('implements', '').trim().split(',').map(i => i.trim());
        contractInfo.interfaces.push(...interfaces);
      });
    }
    
    // 检查依赖
    const importMatches = content.match(/import\s+["']([^"']+)["']/g);
    if (importMatches) {
      importMatches.forEach(match => {
        const importPath = match.match(/["']([^"']+)["']/)?.[1];
        if (importPath) {
          const dependency = path.basename(importPath, '.sol');
          contractInfo.dependencies.push(dependency);
        }
      });
    }
    
    // 检查升级机制
    contractInfo.hasInitializer = content.includes('Initializable') || content.includes('initializer');
    contractInfo.hasUpgradeable = content.includes('UUPSUpgradeable') || content.includes('upgradeTo');
    
    return contractInfo;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warning(`无法分析合约文件: ${filePath} - ${errorMessage}`);
    return null;
  }
}

async function checkInterfaceImplementations(contracts: ContractInfo[], report: ConsistencyReport): Promise<void> {
  logger.info('🔍 检查接口实现...');
  
  // 收集所有接口
  const interfaces = contracts.filter(c => c.name.startsWith('I') || c.path.includes('interfaces'));
  const implementations = contracts.filter(c => !c.name.startsWith('I') && !c.path.includes('interfaces'));
  
  // 检查每个接口是否有实现
  for (const interface_ of interfaces) {
    const interfaceName = interface_.name;
    const hasImplementation = implementations.some(impl => 
      impl.interfaces.includes(interfaceName)
    );
    
    if (!hasImplementation) {
      report.missingImplementations.push(interfaceName);
    }
  }
  
  // 检查实现是否完整
  for (const impl of implementations) {
    for (const interfaceName of impl.interfaces) {
      const interface_ = interfaces.find(i => i.name === interfaceName);
      if (interface_) {
        // 这里可以添加更详细的接口方法检查
        logger.success(`✓ ${impl.name} 实现 ${interfaceName}`);
      }
    }
  }
}

async function checkModuleDependencies(contracts: ContractInfo[], report: ConsistencyReport): Promise<void> {
  logger.info('🔍 检查模块依赖...');
  
  const coreModules = ['VaultCore', 'VaultStorage', 'VaultRouter', 'VaultAdmin'];
  const businessModules = ['CollateralManager', 'LendingEngine', 'HealthFactorCalculator', 'StatisticsView'];
  const infrastructureModules = ['AssetWhitelist', 'FeeRouter', 'RewardManager', 'ValuationOracleAdapter'];
  
  // 检查核心模块依赖
  for (const module of coreModules) {
    const contract = contracts.find(c => c.name === module);
    if (contract) {
      logger.success(`✓ 核心模块 ${module} 存在`);
    } else {
      report.dependencyIssues.push(`缺少核心模块: ${module}`);
    }
  }
  
  // 检查业务模块依赖
  for (const module of businessModules) {
    const contract = contracts.find(c => c.name === module);
    if (contract) {
      logger.success(`✓ 业务模块 ${module} 存在`);
    } else {
      report.dependencyIssues.push(`缺少业务模块: ${module}`);
    }
  }
  
  // 检查基础设施模块依赖
  for (const module of infrastructureModules) {
    const contract = contracts.find(c => c.name === module);
    if (contract) {
      logger.success(`✓ 基础设施模块 ${module} 存在`);
    } else {
      report.dependencyIssues.push(`缺少基础设施模块: ${module}`);
    }
  }
}

async function checkUpgradeableContracts(contracts: ContractInfo[], report: ConsistencyReport): Promise<void> {
  logger.info('🔍 检查升级机制...');
  
  const upgradeableContracts = contracts.filter(c => c.hasUpgradeable);
  const nonUpgradeableContracts = contracts.filter(c => !c.hasUpgradeable);
  
  logger.info(`发现 ${upgradeableContracts.length} 个可升级合约`);
  logger.info(`发现 ${nonUpgradeableContracts.length} 个不可升级合约`);
  
  // 检查关键合约是否支持升级
  const criticalContracts = ['VaultCore', 'VaultStorage', 'VaultRouter', 'VaultAdmin'];
  for (const contractName of criticalContracts) {
    const contract = contracts.find(c => c.name === contractName);
    if (contract && !contract.hasUpgradeable) {
      report.upgradeableIssues.push(`关键合约 ${contractName} 不支持升级`);
    }
  }
  
  // 检查升级合约是否有初始化器
  for (const contract of upgradeableContracts) {
    if (!contract.hasInitializer) {
      report.upgradeableIssues.push(`可升级合约 ${contract.name} 缺少初始化器`);
    }
  }
}

async function checkConstantsUsage(contracts: ContractInfo[], report: ConsistencyReport): Promise<void> {
  logger.info('🔍 检查常量库使用...');
  
  const constantsLibraries = ['ModuleKeys', 'ActionKeys', 'VaultMath'];
  
  for (const lib of constantsLibraries) {
    const contract = contracts.find(c => c.name === lib);
    if (contract) {
      logger.success(`✓ 常量库 ${lib} 存在`);
    } else {
      report.dependencyIssues.push(`缺少常量库: ${lib}`);
    }
  }
  
  // 检查其他合约是否使用常量库
  const contractsUsingConstants = contracts.filter(c => 
    c.dependencies.some(dep => constantsLibraries.includes(dep))
  );
  
  logger.info(`${contractsUsingConstants.length} 个合约使用了常量库`);
}

function generateReport(report: ConsistencyReport): void {
  logger.info('\n📊 合约一致性检查报告');
  logger.info('='.repeat(50));
  
  logger.info(`📋 总合约数量: ${report.totalContracts}`);
  
  if (report.interfaceIssues.length > 0) {
    logger.error(`❌ 接口问题 (${report.interfaceIssues.length}):`);
    report.interfaceIssues.forEach(issue => logger.error(`  - ${issue}`));
  }
  
  if (report.dependencyIssues.length > 0) {
    logger.error(`❌ 依赖问题 (${report.dependencyIssues.length}):`);
    report.dependencyIssues.forEach(issue => logger.error(`  - ${issue}`));
  }
  
  if (report.upgradeableIssues.length > 0) {
    logger.error(`❌ 升级机制问题 (${report.upgradeableIssues.length}):`);
    report.upgradeableIssues.forEach(issue => logger.error(`  - ${issue}`));
  }
  
  if (report.missingImplementations.length > 0) {
    logger.warning(`⚠️ 缺少实现 (${report.missingImplementations.length}):`);
    report.missingImplementations.forEach(issue => logger.warning(`  - ${issue}`));
  }
  
  const totalIssues = report.interfaceIssues.length + 
                     report.dependencyIssues.length + 
                     report.upgradeableIssues.length;
  
  if (totalIssues === 0) {
    logger.success('🎉 所有检查通过！合约一致性良好');
  } else {
    logger.error(`❌ 发现 ${totalIssues} 个问题需要修复`);
    process.exitCode = 1;
  }
}

// 执行检查
if (require.main === module) {
  checkContractConsistency().catch(error => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('合约一致性检查过程中出错', error instanceof Error ? error : new Error(errorMessage));
    process.exitCode = 1;
  });
}

export { checkContractConsistency };


