// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

contract TestUSDCTest is Test {
    TestUSDC t;
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_700_000_000);
        t = new TestUSDC(address(this));
    }

    function testMetadata() public view {
        assertEq(t.decimals(), 6);
        assertEq(t.symbol(), "tUSDC");
        assertEq(t.name(), "Test USDC (no value)");
    }

    function testMintOnlyOwner() public {
        t.mint(alice, 5);
        assertEq(t.balanceOf(alice), 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        t.mint(alice, 5);
    }

    function testFaucetRateLimit() public {
        vm.prank(alice);
        t.faucet();
        assertEq(t.balanceOf(alice), 1_000e6);
        uint256 next = block.timestamp + 24 hours;
        assertEq(t.faucetAvailableAt(alice), next);
        vm.warp(next - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.FaucetCooldown.selector, next));
        t.faucet();
        vm.warp(next);
        vm.prank(alice);
        t.faucet();
        assertEq(t.balanceOf(alice), 2_000e6);
    }
}
