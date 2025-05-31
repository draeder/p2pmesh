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
    // FIXED: Much shorter timeouts for WebTorrent to prevent stuck connections
    this.CONNECTION_TIMEOUT = options.CONNECTION_TIMEOUT || 30000; // 30 seconds for WebTorrent
    this.STALLED_CONNECTION_TIMEOUT = 15000; // 15 seconds to detect stalled connections
  }

  /**
   * ENHANCED: Sets up event handlers for a peer connection with comprehensive state tracking
   * @param {Object} peer - SimplePeer instance
   * @param {string} remotePeerId - Remote peer ID
   */
  setupPeerEvents(peer, remotePeerId) {
    // Track connection attempt start time if not already tracked
    if (!this.peerConnectionAttempts.has(remotePeerId)) {
      this.peerConnectionAttempts.set(remotePeerId, Date.now());
    }
    
    // ENHANCED: Add comprehensive connection state tracking
    peer._connectionState = peer._connectionState || 'connecting';
    peer._lastStateChange = peer._lastStateChange || Date.now();
    peer._signalQueue = [];
    peer._isProcessingSignal = false;
    peer._peerId = remotePeerId; // Store for debugging
    
    peer.on('signal', async (data) => {
      // Update state change timestamp
      peer._lastStateChange = Date.now();
      
      // Track signal types for better state management
      if (data.type === 'offer') {
        peer._connectionState = 'offering';
        console.log(`STATE: Peer ${remotePeerId} offering (state: ${peer._pc?.signalingState || 'unknown'})`);
      } else if (data.type === 'answer') {
        peer._connectionState = 'answering';
        console.log(`STATE: Peer ${remotePeerId} answering (state: ${peer._pc?.signalingState || 'unknown'})`);
      } else {
        console.log(`STATE: Peer ${remotePeerId} ICE candidate (state: ${peer._pc?.signalingState || 'unknown'})`);
      }
      
      // Only check if peer is destroyed - allow all other signals through
      if (peer.destroyed) {
        console.log(`Ignoring signal for destroyed peer ${remotePeerId}`);
        return;
      }
      
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
   * ENHANCED: Check for peer connection timeouts with comprehensive state validation
   * This fixes the race condition where peers get stuck in "Connecting..." state
   * @returns {boolean} True if any peers were timed out or cleaned up
   */
  checkForConnectionTimeouts() {
    const now = Date.now();
    let cleanedUpPeers = [];
    
    console.log(`TIMEOUT CHECK: Starting comprehensive timeout detection (${this.peerConnectionAttempts.size} tracked attempts, ${this.peers.size} peers in map)`);
    
    // PHASE 1: Check tracked connection attempts with enhanced state validation
    this.peerConnectionAttempts.forEach((timestamp, peerId) => {
      const connectionDuration = now - timestamp;
      const peer = this.peers.get(peerId);
      
      if (!peer) {
        // Peer is tracked but not in peers map - cleanup orphaned tracking
        console.log(`TIMEOUT: Cleaning up orphaned tracking for ${peerId} (no peer object)`);
        cleanedUpPeers.push({ peerId, reason: 'orphaned_tracking' });
        return;
      }
      
      // Check if peer is actually connected - if so, clean up tracking instead of timing out
      if (peer.connected && peer.readyState === 'open') {
        console.log(`TIMEOUT: Peer ${peerId} is connected - cleaning up tracking (was tracked for ${connectionDuration}ms)`);
        cleanedUpPeers.push({ peerId, reason: 'connected_cleanup' });
        return;
      }
      
      // Enhanced state validation before timeout decision
      const isDestroyed = peer.destroyed;
      const readyState = peer.readyState;
      const connectionState = peer._connectionState;
      const lastStateChange = peer._lastStateChange;
      
      console.log(`TIMEOUT: Evaluating ${peerId} - Duration: ${connectionDuration}ms, Destroyed: ${isDestroyed}, ReadyState: ${readyState}, ConnectionState: ${connectionState}, TimeSinceStateChange: ${lastStateChange ? now - lastStateChange : 'unknown'}ms`);
      
      // Don't timeout peers that are actually in a good state
      if (isDestroyed) {
        console.log(`TIMEOUT: Peer ${peerId} is destroyed but still tracked - cleaning up`);
        cleanedUpPeers.push({ peerId, reason: 'destroyed_cleanup' });
        return;
      }
      
      if (readyState === 'closed' || readyState === 'failed') {
        console.log(`TIMEOUT: Peer ${peerId} is in failed state (${readyState}) - cleaning up`);
        cleanedUpPeers.push({ peerId, reason: 'failed_state_cleanup' });
        return;
      }
      
      // FIXED: More aggressive timeout detection for stalled connections
      if (connectionDuration > this.CONNECTION_TIMEOUT) {
        // Additional checks for truly stalled connections
        const isStalled = (
          (!peer.connected && readyState === 'connecting') ||
          (connectionState === 'connecting' && lastStateChange && (now - lastStateChange) > this.STALLED_CONNECTION_TIMEOUT) ||
          readyState === 'new'
        );
        
        if (isStalled) {
          console.log(`TIMEOUT: Peer ${peerId} is genuinely stalled after ${connectionDuration}ms (readyState: ${readyState}, connectionState: ${connectionState})`);
          cleanedUpPeers.push({ peerId, reason: 'timeout_stalled' });
        } else {
          console.log(`TIMEOUT: Peer ${peerId} exceeded timeout but appears healthy - preserving (readyState: ${readyState}, connected: ${peer.connected})`);
        }
      } else if (connectionDuration > this.STALLED_CONNECTION_TIMEOUT) {
        // FIXED: Check for stalled connections even before full timeout
        const timeSinceStateChange = lastStateChange ? now - lastStateChange : connectionDuration;
        if (timeSinceStateChange > this.STALLED_CONNECTION_TIMEOUT && !peer.connected && readyState === 'connecting') {
          console.log(`TIMEOUT: Peer ${peerId} appears stalled (no state change for ${timeSinceStateChange}ms) - cleaning up`);
          cleanedUpPeers.push({ peerId, reason: 'stalled_before_timeout' });
        }
      }
    });
    
    // PHASE 2: Scan peers map for zombie peers (destroyed/closed but still in map)
    this.peers.forEach((peer, peerId) => {
      if (!this.peerConnectionAttempts.has(peerId)) {
        // Peer exists but isn't tracked - check if it needs cleanup
        if (peer.destroyed || peer.readyState === 'closed' || peer.readyState === 'failed') {
          console.log(`TIMEOUT: Found zombie peer ${peerId} (destroyed: ${peer.destroyed}, readyState: ${peer.readyState}) - cleaning up`);
          cleanedUpPeers.push({ peerId, reason: 'zombie_cleanup' });
        } else if (!peer.connected && peer.readyState === 'connecting') {
          // Untracked connection that's connecting - add to tracking or clean up if old
          const stateChangeTime = peer._lastStateChange || 0;
          const timeSinceStateChange = now - stateChangeTime;
          
          if (timeSinceStateChange > this.CONNECTION_TIMEOUT) {
            console.log(`TIMEOUT: Found untracked stalled connection ${peerId} (${timeSinceStateChange}ms since state change) - cleaning up`);
            cleanedUpPeers.push({ peerId, reason: 'untracked_stalled' });
          } else {
            console.log(`TIMEOUT: Found untracked connecting peer ${peerId} - adding to tracking`);
            this.peerConnectionAttempts.set(peerId, now - timeSinceStateChange);
          }
        }
      }
    });
    
    // PHASE 3: Execute cleanup for all identified peers
    cleanedUpPeers.forEach(({ peerId, reason }) => {
      const peer = this.peers.get(peerId);
      
      console.log(`TIMEOUT: Cleaning up peer ${peerId} (reason: ${reason})`);
      
      // Always clean up tracking data regardless of peer state
      this.peers.delete(peerId);
      this.peerConnectionAttempts.delete(peerId);
      this.pendingConnections.delete(peerId);
      
      // Destroy peer if it exists and isn't already destroyed
      if (peer && !peer.destroyed) {
        try {
          peer.destroy();
        } catch (error) {
          console.warn(`TIMEOUT: Error destroying peer ${peerId}:`, error);
        }
      }
      
      // Update Kademlia routing table
      if (this.kademlia && this.kademlia.routingTable) {
        if (reason.includes('timeout') || reason.includes('stalled')) {
          // Mark as failed for timeout/stalled cases
          if (this.kademlia.routingTable.markContactFailed) {
            this.kademlia.routingTable.markContactFailed(peerId);
          }
        }
        this.kademlia.routingTable.removeContact(peerId);
      }
      
      // Notify connection manager for reconnection logic
      if (this.connectionManager && this.connectionManager.onPeerDisconnected) {
        this.connectionManager.onPeerDisconnected(peerId);
      }
      
      // Emit appropriate events
      if (reason.includes('timeout')) {
        if (this.eventHandlers['peer:timeout']) {
          this.eventHandlers['peer:timeout'](peerId);
        }
      }
      
      if (this.eventHandlers['peer:disconnect']) {
        this.eventHandlers['peer:disconnect'](peerId);
      }
    });
    
    console.log(`TIMEOUT CHECK: Completed - cleaned up ${cleanedUpPeers.length} peers (${this.peers.size} remaining)`);
    
    return cleanedUpPeers.length > 0;
  }
}
