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
    this.iceServers = options.iceServers;
    this.kademlia = options.kademlia;
    this.transportInstance = options.transportInstance;
    this.eventHandlers = options.eventHandlers || {};
    
    this.peers = options.peers; // Reference to main peers Map
    this.peerConnectionAttempts = options.peerConnectionAttempts;
    this.pendingConnections = options.pendingConnections;
    this.setupPeerEvents = options.setupPeerEvents; // Callback to setup events
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

    // Count actual connected peers (not just peer objects)
    const connectedPeerCount = Array.from(this.peers.values()).filter(peer => peer.connected).length;
    const totalPeerCount = this.peers.size + this.pendingConnections.size;

    // If we're under the limit, allow the connection
    if (totalPeerCount < this.maxPeers) {
      console.log(`Allowing connection to ${remotePeerId} (${totalPeerCount + 1}/${this.maxPeers})`);
      await this.connectToPeer(remotePeerId, initiator);
      return true;
    }

    // If at limit, try eviction strategy
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
    const furthestPeerContact = this.kademlia.routingTable.getFurthestContact();
    if (!furthestPeerContact) {
      return false;
    }

    const distanceToNewPeer = calculateDistance(this.localPeerId, newPeerId);
    const distanceToFurthestPeer = calculateDistance(this.localPeerId, furthestPeerContact.id);

    if (distanceToNewPeer < distanceToFurthestPeer) {
      console.log(`New peer ${newPeerId} (dist: ${distanceToNewPeer}) is closer than furthest peer ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer}). Evicting furthest.`);
      
      const furthestPeerConnection = this.peers.get(furthestPeerContact.id);
      if (furthestPeerConnection) {
        this.sendReconnectionData(furthestPeerConnection, furthestPeerContact.id, 'evicted_for_closer_peer');
        
        // Short delay to allow the message to be sent before destroying the connection
        setTimeout(() => {
          furthestPeerConnection.destroy(); // This should trigger 'close' event and removal
        }, 100);
      }
      return true;
    }
    
    return false;
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
      console.log(`Force disconnecting stalled peer: ${peerId}`);
      peer.destroy();
    }
    
    // Clean up tracking
    this.peers.delete(peerId);
    this.peerConnectionAttempts.delete(peerId);
    this.pendingConnections.delete(peerId);
    this.kademlia.routingTable.removeContact(peerId);
  }

  /**
   * Sends reconnection data to a peer before evicting them
   * @param {Object} peerConnection - SimplePeer connection
   * @param {string} peerId - Peer ID being evicted
   * @param {string} reason - Reason for eviction
   */
  sendReconnectionData(peerConnection, peerId, reason) {
    // Collect information about other peers for reconnection assistance
    const reconnectPeers = [];
    this.peers.forEach((peerConn, peerConnId) => {
      // Don't include the peer we're about to evict
      if (peerConnId !== peerId) {
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
}
