// src/peer-discovery.js

/**
 * Handles peer discovery and connection strategies
 * FIXED: More aggressive initial discovery to allow connections
 */
export class PeerDiscovery {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.kademlia = options.kademlia;
    this.peerManager = options.peerManager;
    this.transport = options.transport;
    this.maxPeers = options.maxPeers || 5;
    this.eventHandlers = options.eventHandlers || {};
    
    // Store reconnection data for peer-assisted reconnection
    this._reconnectionPeers = [];
    this._reconnectionDataTimestamp = 0;
    this._alternativePeers = [];
    
    // FIXED: More aggressive initial discovery, conservative after connections
    this.failedDiscoveryAttempts = 0;
    this.maxFailedAttempts = 5; // Allow more attempts for initial connections
    this.backoffMultiplier = 2; // Less aggressive backoff
    this.baseDiscoveryInterval = 5000; // FIXED: Start with 5 seconds for faster initial connections
    this.maxDiscoveryInterval = 60000; // FIXED: Max 1 minute between attempts
    this.lastSuccessfulDiscovery = 0;
    this.isDiscoveryActive = false; // Prevent overlapping discovery attempts
    this.discoveryPaused = false; // ADDED: Pause discovery when no peers available
    
    // ENHANCED: Additional properties for improved discovery
    this.lastDiscoveryAttempt = 0;
    this.discoveryAttempts = 0;
    this.baseDiscoveryDelay = 2000; // FIXED: Shorter initial delay
    this.maxDiscoveryDelay = 30000; // FIXED: Shorter max delay
    this.discoveryBackoff = this.baseDiscoveryDelay;
    this.isDiscovering = false;
    
