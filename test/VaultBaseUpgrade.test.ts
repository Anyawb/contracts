import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('VaultBaseUpgrade gates', function () {
	async function deployUpgradeableVaultFixture() {
		const [owner, operator] = await ethers.getSigners();

		const V1Factory = await ethers.getContractFactory('VaultBaseUpgradeMockV1');
		const proxy = await upgrades.deployProxy(V1Factory, [owner.address, 42n], {
			kind: 'uups',
			initializer: 'initialize',
		});
		await proxy.waitForDeployment();

		return {
			owner,
			operator,
			proxy,
		};
	}

	it('UPG-FAIL-01 blocks incompatible storage layouts and keeps the proxy healthy', async function () {
		const { proxy } = await loadFixture(deployUpgradeableVaultFixture);
		const beforeImpl = await upgrades.erc1967.getImplementationAddress(await proxy.getAddress());
		const BadLayoutFactory = await ethers.getContractFactory('VaultBaseUpgradeMockBadLayout');

		let failure: unknown;
		try {
			await upgrades.upgradeProxy(await proxy.getAddress(), BadLayoutFactory);
		} catch (error) {
			failure = error;
		}

		expect(failure).to.be.instanceOf(Error);
		expect(String((failure as Error).message)).to.match(/layout|storage|upgrade/i);
		expect(await upgrades.erc1967.getImplementationAddress(await proxy.getAddress())).to.equal(beforeImpl);
		expect(await proxy.totalValue()).to.equal(42n);
	});

	it('UPG-FAIL-02 detects an upgrade that skipped the required reinitializer', async function () {
		const { proxy } = await loadFixture(deployUpgradeableVaultFixture);
		const V2Factory = await ethers.getContractFactory('VaultBaseUpgradeMockV2');

		const upgraded = await upgrades.upgradeProxy(await proxy.getAddress(), V2Factory);
		await upgraded.waitForDeployment();

		expect(await upgraded.version()).to.equal(2n);
		expect(await upgraded.totalValue()).to.equal(42n);
		expect(await upgraded.v2Initialized()).to.equal(false);
		expect(await upgraded.upgradeCounter()).to.equal(0n);

		await upgraded.initializeV2(7n);
		expect(await upgraded.v2Initialized()).to.equal(true);
		expect(await upgraded.upgradeCounter()).to.equal(7n);
	});

	it('UPG-FAIL-03 rejects upgrades to a non-UUPS implementation and preserves the old implementation', async function () {
		const { proxy } = await loadFixture(deployUpgradeableVaultFixture);
		const beforeImpl = await upgrades.erc1967.getImplementationAddress(await proxy.getAddress());
		const WrongImplFactory = await ethers.getContractFactory('MockSimpleContract');
		const wrongImpl = await WrongImplFactory.deploy();
		await wrongImpl.waitForDeployment();

		await expect(proxy.upgradeToAndCall(await wrongImpl.getAddress(), '0x')).to.be.reverted;
		expect(await upgrades.erc1967.getImplementationAddress(await proxy.getAddress())).to.equal(beforeImpl);
		expect(await proxy.totalValue()).to.equal(42n);
	});

	it('UPG-RB-01 and UPG-RB-02 preserve core state across v1 -> v2 -> v1 rollback', async function () {
		const { owner, operator, proxy } = await loadFixture(deployUpgradeableVaultFixture);
		const V2Factory = await ethers.getContractFactory('VaultBaseUpgradeMockV2');

		const upgraded = await upgrades.upgradeProxy(await proxy.getAddress(), V2Factory, {
			call: {
				fn: 'initializeV2',
				args: [5n],
			},
		});
		await upgraded.waitForDeployment();

		await upgraded.setTotalValue(99n);
		await upgraded.setOperator(operator.address);
		await upgraded.recordUpgradeCheckpoint(11n);

		const rollbackImpl = await V2Factory.attach(await upgraded.getAddress());
		const V1Factory = await ethers.getContractFactory('VaultBaseUpgradeMockV1');
		const v1Impl = await V1Factory.deploy();
		await v1Impl.waitForDeployment();

		await rollbackImpl.connect(owner).upgradeToAndCall(await v1Impl.getAddress(), '0x');

		const rolledBack = V1Factory.attach(await upgraded.getAddress()) as any;
		expect(await rolledBack.version()).to.equal(1n);
		expect(await rolledBack.totalValue()).to.equal(99n);
		expect(await rolledBack.operator()).to.equal(operator.address);

		await rolledBack.connect(owner).setTotalValue(123n);
		expect(await rolledBack.totalValue()).to.equal(123n);
	});

	it('UPG-RB-03 recovers to a known-safe implementation after a failed upgrade attempt', async function () {
		const { proxy } = await loadFixture(deployUpgradeableVaultFixture);
		const beforeImpl = await upgrades.erc1967.getImplementationAddress(await proxy.getAddress());
		const WrongImplFactory = await ethers.getContractFactory('MockSimpleContract');
		const wrongImpl = await WrongImplFactory.deploy();
		await wrongImpl.waitForDeployment();

		await expect(proxy.upgradeToAndCall(await wrongImpl.getAddress(), '0x')).to.be.reverted;
		expect(await upgrades.erc1967.getImplementationAddress(await proxy.getAddress())).to.equal(beforeImpl);

		const V2Factory = await ethers.getContractFactory('VaultBaseUpgradeMockV2');
		const recovered = await upgrades.upgradeProxy(await proxy.getAddress(), V2Factory, {
			call: {
				fn: 'initializeV2',
				args: [13n],
			},
		});
		await recovered.waitForDeployment();

		expect(await recovered.version()).to.equal(2n);
		expect(await recovered.v2Initialized()).to.equal(true);
		expect(await recovered.upgradeCounter()).to.equal(13n);
	});
});

