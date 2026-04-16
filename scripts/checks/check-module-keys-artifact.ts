import * as fs from 'fs';
import * as path from 'path';

const SOLIDITY_SOURCE = path.resolve(__dirname, '../../src/constants/ModuleKeys.sol');
const GENERATED_ARTIFACT = path.resolve(__dirname, '../../frontend-config/moduleKeys.ts');

const REQUIRED_KEYS = [
  'KEY_VAULT_BUSINESS_LOGIC',
  'KEY_BLOCKS_ONLY_COORDINATOR',
  'KEY_BLOCKS_ONLY_VIEW',
] as const;

function parseSourceMappings(source: string): Record<string, string> {
  const pattern = /bytes32\s+internal\s+constant\s+(KEY_[A-Z0-9_]+)\s*=\s*keccak256\(\s*"([^"]+)"\s*\)\s*;/gs;
  const mapping: Record<string, string> = {};
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    mapping[match[1]] = match[2];
  }

  return mapping;
}

function parseGeneratedMappings(source: string): Record<string, string> {
  const blockMatch = source.match(/export const MODULE_KEY_INPUTS = \{([\s\S]*?)\} as const;/);
  if (!blockMatch) {
    throw new Error('frontend-config/moduleKeys.ts 缺少 MODULE_KEY_INPUTS 块');
  }

  const mapping: Record<string, string> = {};
  const entryPattern = /^\s*(KEY_[A-Z0-9_]+): '([^']+)',?$/gm;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(blockMatch[1])) !== null) {
    mapping[match[1]] = match[2];
  }

  return mapping;
}

function main(): void {
  const sourceMappings = parseSourceMappings(fs.readFileSync(SOLIDITY_SOURCE, 'utf8'));
  const generatedMappings = parseGeneratedMappings(fs.readFileSync(GENERATED_ARTIFACT, 'utf8'));

  const sourceKeys = Object.keys(sourceMappings).sort();
  const generatedKeys = Object.keys(generatedMappings).sort();

  if (sourceKeys.length === 0) {
    throw new Error('未从 ModuleKeys.sol 解析出任何 key');
  }

  if (sourceKeys.length !== generatedKeys.length) {
    throw new Error(
      `moduleKeys 产物数量不一致: source=${sourceKeys.length}, generated=${generatedKeys.length}`
    );
  }

  for (const key of sourceKeys) {
    if (!(key in generatedMappings)) {
      throw new Error(`moduleKeys 产物缺少 key: ${key}`);
    }
    if (sourceMappings[key] !== generatedMappings[key]) {
      throw new Error(
        `moduleKeys 产物值不一致: ${key}, source=${sourceMappings[key]}, generated=${generatedMappings[key]}`
      );
    }
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in generatedMappings)) {
      throw new Error(`关键迁移 key 缺失: ${key}`);
    }
  }

  console.log(`module key artifact verified: ${sourceKeys.length} keys`);
  console.log(`required migration keys present: ${REQUIRED_KEYS.join(', ')}`);
}

main();