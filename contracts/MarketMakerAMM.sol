// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;
import "solady/src/utils/g/EnumerableSetLib.sol";
import "hardhat/console.sol";

contract MarketMakerAMM {

    using EnumerableSetLib for Uint256Set;

    event MarketEnter(uint256 indexed MarketId, uint256 indexed RoundId, address indexed User, uint256 AmountIn, uint256 Side, uint256 AmountOut); //0xafdcf9101f4dab5c3b6e53a3ec30d3e897f17b974edceb117d3c12d2d83b0fd9
    event MarketExit(uint256 indexed MarketId, uint256 indexed RoundId, address indexed User, uint256 AmountInA, uint256 AmountInB, uint256 AmountOut); //0x4c686a53bc9329e91f0d0d94d821505fd2c0aef3c09a94ea360d98c0dfb9dee4
    event MarketRedeem(uint256 indexed MarketId, uint256 indexed RoundId, address indexed User, uint256 Result, uint256 AmountOut); //0x3f63856e2d8c431941e15ac15a28d4201c2838a61987308f61a9d5d01aac4839

    error NotAuthorised();
    error RoundExpired();
    error AlreadyClaimed();
    error RoundResolved();
    error InvalidRound();
    error InvalidTimestamp();
    error InvalidInput();
    error SlippageReached();
    error RoundNotYetInitialised();
    error InvalidOutput();
    error OracleError();
    error InvalidReserves();

    address internal admin; // slot: 0
    uint256 public fees; //slot1
    uint256 public universalRound; // slot: 2
    uint256 public roundStart; // slot: 3
    mapping(uint256 marketId => mapping(uint256 round => uint256 yesReserves)) internal marketToRoundToYesReserves; // slot: 4
    mapping(uint256 marketId => mapping(uint256 round => uint256 noReserves)) internal marketToRoundToNoReserves; // slot: 5
    mapping(uint256 marketId => mapping(uint256 round => uint256 treasury)) internal marketToRoundToTreasury; // slot: 6
    mapping(address user => mapping(uint256 marketId => mapping(uint256 round => uint256 yesReserves))) internal userToMarketToRoundToYesReserves; // slot: 7
    mapping(address user => mapping(uint256 marketId => mapping(uint256 round => uint256 noReserves))) internal userToMarketToRoundToNoReserves; // slot: 8
    mapping(uint256 marketId => mapping(uint256 round => uint256 price)) internal marketToRoundToPrice; // slot: 9
    mapping(uint256 marketId => mapping(uint256 round => uint256 result)) internal marketToRoundToResult; // slot: 10
    mapping(address user => mapping(uint256 marketId => uint256[] roundIds)) internal userToActiveRoundsPerMarket; // slot: 11
    mapping(address user => mapping(uint256 marketId => mapping(uint256 roundId => uint256 registered))) internal userToRegisteredRound; // slot: 12
    mapping(address user => mapping(uint256 marketId => mapping(uint256 roundId => uint256 redeemed)))  internal userToRedeemedMarketRound;  // slot: 13
    mapping(uint256 marketId => mapping(uint256 round => uint256 outstandingYesShares)) internal marketToRoundToOutYesShares; // slot: 14
    mapping(uint256 marketId => mapping(uint256 round => uint256 outstandingNoShares)) internal marketToRoundToOutNoShares; // slot: 15
    mapping(uint256 roundId => uint256 resolverFees) internal roundIdToResolverFees; // slot: 16
    mapping(uint256 marketId => uint256 delistRound) public marketToDelistingRound; // slot: 17


    Uint256Set private availableMarkets;
    Uint256Set private allMarkets;// slot: 19


    struct MarketData {
        uint256 marketId;
        uint256 roundId;
        uint256 roundStart;
        uint256 marketTreasury;
        uint256 yesReserves;
        uint256 noReserves;
        uint256 outYesReserves;
        uint256 outNoReserves;
        uint256 lastPrice;
        uint256 currentPrice;
        uint256 result;
    }

    struct MarketDataWithHistory {
        uint256 marketId;
        uint256 roundId;
        uint256 roundStart;
        uint256 marketTreasury;
        uint256 yesReserves;
        uint256 noReserves;
        uint256 outYesReserves;
        uint256 outNoReserves;
        uint256 lastPrice;
        uint256 currentPrice;
        uint256 result;
        uint256 delistingRound;
        uint256[] history;
    }

    struct MarketHistory {
        uint256 marketId;
        uint256 roundId;
        uint256 outYesReserves;
        uint256 outNoReserves;
        uint256 openPrice;
        uint256 closePrice;
        uint256 result;
    }

    struct UserData {
        uint256 marketId;
        uint256 roundId;
        uint256 result;
        uint256 outYesReserves;
        uint256 outNoReserves;
        uint256 userYesReserves;
        uint256 userNoReserves;
        uint256 treasury;
        uint256 userRedeemed;
    }

    struct UserToRoundsPerMarket {
        uint256 marketId;
        uint256[] roundIds;
    }

    /**
     * @notice Initializes the MarketMakerAMM contract with initial markets
     * @dev Sets up initial reserves for rounds 1 and 2, fetches initial oracle prices
     * @param initMarketIds Array of market IDs to initialize (e.g., [0, 1, 2] for BTC, HYPE, SOL)
     * 
     * Initializes:
     * - Round 1 as the current round
     * - 425 HYPE initial reserves for YES and NO in rounds 1 and 2
     * - Fetches and stores initial oracle price for round 0
     * - Sets deployer as admin
     */
    constructor(uint256[] memory initMarketIds, address _admin) {
        uint len = initMarketIds.length;
        for(uint i=0; i<len; i++) {
            uint256 marketId = initMarketIds[i];
            marketToRoundToPrice[marketId][0] = _oraclePx(marketId);
            availableMarkets.add(marketId);
            allMarkets.add(marketId);
            marketToRoundToYesReserves[marketId][1] = 425 * 10**18;
            marketToRoundToNoReserves[marketId][1] = 425 * 10**18;
            marketToRoundToYesReserves[marketId][2] = 425 * 10**18;
            marketToRoundToNoReserves[marketId][2] = 425 * 10**18;
        }
        universalRound++;
        roundStart = block.timestamp;
        admin = _admin;
    }



    /**
     * @notice Registers a new market to the AMM
     * @dev Only callable by admin. Market ID must not already exist
     * @param index The market ID to register
     * 
     * @custom:reverts NotAuthorised if caller is not admin
     * @custom:reverts InvalidInput if market ID already exists
     */
    function registerMarket(uint256 index) external {
        if(msg.sender != admin) {
            revert NotAuthorised();
        }
        marketToDelistingRound[index] = 0; //Clear delisting round on potential relisting
        if(!availableMarkets.add(index)) revert InvalidInput();
        allMarkets.add(index);
        uint256 uRound = universalRound + 1;
        marketToRoundToYesReserves[index][uRound] = 425 * 10**18;
        marketToRoundToNoReserves[index][uRound] = 425 * 10**18;
    }

    /**
     * @notice Puts the market Id in schedule for removal, after 5 rounds admin can remove the market Id.
     * @dev Only callable by admin. Market ID must already exist
     * @param index The market ID to remove
     *
     * @custom:reverts NotAuthorised if caller is not admin
     * @custom:reverts InvalidInput if market ID doesn't exist
     */
    function putMarketOnDelist(uint256 index) external {
        if(msg.sender != admin) {
            revert NotAuthorised();
        }
        if(!availableMarkets.contains(index)) revert InvalidInput();
        marketToDelistingRound[index] = universalRound + 5;
    }

    /**
     * @notice Removes an active market from the App
     * @dev Only callable by admin. Market ID must already exist
     * @dev Markets should be scheduled for delete using putMarketOnDelist() before calling this function
     * @param index The market ID to remove
     *
     * @custom:reverts NotAuthorised if caller is not admin
     * @custom:reverts InvalidInput if market ID doesn't exist
     */
    function delistMarket(uint256 index) external {
        if(msg.sender != admin) {
            revert NotAuthorised();
        }
        if(marketToDelistingRound[index] == 0 || marketToDelistingRound[index] > universalRound) revert InvalidInput();
        if(!availableMarkets.remove(index)) revert InvalidInput();
    }

    /**
     * @notice Updates the admin
     * @dev Only callable by admin
     * @param newAdmin The newAdmin's address
     *
     * @custom:reverts NotAuthorised if caller is not admin
     */
    function updateAdmin(address newAdmin) external {
        if(msg.sender != admin) {
            revert NotAuthorised();
        }
        admin = newAdmin;
    }

    /**
     * @notice Buy YES or NO shares in a prediction market
     * @dev Uses AMM formula to calculate shares. Deducts 0.3% fee (60% protocol, 40% resolver)
     * @param minAmountOut Minimum shares expected (slippage protection)
     * @param marketId Market identifier (0=BTC, 1=HYPE, etc.)
     * @param roundId Round identifier (must be current round or next round in pre-market)
     * @param side 0 for YES (price will increase), 1 for NO (price will decrease)
     * 
     * Requirements:
     * - msg.value > 0 (must send HYPE)
     * - roundId must be universalRound or universalRound+1
     * - If roundId == universalRound: must be within first 5 minutes
     * - If roundId == universalRound+1: must be after 5 minutes (pre-market)
     * - Previous round must have a price (for current round)
     * 
     * Effects:
     * - Registers user in round if first time
     * - Updates market reserves
     * - Updates user share balances
     * - Distributes fees (60% protocol, 40% resolver)
     * 
     * @custom:reverts InvalidInput if side > 1
     * @custom:reverts InvalidRound if roundId is invalid or previous round has no price
     * @custom:reverts RoundExpired if current round trading window has closed
     * @custom:reverts RoundNotYetInitialised if trying to enter next round before pre-market
     * @custom:reverts SlippageReached if calculated shares < minAmountOut
     */
    function enterMarket(uint256 minAmountOut, uint256 marketId, uint256 roundId, uint256 side) external payable {
        if (!availableMarkets.contains(marketId)) revert InvalidInput();
        if(marketToDelistingRound[marketId] != 0 && marketToDelistingRound[marketId] <= roundId) revert InvalidInput();
        assembly {
            let rStart := sload(roundStart.slot)
            if gt(side, 1) {
                mstore(0x00, 0xb4fa3fb3) //InvalidInput()
                revert(0x1c, 0x04)
            }
            let universalRoundId := sload(universalRound.slot)
            // marketToRoundToPrice
            mstore(0x00, marketId)
            mstore(0x20, 9)
            let hash := keccak256(0, 0x40)
            mstore(0, sub(roundId, 1))
            mstore(0x20, hash)
            hash := keccak256(0, 0x40)
            if and(eq(universalRoundId, roundId), eq(sload(hash), 0)) {
                mstore(0x00, 0xa2b52a54) //InvalidRound()
                revert(0x1c, 0x04)
            }
            if or(gt(roundId, add(universalRoundId, 1)), lt(roundId, universalRoundId)) {
                mstore(0x00, 0xa2b52a54) //InvalidRound()
                revert(0x1c, 0x04)
            }
            if and(eq(roundId, universalRoundId), lt(add(rStart, 300), timestamp())) {
                mstore(0x00, 0x9e6d804f) //RoundExpired()
                revert(0x1c, 0x04)
            }
            if and(eq(roundId, add(universalRoundId, 1)), lt(timestamp(), add(rStart, 300))) {
                mstore(0x00, 0x5b903c71) //RoundNotYetInitialised()
                revert(0x1c, 0x04)
            }
            let amount := div(mul(callvalue(), 997), 1000)
            let totalFee := sub(callvalue(), amount)
            sstore(fees.slot, add(sload(fees.slot), div(mul(totalFee, 600), 1000))) //Deduct resolver fees from total fees

            // roundIdToResolverFees
            mstore(0x00, roundId)
            mstore(0x20, 16)
            hash := keccak256(0, 0x40)
            sstore(hash, add(sload(hash), sub(totalFee, div(mul(totalFee, 600), 1000))))

            // marketToRoundToTreasury
            mstore(0x00, marketId)
            mstore(0x20, 6)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, roundId)
            hash := keccak256(0, 0x40)
            sstore(hash, add(sload(hash), amount))

            //  userToRegisteredRound
            mstore(0x00, caller())
            mstore(0x20, 12)
            hash := keccak256(0x00, 0x40)
            mstore(0x00, marketId)
            mstore(0x20, hash)
            hash := keccak256(0x00, 0x40)
            mstore(0x00, roundId)
            mstore(0x20, hash)
            hash := keccak256(0x00, 0x40)
            if eq(sload(hash), 0) {
                sstore(hash, 1)
                // userToActiveRoundsPerMarket
                mstore(0x00, caller())
                mstore(0x20, 11)
                hash := keccak256(0, 0x40)
                mstore(0x00, marketId)
                mstore(0x20, hash)
                hash := keccak256(0, 0x40)
                let len := sload(hash)
                sstore(hash, add(len, 1))
                mstore(0x00, hash)
                hash := keccak256(0, 0x20)
                sstore(add(hash, len), roundId)
            }

            // marketToRoundToYesReserves
            mstore(0x00, marketId)
            mstore(0x20, 4)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, roundId)
            hash := keccak256(0, 0x40)
            let yesReserves := sload(hash)

            // marketToRoundToNoReserves
            mstore(0x00, marketId)
            mstore(0x20, 5)
            let noHash := keccak256(0, 0x40)
            mstore(0x20, noHash)
            mstore(0, roundId)
            noHash := keccak256(0, 0x40)
            let noReserves := sload(noHash)

            // _buyYes()
            if eq(side, 0) {
                let userPrimaryReserves := div(mul(amount, yesReserves), add(amount, noReserves))
                if lt(add(userPrimaryReserves, amount), minAmountOut) {
                    mstore(0x00, 0xa6d7690f) //SlippageReached()
                    revert(0x1c, 0x04)
                }

                sstore(hash, sub(yesReserves, userPrimaryReserves))
                sstore(noHash, add(noReserves, amount))

                // userToMarketToRoundToYesReserves
                mstore(0x00, caller())
                mstore(0x20, 7)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, marketId)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, add(sload(hash), add(userPrimaryReserves, amount)))

                // marketToRoundToOutYesShares
                mstore(0x00, marketId)
                mstore(0x20, 14)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, add(sload(hash), add(userPrimaryReserves, amount)))
                mstore(0x00, callvalue())
                mstore(0x20, side)
                mstore(0x40, add(userPrimaryReserves, amount))
                log4(0x00, 0x60, 0xafdcf9101f4dab5c3b6e53a3ec30d3e897f17b974edceb117d3c12d2d83b0fd9, marketId, roundId, caller())
                return(0,0)
            }
            // _buyNo()
            let userSecondaryReserves := div(mul(amount, noReserves), add(amount, yesReserves))
            if lt(add(userSecondaryReserves, amount), minAmountOut) {
                mstore(0x00, 0xa6d7690f) //SlippageReached()
                revert(0x1c, 0x04)
            }

            sstore(hash, add(yesReserves, amount))
            sstore(noHash, sub(noReserves, userSecondaryReserves))

            // userToMarketToRoundToNoReserves
            mstore(0x00, caller())
            mstore(0x20, 8)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, marketId)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, roundId)
            hash := keccak256(0, 0x40)
            sstore(hash, add(sload(hash), add(userSecondaryReserves, amount)))

            // marketToRoundToOutNoShares
            mstore(0x00, marketId)
            mstore(0x20, 15)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, roundId)
            hash := keccak256(0, 0x40)
            sstore(hash, add(sload(hash), add(userSecondaryReserves, amount)))
            mstore(0x00, callvalue())
            mstore(0x20, side)
            mstore(0x40, add(userSecondaryReserves, amount))
            log4(0x00, 0x60, 0xafdcf9101f4dab5c3b6e53a3ec30d3e897f17b974edceb117d3c12d2d83b0fd9, marketId, roundId, caller())
            return(0,0)
        }
    }

    /**
     * @notice Exit a market position by selling YES and NO shares
     * @dev Optionally swaps between YES/NO before redeeming. Deducts 0.3% exit fee
     * @param minNativeAmountOut Minimum HYPE expected after exit (slippage protection)
     * @param marketId Market identifier
     * @param roundId Round identifier (must be current or next round)
     * @param amountYes Amount of YES shares user wants to sell
     * @param amountNo Amount of NO shares user wants to sell
     * @param toBeExchanged Amount to swap between YES/NO to balance position before exit
     * 
     * Process:
     * 1. If toBeExchanged > 0: Swaps YES to NO or NO to YES (whichever is higher)
     * 2. Redeems equal amounts of YES and NO shares for HYPE
     * 3. Deducts 0.3% fee (60% protocol, 40% resolver)
     * 4. Transfers remaining HYPE to user
     * 
     * Requirements:
     * - roundId must be current round or next round
     * - If current round: must be within trading window (first 5 minutes)
     * - If next round: must be within pre-market trading window (second 5 minutes of current round)
     * - User must have sufficient YES and NO shares
     * 
     * @custom:reverts InvalidRound if roundId is out of valid range
     * @custom:reverts RoundExpired if current round trading window has closed
     * @custom:reverts SlippageReached if HYPE received < minNativeAmountOut
     * @custom:reverts InvalidOutput if HYPE transfer to user fails
     */
    function exitMarket(uint256 minNativeAmountOut, uint256 marketId, uint256 roundId, uint256 amountYes, uint256 amountNo, uint256 toBeExchanged) external {
        if(!availableMarkets.contains(marketId)) revert InvalidInput();
        uint256 amountOut;
        if (toBeExchanged > 0 ) {
            if (amountYes < amountNo) {
                amountOut = _sellNo(toBeExchanged, marketId, roundId);
                amountNo -= toBeExchanged;
                amountYes += amountOut;
            } else {
                amountOut = _sellYes(toBeExchanged,marketId, roundId);
                amountYes -= toBeExchanged;
                amountNo += amountOut;
            }
        }
        amountOut = amountYes > amountNo ? amountNo : amountYes;

        // @dev marketToRoundToYesReserves transient_slot 0
        // @dev marketToRoundToNoReserves transient_slot 1
        // @dev marketToRoundToTreasury transient_slot 2
        // @dev userToMarketToRoundToYesReserves transient_slot 3
        // @dev userToMarketToRoundToNoReserves transient_slot 4
        // @dev marketToRoundToOutYesShares transient_slot 5
        // @dev marketToRoundToOutNoShares transient_slot
        assembly {
            let localUniversalRound := sload(universalRound.slot)

            if or(lt(roundId, localUniversalRound), gt(roundId, add(localUniversalRound, 1))) {
                mstore(0x00, 0xa2b52a54) //InvalidRound()
                revert(0x1c, 0x04)
            }

            if and(eq(roundId, localUniversalRound), lt(add(sload(roundStart.slot), 300), timestamp())) {
                mstore(0x00, 0x9e6d804f) //RoundExpired()
                revert(0x1c, 0x04)
            }

            switch gt(toBeExchanged, 0)
            case 1 {
                // marketToRoundToTreasury DONE
                mstore(0x00, marketId)
                mstore(0x20, 6)
                let hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, sub(tload(2), amountOut))
                tstore(2, 0)

                // userToMarketToRoundToYesReserves DONE
                mstore(0x00, caller())
                mstore(0x20, 7)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, marketId)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)

                if lt(tload(3), amountOut) {
                    mstore(0x00, 0x7b9c8916) //InvalidReserves()
                    revert(0x1c, 0x04)
                }
                sstore(hash, sub(tload(3), amountOut))
                tstore(3, 0)

                // userToMarketToRoundToNoReserves DONE
                mstore(0x00, caller())
                mstore(0x20, 8)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, marketId)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)

                if lt(tload(4), amountOut) {
                    mstore(0x00, 0x7b9c8916) //InvalidReserves()
                    revert(0x1c, 0x04)
                }
                sstore(hash, sub(tload(4), amountOut))
                tstore(4, 0)

                // marketToRoundToOutYesShares DONE
                mstore(0x00, marketId)
                mstore(0x20, 14)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, sub(tload(5), amountOut))
                tstore(5, 0)

                // marketToRoundToOutNoShares DONE
                mstore(0x00, marketId)
                mstore(0x20, 15)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, sub(tload(6), amountOut))
                tstore(6, 0)
            }
            case 0 {
                // marketToRoundToTreasury DONE
                mstore(0x00, marketId)
                mstore(0x20, 6)
                let hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, sub(sload(hash), amountOut))

                // userToMarketToRoundToYesReserves DONE
                mstore(0x00, caller())
                mstore(0x20, 7)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, marketId)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                let state := sload(hash)
                if lt(state, amountOut) {
                    mstore(0x00, 0x7b9c8916) //InvalidReserves()
                    revert(0x1c, 0x04)
                }
                sstore(hash, sub(state, amountOut))

                // userToMarketToRoundToNoReserves DONE
                mstore(0x00, caller())
                mstore(0x20, 8)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, marketId)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                state := sload(hash)
                if lt(state, amountOut) {
                   mstore(0x00, 0x7b9c8916) //InvalidReserves()
                   revert(0x1c, 0x04)
                }
                sstore(hash, sub(state, amountOut))

                // marketToRoundToOutYesShares DONE
                mstore(0x00, marketId)
                mstore(0x20, 14)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, sub(sload(hash), amountOut))

                // marketToRoundToOutNoShares DONE
                mstore(0x00, marketId)
                mstore(0x20, 15)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, roundId)
                hash := keccak256(0, 0x40)
                sstore(hash, sub(sload(hash), amountOut))
            }
            let amountOutAfterFee := div(mul(amountOut, 997), 1000)
            let totalFee := sub(amountOut, amountOutAfterFee)
            sstore(fees.slot, add(sload(fees.slot), div(mul(totalFee, 600), 1000))) //Deduct resolver fees from total fees

            // roundIdToResolverFees
            mstore(0x00, roundId)
            mstore(0x20, 16)
            let hash := keccak256(0, 0x40)
            sstore(hash, add(sload(hash), sub(totalFee, div(mul(totalFee, 600), 1000))))
            if lt(amountOutAfterFee, minNativeAmountOut) {
                mstore(0x00, 0xa6d7690f) //SlippageReached()
                revert(0x1c, 0x04)
            }
            mstore(0x00, amountYes)
            mstore(0x20, amountNo)
            mstore(0x40, amountOutAfterFee)
            log4(0x00, 0x60, 0x4c686a53bc9329e91f0d0d94d821505fd2c0aef3c09a94ea360d98c0dfb9dee4, marketId, roundId, caller())
            if iszero(
                call(gas(), caller(), amountOutAfterFee, 0, 0, 0, 0)
            ) {
                mstore(0x00, 0x98f73609) //InvalidOutput()
                revert(0x1c, 0x04)
            }

        }
    }

    /**
     * @notice Resolves all markets for the current round and starts a new round
     * @dev Can be called by anyone after 10 minutes. Caller receives resolver fees as incentive
     * 
     * Process:
     * 1. Validates 10 minutes (600 seconds) have passed since round start
     * 2. For each market:
     *    - Fetches current price from oracle
     *    - Compares with previous round's price
     *    - Sets result: 1 if price increased (YES wins), 2 if decreased (NO wins)
     *    - If no winners, adds treasury to protocol fees
     *    - Initializes reserves for round+2 (425 HYPE each)
     * 3. Increments universalRound
     * 4. Updates roundStart to current timestamp
     * 5. Transfers accumulated resolver fees to caller
     * 
     * Fee Distribution:
     * - Resolver receives 40% of all trading fees from the round
     * - Protocol receives 60% of all trading fees
     * 
     * @custom:reverts InvalidTimestamp if called before 10 minutes elapsed
     * @custom:reverts RoundResolved if round already resolved
     * @custom:reverts OracleError if oracle price fetch fails
     * @custom:reverts InvalidOutput if fee transfer to resolver fails
     */
    function resolveMarkets() external {
        assembly {
            if lt(timestamp(), add(sload(roundStart.slot), 600)) {
                mstore(0x00, 0xb7d09497) //InvalidTimestamp()
                revert(0x1c, 0x04)
            }
        }
        uint256 uRound = universalRound;
        uint256 len = availableMarkets.length();
        for(uint i=0; i<len; i++){
            uint256 marketId = availableMarkets.at(i);
            // get price from oracle
            uint256 currentPrice = _oraclePx(marketId);
            assembly {
                // marketToRoundToResult
                mstore(0x00, marketId)
                mstore(0x20, 10)
                let hash := keccak256(0x00, 0x40)
                mstore(0x00, uRound)
                mstore(0x20, hash)
                let resultHash := keccak256(0x00, 0x40)

                if gt(sload(resultHash), 0) {
                    mstore(0x00, 0xfd29af2c) //RoundResolved()
                    revert(0x1c, 0x04)
                }

                // marketToRoundToPrice currentRound -1
                mstore(0x00, marketId)
                mstore(0x20, 9)
                hash := keccak256(0x00, 0x40)
                mstore(0x00, sub(uRound, 1))
                mstore(0x20, hash)
                hash := keccak256(0x00, 0x40)
                let lastPrice := sload(hash)
                // marketToRoundToPrice currentRound
                mstore(0x00, uRound)
                hash := keccak256(0x00, 0x40)
                sstore(hash, currentPrice)

                if gt(lastPrice, 0) {
                    mstore(0x00, marketId)
                    mstore(0x20, 6)
                    hash := keccak256(0, 0x40)
                    mstore(0x20, hash)
                    mstore(0, uRound)
                    hash := keccak256(0, 0x40)
                    let treasury := sload(hash)
                    switch gt(currentPrice, lastPrice)
                    case 1 {
                        sstore(resultHash, 1)
                        // If there are no winners then add market treasury to fees
                        mstore(0x00, marketId)
                        mstore(0x20, 14)
                        hash := keccak256(0, 0x40)
                        mstore(0x20, hash)
                        mstore(0, uRound)
                        hash := keccak256(0, 0x40)
                        if eq(sload(hash), 0) {
                            sstore(fees.slot, add(sload(fees.slot), treasury))
                        }
                    }
                    case 0 {
                        sstore(resultHash, 2)
                        // If there are no winners then add market treasury to fees
                        mstore(0x00, marketId)
                        mstore(0x20, 15)
                        hash := keccak256(0, 0x40)
                        mstore(0x20, hash)
                        mstore(0, uRound)
                        hash := keccak256(0, 0x40)
                        if eq(sload(hash), 0) {
                            sstore(fees.slot, add(sload(fees.slot), treasury))
                        }
                    }
                }

                // marketToRoundToYesReserves
                mstore(0x00, marketId)
                mstore(0x20, 4)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, add(uRound, 2))
                hash := keccak256(0, 0x40)
                sstore(hash, 425000000000000000000)

                // marketToRoundToNoReserves
                mstore(0x00, marketId)
                mstore(0x20, 5)
                hash := keccak256(0, 0x40)
                mstore(0x20, hash)
                mstore(0, add(uRound, 2))
                hash := keccak256(0, 0x40)
                sstore(hash, 425000000000000000000)
            }
        }
        assembly {
            mstore(0x00, sload(universalRound.slot))
            mstore(0x20, 16)
            let hash := keccak256(0, 0x40)
            let roundFees := sload(hash)

            sstore(universalRound.slot, add(uRound, 1))
            sstore(roundStart.slot, timestamp())
            if iszero(

                    call(gas(), caller(), roundFees, 0, 0, 0, 0)
                ) {
                    mstore(0x00, 0x98f73609) //InvalidOutput()
                    revert(0x1c, 0x04)
                }
        }
    }

    /**
     * @notice Claims winnings from resolved rounds for a specific market (max 25 rounds)
     * @dev Processes up to 25 rounds per call to avoid gas limits. Call multiple times if needed
     * @param marketId Market identifier to claim winnings from
     * @dev Unresolved RoundIds will deterministically be placed on either roundIds storage slot 0, 1 or total_len-1, total_len-2 after an iteration
     * 
     * Process:
     * 1. Retrieves user's pending rounds for the market
     * 2. Processes up to 25 rounds:
     *    - Checks if round is resolved
     *    - Calculates user's share of treasury based on winning shares
     *    - Transfers winnings to user
     *    - Marks round as redeemed
     *    - Removes from pending list if resolved
     * 3. Reorganizes pending rounds array
     * 
     * Payout Formula:
     * - userPayout = (userWinningShares * marketTreasury) / totalWinningShares
     * 
     * @custom:reverts AlreadyClaimed if user already claimed winnings for a round
     * @custom:reverts InvalidOutput if HYPE transfer fails
     */
    function redeemRoundsPerMarketIdCapped(uint256 marketId) external {
        assembly {
            mstore(0x00, caller())
            mstore(0x20, 11)
            let hash := keccak256(0, 0x40)
            mstore(0x00, marketId)
            mstore(0x20, hash)
            let roundHashLen := keccak256(0, 0x40)
            let totalLen := sload(roundHashLen)
            let len := totalLen
            mstore(0x00, roundHashLen)
            let itemHash := keccak256(0, 0x20)
            if gt(len, 25) {
                len := 25
            }
            for {let i := 0} lt(i, len) {i := add(i, 1)} {
                let roundId := sload(add(itemHash, i))
                sstore(add(itemHash, i), 0) //clear roundId

                // userToRedeemedMarketRound
                mstore(0x00, caller())
                mstore(0x20, 13)
                hash := keccak256(0, 0x40)
                mstore(0, marketId)
                mstore(0x20, hash)
                hash := keccak256(0, 0x40)
                mstore(0, roundId)
                mstore(0x20, hash)
                let resultHash := keccak256(0, 0x40)

                if gt(sload(resultHash), 0) {
                    mstore(0x00, 0x646cf558) // AlreadyClaimed()
                    revert(0x1c, 0x04)
                }

                // marketToRoundToResult
                mstore(0x00, marketId)
                mstore(0x20, 10)
                hash := keccak256(0x00, 0x40)
                mstore(0x00, roundId)
                mstore(0x20, hash)
                hash := keccak256(0x00, 0x40)

                let userBet := 0
                let winningBets := 1
                let result := sload(hash)
                switch result
                case 1 {
                    // userToRedeemedMarketRound
                    sstore(resultHash, 1)

                    // userToMarketToRoundToYesReserves
                    mstore(0x00, caller())
                    mstore(0x20, 7)
                    hash := keccak256(0, 0x40)
                    mstore(0, marketId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    userBet := sload(hash)

                    // marketToRoundToOutYesShares
                    mstore(0x00, marketId)
                    mstore(0x20, 14)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    winningBets := sload(hash)
                }
                case 2 {
                    // userToRedeemedMarketRound
                    sstore(resultHash, 1)

                    // userToMarketToRoundToNoReserves
                    mstore(0x00, caller())
                    mstore(0x20, 8)
                    hash := keccak256(0, 0x40)
                    mstore(0, marketId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    userBet := sload(hash)

                    // marketToRoundToOutNoShares
                    mstore(0x00, marketId)
                    mstore(0x20, 15)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    winningBets := sload(hash)
                }
                default {
                    tstore(i, roundId)
                }

                if gt(sload(resultHash), 0) {
                    // marketToRoundToTreasury
                    mstore(0x00, marketId)
                    mstore(0x20, 6)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)

                    let amountOut := div(mul(userBet, sload(hash)), winningBets)

                    mstore(0x00, result)
                    mstore(0x20, amountOut)
                    log4(0x00, 0x40, 0x3f63856e2d8c431941e15ac15a28d4201c2838a61987308f61a9d5d01aac4839, marketId, roundId, caller())

                    if iszero(call(gas(), caller(), amountOut, 0, 0, 0, 0)) {
                        mstore(0x00, 0x98f73609) //InvalidOutput()
                        revert(0x1c, 0x04)
                    }
                }
            }
            let movingLen := sub(totalLen, len)
            if gt(movingLen, 25) {
                movingLen := 25
            }
            let newLen := sub(totalLen, len)
            for {let i := 0} lt(i, movingLen) {i := add(i, 1)} {
                sstore(add(itemHash, i), sload(add(itemHash, sub(totalLen, add(i, 1)))))
                if gt(tload(i), 0) {
                    sstore(add(itemHash, newLen), tload(i))
                    tstore(i, 0)
                    newLen := add(newLen, 1)
                }
            }
            if eq(movingLen, 0 ) {
                //fallback if we need to index the whole window when processed assets are less than the page
                for {let i := 0} lt(i, 25) {i := add(i, 1)} {
                    if gt(tload(i), 0) {
                        sstore(add(itemHash, newLen), tload(i))
                        tstore(i, 0)
                        newLen := add(newLen, 1)
                    }
                }
            }
            sstore(roundHashLen, newLen)
        }
    }

    /**
     * @notice Claims winnings from ALL pending rounds for a specific market (unbounded)
     * @dev WARNING: May run out of gas if user has many pending rounds. Use capped version for safety
     * @param marketId Market identifier to claim winnings from
     * @dev Unresolved RoundIds will deterministically be on either transient slot 0, 1 or total_len-1, total_len-2
     * 
     * Process:
     * - Same as redeemRoundsPerMarketIdCapped but processes ALL pending rounds
     * - No 25-round limit
     * 
     * Gas Considerations:
     * - Each round costs ~60k gas
     * - Block gas limit is ~2M
     * - Safe to process ~25 rounds per call
     * - Use capped version if unsure
     * 
     * @custom:reverts AlreadyClaimed if user already claimed winnings for a round
     * @custom:reverts InvalidOutput if HYPE transfer fails
     */
    function redeemPendingRoundsPerMarketId(uint256 marketId) external {
        assembly {
            mstore(0x00, caller())
            mstore(0x20, 11)
            let hash := keccak256(0, 0x40)
            mstore(0x00, marketId)
            mstore(0x20, hash)
            let roundHashLen := keccak256(0, 0x40)
            let len := sload(roundHashLen)
            mstore(0x00, roundHashLen)
            let itemHash := keccak256(0, 0x20)
            for {let i := 0} lt(i, len) {i := add(i, 1)} {
                let roundId := sload(add(itemHash, i))
                sstore(add(itemHash, i), 0) //clear roundId

                // userToRedeemedMarketRound
                mstore(0x00, caller())
                mstore(0x20, 13)
                hash := keccak256(0, 0x40)
                mstore(0, marketId)
                mstore(0x20, hash)
                hash := keccak256(0, 0x40)
                mstore(0, roundId)
                mstore(0x20, hash)
                let resultHash := keccak256(0, 0x40)

                if gt(sload(resultHash), 0) {
                    mstore(0x00, 0x646cf558) // AlreadyClaimed()
                    revert(0x1c, 0x04)
                }

                // marketToRoundToResult
                mstore(0x00, marketId)
                mstore(0x20, 10)
                hash := keccak256(0x00, 0x40)
                mstore(0x00, roundId)
                mstore(0x20, hash)
                hash := keccak256(0x00, 0x40)
                let userBet := 0
                let winningBets := 1
                let result := sload(hash)
                switch result
                case 1 {
                    // userToRedeemedMarketRound
                    sstore(resultHash, 1)

                    // userToMarketToRoundToYesReserves
                    mstore(0x00, caller())
                    mstore(0x20, 7)
                    hash := keccak256(0, 0x40)
                    mstore(0, marketId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    userBet := sload(hash)

                    // marketToRoundToOutYesShares
                    mstore(0x00, marketId)
                    mstore(0x20, 14)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    winningBets := sload(hash)
                }
                case 2 {
                    // userToRedeemedMarketRound
                    sstore(resultHash, 1)

                    // userToMarketToRoundToNoReserves
                    mstore(0x00, caller())
                    mstore(0x20, 8)
                    hash := keccak256(0, 0x40)
                    mstore(0, marketId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    userBet := sload(hash)

                    // marketToRoundToOutNoShares
                    mstore(0x00, marketId)
                    mstore(0x20, 15)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)
                    winningBets := sload(hash)
                }
                default {
                    tstore(i, roundId)
                }

                if gt(sload(resultHash), 0) {
                    // marketToRoundToTreasury
                    mstore(0x00, marketId)
                    mstore(0x20, 6)
                    hash := keccak256(0, 0x40)
                    mstore(0, roundId)
                    mstore(0x20, hash)
                    hash := keccak256(0, 0x40)

                    let amountOut := div(mul(userBet, sload(hash)), winningBets)

                    mstore(0x00, result)
                    mstore(0x20, amountOut)
                    log4(0x00, 0x40, 0x3f63856e2d8c431941e15ac15a28d4201c2838a61987308f61a9d5d01aac4839, marketId, roundId, caller())

                    if iszero(
                        call(gas(), caller(), amountOut, 0, 0, 0, 0)
                    ) {
                        mstore(0x00, 0x98f73609) //InvalidOutput()
                        revert(0x1c, 0x04)
                    }
                }
            }
            let newLen := 0
            if gt(tload(0), 0) {
                sstore(add(itemHash, newLen), tload(0))
                tstore(0, 0)
                newLen := add(newLen, 1)
            }
            if gt(tload(1), 0) {
                sstore(add(itemHash, newLen), tload(1))
                tstore(1, 0)
                newLen := add(newLen, 1)
            }
            if and(gt(tload(sub(len, 1)), 0), gt(len, 0)) {
                sstore(add(itemHash, newLen), tload(sub(len, 1)))
                tstore(sub(len, 1), 0)
                newLen := add(newLen, 1)
            }
            if and(gt(tload(sub(len, 2)), 0), gt(len, 1)) {
                sstore(add(itemHash, newLen), tload(sub(len, 2)))
                tstore(sub(len, 2), 0)
                newLen := add(newLen, 1)
            }
            sstore(roundHashLen, newLen)
        }
    }

    /**
     * @notice Withdraws accumulated protocol fees to admin
     * @dev Only admin can call. Transfers all accumulated fees and resets to 0
     * 
     * Fee Sources:
     * - 60% of all entry fees (0.3% of entry amount)
     * - 60% of all exit fees (0.3% of exit amount)
     * - Treasury from rounds with no winners
     * 
     * @custom:reverts Require fails if HYPE transfer to admin fails
     */
    function claimFees() external {
        uint256 feesToClaim = fees;
        fees = 0;
        require(payable(admin).send(feesToClaim));
    }

    // Internal functions
    /**
     * @notice Fetches current price from oracle for a given market
     * @dev Calls precompiled oracle contract at address 0x807
     * @param index Market index to fetch price for
     * @return price Current oracle price for the market
     * 
     * @custom:reverts OracleError if oracle call fails
     */
    function _oraclePx(uint256 index) internal view returns (uint256 price) {
        address oracle = 0x0000000000000000000000000000000000000807;
        assembly {
            mstore(0, index)
            if iszero(staticcall(gas(), oracle, 0x00, 0x20, 0x00, 0x20)) {
                mstore(0x00, 0xb41b6cb1) // OracleError()
                revert(0x1c, 0x04)
            }
            price := mload(0)
        }
      }

    /**
     * @notice Internal function to sell YES shares for NO shares
     * @dev Uses AMM formula: s = p_amount * S / (P + p_amount)
     * @param amount Amount of YES shares to sell
     * @param marketId Market identifier
     * @param currentRound Round identifier
     * @return userSecondaryReserves Amount of NO shares received
     * 
     * Effects:
     * - Increases YES reserves by amount
     * - Decreases NO reserves by userSecondaryReserves
     * - Updates user balances in transient storage
     * - Updates outstanding shares in transient storage
     */
    function _sellYes(uint256 amount, uint256 marketId, uint256 currentRound) internal returns(uint256 userSecondaryReserves) {
        assembly {

            // marketToRoundToYesReserves DONE
            mstore(0x00, marketId)
            mstore(0x20, 4)
            let hash := keccak256(0, 0x40)
            mstore(0, currentRound)
            mstore(0x20, hash)
            hash := keccak256(0, 0x40)
            let yesReserves := sload(hash)
            sstore(hash, add(yesReserves, amount))

            // marketToRoundToNoReserves DONE
            mstore(0x00, marketId)
            mstore(0x20, 5)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            let noReserves := sload(hash)
            // s = p_amount * S / (P + p_amount)
            userSecondaryReserves := div(mul(amount, noReserves), add(amount, yesReserves))
            sstore(hash, sub(noReserves, userSecondaryReserves))

            // marketToRoundToTreasury DONE
            mstore(0x00, marketId)
            mstore(0x20, 6)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(2, sload(hash))

            // userToMarketToRoundToYesReserves DONE
            mstore(0x00, caller())
            mstore(0x20, 7)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, marketId)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            let state := sload(hash)
            if lt(state, amount) {
               mstore(0x00, 0x7b9c8916) //InvalidReserves()
               revert(0x1c, 0x04)
            }
            tstore(3, sub(state, amount))

            // userToMarketToRoundToNoReserves DONE
            mstore(0x00, caller())
            mstore(0x20, 8)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, marketId)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(4, add(sload(hash), userSecondaryReserves))

            // marketToRoundToOutYesShares DONE
            mstore(0x00, marketId)
            mstore(0x20, 14)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(5, sub(sload(hash), amount))

            // marketToRoundToOutNoShares DONE
            mstore(0x00, marketId)
            mstore(0x20, 15)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(6, add(sload(hash), userSecondaryReserves))
        }
    }

    /**
     * @notice Internal function to sell NO shares for YES shares
     * @dev Uses AMM formula: p = s_amount * P / (S + s_amount)
     * @param amount Amount of NO shares to sell
     * @param marketId Market identifier
     * @param currentRound Round identifier
     * @return userPrimaryReserves Amount of YES shares received
     * 
     * Effects:
     * - Increases NO reserves by amount
     * - Decreases YES reserves by userPrimaryReserves
     * - Updates user balances in transient storage
     * - Updates outstanding shares in transient storage
     */
    function _sellNo(uint256 amount, uint256 marketId, uint256 currentRound) internal returns(uint256 userPrimaryReserves) {
        assembly {
            // marketToRoundToNoReserves DONE
            mstore(0x00, marketId)
            mstore(0x20, 5)
            let hash := keccak256(0, 0x40)
            mstore(0, currentRound)
            mstore(0x20, hash)
            hash := keccak256(0, 0x40)
            let noReserves := sload(hash)
            sstore(hash, add(noReserves, amount))

            // marketToRoundToYesReserves DONE
            mstore(0x00, marketId)
            mstore(0x20, 4)
            hash := keccak256(0, 0x40)
            mstore(0, currentRound)
            mstore(0x20, hash)
            hash := keccak256(0, 0x40)
            let yesReserves := sload(hash)
            // p = s_amount * P / (S + s_amount)
            userPrimaryReserves := div(mul(amount, yesReserves), add(amount, noReserves))
            sstore(hash, sub(yesReserves, userPrimaryReserves))

            // marketToRoundToTreasury DONE
            mstore(0x00, marketId)
            mstore(0x20, 6)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(2, sload(hash))

            // userToMarketToRoundToYesReserves DONE
            mstore(0x00, caller())
            mstore(0x20, 7)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, marketId)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(3, add(sload(hash), userPrimaryReserves))

            // userToMarketToRoundToNoReserves DONE
            mstore(0x00, caller())
            mstore(0x20, 8)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, marketId)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            let state := sload(hash)
            if lt(state, amount) {
                mstore(0x00, 0x7b9c8916) //InvalidReserves()
                revert(0x1c, 0x04)
            }
            tstore(4, sub(state, amount))

            // marketToRoundToOutYesShares DONE
            mstore(0x00, marketId)
            mstore(0x20, 14)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(5, add(sload(hash), userPrimaryReserves))

            // marketToRoundToOutNoShares DONE
            mstore(0x00, marketId)
            mstore(0x20, 15)
            hash := keccak256(0, 0x40)
            mstore(0x20, hash)
            mstore(0, currentRound)
            hash := keccak256(0, 0x40)
            tstore(6, sub(sload(hash), amount))
        }
    }

    //MARKET INFO VIEW FUNCTIONS
    /**
     * @notice Get market data for all markets in the current round
     * @return marketData Array of MarketData structs for all available markets
     */
    function currentRoundInfo() external view returns(MarketData[] memory marketData) {
        uint256 len = availableMarkets.length();
        marketData = new MarketData[](len);
        uint256 roundId = universalRound;
        uint256 currentRoundStart = roundStart;
        for(uint i=0; i<len; i++) {
            uint256 marketId = availableMarkets.at(i);
            uint256 currentPrice = _oraclePx(marketId);
            marketData[i] = MarketData({
                marketId: marketId,
                roundId: roundId,
                roundStart: currentRoundStart,
                yesReserves: marketToRoundToYesReserves[marketId][roundId],
                noReserves: marketToRoundToNoReserves[marketId][roundId],
                marketTreasury: marketToRoundToTreasury[marketId][roundId],
                lastPrice: marketToRoundToPrice[marketId][roundId-1],
                currentPrice: currentPrice,
                result: marketToRoundToResult[marketId][roundId],
                outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
                outNoReserves: marketToRoundToOutNoShares[marketId][roundId]
            });
        }
    }


    //MARKET INFO VIEW FUNCTIONS
    /**
     * @notice Get market data for all markets in the current and next round
     * @return roundId Current round's number
     * @return marketDataCurrent Array of MarketData structs for all available markets for active round
     * @return marketDataFuture Array of MarketData structs for all available markets for next round
     */
    function currentAndFutureRoundInfo() external view returns(uint256 roundId, MarketDataWithHistory[] memory marketDataCurrent, MarketDataWithHistory[] memory marketDataFuture) {
        uint256 len = availableMarkets.length();
        roundId = universalRound;
        uint256 historyLen = roundId > 10 ? 10 : roundId-1;
        marketDataCurrent = new MarketDataWithHistory[](len);
        marketDataFuture = new MarketDataWithHistory[](len);
        uint256 futureRound = roundId + 1;
        uint256 currentRoundStart = roundStart;
        for(uint i=0; i<len; i++) {
            uint256[] memory history = new uint256[](historyLen);
            uint256 marketId = availableMarkets.at(i);
            uint256 currentPrice = _oraclePx(marketId);
            for(uint j=0; j<historyLen; j++) {
                history[j] = marketToRoundToResult[marketId][roundId-j-1];
            }
            marketDataCurrent[i] = MarketDataWithHistory({
                marketId: marketId,
                roundId: roundId,
                roundStart: currentRoundStart,
                yesReserves: marketToRoundToYesReserves[marketId][roundId],
                noReserves: marketToRoundToNoReserves[marketId][roundId],
                marketTreasury: marketToRoundToTreasury[marketId][roundId],
                lastPrice: marketToRoundToPrice[marketId][roundId-1],
                currentPrice: currentPrice,
                result: marketToRoundToResult[marketId][roundId],
                outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
                outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
                delistingRound: marketToDelistingRound[marketId],
                history: history
            });
            marketDataFuture[i] = MarketDataWithHistory({
                marketId: marketId,
                roundId: futureRound,
                roundStart: currentRoundStart,
                yesReserves: marketToRoundToYesReserves[marketId][futureRound],
                noReserves: marketToRoundToNoReserves[marketId][futureRound],
                marketTreasury: marketToRoundToTreasury[marketId][futureRound],
                lastPrice: marketToRoundToPrice[marketId][roundId],
                currentPrice: currentPrice,
                result: marketToRoundToResult[marketId][futureRound],
                outYesReserves: marketToRoundToOutYesShares[marketId][futureRound],
                outNoReserves: marketToRoundToOutNoShares[marketId][futureRound],
                delistingRound: marketToDelistingRound[marketId],
                history: history
            });
            delete history;
        }
    }

    /**
     * @notice Get market data for all markets in a specific round
     * @param roundId Round identifier to query
     * @return marketData Array of MarketData structs for all markets in the round
     */
    function inputRoundInfo(uint256 roundId) external view returns(MarketData[] memory marketData) {
        uint256 len = availableMarkets.length();
        marketData = new MarketData[](len);
        uint256 currentRoundStart = roundStart;
        for(uint i=0; i<len; i++) {
            uint256 marketId = availableMarkets.at(i);
            uint256 cPrice = marketToRoundToPrice[marketId][roundId];
            uint256 currentPrice = cPrice == 0 ? _oraclePx(marketId): cPrice;
            marketData[i] = MarketData({
                marketId: marketId,
                roundId: roundId,
                roundStart: currentRoundStart,
                yesReserves: marketToRoundToYesReserves[marketId][roundId],
                noReserves: marketToRoundToNoReserves[marketId][roundId],
                marketTreasury: marketToRoundToTreasury[marketId][roundId],
                lastPrice: marketToRoundToPrice[marketId][roundId-1],
                currentPrice: currentPrice,
                result: marketToRoundToResult[marketId][roundId],
                outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
                outNoReserves: marketToRoundToOutNoShares[marketId][roundId]
            });
        }
    }

    /**
     * @notice Get market data for a specific market in the current round
     * @param marketId Market identifier to query
     * @return marketData MarketData struct for the specified market
     */
    function currentSingleMarketRoundInfo(uint256 marketId) external view returns(MarketData memory marketData) {
        uint256 roundId = universalRound;
        uint256 currentRoundStart = roundStart;
        uint256 currentPrice = _oraclePx(marketId);
        marketData = MarketData({
            marketId: marketId,
            roundId: roundId,
            roundStart: currentRoundStart,
            yesReserves: marketToRoundToYesReserves[marketId][roundId],
            noReserves: marketToRoundToNoReserves[marketId][roundId],
            marketTreasury: marketToRoundToTreasury[marketId][roundId],
            lastPrice: marketToRoundToPrice[marketId][roundId-1],
            currentPrice: currentPrice,
            result: marketToRoundToResult[marketId][roundId],
            outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
            outNoReserves: marketToRoundToOutNoShares[marketId][roundId]
        });
    }

    /**
     * @notice Get market data for a specific market in a specific round
     * @param marketId Market identifier to query
     * @param roundId Round identifier to query
     * @return marketData MarketData struct for the specified market and round
     */
    function inputSingleMarketRoundInfo(uint256 marketId, uint256 roundId) external view returns(MarketDataWithHistory memory marketData) {
        uint256 currentRoundStart = roundStart;
        uint256 cPrice = marketToRoundToPrice[marketId][roundId];
        uint256 currentPrice = cPrice == 0 ? _oraclePx(marketId): cPrice;
        uint256 historyLen = roundId > 10 ? 10 : roundId-1;
        uint256[] memory history = new uint256[](historyLen);
        for(uint j=0; j<historyLen; j++) {
            history[j] = marketToRoundToResult[marketId][roundId-j-1];
        }
        marketData = MarketDataWithHistory({
            marketId: marketId,
            roundId: roundId,
            roundStart: currentRoundStart,
            yesReserves: marketToRoundToYesReserves[marketId][roundId],
            noReserves: marketToRoundToNoReserves[marketId][roundId],
            marketTreasury: marketToRoundToTreasury[marketId][roundId],
            lastPrice: marketToRoundToPrice[marketId][roundId-1],
            currentPrice: currentPrice,
            result: marketToRoundToResult[marketId][roundId],
            outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
            outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
            delistingRound: marketToDelistingRound[marketId],
            history: history
        });
    }

    /**
     * @notice Get market history for a specific market
     * @param marketId Market identifier to query
     * @return marketData MarketData struct for the specified market and round
     */
    function inputMarketRoundHistory(uint256 marketId) external view returns(MarketHistory[] memory marketData) {
        uint256 roundId = universalRound;
        uint256 historyLen = roundId > 150 ? 150 : roundId-1;
        uint256 index = roundId-historyLen;
        marketData = new MarketHistory[](historyLen);
        for(uint j=0; j<historyLen; j++) {
            marketData[j] = MarketHistory({
                marketId: marketId,
                roundId: index + j,
                openPrice: marketToRoundToPrice[marketId][index - 1+j],
                closePrice: marketToRoundToPrice[marketId][index + j],
                result: marketToRoundToResult[marketId][index + j],
                outYesReserves: marketToRoundToOutYesShares[marketId][index+j],
                outNoReserves: marketToRoundToOutNoShares[marketId][index+j]
            });
        }
    }

    /**
     * @notice Check if current round can be resolved and get resolver fees
     * @return isResolvable True if 10 minutes have passed and round can be resolved
     * @return secondsLeft Seconds remaining until round can be resolved (0 if resolvable)
     * @return currentRoundFees Accumulated resolver fees for current round (40% of trading fees)
     */
    function checkResolutionStatus() external view returns(bool isResolvable, uint256 secondsLeft, uint256 currentRoundFees) {
        isResolvable = block.timestamp >= roundStart + 600;
        secondsLeft = block.timestamp < roundStart + 600 ? roundStart + 600 - block.timestamp : 0;
        currentRoundFees = roundIdToResolverFees[universalRound];
    }

    //USER INFO VIEW FUNCTIONS
    /**
     * @notice Get all unclaimed round IDs for a user in a specific market
     * @param user User address to query
     * @param marketId Market identifier
     * @return roundIds Array of round IDs where user has unclaimed positions
     */
    function userUnclaimedRoundsPerMarketId(address user, uint256 marketId) external view returns (uint256[] memory roundIds) {
        return userToActiveRoundsPerMarket[user][marketId];
    }

    /**
     * @notice Get unclaimed round IDs with pagination (500 per page)
     * @param user User address to query
     * @param marketId Market identifier
     * @param page Page number (0-indexed)
     * @return total Total number of unclaimed rounds
     * @return roundIds Array of round IDs for the requested page (max 500)
     */
    function userUnclaimedRoundsPerMarketIdWithPage(address user, uint256 marketId, uint256 page) external view returns (uint256 total, uint256[] memory roundIds) {
        total = userToActiveRoundsPerMarket[user][marketId].length;
        uint256 pageSize = 500;
        uint256 startIndex = page * pageSize;

        if (startIndex >= total) {
            roundIds = new uint256[](0);
            return (total, roundIds);
        }

        uint256 remaining = total - startIndex;
        uint256 length = remaining < pageSize ? remaining : pageSize;
        roundIds = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            roundIds[i] = userToActiveRoundsPerMarket[user][marketId][startIndex + i];
        }

        return (total, roundIds);
    }

    /**
     * @notice Get detailed data for unclaimed rounds with pagination (100 per page)
     * @param user User address to query
     * @param marketId Market identifier
     * @param page Page number (0-indexed)
     * @return total Total number of unclaimed rounds
     * @return userData Array of UserData structs for the requested page (max 100)
     */
    function userUnclaimedRoundsDataPerMarketId(address user, uint256 marketId, uint256 page) external view returns(uint256 total, UserData[] memory userData){
        total = userToActiveRoundsPerMarket[user][marketId].length;
        uint256 pageSize = 100;
        uint256 startIndex = page * pageSize;
        if (startIndex >= total) {
            userData = new UserData[](0);
            return (total, userData);
        }

        uint256 remaining = total - startIndex;
        uint256 length = remaining < pageSize ? remaining : pageSize;
        userData = new UserData[](length);
        for(uint i=0; i<length;i++) {
            uint256 roundId = userToActiveRoundsPerMarket[user][marketId][startIndex + i];
            userData[i] = UserData({
                marketId: marketId,
                roundId: roundId,
                result: marketToRoundToResult[marketId][roundId],
                outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
                outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
                userYesReserves: userToMarketToRoundToYesReserves[user][marketId][roundId],
                userNoReserves: userToMarketToRoundToNoReserves[user][marketId][roundId],
                treasury: marketToRoundToTreasury[marketId][roundId],
                userRedeemed: userToRedeemedMarketRound[user][marketId][roundId]
            });
        }
    }

    /**
     * @notice Get unclaimed rounds across all markets for a user
     * @param user User address to query
     * @return roundsPerMarket Array of UserToRoundsPerMarket structs for all markets
     */
    function userToUnclaimedRounds(address user) external view returns(UserToRoundsPerMarket[] memory roundsPerMarket) {
        uint256 len = availableMarkets.length();
        roundsPerMarket = new UserToRoundsPerMarket[](len);
        for(uint i=0; i<len;i++) {
            uint256 marketId = availableMarkets.at(i);
            roundsPerMarket[i] = UserToRoundsPerMarket({
                marketId: marketId,
                roundIds: userToActiveRoundsPerMarket[user][marketId]
            });
        }
    }

    /**
     * @notice Get user data for all markets in the current round
     * @param user User address to query
     * @return userData Array of UserData structs for all markets in current round
     */
    function userDataPerCurrentRoundId(address user) external view returns(UserData[] memory userData){
        uint256 len = availableMarkets.length();
        userData = new UserData[](len);
        uint256 roundId = universalRound;
        for(uint i=0; i<len;i++) {
            uint256 marketId = availableMarkets.at(i);
            userData[i] = UserData({
                marketId: marketId,
                roundId: roundId,
                result: marketToRoundToResult[marketId][roundId],
                outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
                outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
                userYesReserves: userToMarketToRoundToYesReserves[user][marketId][roundId],
                userNoReserves: userToMarketToRoundToNoReserves[user][marketId][roundId],
                treasury: marketToRoundToTreasury[marketId][roundId],
                userRedeemed: userToRedeemedMarketRound[user][marketId][roundId]
            });
        }
    }

    /**
     * @notice Get user data for a specific market in the current round
     * @param user User address to query
     * @param marketId Market identifier
     * @return userData UserData struct for the specified market in current round
     */
    function userDataPerMarketAndCurrentRoundId(address user, uint256 marketId) external view returns(UserData memory userData){
        uint256 roundId = universalRound;
        userData = UserData({
            marketId: marketId,
            roundId: roundId,
            result: marketToRoundToResult[marketId][roundId],
            outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
            outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
            userYesReserves: userToMarketToRoundToYesReserves[user][marketId][roundId],
            userNoReserves: userToMarketToRoundToNoReserves[user][marketId][roundId],
            treasury: marketToRoundToTreasury[marketId][roundId],
            userRedeemed: userToRedeemedMarketRound[user][marketId][roundId]
        });
    }

    /**
     * @notice Get user data for all markets in a specific round
     * @param user User address to query
     * @param roundId Round identifier
     * @return userData Array of UserData structs for all markets in the round
     */
    function userDataPerRoundId(address user, uint256 roundId) external view returns(UserData[] memory userData){
        uint256 len = availableMarkets.length();
        userData = new UserData[](len);
        for(uint i=0; i<len;i++) {
            uint256 marketId = availableMarkets.at(i);
            userData[i] = UserData({
                marketId: marketId,
                roundId: roundId,
                result: marketToRoundToResult[marketId][roundId],
                outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
                outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
                userYesReserves: userToMarketToRoundToYesReserves[user][marketId][roundId],
                userNoReserves: userToMarketToRoundToNoReserves[user][marketId][roundId],
                treasury: marketToRoundToTreasury[marketId][roundId],
                userRedeemed: userToRedeemedMarketRound[user][marketId][roundId]
            });
        }
    }

    /**
     * @notice Get user data for a specific market and round
     * @param user User address to query
     * @param marketId Market identifier
     * @param roundId Round identifier
     * @return userData UserData struct for the specified market and round
     */
    function userDataPerMarketIdAndRoundId(address user, uint256 marketId, uint256 roundId) external view returns(UserData memory userData){
        userData = UserData({
            marketId: marketId,
            roundId: roundId,
            result: marketToRoundToResult[marketId][roundId],
            outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
            outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
            userYesReserves: userToMarketToRoundToYesReserves[user][marketId][roundId],
            userNoReserves: userToMarketToRoundToNoReserves[user][marketId][roundId],
            treasury: marketToRoundToTreasury[marketId][roundId],
            userRedeemed: userToRedeemedMarketRound[user][marketId][roundId]
        });
    }

    /**
     * @notice Get user data for a specific market across multiple rounds
     * @param user User address to query
     * @param marketId Market identifier
     * @param roundIds Array of round identifiers
     * @return userData Array of UserData structs for the specified rounds
     */
    function userDataPerMarketIdAndRoundIds(address user, uint256 marketId, uint256[] memory roundIds) external view returns(UserData[] memory userData){
        uint256 len = roundIds.length;
        userData = new UserData[](len);
        for(uint i=0; i<len;i++) {
            uint256 roundId = roundIds[i];
            userData[i] = UserData({
                marketId: marketId,
                roundId: roundId,
                result: marketToRoundToResult[marketId][roundId],
                outYesReserves: marketToRoundToOutYesShares[marketId][roundId],
                outNoReserves: marketToRoundToOutNoShares[marketId][roundId],
                userYesReserves: userToMarketToRoundToYesReserves[user][marketId][roundId],
                userNoReserves: userToMarketToRoundToNoReserves[user][marketId][roundId],
                treasury: marketToRoundToTreasury[marketId][roundId],
                userRedeemed: userToRedeemedMarketRound[user][marketId][roundId]
            });
        }
    }

    /**
     * @notice Calculate expected shares for a given input amount
     * @dev Applies 0.3% fee before calculation. Used for price quotes
     * @param amountIn Amount of HYPE to spend
     * @param marketId Market identifier
     * @param roundId Round identifier
     * @param side 0 for YES, 1 for NO
     * @return amountOut Expected shares to receive (after fee)
     * 
     * Formula:
     * - amountAfterFee = amountIn * 997 / 1000
     * - If YES: amountOut = (amountAfterFee * yesReserves) / (amountAfterFee + noReserves) + amountAfterFee
     * - If NO: amountOut = (amountAfterFee * noReserves) / (amountAfterFee + yesReserves) + amountAfterFee
     */
    function getAmountOut(uint256 amountIn, uint256 marketId, uint256 roundId, uint256 side) external view returns(uint256 amountOut) {
        uint256 yesShares = marketToRoundToYesReserves[marketId][roundId];
        uint256 noShares = marketToRoundToNoReserves[marketId][roundId];
        amountIn = amountIn * 997/1000;
        if (side == 0) {
            amountOut = ((amountIn * yesShares) / (amountIn + noShares)) + amountIn;
        } else {
            amountOut = ((amountIn * noShares) / (amountIn + yesShares)) + amountIn;
        }
    }

    function getAllAvailableMarkets() external view returns(uint256[] memory) {
        return availableMarkets.values();
    }

    function getAllMarkets() external view returns(uint256[] memory) {
        return allMarkets.values();
    }

    function getBothMarkets() external view returns(uint256[] memory, uint256[] memory) {
        return (availableMarkets.values(), allMarkets.values());
    }


}
