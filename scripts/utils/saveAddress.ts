/**
 * 部署地址管理工具
 * Deployment Address Management Utility
 * 
 * 提供统一的地址记录与管理系统，支持多网络部署
 * Provides unified address recording and management system for multi-network deployment
 */

import * as fs from 'fs';
import * as path from 'path';

export interface NetworkInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
}

export interface DeploymentRecord {
  network: NetworkInfo;
  deployer: string;
  version: string;
  description: string;
  timestamp: number;
  contracts: AddressConfig;
  proxyAddresses?: Record<string, string>;
  implementationAddresses?: Record<string, string>;
}

export interface AddressConfig {
  [contractName: string]: {
    address: string;
    proxyAddress?: string;
    implementationAddress?: string;
    deployedAt: number;
    deployedBy: string;
  };
}

export class AddressManager {
  private readonly baseDir: string;
  private readonly network: string;
  private readonly networkInfo: NetworkInfo;
  private addresses: AddressConfig = {};
  private deploymentRecord?: DeploymentRecord;

  constructor(network: string, networkInfo: NetworkInfo, baseDir: string = 'scripts/deployments') {
    this.network = network;
    this.networkInfo = networkInfo;
    this.baseDir = baseDir;
    
    // Ensure directory exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    // Load existing addresses if file exists
    this.loadAddresses();
  }

  /**
   * Save a contract address
   */
  saveAddress(contractName: string, address: string, deployer: string, options?: {
    proxyAddress?: string;
    implementationAddress?: string;
  }): void {
    this.addresses[contractName] = {
      address,
      proxyAddress: options?.proxyAddress,
      implementationAddress: options?.implementationAddress,
      deployedAt: Date.now(),
      deployedBy: deployer
    };

    this.writeAddresses();
    console.log(`✅ Saved ${contractName}: ${address}`);
  }

  /**
   * Update an existing contract address
   */
  updateAddress(contractName: string, newAddress: string, deployer: string, options?: {
    proxyAddress?: string;
    implementationAddress?: string;
  }): void {
    if (!this.addresses[contractName]) {
      throw new Error(`Contract ${contractName} not found in address registry`);
    }

    // Create backup before updating
    this.createBackup();

    this.addresses[contractName] = {
      address: newAddress,
      proxyAddress: options?.proxyAddress || this.addresses[contractName].proxyAddress,
      implementationAddress: options?.implementationAddress || this.addresses[contractName].implementationAddress,
      deployedAt: Date.now(),
      deployedBy: deployer
    };

    this.writeAddresses();
    console.log(`🔄 Updated ${contractName}: ${newAddress}`);
  }

  /**
   * Get a contract address
   */
  getAddress(contractName: string): string {
    const contract = this.addresses[contractName];
    if (!contract) {
      throw new Error(`Contract ${contractName} not found in address registry`);
    }
    return contract.address;
  }

  /**
   * Get proxy address if available
   */
  getProxyAddress(contractName: string): string | undefined {
    return this.addresses[contractName]?.proxyAddress;
  }

  /**
   * Get implementation address if available
   */
  getImplementationAddress(contractName: string): string | undefined {
    return this.addresses[contractName]?.implementationAddress;
  }

  /**
   * Check if a contract address exists
   */
  hasAddress(contractName: string): boolean {
    return !!this.addresses[contractName];
  }

  /**
   * Get all contract addresses
   */
  getAllAddresses(): AddressConfig {
    return { ...this.addresses };
  }

  /**
   * Get contract names as array
   */
  getContractNames(): string[] {
    return Object.keys(this.addresses);
  }

