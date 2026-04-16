import * as hardhat from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hardhat;

describe("Registry - invariant fuzz", function () {
  const TEST_MIN_DELAY = BigInt((1 * 60 * 60) / 2); // 1 hour in blocks (2s)
  const TEST_MAX_DELAY = BigInt((7 * 24 * 60 * 60) / 2); // 7 days in blocks (2s)

  const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes("LENDING_ENGINE"));
  const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes("COLLATERAL_MANAGER"));
  const KEY_PO = ethers.keccak256(ethers.toUtf8Bytes("PRICE_ORACLE"));

  async function deployFixture() {
    const [owner] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("Registry");
    const registryImplementation = await RegistryFactory.deploy();
    await registryImplementation.waitForDeployment();

    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const initData = registryImplementation.interface.encodeFunctionData("initialize", [
      TEST_MIN_DELAY,
      TEST_MAX_DELAY,
      owner.address,
      owner.address,
      owner.address,
    ]);
    const registryProxy = (await ProxyFactory.deploy(registryImplementation.target, initData)) as any;
    await registryProxy.waitForDeployment();

    const registry = registryImplementation.attach(registryProxy.target) as any;

    const MockLendingEngineConcreteFactory = await ethers.getContractFactory("MockLendingEngineConcrete");
    const mockLendingEngine = (await MockLendingEngineConcreteFactory.deploy()) as any;
    await mockLendingEngine.waitForDeployment();

    const MockCollateralManagerFactory = await ethers.getContractFactory("MockCollateralManager");
    const mockCollateralManager = (await MockCollateralManagerFactory.deploy()) as any;
    await mockCollateralManager.waitForDeployment();

    const MockPriceOracleFactory = await ethers.getContractFactory("MockPriceOracle");
    const mockPriceOracle = (await MockPriceOracleFactory.deploy()) as any;
    await mockPriceOracle.waitForDeployment();

    return {
      registry,
      mockLendingEngine,
      mockCollateralManager,
      mockPriceOracle,
    };
  }

  function makeRng(seed: number) {
    let x = seed >>> 0;
    return () => {
      x = (x * 1103515245 + 12345) % 0x80000000;
      return x;
    };
  }

  it("maintains last-write-wins for module mapping", async function () {
    const { registry, mockLendingEngine, mockCollateralManager, mockPriceOracle } = await loadFixture(deployFixture);

    const keys = [KEY_LE, KEY_CM, KEY_PO];
    const addrs = [mockLendingEngine.target, mockCollateralManager.target, mockPriceOracle.target];

    const rng = makeRng(20260305);
    const expected = new Map<string, string>();

    for (let i = 0; i < 40; i += 1) {
      const mode = rng() % 4;
      if (mode === 0) {
        const batchSize = 2 + (rng() % 2);
        const batchKeys: string[] = [];
        const batchAddrs: string[] = [];
        for (let j = 0; j < batchSize; j += 1) {
          const key = keys[rng() % keys.length];
          const addr = addrs[rng() % addrs.length] as string;
          batchKeys.push(key);
          batchAddrs.push(addr);
          expected.set(key, addr);
        }
        await registry.batchSetModules(batchKeys, batchAddrs, true);
      } else {
        const key = keys[rng() % keys.length];
        const addr = addrs[rng() % addrs.length] as string;
        await registry.setModule(key, addr);
        expected.set(key, addr);
      }

      for (const [key, addr] of expected.entries()) {
        const onchain = await registry.getModuleOrRevert(key);
        expect(onchain).to.equal(addr);
      }
    }
  });
});
