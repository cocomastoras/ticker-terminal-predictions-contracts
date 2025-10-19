import {expect} from "chai";
import hre, {network} from "hardhat";

const { networkHelpers, ethers} = await network.connect();

describe("Financial Prediction Markets", function () {
  async function deployPrecompileAndAMM() {
    const ORACLE_PX_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000807";
    // 1. Deploy an instance of `SpotMock` as you would any other contract.
    const SpotMock = await ethers.getContractFactory("Spot_Precompile");
    const spotMock = await SpotMock.deploy();
    // 2. Cache the bytecode that was just deployed.
    const code = await ethers.provider.getCode(await spotMock.getAddress())
    // 3. Use `hardhat_setCode` to set the bytecode at `SPOT_PX_PRECOMPILE_ADDRESS`
    await ethers.provider.send("hardhat_setCode", [ORACLE_PX_PRECOMPILE_ADDRESS, code]);
    const signers = await ethers.getSigners();
    const admin = signers[19]
    const MarketMakerAMM = await ethers.getContractFactory("MarketMakerAMM");
    const marketMakerAMM = await MarketMakerAMM.connect(admin).deploy([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], await admin.getAddress());
    return  { marketMakerAMM, admin };
  }

  async function deployStaticPrecompileAndAMM() {
    const ORACLE_PX_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000807";
    // 1. Deploy an instance of `SpotMock` as you would any other contract.
    const SpotMock = await ethers.getContractFactory("Spot_Precompile_Static");
    const spotMock = await SpotMock.deploy();
    // 2. Cache the bytecode that was just deployed.
    const code = await ethers.provider.getCode(await spotMock.getAddress())
    // 3. Use `hardhat_setCode` to set the bytecode at `SPOT_PX_PRECOMPILE_ADDRESS`
    await ethers.provider.send("hardhat_setCode", [ORACLE_PX_PRECOMPILE_ADDRESS, code]);
    const signers = await ethers.getSigners();
    const admin = signers[19]
    const MarketMakerAMM = await ethers.getContractFactory("MarketMakerAMM");
    const marketMakerAMM = await MarketMakerAMM.connect(admin).deploy([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], await admin.getAddress());
    return  { marketMakerAMM, admin };
  }

  // @ts-ignore
  function simulateSwapYesToNo(X, Y, dx) {
    // Sell dx YES into pool with reserves X (YES), Y (NO).
    // Returns dy NO out. Integer math with BigInt.
    const newY = (X * Y) / (X + dx);
    return Y - newY;
  }

  // @ts-ignore
  function simulateSwapNoToYes(X, Y, dy) {
    // Sell dy NO into pool with reserves Y (NO), X (YES).
    // Returns dx YES out. Integer math with BigInt.
    const newX = (X * Y) / (Y + dy);
    return X - newX;
  }

  // @ts-ignore
  function solveSwapToBalance(X, Y, tYes, tNo, maxIter = 100) {
    // Find how much to sell (YES or NO) to make balances equal (or closest).
    // Returns [direction, amountIn, amountOut, newYes, newNo]
    let best = ["NONE", 0n, 0n, tYes, tNo, (tYes > tNo ? tYes - tNo : tNo - tYes)];

    // --- Try selling YES ---
    let lo = 0n, hi = tYes;
    for (let i = 0; i < maxIter && lo <= hi; i++) {
      const mid = (lo + hi) / 2n;
      const dy = simulateSwapYesToNo(X, Y, mid);
      const newYes = tYes - mid;
      const newNo = tNo + dy;
      const diff = newYes > newNo ? newYes - newNo : newNo - newYes;

      if (diff < best[5]) {
        best = ["YES->NO", mid, dy, newYes, newNo, diff];
      }

      if (newYes > newNo) {
        lo = mid + 1n;
      } else {
        hi = mid - 1n;
      }
    }

    // --- Try selling NO ---
    lo = 0n; hi = tNo;
    for (let i = 0; i < maxIter && lo <= hi; i++) {
      const mid = (lo + hi) / 2n;
      const dx = simulateSwapNoToYes(X, Y, mid);
      const newYes = tYes + dx;
      const newNo = tNo - mid;
      const diff = newYes > newNo ? newYes - newNo : newNo - newYes;

      if (diff < best[5]) {
        best = ["NO->YES", mid, dx, newYes, newNo, diff];
      }

      if (newNo > newYes) {
        lo = mid + 1n;
      } else {
        hi = mid - 1n;
      }
    }

    // Return without diff
    return best.slice(0, 5);
  }

  describe("E2E Tests", function () {
      it("Should simulate trading with selling whole positions, market should stay solvent", async function () {
          const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
          const signers = await ethers.getSigners()
          await marketMakerAMM.connect(signers[0]).enterMarket(0n, 1, 1, 0, {value: ethers.parseEther('1')})
          const accounts = Array.from({length: 100}, (_, i) => ({
            signer: signers[i],
            timesSelected: 0,
            actions: [],
            yesBalance: 0n,
            noBalance: 0n,
            hypeBought: 0n,
            hypeSold: 0n,
            PnL: '',
            expectedPayout: ''
          }));

          function getRandomAmount(min = 5, max = 250) {
            return (Math.random() * (max - min + 1)) + min;
          }

          function getRandomAccount() {
            return Math.floor(Math.random() * accounts.length);
          }

          function getRandomAction() {
            const ran = Math.random()
            return ran < 0.8 ? "buy" : "sell";
          }

          const roundStart = Number(await marketMakerAMM.roundStart())

          while (await networkHelpers.time.latest() < roundStart + 299) {
            const index = getRandomAccount();
            const account = accounts[index]
            let action;
            if (account.timesSelected === 0) {
              action = "buy";
            } else {
              action = getRandomAction();
            }
            if (action === "buy") {
              const maxAmountInString = getRandomAmount().toFixed(2).toString();
              let maxAmountIn = ethers.parseEther(maxAmountInString)
              if (await ethers.provider.getBalance(await account.signer.getAddress()) < 101n * (10n ** 18n)) {
                action = "sell"
                const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
                const yesReserves = marketData.yesReserves
                const noReserves = marketData.noReserves
                const nativeBalanceBefore = await ethers.provider.getBalance(await account.signer.getAddress())
                const [, amountIn, , ,] = solveSwapToBalance(yesReserves, noReserves, account.yesBalance, account.noBalance);
                await marketMakerAMM.connect(account.signer).exitMarket(0, 1, 1, account.yesBalance, account.noBalance, amountIn)
                const nativeBalanceAfter = await ethers.provider.getBalance(await account.signer.getAddress())
                const userDataAfter = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await account.signer.getAddress(), 1)
                const userYesSharesAfter = userDataAfter.userYesReserves
                const userNoSharesAfter = userDataAfter.userNoReserves
                account.timesSelected += 1;
                account.yesBalance = userYesSharesAfter;
                account.noBalance = userNoSharesAfter;
                // @ts-ignore
                account.hypeSold += (nativeBalanceAfter - nativeBalanceBefore)
              } else {
                const side = index % 2 === 0 ? 0 : 1
                await marketMakerAMM.connect(account.signer).enterMarket(0, 1, 1, side, {value: maxAmountIn})
                const userDataAfter = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await account.signer.getAddress(), 1)
                const userYesSharesAfter = userDataAfter.userYesReserves
                const userNoSharesAfter = userDataAfter.userNoReserves
                account.timesSelected += 1;
                // @ts-ignore
                account.actions.push(action);
                account.yesBalance = userYesSharesAfter;
                account.noBalance = userNoSharesAfter;
                account.hypeBought += maxAmountIn
              }
            } else {
              const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
              const yesReserves = marketData.yesReserves
              const noReserves = marketData.noReserves
              const nativeBalanceBefore = await ethers.provider.getBalance(await account.signer.getAddress())
              const [, amountIn, , ,] = solveSwapToBalance(yesReserves, noReserves, account.yesBalance, account.noBalance);
              await marketMakerAMM.connect(account.signer).exitMarket(0, 1, 1, account.yesBalance, account.noBalance, amountIn)
              const nativeBalanceAfter = await ethers.provider.getBalance(await account.signer.getAddress())
              const userDataAfter = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await account.signer.getAddress(), 1)
              const userYesSharesAfter = userDataAfter.userYesReserves
              const userNoSharesAfter = userDataAfter.userNoReserves
              account.timesSelected += 1;
              // @ts-ignore
              account.actions.push(action);
              account.yesBalance = userYesSharesAfter;
              account.noBalance = userNoSharesAfter;
              // @ts-ignore
              account.hypeSold += (nativeBalanceAfter - nativeBalanceBefore)
            }
          }
          let totalVolume = 0n;
          await networkHelpers.time.increase(301)
          await marketMakerAMM.resolveMarkets()
          const marketData = await marketMakerAMM.inputSingleMarketRoundInfo(1, 1)
          const marketResolution = marketData.result
          const marketTreasury = marketData.marketTreasury
          const marketOutstandingYes = marketData.outYesReserves
          const marketOutstandingNo = marketData.outNoReserves
          const winners = []
          const losers = []

          let maxGas = 0n;
          let minGas = 2n *10n**6n;
          const allGas = []


          for (let i = 0; i < accounts.length; i++) {
            totalVolume += accounts[i].hypeBought + accounts[i].hypeSold
            accounts[i]['PnL'] = accounts[i].hypeBought > accounts[i].hypeSold ? "-" + (ethers.formatEther(accounts[i].hypeBought - accounts[i].hypeSold)).toString() : ethers.formatEther(accounts[i].hypeSold - accounts[i].hypeBought)
            accounts[i]["expectedPayout"] = marketResolution === 1n ? ethers.formatEther((accounts[i]['yesBalance'] * marketTreasury) / marketOutstandingYes) : ethers.formatEther((accounts[i]['noBalance'] * marketTreasury) / marketOutstandingNo)
            if (Number(accounts[i]["expectedPayout"]) + Number(accounts[i]['PnL']) > 1) {
              winners.push({'Rpnl': accounts[i]['PnL'], 'URpnl': accounts[i]["expectedPayout"]})
            } else {
              losers.push({'Rpnl': accounts[i]['PnL'], 'URpnl': accounts[i]["expectedPayout"]})
            }
            const preBalance = await ethers.provider.getBalance(await accounts[i].signer.getAddress())
            const pendingRoundsPre = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await accounts[i].signer.getAddress(), 1)
            const redeemTxn = await marketMakerAMM.connect(accounts[i].signer).redeemPendingRoundsPerMarketId(1)
            const receipt = await redeemTxn.wait()
            const gas = receipt?.gasUsed
            if (gas) {
                allGas.push(gas)
                if (gas >maxGas) {
                    maxGas = gas
                }
                if (gas < minGas) {
                    minGas = gas
                }
            }
            const pendingRoundsAfter = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await accounts[i].signer.getAddress(), 1)
            if (pendingRoundsPre.length > 0) {
                expect(pendingRoundsAfter.length).lt(pendingRoundsPre.length)
            }
            expect(pendingRoundsAfter.length).eq(0)
            const postBalance = await ethers.provider.getBalance(await accounts[i].signer.getAddress())
            if (Number(accounts[i]["expectedPayout"]) > 1) {
              expect(postBalance).gt(preBalance)
            }
          }
          console.log('Redeem Market Gas: ', {
              'Max Gas': maxGas,
              'Min Gas': minGas,
              'Avg Gas': allGas.reduce((a, b) => a + b, 0n) / BigInt(allGas.length)
          })
      }).timeout(1000000000000000);
      it("Should simulate trading with selling quarter positions, market should stay solvent", async function () {
          const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
          const signers = await ethers.getSigners()
          await marketMakerAMM.connect(signers[0]).enterMarket(0n, 1, 1, 0, {value: ethers.parseEther('1')})
          const accounts = Array.from({length: 100}, (_, i) => ({
            signer: signers[i],
            timesSelected: 0,
            actions: [],
            yesBalance: 0n,
            noBalance: 0n,
            hypeBought: 0n,
            hypeSold: 0n,
            PnL: '',
            expectedPayout: ''
          }));

          function getRandomAmount(min = 5, max = 250) {
            return (Math.random() * (max - min + 1)) + min;
          }

          function getRandomAccount() {
            return Math.floor(Math.random() * accounts.length);
          }

          function getRandomAction() {
            const ran = Math.random()
            return ran < 0.7 ? "buy" : "sell";
          }

          const roundStart = Number(await marketMakerAMM.roundStart())

          while (await networkHelpers.time.latest() < roundStart + 299) {
            const index = getRandomAccount();
            const account = accounts[index]
            let action;
            if (account.timesSelected === 0) {
              action = "buy";
            } else {
              action = getRandomAction();
            }
            if (action === "buy") {
              const maxAmountInString = getRandomAmount().toFixed(2).toString();
              let maxAmountIn = ethers.parseEther(maxAmountInString)
              if (await ethers.provider.getBalance(await account.signer.getAddress()) < 101n * (10n ** 18n)) {
                action = "sell"
                maxAmountIn = index % 2 === 0 ? account.yesBalance : account.noBalance
                const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
                const yesReserves = marketData.yesReserves
                const noReserves = marketData.noReserves
                const side = index % 2 === 0 ? 0 : 1
                const nativeBalanceBefore = await ethers.provider.getBalance(await account.signer.getAddress())
                const [, amountIn, , ,] = solveSwapToBalance(yesReserves, noReserves, side == 0 ? maxAmountIn : 0n, side == 1 ? 0n : maxAmountIn);
                await marketMakerAMM.connect(account.signer).exitMarket(0, 1, 1, side == 0 ? maxAmountIn : 0n, side == 0 ? 0n : maxAmountIn, amountIn)
                const nativeBalanceAfter = await ethers.provider.getBalance(await account.signer.getAddress())
                const userDataAfter = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await account.signer.getAddress(), 1)
                const userYesSharesAfter = userDataAfter.userYesReserves
                const userNoSharesAfter = userDataAfter.userNoReserves
                account.timesSelected += 1;
                // account.actions.push(action);
                account.yesBalance = userYesSharesAfter;
                account.noBalance = userNoSharesAfter;
                //@ts-ignore
                account.hypeSold += (nativeBalanceAfter - nativeBalanceBefore)
              } else {
                const side = index % 2 === 0 ? 0 : 1
                await marketMakerAMM.connect(account.signer).enterMarket(0, 1, 1, side, {value: maxAmountIn})
                const userDataAfter = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await account.signer.getAddress(), 1)
                const userYesSharesAfter = userDataAfter.userYesReserves
                const userNoSharesAfter = userDataAfter.userNoReserves
                account.timesSelected += 1;
                // account.actions.push(action);
                account.yesBalance = userYesSharesAfter;
                account.noBalance = userNoSharesAfter;
                account.hypeBought += maxAmountIn
              }
            } else {
              const maxAmountIn = index % 2 === 0 ? account.yesBalance : account.noBalance
              const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
              const yesReserves = marketData.yesReserves
              const noReserves = marketData.noReserves
              const side = index % 2 === 0 ? 0 : 1
              const nativeBalanceBefore = await ethers.provider.getBalance(await account.signer.getAddress())
              const [, amountIn, , ,] = solveSwapToBalance(yesReserves, noReserves, side == 0 ? maxAmountIn : 0n, side == 0 ? 0n : maxAmountIn);
              await marketMakerAMM.connect(account.signer).exitMarket(0, 1, 1, side == 0 ? maxAmountIn : 0n, side == 0 ? 0n : maxAmountIn, amountIn)
              const nativeBalanceAfter = await ethers.provider.getBalance(await account.signer.getAddress())
              const userDataAfter = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await account.signer.getAddress(), 1)
              const userYesSharesAfter = userDataAfter.userYesReserves
              const userNoSharesAfter = userDataAfter.userNoReserves
              account.timesSelected += 1;
              // account.actions.push(action);
              account.yesBalance = userYesSharesAfter;
              account.noBalance = userNoSharesAfter;
              //@ts-ignore
              account.hypeSold += (nativeBalanceAfter - nativeBalanceBefore)
            }
          }
          let totalVolume = 0n;
          await networkHelpers.time.increase(301)
          await marketMakerAMM.resolveMarkets()
          const marketData = await marketMakerAMM.inputSingleMarketRoundInfo(1, 1)
          const marketResolution = marketData.result
          const marketTreasury = marketData.marketTreasury
          const marketOutstandingYes = marketData.outYesReserves
          const marketOutstandingNo = marketData.outNoReserves
          const winners = []
          const losers = []

          for (let i = 0; i < accounts.length; i++) {
            totalVolume += accounts[i].hypeBought + accounts[i].hypeSold
            accounts[i]['PnL'] = accounts[i].hypeBought > accounts[i].hypeSold ? "-" + (ethers.formatEther(accounts[i].hypeBought - accounts[i].hypeSold)).toString() : ethers.formatEther(accounts[i].hypeSold - accounts[i].hypeBought)
            accounts[i]["expectedPayout"] = marketResolution === 1n ? ethers.formatEther((accounts[i]['yesBalance'] * marketTreasury) / marketOutstandingYes) : ethers.formatEther((accounts[i]['noBalance'] * marketTreasury) / marketOutstandingNo)
            if (Number(accounts[i]["expectedPayout"]) + Number(accounts[i]['PnL']) > 1) {
              winners.push({'Rpnl': accounts[i]['PnL'], 'URpnl': accounts[i]["expectedPayout"]})
            } else {
              losers.push({'Rpnl': accounts[i]['PnL'], 'URpnl': accounts[i]["expectedPayout"]})
            }
            const preBalance = await ethers.provider.getBalance(await accounts[i].signer.getAddress())
            await marketMakerAMM.connect(accounts[i].signer).redeemPendingRoundsPerMarketId(1)
            const postBalance = await ethers.provider.getBalance(await accounts[i].signer.getAddress())
            if (Number(accounts[i]["expectedPayout"]) > 1) {
              expect(postBalance).gt(preBalance)
            }
          }
      }).timeout(1000000000000000);
  });
  describe("Unit Tests", function () {
    describe("Register Market", function () {
        it("Admin should register new unique market id", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).registerMarket(11)
        }).timeout(1000000000000000);
        it("Should revert on register new unique market id if not admin", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await expect(marketMakerAMM.connect(signers[0]).registerMarket(11)).to.be.revertedWithCustomError(marketMakerAMM, "NotAuthorised()")
        }).timeout(1000000000000000);
        it("Should revert on register on duplicate market id", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await expect(marketMakerAMM.connect(admin).registerMarket(1)).to.be.revertedWithCustomError(marketMakerAMM, "InvalidInput()")
        }).timeout(1000000000000000);
        it("Should clear delistingRound if market reregisters", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).putMarketOnDelist(1)
            for(let i=0; i<5; i++) {
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(admin).delistMarket(1)
            await marketMakerAMM.connect(admin).registerMarket(1)
            expect(await marketMakerAMM.marketToDelistingRound(1)).eq(0n)
        }).timeout(1000000000000000);
        it("Should have valid initial state for the next round of listing round", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).registerMarket(15)
            const state_current = await marketMakerAMM.inputSingleMarketRoundInfo(15, 1)
            const state_next = await marketMakerAMM.inputSingleMarketRoundInfo(15, 2)
            expect(state_current.yesReserves).eq(0n)
            expect(state_current.noReserves).eq(0n)
            expect(state_next.yesReserves).eq(ethers.parseEther('425'))
            expect(state_next.noReserves).eq(ethers.parseEther('425'))
        }).timeout(1000000000000000);
    });
    describe("Delist Market", function () {
        it("Admin should add market on delist schedule", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).putMarketOnDelist(1)
        }).timeout(1000000000000000);
        it("Should revert on delist if not valid round", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await expect(marketMakerAMM.connect(admin).delistMarket(1)).to.be.revertedWithCustomError(marketMakerAMM, "InvalidInput()")
            await marketMakerAMM.connect(admin).putMarketOnDelist(1)
            await expect(marketMakerAMM.connect(admin).delistMarket(1)).to.be.revertedWithCustomError(marketMakerAMM, "InvalidInput()")
        }).timeout(1000000000000000);
        it("Should delist if valid round", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).putMarketOnDelist(1)
            for(let i=0; i<5; i++) {
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(admin).delistMarket(1)
        }).timeout(1000000000000000);
        it("Should delist if higher round", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).putMarketOnDelist(1)
            for(let i=0; i<10; i++) {
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(admin).delistMarket(1)
        }).timeout(1000000000000000);
    });
    describe("Enter Market", function () {
        it("Should revert if market is fresh and betting on active round", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).registerMarket(11)
            const signers = await ethers.getSigners()
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 11, 1, 1, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidRound()")
        }).timeout(1000000000000000);
        it("Should enter successfully if market is fresh and betting on future round", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).registerMarket(11)
            const signers = await ethers.getSigners()
            await networkHelpers.time.increase(310)
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 11, 1, 1, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidRound()")
        }).timeout(1000000000000000);
        it("Should revert if invalid side input", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 2, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidInput()")
        }).timeout(1000000000000000);
        it("Should revert if round input is invalid", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 0, 1, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidRound()")
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 3, 1, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidRound()")
        }).timeout(1000000000000000);
        it("Should revert if current round is on resolution phase", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await networkHelpers.time.increase(301)
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "RoundExpired()")
        }).timeout(1000000000000000);
        it("Should revert if next round is not yet initialised", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "RoundNotYetInitialised()")
        }).timeout(1000000000000000);
        it("Should enterMarket successfully if current round is on betting phase", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
        }).timeout(1000000000000000);
        it("Should enterMarket on future round successfully if current round is on resolution phase", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await networkHelpers.time.increase(301)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther('1')})
        }).timeout(1000000000000000);
        it("Should enterMarket on future round successfully even if market is fresh", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).registerMarket(11)
            const signers = await ethers.getSigners()
            await networkHelpers.time.increase(301)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 11, 2, 1, {value: ethers.parseEther('1')})
        }).timeout(1000000000000000);
        it("Should register user on first enter market on new round id", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const [, roundsPre] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            const [_, roundsPost] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(roundsPost.length).gt(roundsPre.length)
            expect(roundsPost[0]).eq(1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            const [, roundsTest] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(roundsTest.length).eq(roundsPost.length)
            expect(roundsTest[0]).eq(1n)
            await networkHelpers.time.increase(301)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther('1')})
            const [, roundsTest2] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(roundsTest2.length).gt(roundsPost.length)
            expect(roundsTest2[0]).eq(1n)
            expect(roundsTest2[1]).eq(2n)
        }).timeout(1000000000000000);
        it("Should update market state on user enter", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.inputSingleMarketRoundInfo(1, 1)
            const resolution = marketData.result
            const treasury = marketData.marketTreasury
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves

            expect(yesReserves).lt(425n*10n**18n)
            expect(noReserves).gt(425n*10n**18n)
            expect(treasury).eq(((10n**18n) * 997n) / 1000n)
            expect(resolution).eq(0n)
        }).timeout(1000000000000000);
        it("Should have same value of calculatedAmountOut with actual amountOut", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const amountOut = await marketMakerAMM.getAmountOut(ethers.parseEther('50'), 1, 1, 0)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('50')})
            const userDataAfter = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userYesSharesAfter = userDataAfter.userYesReserves
            expect(userYesSharesAfter).eq(amountOut)
        }).timeout(1000000000000000);
        it("Should revert if below expected amountOut in buy yes", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const amountOut = await marketMakerAMM.getAmountOut(ethers.parseEther('2'), 1, 1, 0)
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(amountOut, 1, 1, 0, {value: ethers.parseEther('1')})).revertedWithCustomError(marketMakerAMM, 'SlippageReached()')
        }).timeout(1000000000000000);
        it("Should revert if below expected amountOut in buy no", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const amountOut = await marketMakerAMM.getAmountOut(ethers.parseEther('2'), 1, 1, 1)
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(amountOut, 1, 1, 1, {value: ethers.parseEther('1')})).revertedWithCustomError(marketMakerAMM, 'SlippageReached()')
        }).timeout(1000000000000000);
        it("Should emit correct event on successful enterMarket", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const amountOut = await marketMakerAMM.getAmountOut(ethers.parseEther('1'), 1, 1, 0)
            let txn = await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            await expect(txn).emit(marketMakerAMM, "MarketEnter").withArgs(1, 1, await signers[0].getAddress(), ethers.parseEther('1'), 0, amountOut)
            await networkHelpers.time.increase(300n)
            txn = await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther('1')})
            await expect(txn).emit(marketMakerAMM, "MarketEnter").withArgs(1, 2, await signers[0].getAddress(), ethers.parseEther('1'), 0, amountOut)
        }).timeout(1000000000000000);
        it("Should revert if market is on delist on active round or future round ", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(admin).putMarketOnDelist(1)
            for(let i=0; i<4; i++) {
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 5, 0, {value: ethers.parseEther('1')})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 5n)
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 6, 0, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidInput()")
            await marketMakerAMM.resolveMarkets()
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 6, 0, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidInput()")
            await networkHelpers.time.increase(secondsLeft + 5n)
            await expect(marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 7, 0, {value: ethers.parseEther('1')})).to.be.revertedWithCustomError(marketMakerAMM, "InvalidInput()")
        }).timeout(1000000000000000);
    });
    describe("Exit Market", function () {
        it("Should revert if below expected amountOut in sell yes", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userYesReserves = userData.userYesReserves
            const [, amountIn, amountOut, ,] = solveSwapToBalance(yesReserves, noReserves, userYesReserves, 0n);
            await expect(marketMakerAMM.connect(signers[0]).exitMarket(amountOut * 997n/1000n, 1, 1, userYesReserves, 0 , amountIn)).revertedWithCustomError(marketMakerAMM, 'SlippageReached()')
        }).timeout(1000000000000000);
        it("Should revert if below expected amountOut in sell no", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userNoReserves = userData.userNoReserves
            const [, amountIn, amountOut, ,] = solveSwapToBalance(yesReserves, noReserves, 0n, userNoReserves);
            await expect(marketMakerAMM.connect(signers[0]).exitMarket(amountOut * 997n/1000n, 1, 1, 0, userNoReserves, amountIn)).revertedWithCustomError(marketMakerAMM, 'SlippageReached()')
        }).timeout(1000000000000000);
        it("Should revert if market is in resolution mode", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userNoReserves = userData.userNoReserves
            const [, amountIn, amountOut, ,] = solveSwapToBalance(yesReserves, noReserves, 0n, userNoReserves);
            await networkHelpers.time.increase(302)
            await expect(marketMakerAMM.connect(signers[0]).exitMarket(amountOut * 997n/1000n, 1, 1, 0, userNoReserves, amountIn)).revertedWithCustomError(marketMakerAMM, 'RoundExpired()')
        }).timeout(1000000000000000);
        it("Should exit next round if current round is in resolution mode", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userNoReserves = userData.userNoReserves
            const [, amountIn, amountOut, ,] = solveSwapToBalance(yesReserves, noReserves, 0n, userNoReserves);
            await networkHelpers.time.increase(302)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 1, {value: ethers.parseEther('1')})
            await marketMakerAMM.connect(signers[0]).exitMarket((amountOut * 997n/1000n) - 2n, 1, 2, 0, userNoReserves, amountIn)
        }).timeout(1000000000000000);
        it("Should revert if user not having enough shares to sell yes->no", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userYesReserves = userData.userYesReserves
            const [, amountIn, amountOut, ,] = solveSwapToBalance(yesReserves, noReserves, userYesReserves, 0n);
            await expect(marketMakerAMM.connect(signers[1]).exitMarket(0, 1, 1, userYesReserves, 0 , amountIn)).revertedWithCustomError(marketMakerAMM, 'InvalidReserves()')
        }).timeout(1000000000000000);
        it("Should revert if user not having enough shares to sell no->yes", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userNoReserves = userData.userNoReserves
            const [, amountIn, amountOut, ,] = solveSwapToBalance(yesReserves, noReserves, 0n, userNoReserves);
            await expect(marketMakerAMM.connect(signers[1]).exitMarket(0, 1, 1, 0, userNoReserves , amountIn)).revertedWithCustomError(marketMakerAMM, 'InvalidReserves()')
        }).timeout(1000000000000000);
        it("Should revert if user not having enough shares to sell no change", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther('1')})
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userNoReserves = userData.userNoReserves
            const userYesReserves = userData.userYesReserves
            await expect(marketMakerAMM.connect(signers[1]).exitMarket(0, 1, 1, userYesReserves, userNoReserves , 0)).revertedWithCustomError(marketMakerAMM, 'InvalidReserves()')
        }).timeout(1000000000000000);
        it("Should revert if user not having enough shares to sell no change no bets", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const userNoReserves = 1000n
            const userYesReserves = 1000n
            await expect(marketMakerAMM.connect(signers[1]).exitMarket(0, 1, 1, userYesReserves, userNoReserves , 0)).revertedWithCustomError(marketMakerAMM, 'InvalidReserves()')
        }).timeout(1000000000000000);
        it("Should not alter state if user not having enough shares to sell one side no change", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther('1')})
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userYesReserves = userData.userYesReserves
            const marketDataPre = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            await marketMakerAMM.connect(signers[1]).exitMarket(0, 1, 1, userYesReserves, 0 , 0)
            const marketDataPost = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            expect(marketDataPre.yesReserves).eq(marketDataPost.yesReserves)
            expect(marketDataPre.noReserves).eq(marketDataPost.noReserves)
            expect(marketDataPre.marketTreasury).eq(marketDataPost.marketTreasury)
            expect(marketDataPre.outYesReserves).eq(marketDataPost.outYesReserves)
            expect(marketDataPre.outNoReserves).eq(marketDataPost.outNoReserves)
        }).timeout(1000000000000000);
        it("Should emit correct event on successful exit market", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther('1')})
            const marketData = await marketMakerAMM.currentSingleMarketRoundInfo(1)
            const yesReserves = marketData.yesReserves
            const noReserves = marketData.noReserves
            const userData = await marketMakerAMM.userDataPerMarketAndCurrentRoundId(await signers[0].getAddress(), 1)
            const userNoReserves = userData.userNoReserves
            const [, amountIn, amountOut, ,] = solveSwapToBalance(yesReserves, noReserves, 0n, userNoReserves);
            let txn = await marketMakerAMM.connect(signers[0]).exitMarket((amountOut * 997n/1000n) - 2n, 1, 1, 0, userNoReserves, amountIn)
            await expect(txn).emit(marketMakerAMM, "MarketExit").withArgs(1, 1, await signers[0].getAddress(), amountOut-1n, userNoReserves - amountIn, (amountOut-1n)*997n/1000n)
            await networkHelpers.time.increase(302)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 1, {value: ethers.parseEther('1')})
            txn = await marketMakerAMM.connect(signers[0]).exitMarket((amountOut * 997n/1000n) - 2n, 1, 2, 0, userNoReserves, amountIn)
            await expect(txn).emit(marketMakerAMM, "MarketExit").withArgs(1, 2, await signers[0].getAddress(), amountOut-1n, userNoReserves - amountIn, (amountOut-1n)*997n/1000n)
        }).timeout(1000000000000000);
    });
    describe('Redeem Market', function () {
        it("Should add treasury to fees if no winners", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther("100")})
            const [, secondsLeft, currentRoundFees] = await marketMakerAMM.checkResolutionStatus()
            const feesPre = await marketMakerAMM.fees()
            const expectedTotalFees = 100n*10n**18n - ((100n*10n**18n) * 997n)/ 1000n
            expect(currentRoundFees + feesPre).eq(expectedTotalFees)
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            const feesPost = await marketMakerAMM.fees()
            expect(currentRoundFees).gt(0)
            expect(currentRoundFees).eq(expectedTotalFees - (expectedTotalFees * 600n / 1000n))
            expect(feesPost).gt(feesPre)
            expect(feesPost).eq(feesPre + ((100n*10n**18n) * 997n)/ 1000n)
            expect(await ethers.provider.getBalance(await signers[1].getAddress())).gt(ethers.parseEther("10000"))
        }).timeout(1000000000000000)
        it("Should add treasury to fees if no winners multiple markets", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i=0; i<10; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, i+1, 1, 0, {value: ethers.parseEther("100")})
            }
            const [, secondsLeft, currentRoundFees] = await marketMakerAMM.checkResolutionStatus()
            const feesPre = await marketMakerAMM.fees()
            const expectedTotalFees = 10n*100n*10n**18n - 10n*(((100n*10n**18n) * 997n)/ 1000n)
            expect(currentRoundFees + feesPre).eq(expectedTotalFees)
            await networkHelpers.time.increase(secondsLeft + 1n)
            const resolve = await marketMakerAMM.connect(signers[1]).resolveMarkets()
            const receipt = await resolve.wait()
            console.log("Resolve Market Gas: ", receipt?.gasUsed)
            const feesPost = await marketMakerAMM.fees()
            expect(currentRoundFees).gt(0)
            expect(currentRoundFees).eq(expectedTotalFees - (expectedTotalFees * 600n / 1000n))
            expect(feesPost).gt(feesPre)
            expect(feesPost).eq(feesPre + 10n*(((100n*10n**18n) * 997n)/ 1000n))
            expect(await ethers.provider.getBalance(await signers[1].getAddress())).gt(ethers.parseEther("10000"))
        }).timeout(1000000000000000)
        it("Should remove roundId from user's active rounds", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther("100")})
            const [isResolvable, secondsLeft, currentRoundFees] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            await marketMakerAMM.connect(signers[0]).redeemPendingRoundsPerMarketId(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(0n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(0n)
            expect(total).eq(0n)
        }).timeout(1000000000000000)
        it("Should remove roundId from user's active rounds with capped redeem and markets less than page", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther("100")})
            const [isResolvable, secondsLeft, currentRoundFees] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(0n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(0n)
            expect(total).eq(0n)
        }).timeout(1000000000000000)
        it("Should remove correct roundId from user's active rounds with capped redeem and markets more than page and less than 2*page", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i = 0; i<27; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 1, {value: ethers.parseEther("10")})
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.connect(signers[1]).resolveMarkets()
            }
            const [totalPre, activeRoundsPre] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPre).eq(27n)
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const [totalPost, activeRoundsPost] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost).eq(2n)
            expect(activeRoundsPost[0]).eq(27n)
            expect(activeRoundsPost[1]).eq(26n)
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const [totalPost2, activeRoundsPost2] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost2).eq(0n)
            expect(activeRoundsPost2.length).eq(0n)
        }).timeout(1000000000000000)
        it("Should remove correct roundId from user's active rounds with capped redeem and markets more than page and eq 2*page", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i = 0; i<50; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 1, {value: ethers.parseEther("10")})
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.connect(signers[1]).resolveMarkets()
            }
            const [totalPre, activeRoundsPre] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPre).eq(50n)
            let redeem = await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            let receipt = await redeem.wait()
            const maxGas = receipt?.gasUsed
            const minGas = receipt?.gasUsed
            const [totalPost, activeRoundsPost] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost).eq(25n)
            for (let i=0; i <25; i++) {
                expect(activeRoundsPost[i]).eq(50n-BigInt(i))
            }
            redeem = await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            receipt = await redeem.wait()
            console.log("Redeem Market Gas: ", {'Max Gas': maxGas && receipt?.gasUsed && maxGas > receipt.gasUsed ? maxGas : receipt?.gasUsed, 'Min Gas': minGas && receipt?.gasUsed && minGas < receipt.gasUsed ? minGas : receipt?.gasUsed})
            const [totalPost2, activeRoundsPost2] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost2).eq(0n)
            expect(activeRoundsPost2.length).eq(0n)
        }).timeout(1000000000000000)
        it("Should remove correct roundId from user's active rounds with capped redeem and markets more than page and more than 2*page", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i=0; i<55; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 1, {value: ethers.parseEther("10")})
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.connect(signers[1]).resolveMarkets()
            }
            const [totalPre, ] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPre).eq(55n)
            let redeem = await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            let receipt = await redeem.wait()
            const maxGas = receipt?.gasUsed
            const minGas = receipt?.gasUsed
            const [totalPost, activeRoundsPost] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost).eq(30n)
            for (let i=0; i <25n; i++) {
                expect(activeRoundsPost[i]).eq(55n-BigInt(i))
            }
            redeem = await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            receipt = await redeem.wait()
            console.log("Redeem Market Gas: ", {'Max Gas': maxGas && receipt?.gasUsed && maxGas > receipt.gasUsed ? maxGas : receipt?.gasUsed, 'Min Gas': minGas && receipt?.gasUsed && minGas < receipt.gasUsed ? minGas : receipt?.gasUsed})
            const [totalPost2, activeRoundsPost2] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost2).eq(5n)
            for(let i=0; i<5; i++) {
                expect(activeRoundsPost2[i]).eq(30n-BigInt(i))
            }
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const [totalPost3, ] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost3).eq(0n)
        }).timeout(1000000000000000)
        it("Should be able to process a full page of winning redeem markets", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i = 0; i<50; i++) {
                await marketMakerAMM.connect(signers[3]).enterMarket(0, 1, i+1, 1, {value: ethers.parseEther("10")})
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.connect(signers[1]).resolveMarkets()
            }
            const [totalPre, activeRoundsPre] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[3].getAddress(), 1, 0)
            expect(totalPre).eq(50n)
            let redeem = await marketMakerAMM.connect(signers[3]).redeemRoundsPerMarketIdCapped(1)
            let receipt = await redeem.wait()
            const maxGas = receipt?.gasUsed
            const minGas = receipt?.gasUsed
            const [totalPost, activeRoundsPost] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[3].getAddress(), 1, 0)
            expect(totalPost).eq(25n)
            for (let i=0; i <25; i++) {
                expect(activeRoundsPost[i]).eq(50n-BigInt(i))
            }
            redeem = await marketMakerAMM.connect(signers[3]).redeemRoundsPerMarketIdCapped(1)
            receipt = await redeem.wait()
            console.log("Redeem Market Gas: ", {'Max Gas': maxGas && receipt?.gasUsed && maxGas > receipt.gasUsed ? maxGas : receipt?.gasUsed, 'Min Gas': minGas && receipt?.gasUsed && minGas < receipt.gasUsed ? minGas : receipt?.gasUsed})
            const [totalPost2, activeRoundsPost2] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(totalPost2).eq(0n)
            expect(activeRoundsPost2.length).eq(0n)
            expect(maxGas).lt(2n*10n**6n)

        }).timeout(1000000000000000)
        it("Should keep unresolved roundIds on users active rounds on less than page in claim page", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther("100")})
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(2n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(2n)
            expect(total).eq(2n)
            expect(acRounds[0]).eq(1n)
            expect(acRounds[1]).eq(2n)
        }).timeout(1000000000000000)
        it("Should keep unresolved roundIds on users active rounds without pagination", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 0, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther("100")})
            await marketMakerAMM.connect(signers[0]).redeemPendingRoundsPerMarketId(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(2n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(2n)
            expect(total).eq(2n)
            expect(acRounds[0]).eq(1n)
            expect(acRounds[1]).eq(2n)
        }).timeout(1000000000000000)
        it("Should keep unresolved roundIds on users active rounds without pagination if unresolved rounds are in the first 2 postions on the stack", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i=0; i<30; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 0, {value: ethers.parseEther("1")})
                const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 31, 0, {value: ethers.parseEther("1")})
            const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 32, 0, {value: ethers.parseEther("100")})
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            await marketMakerAMM.connect(signers[0]).redeemPendingRoundsPerMarketId(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(2n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(2n)
            expect(total).eq(2n)
            expect(acRounds[0]).eq(32n)
            expect(acRounds[1]).eq(31n)
        }).timeout(1000000000000000)
        it("Should keep unresolved roundIds on users active rounds on eq the page in claim page", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i=0; i<24; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 0, {value: ethers.parseEther("1")})
                const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 25, 0, {value: ethers.parseEther("100")})
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(1n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(1n)
            expect(total).eq(1n)
            expect(acRounds[0]).eq(25n)
        }).timeout(1000000000000000)
        it("Should keep unresolved roundIds on users active rounds on eq the page in claim page with 2 unresolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i=0; i<23; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 0, {value: ethers.parseEther("1")})
                const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 24, 0, {value: ethers.parseEther("1")})
            const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 25, 0, {value: ethers.parseEther("100")})
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(2n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(2n)
            expect(total).eq(2n)
            expect(acRounds[0]).eq(24n)
            expect(acRounds[1]).eq(25n)
        }).timeout(1000000000000000)
        it("Should keep unresolved roundIds on users active rounds on more than 2*page in claim page with 2 unresolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i=0; i<55; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 0, {value: ethers.parseEther("1")})
                const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 56, 0, {value: ethers.parseEther("1")})
            const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 57, 0, {value: ethers.parseEther("100")})
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(9n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(9n)
            expect(total).eq(9n)
            expect(acRounds[7]).eq(57n)
            expect(acRounds[8]).eq(56n)
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.resolveMarkets()
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const [totalLast, acRoundsLast] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRoundsLast.length).eq(1n)
            expect(totalLast).eq(1n)
            expect(acRoundsLast[0]).eq(57n)
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.resolveMarkets()
            await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const [t, ac] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(ac.length).eq(0n)
            expect(t).eq(0n)
        }).timeout(1000000000000000)
        it("Should keep unresolved roundIds on users active rounds without pagination multi rounds", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            for (let i=0; i<55; i++) {
                await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, i+1, 0, {value: ethers.parseEther("1")})
                const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 56, 0, {value: ethers.parseEther("1")})
            const [, secondsLeft,] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 57, 0, {value: ethers.parseEther("100")})
            await marketMakerAMM.connect(signers[0]).redeemPendingRoundsPerMarketId(1)
            const activeRounds = await marketMakerAMM.userUnclaimedRoundsPerMarketId(await signers[0].getAddress(), 1)
            expect(activeRounds.length).eq(2n)
            const [total, acRounds] = await marketMakerAMM.userUnclaimedRoundsPerMarketIdWithPage(await signers[0].getAddress(), 1, 0)
            expect(acRounds.length).eq(2n)
            expect(total).eq(2n)
            expect(acRounds[0]).eq(57n)
            expect(acRounds[1]).eq(56n)
        }).timeout(1000000000000000)
        it("Should emit correct event on redeem capped all resolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther("100")})
            await networkHelpers.time.increase(secondsLeft + 10n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            const txn = await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            await expect(txn).emit(marketMakerAMM, "MarketRedeem").withArgs(1n, 1n, await signers[0].getAddress(), 2n, (100n*10n**18n * 997n)/1000n)
            await expect(txn).emit(marketMakerAMM, "MarketRedeem").withArgs(1n, 2n, await signers[0].getAddress(), 2n, 0n)
        }).timeout(1000000000000000)
        it("Should not emit event on redeem capped none resolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 1, {value: ethers.parseEther("100")})
            const txn = await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            await expect(txn).to.not.emit(marketMakerAMM, "MarketRedeem")
        }).timeout(1000000000000000)
        it("Should emit correct event on redeem capped one resolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 1, {value: ethers.parseEther("100")})
            await networkHelpers.time.increase(secondsLeft + 10n)
            const txn = await marketMakerAMM.connect(signers[0]).redeemRoundsPerMarketIdCapped(1)
            const rsp = await txn.wait()
            expect(rsp?.logs.length).eq(1)
            await expect(txn).emit(marketMakerAMM, "MarketRedeem").withArgs(1n, 1n, await signers[0].getAddress(), 2n, (100n*10n**18n * 997n)/1000n)
        }).timeout(1000000000000000)
        it("Should emit correct event on redeem without cap all resolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 0, {value: ethers.parseEther("100")})
            await networkHelpers.time.increase(secondsLeft + 10n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            const txn = await marketMakerAMM.connect(signers[0]).redeemPendingRoundsPerMarketId(1)
            await expect(txn).emit(marketMakerAMM, "MarketRedeem").withArgs(1n, 1n, await signers[0].getAddress(), 2n, (100n*10n**18n * 997n)/1000n)
            await expect(txn).emit(marketMakerAMM, "MarketRedeem").withArgs(1n, 2n, await signers[0].getAddress(), 2n, 0n)
        }).timeout(1000000000000000)
        it("Should not emit event on redeem without cap none resolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 1, {value: ethers.parseEther("100")})
            const txn = await marketMakerAMM.connect(signers[0]).redeemPendingRoundsPerMarketId(1)
            await expect(txn).to.not.emit(marketMakerAMM, "MarketRedeem")
        }).timeout(1000000000000000)
        it("Should emit correct event on redeem without cap one resolved", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployStaticPrecompileAndAMM);
            const signers = await ethers.getSigners()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 1, 1, {value: ethers.parseEther("100")})
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            await marketMakerAMM.connect(signers[0]).enterMarket(0, 1, 2, 1, {value: ethers.parseEther("100")})
            await networkHelpers.time.increase(secondsLeft + 10n)
            const txn = await marketMakerAMM.connect(signers[0]).redeemPendingRoundsPerMarketId(1)
            const rsp = await txn.wait()
            expect(rsp?.logs.length).eq(1)
            await expect(txn).emit(marketMakerAMM, "MarketRedeem").withArgs(1n, 1n, await signers[0].getAddress(), 2n, (100n*10n**18n * 997n)/1000n)
        }).timeout(1000000000000000)
    })
    describe('Resolve Market', function () {
        it("Should revert if not valid timestamp", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const [isResolvable, secondsLeft, currentRoundFees] = await marketMakerAMM.checkResolutionStatus()
            expect(isResolvable).eq(false)
            await expect(marketMakerAMM.connect(signers[1]).resolveMarkets()).to.be.revertedWithCustomError(marketMakerAMM, "InvalidTimestamp")
            await networkHelpers.time.increase(secondsLeft + 1n)
            const [isResolvable2, , ] = await marketMakerAMM.checkResolutionStatus()
            expect(isResolvable2).eq(true)
        }).timeout(1000000000000000)
    })
    describe('View Functions', function () {
        xit("Should ", async function() {
            const {marketMakerAMM} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            const signers = await ethers.getSigners()
            const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
            await networkHelpers.time.increase(secondsLeft + 1n)
            await marketMakerAMM.connect(signers[1]).resolveMarkets()
            console.log(await marketMakerAMM.inputSingleMarketRoundInfo(1, 2))
            const rsp = await marketMakerAMM.currentAndFutureRoundInfo()
            console.log(rsp[1][0])
            console.log(rsp[2][0])
        }).timeout(1000000000000000)
        xit("Should return both lists of markets", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            await marketMakerAMM.connect(admin).putMarketOnDelist(1)
            for(let i=0; i<10; i++) {
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.connect(admin).delistMarket(1)
            console.log(await marketMakerAMM.getBothMarkets())
            await marketMakerAMM.connect(admin).registerMarket(1)
            console.log(await marketMakerAMM.getBothMarkets())
        }).timeout(1000000000000000)
        it("Should return hist", async function() {
            const {marketMakerAMM, admin} = await networkHelpers.loadFixture(deployPrecompileAndAMM);
            for(let i=0; i<50; i++) {
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await marketMakerAMM.connect(admin).enterMarket(0, 1, i+1, 0, {value: ethers.parseEther("0.1")})
                await marketMakerAMM.connect(admin).enterMarket(0, 1, i+1, 1, {value: ethers.parseEther("0.1")})
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.inputMarketRoundHistory(1n)
             for(let i=0; i<150; i++) {
                const [, secondsLeft, ] = await marketMakerAMM.checkResolutionStatus()
                await marketMakerAMM.connect(admin).enterMarket(0, 1, i+51, 0, {value: ethers.parseEther("0.1")})
                await marketMakerAMM.connect(admin).enterMarket(0, 1, i+51, 1, {value: ethers.parseEther("0.1")})
                await networkHelpers.time.increase(secondsLeft + 1n)
                await marketMakerAMM.resolveMarkets()
            }
            await marketMakerAMM.inputMarketRoundHistory(1n)
        }).timeout(1000000000000000)

    })
  })
});
