# MarketMakerAMM Smart Contract Documentation

## Overview

The **MarketMakerAMM** is a prediction market automated market maker (AMM) contract that enables users to bet on price movements of various assets. The contract operates in rounds, where each round lasts 10 minutes (600 seconds), with a 5-minute active trading window and a 5-minute pre-market trading window.

## Key Concepts

### Market Structure
- **Markets**: Each market represents a different asset (identified by `marketId`)
- **Rounds**: Time-based betting periods (10 minutes each)
- **YES/NO Shares**: Users buy shares predicting price will go UP (YES) or DOWN (NO)
- **AMM Mechanism**: Constant product formula for pricing shares

### Round Lifecycle
1. **Active Round** (0-5 minutes): Users can enter/exit positions
2. **Pre-Market** (5-10 minutes): Next round opens for early positions
3. **Resolution** (10 minutes): Anyone can resolve the round and claim resolver fees

### Fee Structure
- **Trading Fee**: 0.3% (3/1000) on all entries and exits
- **Fee Distribution**:
  - 60% goes to protocol admin
  - 40% goes to round resolver (incentive to resolve markets)

## Contract Architecture

### State Variables

```solidity
address internal admin;                    // Contract administrator
uint256 public fees;                       // Accumulated protocol fees
uint256 public universalRound;             // Current round number
uint256 public roundStart;                 // Timestamp when current round started
```

### Storage Mappings

| Mapping | Description |
|---------|-------------|
| `marketToRoundToYesReserves` | YES share reserves per market per round |
| `marketToRoundToNoReserves` | NO share reserves per market per round |
| `marketToRoundToTreasury` | Total treasury (prize pool) per market per round |
| `userToMarketToRoundToYesReserves` | User's YES shares per market per round |
| `userToMarketToRoundToNoReserves` | User's NO shares per market per round |
| `marketToRoundToPrice` | Oracle price snapshot per market per round |
| `marketToRoundToResult` | Round result (0=unresolved, 1=YES won, 2=NO won) |
| `userToActiveRoundsPerMarket` | User's active round IDs per market |
| `userToRegisteredRound` | Tracks if user is registered in a round |
| `userToRedeemedMarketRound` | Tracks if user has claimed winnings |
| `marketToRoundToOutYesShares` | Total outstanding YES shares |
| `marketToRoundToOutNoShares` | Total outstanding NO shares |
| `roundIdToResolverFees` | Accumulated resolver fees per round |

### Data Structures

#### MarketData
```solidity
struct MarketData {
    uint256 marketId;           // Market identifier
    uint256 roundId;            // Round identifier
    uint256 roundStart;         // Round start timestamp
    uint256 marketTreasury;     // Total prize pool
    uint256 yesReserves;        // YES share reserves
    uint256 noReserves;         // NO share reserves
    uint256 outYesReserves;     // Outstanding YES shares
    uint256 outNoReserves;      // Outstanding NO shares
    uint256 lastPrice;          // Previous round's price
    uint256 currentPrice;       // Current oracle price
    uint256 result;             // Round result
}
```

#### UserData
```solidity
struct UserData {
    uint256 marketId;           // Market identifier
    uint256 roundId;            // Round identifier
    uint256 result;             // Round result
    uint256 outYesReserves;     // Total outstanding YES shares
    uint256 outNoReserves;      // Total outstanding NO shares
    uint256 userYesReserves;    // User's YES shares
    uint256 userNoReserves;     // User's NO shares
    uint256 treasury;           // Market treasury
    uint256 userRedeemed;       // Has user claimed winnings
}
```

## Core Functions

### 1. enterMarket
**Purpose**: Buy YES or NO shares in a prediction market

**Parameters**:
- `minAmountOut`: Minimum shares expected (slippage protection)
- `marketId`: Market identifier
- `roundId`: Round identifier
- `side`: 0 for YES, 1 for NO

**Payable**: Yes (send HYPE to buy shares)

**Process**:
1. Validates round is active or in pre-market
2. Deducts 0.3% fee (60% to protocol, 40% to resolver)
3. Calculates shares using AMM formula
4. Updates reserves and user balances
5. Registers user in round if first time

**Reverts**:
- `InvalidInput`: side > 1
- `InvalidRound`: roundId out of valid range
- `RoundExpired`: Active round has ended
- `RoundNotYetInitialised`: Pre-market not yet open
- `SlippageReached`: Output below minAmountOut

### 2. exitMarket
**Purpose**: Sell shares and exit position

**Parameters**:
- `minNativeAmountOut`: Minimum HYPE expected (slippage protection)
- `marketId`: Market identifier
- `roundId`: Round identifier
- `amountYes`: User's YES shares to sell
- `amountNo`: User's NO shares to sell
- `toBeExchanged`: Amount to swap between YES/NO before exit

**Process**:
1. Optionally swaps YES↔NO shares to balance position
2. Redeems equal amounts of YES and NO shares for HYPE
3. Deducts 0.3% exit fee
4. Transfers HYPE to user

**Reverts**:
- `InvalidRound`: roundId out of valid range
- `RoundExpired`: Active round has ended
- `SlippageReached`: Output below minNativeAmountOut
- `InvalidOutput`: HYPE transfer failed

### 3. resolveMarkets
**Purpose**: Resolve all markets for current round and start new round

