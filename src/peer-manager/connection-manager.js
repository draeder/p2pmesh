// src/peer-manager/connection-manager.js
import { loadSimplePeer } from '../utils/simple-peer-loader.js';
import { calculateDistance } from '../kademlia.js';

/**
 * Manages peer connection lifecycle, eviction, and connection limits
 * STABILIZED: Reduced churn with conservative connection management
 */
export class ConnectionManager {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.maxPeers = options.maxPeers || 5;
    this.minPeers = Math.max(1, Math.floor(this.maxPeers * 0.5)); // STABILIZED: Less aggressive minimum (50% of max)
    this.iceServers = options.iceServers;
    this.kademlia = options.kademlia;
    this.transportInstance = options.transportInstance;
    this.eventHandlers = options.eventHandlers || {};
    
    this.peers = options.peers; // Reference to main peers Map
    this.peerConnectionAttempts = options.peerConnectionAttempts;
    this.pendingConnections = options.pendingConnections;
    this.setupPeerEvents = options.setupPeerEvents; // Callback to setup events
    
    // STABILIZED: Track disconnection events with backoff
    this.lastDisconnectionTime = 0;
    this.reconnectionAttempts = new Map(); // peerId -> attempt count
    this.maxReconnectionAttempts = 3; // REDUCED: Fewer reconnection attempts to prevent loops
    this.reconnectionBackoff = new Map(); // peerId -> next allowed reconnection time
    this.baseReconnectionDelay = 5000; // 5 seconds base delay
    this.maxReconnectionDelay = 60000; // 1 minute max delay
    
    // STABILIZED: Less frequent connectivity check to reduce churn
    this.connectivityCheckInterval = setInterval(() => {
      this.periodicConnectivityCheck();
    }, 20000); // Check every 20 seconds (much less frequent)
    
