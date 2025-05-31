// src/peer-manager.js
import { SignalingOptimizer } from './signaling-optimizer.js';
import { ConnectionManager } from './peer-manager/connection-manager.js';
import { DataHandler } from './peer-manager/data-handler.js';
import { EventManager } from './peer-manager/event-manager.js';
import { RelayManager } from './peer-manager/relay-manager.js';

/**
 * Manages WebRTC peer connections and their lifecycle
 */
export class PeerManager {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.maxPeers = options.maxPeers || 5;
    this.iceServers = options.iceServers;
    this.kademlia = options.kademlia;
    this.transportInstance = options.transportInstance;
    this.eventHandlers = options.eventHandlers || {};
    
    this.peers = new Map(); // Map of peerId to Peer instance (direct WebRTC connections)
    this.peerConnectionAttempts = new Map(); // Track connection attempt timestamps
    // FIXED: Shorter timeout for WebTorrent connections to prevent stuck states
    this.CONNECTION_TIMEOUT = 30000; // 30 seconds timeout for WebTorrent connections
    this.disconnectedPeers = new Set(); // Track disconnected peers to prevent duplicate events
    this.pendingConnections = new Set(); // Track peers currently attempting to connect
    
    // Initialize SignalingOptimizer
    this.signalingOptimizer = new SignalingOptimizer({
      localPeerId: this.localPeerId,
      transportInstance: this.transportInstance,
      peerManager: this
    });
    
    // Set up signaling optimizer callbacks
    this.signalingOptimizer.setSignalReceivedCallback((from, signal) => {
      if (this.eventHandlers['signal']) {
        this.eventHandlers['signal']({ from, signal });
      }
    });
    
    // Initialize modular components
    this.dataHandler = new DataHandler({
      localPeerId: this.localPeerId,
      eventHandlers: this.eventHandlers,
      peers: this.peers,
      signalingOptimizer: this.signalingOptimizer,
      pendingConnections: this.pendingConnections,
      peerConnectionAttempts: this.peerConnectionAttempts
    });
    
    // Initialize connection manager first
    this.connectionManager = new ConnectionManager({
      localPeerId: this.localPeerId,
      maxPeers: this.maxPeers,
      iceServers: this.iceServers,
      kademlia: this.kademlia,
      transportInstance: this.transportInstance,
      eventHandlers: this.eventHandlers,
      peers: this.peers,
      peerConnectionAttempts: this.peerConnectionAttempts,
      pendingConnections: this.pendingConnections,
      setupPeerEvents: null // Will be set after event manager is created
    });
    
    // Initialize event manager with connection manager reference
    this.eventManager = new EventManager({
      localPeerId: this.localPeerId,
      eventHandlers: this.eventHandlers,
      peers: this.peers,
      peerConnectionAttempts: this.peerConnectionAttempts,
      pendingConnections: this.pendingConnections,
      disconnectedPeers: this.disconnectedPeers,
      kademlia: this.kademlia,
      transportInstance: this.transportInstance,
      signalingOptimizer: this.signalingOptimizer,
      dataHandler: this.dataHandler,
      connectionManager: this.connectionManager, // Pass connection manager reference
      CONNECTION_TIMEOUT: this.CONNECTION_TIMEOUT
    });
    
    // Now set the setupPeerEvents callback in connection manager
    this.connectionManager.setupPeerEvents = this.eventManager.setupPeerEvents.bind(this.eventManager);
    
    this.relayManager = new RelayManager({
      localPeerId: this.localPeerId,
      peers: this.peers
    });
    
