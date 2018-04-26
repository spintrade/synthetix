/* PublicHavven.sol: expose the internal functions in Havven
 * for testing purposes.
 */

pragma solidity 0.4.21;


import "contracts/Havven.sol";
import "contracts/TokenState.sol";


// Public getters for all items in the Havven contract, used for debugging/testing
contract PublicHavven is Havven {

    function PublicHavven(TokenState initialState, address _owner, address _oracle)
        Havven(initialState, _owner, _oracle)
        public
    {}

    function currentTime()
        public
        returns (uint)
    {
        return now;
    }

    function currentTotalIssuedNominBalanceSum()
        external
        view
        returns (uint)
    {
        return totalIssuedNominBalanceData.currentBalanceSum;
    }

    function lastAverageTotalIssuedNominBalance()
        external
        view
        returns (uint)
    {
        return totalIssuedNominBalanceData.lastAverageBalance;
    }

}
