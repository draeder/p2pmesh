// src/peer-manager.js
import { loadSimplePeer } from './utils/simple-peer-loader.js';
import { calculateDistance } from './kademlia.js';

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
    this.CONNECTION_TIMEOUT = 15000; // 15 seconds timeout for stalled connections
    this.disconnectedPeers = new Set(); // Track disconnected peers to prevent duplicate events
    
    // Bind methods to preserve context
    this.setupPeerEvents = this.setupPeerEvents.bind(this);
    this.checkForConnectionTimeouts = this.checkForConnectionTimeouts.bind(this);
    this.relaySignalingData = this.relaySignalingData.bind(this);
  }

  /**
   * Sets up event handlers for a peer connection
   * @param {Object} peer - SimplePeer instance
   * @param {string} remotePeerId - Remote peer ID
   */
  setupPeerEvents(peer, remotePeerId) {
    // Track connection attempt start time
    this.peerConnectionAttempts.set(remotePeerId, Date.now());
    
    peer.on('signal', (data) => {
      console.log(`Preparing WebRTC signal to ${remotePeerId}`);
      
      // Attempt peer relay for all connections for resilience
      // Even if we have only 1 peer, it might be connected to our target
      if (this.peers.size > 0) {
        // Attempt to relay through existing peers
        // This function always returns false now, ensuring we use signaling server
        // but we still attempt relays to increase connection success probability
        this.relaySignalingData(remotePeerId, data);
      }
      
      // ALWAYS use the signaling server for reliable connections
      // Using multiple signal paths improves connection success rates
      console.log(`Sending WebRTC signal to ${remotePeerId} via signaling server`);
      this.transportInstance.send(remotePeerId, { type: 'signal', from: this.localPeerId, signal: data });
    });

    peer.on('connect', () => {
      console.log(`Connected (WebRTC) to peer: ${remotePeerId}`);
      // Connection established, clear connection attempt tracking
      this.peerConnectionAttempts.delete(remotePeerId);
      
      // Add to Kademlia routing table. 'address' would be transport-specific info if needed.
      // For simple-peer over a signaling server, the 'remotePeerId' is often enough.
      this.kademlia.routingTable.addContact({ 
        id: remotePeerId, 
        address: this.transportInstance.getPeerAddress ? this.transportInstance.getPeerAddress(remotePeerId) : remotePeerId 
      });
      
      // Reset the disconnected state when a peer connects/reconnects
      this.disconnectedPeers.delete(remotePeerId);
      
      if (this.eventHandlers['peer:connect']) {
        this.eventHandlers['peer:connect'](remotePeerId);
      }
    });

    peer.on('data', (data) => {
      this.handlePeerData(data, remotePeerId);
    });

    peer.on('close', () => {
      console.log(`Connection closed with peer: ${remotePeerId}`);
      this.peers.delete(remotePeerId);
      this.peerConnectionAttempts.delete(remotePeerId); // Clean up connection tracking
      this.kademlia.routingTable.removeContact(remotePeerId);
      
      // Only emit the event if the peer hasn't been marked as disconnected
      if (!this.disconnectedPeers.has(remotePeerId)) {
        this.disconnectedPeers.add(remotePeerId);
        if (this.eventHandlers['peer:disconnect']) {
          this.eventHandlers['peer:disconnect'](remotePeerId);
        }
      }
    });

    peer.on('error', (err) => {
      console.error(`Error with peer ${remotePeerId}:`, err);
      this.peers.delete(remotePeerId);
      this.peerConnectionAttempts.delete(remotePeerId); // Clean up connection tracking
      this.kademlia.routingTable.removeContact(remotePeerId);
      
      if (this.eventHandlers['peer:error']) {
        this.eventHandlers['peer:error']({peerId: remotePeerId, error: err});
      }
      
      // Only emit the event if the peer hasn't been marked as disconnected
      if (!this.disconnectedPeers.has(remotePeerId)) {
        this.disconnectedPeers.add(remotePeerId);
        if (this.eventHandlers['peer:disconnect']) {
          this.eventHandlers['peer:disconnect'](remotePeerId);
        }
      }
    });
  }

  /**
   * Handles incoming data from a peer
   * @param {Buffer|string} data - Raw data from peer
   * @param {string} remotePeerId - Peer ID that sent the data
   */
  handlePeerData(data, remotePeerId) {
    let parsedData;
    const dataString = data.toString();
    try {
      parsedData = JSON.parse(dataString);
    } catch (e) {
      // Log the error for better debugging instead of silently ignoring it
      console.error(`Error parsing JSON data from ${remotePeerId}:`, e);
      console.error(`Problematic data: ${dataString.substring(0, 100)}${dataString.length > 100 ? '...' : ''}`);
      
      // Emit as a generic 'message' event (as per previous behavior for non-JSON)
      if (this.eventHandlers['message']) {
        this.eventHandlers['message']({ from: remotePeerId, data: dataString });
      } else {
        console.log(`Received non-JSON data from ${remotePeerId} (no 'message' handler)`);
      }
      return; // Stop processing if not valid JSON for structured messages
    }

    // Handle relay_signal messages - relay WebRTC signaling data through peers
    if (parsedData && parsedData.type === 'relay_signal') {
      this.handleRelaySignal(parsedData, remotePeerId);
      return;
    }
    
    // Handle relay acknowledgments
    if (parsedData && parsedData.type === 'relay_ack') {
      const latency = parsedData.receivedTimestamp - parsedData.originalTimestamp;
      console.log(`Relay to ${parsedData.from} was acknowledged (latency: ${latency}ms)`);
      return; // Don't pass ack messages to application layer
    }
    
    // Handle relay failures
    if (parsedData && parsedData.type === 'relay_failure') {
      console.warn(`Relay to ${parsedData.targetPeer} failed: ${parsedData.reason}`);
      return; // Don't pass failure messages to application layer
    }

    if (parsedData && parsedData.type === 'reconnection_data') {
      this.handleReconnectionData(parsedData, remotePeerId);
    } else if (parsedData && parsedData.type === 'gossip') {
      // Forward to gossip protocol handler
      if (this.eventHandlers['gossip']) {
        this.eventHandlers['gossip'](parsedData, remotePeerId);
      }
    } else if (parsedData && parsedData.type === 'gossip_ack') {
      // Handle gossip acknowledgments internally but don't forward to application
      if (this.eventHandlers['gossip']) {
        this.eventHandlers['gossip'](parsedData, remotePeerId);
      }
    } else if (parsedData && parsedData.type === 'kademlia_rpc_response') {
      // Fallback for other structured messages if not Kademlia response or no handler
      if (this.eventHandlers['message']) {
        this.eventHandlers['message']({ from: remotePeerId, data: parsedData });
      }
    } else if (parsedData) {
      // Emit as a generic 'message' event if it's structured but not internal protocol messages
      if (this.eventHandlers['message']) {
        this.eventHandlers['message']({ from: remotePeerId, data: parsedData });
      }
    }
  }

  /**
   * Handles relay signal messages
   * @param {Object} parsedData - Parsed relay signal data
   * @param {string} remotePeerId - Peer that sent the relay
   */
  handleRelaySignal(parsedData, remotePeerId) {
    if (parsedData.to && parsedData.from && parsedData.signal) {
      // Add received timestamp for tracking relay timing
      const receivedTime = Date.now();
      const relayLatency = parsedData.timestamp ? (receivedTime - parsedData.timestamp) : 'unknown';
      
      if (parsedData.to === this.localPeerId) {
        // Signal is for us - process it directly and acknowledge receipt
        console.log(`Received relayed signal from ${parsedData.from} via peer ${remotePeerId} (latency: ${relayLatency}ms)`);
        
        // Process the signal data
        if (this.eventHandlers['signal']) {
          this.eventHandlers['signal']({ from: parsedData.from, signal: parsedData.signal });
        }
        
        // Send acknowledgment back to the sender
        try {
          const peer = this.peers.get(remotePeerId);
          if (peer) {
            peer.send(JSON.stringify({
              type: 'relay_ack',
              to: parsedData.from,
              from: this.localPeerId,
              originalTimestamp: parsedData.timestamp,
              receivedTimestamp: receivedTime
            }));
          }
        } catch (error) {
          console.error(`Failed to send relay acknowledgment to ${remotePeerId}:`, error);
        }
      } else {
        // Signal is for another peer - relay it further if we can
        console.log(`Relaying signal from ${parsedData.from} to ${parsedData.to}`);
        const targetPeer = this.peers.get(parsedData.to);
        if (targetPeer && targetPeer.connected) {
          try {
            // Preserve original timestamp for accurate latency measurement
            targetPeer.send(JSON.stringify({
              ...parsedData,
              relayPath: [...(parsedData.relayPath || []), this.localPeerId] // Track relay path
            }));
            console.log(`Successfully relayed signal to ${parsedData.to}`);
          } catch (error) {
            console.error(`Error relaying signal to ${parsedData.to}:`, error);
            this.sendRelayFailure(remotePeerId, parsedData.from, parsedData.to, error.message || 'Send error');
          }
        } else {
          console.warn(`Cannot relay signal to ${parsedData.to}: not connected`);
          this.sendRelayFailure(remotePeerId, parsedData.from, parsedData.to, 'Peer not connected');
        }
      }
    }
  }

  /**
   * Handles reconnection data messages
   * @param {Object} parsedData - Parsed reconnection data
   * @param {string} remotePeerId - Peer that sent the data
   */
  handleReconnectionData(parsedData, remotePeerId) {
    // Store reconnection data for later use if disconnected
    console.log(`Received reconnection data from ${remotePeerId} with ${parsedData.peers.length} alternative peers`);
    
    if (this.eventHandlers['reconnection_data']) {
      this.eventHandlers['reconnection_data'](parsedData, remotePeerId);
    }
    
    // Emit a special event that applications can listen for
    if (this.eventHandlers['peer:evicted']) {
      this.eventHandlers['peer:evicted']({ 
        reason: parsedData.reason, 
        alternativePeers: parsedData.peers 
      });
    }
  }

  /**
   * Sends a relay failure notification
   * @param {string} relayPeerId - Peer that attempted the relay
   * @param {string} originalSender - Original sender of the message
   * @param {string} targetPeer - Target peer that couldn't be reached
   * @param {string} reason - Reason for failure
   */
  sendRelayFailure(relayPeerId, originalSender, targetPeer, reason) {
    try {
      const peer = this.peers.get(relayPeerId);
      if (peer) {
        peer.send(JSON.stringify({
          type: 'relay_failure',
          to: originalSender,
          from: this.localPeerId,
          targetPeer: targetPeer,
          reason: reason
        }));
      }
    } catch (error) {
      console.error(`Failed to send relay failure notification:`, error);
    }
  }

  /**
   * Attempts to connect to a new peer
   * @param {string} remotePeerId - Peer ID to connect to
   * @param {boolean} initiator - Whether this peer should initiate the connection
   */
  async connectToPeer(remotePeerId, initiator = true) {
    if (this.peers.has(remotePeerId)) {
      console.log(`Already connected or connecting to ${remotePeerId}`);
      return;
    }

    if (this.peers.size >= this.maxPeers) {
      // Apply eviction strategy
      const evicted = this.evictFurthestPeer(remotePeerId);
      if (!evicted) {
        console.log(`Max peers reached, cannot connect to ${remotePeerId}`);
        return;
      }
    }

    const Peer = await loadSimplePeer();
    const newPeer = new Peer({ initiator, trickle: false, iceServers: this.iceServers });
    this.setupPeerEvents(newPeer, remotePeerId);
    this.peers.set(remotePeerId, newPeer);
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
   * Relay signaling data through peers instead of the signaling server
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signaling data
   * @returns {boolean} Always returns false to ensure signaling server fallback
   */
  relaySignalingData(toPeerId, signalData) {
    if (this.peers.size === 0) {
      console.warn('No connected peers to relay signaling data through');
      return false;
    }
    
    // Check if the target peer is directly connected to us
    // If it is, we don't need to relay and should return false to use signaling server
    if (this.peers.has(toPeerId) && this.peers.get(toPeerId).connected) {
      console.log(`Target peer ${toPeerId} is already directly connected. No relay needed.`);
      return false;
    }
    
    // Track if we've attempted to relay, not that it was successful
    let relayAttempted = false;
    
    // Try to relay through connected peers
    let potentialRelayPeers = [];
    this.peers.forEach((peer, peerId) => {
      if (peer.connected) {
        potentialRelayPeers.push(peerId);
      }
    });
    
    // Select up to 3 peers for relay to avoid overwhelming the network
    // but increase chances of successful relay
    if (potentialRelayPeers.length > 3) {
      potentialRelayPeers = potentialRelayPeers.slice(0, 3);
    }
    
    // Attempt relay through selected peers
    for (const peerId of potentialRelayPeers) {
      const peer = this.peers.get(peerId);
      if (peer && peer.connected) {
        try {
          console.log(`Attempting to relay signaling data to ${toPeerId} via peer ${peerId}`);
          peer.send(JSON.stringify({
            type: 'relay_signal',
            from: this.localPeerId,
            to: toPeerId,
            signal: signalData,
            timestamp: Date.now() // Add timestamp for tracking purposes
          }));
          relayAttempted = true;
        } catch (error) {
          console.error(`Failed to relay signal via peer ${peerId}:`, error);
        }
      }
    }
    
    // Just because we sent the relay doesn't mean it will succeed
    // Return false to ensure fallback to signaling server as a reliability measure
    console.log(`Relay attempts made: ${relayAttempted}. Recommending signaling server fallback for reliability.`);
    return false; // Always use signaling server to ensure connection reliability
  }

  /**
   * Check for peer connection timeouts and clean up stalled connections
   * @returns {boolean} True if any peers were timed out
   */
  checkForConnectionTimeouts() {
    const now = Date.now();
    let timedOutPeers = [];
    
    // Identify peers that have been in connecting state for too long
    this.peerConnectionAttempts.forEach((timestamp, peerId) => {
      const connectionDuration = now - timestamp;
      
      if (connectionDuration > this.CONNECTION_TIMEOUT) {
        console.log(`Connection to peer ${peerId} timed out after ${connectionDuration}ms`);
        timedOutPeers.push(peerId);
      }
    });
    
    // Clean up timed out peers
    timedOutPeers.forEach(peerId => {
      const peer = this.peers.get(peerId);
      if (peer) {
        console.log(`Destroying timed out peer connection to ${peerId}`);
        peer.destroy();
        this.peers.delete(peerId);
        this.peerConnectionAttempts.delete(peerId);
        this.kademlia.routingTable.removeContact(peerId);
        
        // Emit timeout event
        if (this.eventHandlers['peer:timeout']) {
          this.eventHandlers['peer:timeout'](peerId);
        }
        // Also emit disconnect event for UI consistency
        if (this.eventHandlers['peer:disconnect']) {
          this.eventHandlers['peer:disconnect'](peerId);
        }
      }
    });
    
    return timedOutPeers.length > 0;
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
    this.disconnectedPeers.clear();
  }

  /**
   * Gets the current peer connections
   * @returns {Map} Map of peer connections
   */
  getPeers() {
    return this.peers;
  }

  /**
   * Gets the number of connected peers
   * @returns {number} Number of connected peers
   */
  getPeerCount() {
    return this.peers.size;
  }
}