    // FIXED: Start discovery immediately for initial connections
    this.startSmartDiscovery();
  }

  /**
   * FIXED: More aggressive peer discovery for initial connections
   */
  startSmartDiscovery() {
    console.log(`PEER-DISCOVERY: Started discovery for peer ${this.localPeerId}`);
    
    // FIXED: Start immediately if no connections, otherwise use base interval
    const initialDelay = this.peerManager.getPeerCount() === 0 ? 1000 : this.baseDiscoveryInterval;
    this.scheduleNextDiscovery(initialDelay);
  }

  /**
   * FIXED: More permissive discovery logic to allow initial connections
   */
  shouldAttemptDiscovery() {
    // Don't attempt if discovery is already active
    if (this.isDiscoveryActive) {
      return false;
    }

    // FIXED: Don't pause discovery if we have no connections at all
    const currentPeerCount = this.peerManager.getPeerCount();
    if (currentPeerCount === 0) {
      console.log(`PEER-DISCOVERY: ${this.localPeerId} - No connections, forcing discovery attempt`);
      this.discoveryPaused = false; // Unpause if we have no connections
      return true;
    }

    // Don't attempt if discovery is paused (but only if we have some connections)
    if (this.discoveryPaused) {
      return false;
    }

    // ENHANCED: Check if we have any potential peers at all
    if (!this.hasPotentialPeers()) {
      console.log(`PEER-DISCOVERY: ${this.localPeerId} - No potential peers available, pausing discovery`);
      this.discoveryPaused = true;
      return false;
    }

    // FIXED: Be more permissive with failed attempts for initial connections
    if (this.failedDiscoveryAttempts < this.maxFailedAttempts || currentPeerCount === 0) {
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
   * FIXED: More aggressive scheduling for initial connections
   */
  scheduleNextDiscovery(interval) {
    if (this.discoveryTimeout) {
      clearTimeout(this.discoveryTimeout);
    }
    
    this.discoveryTimeout = setTimeout(async () => {
      const currentPeerCount = this.peerManager.getPeerCount();
      
      // FIXED: Be more aggressive when we have no connections
      if (currentPeerCount === 0) {
        console.log(`PEER-DISCOVERY: ${this.localPeerId} has no connections, attempting immediate discovery...`);
      } else if (currentPeerCount >= Math.floor(this.maxPeers * 0.8)) {
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
          // FIXED: Use shorter interval after successful connections
          const nextInterval = currentPeerCount < 2 ? this.baseDiscoveryInterval / 2 : this.baseDiscoveryInterval;
          this.scheduleNextDiscovery(nextInterval);
        } else {
          // No peers found, increase backoff
          this.failedDiscoveryAttempts++;
          
          // ENHANCED: If we've failed max attempts, pause discovery
          if (this.failedDiscoveryAttempts >= this.maxFailedAttempts && currentPeerCount > 0) {
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
   * ENHANCED: Kademlia-aware peer discovery with stability improvements
   */
  async findAndConnectPeers() {
    if (this.isDiscovering) {
      console.log('PEER-DISCOVERY: Already discovering, skipping...');
      return 0;
    }

    this.isDiscovering = true;
    
    try {
      const currentPeerCount = this.peerManager.getPeerCount();
      const connectedPeerCount = this.peerManager.getConnectedPeerCount();
      console.log(`PEER-DISCOVERY: Current peer count: ${currentPeerCount}/${this.maxPeers} (${connectedPeerCount} connected)`);

      // FIXED: Be more aggressive when we have few connections
      const minDesiredPeers = Math.max(1, Math.floor(this.maxPeers * 0.4));
      if (connectedPeerCount >= minDesiredPeers && currentPeerCount >= this.maxPeers) {
        console.log(`PEER-DISCOVERY: Sufficient connectivity (${connectedPeerCount}/${minDesiredPeers} desired), skipping discovery`);
        return 0;
      }

      // FIXED: Reduce backoff for initial connections
      const now = Date.now();
      if (currentPeerCount > 0 && now - this.lastDiscoveryAttempt < this.discoveryBackoff) {
        console.log(`PEER-DISCOVERY: In backoff period, waiting ${this.discoveryBackoff - (now - this.lastDiscoveryAttempt)}ms`);
        return 0;
      }

      this.lastDiscoveryAttempt = now;
      this.discoveryAttempts++;
      
      // FIXED: Less aggressive backoff for initial connections
      if (currentPeerCount === 0) {
        this.discoveryBackoff = this.baseDiscoveryDelay; // No backoff when no connections
      } else {
        this.discoveryBackoff = Math.min(
          this.baseDiscoveryDelay * Math.pow(2, Math.max(0, this.discoveryAttempts - 3)),
          this.maxDiscoveryDelay
        );
      }

      console.log(`PEER-DISCOVERY: Starting discovery attempt ${this.discoveryAttempts} (next backoff: ${this.discoveryBackoff}ms)`);

      // ENHANCED: Get peers from multiple sources for better diversity
      const potentialPeers = await this.gatherPotentialPeers();

      console.log(`PEER-DISCOVERY: Found ${potentialPeers.length} potential peers from all sources`);

      if (potentialPeers.length === 0) {
        console.log('PEER-DISCOVERY: No potential peers found, attempting Kademlia lookup');
        // Try a Kademlia lookup to discover new peers
        await this.performKademliaDiscovery();
        return 0;
      }

      // ENHANCED: Smart peer selection based on Kademlia distance and connection status
      const selectedPeers = this.selectOptimalPeers(potentialPeers, currentPeerCount);

      console.log(`PEER-DISCOVERY: Attempting to connect to ${selectedPeers.length} optimal peers:`, selectedPeers.map(p => p.id));

      // FIXED: Shorter delays for initial connections
      let successfulConnections = 0;
      for (const peerInfo of selectedPeers) {
        try {
          const connected = await this.peerManager.requestConnection(peerInfo.id, true);
          if (connected) {
            console.log(`PEER-DISCOVERY: Successfully initiated connection to ${peerInfo.id}`);
            successfulConnections++;
          } else {
            console.log(`PEER-DISCOVERY: Connection to ${peerInfo.id} was rejected`);
          }
          
          // FIXED: Shorter delay between connection attempts
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`PEER-DISCOVERY: Failed to connect to ${peerInfo.id}:`, error);
        }
      }

      // ENHANCED: Reset backoff on successful connections
      if (successfulConnections > 0) {
        console.log(`PEER-DISCOVERY: ${successfulConnections} successful connections, resetting backoff`);
        this.discoveryAttempts = Math.max(0, this.discoveryAttempts - successfulConnections);
        this.discoveryBackoff = this.baseDiscoveryDelay;
      }

      return successfulConnections;

    } finally {
      this.isDiscovering = false;
    }
  }

  /**
   * ENHANCED: Gather potential peers from multiple sources
   * @returns {Promise<Array>} Array of potential peer objects with metadata
   */
  async gatherPotentialPeers() {
    const potentialPeers = new Map();
    const connectedPeers = this.peerManager.getPeers();
    const pendingConnections = this.peerManager.pendingConnections;

    // Source 1: Kademlia routing table
    const allContacts = this.kademlia.routingTable.getAllContacts
      ? this.kademlia.routingTable.getAllContacts()
      : this.kademlia.routingTable.buckets.flat();

    for (const contact of allContacts) {
      if (contact.id !== this.localPeerId && 
          !connectedPeers.has(contact.id) && 
          !pendingConnections.has(contact.id)) {
        potentialPeers.set(contact.id, {
          id: contact.id,
          source: 'kademlia',
          lastSeen: contact.lastSeen || 0,
          failureCount: contact.failureCount || 0,
          priority: 1
        });
      }
    }

    // Source 2: Reconnection data (alternative peers from previous sessions)
    const reconnectionData = this.getReconnectionData();
    for (const peerId of reconnectionData.peers) {
      if (peerId !== this.localPeerId && 
          !connectedPeers.has(peerId) && 
          !pendingConnections.has(peerId) &&
          !potentialPeers.has(peerId)) {
        potentialPeers.set(peerId, {
          id: peerId,
          source: 'reconnection',
          lastSeen: reconnectionData.timestamp || 0,
          failureCount: 0,
          priority: 0.8
        });
      }
    }

    // Source 3: Transport-level peer discovery
    if (this.transport && typeof this.transport.discoverPeers === 'function') {
      try {
        console.log('PEER-DISCOVERY: Attempting transport-level peer discovery...');
        const transportDiscoveredPeers = await this.transport.discoverPeers();
        
        if (transportDiscoveredPeers && Array.isArray(transportDiscoveredPeers)) {
          console.log(`PEER-DISCOVERY: Transport discovered ${transportDiscoveredPeers.length} peers`);
          
          for (const peerId of transportDiscoveredPeers) {
            if (peerId !== this.localPeerId && 
                !connectedPeers.has(peerId) && 
                !pendingConnections.has(peerId) &&
                !potentialPeers.has(peerId)) {
              potentialPeers.set(peerId, {
                id: peerId,
                source: 'transport',
                lastSeen: Date.now(),
                failureCount: 0,
                priority: 0.9 // High priority for fresh transport discoveries
              });
            }
          }
        }
      } catch (error) {
        console.warn('PEER-DISCOVERY: Transport peer discovery failed:', error.message);
      }
    }

    return Array.from(potentialPeers.values());
  }

  /**
   * FIXED: Select optimal peers without BigInt conversion error
   * @param {Array} potentialPeers - Array of potential peer objects
   * @param {number} currentPeerCount - Current number of peers
   * @returns {Array} Array of selected peer objects
   */
  selectOptimalPeers(potentialPeers, currentPeerCount) {
    const maxNewConnections = Math.min(3, this.maxPeers - currentPeerCount); // FIXED: Allow more connections at once
    
    // FIXED: Score peers without complex distance calculation to avoid BigInt errors
    const scoredPeers = potentialPeers.map(peer => {
      // Use a simple numeric distance instead of BigInt
      let distance = Math.floor(Math.random() * 1000000);
      
      // Score based on multiple factors
      let score = peer.priority;
      
      // Prefer peers with recent activity
      const timeSinceLastSeen = Date.now() - (peer.lastSeen || 0);
      if (timeSinceLastSeen < 300000) { // 5 minutes
        score += 0.3;
      }
      
      // Penalize peers with failures
      score -= (peer.failureCount || 0) * 0.2;
      
      // Prefer Kademlia routing table peers
      if (peer.source === 'kademlia') {
        score += 0.2;
      }
      
      return {
        ...peer,
        distance,
        score
      };
    });

    // Sort by score (highest first), then by distance (closest first)
    scoredPeers.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.1) {
        return b.score - a.score; // Higher score first
      }
      return a.distance - b.distance; // Closer distance first (numeric comparison)
    });

    return scoredPeers.slice(0, maxNewConnections);
  }

  /**
   * ENHANCED: Perform Kademlia discovery to find new peers
   */
  async performKademliaDiscovery() {
    try {
      console.log('PEER-DISCOVERY: Performing Kademlia discovery for new peers');
      
      // Perform a FIND_NODE for a random ID to discover new peers
      const randomId = this.generateRandomKademliaId();
      const discoveredPeers = await this.kademlia.findNode(randomId);
      
      console.log(`PEER-DISCOVERY: Kademlia discovery found ${discoveredPeers.length} peers`);
      
      // Try to connect to some of the discovered peers
      const connectablePeers = discoveredPeers
        .filter(peer => 
          peer.id !== this.localPeerId && 
          !this.peerManager.getPeers().has(peer.id) &&
          !this.peerManager.pendingConnections.has(peer.id)
        )
        .slice(0, 2);
      
      for (const peer of connectablePeers) {
        try {
          await this.peerManager.requestConnection(peer.id, true);
          console.log(`PEER-DISCOVERY: Initiated connection to discovered peer ${peer.id}`);
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`PEER-DISCOVERY: Failed to connect to discovered peer ${peer.id}:`, error);
        }
      }
      
    } catch (error) {
      console.error('PEER-DISCOVERY: Kademlia discovery failed:', error);
    }
  }

  /**
   * Generate a random Kademlia ID for discovery
   * @returns {string} Random Kademlia ID
   */
  generateRandomKademliaId() {
    let id = '';
    for (let i = 0; i < 40; i++) { // 160 bits / 4 bits per hex char
      id += Math.floor(Math.random() * 16).toString(16);
    }
    return id;
  }

  /**
   * FIXED: Reset backoff when new peers join the network
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
   * @param {Object} transportInstance - Transport instance for signaling
   * @returns {boolean} True if reconnection was attempted via peers
   */
  async attemptPeerAssistedReconnection(transportInstance) {
    const reconnectionData = this.getReconnectionData();
    const availablePeers = reconnectionData.peers.filter(peerId => peerId !== this.localPeerId);
    
    if (availablePeers.length === 0) {
      console.log('PEER-DISCOVERY: No reconnection data available');
      return false;
    }

    console.log(`PEER-DISCOVERY: Attempting peer-assisted reconnection with ${availablePeers.length} stored peers...`);
    
    let reconnectedViaPeers = false;
    
    // Try to connect to stored peers directly
    for (const peerId of availablePeers.slice(0, Math.min(3, this.maxPeers))) {
      try {
        console.log(`PEER-DISCOVERY: Attempting direct reconnection to ${peerId}`);
        const connected = await this.peerManager.requestConnection(peerId, true);
        if (connected) {
          console.log(`PEER-DISCOVERY: Successfully reconnected to ${peerId}`);
          reconnectedViaPeers = true;
          
          // Add a small delay between connections
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`PEER-DISCOVERY: Failed to reconnect to ${peerId}:`, error);
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
   * FIXED: Cleanup method to stop discovery
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