    // Bind methods to preserve context
    this.setupPeerEvents = this.eventManager.setupPeerEvents.bind(this.eventManager);
    this.checkForConnectionTimeouts = this.eventManager.checkForConnectionTimeouts.bind(this.eventManager);
    this.relaySignalingData = this.relayManager.relaySignalingData.bind(this.relayManager);
  }

  /**
   * Gets all connected peers
   * @returns {Map} Map of peer IDs to peer connections
   */
  getPeers() {
    return this.peers;
  }

  /**
   * Gets the count of connected peers
   * @returns {number} Number of connected peers
   */
  getPeerCount() {
    return Array.from(this.peers.values()).filter(peer => peer.connected).length;
  }

  /**
   * Gets the count of connected peers (alias for getPeerCount)
   * @returns {number} Number of connected peers
   */
  getConnectedPeerCount() {
    return this.getPeerCount();
  }

  /**
   * Gets an array of connected peer IDs
   * @returns {Array<string>} Array of connected peer IDs
   */
  getConnectedPeerIds() {
    const connectedPeers = [];
    this.peers.forEach((peer, peerId) => {
      if (peer.connected) {
        connectedPeers.push(peerId);
      }
    });
    return connectedPeers;
  }

  /**
   * Requests a connection to a new peer with proper maxPeers management
   * @param {string} remotePeerId - Peer ID to connect to
   * @param {boolean} initiator - Whether this peer should initiate the connection
   * @returns {Promise<boolean>} True if connection was allowed, false otherwise
   */
  async requestConnection(remotePeerId, initiator = true) {
    return await this.connectionManager.requestConnection(remotePeerId, initiator);
  }

  /**
   * Attempts to connect to a new peer
   * @param {string} remotePeerId - Peer ID to connect to
   * @param {boolean} initiator - Whether this peer should initiate the connection
   */
  async connectToPeer(remotePeerId, initiator = true) {
    return await this.connectionManager.connectToPeer(remotePeerId, initiator);
  }

  /**
   * Evicts the furthest peer to make room for a closer one
   * @param {string} newPeerId - ID of the new peer to connect to
   * @returns {boolean} True if eviction occurred, false otherwise
   */
  evictFurthestPeer(newPeerId) {
    return this.connectionManager.evictFurthestPeer(newPeerId);
  }

  /**
   * Finds a stalled connection that can be replaced
   * @returns {string|null} Peer ID of stalled connection or null
   */
  findStalledConnection() {
    return this.connectionManager.findStalledConnection();
  }

  /**
   * Forces disconnection of a peer
   * @param {string} peerId - Peer ID to disconnect
   */
  forceDisconnectPeer(peerId) {
    this.connectionManager.forceDisconnectPeer(peerId);
  }

  /**
   * Sends reconnection data to a peer before evicting them
   * @param {Object} peerConnection - SimplePeer connection
   * @param {string} peerId - Peer ID being evicted
   * @param {string} reason - Reason for eviction
   */
  sendReconnectionData(peerConnection, peerId, reason) {
    this.connectionManager.sendReconnectionData(peerConnection, peerId, reason);
  }

  /**
   * Gets alternative peers for connection rejection messages
   * @returns {Array} Array of alternative peer IDs
   */
  getAlternativePeers() {
    return this.connectionManager.getAlternativePeers();
  }

  /**
   * Get connectivity statistics from connection manager
   * @returns {Object} Connectivity statistics
   */
  getConnectivityStats() {
    return this.connectionManager.getConnectivityStats();
  }

  /**
   * Ensure minimum connectivity (public method to trigger reconnection)
   */
  async ensureMinimumConnectivity() {
    return await this.connectionManager.ensureMinimumConnectivity();
  }

  /**
   * Handles incoming data from a peer
   * @param {Buffer|string} data - Raw data from peer
   * @param {string} remotePeerId - Peer ID that sent the data
   */
  handlePeerData(data, remotePeerId) {
    this.dataHandler.handlePeerData(data, remotePeerId);
  }

  /**
   * Handles connection rejection messages
   * @param {Object} parsedData - Parsed connection rejection data
   * @param {string} remotePeerId - Peer that sent the rejection
   */
  handleConnectionRejection(parsedData, remotePeerId) {
    this.dataHandler.handleConnectionRejection(parsedData, remotePeerId);
  }

  /**
   * Handles relay signal messages
   * @param {Object} parsedData - Parsed relay signal data
   * @param {string} remotePeerId - Peer that sent the relay
   */
  handleRelaySignal(parsedData, remotePeerId) {
    this.dataHandler.handleRelaySignal(parsedData, remotePeerId);
  }

  /**
   * Handles reconnection data messages
   * @param {Object} parsedData - Parsed reconnection data
   * @param {string} remotePeerId - Peer that sent the data
   */
  handleReconnectionData(parsedData, remotePeerId) {
    this.dataHandler.handleReconnectionData(parsedData, remotePeerId);
  }

  /**
   * Sends a relay failure notification
   * @param {string} relayPeerId - Peer that attempted the relay
   * @param {string} originalSender - Original sender of the message
   * @param {string} targetPeer - Target peer that couldn't be reached
   * @param {string} reason - Reason for failure
   */
  sendRelayFailure(relayPeerId, originalSender, targetPeer, reason) {
    this.dataHandler.sendRelayFailure(relayPeerId, originalSender, targetPeer, reason);
  }

  /**
   * Sends a message to a specific peer
   * @param {string} peerId - Target peer ID
   * @param {any} payload - Message payload
   */
  sendToPeer(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (peer && peer.connected) {
      console.log(`Sending direct message to ${peerId}:`, payload);
      try {
        peer.send(JSON.stringify({ type: 'direct', payload }));
      } catch (error) {
        console.error(`Error sending direct message to ${peerId}:`, error);
      }
    } else {
      console.warn(`Cannot send message: Peer ${peerId} not found or not connected.`);
    }
  }

  /**
   * Sends raw data to a peer (used by gossip protocol)
   * @param {string} peerId - Target peer ID
   * @param {any} data - Raw data to send
   */
  sendRawToPeer(peerId, data) {
    const peerConnection = this.peers.get(peerId);
    if (peerConnection && peerConnection.connected) {
      try {
        // Gossip messages need to be stringified only once for sending
        // Check if data is already a string to prevent double serialization
        const dataToSend = typeof data === 'string' ? data : JSON.stringify(data);
        peerConnection.send(dataToSend);
      } catch (error) {
        console.error(`Error sending raw data to peer ${peerId}:`, error);
      }
    }
  }

  /**
   * Destroys all peer connections
   */
  destroy() {
    this.peers.forEach(peer => peer.destroy());
    this.peers.clear();
    this.peerConnectionAttempts.clear();
    this.pendingConnections.clear();
    this.disconnectedPeers.clear();
    
    // Clean up signaling optimizer
    if (this.signalingOptimizer && this.signalingOptimizer.destroy) {
      this.signalingOptimizer.destroy();
    }
  }
}
