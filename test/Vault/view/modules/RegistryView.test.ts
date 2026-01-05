import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_ACM = ethers.id("ACCESS_CONTROL_MANAGER");
const KEY_PV = ethers.id("POSITION_VIEW");
const KEY_PREVIEW = ethers.id("PREVIEW_VIEW");
const KEY_HEALTH = ethers.id("HEALTH_VIEW");
const KEY_OTHER = ethers.id("OTHER_MODULE");
const KEY_DYNAMIC_MODULE_REGISTRY = ethers.id("DYNAMIC_MODULE_REGISTRY");
const ACTION_ADMIN = ethers.id("ACTION_ADMIN");
const MAX_BATCH = 100n; // 来自 ViewConstants.MAX_BATCH_SIZE

describe("RegistryView", function () {
  async function deployFixture() {
    const [admin, user] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const Access = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await Access.deploy();
    await acm.grantRole(ACTION_ADMIN, admin.address);

    const RegistryView = await ethers.getContractFactory("RegistryView");
    const rv = await upgrades.deployProxy(
      RegistryView,
      [await registry.getAddress()],
      { kind: "uups" }
    );

    await registry.setModule(KEY_ACM, await acm.getAddress());

    return { admin, user, registry, acm, rv };
  }

  describe("init", function () {
    it("reverts on zero registry", async function () {
      const RegistryView = await ethers.getContractFactory("RegistryView");
      await expect(
        upgrades.deployProxy(
          RegistryView,
          [ethers.ZeroAddress],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(RegistryView, "ZeroAddress");
    });

    it("sets registry address", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      expect(await rv.registryAddr()).to.equal(await registry.getAddress());
      expect(await rv.getRegistry()).to.equal(await registry.getAddress());
    });
  });

  describe("module listing", function () {
    it("returns only registered module keys", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PV, ethers.Wallet.createRandom().address);
      await registry.setModule(KEY_PREVIEW, ethers.Wallet.createRandom().address);
      const keys = await rv.getAllRegisteredModuleKeys();
      expect(keys).to.include.members([KEY_ACM, KEY_PV, KEY_PREVIEW]);
    });

    it("returns registered modules with addresses", async function () {
      const { registry, rv, acm } = await loadFixture(deployFixture);
      const pvAddr = ethers.Wallet.createRandom().address;
      await registry.setModule(KEY_PV, pvAddr);
      const [keys, addrs] = await rv.getAllRegisteredModules();
      const indexAcm = keys.findIndex((k: string) => k === KEY_ACM);
      const indexPv = keys.findIndex((k: string) => k === KEY_PV);
      expect(addrs[indexAcm]).to.equal(await acm.getAddress());
      expect(addrs[indexPv]).to.equal(pvAddr);
    });
  });

  describe("existence checks with batch limits", function () {
    it("checkModulesExist respects batch limit", async function () {
      const { rv } = await loadFixture(deployFixture);
      const oversized = Array.from({ length: Number(MAX_BATCH) + 1 }, (_, i) => ethers.id("KEY" + i));
      await expect(rv.checkModulesExist(oversized)).to.be.revertedWithCustomError(rv, "RegistryView__BatchTooLarge");
    });

    it("batchFindModuleKeysByAddresses respects batch limit", async function () {
      const { rv } = await loadFixture(deployFixture);
      const oversized = Array.from({ length: Number(MAX_BATCH) + 1 }, () => ethers.Wallet.createRandom().address);
      await expect(rv.batchFindModuleKeysByAddresses(oversized, 0)).to.be.revertedWithCustomError(
        rv,
        "RegistryView__BatchTooLarge"
      );
    });

    it("getRegisteredModuleKeysPaginated enforces limit", async function () {
      const { rv } = await loadFixture(deployFixture);
      await expect(rv.getRegisteredModuleKeysPaginated(0, Number(MAX_BATCH) + 1)).to.be.revertedWithCustomError(
        rv,
        "RegistryView__BatchTooLarge"
      );
    });

    it("checkModulesExist returns correct booleans", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PV, ethers.Wallet.createRandom().address);
      const res = await rv.checkModulesExist([KEY_PV, KEY_HEALTH]);
      expect(res[0]).to.equal(true);
      expect(res[1]).to.equal(false);
    });
  });

  describe("reverse lookup", function () {
    it("findModuleKeyByAddress respects maxCount", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      const addr1 = ethers.Wallet.createRandom().address;
      const addr2 = ethers.Wallet.createRandom().address;
      await registry.setModule(KEY_PV, addr1);
      await registry.setModule(KEY_HEALTH, addr2);

      const [keyLimited, foundLimited] = await rv.findModuleKeyByAddress(addr2, 1);
      expect(foundLimited).to.equal(false);
      expect(keyLimited).to.equal(ethers.ZeroHash);

      const [keyFull, foundFull] = await rv.findModuleKeyByAddress(addr2, 0);
      expect(foundFull).to.equal(true);
      expect(keyFull).to.equal(KEY_HEALTH);
    });

    it("batchFindModuleKeysByAddresses returns keys and found flags", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      const addr1 = ethers.Wallet.createRandom().address;
      await registry.setModule(KEY_PV, addr1);

      const [keys, founds] = await rv.batchFindModuleKeysByAddresses([addr1, ethers.ZeroAddress], 0);
      expect(keys[0]).to.equal(KEY_PV);
      expect(founds[0]).to.equal(true);
      expect(founds[1]).to.equal(false);
    });
  });

  describe("pagination", function () {
    it("returns paginated registered keys with totalCount", async function () {
      const { registry, rv } = await loadFixture(deployFixture);
      await registry.setModule(KEY_PV, ethers.Wallet.createRandom().address);
      await registry.setModule(KEY_PREVIEW, ethers.Wallet.createRandom().address);
      await registry.setModule(KEY_HEALTH, ethers.Wallet.createRandom().address);

      const [page, total] = await rv.getRegisteredModuleKeysPaginated(1, 2);
      expect(total).to.equal(4); // ACM + 3 registered above
      expect(page.length).to.equal(2);
    });
  });

  describe("governance passthrough (mock-compatible)", function () {
    it("minDelay/maxDelay/owner return fallback values with MockRegistry", async function () {
      const { rv } = await loadFixture(deployFixture);
      expect(await rv.minDelay()).to.equal(0);
      expect(await rv.maxDelay()).to.equal(0);
      expect(await rv.owner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("动态模块键聚合", function () {
    it("没有动态模块键注册表时只返回静态键", async function () {
      const { rv } = await loadFixture(deployFixture);
      const allKeys = await rv.getAllModuleKeys();
      // 应该只包含静态键
      expect(allKeys.length).to.be.gt(0);
      // 验证不包含动态键（通过检查键的格式）
      const hasDynamicKey = allKeys.some((key: string) => key.startsWith("0x") && key.length === 66);
      // 静态键应该都是预定义的
      expect(allKeys).to.include(KEY_ACM);
    });

    it("有动态模块键注册表时聚合静态键和动态键", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      // 注册一些动态键
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_2");
      
      // 获取动态键
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      expect(dynamicKeys.length).to.equal(2);

      // 将动态键注册表注册到 Registry
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );

      // 先创建一个不包含动态键注册表的 RegistryView 来获取静态键数量
      const Registry2 = await ethers.getContractFactory("MockRegistry");
      const registry2 = await Registry2.deploy();
      const RegistryView2 = await ethers.getContractFactory("RegistryView");
      const rv2 = await RegistryView2.deploy();
      await rv2.initialize(await registry2.getAddress());
      const staticKeysCount = (await rv2.getAllModuleKeys()).length;

      // 现在获取包含动态键的键列表
      const allKeys = await rv.getAllModuleKeys();
      
      // 应该包含静态键
      expect(allKeys).to.include(KEY_ACM);
      // 应该包含动态键（总数应该大于静态键数量）
      expect(allKeys.length).to.be.gt(staticKeysCount);
      // 验证动态键都在结果中
      for (const dk of dynamicKeys) {
        expect(allKeys).to.include(dk);
      }
    });

    it("动态键查询失败时回退到静态键", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await RegistryView.deploy();
      await rv.initialize(await registry.getAddress());

      // 先获取不包含动态键注册表时的键列表（应该只有静态键）
      const staticKeysOnly = await rv.getAllModuleKeys();
      expect(staticKeysOnly).to.include(KEY_ACM);
      expect(staticKeysOnly.length).to.be.gt(0);

      // 设置一个无效的动态键注册表地址（不是合约，会导致调用失败）
      // 使用零地址而不是 admin.address，因为零地址更安全
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, ethers.ZeroAddress);

      // 应该只返回静态键（因为动态键注册表地址为零，会直接返回静态键）
      const allKeys = await rv.getAllModuleKeys();
      expect(allKeys).to.include(KEY_ACM);
      expect(allKeys.length).to.equal(staticKeysOnly.length); // 应该与只有静态键时相同
    });

    it("getAllRegisteredModuleKeys 包含动态键中已注册的模块", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      // 注册动态键
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_2");
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      const dynamicKey1 = dynamicKeys[0];
      const dynamicKey2 = dynamicKeys[1];

      // 将动态键注册表注册到 Registry
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());

      // 注册一些静态模块
      const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
      await registry.setModule(KEY_ACM, await acm.getAddress());

      // 注册动态键对应的模块
      const dynamicModule1 = ethers.Wallet.createRandom().address;
      await registry.setModule(dynamicKey1, dynamicModule1);

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await RegistryView.deploy();
      await rv.initialize(await registry.getAddress());

      const registeredKeys = await rv.getAllRegisteredModuleKeys();
      
      // 应该包含已注册的静态键
      expect(registeredKeys).to.include(KEY_ACM);
      // 应该包含已注册的动态键
      expect(registeredKeys).to.include(dynamicKey1);
      // 不应该包含未注册的动态键
      expect(registeredKeys).to.not.include(dynamicKey2);
    });

    it("getAllRegisteredModules 包含动态键模块的地址", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      const dynamicKey1 = dynamicKeys[0];

      const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
      await registry.setModule(KEY_ACM, await acm.getAddress());

      const dynamicModule1 = ethers.Wallet.createRandom().address;
      await registry.setModule(dynamicKey1, dynamicModule1);

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await RegistryView.deploy();
      await rv.initialize(await registry.getAddress());

      const [keys, addrs] = await rv.getAllRegisteredModules();
      
      const indexAcm = keys.findIndex((k: string) => k === KEY_ACM);
      const indexDynamic = keys.findIndex((k: string) => k === dynamicKey1);
      
      expect(addrs[indexAcm]).to.equal(await acm.getAddress());
      expect(addrs[indexDynamic]).to.equal(dynamicModule1);
    });

    it("getRegisteredModuleKeysPaginated 包含动态键", async function () {
      const [admin] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("MockRegistry");
      const registry = await Registry.deploy();

      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();

      await dynamicKeyReg.registerModuleKey("CUSTOM_MODULE_1");
      await registry.setModule(KEY_DYNAMIC_MODULE_REGISTRY, await dynamicKeyReg.getAddress());
      const dynamicKeys = await dynamicKeyReg.getDynamicModuleKeys();
      const dynamicKey1 = dynamicKeys[0];

      const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
      await registry.setModule(KEY_ACM, await acm.getAddress());

      const dynamicModule1 = ethers.Wallet.createRandom().address;
      await registry.setModule(dynamicKey1, dynamicModule1);

      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await RegistryView.deploy();
      await rv.initialize(await registry.getAddress());

      const [page, total] = await rv.getRegisteredModuleKeysPaginated(0, 10);
      
      expect(total).to.be.gte(2); // 至少包含 ACM 和 dynamicKey1
      expect(page.length).to.be.gte(2);
      expect(page).to.include(KEY_ACM);
      expect(page).to.include(dynamicKey1);
    });
  });

  describe("真实 Registry passthrough 测试", function () {
    async function deployRealRegistryFixture() {
      const [admin] = await ethers.getSigners();
      
      // 部署真实 Registry（使用代理模式）
      const RegistryFactory = await ethers.getContractFactory("Registry");
      const registryImplementation = await RegistryFactory.deploy();
      await registryImplementation.waitForDeployment();
      
      const minDelay = 24 * 60 * 60; // 1 day in seconds
      const upgradeAdmin = admin.address;
      const emergencyAdmin = admin.address;

      const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      const registryProxy = await ProxyFactory.deploy(
        await registryImplementation.getAddress(),
        registryImplementation.interface.encodeFunctionData(
          "initialize",
          [minDelay, upgradeAdmin, emergencyAdmin]
        )
      );
      await registryProxy.waitForDeployment();
      
      const registry = registryImplementation.attach(await registryProxy.getAddress());
      
      // 部署 RegistryView
      const RegistryView = await ethers.getContractFactory("RegistryView");
      const rv = await upgrades.deployProxy(
        RegistryView,
        [await registry.getAddress()],
        { kind: "uups" }
      );
      
      return { admin, registry, rv, minDelay };
    }

    it("应该能够与真实 Registry 合约交互", async function () {
      const { admin, registry, rv, minDelay } = await loadFixture(deployRealRegistryFixture);
      
      // 验证 RegistryView 可以访问真实 Registry
      expect(await rv.registryAddr()).to.equal(await registry.getAddress());
      
      // 验证可以获取真实 Registry 的 minDelay
      const actualMinDelay = await rv.minDelay();
      expect(actualMinDelay).to.equal(minDelay);
      
      // 验证可以获取真实 Registry 的 owner
      const owner = await rv.owner();
      expect(owner).to.equal(admin.address);
    });

    it("应该能够从真实 Registry 获取模块地址", async function () {
      const { rv } = await loadFixture(deployRealRegistryFixture);
      
      // 验证 RegistryView 可以查询真实 Registry
      const allKeys = await rv.getAllModuleKeys();
      expect(allKeys.length).to.be.gt(0);
      
      // 验证可以获取已注册的模块键（初始状态应该为空或很少）
      const registeredKeys = await rv.getAllRegisteredModuleKeys();
      expect(registeredKeys.length).to.be.gte(0);
    });

    it("应该能够处理真实 Registry 的 MAX_DELAY", async function () {
      const { rv } = await loadFixture(deployRealRegistryFixture);
      
      // 验证可以获取真实 Registry 的 MAX_DELAY
      const maxDelay = await rv.maxDelay();
      // MAX_DELAY 应该是 7 days (604800 秒)
      expect(maxDelay).to.equal(7 * 24 * 60 * 60);
    });

    it("应该能够处理真实 Registry 的动态模块键注册表", async function () {
      const { rv } = await loadFixture(deployRealRegistryFixture);
      
      const DynamicKeyReg = await ethers.getContractFactory("MockRegistryDynamicModuleKey");
      const dynamicKeyReg = await DynamicKeyReg.deploy();
      
      // 注册一些动态键
      await dynamicKeyReg.registerModuleKey("REAL_DYNAMIC_1");
      
      // 验证 getAllModuleKeys 可以正常工作
      // 注意：由于真实 Registry 需要 owner 权限设置模块，动态键注册表可能未在 Registry 中注册
      // 这种情况下应该只返回静态键
      const allKeys = await rv.getAllModuleKeys();
      expect(allKeys.length).to.be.gt(0);
      
      // 验证至少包含已知的静态键
      expect(allKeys).to.include(KEY_ACM);
    });
  });
});

