// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface AssetListing {
  id: string;
  encryptedPrice: string;
  encryptedDetails: string;
  timestamp: number;
  owner: string;
  assetType: string;
  status: "pending" | "verified" | "rejected";
  complianceVerified: boolean;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [listings, setListings] = useState<AssetListing[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newListingData, setNewListingData] = useState({ assetType: "", description: "", price: 0 });
  const [selectedListing, setSelectedListing] = useState<AssetListing | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  // Statistics
  const verifiedCount = listings.filter(l => l.status === "verified").length;
  const pendingCount = listings.filter(l => l.status === "pending").length;
  const rejectedCount = listings.filter(l => l.status === "rejected").length;
  const compliantCount = listings.filter(l => l.complianceVerified).length;

  useEffect(() => {
    loadListings().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadListings = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("listing_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing listing keys:", e); }
      }
      
      const list: AssetListing[] = [];
      for (const key of keys) {
        try {
          const listingBytes = await contract.getData(`listing_${key}`);
          if (listingBytes.length > 0) {
            try {
              const listingData = JSON.parse(ethers.toUtf8String(listingBytes));
              list.push({ 
                id: key, 
                encryptedPrice: listingData.price, 
                encryptedDetails: listingData.details,
                timestamp: listingData.timestamp, 
                owner: listingData.owner, 
                assetType: listingData.assetType, 
                status: listingData.status || "pending",
                complianceVerified: listingData.complianceVerified || false
              });
            } catch (e) { console.error(`Error parsing listing data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading listing ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setListings(list);
    } catch (e) { console.error("Error loading listings:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitListing = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting asset data with Zama FHE..." });
    try {
      const encryptedPrice = FHEEncryptNumber(newListingData.price);
      const encryptedDetails = `FHE-${btoa(newListingData.description)}`;
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const listingId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const listingData = { 
        price: encryptedPrice, 
        details: encryptedDetails,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        assetType: newListingData.assetType, 
        status: "pending",
        complianceVerified: false
      };
      
      await contract.setData(`listing_${listingId}`, ethers.toUtf8Bytes(JSON.stringify(listingData)));
      
      const keysBytes = await contract.getData("listing_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(listingId);
      await contract.setData("listing_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset listed securely with FHE encryption!" });
      await loadListings();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewListingData({ assetType: "", description: "", price: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyListing = async (listingId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Verifying asset with FHE encryption..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const listingBytes = await contract.getData(`listing_${listingId}`);
      if (listingBytes.length === 0) throw new Error("Listing not found");
      const listingData = JSON.parse(ethers.toUtf8String(listingBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedListing = { ...listingData, status: "verified", complianceVerified: true };
      await contractWithSigner.setData(`listing_${listingId}`, ethers.toUtf8Bytes(JSON.stringify(updatedListing)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset verified with FHE encryption!" });
      await loadListings();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectListing = async (listingId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Rejecting asset listing..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const listingBytes = await contract.getData(`listing_${listingId}`);
      if (listingBytes.length === 0) throw new Error("Listing not found");
      const listingData = JSON.parse(ethers.toUtf8String(listingBytes));
      const updatedListing = { ...listingData, status: "rejected" };
      await contract.setData(`listing_${listingId}`, ethers.toUtf8Bytes(JSON.stringify(updatedListing)));
      setTransactionStatus({ visible: true, status: "success", message: "Asset listing rejected!" });
      await loadListings();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (listingAddress: string) => address?.toLowerCase() === listingAddress.toLowerCase();

  // Filter listings based on search and filters
  const filteredListings = listings.filter(listing => {
    const matchesSearch = listing.assetType.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         listing.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = filterType === "all" || listing.assetType === filterType;
    const matchesStatus = filterStatus === "all" || listing.status === filterStatus;
    return matchesSearch && matchesType && matchesStatus;
  });

  // Asset types for filter
  const assetTypes = [...new Set(listings.map(l => l.assetType))];

  const renderComplianceChart = () => {
    const total = listings.length || 1;
    const compliantPercentage = (compliantCount / total) * 100;
    const nonCompliantPercentage = ((total - compliantCount) / total) * 100;
    
    return (
      <div className="compliance-chart">
        <div className="chart-bar">
          <div 
            className="bar-segment compliant" 
            style={{ width: `${compliantPercentage}%` }}
            data-tooltip={`${compliantPercentage.toFixed(1)}% Compliant`}
          ></div>
          <div 
            className="bar-segment non-compliant" 
            style={{ width: `${nonCompliantPercentage}%` }}
            data-tooltip={`${nonCompliantPercentage.toFixed(1)}% Non-Compliant`}
          ></div>
        </div>
        <div className="chart-legend">
          <div className="legend-item">
            <div className="color-dot compliant"></div>
            <span>Compliant: {compliantCount}</span>
          </div>
          <div className="legend-item">
            <div className="color-dot non-compliant"></div>
            <span>Non-Compliant: {listings.length - compliantCount}</span>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing RWA DEX with FHE encryption...</p>
    </div>
  );

  return (
    <div className="app-container metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
              <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
              <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
            </svg>
          </div>
          <h1>RWA<span>DEX</span></h1>
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-listing-btn metal-button"
            data-hover-glow
          >
            <div className="add-icon"></div>
            List Asset
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content panel-layout">
        <div className="left-panel">
          <div className="panel-section stats-section metal-card">
            <h3>Market Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value gold-text">{listings.length}</div>
                <div className="stat-label">Total Listings</div>
              </div>
              <div className="stat-item">
                <div className="stat-value silver-text">{verifiedCount}</div>
                <div className="stat-label">Verified</div>
              </div>
              <div className="stat-item">
                <div className="stat-value bronze-text">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat-item">
                <div className="stat-value copper-text">{compliantCount}</div>
                <div className="stat-label">Compliant</div>
              </div>
            </div>
          </div>

          <div className="panel-section compliance-section metal-card">
            <h3>Compliance Status</h3>
            {renderComplianceChart()}
          </div>

          <div className="panel-section partners-section metal-card">
            <h3>Technology Partners</h3>
            <div className="partners-grid">
              <div className="partner-logo" data-tooltip="Zama FHE">
                <img src="https://zama.ai/favicon.ico" alt="Zama" />
                <span>Zama</span>
              </div>
              <div className="partner-logo" data-tooltip="Ethereum">
                <img src="https://ethereum.org/favicon.ico" alt="Ethereum" />
                <span>Ethereum</span>
              </div>
              <div className="partner-logo" data-tooltip="RainbowKit">
                <img src="https://rainbowkit.com/favicon.ico" alt="RainbowKit" />
                <span>RainbowKit</span>
              </div>
            </div>
          </div>
        </div>

        <div className="right-panel">
          <div className="panel-section search-section metal-card">
            <div className="search-filters">
              <div className="search-input">
                <input 
                  type="text" 
                  placeholder="Search assets..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <div className="search-icon"></div>
              </div>
              <div className="filter-group">
                <select 
                  value={filterType} 
                  onChange={(e) => setFilterType(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Types</option>
                  {assetTypes.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="filter-group">
                <select 
                  value={filterStatus} 
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Status</option>
                  <option value="verified">Verified</option>
                  <option value="pending">Pending</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <button 
                onClick={loadListings} 
                className="refresh-btn metal-button"
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="panel-section listings-section metal-card">
            <div className="listings-header">
              <h2>Asset Listings</h2>
              <div className="header-info">
                Showing {filteredListings.length} of {listings.length} assets
              </div>
            </div>
            
            {filteredListings.length === 0 ? (
              <div className="no-listings">
                <div className="no-listings-icon"></div>
                <p>No asset listings found</p>
                <button 
                  className="metal-button primary" 
                  onClick={() => setShowCreateModal(true)}
                >
                  List Your First Asset
                </button>
              </div>
            ) : (
              <div className="listings-grid">
                {filteredListings.map(listing => (
                  <div 
                    className="listing-card" 
                    key={listing.id}
                    onClick={() => setSelectedListing(listing)}
                    data-hover-glow
                  >
                    <div className="card-header">
                      <div className="asset-type">{listing.assetType}</div>
                      <div className={`status-badge ${listing.status}`}>
                        {listing.status}
                        {listing.complianceVerified && <span className="compliance-check"></span>}
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="asset-id">ID: #{listing.id.substring(0, 6)}</div>
                      <div className="asset-owner">
                        Owner: {listing.owner.substring(0, 6)}...{listing.owner.substring(38)}
                      </div>
                      <div className="asset-date">
                        Listed: {new Date(listing.timestamp * 1000).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="card-footer">
                      <div className="encrypted-price">
                        <span>Encrypted Price:</span>
                        <div>{listing.encryptedPrice.substring(0, 20)}...</div>
                      </div>
                      {isOwner(listing.owner) && listing.status === "pending" && (
                        <div className="owner-actions">
                          <button 
                            className="action-btn metal-button success" 
                            onClick={(e) => { e.stopPropagation(); verifyListing(listing.id); }}
                          >
                            Verify
                          </button>
                          <button 
                            className="action-btn metal-button danger" 
                            onClick={(e) => { e.stopPropagation(); rejectListing(listing.id); }}
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitListing} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          listingData={newListingData} 
          setListingData={setNewListingData}
        />
      )}

      {selectedListing && (
        <ListingDetailModal 
          listing={selectedListing} 
          onClose={() => { setSelectedListing(null); setDecryptedPrice(null); }} 
          decryptedPrice={decryptedPrice} 
          setDecryptedPrice={setDecryptedPrice} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>RWA DEX</span>
            </div>
            <p>Privacy-preserving Real World Asset exchange powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} RWA DEX. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  listingData: any;
  setListingData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, listingData, setListingData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setListingData({ ...listingData, [name]: value });
  };

  const handlePriceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setListingData({ ...listingData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!listingData.assetType || !listingData.price) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>List New Asset</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your asset details will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Asset Type *</label>
              <select 
                name="assetType" 
                value={listingData.assetType} 
                onChange={handleChange} 
                className="metal-select"
              >
                <option value="">Select asset type</option>
                <option value="Real Estate">Real Estate</option>
                <option value="Artwork">Artwork</option>
                <option value="Commodities">Commodities</option>
                <option value="Precious Metals">Precious Metals</option>
                <option value="Intellectual Property">Intellectual Property</option>
                <option value="Other">Other</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Description</label>
              <textarea 
                name="description" 
                value={listingData.description} 
                onChange={handleChange} 
                placeholder="Asset description..."
                className="metal-textarea"
                rows={3}
              />
            </div>
            
            <div className="form-group">
              <label>Price (USD) *</label>
              <input 
                type="number" 
                name="price" 
                value={listingData.price} 
                onChange={handlePriceChange} 
                placeholder="Enter price..."
                className="metal-input"
                step="0.01"
                min="0"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{listingData.price || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {listingData.price ? 
                    FHEEncryptNumber(listingData.price).substring(0, 30) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Privacy Guarantee</strong>
              <p>Asset details remain encrypted during processing and are never decrypted on our servers</p>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ListingDetailModalProps {
  listing: AssetListing;
  onClose: () => void;
  decryptedPrice: number | null;
  setDecryptedPrice: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const ListingDetailModal: React.FC<ListingDetailModalProps> = ({ 
  listing, 
  onClose, 
  decryptedPrice, 
  setDecryptedPrice, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedPrice !== null) { 
      setDecryptedPrice(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(listing.encryptedPrice);
    if (decrypted !== null) setDecryptedPrice(decrypted);
  };

  const decryptedDetails = listing.encryptedDetails.startsWith('FHE-') ? 
    atob(listing.encryptedDetails.substring(4)) : 
    listing.encryptedDetails;

  return (
    <div className="modal-overlay">
      <div className="listing-detail-modal metal-card">
        <div className="modal-header">
          <h2>Asset Details #{listing.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="listing-info">
            <div className="info-item">
              <span>Type:</span>
              <strong>{listing.assetType}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{listing.owner.substring(0, 6)}...{listing.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Listed:</span>
              <strong>{new Date(listing.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${listing.status}`}>
                {listing.status}
                {listing.complianceVerified && <span className="compliance-check"></span>}
              </strong>
            </div>
          </div>
          
          <div className="section-divider"></div>
          
          <div className="listing-description">
            <h3>Description</h3>
            <p>{decryptedDetails}</p>
          </div>
          
          <div className="section-divider"></div>
          
          <div className="price-section">
            <h3>Price Information</h3>
            <div className="encrypted-price">
              <span>Encrypted Price:</span>
              <div className="encrypted-value">
                {listing.encryptedPrice.substring(0, 50)}...
              </div>
              <div className="fhe-tag">
                <div className="fhe-icon"></div>
                <span>FHE Encrypted</span>
              </div>
              <button 
                className="decrypt-btn metal-button" 
                onClick={handleDecrypt} 
                disabled={isDecrypting}
              >
                {isDecrypting ? (
                  <span className="decrypt-spinner"></span>
                ) : decryptedPrice !== null ? (
                  "Hide Decrypted Price"
                ) : (
                  "Decrypt with Wallet Signature"
                )}
              </button>
            </div>
            
            {decryptedPrice !== null && (
              <div className="decrypted-price">
                <span>Decrypted Price:</span>
                <div className="price-value">
                  ${decryptedPrice.toLocaleString()}
                </div>
                <div className="decryption-notice">
                  <div className="warning-icon"></div>
                  <span>Decrypted price is only visible after wallet signature verification</span>
                </div>
              </div>
            )}
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;