    console.log(`ConnectionManager initialized: maxPeers=${this.maxPeers}, minPeers=${this.minPeers} - STABILIZED MODE`);
  }

  /**
   * STABILIZED: Conservative periodic connectivity check
   */
  async periodicConnectivityCheck() {
    const connectedCount = this.getConnectedPeerCount();
    const pendingCount = this.pendingConnections.size;
    const totalCount = connectedCount + pendingCount;
    
    // STABILIZED: Only trigger reconnection if we're significantly under-connected
    if (connectedCount < this.minPeers && totalCount < this.minPeers) {
      console.log(`STABILITY: Below minimum connectivity (${connectedCount}/${this.minPeers}), seeking connections...`);
      await this.ensureMinimumConnectivity();
    } else if (connectedCount === 0 && pendingCount === 0) {
      // Only be aggressive if we have no connections at all
      console.log(`STABILITY: No connections, attempting emergency reconnection...`);
      await this.ensureMinimumConnectivity();
    }
  }

  /**
   * Get current connected peer count
   */
  getConnectedPeerCount() {
    return Array.from(this.peers.values()).filter(peer => peer.connected).length;
  }

  /**
   * Check if we're below minimum connectivity and need to reconnect
   */
  needsReconnection() {
    const connectedCount = this.getConnectedPeerCount();
    const pendingCount = this.pendingConnections.size;
    const totalCount = connectedCount + pendingCount;
    
    return connectedCount < this.minPeers && totalCount < this.minPeers;
  }

  /**
   * STABILIZED: Conservative connectivity management
   */
  async ensureMinimumConnectivity() {
    const connectedCount = this.getConnectedPeerCount();
    const pendingCount = this.pendingConnections.size;
    const totalCount = connectedCount + pendingCount;
    
    // STABILIZED: Only seek connections if we're below minimum
    if (connectedCount >= this.minPeers) {
      console.log(`STABILITY: Already at minimum connectivity (${connectedCount}/${this.minPeers}), no action needed`);
      return;
    }
    
    const needed = Math.min(this.minPeers - totalCount, 2); // STABILIZED: Connect to max 2 peers at once
    
    if (needed <= 0) {
      console.log(`STABILITY: Sufficient pending connections (${pendingCount}), waiting...`);
      return;
    }
    
    console.log(`STABILITY: Seeking ${needed} connections to reach minimum (${connectedCount}/${this.minPeers})`);
    
    // Get potential peers from Kademlia routing table
    const allContacts = this.kademlia.routingTable.getAllContacts
      ? this.kademlia.routingTable.getAllContacts()
      : this.kademlia.routingTable.buckets.flat();
    
    const availablePeers = allContacts
      .map(c => c.id)
      .filter(id => 
        id !== this.localPeerId && 
        !this.peers.has(id) && 
        !this.pendingConnections.has(id) &&
        this.canReconnectToPeer(id)
      );
    
    if (availablePeers.length === 0) {
      console.log('STABILITY: No available peers for connection');
      return;
    }
    
    // STABILIZED: Connect to available peers conservatively
    const peersToConnect = availablePeers.slice(0, needed);
    console.log(`STABILITY: Attempting to connect to ${peersToConnect.length} peers:`, peersToConnect);
    
    for (const peerId of peersToConnect) {
      try {
        await this.connectToPeer(peerId, true);
        this.updateReconnectionAttempt(peerId);
        
        // STABILIZED: Add delay between connection attempts
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`STABILITY: Failed to connect to ${peerId}:`, error);
      }
    }
  }

  /**
   * FIXED: More permissive reconnection check - allow initial connections
   */
  canReconnectToPeer(peerId) {
    const attempts = this.reconnectionAttempts.get(peerId) || 0;
    
    // FIXED: Always allow first connection attempt
    if (attempts === 0) {
      return true;
    }
    
    // Only apply limits after first failure
    if (attempts >= this.maxReconnectionAttempts) {
      return false;
    }
    
    const backoffTime = this.reconnectionBackoff.get(peerId);
    if (backoffTime && Date.now() < backoffTime) {
      return false;
    }
    
    return true;
  }

  /**
   * STABILIZED: Update reconnection attempt with exponential backoff
   */
  updateReconnectionAttempt(peerId) {
    const attempts = (this.reconnectionAttempts.get(peerId) || 0) + 1;
    this.reconnectionAttempts.set(peerId, attempts);
    
    // Calculate exponential backoff
    const delay = Math.min(
      this.baseReconnectionDelay * Math.pow(2, attempts - 1),
      this.maxReconnectionDelay
    );
    
    this.reconnectionBackoff.set(peerId, Date.now() + delay);
    console.log(`STABILITY: Set reconnection backoff for ${peerId}: ${delay}ms (attempt ${attempts})`);
  }

  /**
   * STABILIZED: Handle peer disconnection with conservative reconnection
   */
  async onPeerDisconnected(peerId) {
    this.lastDisconnectionTime = Date.now();
    
    // Clean up tracking
    this.peers.delete(peerId);
    this.peerConnectionAttempts.delete(peerId);
    this.pendingConnections.delete(peerId);
    
    const connectedCount = this.getConnectedPeerCount();
    console.log(`STABILITY: Peer ${peerId} disconnected. Connected peers: ${connectedCount}/${this.maxPeers} max`);
    
    // STABILIZED: Only trigger reconnection if we're below minimum and not too recently
    const timeSinceLastDisconnection = Date.now() - this.lastDisconnectionTime;
    if (connectedCount < this.minPeers && timeSinceLastDisconnection > 2000) {
      console.log('STABILITY: Below minimum connectivity, scheduling delayed reconnection...');
      // STABILIZED: Longer delay to prevent rapid reconnection cycles
      setTimeout(() => this.ensureMinimumConnectivity(), 5000);
    }
  }

  /**
   * FIXED: Smart connection requests with Kademlia-aware eviction and stability
   */
  async requestConnection(remotePeerId, initiator = true) {
    if (this.peers.has(remotePeerId) || this.pendingConnections.has(remotePeerId)) {
      console.log(`Already connected or connecting to ${remotePeerId}`);
      return false;
    }

    // STABILIZED: Check reconnection backoff
    if (!this.canReconnectToPeer(remotePeerId)) {
      console.log(`Cannot reconnect to ${remotePeerId}: in backoff period or max attempts reached`);
      return false;
    }

    const connectedPeerCount = this.getConnectedPeerCount();
    const pendingPeerCount = this.pendingConnections.size;
    const totalPeerCount = connectedPeerCount + pendingPeerCount;

    console.log(`STABILITY: Connection request from ${remotePeerId}: Connected=${connectedPeerCount}, Pending=${pendingPeerCount}, Total=${totalPeerCount}, Max=${this.maxPeers}`);

    // ENHANCED: Always allow connections if we're significantly under-connected
    if (connectedPeerCount < this.minPeers) {
      console.log(`STABILITY: Under minimum connectivity (${connectedPeerCount}/${this.minPeers}), allowing connection to ${remotePeerId}`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    // STABILIZED: Allow connections if we're under maxPeers
    if (totalPeerCount < this.maxPeers) {
      console.log(`STABILITY: Allowing connection to ${remotePeerId} (${totalPeerCount + 1}/${this.maxPeers})`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    // ENHANCED: Kademlia-aware eviction for better network topology
    const evicted = this.evictForKademliaOptimization(remotePeerId);
    if (evicted) {
      console.log(`STABILITY: Evicted peer for Kademlia optimization with ${remotePeerId}`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    console.log(`STABILITY: Cannot connect to ${remotePeerId}: max peers (${this.maxPeers}) reached and no beneficial eviction available`);
    return false;
  }

  /**
   * ENHANCED: Kademlia-aware eviction for optimal network topology
   * @param {string} newPeerId - ID of the new peer to connect to
   * @returns {boolean} True if eviction occurred
   */
  evictForKademliaOptimization(newPeerId) {
    try {
      const connectedCount = this.getConnectedPeerCount();
      
      // Only evict if we're at maxPeers
      if (connectedCount < this.maxPeers) {
        console.log(`STABILITY: Not at maxPeers (${connectedCount}/${this.maxPeers}), no eviction needed`);
        return false;
      }
      
      // ENHANCED: Use Kademlia routing table to make smart eviction decisions
      const distanceToNewPeer = calculateDistance(this.localPeerId, newPeerId);
      
      // Get all connected peers and their Kademlia distances
      const connectedPeersWithDistances = [];
      this.peers.forEach((peer, peerId) => {
        if (peer.connected) {
          const distance = calculateDistance(this.localPeerId, peerId);
          connectedPeersWithDistances.push({
            peerId,
            distance,
            peer,
            inKademliaTable: this.kademlia.routingTable.getAllContacts().some(c => c.id === peerId)
          });
        }
      });
      
      // Sort by distance (furthest first)
      connectedPeersWithDistances.sort((a, b) => a.distance > b.distance ? -1 : 1);
      
      console.log(`STABILITY: Evaluating ${connectedPeersWithDistances.length} connected peers for eviction`);
      
      // ENHANCED: Prefer to evict peers that are:
      // 1. Not in Kademlia routing table (less important for DHT)
      // 2. Furthest away
      // 3. Have connection issues
      
      let candidateForEviction = null;
      
      // First, try to find a peer not in Kademlia table that's further than new peer
      for (const peerInfo of connectedPeersWithDistances) {
        if (!peerInfo.inKademliaTable && peerInfo.distance > distanceToNewPeer) {
          candidateForEviction = peerInfo;
          console.log(`STABILITY: Found non-Kademlia peer ${peerInfo.peerId} for eviction (distance: ${peerInfo.distance})`);
          break;
        }
      }
      
      // If no non-Kademlia peer found, try furthest peer that's further than new peer
      if (!candidateForEviction) {
        for (const peerInfo of connectedPeersWithDistances) {
          if (peerInfo.distance > distanceToNewPeer) {
            candidateForEviction = peerInfo;
            console.log(`STABILITY: Found furthest peer ${peerInfo.peerId} for eviction (distance: ${peerInfo.distance})`);
            break;
          }
        }
      }
      
      // If still no candidate, check for stalled connections
      if (!candidateForEviction) {
        const stalledPeerId = this.findStalledConnection();
        if (stalledPeerId) {
          const stalledPeerInfo = connectedPeersWithDistances.find(p => p.peerId === stalledPeerId);
          if (stalledPeerInfo) {
            candidateForEviction = stalledPeerInfo;
            console.log(`STABILITY: Found stalled connection ${stalledPeerId} for eviction`);
          }
        }
      }
      
      if (candidateForEviction) {
        console.log(`STABILITY: Evicting peer ${candidateForEviction.peerId} (distance: ${candidateForEviction.distance}, inKademlia: ${candidateForEviction.inKademliaTable}) for closer peer ${newPeerId} (distance: ${distanceToNewPeer})`);
        
        // ENHANCED: Coordinate with transport for proper eviction
        this.forceDisconnectPeer(candidateForEviction.peerId, 'kademlia_optimization', {
          replacementPeer: newPeerId,
          distanceImprovement: candidateForEviction.distance - distanceToNewPeer
        });
        
        return true;
      }
      
      console.log(`STABILITY: New peer ${newPeerId} (distance: ${distanceToNewPeer}) not closer than any connected peer, no eviction`);
      return false;
      
    } catch (error) {
      console.error(`STABILITY: Error in evictForKademliaOptimization for ${newPeerId}:`, error);
      return false;
    }
  }

  /**
   * ENHANCED: Forces disconnection with transport coordination
   * @param {string} peerId - Peer ID to disconnect
   * @param {string} reason - Reason for disconnection
   * @param {Object} options - Additional options
   */
  forceDisconnectPeer(peerId, reason = 'forced_disconnect', options = {}) {
    const peer = this.peers.get(peerId);
    
    console.log(`STABILITY: Force disconnecting peer: ${peerId} (reason: ${reason})`);
    
    // ENHANCED: Coordinate with transport for proper eviction
    if (this.transportInstance && typeof this.transportInstance.evictPeer === 'function') {
      this.transportInstance.evictPeer(peerId, reason, {
        alternativePeers: this.getAlternativePeers(),
        ...options
      });
    }
    
    // Send reconnection data before disconnecting
    if (peer && peer.connected && !options.skipReconnectionData) {
      try {
        const alternativePeers = this.getAlternativePeers().filter(id => id !== peerId);
        if (alternativePeers.length > 0) {
          peer.send(JSON.stringify({
            type: 'reconnection_data',
            reason: reason,
            peers: alternativePeers,
            timestamp: Date.now()
          }));
          console.log(`STABILITY: Sent reconnection data to ${peerId} with ${alternativePeers.length} alternative peers`);
        }
      } catch (error) {
        console.warn(`STABILITY: Failed to send reconnection data to ${peerId}:`, error);
      }
    }
    
    // Destroy the peer connection
    if (peer) {
      try {
        peer.destroy();
      } catch (error) {
        console.warn(`STABILITY: Error destroying peer ${peerId}:`, error);
      }
    }
    
    // Clean up all tracking
    this.peers.delete(peerId);
    this.peerConnectionAttempts.delete(peerId);
    this.pendingConnections.delete(peerId);
    
    // Update Kademlia routing table
    if (this.kademlia && this.kademlia.routingTable) {
      this.kademlia.routingTable.removeContact(peerId);
    }
    
    console.log(`STABILITY: Force disconnection completed for ${peerId}`);
  }

  /**
   * Gets alternative peers for connection rejection messages
   * @returns {Array} Array of alternative peer IDs
   */
  getAlternativePeers() {
    const connectedPeers = [];
    this.peers.forEach((peer, peerId) => {
      if (peer.connected) {
        connectedPeers.push(peerId);
      }
    });
    
    // Return up to 3 alternative peers
    return connectedPeers.slice(0, 3);
  }

  /**
   * Get connectivity statistics
   */
  getConnectivityStats() {
    const connectedCount = this.getConnectedPeerCount();
    const pendingCount = this.pendingConnections.size;
    
    return {
      connected: connectedCount,
      pending: pendingCount,
      total: connectedCount + pendingCount,
      maxPeers: this.maxPeers,
      minPeers: this.minPeers,
      needsReconnection: this.needsReconnection(),
      lastDisconnectionTime: this.lastDisconnectionTime,
      stabilizedMode: true,
      reconnectionAttempts: this.reconnectionAttempts.size,
      peersInBackoff: Array.from(this.reconnectionBackoff.entries()).filter(([_, time]) => Date.now() < time).length
    };
  }

  /**
   * Cleanup method to clear intervals
   */
  destroy() {
    if (this.connectivityCheckInterval) {
      clearInterval(this.connectivityCheckInterval);
      this.connectivityCheckInterval = null;
    }
    
    // Clear backoff timers
    this.reconnectionAttempts.clear();
    this.reconnectionBackoff.clear();
  }

  /**
   * ENHANCED: Attempts to connect to a new peer with robust connection state validation
   */
  async connectToPeer(remotePeerId, initiator = true) {
    if (this.peers.has(remotePeerId) || this.pendingConnections.has(remotePeerId)) {
      console.log(`Already connected or connecting to ${remotePeerId}`);
      return;
    }

    // Coordinate with transport for proper connection tracking
    if (this.transportInstance && typeof this.transportInstance.startConnectionTimeout === 'function') {
      this.transportInstance.startConnectionTimeout(remotePeerId, {
        initiator,
        reason: 'peer_discovery'
      });
    }

    this.pendingConnections.add(remotePeerId);

    try {
      const Peer = await loadSimplePeer();
      // ENHANCED: Add comprehensive connection state tracking and timeout handling
      // FIXED: Changed trickle to false to prevent ICE candidate delays in WebTorrent environments
      const newPeer = new Peer({ 
        initiator, 
        trickle: false, // Set to false to batch ICE candidates for faster connections
        iceServers: this.iceServers,
        config: {
          iceTransportPolicy: 'all',
          bundlePolicy: 'balanced',
          rtcpMuxPolicy: 'require'
        }
      });
      
      // ENHANCED: Add comprehensive connection state validation and tracking
      newPeer._connectionState = 'connecting';
      newPeer._lastStateChange = Date.now();
      newPeer._peerId = remotePeerId; // Store peer ID for debugging
      newPeer._initiator = initiator;
      
      // Track connection attempt immediately
      this.peerConnectionAttempts.set(remotePeerId, Date.now());
      
      this.setupPeerEvents(newPeer, remotePeerId);
      this.peers.set(remotePeerId, newPeer);
      
      console.log(`ENHANCED: Initiated connection to ${remotePeerId} (initiator: ${initiator}) with comprehensive state tracking`);
      
      // ENHANCED: Add state change tracking
      const originalSignal = newPeer.signal;
      newPeer.signal = function(data) {
        newPeer._lastStateChange = Date.now();
        if (data.type === 'offer' || data.type === 'answer') {
          newPeer._connectionState = data.type === 'offer' ? 'offering' : 'answering';
          console.log(`STATE: Peer ${remotePeerId} state changed to ${newPeer._connectionState}`);
        }
        return originalSignal.call(this, data);
      };
      
    } catch (error) {
      console.error(`Failed to create peer connection to ${remotePeerId}:`, error);
      this.pendingConnections.delete(remotePeerId);
      this.peerConnectionAttempts.delete(remotePeerId);
      
      // Notify transport of connection failure
      if (this.transportInstance && typeof this.transportInstance.handlePeerConnectionFailed === 'function') {
        this.transportInstance.handlePeerConnectionFailed(remotePeerId, error.message);
      }
    }
  }
}
