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
   * STABILIZED: Check if we can reconnect to a peer (respects backoff)
   */
  canReconnectToPeer(peerId) {
    const attempts = this.reconnectionAttempts.get(peerId) || 0;
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
   * FIXED: Smart connection requests with eviction for better connectivity
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

    console.log(`Connection request from ${remotePeerId}: Connected=${connectedPeerCount}, Pending=${pendingPeerCount}, Total=${totalPeerCount}, Max=${this.maxPeers}`);

    // STABILIZED: Allow connections if we're under maxPeers
    if (totalPeerCount < this.maxPeers) {
      console.log(`STABILITY: Allowing connection to ${remotePeerId} (${totalPeerCount + 1}/${this.maxPeers})`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    // FIXED: Enable smart eviction for better connectivity even in small networks
    const evicted = this.evictForBetterConnectivity(remotePeerId);
    if (evicted) {
      console.log(`STABILITY: Evicted peer to make room for better connectivity with ${remotePeerId}`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    console.log(`STABILITY: Cannot connect to ${remotePeerId}: max peers (${this.maxPeers}) reached and no beneficial eviction available`);
    return false;
  }

  /**
   * Attempts to connect to a new peer
   */
  async connectToPeer(remotePeerId, initiator = true) {
    if (this.peers.has(remotePeerId) || this.pendingConnections.has(remotePeerId)) {
      console.log(`Already connected or connecting to ${remotePeerId}`);
      return;
    }

    this.pendingConnections.add(remotePeerId);

    try {
      const Peer = await loadSimplePeer();
      const newPeer = new Peer({ initiator, trickle: false, iceServers: this.iceServers });
      this.setupPeerEvents(newPeer, remotePeerId);
      this.peers.set(remotePeerId, newPeer);
      console.log(`Initiated connection to ${remotePeerId} (initiator: ${initiator})`);
    } catch (error) {
      console.error(`Failed to create peer connection to ${remotePeerId}:`, error);
      this.pendingConnections.delete(remotePeerId);
    }
  }

  /**
   * FIXED: Smart eviction for better connectivity (works for all network sizes)
   */
  evictForBetterConnectivity(newPeerId) {
    try {
      const connectedCount = this.getConnectedPeerCount();
      
      // Only evict if we're at maxPeers
      if (connectedCount < this.maxPeers) {
        console.log(`STABILITY: Not at maxPeers (${connectedCount}/${this.maxPeers}), no eviction needed`);
        return false;
      }
      
      // FIXED: Use distance-based eviction for all network sizes
      const distanceToNewPeer = calculateDistance(this.localPeerId, newPeerId);
      
      // Find the furthest connected peer
      let furthestPeerId = null;
      let furthestDistance = 0;
      
      this.peers.forEach((peer, peerId) => {
        if (peer.connected) {
          const distance = calculateDistance(this.localPeerId, peerId);
          if (distance > furthestDistance) {
            furthestDistance = distance;
            furthestPeerId = peerId;
          }
        }
      });
      
      // Only evict if the new peer is closer than the furthest peer
      if (furthestPeerId && distanceToNewPeer < furthestDistance) {
        console.log(`STABILITY: Evicting furthest peer ${furthestPeerId} (distance: ${furthestDistance}) for closer peer ${newPeerId} (distance: ${distanceToNewPeer})`);
        this.forceDisconnectPeer(furthestPeerId);
        return true;
      }
      
      // ENHANCED: Also check for stalled connections that can be replaced
      const stalledPeer = this.findStalledConnection();
      if (stalledPeer) {
        console.log(`STABILITY: Evicting stalled connection ${stalledPeer} for new peer ${newPeerId}`);
        this.forceDisconnectPeer(stalledPeer);
        return true;
      }
      
      console.log(`STABILITY: New peer ${newPeerId} (distance: ${distanceToNewPeer}) not closer than furthest peer ${furthestPeerId} (distance: ${furthestDistance}), no eviction`);
      return false;
      
    } catch (error) {
      console.error(`Error in evictForBetterConnectivity for ${newPeerId}:`, error);
      return false;
    }
  }

  /**
   * ENHANCED: Find a stalled connection that can be replaced
   */
  findStalledConnection() {
    const now = Date.now();
    const STALL_TIMEOUT = 30000; // 30 seconds
    
    for (const [peerId, peer] of this.peers) {
      // Check if peer is connecting but not connected for too long
      if (!peer.connected && peer.connecting) {
        const attemptTime = this.peerConnectionAttempts.get(peerId);
        if (attemptTime && (now - attemptTime) > STALL_TIMEOUT) {
          console.log(`STABILITY: Found stalled connection to ${peerId} (${now - attemptTime}ms)`);
          return peerId;
        }
      }
      
      // Check if peer is in a bad state
      if (peer.destroyed || peer.readyState === 'closed') {
        console.log(`STABILITY: Found dead connection to ${peerId} (destroyed: ${peer.destroyed}, state: ${peer.readyState})`);
        return peerId;
      }
    }
    
    return null;
  }

  /**
   * Legacy method for backward compatibility
   */
  evictFurthestPeer(newPeerId) {
    return this.evictForBetterConnectivity(newPeerId);
  }

  /**
   * Forces disconnection of a peer
   */
  forceDisconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      console.log(`Force disconnecting peer: ${peerId}`);
      peer.destroy();
    }
    
    this.peers.delete(peerId);
    this.peerConnectionAttempts.delete(peerId);
    this.pendingConnections.delete(peerId);
    this.kademlia.routingTable.removeContact(peerId);
    
    // STABILIZED: No immediate reconnection after forced disconnection
    console.log('Forced disconnection completed, relying on periodic check for reconnection');
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
}
