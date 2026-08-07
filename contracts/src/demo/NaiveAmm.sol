// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeTransfer} from "../SafeTransfer.sol";

/// @notice A constant-product pool for the same FXRP/USDT0 pair the venue
/// trades. This is the comparison baseline, not part of the venue.
///
/// @dev It lives under `src/demo` and is deployed separately so there is no
/// chance of reading it as production code. It exists to make one point
/// measurable: on a public pool, a trade is fully legible before it executes,
/// and that legibility has a price.
///
/// The mechanics are Uniswap v2's, reduced to what the comparison needs:
///
/// - `x * y = k` with a 30 bps fee, the fee accruing to the reserves
/// - reserves tracked in storage rather than read from balances, so a token
///   donation cannot move the price out from under the demo
/// - liquidity seeded by the owner, with no LP tokens, because nobody but the
///   deployer ever provides liquidity here
///
/// "Naive" refers to the venue design, not the implementation. Nothing here is
/// deliberately broken: this is what a competent constant-product pool looks
/// like, and it is sandwichable anyway. That is the point. The vulnerability is
/// in the shape of the venue, not in a bug that a careful developer would have
/// caught.
contract NaiveAmm {
    using SafeTransfer for address;

    /// @dev Both tokens use 6 decimals, so prices are quoted in the same scale
    /// the enclave and the FTSO band use. Never assume 18 anywhere.
    uint256 public constant PRICE_SCALE = 1e6;

    /// @dev 30 bps, expressed as the share that survives the fee.
    uint256 public constant FEE_NUMERATOR = 9970;
    uint256 public constant FEE_DENOMINATOR = 10_000;

    address public immutable BASE;
    address public immutable QUOTE;
    address public immutable OWNER;

    uint256 public reserveBase;
    uint256 public reserveQuote;

    error NotOwner();
    error ZeroAmount();
    error NoLiquidity();
    error SlippageExceeded(uint256 got, uint256 minOut);

    event LiquidityAdded(uint256 baseAmount, uint256 quoteAmount);
    event Swap(address indexed trader, bool baseIn, uint256 amountIn, uint256 amountOut);

    constructor(address base, address quote, address owner) {
        BASE = base;
        QUOTE = quote;
        OWNER = owner;
    }

    /// @notice Seed the pool. Owner only, and additive, so the demo can top up
    /// a pool that a previous run drained.
    function addLiquidity(uint256 baseAmount, uint256 quoteAmount) external {
        if (msg.sender != OWNER) revert NotOwner();
        if (baseAmount == 0 || quoteAmount == 0) revert ZeroAmount();

        // Credit what actually arrived. A fee-on-transfer token would deliver
        // less than requested, and trusting the argument would overstate the
        // reserves and misprice every subsequent swap.
        uint256 baseBefore = _balance(BASE);
        uint256 quoteBefore = _balance(QUOTE);
        BASE.safeTransferFrom(msg.sender, address(this), baseAmount);
        QUOTE.safeTransferFrom(msg.sender, address(this), quoteAmount);
        uint256 baseReceived = _balance(BASE) - baseBefore;
        uint256 quoteReceived = _balance(QUOTE) - quoteBefore;

        reserveBase += baseReceived;
        reserveQuote += quoteReceived;
        emit LiquidityAdded(baseReceived, quoteReceived);
    }

    /// @notice Sell `amountIn` base for quote. Reverts if the output is below
    /// `minOut`.
    /// @dev `minOut` is the only protection a trader has here, and it is a weak
    /// one: it caps the loss but does not prevent the extraction, and a trader
    /// who sets it tightly simply gets reverted instead of filled. Compare with
    /// the venue, where the order is not visible to extract from in the first
    /// place.
    function swapBaseForQuote(uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        amountOut = _swap(true, amountIn, minOut);
    }

    /// @notice Buy base with `amountIn` quote.
    function swapQuoteForBase(uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        amountOut = _swap(false, amountIn, minOut);
    }

    /// @notice What `amountIn` would fetch right now, at the current reserves.
    /// @dev Public and free to call. That is exactly the problem being
    /// illustrated: anyone can price a pending trade before it lands.
    function quoteOut(bool baseIn, uint256 amountIn) public view returns (uint256) {
        (uint256 reserveIn, uint256 reserveOut) =
            baseIn ? (reserveBase, reserveQuote) : (reserveQuote, reserveBase);
        if (reserveIn == 0 || reserveOut == 0) revert NoLiquidity();
        if (amountIn == 0) return 0;

        uint256 amountInWithFee = (amountIn * FEE_NUMERATOR) / FEE_DENOMINATOR;
        return (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);
    }

    /// @notice Marginal price of base in quote, scaled by 1e6.
    /// @dev The price a trade actually gets is worse than this, and gets worse
    /// the larger the trade. That gap is the slippage a sandwich widens.
    function spotPrice() external view returns (uint256) {
        if (reserveBase == 0) revert NoLiquidity();
        return (reserveQuote * PRICE_SCALE) / reserveBase;
    }

    /// @notice Average price actually paid or received, scaled by 1e6.
    /// @dev The number worth comparing between venues. `size` is always in base
    /// units and `quote` in quote units, whichever direction the swap ran.
    function executionPrice(uint256 baseAmount, uint256 quoteAmount) external pure returns (uint256) {
        if (baseAmount == 0) return 0;
        return (quoteAmount * PRICE_SCALE) / baseAmount;
    }

    function _swap(bool baseIn, uint256 amountIn, uint256 minOut) private returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        amountOut = quoteOut(baseIn, amountIn);

        (address tokenIn, address tokenOut) = baseIn ? (BASE, QUOTE) : (QUOTE, BASE);

        uint256 inBefore = _balance(tokenIn);
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = _balance(tokenIn) - inBefore;

        // Re-price against what arrived rather than what was asked for, then
        // enforce slippage. Checking `minOut` against the optimistic quote and
        // paying out the re-priced amount would let a fee-on-transfer token slip
        // past the trader's protection.
        if (received != amountIn) amountOut = quoteOut(baseIn, received);
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        if (baseIn) {
            reserveBase += received;
            reserveQuote -= amountOut;
        } else {
            reserveQuote += received;
            reserveBase -= amountOut;
        }

        tokenOut.safeTransfer(msg.sender, amountOut);
        emit Swap(msg.sender, baseIn, received, amountOut);
    }

    function _balance(address token) private view returns (uint256) {
        (bool ok, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf(address)
        require(ok && data.length >= 32, "balanceOf failed");
        return abi.decode(data, (uint256));
    }
}
