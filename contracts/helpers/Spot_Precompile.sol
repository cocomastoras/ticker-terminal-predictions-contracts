// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.10;

contract Spot_Precompile {
    constructor(){}

    fallback(bytes calldata input) external returns(bytes memory){
        uint32 marketId = abi.decode(input, (uint32));
        bytes memory result = abi.encode(uint64(uint256(keccak256(abi.encodePacked(marketId * block.timestamp))) % 100000));
        return result;
    }
}
