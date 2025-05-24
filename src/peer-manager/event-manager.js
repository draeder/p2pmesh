// src/peer-manager/event-manager.js

/**
 * Manages peer event setup and handling
 */
export class EventManager {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.eventHandlers = options.eventHandlers || {};
    this.peers = options.peers; // Reference to main peers Map
    this.peerConnectionAttempts = options.peerConnectionAttempts;
    this.pendingConnections = options.pendingConnections;
    this.disconnectedPeers = options.disconnectedPeers;
    this.kademlia = options.kademlia;
    this.transportInstance = options.transportInstance;
    this.signalingOptimizer = options.signalingOptimizer;
    this.dataHandler = options.dataHandler;
    this.connectionManager = options.connectionManager; // Reference to connection manager
    this.CONNECTION_TIMEOUT = options.CONNECTION_TIMEOUT || 15000;
  }

  /**
   * FIXED: Sets up event handlers for a peer connection with permissive signaling
   * @param {Object} peer - SimplePeer instance
   * @param {string} remotePeerId - Remote peer ID
   */
  setupPeerEvents(peer, remotePeerId) {
    // Track connection attempt start time
    this.peerConnectionAttempts.set(remotePeerId, Date.now());
    
    // FIXED: Add connection state tracking
    peer._connectionState = 'connecting';
    peer._lastStateChange = Date.now();
    peer._signalQueue = [];
    peer._isProcessingSignal = false;
    
    peer.on('signal', async (data) => {
      console.log(`Preparing WebRTC signal to ${remotePeerId} (type: ${data.type || 'candidate'}, state: ${peer._pc?.signalingState || 'unknown'})`);
      
      // Only check if peer is destroyed - allow all other signals through
      if (peer.destroyed) {
        console.log(`Ignoring signal for destroyed peer ${remotePeerId}`);
        return;
      }
      
      // FIXED: Removed restrictive signal validation that was preventing connections
      // Let SimplePeer handle signal validation internally
      
      // Use SignalingOptimizer to choose the best signaling path
      try {
        const handled = await this.signalingOptimizer.optimizeSignaling(remotePeerId, data);
        if (!handled) {
          // Fallback to direct signaling server if optimizer couldn't handle it
          console.log(`SignalingOptimizer fallback: sending signal to ${remotePeerId} via signaling server`);
          this.transportInstance.send(remotePeerId, { type: 'signal', from: this.localPeerId, signal: data });
        }
      } catch (error) {
        console.error(`SignalingOptimizer error for ${remotePeerId}:`, error);
        // Fallback to signaling server on error
        this.transportInstance.send(remotePeerId, { type: 'signal', from: this.localPeerId, signal: data });
      }
    });

    peer.on('connect', () => {
      console.log(`Connected (WebRTC) to peer: ${remotePeerId}`);
      
      // FIXED: Update connection state
      peer._connectionState = 'connected';
      peer._lastStateChange = Date.now();
      
      // Connection established, clear connection attempt tracking
      this.peerConnectionAttempts.delete(remotePeerId);
      this.pendingConnections.delete(remotePeerId);
      
      // Add to Kademlia routing table. 'address' would be transport-specific info if needed.
      // For simple-peer over a signaling server, the 'remotePeerId' is often enough.
      this.kademlia.routingTable.addContact({ 
        id: remotePeerId, 
        address: this.transportInstance.getPeerAddress ? this.transportInstance.getPeerAddress(remotePeerId) : remotePeerId 
      });
      
      // Reset the disconnected state when a peer connects/reconnects
      this.disconnectedPeers.delete(remotePeerId);
      
      // Notify SignalingOptimizer about peer connection
      this.signalingOptimizer.onPeerConnected(remotePeerId);
      
      if (this.eventHandlers['peer:connect']) {
        this.eventHandlers['peer:connect'](remotePeerId);
      }
    });

    peer.on('data', (data) => {
      this.dataHandler.handlePeerData(data, remotePeerId);
    });

    peer.on('close', () => {
      console.log(`Connection closed with peer: ${remotePeerId}`);
      
      // Notify connection manager about disconnection for reconnection logic
      if (this.connectionManager && this.connectionManager.onPeerDisconnected) {
        this.connectionManager.onPeerDisconnected(remotePeerId);
      } else {
        // Fallback cleanup if connection manager not available
        this.peers.delete(remotePeerId);
        this.peerConnectionAttempts.delete(remotePeerId);
        this.pendingConnections.delete(remotePeerId);
      }
      
      this.kademlia.routingTable.removeContact(remotePeerId);
      
      // Notify SignalingOptimizer about peer disconnection
      this.signalingOptimizer.onPeerDisconnected(remotePeerId);
      
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
      
      // FIXED: Mark contact as failed in Kademlia for better routing decisions
      if (this.kademlia && this.kademlia.routingTable && this.kademlia.routingTable.markContactFailed) {
        this.kademlia.routingTable.markContactFailed(remotePeerId);
      }
      
      // Notify connection manager about disconnection for reconnection logic
      if (this.connectionManager && this.connectionManager.onPeerDisconnected) {
        this.connectionManager.onPeerDisconnected(remotePeerId);
      } else {
        // Fallback cleanup if connection manager not available
        this.peers.delete(remotePeerId);
        this.peerConnectionAttempts.delete(remotePeerId);
        this.pendingConnections.delete(remotePeerId);
      }
      
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
        
        // FIXED: Mark contact as failed in Kademlia
        if (this.kademlia && this.kademlia.routingTable && this.kademlia.routingTable.markContactFailed) {
          this.kademlia.routingTable.markContactFailed(peerId);
        }
        
        // Notify connection manager about timeout for reconnection logic
        if (this.connectionManager && this.connectionManager.onPeerDisconnected) {
          this.connectionManager.onPeerDisconnected(peerId);
        } else {
          // Fallback cleanup if connection manager not available
          this.peers.delete(peerId);
          this.peerConnectionAttempts.delete(peerId);
          this.pendingConnections.delete(peerId);
        }
        
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
}
