import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('VaultAccessUpgrade gates', function () {
	const MIN_DELAY = 6n;
	const MAX_DELAY = 1000n;
	const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));

	async function deployRegistryUpgradeFixture() {
		const [owner, upgradeAdmin, emergencyAdmin, operator] = await ethers.getSigners();

		const RegistryFactory = await ethers.getContractFactory('Registry');
		const registryImpl = await RegistryFactory.deploy();
		await registryImpl.waitForDeployment();

		const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
		const initData = registryImpl.interface.encodeFunctionData('initialize', [
			MIN_DELAY,
			MAX_DELAY,
			upgradeAdmin.address,
			emergencyAdmin.address,
			owner.address,
		]);
		const proxy = await ProxyFactory.deploy(await registryImpl.getAddress(), initData);
		await proxy.waitForDeployment();

		const registry = RegistryFactory.attach(await proxy.getAddress()) as any;

		const MockLendingEngineFactory = await ethers.getContractFactory('MockLendingEngineConcrete');
		const currentModule = await MockLendingEngineFactory.deploy();
		await currentModule.waitForDeployment();
		const nextModule = await MockLendingEngineFactory.deploy();
		await nextModule.waitForDeployment();

		await registry.connect(owner).setModule(KEY_LE, await currentModule.getAddress());

		return {
			owner,
			upgradeAdmin,
			emergencyAdmin,
			operator,
			proxy,
			registry,
			currentModule,
			nextModule,
		};
	}

	it('UPG-AUTH-01 and UPG-AUTH-03 reject unauthorized Registry upgrades without changing implementation', async function () {
		const { operator, proxy, registry } = await loadFixture(deployRegistryUpgradeFixture);
		const beforeImpl = await upgrades.erc1967.getImplementationAddress(await proxy.getAddress());

		const RegistryFactory = await ethers.getContractFactory('Registry');
		const safeImpl = await RegistryFactory.deploy();
		await safeImpl.waitForDeployment();

		await expect(
			registry.connect(operator).upgradeToAndCall(await safeImpl.getAddress(), '0x')
		)
			.to.be.revertedWithCustomError(registry, 'Registry__NotUpgradeAdmin')
			.withArgs(operator.address);

		expect(await upgrades.erc1967.getImplementationAddress(await proxy.getAddress())).to.equal(beforeImpl);
		expect(await registry.owner()).to.equal((await ethers.getSigners())[0].address);
	});

	it('UPG-FAIL-04 keeps implementation slot and governance state aligned after an authorized upgrade', async function () {
		const { proxy, registry, upgradeAdmin, owner } = await loadFixture(deployRegistryUpgradeFixture);
		const RegistryFactory = await ethers.getContractFactory('Registry');
		const safeImpl = await RegistryFactory.deploy();
		await safeImpl.waitForDeployment();

		await registry.connect(upgradeAdmin).upgradeToAndCall(await safeImpl.getAddress(), '0x');

		expect(await upgrades.erc1967.getImplementationAddress(await proxy.getAddress())).to.equal(await safeImpl.getAddress());
		expect(await registry.owner()).to.equal(owner.address);
		expect(await registry.getUpgradeAdmin()).to.equal(upgradeAdmin.address);
	});

	it('UPG-AUTH-02 enforces the Registry timelock queue before a module route can change', async function () {
		const { owner, registry, currentModule, nextModule } = await loadFixture(deployRegistryUpgradeFixture);

		await registry.connect(owner).scheduleModuleUpgrade(KEY_LE, await nextModule.getAddress());
		await expect(registry.connect(owner).executeModuleUpgrade(KEY_LE))
			.to.be.revertedWithCustomError(registry, 'ModuleUpgradeNotReady');

		await ethers.provider.send('hardhat_mine', [`0x${MIN_DELAY.toString(16)}`]);
		await registry.connect(owner).executeModuleUpgrade(KEY_LE);

		expect(await registry.getModule(KEY_LE)).to.equal(await nextModule.getAddress());
		expect(await registry.getModule(KEY_LE)).to.not.equal(await currentModule.getAddress());
	});

	it('UPG-AUTH-04 blocks malicious upgradeToAndCall payloads from unauthorized callers', async function () {
		const { operator, registry, proxy, owner } = await loadFixture(deployRegistryUpgradeFixture);
		const beforeImpl = await upgrades.erc1967.getImplementationAddress(await proxy.getAddress());

		const AttackFactory = await ethers.getContractFactory('RegistryUpgradeAttackMock');
		const attackImpl = await AttackFactory.deploy();
		await attackImpl.waitForDeployment();
		const payload = attackImpl.interface.encodeFunctionData('seizeOwner', [operator.address]);

		await expect(
			registry.connect(operator).upgradeToAndCall(await attackImpl.getAddress(), payload)
		)
			.to.be.revertedWithCustomError(registry, 'Registry__NotUpgradeAdmin')
			.withArgs(operator.address);

		expect(await upgrades.erc1967.getImplementationAddress(await proxy.getAddress())).to.equal(beforeImpl);
		expect(await registry.owner()).to.equal(owner.address);
	});
});

