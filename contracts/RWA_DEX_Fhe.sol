pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RwaDexFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds;
    bool public paused;

    struct Order {
        euint32 encryptedAssetId;
        euint32 encryptedAmount;
        euint32 encryptedPrice;
        euint32 encryptedExpiryBlock;
        bool isAsk;
    }
    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId;

    struct Batch {
        uint256 id;
        bool isOpen;
    }
    Batch public currentBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event OrderSubmitted(address indexed provider, uint256 indexed orderId, uint256 indexed batchId, bool isAsk);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 clearedAskVolume, uint256 clearedBidVolume);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatchId();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error OrderNotFound();

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (isProvider[provider]) revert();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) revert();
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (paused == _paused) revert();
        paused = _paused;
        if (_paused) {
            emit Paused(msg.sender);
        } else {
            emit Unpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (currentBatch.isOpen) revert();
        currentBatch.id++;
        currentBatch.isOpen = true;
        emit BatchOpened(currentBatch.id);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.isOpen) revert();
        currentBatch.isOpen = false;
        emit BatchClosed(currentBatch.id);
    }

    function submitOrder(
        euint32 encryptedAssetId,
        euint32 encryptedAmount,
        euint32 encryptedPrice,
        euint32 encryptedExpiryBlock,
        bool isAsk
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!currentBatch.isOpen) revert BatchNotOpen();

        lastSubmissionTime[msg.sender] = block.timestamp;
        orders[nextOrderId] = Order(encryptedAssetId, encryptedAmount, encryptedPrice, encryptedExpiryBlock, isAsk);
        emit OrderSubmitted(msg.sender, nextOrderId, currentBatch.id, isAsk);
        nextOrderId++;
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) internal {
        if (!v.isInitialized()) {
            v.initialize();
        }
    }
    
    function _requireInitialized(euint32 v) internal pure {
        if (!v.isInitialized()) revert("Ciphertext not initialized");
    }

    function requestBatchProcessing(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId != currentBatch.id) revert InvalidBatchId();
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 memory totalAskVolume = FHE.asEuint32(0);
        euint32 memory totalBidVolume = FHE.asEuint32(0);

        for (uint256 i = 0; i < nextOrderId; i++) {
            if (orders[i].encryptedExpiryBlock.isInitialized() && orders[i].encryptedExpiryBlock.le(FHE.asEuint32(block.number))) {
                continue; // Skip expired orders
            }
            _initIfNeeded(totalAskVolume);
            _initIfNeeded(totalBidVolume);
            _initIfNeeded(orders[i].encryptedAmount);

            if (orders[i].isAsk) {
                totalAskVolume = totalAskVolume.add(orders[i].encryptedAmount);
            } else {
                totalBidVolume = totalBidVolume.add(orders[i].encryptedAmount);
            }
        }
        _requireInitialized(totalAskVolume);
        _requireInitialized(totalBidVolume);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = totalAskVolume.toBytes32();
        cts[1] = totalBidVolume.toBytes32();
        
        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        
        decryptionContexts[requestId] = DecryptionContext(batchId, stateHash, false);
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        
        bytes32[] memory cts = new bytes32[](2);
        for (uint256 i = 0; i < nextOrderId; i++) {
            if (orders[i].encryptedExpiryBlock.isInitialized() && orders[i].encryptedExpiryBlock.le(FHE.asEuint32(block.number))) {
                continue; // Skip expired orders
            }
            euint32 memory totalAskVolume = FHE.asEuint32(0);
            euint32 memory totalBidVolume = FHE.asEuint32(0);
            _initIfNeeded(totalAskVolume);
            _initIfNeeded(totalBidVolume);
            _initIfNeeded(orders[i].encryptedAmount);

            if (orders[i].isAsk) {
                totalAskVolume = totalAskVolume.add(orders[i].encryptedAmount);
            } else {
                totalBidVolume = totalBidVolume.add(orders[i].encryptedAmount);
            }
            cts[0] = totalAskVolume.toBytes32();
            cts[1] = totalBidVolume.toBytes32();
        }
        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();
        
        try FHE.checkSignatures(requestId, cleartexts, proof) {
            uint256 clearedAskVolume = abi.decode(cleartexts, (uint256));
            uint256 clearedBidVolume = abi.decode(cleartexts[32:], (uint256));
            
            decryptionContexts[requestId].processed = true;
            emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, clearedAskVolume, clearedBidVolume);
        } catch {
            revert InvalidProof();
        }
    }
}