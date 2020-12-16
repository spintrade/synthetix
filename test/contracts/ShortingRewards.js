const { artifacts, contract } = require('@nomiclabs/buidler');
const { toBN } = require('web3-utils');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { mockToken, setupAllContracts, setupContract } = require('./setup');
const { currentTime, toUnit, fastForward } = require('../utils')();

const CollateralManager = artifacts.require(`CollateralManager`);
const CollateralState = artifacts.require(`CollateralState`);
const CollateralManagerState = artifacts.require('CollateralManagerState');

contract('ShortingRewards', accounts => {
	const [
		deployerAccount,
		owner,
		oracle,
		authority,
		rewardEscrowAddress,
		account1,
		mockRewardsDistributionAddress,
	] = accounts;

	const sUSD = toBytes32('sUSD');
	const sETH = toBytes32('sETH');
	const sBTC = toBytes32('sBTC');

	// Synthetix is the rewardsToken
	let rewardsToken,
		externalRewardsToken,
		exchangeRates,
		shortingRewards,
		rewardsDistribution,
		systemSettings,
		feePool,
		synths,
		short,
		state,
		sUSDSynth,
		sBTCSynth,
		sETHSynth,
		issuer,
		debtCache,
		managerState,
		manager,
		addressResolver,
		tx,
		id;

	const DAY = 86400;
	const ZERO_BN = toBN(0);

	const getid = async tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const updateRatesWithDefaults = async () => {
		const timestamp = await currentTime();

		await exchangeRates.updateRates([sETH], ['100'].map(toUnit), timestamp, {
			from: oracle,
		});

		const sBTC = toBytes32('sBTC');

		await exchangeRates.updateRates([sBTC], ['10000'].map(toUnit), timestamp, {
			from: oracle,
		});
	};

	const setRewardsTokenExchangeRate = async ({ rateStaleDays } = { rateStaleDays: 7 }) => {
		const rewardsTokenIdentifier = await rewardsToken.symbol();

		await systemSettings.setRateStalePeriod(DAY * rateStaleDays, { from: owner });
		const updatedTime = await currentTime();
		await exchangeRates.updateRates(
			[toBytes32(rewardsTokenIdentifier)],
			[toUnit('2')],
			updatedTime,
			{
				from: oracle,
			}
		);
		assert.equal(await exchangeRates.rateIsStale(toBytes32(rewardsTokenIdentifier)), false);
	};

	const issuesUSDToAccount = async (issueAmount, receiver) => {
		// Set up the depositor with an amount of synths to deposit.
		await sUSDSynth.issue(receiver, issueAmount, {
			from: owner,
		});
	};

	const issuesBTCtoAccount = async (issueAmount, receiver) => {
		await sBTCSynth.issue(receiver, issueAmount, { from: owner });
	};

	const issuesETHToAccount = async (issueAmount, receiver) => {
		await sETHSynth.issue(receiver, issueAmount, { from: owner });
	};

	const deployShort = async ({
		state,
		owner,
		manager,
		resolver,
		collatKey,
		synths,
		minColat,
		minSize,
		underCon,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralShort',
			args: [state, owner, manager, resolver, collatKey, synths, minColat, minSize, underCon],
		});
	};

	addSnapshotBeforeRestoreAfterEach();

	before(async () => {
		synths = ['sUSD', 'sBTC', 'sETH'];
		({
			ExchangeRates: exchangeRates,
			SynthsUSD: sUSDSynth,
			SynthsBTC: sBTCSynth,
			SynthsETH: sETHSynth,
			FeePool: feePool,
			AddressResolver: addressResolver,
			Issuer: issuer,
			DebtCache: debtCache,
			RewardsDistribution: rewardsDistribution,
			Synthetix: rewardsToken,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'Synthetix',
				'FeePool',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'Issuer',
				'DebtCache',
				'RewardsDistribution',
				'Synthetix',
				'SystemSettings',
			],
		}));

		managerState = await CollateralManagerState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		const maxDebt = toUnit(10000000);

		manager = await CollateralManager.new(
			managerState.address,
			owner,
			addressResolver.address,
			maxDebt,
			// 5% / 31536000 (seconds in common year)
			1585489599,
			0,
			{
				from: deployerAccount,
			}
		);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		state = await CollateralState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		short = await deployShort({
			state: state.address,
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: sUSD,
			synths: [toBytes32('SynthsBTC'), toBytes32('SynthsETH')],
			minColat: toUnit(1.5),
			minSize: toUnit(0.1),
			underCon: sUSDSynth.address,
		});

		await addressResolver.importAddresses(
			[toBytes32('CollateralShort'), toBytes32('CollateralManager')],
			[short.address, manager.address],
			{
				from: owner,
			}
		);

		await short.rebuildCache();
		await short.setCurrencies();

		await state.setAssociatedContract(short.address, { from: owner });

		await feePool.rebuildCache();
		await manager.rebuildCache();
		await issuer.rebuildCache();
		await debtCache.rebuildCache();

		await sUSDSynth.approve(short.address, toUnit(100000), { from: account1 });

		await manager.addCollateral(short.address, { from: owner });
		await manager.addShortableSynth(sBTCSynth.address, { from: owner });
		await manager.addShortableSynth(sETHSynth.address, { from: owner });

		({ token: externalRewardsToken } = await mockToken({
			accounts,
			name: 'External Rewards Token',
			symbol: 'MOAR',
		}));

		shortingRewards = await setupContract({
			accounts,
			contract: 'ShortingRewards',
			args: [
				owner,
				addressResolver.address,
				rewardsDistribution.address,
				rewardsToken.address,
				short.address,
				toBytes32('SynthsBTC'),
			],
		});

		await shortingRewards.rebuildCache();

		await rewardsDistribution.setAuthority(authority, { from: owner });
		await rewardsDistribution.setRewardEscrow(rewardEscrowAddress, { from: owner });
		await rewardsDistribution.setSynthetixProxy(rewardsToken.address, { from: owner });
		await rewardsDistribution.setFeePoolProxy(feePool.address, { from: owner });

		await shortingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
			from: owner,
		});

		await short.addRewardsContracts(shortingRewards.address, sBTC, { from: owner });

		await setRewardsTokenExchangeRate();
	});

	beforeEach(async () => {
		await updateRatesWithDefaults();

		await issuesUSDToAccount(toUnit(100000), owner);
		await issuesBTCtoAccount(toUnit(10), owner);
		await issuesETHToAccount(toUnit(100), owner);

		await issuesUSDToAccount(toUnit(20000), account1);
		await issuesBTCtoAccount(toUnit(2), account1);
		await issuesETHToAccount(toUnit(10), account1);

		await debtCache.takeDebtSnapshot();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: shortingRewards.abi,
			ignoreParents: ['ReentrancyGuard', 'Owned', 'MixinResolver'],
			expected: [
				'enrol',
				'withdraw',
				'exit',
				'getReward',
				'notifyRewardAmount',
				'setPaused',
				'setRewardsDistribution',
				'setRewardsDuration',
			],
		});
	});

	describe('Constructor & Settings', () => {
		it('should set rewards token on constructor', async () => {
			assert.equal(await shortingRewards.rewardsToken(), rewardsToken.address);
		});

		it('should staking token on constructor', async () => {
			assert.equal(await shortingRewards.synth(), toBytes32('SynthsBTC'));
		});

		it('should set owner on constructor', async () => {
			const ownerAddress = await shortingRewards.owner();
			assert.equal(ownerAddress, owner);
		});
	});

	describe('Function permissions', () => {
		const rewardValue = toUnit(1.0);

		before(async () => {
			await rewardsToken.transfer(shortingRewards.address, rewardValue, { from: owner });
		});

		it('only owner can call notifyRewardAmount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: shortingRewards.notifyRewardAmount,
				args: [rewardValue],
				address: mockRewardsDistributionAddress,
				accounts,
			});
		});

		it('only rewardsDistribution address can call notifyRewardAmount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: shortingRewards.notifyRewardAmount,
				args: [rewardValue],
				address: mockRewardsDistributionAddress,
				accounts,
			});
		});

		it('only owner address can call setRewardsDuration', async () => {
			await fastForward(DAY * 7);
			await onlyGivenAddressCanInvoke({
				fnc: shortingRewards.setRewardsDuration,
				args: [70],
				address: owner,
				accounts,
			});
		});

		it('only owner address can call setPaused', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: shortingRewards.setPaused,
				args: [true],
				address: owner,
				accounts,
			});
		});
	});

	describe('Pausable', async () => {
		beforeEach(async () => {
			await shortingRewards.setPaused(true, { from: owner });
		});
		it('should revert calling enrol() when paused', async () => {
			await assert.revert(
				short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 }),
				'This action cannot be performed while the contract is paused'
			);
		});
		it('should not revert calling stake() when unpaused', async () => {
			await shortingRewards.setPaused(false, { from: owner });

			await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
		});
	});

	describe('External Rewards Recovery', () => {
		const amount = toUnit('5000');
		beforeEach(async () => {
			// Send ERC20 to shortingRewards Contract
			await externalRewardsToken.transfer(shortingRewards.address, amount, { from: owner });
			assert.bnEqual(await externalRewardsToken.balanceOf(shortingRewards.address), amount);
		});
		// 	it('only owner can call recoverERC20', async () => {
		// 		await onlyGivenAddressCanInvoke({
		// 			fnc: shortingRewards.recoverERC20,
		// 			args: [externalRewardsToken.address, amount],
		// 			address: owner,
		// 			accounts,
		// 			reason: 'Only the contract owner may perform this action',
		// 		});
		// 	});
		// 	it('should revert if recovering staking token', async () => {
		// 		await assert.revert(
		// 			shortingRewards.recoverERC20(stakingToken.address, amount, {
		// 				from: owner,
		// 			}),
		// 			'Cannot withdraw the staking or rewards tokens'
		// 		);
		// 	});
		// 	it('should revert if recovering rewards token (SNX)', async () => {
		// 		// rewardsToken in these tests is the underlying contract
		// 		await assert.revert(
		// 			shortingRewards.recoverERC20(rewardsToken.address, amount, {
		// 				from: owner,
		// 			}),
		// 			'Cannot withdraw the staking or rewards tokens'
		// 		);
		// 	});
		// 	it('should revert if recovering the SNX Proxy', async () => {
		// 		const snxProxy = await rewardsToken.proxy();
		// 		await assert.revert(
		// 			shortingRewards.recoverERC20(snxProxy, amount, {
		// 				from: owner,
		// 			}),
		// 			'Cannot withdraw the staking or rewards tokens'
		// 		);
		// 	});
		// 	it('should retrieve external token from shortingRewards and reduce contracts balance', async () => {
		// 		await shortingRewards.recoverERC20(externalRewardsToken.address, amount, {
		// 			from: owner,
		// 		});
		// 		assert.bnEqual(await externalRewardsToken.balanceOf(shortingRewards.address), ZERO_BN);
		// 	});
		// 	it('should retrieve external token from shortingRewards and increase owners balance', async () => {
		// 		const ownerMOARBalanceBefore = await externalRewardsToken.balanceOf(owner);

		// 		await shortingRewards.recoverERC20(externalRewardsToken.address, amount, {
		// 			from: owner,
		// 		});

		// 		const ownerMOARBalanceAfter = await externalRewardsToken.balanceOf(owner);
		// 		assert.bnEqual(ownerMOARBalanceAfter.sub(ownerMOARBalanceBefore), amount);
		// 	});
		// 	it('should emit Recovered event', async () => {
		// 		const transaction = await shortingRewards.recoverERC20(externalRewardsToken.address, amount, {
		// 			from: owner,
		// 		});
		// 		assert.eventEqual(transaction, 'Recovered', {
		// 			token: externalRewardsToken.address,
		// 			amount: amount,
		// 		});
		// 	});
	});

	describe('lastTimeRewardApplicable()', () => {
		it('should return 0', async () => {
			assert.bnEqual(await shortingRewards.lastTimeRewardApplicable(), ZERO_BN);
		});

		describe('when updated', () => {
			it('should equal current timestamp', async () => {
				await shortingRewards.notifyRewardAmount(toUnit(1.0), {
					from: mockRewardsDistributionAddress,
				});

				const cur = await currentTime();
				const lastTimeReward = await shortingRewards.lastTimeRewardApplicable();

				assert.equal(cur.toString(), lastTimeReward.toString());
			});
		});
	});

	describe('rewardPerToken()', () => {
		it('should return 0', async () => {
			assert.bnEqual(await shortingRewards.rewardPerToken(), ZERO_BN);
		});

		it('should be > 0', async () => {
			await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });

			const totalSupply = await shortingRewards.totalSupply();
			assert.bnGt(totalSupply, ZERO_BN);

			const rewardValue = toUnit(5000.0);
			await rewardsToken.transfer(shortingRewards.address, rewardValue, { from: owner });
			await shortingRewards.notifyRewardAmount(rewardValue, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			const rewardPerToken = await shortingRewards.rewardPerToken();
			assert.bnGt(rewardPerToken, ZERO_BN);
		});
	});

	describe('stake()', () => {
		it('staking increases staking balance', async () => {
			const initialStakeBal = await shortingRewards.balanceOf(account1);
			// const initialLpBal = await stakingToken.balanceOf(stakingAccount1);

			await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });

			const postStakeBal = await shortingRewards.balanceOf(account1);

			assert.bnGt(postStakeBal, initialStakeBal);
		});

		xit('cannot stake 0', async () => {
			await assert.revert(shortingRewards.stake('0'), 'Cannot stake 0');
		});
	});

	describe('earned()', () => {
		it('should be 0 when not staking', async () => {
			assert.bnEqual(await shortingRewards.earned(account1), ZERO_BN);
		});

		it('should be > 0 when staking', async () => {
			await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });

			const rewardValue = toUnit(5000.0);
			await rewardsToken.transfer(shortingRewards.address, rewardValue, { from: owner });
			await shortingRewards.notifyRewardAmount(rewardValue, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			const earned = await shortingRewards.earned(account1);

			assert.bnGt(earned, ZERO_BN);
		});

		it('rewardRate should increase if new rewards come before DURATION ends', async () => {
			const totalToDistribute = toUnit('5000');

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			const rewardRateInitial = await shortingRewards.rewardRate();

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			const rewardRateLater = await shortingRewards.rewardRate();

			assert.bnGt(rewardRateInitial, ZERO_BN);
			assert.bnGt(rewardRateLater, rewardRateInitial);
		});

		it('rewards token balance should rollover after DURATION', async () => {
			const totalToDistribute = toUnit('5000');

			await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 7);
			const earnedFirst = await shortingRewards.earned(account1);

			await setRewardsTokenExchangeRate();
			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 7);
			const earnedSecond = await shortingRewards.earned(account1);

			assert.bnEqual(earnedSecond, earnedFirst.add(earnedFirst));
		});
	});

	describe('getReward()', () => {
		it('should increase rewards token balance', async () => {
			const totalToDistribute = toUnit('5000');

			tx = await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
			id = await getid(tx);

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			const initialRewardBal = await rewardsToken.balanceOf(account1);
			const initialEarnedBal = await shortingRewards.earned(account1);

			await issuesBTCtoAccount(toUnit(1), account1);
			await short.close(id, { from: account1 });

			const postRewardBal = await rewardsToken.balanceOf(account1);
			const postEarnedBal = await shortingRewards.earned(account1);

			assert.bnLt(postEarnedBal, initialEarnedBal);
			assert.bnGt(postRewardBal, initialRewardBal);
		});
	});

	describe('setRewardsDuration()', () => {
		const sevenDays = DAY * 7;
		const seventyDays = DAY * 70;
		it('should increase rewards duration before starting distribution', async () => {
			const defaultDuration = await shortingRewards.rewardsDuration();
			assert.bnEqual(defaultDuration, sevenDays);

			await shortingRewards.setRewardsDuration(seventyDays, { from: owner });
			const newDuration = await shortingRewards.rewardsDuration();
			assert.bnEqual(newDuration, seventyDays);
		});
		it('should revert when setting setRewardsDuration before the period has finished', async () => {
			const totalToDistribute = toUnit('5000');

			tx = await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
			id = await getid(tx);

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			await assert.revert(
				shortingRewards.setRewardsDuration(seventyDays, { from: owner }),
				'Previous rewards period must be complete before changing the duration for the new period'
			);
		});
		it('should update when setting setRewardsDuration after the period has finished', async () => {
			const totalToDistribute = toUnit('5000');

			tx = await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
			id = await getid(tx);

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 8);

			const transaction = await shortingRewards.setRewardsDuration(seventyDays, { from: owner });
			assert.eventEqual(transaction, 'RewardsDurationUpdated', {
				newDuration: seventyDays,
			});

			const newDuration = await shortingRewards.rewardsDuration();
			assert.bnEqual(newDuration, seventyDays);

			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});
		});

		it('should update when setting setRewardsDuration after the period has finished', async () => {
			const totalToDistribute = toUnit('5000');

			tx = await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
			id = await getid(tx);

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 4);
			await shortingRewards.getReward(account1, { from: shortingRewards.adddress });
			await fastForward(DAY * 4);

			// New Rewards period much lower
			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			const transaction = await shortingRewards.setRewardsDuration(seventyDays, { from: owner });
			assert.eventEqual(transaction, 'RewardsDurationUpdated', {
				newDuration: seventyDays,
			});

			const newDuration = await shortingRewards.rewardsDuration();
			assert.bnEqual(newDuration, seventyDays);

			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 71);
			await shortingRewards.getReward(account1, { from: shortingRewards.adddress });
		});
	});

	describe('getRewardForDuration()', () => {
		it('should increase rewards token balance', async () => {
			const totalToDistribute = toUnit('5000');
			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(totalToDistribute, {
				from: mockRewardsDistributionAddress,
			});

			const rewardForDuration = await shortingRewards.getRewardForDuration();

			const duration = await shortingRewards.rewardsDuration();
			const rewardRate = await shortingRewards.rewardRate();

			assert.bnGt(rewardForDuration, ZERO_BN);
			assert.bnEqual(rewardForDuration, duration.mul(rewardRate));
		});
	});

	describe('withdraw()', () => {
		it('should increases lp token balance and decreases staking balance', async () => {
			const totalToStake = toUnit(1);

			tx = await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
			id = await getid(tx);

			const initialStakeBal = await shortingRewards.balanceOf(account1);

			tx = await short.close(id, { from: account1 });

			const postStakeBal = await shortingRewards.balanceOf(account1);

			assert.bnEqual(postStakeBal.add(toBN(totalToStake)), initialStakeBal);
		});
	});

	describe('exit()', () => {
		it('should retrieve all earned and increase rewards bal', async () => {
			const totalToDistribute = toUnit('5000');

			tx = await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
			id = await getid(tx);

			await rewardsToken.transfer(shortingRewards.address, totalToDistribute, { from: owner });
			await shortingRewards.notifyRewardAmount(toUnit(5000.0), {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			const initialRewardBal = await rewardsToken.balanceOf(account1);
			const initialEarnedBal = await shortingRewards.earned(account1);
			tx = await short.close(id, { from: account1 });
			const postRewardBal = await rewardsToken.balanceOf(account1);
			const postEarnedBal = await shortingRewards.earned(account1);

			assert.bnLt(postEarnedBal, initialEarnedBal);
			assert.bnGt(postRewardBal, initialRewardBal);
			assert.bnEqual(postEarnedBal, ZERO_BN);
		});
	});

	describe('notifyRewardAmount()', () => {
		let localshortingRewards;

		before(async () => {
			localshortingRewards = await setupContract({
				accounts,
				contract: 'ShortingRewards',
				args: [
					owner,
					addressResolver.address,
					rewardsDistribution.address,
					rewardsToken.address,
					short.address,
					toBytes32('SynthsBTC'),
				],
			});

			await localshortingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('Reverts if the provided reward is greater than the balance.', async () => {
			const rewardValue = toUnit(1000);
			await rewardsToken.transfer(localshortingRewards.address, rewardValue, { from: owner });
			await assert.revert(
				localshortingRewards.notifyRewardAmount(rewardValue.add(toUnit(0.1)), {
					from: mockRewardsDistributionAddress,
				}),
				'Provided reward too high'
			);
		});

		it('Reverts if the provided reward is greater than the balance, plus rolled-over balance.', async () => {
			const rewardValue = toUnit(1000);
			await rewardsToken.transfer(localshortingRewards.address, rewardValue, { from: owner });
			localshortingRewards.notifyRewardAmount(rewardValue, {
				from: mockRewardsDistributionAddress,
			});
			await rewardsToken.transfer(localshortingRewards.address, rewardValue, { from: owner });
			// Now take into account any leftover quantity.
			await assert.revert(
				localshortingRewards.notifyRewardAmount(rewardValue.add(toUnit(0.1)), {
					from: mockRewardsDistributionAddress,
				}),
				'Provided reward too high'
			);
		});
	});

	describe('Integration Tests', () => {
		before(async () => {
			// Set rewardDistribution address
			await shortingRewards.setRewardsDistribution(rewardsDistribution.address, {
				from: owner,
			});
			assert.equal(await shortingRewards.rewardsDistribution(), rewardsDistribution.address);

			await setRewardsTokenExchangeRate();
		});

		it('stake and claim', async () => {
			// Transfer some LP Tokens to user
			const totalToStake = toUnit(1);

			tx = await short.open(toUnit(15000), toUnit(1), sBTC, { from: account1 });
			id = await getid(tx);

			// Distribute some rewards
			const totalToDistribute = toUnit('35000');
			assert.equal(await rewardsDistribution.distributionsLength(), 0);
			await rewardsDistribution.addRewardDistribution(shortingRewards.address, totalToDistribute, {
				from: owner,
			});
			assert.equal(await rewardsDistribution.distributionsLength(), 1);

			// Transfer Rewards to the RewardsDistribution contract address
			await rewardsToken.transfer(rewardsDistribution.address, totalToDistribute, { from: owner });

			// Distribute Rewards called from Synthetix contract as the authority to distribute
			await rewardsDistribution.distributeRewards(totalToDistribute, {
				from: authority,
			});

			// Period finish should be ~7 days from now
			const periodFinish = await shortingRewards.periodFinish();
			const curTimestamp = await currentTime();
			assert.equal(parseInt(periodFinish.toString(), 10), curTimestamp + DAY * 7);

			// Reward duration is 7 days, so we'll
			// Fastforward time by 6 days to prevent expiration
			await fastForward(DAY * 6);

			// Reward rate and reward per token
			const rewardRate = await shortingRewards.rewardRate();
			assert.bnGt(rewardRate, ZERO_BN);

			const rewardPerToken = await shortingRewards.rewardPerToken();
			assert.bnGt(rewardPerToken, ZERO_BN);

			// Make sure we earned in proportion to reward per token
			const rewardRewardsEarned = await shortingRewards.earned(account1);
			assert.bnEqual(rewardRewardsEarned, rewardPerToken.mul(totalToStake).div(toUnit(1)));

			// Make sure after withdrawing, we still have the ~amount of rewardRewards
			// The two values will be a bit different as time has "passed"
			tx = await short.repay(account1, id, toUnit(0.2), { from: account1 });

			const rewardRewardsEarnedPostWithdraw = await shortingRewards.earned(account1);
			assert.bnClose(rewardRewardsEarned, rewardRewardsEarnedPostWithdraw, toUnit('0.1'));
		});
	});
});