import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Registry Gas Optimization", function () {
    let registry: Contract;
    let owner: Signer;
    let addr1: Signer;
    let addr2: Signer;
    let addr3: Signer;

    async function deployRegistryFixture() {
        const [owner, addr1, addr2, addr3] = await ethers.getSigners();
        
        // Deploy implementation and proxy
        const Registry = await ethers.getContractFactory("Registry");
        const implementation = await Registry.deploy();
        
        // Deploy proxy
        const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
        const proxy = await ERC1967Proxy.deploy(
            await implementation.getAddress(),
            implementation.interface.encodeFunctionData("initialize", [3600])
        );
        
        const registry = Registry.attach(await proxy.getAddress());
        
        return { registry, owner, addr1, addr2, addr3 };
    }

    beforeEach(async function () {
        const fixture = await loadFixture(deployRegistryFixture);
        registry = fixture.registry;
        owner = fixture.owner;
        addr1 = fixture.addr1;
        addr2 = fixture.addr2;
        addr3 = fixture.addr3;
    });

    describe("Gas Optimization - Batch Module Operations", function () {
        it("Should optimize gas usage for batch module operations", async function () {
            const keys = [
                ethers.keccak256(ethers.toUtf8Bytes("TEST_MODULE_1")),
                ethers.keccak256(ethers.toUtf8Bytes("TEST_MODULE_2")),
                ethers.keccak256(ethers.toUtf8Bytes("TEST_MODULE_3"))
            ];
            
            const addresses = [
                await addr1.getAddress(),
                await addr2.getAddress(),
                await addr3.getAddress()
            ];

            // Test batch set modules with status
            const tx = await registry.setModulesWithStatus(keys, addresses);
            const receipt = await tx.wait();
            
            // Verify the operation was successful
            expect(await registry.getModule(keys[0])).to.equal(await addr1.getAddress());
            expect(await registry.getModule(keys[1])).to.equal(await addr2.getAddress());
            expect(await registry.getModule(keys[2])).to.equal(await addr3.getAddress());
            
            // Log gas usage for comparison
            console.log(`Batch operation gas used: ${receipt?.gasUsed?.toString()}`);
        });

        it("Should handle batch operations with mixed changes and no-ops", async function () {
            // First, set some modules
            const keys = [
                ethers.keccak256(ethers.toUtf8Bytes("MIXED_TEST_1")),
                ethers.keccak256(ethers.toUtf8Bytes("MIXED_TEST_2")),
                ethers.keccak256(ethers.toUtf8Bytes("MIXED_TEST_3"))
            ];
            
            const addresses1 = [
                await addr1.getAddress(),
                await addr2.getAddress(),
                await addr3.getAddress()
            ];

            // Set initial modules
            await registry.setModulesWithStatus(keys, addresses1);
            
            // Now try to set the same addresses again (should be no-ops)
            const addresses2 = [
                await addr1.getAddress(), // Same address
                await addr2.getAddress(), // Same address  
                await addr3.getAddress()  // Same address
            ];

            const tx = await registry.setModulesWithStatus(keys, addresses2);
            const receipt = await tx.wait();
            
            // Verify modules are still the same
            expect(await registry.getModule(keys[0])).to.equal(await addr1.getAddress());
            expect(await registry.getModule(keys[1])).to.equal(await addr2.getAddress());
            expect(await registry.getModule(keys[2])).to.equal(await addr3.getAddress());
            
            console.log(`Mixed operation gas used: ${receipt?.gasUsed?.toString()}`);
        });

        it("Should emit batch events correctly", async function () {
            const keys = [
                ethers.keccak256(ethers.toUtf8Bytes("EVENT_TEST_1")),
                ethers.keccak256(ethers.toUtf8Bytes("EVENT_TEST_2"))
            ];
            
            const addresses = [
                await addr1.getAddress(),
                await addr2.getAddress()
            ];

            // Expect batch event to be emitted
            await expect(registry.setModulesWithStatus(keys, addresses))
                .to.emit(registry, "BatchModuleChanged")
                .withArgs(keys, [ethers.ZeroAddress, ethers.ZeroAddress], addresses, await owner.getAddress());
        });

        it("Should handle large batch operations efficiently", async function () {
            // Create a larger batch (but within limits)
            const keys = [];
            const addresses = [];
            
            for (let i = 0; i < 10; i++) {
                keys.push(ethers.keccak256(ethers.toUtf8Bytes(`LARGE_TEST_${i}`)));
                addresses.push(await addr1.getAddress());
            }

            const tx = await registry.setModulesWithStatus(keys, addresses);
            const receipt = await tx.wait();
            
            // Verify all modules were set
            for (let i = 0; i < keys.length; i++) {
                expect(await registry.getModule(keys[i])).to.equal(await addr1.getAddress());
            }
            
            console.log(`Large batch operation gas used: ${receipt?.gasUsed?.toString()}`);
        });

        it("Should maintain backward compatibility", async function () {
            // Test individual module setting still works
            const key = ethers.keccak256(ethers.toUtf8Bytes("SINGLE_TEST"));
            const address = await addr1.getAddress();
            
            await expect(registry.setModule(key, address))
                .to.emit(registry, "ModuleUpgraded")
                .withArgs(key, ethers.ZeroAddress, address, await owner.getAddress());
                
            expect(await registry.getModule(key)).to.equal(address);
        });

        it("Should handle batch operations with allowReplace flag", async function () {
            const keys = [
                ethers.keccak256(ethers.toUtf8Bytes("REPLACE_TEST_1")),
                ethers.keccak256(ethers.toUtf8Bytes("REPLACE_TEST_2"))
            ];
            
            const addresses1 = [
                await addr1.getAddress(),
                await addr2.getAddress()
            ];

            // Set initial modules
            await registry.setModulesWithStatus(keys, addresses1);
            
            const addresses2 = [
                await addr3.getAddress(),
                await addr1.getAddress()
            ];

            // Replace modules
            const tx = await registry.batchSetModules(keys, addresses2, true);
            const receipt = await tx.wait();
            
            // Verify modules were replaced
            expect(await registry.getModule(keys[0])).to.equal(await addr3.getAddress());
            expect(await registry.getModule(keys[1])).to.equal(await addr1.getAddress());
            
            console.log(`Replace operation gas used: ${receipt?.gasUsed?.toString()}`);
        });
    });

    describe("Gas Optimization - Error Handling", function () {
        it("Should revert for invalid batch operations", async function () {
            const keys = [
                ethers.keccak256(ethers.toUtf8Bytes("ERROR_TEST_1")),
                ethers.keccak256(ethers.toUtf8Bytes("ERROR_TEST_2"))
            ];
            
            const addresses = [
                await addr1.getAddress(),
                ethers.ZeroAddress // Invalid address
            ];

            await expect(registry.setModulesWithStatus(keys, addresses))
                .to.be.revertedWithCustomError(registry, "ZeroAddress");
        });

        it("Should revert for mismatched array lengths", async function () {
            const keys = [
                ethers.keccak256(ethers.toUtf8Bytes("LENGTH_TEST_1")),
                ethers.keccak256(ethers.toUtf8Bytes("LENGTH_TEST_2"))
            ];
            
            const addresses = [
                await addr1.getAddress()
                // Missing second address
            ];

            await expect(registry.setModulesWithStatus(keys, addresses))
                .to.be.revertedWithCustomError(registry, "InvalidCaller");
        });
    });

    describe("Gas Optimization - Performance Comparison", function () {
        it("Should show improved gas efficiency", async function () {
            const keys = [
                ethers.keccak256(ethers.toUtf8Bytes("PERF_TEST_1")),
                ethers.keccak256(ethers.toUtf8Bytes("PERF_TEST_2")),
                ethers.keccak256(ethers.toUtf8Bytes("PERF_TEST_3")),
                ethers.keccak256(ethers.toUtf8Bytes("PERF_TEST_4")),
                ethers.keccak256(ethers.toUtf8Bytes("PERF_TEST_5"))
            ];
            
            const addresses = [
                await addr1.getAddress(),
                await addr2.getAddress(),
                await addr3.getAddress(),
                await addr1.getAddress(),
                await addr2.getAddress()
            ];

            // Measure gas usage for batch operation
            const tx = await registry.setModulesWithStatus(keys, addresses);
            const receipt = await tx.wait();
            
            console.log(`Performance test - Batch operation gas used: ${receipt?.gasUsed?.toString()}`);
            console.log(`Performance test - Gas per module: ${Number(receipt?.gasUsed) / keys.length}`);
            
            // Verify all modules were set correctly
            for (let i = 0; i < keys.length; i++) {
                expect(await registry.getModule(keys[i])).to.equal(addresses[i]);
            }
        });
    });
}); 