// src/peer-discovery.js

/**
 * Handles peer discovery and connection strategies
 * STABILIZED: Conservative peer discovery with proper backoff to prevent churn
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
    
    // STABILIZED: Conservative discovery with longer backoff
    this.failedDiscoveryAttempts = 0;
    this.maxFailedAttempts = 3; // REDUCED: Stop trying sooner when no peers available
    this.backoffMultiplier = 3; // INCREASED: More aggressive backoff
    this.baseDiscoveryInterval = 30000; // INCREASED: Start with 30 seconds
    this.maxDiscoveryInterval = 300000; // INCREASED: Max 5 minutes between attempts
    this.lastSuccessfulDiscovery = 0;
    this.isDiscoveryActive = false; // Prevent overlapping discovery attempts
    this.discoveryPaused = false; // ADDED: Pause discovery when no peers available
    
    // STABILIZED: Start discovery with longer initial delay
    this.startSmartDiscovery();
  }

  /**
   * STABILIZED: Conservative peer discovery with exponential backoff
   * Prevents infinite loops and reduces network churn
   */
  startSmartDiscovery() {
    console.log(`PEER-DISCOVERY: Started conservative discovery for peer ${this.localPeerId}`);
    
    // Start with initial delay to let the network settle
    this.scheduleNextDiscovery(this.baseDiscoveryInterval);
  }

  /**
   * STABILIZED: Determine if we should attempt discovery based on conservative logic
   */
  shouldAttemptDiscovery() {
    // Don't attempt if discovery is already active or paused
    if (this.isDiscoveryActive || this.discoveryPaused) {
      return false;
    }

    // ENHANCED: Check if we have any potential peers at all
    if (!this.hasPotentialPeers()) {
      console.log(`PEER-DISCOVERY: ${this.localPeerId} - No potential peers available, pausing discovery`);
      this.discoveryPaused = true;
      return false;
    }

    // Always attempt if we haven't failed too many times
    if (this.failedDiscoveryAttempts < this.maxFailedAttempts) {
      return true;
    }

    // If we've failed many times, only attempt occasionally
    const timeSinceLastSuccess = Date.now() - this.lastSuccessfulDiscovery;
    const shouldRetry = timeSinceLastSuccess > this.maxDiscoveryInterval;
    
    if (shouldRetry) {
      console.log(`PEER-DISCOVERY: ${this.localPeerId} - Retrying discovery after extended backoff period`);
      // Reset failed attempts after long backoff
      this.failedDiscoveryAttempts = Math.max(0, this.failedDiscoveryAttempts - 1);
    }
    
    return shouldRetry;
  }

  /**
   * ENHANCED: Check if we have any potential peers to discover
   */
  hasPotentialPeers() {
    // Check routing table
    const allContacts = this.kademlia.routingTable.getAllContacts
      ? this.kademlia.routingTable.getAllContacts()
      : this.kademlia.routingTable.buckets.flat();
    
    const routingTablePeers = allContacts
      .filter(c => c.id !== this.localPeerId && !this.peerManager.getPeers().has(c.id));
    
    // Check reconnection data
    const reconnectionPeers = this._reconnectionPeers
      .filter(id => id !== this.localPeerId && !this.peerManager.getPeers().has(id));
    
    // Check alternative peers
    const alternativePeers = this._alternativePeers
      .filter(id => id !== this.localPeerId && !this.peerManager.getPeers().has(id));
    
    const totalPotential = routingTablePeers.length + reconnectionPeers.length + alternativePeers.length;
    
    console.log(`PEER-DISCOVERY: Potential peers available - Routing: ${routingTablePeers.length}, Reconnection: ${reconnectionPeers.length}, Alternative: ${alternativePeers.length}, Total: ${totalPotential}`);
    
    return totalPotential > 0;
  }

  /**
   * STABILIZED: Schedule next discovery attempt with conservative timing
   */
  scheduleNextDiscovery(interval) {
    if (this.discoveryTimeout) {
      clearTimeout(this.discoveryTimeout);
    }
    
    this.discoveryTimeout = setTimeout(async () => {
      const currentPeerCount = this.peerManager.getPeerCount();
      
      // STABILIZED: Only discover if we're significantly under-connected
      if (currentPeerCount >= Math.floor(this.maxPeers * 0.8)) {
        // We have enough peers, schedule next check with longer interval
        this.scheduleNextDiscovery(this.maxDiscoveryInterval);
        return;
      }

      // Check if we should attempt discovery based on backoff
      if (this.shouldAttemptDiscovery()) {
        console.log(`PEER-DISCOVERY: ${this.localPeerId} has ${currentPeerCount}/${this.maxPeers} peers, seeking connections...`);
        
        this.isDiscoveryActive = true;
        const foundPeers = await this.findAndConnectPeers();
        this.isDiscoveryActive = false;
        
        if (foundPeers > 0) {
          // Success! Reset backoff and unpause
          this.failedDiscoveryAttempts = 0;
          this.lastSuccessfulDiscovery = Date.now();
          this.discoveryPaused = false;
          this.scheduleNextDiscovery(this.baseDiscoveryInterval);
        } else {
          // No peers found, increase backoff
          this.failedDiscoveryAttempts++;
          
          // ENHANCED: If we've failed max attempts, pause discovery
          if (this.failedDiscoveryAttempts >= this.maxFailedAttempts) {
            console.log(`PEER-DISCOVERY: ${this.localPeerId} - Max discovery attempts reached, pausing discovery for extended period`);
            this.discoveryPaused = true;
            this.scheduleNextDiscovery(this.maxDiscoveryInterval * 2); // Extra long pause
          } else {
            const backoffInterval = Math.min(
              this.baseDiscoveryInterval * Math.pow(this.backoffMultiplier, this.failedDiscoveryAttempts),
              this.maxDiscoveryInterval
            );
            
            console.log(`PEER-DISCOVERY: ${this.localPeerId} - No peers found (attempt ${this.failedDiscoveryAttempts}), backing off to ${backoffInterval}ms`);
            this.scheduleNextDiscovery(backoffInterval);
          }
        }
      } else {
        // Skip this attempt due to backoff, active discovery, or no peers available
        const nextInterval = this.discoveryPaused ? this.maxDiscoveryInterval * 2 : this.baseDiscoveryInterval;
        this.scheduleNextDiscovery(nextInterval);
      }
    }, interval);
  }

  /**
   * STABILIZED: Conservative peer discovery with proper return value
   * Returns number of peers found/connected to help with backoff logic
   */
  async findAndConnectPeers() {
    const currentPeerCount = this.peerManager.getPeerCount();
    
    // STABILIZED: Only discover if we're below 80% of maxPeers
    if (currentPeerCount >= Math.floor(this.maxPeers * 0.8)) {
      console.log(`PEER-DISCOVERY: ${this.localPeerId} has sufficient peers (${currentPeerCount}/${this.maxPeers})`);
      return 0;
    }

    const needed = this.maxPeers - currentPeerCount;
    console.log(`PEER-DISCOVERY: ${this.localPeerId} seeking ${needed} more connections`);

    // STABILIZED: Conservative discovery with limited strategies
    return await this.discoverPeersConservatively(Math.min(needed, 2)); // Max 2 connections per discovery
  }

  /**
   * STABILIZED: Conservative peer discovery that returns number of peers found
   */
  async discoverPeersConservatively(needed) {
    let totalFound = 0;
    
    // STABILIZED: Use fewer strategies and add delays between them
    const strategies = [
      () => this.discoverViaRoutingTable(needed - totalFound),
      () => this.discoverViaReconnectionData(needed - totalFound),
      () => this.discoverViaKademlia(needed - totalFound)
    ];

    for (const strategy of strategies) {
      const currentPeerCount = this.peerManager.getPeerCount();
      if (currentPeerCount >= this.maxPeers || totalFound >= needed) break;
      
      try {
        const found = await strategy();
        totalFound += found;
        
        // STABILIZED: Longer delay between strategies to reduce network load
        if (found > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay after success
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay after failure
        }
      } catch (error) {
        console.error('PEER-DISCOVERY: Strategy failed:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return totalFound;
  }

  /**
   * STABILIZED: Discover peers via routing table with return value
   */
  async discoverViaRoutingTable(needed) {
    try {
      const allContacts = this.kademlia.routingTable.getAllContacts
        ? this.kademlia.routingTable.getAllContacts()
        : this.kademlia.routingTable.buckets.flat();

      const availablePeers = allContacts
        .map(c => c.id)
        .filter(id => 
          id !== this.localPeerId && 
          !this.peerManager.getPeers().has(id)
        )
        .slice(0, needed); // STABILIZED: Limit to needed peers

      if (availablePeers.length === 0) {
        console.log('PEER-DISCOVERY: No peers available in routing table');
        return 0;
      }

      console.log('PEER-DISCOVERY: Found potential peers via routing table:', availablePeers);

      let connected = 0;
      for (const peerId of availablePeers) {
        if (connected >= needed) break;
        if (this.peerManager.getPeerCount() >= this.maxPeers) break;
        
        console.log(`PEER-DISCOVERY: Attempting connection to routing table peer: ${peerId}`);
        const success = await this.peerManager.requestConnection(peerId, true);
        if (success) {
          connected++;
          // STABILIZED: Add delay between connection attempts
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      return connected;
    } catch (error) {
      console.error('PEER-DISCOVERY: Routing table discovery failed:', error);
      return 0;
    }
  }

  /**
   * STABILIZED: Discover peers via reconnection data with return value
   */
  async discoverViaReconnectionData(needed) {
    if (!this._reconnectionPeers || this._reconnectionPeers.length === 0) {
      console.log('PEER-DISCOVERY: No reconnection data available');
      return 0;
    }

    try {
      console.log('PEER-DISCOVERY: Attempting reconnection data discovery...');
      
      const availablePeers = this._reconnectionPeers
        .filter(peerId => 
          peerId !== this.localPeerId && 
          !this.peerManager.getPeers().has(peerId)
        )
        .slice(0, needed); // STABILIZED: Limit to needed peers

      if (availablePeers.length === 0) {
        console.log('PEER-DISCOVERY: No available peers in reconnection data');
        return 0;
      }

      let connected = 0;
      for (const peerId of availablePeers) {
        if (connected >= needed) break;
        if (this.peerManager.getPeerCount() >= this.maxPeers) break;
        
        console.log(`PEER-DISCOVERY: Attempting connection to reconnection peer: ${peerId}`);
        const success = await this.peerManager.requestConnection(peerId, true);
        if (success) {
          connected++;
          // STABILIZED: Add delay between connection attempts
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      return connected;
    } catch (error) {
      console.error('PEER-DISCOVERY: Reconnection data discovery failed:', error);
      return 0;
    }
  }

  /**
   * STABILIZED: Discover peers via Kademlia DHT with return value
   */
  async discoverViaKademlia(needed) {
    try {
      // STABILIZED: Only use Kademlia discovery as last resort
      console.log('PEER-DISCOVERY: Attempting Kademlia discovery as last resort...');
      const potentialPeers = await this.kademlia.findNode(this.localPeerId);
      
      if (potentialPeers.length === 0) {
        console.log('PEER-DISCOVERY: Kademlia discovery found no peers');
        return 0;
      }
      
      console.log('PEER-DISCOVERY: Found potential peers via Kademlia:', potentialPeers.map(p => p.id));

      const availablePeers = potentialPeers
        .filter(contact => 
          contact.id !== this.localPeerId && 
          !this.peerManager.getPeers().has(contact.id)
        )
        .slice(0, needed); // STABILIZED: Limit to needed peers

      let connected = 0;
      for (const contact of availablePeers) {
        if (connected >= needed) break;
        if (this.peerManager.getPeerCount() >= this.maxPeers) break;
        
        console.log(`PEER-DISCOVERY: Attempting connection to Kademlia peer: ${contact.id}`);
        const success = await this.peerManager.requestConnection(contact.id, true);
        if (success) {
          connected++;
          // STABILIZED: Add delay between connection attempts
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      return connected;
    } catch (error) {
      console.error('PEER-DISCOVERY: Kademlia discovery failed:', error);
      return 0;
    }
  }

  /**
   * STABILIZED: Reset backoff when new peers join the network
   */
  onPeerConnected() {
    // Reset discovery backoff when a peer connects
    this.failedDiscoveryAttempts = Math.max(0, this.failedDiscoveryAttempts - 1);
    this.lastSuccessfulDiscovery = Date.now();
    this.discoveryPaused = false; // ADDED: Unpause discovery when peer connects
    
    // If we were in a long backoff, restart discovery with shorter interval
    if (this.discoveryTimeout) {
      clearTimeout(this.discoveryTimeout);
      this.scheduleNextDiscovery(this.baseDiscoveryInterval);
    }
    
    console.log(`PEER-DISCOVERY: Peer connected, discovery unpaused and backoff reset`);
  }

  /**
   * ENHANCED: Resume discovery when new peers become available
   */
  onNewPeersAvailable() {
    if (this.discoveryPaused) {
      console.log(`PEER-DISCOVERY: New peers available, resuming discovery`);
      this.discoveryPaused = false;
      this.failedDiscoveryAttempts = 0;
      
      if (this.discoveryTimeout) {
        clearTimeout(this.discoveryTimeout);
        this.scheduleNextDiscovery(this.baseDiscoveryInterval);
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
    let potentialPeers = [];
    
    if (hasRecentReconnectionData) {
      potentialPeers = [...this._reconnectionPeers];
    }
    
    if (hasAlternativePeers) {
      this._alternativePeers.forEach(peerId => {
        if (!potentialPeers.includes(peerId)) {
          potentialPeers.push(peerId);
        }
      });
    }
    
    if (hasKnownPeers) {
      knownPeersFromRouting.forEach(contact => {
        if (!potentialPeers.includes(contact.id)) {
          potentialPeers.push(contact.id);
        }
      });
    }
    
    if (potentialPeers.length === 0) {
      console.log('PEER-DISCOVERY: No peers available for assisted reconnection');
      return false;
    }

    console.log(`PEER-DISCOVERY: Attempting peer-based connection with ${potentialPeers.length} potential peers...`);
    
    // Connect transport if needed
    if (!transportInstance.isConnected) {
      try {
        await transportInstance.connect(this.localPeerId, {silentConnect: true});
      } catch (error) {
        console.warn('PEER-DISCOVERY: Failed to connect transport silently:', error);
      }
    }
    
    let reconnectedViaPeers = false;
    
    // STABILIZED: Try connecting to fewer peers with delays
    const peersToTry = potentialPeers.slice(0, Math.min(3, this.maxPeers)); // Max 3 peers
    
    for (const alternatePeerId of peersToTry) {
      if (this.peerManager.getPeerCount() >= this.maxPeers) break;
      
      try {
        console.log(`PEER-DISCOVERY: Trying peer-assisted connection to ${alternatePeerId}...`);
        const connectionAllowed = await this.peerManager.requestConnection(alternatePeerId, true);
        
        if (connectionAllowed) {
          // Wait to see if connection establishes
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const peers = this.peerManager.getPeers();
          if (peers.has(alternatePeerId) && peers.get(alternatePeerId).connected) {
            console.log(`PEER-DISCOVERY: Successfully connected to peer ${alternatePeerId}!`);
            reconnectedViaPeers = true;
          }
        }
        
        // STABILIZED: Add delay between attempts
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`PEER-DISCOVERY: Failed to connect via peer ${alternatePeerId}:`, error);
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
    
    // ENHANCED: Resume discovery if new peers are available
    this.onNewPeersAvailable();
  }

  /**
   * Bootstraps Kademlia with connected peers
   * @param {Array} connectedPeers - Array of connected peer objects
   */
  async bootstrapWithConnectedPeers(connectedPeers) {
    if (connectedPeers.length > 0) {
      console.log(`PEER-DISCOVERY: Bootstrapping Kademlia with ${connectedPeers.length} connected peers...`);
      await this.kademlia.bootstrap(connectedPeers);
      
      // ENHANCED: Resume discovery after bootstrap
      this.onNewPeersAvailable();
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

  /**
   * STABILIZED: Cleanup method to stop discovery
   */
  destroy() {
    if (this.discoveryTimeout) {
      clearTimeout(this.discoveryTimeout);
      this.discoveryTimeout = null;
    }
    this.isDiscoveryActive = false;
    this.discoveryPaused = true;
    console.log(`PEER-DISCOVERY: Stopped discovery for peer ${this.localPeerId}`);
  }
}
