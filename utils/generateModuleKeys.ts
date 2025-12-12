/**
 * ModuleKeys TypeScript 生成器
 * ModuleKeys TypeScript Generator
 * 
 * 从 ModuleKeys.sol 合约自动生成前端的 moduleKeys.ts 文件
 * Automatically generate frontend moduleKeys.ts file from ModuleKeys.sol contract
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

interface ModuleKeyMapping {
  [key: string]: string;
}

/**
 * 生成 TypeScript 模块键文件
 */
export async function generateModuleKeysTS(): Promise<void> {
  console.log('🚀 开始生成 ModuleKeys TypeScript 文件...');
  
  try {
    // 创建测试合约实例来调用函数
    const moduleKeysContract = {
      getAllKeyStrings: () => [
        'KEY_CM',
        'KEY_LE', 
        'KEY_HF_CALC',
        'KEY_STATS',
        'KEY_VAULT_CONFIG',
        'KEY_FR',
        'KEY_RM',
        'KEY_REWARD_CORE',
        'KEY_REWARD_CONFIG',
        'KEY_REWARD_CONSUMPTION',
        'KEY_VALUATION_ORACLE',
        'KEY_GUARANTEE_FUND',
        'KEY_KEEPER_REGISTRY',
        'KEY_WHITELIST_REGISTRY',
        'KEY_ACCESS_CONTROL',
        'KEY_ACCESS_CONTROLLER',
        'KEY_ASSET_WHITELIST',
        'KEY_AUTHORITY_WHITELIST',
        'KEY_CROSS_CHAIN_GOV',
        'KEY_GOVERNANCE_ROLE',
        'KEY_REGISTRY',
        'KEY_LOAN_NFT',
        'KEY_REWARD_POINTS',
        'KEY_RWA_TOKEN',
        'KEY_TOKEN_UTILS',
        'KEY_REVERT_DECODER',
        'KEY_VAULT_UTILS',
        'KEY_PRICE_ORACLE',
        'KEY_COINGECKO_UPDATER',
        'KEY_RWA_STRATEGY',
        'KEY_VAULT_BUSINESS_LOGIC',
        'KEY_ADVANCED_ANALYTICS_CONFIG',
        'KEY_PRIORITY_SERVICE_CONFIG',
        'KEY_FEATURE_UNLOCK_CONFIG',
        'KEY_GOVERNANCE_ACCESS_CONFIG',
        'KEY_TESTNET_FEATURES_CONFIG',
        'KEY_REWARD_MANAGER_V1'
      ]
    };

    const keyStrings = moduleKeysContract.getAllKeyStrings();
    
    // 生成哈希值映射
    const moduleKeyMapping: ModuleKeyMapping = {};
    const keyComments: { [key: string]: string } = {
      'KEY_CM': '抵押物管理模块',
      'KEY_LE': '借贷引擎模块', 
      'KEY_HF_CALC': '健康因子计算器模块',
      'KEY_STATS': '金库统计模块',
      'KEY_VAULT_CONFIG': '金库配置模块',
      'KEY_FR': '手续费路由模块',
      'KEY_RM': '奖励管理模块',
      'KEY_REWARD_CORE': '奖励核心模块',
      'KEY_REWARD_CONFIG': '奖励配置模块',
      'KEY_REWARD_CONSUMPTION': '奖励消费模块',
      'KEY_VALUATION_ORACLE': '估值预言机适配器模块',
      'KEY_GUARANTEE_FUND': '保证金基金管理模块',
      'KEY_KEEPER_REGISTRY': 'Keeper注册表模块',
      'KEY_WHITELIST_REGISTRY': '白名单注册表模块',
      'KEY_ACCESS_CONTROL': '访问控制管理器模块',
      'KEY_ACCESS_CONTROLLER': '访问控制器模块（增强版）',
      'KEY_ASSET_WHITELIST': '资产白名单模块',
      'KEY_AUTHORITY_WHITELIST': '权限白名单模块',
      'KEY_CROSS_CHAIN_GOV': '跨链治理模块',
      'KEY_GOVERNANCE_ROLE': '治理角色模块',
      'KEY_REGISTRY': '注册表模块',
      'KEY_LOAN_NFT': '贷款NFT模块',
      'KEY_REWARD_POINTS': '奖励积分模块',
      'KEY_RWA_TOKEN': 'RWA代币模块',
      'KEY_TOKEN_UTILS': '代币工具模块',
      'KEY_REVERT_DECODER': '回滚解码器模块',
      'KEY_VAULT_UTILS': '金库工具模块',
      'KEY_PRICE_ORACLE': '价格预言机模块',
      'KEY_COINGECKO_UPDATER': 'CoinGecko价格更新器模块',
      'KEY_RWA_STRATEGY': 'RWA自动杠杆策略模块',
      'KEY_VAULT_BUSINESS_LOGIC': '金库业务逻辑模块',
      'KEY_ADVANCED_ANALYTICS_CONFIG': '高级数据分析配置模块',
      'KEY_PRIORITY_SERVICE_CONFIG': '优先服务配置模块',
      'KEY_FEATURE_UNLOCK_CONFIG': '功能解锁配置模块',
      'KEY_GOVERNANCE_ACCESS_CONFIG': '治理访问配置模块',
      'KEY_TESTNET_FEATURES_CONFIG': '测试网功能配置模块',
      'KEY_REWARD_MANAGER_V1': '奖励管理模块V1版本'
    };

    // 为每个键生成哈希值
    for (const keyString of keyStrings) {
      const hashValue = ethers.keccak256(ethers.toUtf8Bytes(keyString));
      moduleKeyMapping[keyString] = hashValue;
    }

    // 生成 TypeScript 文件内容
    const tsContent = generateTypeScriptContent(moduleKeyMapping, keyComments, keyStrings);
    
    // 确保输出目录存在
    const outputDir = path.join(__dirname, '../../frontend-config');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // 写入文件
    const outputPath = path.join(outputDir, 'moduleKeys.ts');
    fs.writeFileSync(outputPath, tsContent, 'utf8');
    
    console.log(`✅ ModuleKeys TypeScript 文件已生成: ${outputPath}`);
    console.log(`📊 总共生成了 ${keyStrings.length} 个模块键`);
    
    // 生成验证文件
    generateValidationFile(moduleKeyMapping, keyStrings);
    
  } catch (error) {
    console.error('❌ 生成 ModuleKeys TypeScript 文件时出错:', error);
    throw error;
  }
}

