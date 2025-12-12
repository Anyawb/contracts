#!/usr/bin/env ts-node

import hardhat from 'hardhat';
const { ethers } = hardhat as unknown as { ethers: typeof import('ethers'); } as any;

// Helper: compute keccak256 of uppercase identifiers used in ModuleKeys/ActionKeys
function k256(text: string): string {
	return ethers.keccak256(ethers.toUtf8Bytes(text));
}

async function safeGetModule(registry: any, key: string, label: string): Promise<string> {
	try {
		const addr = await registry.getModule(key);
		if (addr && addr !== ethers.ZeroAddress) {
			console.log(`[Registry] ${label} ->`, addr);
			return addr;
		}
		console.log(`[Registry] ${label} is not registered (0x0)`);
		return ethers.ZeroAddress;
	} catch (e) {
		console.log(`[Registry] ${label} lookup failed, module likely not registered.`);
		return ethers.ZeroAddress;
	}
}

async function main(): Promise<void> {
	const envRegistry = process.env.REGISTRY_ADDRESS as string | undefined;
	const vaultAdminAddress = process.env.VAULT_ADMIN_ADDRESS as string | undefined;
	let governanceAddress = process.env.GOVERNANCE_CALLER as string;
	if (!envRegistry && !vaultAdminAddress) {
		console.error('Provide REGISTRY_ADDRESS or VAULT_ADMIN_ADDRESS');
		process.exitCode = 1;
		return;
	}
	if (!governanceAddress) {
		const [signer] = await (hardhat as any).ethers.getSigners();
		governanceAddress = await signer.getAddress();
		console.log('[Fallback] GOVERNANCE_CALLER not set, using first signer =', governanceAddress);
	}

	let registryAddr: string;
	if (envRegistry) {
		registryAddr = envRegistry;
		console.log('[Input] REGISTRY_ADDRESS =', registryAddr);
	} else {
		const vaultAdmin = await (hardhat as any).ethers.getContractAt('VaultAdmin', vaultAdminAddress);
		registryAddr = await vaultAdmin.getRegistryAddr();
		console.log('[VaultAdmin] registry =', registryAddr);
	}

	const registry = await (hardhat as any).ethers.getContractAt('IRegistry', registryAddr);

	const KEY_ACCESS_CONTROL = k256('ACCESS_CONTROL_MANAGER');
	const KEY_LRM = k256('LIQUIDATION_RISK_MANAGER');
	const ACTION_SET_PARAMETER = k256('SET_PARAMETER');

	const acmAddr = await safeGetModule(registry, KEY_ACCESS_CONTROL, 'KEY_ACCESS_CONTROL');
	const lrmAddr = await safeGetModule(registry, KEY_LRM, 'KEY_LIQUIDATION_RISK_MANAGER');

	if (acmAddr === ethers.ZeroAddress) {
		console.log('Result: ACM not registered. Cannot check role.');
		return;
	}

	const acm = await (hardhat as any).ethers.getContractAt('IAccessControlManager', acmAddr);
	const hasRole: boolean = await acm.hasRole(ACTION_SET_PARAMETER, governanceAddress);
	console.log(`[ACM] caller(${governanceAddress}) has ACTION_SET_PARAMETER =`, hasRole);
	console.log('✅ Script finished.');
}

if (require.main === module) {
	main().catch((err) => {
		console.error('check-vaultadmin-registry failed:', err);
		process.exitCode = 1;
	});
}