**Process**:
1. Validates 10 minutes have passed since round start
2. Fetches current price from oracle for each market
3. Compares with previous round's price
4. Sets result: 1 if price increased (YES wins), 2 if decreased (NO wins)
5. Initializes reserves for round+2
6. Increments universalRound
7. Pays resolver fees to caller

**Reverts**:
- `InvalidTimestamp`: Called before 10 minutes elapsed
- `RoundResolved`: Round already resolved
- `InvalidOutput`: Fee transfer failed

### 4. redeemRoundsPerMarketIdCapped
**Purpose**: Claim winnings from resolved rounds (max 25 rounds per call)

**Parameters**:
- `marketId`: Market identifier

**Process**:
1. Processes up to 25 pending rounds
2. For each resolved round:
   - Calculates user's share of treasury
   - Transfers winnings
   - Marks round as redeemed
3. Reorganizes pending rounds array

**Reverts**:
- `AlreadyClaimed`: User already claimed this round
- `InvalidOutput`: HYPE transfer failed

### 5. redeemPendingRoundsPerMarketId
**Purpose**: Claim winnings from ALL pending rounds (unbounded)

**Parameters**:
- `marketId`: Market identifier

**Process**:
- Similar to capped version but processes all rounds
- **Warning**: May run out of gas with many pending rounds

### 6. claimFees
**Purpose**: Admin function to withdraw accumulated protocol fees

**Access**: Admin only

**Process**:
- Transfers all accumulated fees to admin
- Resets fees to 0

## View Functions

### Market Information

| Function | Description |
|----------|-------------|
| `currentRoundInfo()` | Get data for all markets in current round |
| `inputRoundInfo(roundId)` | Get data for all markets in specific round |
| `currentSingleMarketRoundInfo(marketId)` | Get data for one market in current round |
| `inputSingleMarketRoundInfo(marketId, roundId)` | Get data for one market in specific round |
| `checkResolutionStatus()` | Check if round can be resolved and resolver fees |

### User Information

| Function | Description |
|----------|-------------|
| `userUnclaimedRoundsPerMarketId(user, marketId)` | Get all unclaimed round IDs |
| `userUnclaimedRoundsPerMarketIdWithPage(user, marketId, page)` | Get unclaimed rounds with pagination |
| `userUnclaimedRoundsDataPerMarketId(user, marketId, page)` | Get detailed data for unclaimed rounds |
| `userToUnclaimedRounds(user)` | Get unclaimed rounds across all markets |
| `userDataPerCurrentRoundId(user)` | Get user data for current round |
| `userDataPerMarketAndCurrentRoundId(user, marketId)` | Get user data for specific market in current round |
| `userDataPerRoundId(user, roundId)` | Get user data for specific round |
| `userDataPerMarketIdAndRoundId(user, marketId, roundId)` | Get user data for specific market and round |
| `userDataPerMarketIdAndRoundIds(user, marketId, roundIds[])` | Get user data for multiple rounds |

### Pricing

| Function | Description |
|----------|-------------|
| `getAmountOut(amountIn, marketId, roundId, side)` | Calculate expected shares for given input |

## AMM Pricing Formula

### Buying YES Shares
```
userPrimaryReserves = (amountIn * yesReserves) / (amountIn + noReserves)
totalYesShares = userPrimaryReserves + amountIn
```

### Buying NO Shares
```
userSecondaryReserves = (amountIn * noReserves) / (amountIn + yesReserves)
totalNoShares = userSecondaryReserves + amountIn
```

## Oracle Integration

The contract uses a precompiled oracle at address `0x0000000000000000000000000000000000000807` to fetch asset prices. The oracle returns prices for different market indices.

## Security Features

1. **Slippage Protection**: Users specify minimum output amounts
2. **Round Validation**: Strict checks on round timing and validity
4. **Double-Claim Prevention**: Tracks redeemed rounds
5. **Gas Optimization**: Heavy use of assembly for critical paths

## Gas Optimization

The contract extensively uses inline assembly for:
- Storage access patterns
- Keccak256 hashing
- State updates
- HYPE transfers

This reduces gas costs significantly compared to pure Solidity.

## Example User Flow

### 1. Enter Market (Buy YES)
```solidity
// User thinks BTC price will go up
// Send 10 HYPE to buy YES shares
contract.enterMarket{value: 10 ether}(
    minAmountOut: 9.5 ether,  // Accept up to 5% slippage
    marketId: 0,               // BTC market
    roundId: 42,               // Current round
    side: 0                    // YES
);
```

### 2. Exit Market (Sell Shares)
```solidity
// User wants to exit with 5 YES and 2 NO shares
contract.exitMarket(
    minNativeAmountOut: 1.9 ether,  // Minimum HYPE expected
    marketId: 0,
    roundId: 42,
    amountYes: 5 ether,
    amountNo: 2 ether,
    toBeExchanged: 2 ether  // Swap 2 YES to NO first
);
```

### 3. Resolve Round
```solidity
// Anyone can call after 10 minutes
contract.resolveMarkets();
// Caller receives resolver fees
```

### 4. Claim Winnings
```solidity
// Claim winnings from market 0
contract.redeemRoundsPerMarketIdCapped(0);
```

## License

MIT