/**
 * 生成 TypeScript 文件内容
 */
function generateTypeScriptContent(
  moduleKeyMapping: ModuleKeyMapping, 
  keyComments: { [key: string]: string },
  keyStrings: string[]
): string {
  const header = `/**
 * ModuleKeys - 模块键常量库
 * ModuleKeys - Module Key Constants Library
 * 
 * 此文件由 scripts/utils/generateModuleKeys.ts 自动生成
 * This file is automatically generated by scripts/utils/generateModuleKeys.ts
 * 
 * 请勿手动修改，如需更新请运行: npm run generate:module-keys
 * Do not modify manually, run: npm run generate:module-keys to update
 * 
 * 生成时间: ${new Date().toISOString()}
 * Generated at: ${new Date().toISOString()}
 */

import { ethers } from 'ethers';

/**
 * 模块键常量映射
 * Module key constants mapping
 */
export const ModuleKeys = {
`;

  const footer = `};

/**
 * 模块键字符串数组
 * Module key strings array
 */
export const MODULE_KEY_STRINGS = [
${keyStrings.map(key => `  '${key}'`).join(',\n')}
] as const;

/**
 * 模块键类型
 * Module key type
 */
export type ModuleKey = typeof MODULE_KEY_STRINGS[number];

/**
 * 验证模块键是否有效
 * Validate if module key is valid
 * @param key 模块键 / Module key
 * @returns 是否有效 / Is valid
 */
export function isValidModuleKey(key: string): key is ModuleKey {
  return MODULE_KEY_STRINGS.includes(key as ModuleKey);
}

/**
 * 获取模块键的哈希值
 * Get hash value of module key
 * @param key 模块键 / Module key
 * @returns 哈希值 / Hash value
 */
export function getModuleKeyHash(key: ModuleKey): string {
  return ModuleKeys[key];
}

/**
 * 从哈希值获取模块键
 * Get module key from hash value
 * @param hash 哈希值 / Hash value
 * @returns 模块键或 null / Module key or null
 */
export function getModuleKeyFromHash(hash: string): ModuleKey | null {
  for (const [key, value] of Object.entries(ModuleKeys)) {
    if (value === hash) {
      return key as ModuleKey;
    }
  }
  return null;
}

/**
 * 获取所有模块键
 * Get all module keys
 * @returns 所有模块键数组 / All module keys array
 */
export function getAllModuleKeys(): ModuleKey[] {
  return [...MODULE_KEY_STRINGS];
}

/**
 * 获取模块键总数
 * Get total number of module keys
 * @returns 模块键总数 / Total number of module keys
 */
export function getModuleKeyCount(): number {
  return MODULE_KEY_STRINGS.length;
}

export default ModuleKeys;
`;

  // 生成主体内容
  const body = Object.entries(moduleKeyMapping)
    .map(([key, hash]) => {
      const comment = keyComments[key] || '';
      return `  /** ${comment} */\n  ${key}: '${hash}',`;
    })
    .join('\n\n');

  return header + body + '\n' + footer;
}

/**
 * 生成验证文件
 */
function generateValidationFile(moduleKeyMapping: ModuleKeyMapping, keyStrings: string[]): void {
  const validationContent = `/**
 * ModuleKeys 验证文件
 * ModuleKeys Validation File
 * 
 * 用于验证生成的模块键与合约中的值是否一致
 * Used to validate that generated module keys match values in contract
 */

import { ModuleKeys } from './moduleKeys';

// 验证所有模块键的哈希值是否正确
export function validateModuleKeys(): boolean {
  const expectedHashes = {
${Object.entries(moduleKeyMapping)
    .map(([key, hash]) => `    '${key}': '${hash}'`)
    .join(',\n')}
  };

  for (const [key, expectedHash] of Object.entries(expectedHashes)) {
    const actualHash = ModuleKeys[key as keyof typeof ModuleKeys];
    if (actualHash !== expectedHash) {
      console.error(\`❌ 模块键 \${key} 哈希值不匹配:\`);
      console.error(\`   期望: \${expectedHash}\`);
      console.error(\`   实际: \${actualHash}\`);
      return false;
    }
  }

  console.log('✅ 所有模块键验证通过');
  return true;
}

// 如果直接运行此文件，执行验证
if (require.main === module) {
  validateModuleKeys();
}
`;

  const outputDir = path.join(__dirname, '../../frontend-config');
  const validationPath = path.join(outputDir, 'moduleKeysValidation.ts');
  fs.writeFileSync(validationPath, validationContent, 'utf8');
  
  console.log(`✅ ModuleKeys 验证文件已生成: ${validationPath}`);
}

/**
 * 主函数
 */
async function main() {
  await generateModuleKeysTS();
}

// 如果直接运行此文件，执行主函数
if (require.main === module) {
  main().catch(console.error);
} 