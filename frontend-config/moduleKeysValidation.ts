/**
 * ModuleKeys 验证文件（动态计算版）
 * ModuleKeys Validation File (Dynamic Hash Computation)
 *
 * 验证动态计算的 keccak256 哈希与 Solidity 源码中的定义一致。
 * 不再硬编码期望哈希——直接从 MODULE_KEY_INPUTS 重新计算并对比。
 *
 * SSOT: contracts/src/constants/ModuleKeys.sol
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { ModuleKeys, MODULE_KEY_INPUTS, MODULE_KEY_STRINGS } from './moduleKeys';

/**
 * 验证所有模块键的哈希值是否由 MODULE_KEY_INPUTS 正确计算
 * Validate all module key hashes are correctly computed from MODULE_KEY_INPUTS
 */
export function validateModuleKeys(): boolean {
  let allPassed = true;
  let count = 0;

  for (const keyName of MODULE_KEY_STRINGS) {
    const input = MODULE_KEY_INPUTS[keyName as keyof typeof MODULE_KEY_INPUTS];
    if (!input) {
      console.error(`❌ 模块键 ${keyName} 在 MODULE_KEY_INPUTS 中未找到`);
      allPassed = false;
      continue;
    }

    // 独立计算哈希（与 ModuleKeys 计算路径隔离）
    const expectedHash = keccak256(toUtf8Bytes(input));
    const actualHash = ModuleKeys[keyName as keyof typeof ModuleKeys];

    if (actualHash !== expectedHash) {
      console.error(`❌ 模块键 ${keyName} 哈希值不匹配:`);
      console.error(`   输入: "${input}"`);
      console.error(`   期望: ${expectedHash}`);
      console.error(`   实际: ${actualHash}`);
      allPassed = false;
    } else {
      count++;
    }
  }

  if (allPassed) {
    console.log(`✅ 所有 ${count} 个模块键验证通过（零硬编码哈希）`);
  } else {
    console.error(`❌ 验证失败，${count}/${MODULE_KEY_STRINGS.length} 个通过`);
  }

  return allPassed;
}

/**
 * 抽样验证：用几个已知的 Solidity 常量值做交叉校验
 * Spot-check: cross-validate against a few known Solidity constant values
 */
export function spotCheckKnownHashes(): boolean {
  // 这些值直接来自 ModuleKeys.sol 中的 keccak256("...") 计算结果
  // 仅用于 CI 冒烟测试，不替代完整验证
  const knownPairs: [string, string, string][] = [
    ['KEY_CM', 'COLLATERAL_MANAGER', '0x413cc8bb35fe129dacd3dfaae80d6d4c5d313f64cee9dd6712e7ca52e38573a9'],
    ['KEY_VAULT_CORE', 'VAULT_CORE', '0xe0151814e20b1d3cc8d4af99449dc24a9349fc8b031a16cc617dbc86e2a93cb8'],
    ['KEY_REGISTRY', 'REGISTRY', '0x647f7c286926fbfa90ab890a66b66522dad9feca7ced0af9cf45c613acf13616'],
  ];

  let allPassed = true;
  for (const [keyName, input, expectedHash] of knownPairs) {
    const computed = keccak256(toUtf8Bytes(input));
    const fromModule = ModuleKeys[keyName as keyof typeof ModuleKeys];

    if (computed !== expectedHash || fromModule !== expectedHash) {
      console.error(`❌ 抽样校验失败: ${keyName}`);
      allPassed = false;
    }
  }

  if (allPassed) {
    console.log('✅ 抽样校验通过');
  }
  return allPassed;
}

// 如果直接运行此文件，执行验证
if (require.main === module) {
  const ok1 = validateModuleKeys();
  const ok2 = spotCheckKnownHashes();
  process.exit(ok1 && ok2 ? 0 : 1);
}
