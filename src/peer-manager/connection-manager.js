// src/peer-manager/connection-manager.js
import { loadSimplePeer } from '../utils/simple-peer-loader.js';
import { calculateDistance } from '../kademlia.js';

/**
 * Manages peer connection lifecycle, eviction, and connection limits
 */
export class ConnectionManager {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.maxPeers = options.maxPeers || 5;
    this.minPeers = Math.max(1, Math.floor(this.maxPeers / 2)); // Ensure minimum connectivity
    this.iceServers = options.iceServers;
    this.kademlia = options.kademlia;
    this.transportInstance = options.transportInstance;
    this.eventHandlers = options.eventHandlers || {};
    
    this.peers = options.peers; // Reference to main peers Map
    this.peerConnectionAttempts = options.peerConnectionAttempts;
    this.pendingConnections = options.pendingConnections;
    this.setupPeerEvents = options.setupPeerEvents; // Callback to setup events
    
    // Track disconnection events to trigger reconnection
    this.lastDisconnectionTime = 0;
    this.reconnectionAttempts = new Map(); // peerId -> attempt count
    this.maxReconnectionAttempts = 3;
    
    console.log(`ConnectionManager initialized: maxPeers=${this.maxPeers}, minPeers=${this.minPeers}`);
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
    
    return totalCount < this.minPeers;
  }

  /**
   * Trigger reconnection when below minimum connectivity
   */
  async ensureMinimumConnectivity() {
    if (!this.needsReconnection()) return;
    
    const connectedCount = this.getConnectedPeerCount();
    const pendingCount = this.pendingConnections.size;
    const needed = this.minPeers - (connectedCount + pendingCount);
    
    console.log(`Below minimum connectivity: connected=${connectedCount}, pending=${pendingCount}, need=${needed} more`);
    
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
        (this.reconnectionAttempts.get(id) || 0) < this.maxReconnectionAttempts
      );
    
    if (availablePeers.length === 0) {
      console.log('No available peers for reconnection');
      return;
    }
    
    // Sort by distance (closer peers first)
    availablePeers.sort((a, b) => {
      try {
        const distA = calculateDistance(this.localPeerId, a);
        const distB = calculateDistance(this.localPeerId, b);
        return distA < distB ? -1 : distA > distB ? 1 : 0;
      } catch (error) {
        return 0; // Keep original order if distance calculation fails
      }
    });
    
    // Connect to the closest available peers
    const peersToConnect = availablePeers.slice(0, needed);
    console.log(`Attempting to reconnect to ${peersToConnect.length} peers:`, peersToConnect);
    
    for (const peerId of peersToConnect) {
      try {
        await this.connectToPeer(peerId, true);
        this.reconnectionAttempts.set(peerId, (this.reconnectionAttempts.get(peerId) || 0) + 1);
      } catch (error) {
        console.error(`Failed to reconnect to ${peerId}:`, error);
      }
    }
  }

  /**
   * Handle peer disconnection and trigger reconnection if needed
   */
  async onPeerDisconnected(peerId) {
    this.lastDisconnectionTime = Date.now();
    
    // Clean up tracking
    this.peers.delete(peerId);
    this.peerConnectionAttempts.delete(peerId);
    this.pendingConnections.delete(peerId);
    
    console.log(`Peer ${peerId} disconnected. Connected peers: ${this.getConnectedPeerCount()}`);
    
    // Check if we need to reconnect
    if (this.needsReconnection()) {
      console.log('Below minimum connectivity, triggering reconnection...');
      // Add a small delay to avoid rapid reconnection attempts
      setTimeout(() => this.ensureMinimumConnectivity(), 1000);
    }
  }

  /**
   * Requests a connection to a new peer with proper maxPeers management
   * @param {string} remotePeerId - Peer ID to connect to
   * @param {boolean} initiator - Whether this peer should initiate the connection
   * @returns {Promise<boolean>} True if connection was allowed, false otherwise
   */
  async requestConnection(remotePeerId, initiator = true) {
    // Check if already connected or connecting
    if (this.peers.has(remotePeerId) || this.pendingConnections.has(remotePeerId)) {
      console.log(`Already connected or connecting to ${remotePeerId}`);
      return false;
    }

    const connectedPeerCount = this.getConnectedPeerCount();
    const pendingPeerCount = this.pendingConnections.size;
    const totalPeerCount = connectedPeerCount + pendingPeerCount;

    console.log(`Connection request from ${remotePeerId}: Connected=${connectedPeerCount}, Pending=${pendingPeerCount}, Total=${totalPeerCount}, Max=${this.maxPeers}`);

    // If we're under the limit, allow the connection
    if (totalPeerCount < this.maxPeers) {
      console.log(`Allowing connection to ${remotePeerId} (${totalPeerCount + 1}/${this.maxPeers})`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    // If at limit, try eviction strategy (but ensure we don't go below minimum)
    const evicted = this.evictFurthestPeer(remotePeerId);
    if (evicted) {
      console.log(`Evicted furthest peer to make room for ${remotePeerId}`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    // If eviction failed, check if we can replace a stalled connection
    const stalledPeer = this.findStalledConnection();
    if (stalledPeer) {
      console.log(`Replacing stalled connection ${stalledPeer} with ${remotePeerId}`);
      this.forceDisconnectPeer(stalledPeer);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    console.log(`Cannot connect to ${remotePeerId}: max peers (${this.maxPeers}) reached and no eviction possible`);
    return false;
  }

  /**
   * Attempts to connect to a new peer
   * @param {string} remotePeerId - Peer ID to connect to
   * @param {boolean} initiator - Whether this peer should initiate the connection
   */
  async connectToPeer(remotePeerId, initiator = true) {
    if (this.peers.has(remotePeerId) || this.pendingConnections.has(remotePeerId)) {
      console.log(`Already connected or connecting to ${remotePeerId}`);
      return;
    }

    // Mark as pending to prevent race conditions
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
   * Evicts the furthest peer to make room for a closer one
   * @param {string} newPeerId - ID of the new peer to connect to
   * @returns {boolean} True if eviction occurred, false otherwise
   */
  evictFurthestPeer(newPeerId) {
    try {
      const connectedCount = this.getConnectedPeerCount();
      
      // Don't evict if we're at or below minimum connectivity
      if (connectedCount <= this.minPeers) {
        console.log(`Cannot evict: at minimum connectivity (${connectedCount}/${this.minPeers})`);
        return false;
      }
      
      const distanceToNewPeer = calculateDistance(this.localPeerId, newPeerId);
      
      // First try to find the furthest peer from Kademlia routing table (fully connected peers)
      const furthestPeerContact = this.kademlia.routingTable.getFurthestContact();
      
      if (furthestPeerContact) {
        const distanceToFurthestPeer = calculateDistance(this.localPeerId, furthestPeerContact.id);

        if (distanceToNewPeer < distanceToFurthestPeer) {
          console.log(`Kademlia eviction: New peer ${newPeerId} (dist: ${distanceToNewPeer}) is closer than furthest connected peer ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer})`);
          
          const furthestPeerConnection = this.peers.get(furthestPeerContact.id);
          if (furthestPeerConnection) {
            this.sendReconnectionData(furthestPeerConnection, furthestPeerContact.id, 'evicted_for_closer_peer');
            this.forceDisconnectPeer(furthestPeerContact.id);
            return true;
          }
        }
      }
      
      // If no Kademlia contacts or new peer isn't closer, try evicting from all current peers
      let furthestPeerId = null;
      let maxDistance = -1n;
      
      // Check all current peers (connected only, not pending)
      for (const [peerId, peer] of this.peers.entries()) {
        if (peerId !== newPeerId && peer.connected) {
          try {
            const distance = calculateDistance(this.localPeerId, peerId);
            if (distance > maxDistance) {
              maxDistance = distance;
              furthestPeerId = peerId;
            }
          } catch (error) {
            console.warn(`Error calculating distance to peer ${peerId}:`, error);
            // If we can't calculate distance, consider this peer for eviction
            furthestPeerId = peerId;
            maxDistance = BigInt(Number.MAX_SAFE_INTEGER);
          }
        }
      }
      
      // If the new peer is closer than the furthest current peer, evict the furthest
      if (furthestPeerId && (distanceToNewPeer < maxDistance || maxDistance === BigInt(Number.MAX_SAFE_INTEGER))) {
        console.log(`Distance-based eviction: New peer ${newPeerId} (dist: ${distanceToNewPeer}) replacing furthest peer ${furthestPeerId} (dist: ${maxDistance})`);
        
        const furthestPeerConnection = this.peers.get(furthestPeerId);
        if (furthestPeerConnection) {
          this.sendReconnectionData(furthestPeerConnection, furthestPeerId, 'evicted_for_closer_peer');
        }
        
        this.forceDisconnectPeer(furthestPeerId);
        return true;
      }
      
      console.log(`No eviction: new peer ${newPeerId} (dist: ${distanceToNewPeer}) is not closer than existing peers`);
      return false;
      
    } catch (error) {
      console.error(`Error in evictFurthestPeer for ${newPeerId}:`, error);
      
      // Fallback: only evict if we're above minimum connectivity
      const connectedCount = this.getConnectedPeerCount();
      if (connectedCount > this.minPeers) {
        const peerIds = Array.from(this.peers.keys()).filter(id => this.peers.get(id).connected);
        if (peerIds.length > 0) {
          const peerToEvict = peerIds[0];
          console.log(`Fallback eviction: removing ${peerToEvict} due to error`);
          this.forceDisconnectPeer(peerToEvict);
          return true;
        }
      }
      
      return false;
    }
  }

  /**
   * Finds a stalled connection that can be replaced
   * @returns {string|null} Peer ID of stalled connection or null
   */
  findStalledConnection() {
    const now = Date.now();
    const STALL_THRESHOLD = 30000; // 30 seconds

    // Look for peers that have been connecting for too long
    for (const [peerId, timestamp] of this.peerConnectionAttempts.entries()) {
      if (now - timestamp > STALL_THRESHOLD) {
        const peer = this.peers.get(peerId);
        if (peer && !peer.connected) {
          return peerId;
        }
      }
    }

    // Look for peers that are not actually connected despite being in the peers map
    for (const [peerId, peer] of this.peers.entries()) {
      if (!peer.connected && !this.peerConnectionAttempts.has(peerId)) {
        return peerId;
      }
    }

    return null;
  }

  /**
   * Forces disconnection of a peer
   * @param {string} peerId - Peer ID to disconnect
   */
  forceDisconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      console.log(`Force disconnecting peer: ${peerId}`);
      peer.destroy();
    }
    
    // Clean up tracking
    this.peers.delete(peerId);
    this.peerConnectionAttempts.delete(peerId);
    this.pendingConnections.delete(peerId);
    this.kademlia.routingTable.removeContact(peerId);
    
    // Check if we need to reconnect after forced disconnection
    if (this.needsReconnection()) {
      console.log('Forced disconnection caused connectivity drop, scheduling reconnection...');
      setTimeout(() => this.ensureMinimumConnectivity(), 2000);
    }
  }

  /**
   * Sends reconnection data to a peer before evicting them
   * @param {Object} peerConnection - SimplePeer connection
   * @param {string} peerId - Peer ID being evicted
   * @param {string} reason - Reason for eviction
   */
  sendReconnectionData(peerConnection, peerId, reason) {
    // Check if the peer connection is still valid and connected
    if (!peerConnection || peerConnection.destroyed || !peerConnection.connected) {
      console.log(`Skipping reconnection data for ${peerId}: peer connection is not valid or connected`);
      return;
    }

    // Collect information about other peers for reconnection assistance
    const reconnectPeers = [];
    this.peers.forEach((peerConn, peerConnId) => {
      // Don't include the peer we're about to evict
      if (peerConnId !== peerId && peerConn && peerConn.connected) {
        reconnectPeers.push(peerConnId);
      }
    });
    
    // Send reconnection data to the evicted peer
    try {
      peerConnection.send(JSON.stringify({
        type: 'reconnection_data',
        peers: reconnectPeers,
        reason: reason
      }));
      console.log(`Sent reconnection data to evicted peer ${peerId} with ${reconnectPeers.length} alternative peers`);
    } catch (error) {
      console.error(`Failed to send reconnection data to evicted peer ${peerId}:`, error);
    }
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
      lastDisconnectionTime: this.lastDisconnectionTime
    };
  }
}
