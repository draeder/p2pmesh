// src/peer-discovery.js

/**
 * Handles peer discovery and connection strategies
 */
export class PeerDiscovery {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.kademlia = options.kademlia;
    this.peerManager = options.peerManager;
    this.maxPeers = options.maxPeers || 5;
    this.eventHandlers = options.eventHandlers || {};
    
    // Store reconnection data for peer-assisted reconnection
    this._reconnectionPeers = [];
    this._reconnectionDataTimestamp = 0;
    this._alternativePeers = [];
  }

  /**
   * Finds and connects to peers using Kademlia DHT
   */
  async findAndConnectPeers() {
    if (this.peerManager.getPeerCount() >= this.maxPeers) return;

    console.log('Kademlia: Attempting to find new peers...');
    // Find nodes near our own ID to discover the network
    const potentialPeers = await this.kademlia.findNode(this.localPeerId);
    console.log('Kademlia: Found potential peers:', potentialPeers.map(p => p.id));

    for (const contact of potentialPeers) {
      if (this.peerManager.getPeerCount() >= this.maxPeers) break;
      if (contact.id !== this.localPeerId && !this.peerManager.getPeers().has(contact.id)) {
        console.log(`Attempting to establish WebRTC connection with Kademlia peer: ${contact.id}`);
        // Initiate WebRTC connection (simple-peer)
        await this.peerManager.connectToPeer(contact.id, true);
        // The 'signal' event from newPeer will send the offer via transport.send
        // This assumes the transport can route a 'signal' to a Kademlia peer ID.
        // If Kademlia peers are only known by ID, the transport needs to resolve ID to a routable address.
      }
    }
  }

  /**
   * Attempts peer-assisted reconnection using stored peer data
   * @param {Object} transportInstance - Transport instance for connections
   * @returns {Promise<boolean>} True if reconnection was attempted via peers
   */
  async attemptPeerAssistedReconnection(transportInstance) {
    // Check if we have recent reconnection data from previous sessions (within 10 minutes)
    const hasRecentReconnectionData = this._reconnectionPeers && 
                                   this._reconnectionPeers.length > 0 && 
                                   (Date.now() - this._reconnectionDataTimestamp < 10 * 60 * 1000);
    
    // Check for alternative peers collected from peer evictions
    const hasAlternativePeers = this._alternativePeers && this._alternativePeers.length > 0;
    
    // Check for known peers from routing table
    const knownPeersFromRouting = this.kademlia.routingTable.getAllContacts ? this.kademlia.routingTable.getAllContacts() : [];
    const hasKnownPeers = knownPeersFromRouting.length > 0;
    
    // Create a combined list of potential peers for connection attempts
    // Prioritize recently known peers for faster connection
    let potentialPeers = [];
    
    if (hasRecentReconnectionData) {
      potentialPeers = [...this._reconnectionPeers];
    }
    
    if (hasAlternativePeers) {
      // Add alternative peers, avoiding duplicates
      this._alternativePeers.forEach(peerId => {
        if (!potentialPeers.includes(peerId)) {
          potentialPeers.push(peerId);
        }
      });
    }
    
    if (hasKnownPeers) {
      // Add known peers from routing table, avoiding duplicates
      knownPeersFromRouting.forEach(contact => {
        if (!potentialPeers.includes(contact.id)) {
          potentialPeers.push(contact.id);
        }
      });
    }
    
    if (potentialPeers.length === 0) {
      return false;
    }

    console.log(`Attempting peer-based connection with ${potentialPeers.length} potential peers...`);
    
    // First connect transport minimally to facilitate peer connection if needed
    if (!transportInstance.isConnected) {
      try {
        await transportInstance.connect(this.localPeerId, {silentConnect: true});
      } catch (error) {
        console.warn('Failed to connect transport silently:', error);
        // Continue anyway - we might still be able to connect through peers
      }
    }
    
    let reconnectedViaPeers = false;
    
    // Try connecting to each potential peer
    for (const alternatePeerId of potentialPeers) {
      if (this.peerManager.getPeerCount() >= this.maxPeers) break; // Stop if we've reached max peers
      
      try {
        console.log(`Trying peer-assisted connection to ${alternatePeerId}...`);
        await this.peerManager.connectToPeer(alternatePeerId, true);
        
        // First attempt direct relay through any existing connected peers
        let relayAttempted = false;
        const peers = this.peerManager.getPeers();
        if (peers.size >= 2) {
          // Find existing peers to relay through
          peers.forEach((peer, peerId) => {
            if (peerId !== alternatePeerId && peer.connected) {
              try {
                // Send a connect request that will be relayed
                peer.send(JSON.stringify({
                  type: 'relay_signal',
                  from: this.localPeerId,
                  to: alternatePeerId,
                  signal: { type: 'connect_request' } // A minimal signal to initiate connection
                }));
                console.log(`Sent relay connection request to ${alternatePeerId} via ${peerId}`);
                relayAttempted = true;
              } catch (error) {
                console.error(`Failed to send relay request via peer ${peerId}:`, error);
              }
            }
          });
        }
        
        // If no peers available for relay or relay not attempted, fall back to transport
        if (!relayAttempted) {
          // Request connection via transport - this uses signaling but is direct
          transportInstance.send(alternatePeerId, { type: 'connect_request', from: this.localPeerId });
        }
        
        // If this successfully connects, peer:connect event will be triggered
        // Wait a bit to see if connection establishes before trying next peer
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Check if we connected successfully
        if (peers.has(alternatePeerId) && peers.get(alternatePeerId).connected) {
          console.log(`Successfully connected to peer ${alternatePeerId}!`);
          reconnectedViaPeers = true;
          
          // If this is our first peer connection and we have max peers > 1,
          // try to connect to one more peer for redundancy
          if (peers.size === 1 && this.maxPeers > 1) {
            console.log('Connected to one peer, continuing to try one more for redundancy');
            continue;
          }
          
          break; // Successfully connected to at least one peer (or two if needed)
        }
      } catch (error) {
        console.error(`Failed to connect via peer ${alternatePeerId}:`, error);
        // Continue to try the next peer
      }
    }

    return reconnectedViaPeers;
  }

  /**
   * Stores reconnection data for later use
   * @param {Array} peers - Array of peer IDs for reconnection
   * @param {number} timestamp - Timestamp when data was received
   */
  storeReconnectionData(peers, timestamp = Date.now()) {
    this._reconnectionPeers = peers;
    this._reconnectionDataTimestamp = timestamp;
    
    // Store these peers for potential direct connection attempts on next join
    if (this._alternativePeers) {
      // Merge with existing alternative peers, avoiding duplicates
      this._alternativePeers = [...new Set([...this._alternativePeers, ...peers])];
    } else {
      this._alternativePeers = [...peers];
    }
  }

  /**
   * Bootstraps Kademlia with connected peers
   * @param {Array} connectedPeers - Array of connected peer objects
   */
  async bootstrapWithConnectedPeers(connectedPeers) {
    if (connectedPeers.length > 0) {
      console.log(`Bootstrapping Kademlia with ${connectedPeers.length} connected peers...`);
      await this.kademlia.bootstrap(connectedPeers);
    }
  }

  /**
   * Gets reconnection data
   * @returns {Object} Reconnection data with peers and timestamp
   */
  getReconnectionData() {
    return {
      peers: this._reconnectionPeers,
      timestamp: this._reconnectionDataTimestamp,
      alternativePeers: this._alternativePeers
    };
  }

  /**
   * Clears stored reconnection data
   */
  clearReconnectionData() {
    this._reconnectionPeers = [];
    this._reconnectionDataTimestamp = 0;
    this._alternativePeers = [];
  }
}