  /**
   * Create a backup of current addresses
   */
  createBackup(): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(this.baseDir, 'backups');
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const backupFile = path.join(backupDir, `addresses.${this.network}.${timestamp}.json`);
    const backupData = {
      network: this.networkInfo,
      timestamp: Date.now(),
      addresses: this.addresses
    };

    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
    console.log(`💾 Backup created: ${backupFile}`);
  }

  /**
   * Validate all addresses are valid Ethereum addresses
   */
  validateAddresses(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;

    for (const [contractName, contract] of Object.entries(this.addresses)) {
      if (!ethAddressRegex.test(contract.address)) {
        errors.push(`Invalid address for ${contractName}: ${contract.address}`);
      }
      
      if (contract.proxyAddress && !ethAddressRegex.test(contract.proxyAddress)) {
        errors.push(`Invalid proxy address for ${contractName}: ${contract.proxyAddress}`);
      }
      
      if (contract.implementationAddress && !ethAddressRegex.test(contract.implementationAddress)) {
        errors.push(`Invalid implementation address for ${contractName}: ${contract.implementationAddress}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Generate frontend configuration
   */
  generateFrontendConfig(outputDir: string = 'frontend-config'): void {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const config = {
      network: this.networkInfo,
      contracts: this.addresses,
      lastUpdated: Date.now()
    };

    const configFile = path.join(outputDir, `contracts-${this.network}.json`);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    console.log(`📁 Frontend config generated: ${configFile}`);
  }

  /**
   * Generate deployment summary
   */
  generateSummary(): void {
    console.log('\n📊 Deployment Summary');
    console.log('====================');
    console.log(`Network: ${this.networkInfo.name} (${this.networkInfo.chainId})`);
    console.log(`Total Contracts: ${Object.keys(this.addresses).length}`);
    console.log(`Last Updated: ${new Date().toLocaleString()}`);
    
    console.log('\n📋 Contract Addresses:');
    for (const [contractName, contract] of Object.entries(this.addresses)) {
      console.log(`  ${contractName}: ${contract.address}`);
      if (contract.proxyAddress) {
        console.log(`    Proxy: ${contract.proxyAddress}`);
      }
      if (contract.implementationAddress) {
        console.log(`    Implementation: ${contract.implementationAddress}`);
      }
    }

    // Validation
    const validation = this.validateAddresses();
    if (!validation.valid) {
      console.log('\n❌ Validation Errors:');
      validation.errors.forEach(error => console.log(`  ${error}`));
    } else {
      console.log('\n✅ All addresses are valid');
    }
  }

  /**
   * Load addresses from file
   */
  private loadAddresses(): void {
    const filePath = this.getAddressFilePath();
    
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.addresses = data.contracts || {};
        this.deploymentRecord = data;
        console.log(`📖 Loaded ${Object.keys(this.addresses).length} addresses from ${filePath}`);
      } catch (error) {
        console.warn(`⚠️ Failed to load addresses from ${filePath}:`, error);
        this.addresses = {};
      }
    } else {
      console.log(`📝 No existing address file found for ${this.network}, starting fresh`);
      this.addresses = {};
    }
  }

  /**
   * Write addresses to file
   */
  private writeAddresses(): void {
    const filePath = this.getAddressFilePath();
    
    this.deploymentRecord = {
      network: this.networkInfo,
      deployer: this.getDeployerFromAddresses(),
      version: '1.0.0',
      description: `RWA Lending Platform deployment on ${this.networkInfo.name}`,
      timestamp: Date.now(),
      contracts: this.addresses
    };

    fs.writeFileSync(filePath, JSON.stringify(this.deploymentRecord, null, 2));
  }

  /**
   * Get address file path
   */
  private getAddressFilePath(): string {
    return path.join(this.baseDir, `addresses.${this.network}.json`);
  }

  /**
   * Extract deployer from addresses (assumes all contracts deployed by same address)
   */
  private getDeployerFromAddresses(): string {
    const firstContract = Object.values(this.addresses)[0];
    return firstContract?.deployedBy || 'unknown';
  }
}

// Convenience functions for common operations
export const createAddressManager = (network: string, networkInfo: NetworkInfo): AddressManager => {
  return new AddressManager(network, networkInfo);
};

export const saveContractAddress = (
  manager: AddressManager,
  contractName: string,
  address: string,
  deployer: string,
  options?: { proxyAddress?: string; implementationAddress?: string }
): void => {
  manager.saveAddress(contractName, address, deployer, options);
};

export const getContractAddress = (manager: AddressManager, contractName: string): string => {
  return manager.getAddress(contractName);
};

export const validateDeployment = (manager: AddressManager): boolean => {
  const validation = manager.validateAddresses();
  if (!validation.valid) {
    console.error('❌ Deployment validation failed:');
    validation.errors.forEach(error => console.error(`  ${error}`));
    return false;
  }
  return true;
};

export const generateDeploymentArtifacts = (manager: AddressManager): void => {
  manager.createBackup();
  manager.generateFrontendConfig();
  manager.generateSummary();
}; 