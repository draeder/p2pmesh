// src/transports/transport-interface.js

/**
 * Base Transport Layer Interface
 * Defines the interface for transport mechanisms used for signaling and peer initiation.
 * 
 * Transport implementations should emit the following standard events:
 * - 'signal': When a WebRTC signal is received from another peer
 * - 'connect_request': When another peer requests a connection
 * - 'peer_joined': When a new peer joins the network
 * - 'peer_left': When a peer leaves the network
 * - 'peer_evicted': When a peer is evicted during rebalancing
 * - 'connection_timeout': When a connection attempt times out
 * - 'connection_failed': When a connection attempt fails
 * - 'connection_state_changed': When connection state changes
 * - 'error': When an error occurs
 * - 'ack': When an acknowledgment is received
 * - 'bootstrap_peers': When a list of bootstrap peers is received
 * - 'open': When the transport connection is opened
 * - 'close': When the transport connection is closed
 */
export class InitiateTransport {
  constructor(options = {}) {
    if (this.constructor === InitiateTransport) {
      throw new Error("InitiateTransport classes can't be instantiated directly.");
    }
    this.eventListeners = new Map();
    this.connectionTimeouts = new Map();
    this.pendingConnections = new Set();
    this.connectionStates = new Map();
    this.connectionTimeout = options.connectionTimeout || 15000;
    this.cleanupInterval = options.cleanupInterval || 60000;
    this.cleanupTimer = null;
    this.evictionInProgress = new Set();
    this.lastCleanupTime = 0;
    this._multiTransportId = null;
    this._isMultiTransport = false;
    
    // Explicitly prevent any AWS-related configurations
    this._transportType = options.transportType || 'base';
    this._preventAwsImports = true;
  }

  /**
   * Connects the transport layer.
   * @param {string} localPeerId - The ID of the local peer.
   * @returns {Promise<void>}
   */
  async connect(localPeerId) {
    this.startCleanupTimer();
    throw new Error('Method "connect()" must be implemented.');
  }

  /**
   * Disconnects the transport layer.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.stopCleanupTimer();
    this.clearAllConnectionTimeouts();
    
    // Clean up all state
    this.connectionStates.clear();
    this.evictionInProgress.clear();
    
    throw new Error('Method "disconnect()" must be implemented.');
  }

  /**
   * Sends a message/signal to a specific peer.
   * @param {string} toPeerId - The ID of the recipient peer.
   * @param {object} message - The message/signal to send.
   * @returns {void}
   */
  send(toPeerId, message) {
    throw new Error('Method "send()" must be implemented.');
  }

  /**
   * Registers an event handler.
   * @param {string} eventName - The name of the event (e.g., 'signal', 'connect_request').
   * @param {Function} handler - The callback function to handle the event.
   */
  on(eventName, handler) {
    if (!this.eventListeners.has(eventName)) {
      this.eventListeners.set(eventName, []);
    }
    this.eventListeners.get(eventName).push(handler);
  }

  /**
   * Emits an event to all registered listeners.
   * @param {string} eventName - The name of the event.
   * @param {object} data - The data to pass to the event handlers.
   */
  emit(eventName, data) {
    if (this.eventListeners.has(eventName)) {
      this.eventListeners.get(eventName).forEach(handler => handler(data));
    }
  }

  /**
   * Gets the address information for a peer.
   * @param {string} peerId - The ID of the peer.
   * @returns {string|object} The address information for the peer.
   */
  getPeerAddress(peerId) {
    throw new Error('Method "getPeerAddress()" must be implemented.');
  }
  
  /**
   * Method to discover peers, e.g., via bootstrap servers.
   * This method's signature and behavior can vary greatly depending on the transport.
   * @param {Array<string>} bootstrapUrls - URLs or identifiers for discovery points.
   */
  discoverPeers(bootstrapUrls) {
    console.warn('discoverPeers() not implemented by this transport');
  }

  /**
   * Starts tracking a connection attempt with timeout and state management.
   * @param {string} peerId - The ID of the peer being connected to.
   * @param {Object} options - Connection options
   */
  startConnectionTimeout(peerId, options = {}) {
    this.clearConnectionTimeout(peerId);
    this.pendingConnections.add(peerId);
    
    // Track detailed connection state
    this.connectionStates.set(peerId, {
      state: 'connecting',
      startTime: Date.now(),
      lastStateChange: Date.now(),
      attempts: (this.connectionStates.get(peerId)?.attempts || 0) + 1,
      initiator: options.initiator || false,
      reason: options.reason || 'new_connection'
    });
    
    const timeoutId = setTimeout(() => {
      this.handleConnectionTimeout(peerId);
    }, this.connectionTimeout);
    
    this.connectionTimeouts.set(peerId, timeoutId);
    this.emit('connection_state_changed', { peerId, state: 'connecting', timestamp: Date.now() });
  }

  /**
   * Handles connection timeout with proper cleanup and eviction detection.
   * @param {string} peerId - The ID of the peer that timed out.
   */
  handleConnectionTimeout(peerId) {
    const connectionState = this.connectionStates.get(peerId);
    const isEvictionInProgress = this.evictionInProgress.has(peerId);
    
    console.log(`TRANSPORT: Connection timeout for ${peerId} (eviction in progress: ${isEvictionInProgress})`);
    
    if (isEvictionInProgress) {
      // Don't emit timeout during eviction, just clean up
      this.clearConnectionTimeout(peerId);
      this.emit('connection_state_changed', { peerId, state: 'evicted', timestamp: Date.now() });
      return;
    }
    
    // Update connection state
    if (connectionState) {
      connectionState.state = 'timeout';
      connectionState.lastStateChange = Date.now();
    }
    
    this.emit('connection_timeout', { 
      peerId, 
      duration: connectionState ? Date.now() - connectionState.startTime : this.connectionTimeout,
      attempts: connectionState?.attempts || 1,
      reason: 'timeout'
    });
    
    this.clearConnectionTimeout(peerId);
    this.emit('connection_state_changed', { peerId, state: 'timeout', timestamp: Date.now() });
  }

  /**
   * Clears the connection timeout for a peer with proper state management.
   * @param {string} peerId - The ID of the peer.
   * @param {string} newState - The new connection state.
   */
  clearConnectionTimeout(peerId, newState = 'cleared') {
    if (this.connectionTimeouts.has(peerId)) {
      clearTimeout(this.connectionTimeouts.get(peerId));
      this.connectionTimeouts.delete(peerId);
    }
    
    this.pendingConnections.delete(peerId);
    
    // Update connection state
    const connectionState = this.connectionStates.get(peerId);
    if (connectionState && newState !== 'cleared') {
      connectionState.state = newState;
      connectionState.lastStateChange = Date.now();
      this.emit('connection_state_changed', { peerId, state: newState, timestamp: Date.now() });
    } else if (newState === 'cleared') {
      this.connectionStates.delete(peerId);
    }
  }

  /**
   * Evicts a peer and cleans up any pending connections with proper coordination.
   * @param {string} peerId - The ID of the peer to evict.
   * @param {string} reason - The reason for eviction.
   * @param {Object} options - Eviction options.
   */
  evictPeer(peerId, reason = 'unknown', options = {}) {
    console.log(`TRANSPORT: Evicting peer ${peerId} (reason: ${reason})`);
    
    // Mark eviction in progress to prevent race conditions
    this.evictionInProgress.add(peerId);
    
    // Clear any pending timeouts and connections
    this.clearConnectionTimeout(peerId, 'evicting');
    
    // Update connection state
    const connectionState = this.connectionStates.get(peerId);
    if (connectionState) {
      connectionState.state = 'evicting';
      connectionState.lastStateChange = Date.now();
      connectionState.evictionReason = reason;
    }
    
    // Emit eviction event
    this.emit('peer_evicted', { 
      peerId, 
      reason, 
      timestamp: Date.now(),
      connectionDuration: connectionState ? Date.now() - connectionState.startTime : 0,
      alternativePeers: options.alternativePeers || []
    });
    
    // Schedule cleanup of eviction tracking
    setTimeout(() => {
      this.evictionInProgress.delete(peerId);
      this.connectionStates.delete(peerId);
      this.emit('connection_state_changed', { peerId, state: 'evicted', timestamp: Date.now() });
    }, 1000); // Give time for other components to react
  }

  /**
   * Starts the automatic cleanup timer.
   */
  startCleanupTimer() {
    if (this.cleanupTimer) return;
    
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.cleanupInterval);
  }

  /**
   * Stops the automatic cleanup timer.
   */
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Performs cleanup of stale connections and timeouts with race condition prevention.
   */
  performCleanup() {
    const now = Date.now();
    
    // Prevent too frequent cleanup
    if (now - this.lastCleanupTime < 5000) {
      return;
    }
    this.lastCleanupTime = now;
    
    console.log(`TRANSPORT: Starting cleanup - ${this.pendingConnections.size} pending, ${this.connectionTimeouts.size} timeouts, ${this.evictionInProgress.size} evictions`);
    
    // Clean up stale connection states
    const staleStates = [];
    for (const [peerId, state] of this.connectionStates) {
      const age = now - state.startTime;
      const timeSinceStateChange = now - state.lastStateChange;
      
      // Consider state stale if it's very old or hasn't changed in a long time
      if (age > this.connectionTimeout * 2 || 
          (timeSinceStateChange > this.connectionTimeout && state.state === 'connecting')) {
        staleStates.push(peerId);
      }
    }
    
    // Clean up stale states
    for (const peerId of staleStates) {
      const state = this.connectionStates.get(peerId);
      console.log(`TRANSPORT: Cleaning up stale connection state for ${peerId} (state: ${state.state}, age: ${now - state.startTime}ms)`);
      
      if (!this.evictionInProgress.has(peerId)) {
        this.evictPeer(peerId, 'stale_connection');
      }
    }
    
    // Clean up orphaned evictions
    const stalledEvictions = [];
    for (const peerId of this.evictionInProgress) {
      const state = this.connectionStates.get(peerId);
      if (!state || now - state.lastStateChange > 10000) { // 10 seconds
        stalledEvictions.push(peerId);
      }
    }
    
    for (const peerId of stalledEvictions) {
      console.log(`TRANSPORT: Cleaning up stalled eviction for ${peerId}`);
      this.evictionInProgress.delete(peerId);
      this.connectionStates.delete(peerId);
    }
    
    console.log(`TRANSPORT: Cleanup completed - cleaned ${staleStates.length} stale states, ${stalledEvictions.length} stalled evictions`);
  }

  /**
   * Checks if a peer is currently being evicted.
   * @param {string} peerId - The ID of the peer.
   * @returns {boolean} True if the peer is being evicted.
   */
  isPeerBeingEvicted(peerId) {
    return this.evictionInProgress.has(peerId);
  }

  /**
   * Gets the connection state for a peer.
   * @param {string} peerId - The ID of the peer.
   * @returns {Object|null} The connection state or null if not found.
   */
  getConnectionState(peerId) {
    return this.connectionStates.get(peerId) || null;
  }

  /**
   * Gets all peers currently in connecting state.
   * @returns {Array<string>} Array of peer IDs that are connecting.
   */
  getConnectingPeers() {
    return Array.from(this.pendingConnections);
  }

  /**
   * Validates connection state consistency.
   * @returns {Object} Validation results.
   */
  validateConnectionStates() {
    const validation = {
      inconsistencies: [],
      orphanedTimeouts: [],
      orphanedStates: [],
      evictionConflicts: []
    };
    
    // Check for orphaned timeouts
    for (const peerId of this.connectionTimeouts.keys()) {
      if (!this.pendingConnections.has(peerId)) {
        validation.orphanedTimeouts.push(peerId);
      }
    }
    
    // Check for orphaned states
    for (const [peerId, state] of this.connectionStates) {
      if (state.state === 'connecting' && !this.pendingConnections.has(peerId)) {
        validation.orphanedStates.push(peerId);
      }
      
      // Check for eviction conflicts
      if (this.evictionInProgress.has(peerId) && state.state === 'connecting') {
        validation.evictionConflicts.push(peerId);
      }
    }
    
    return validation;
  }

  /**
   * Clears all connection timeouts.
   */
  clearAllConnectionTimeouts() {
    for (const [peerId, timeoutId] of this.connectionTimeouts) {
      clearTimeout(timeoutId);
    }
    this.connectionTimeouts.clear();
    this.pendingConnections.clear();
  }

  /**
   * Sets the multi-transport ID for this transport instance.
   * @param {string} id - The multi-transport identifier.
   */
  setMultiTransportId(id) {
    this._multiTransportId = id;
    this._isMultiTransport = true;
  }

  /**
   * Gets the multi-transport ID for this transport instance.
   * @returns {string|null} The multi-transport identifier or null if not set.
   */
  getMultiTransportId() {
    return this._multiTransportId;
  }

  /**
   * Checks if this transport is part of a multi-transport setup.
   * @returns {boolean} True if this is a multi-transport instance.
   */
  isMultiTransport() {
    return this._isMultiTransport;
  }

  /**
   * Gets the transport type to prevent unwanted imports.
   * @returns {string} The transport type.
   */
  getTransportType() {
    return this._transportType;
  }

  /**
   * Validates that this transport doesn't trigger AWS imports.
   * @returns {boolean} True if safe from AWS imports.
   */
  isAwsImportSafe() {
    return this._preventAwsImports && this._transportType !== 'aws-websocket';
  }

  /**
   * Static method to safely set multi-transport ID on any transport instance.
   * @param {Object} transport - The transport instance.
   * @param {string} id - The multi-transport identifier.
   * @returns {boolean} True if successfully set, false otherwise.
   */
  static safeSetMultiTransportId(transport, id) {
    if (transport && typeof transport.setMultiTransportId === 'function') {
      transport.setMultiTransportId(id);
      return true;
    } else if (transport) {
      // Fallback: manually set properties for older transport implementations
      transport._multiTransportId = id;
      transport._isMultiTransport = true;
      console.warn(`Transport ${transport.constructor.name} doesn't implement setMultiTransportId, using fallback`);
      return true;
    }
    return false;
  }

  /**
   * Static method to safely get multi-transport ID from any transport instance.
   * @param {Object} transport - The transport instance.
   * @returns {string|null} The multi-transport identifier or null.
   */
  static safeGetMultiTransportId(transport) {
    if (transport && typeof transport.getMultiTransportId === 'function') {
      return transport.getMultiTransportId();
    } else if (transport && transport._multiTransportId) {
      return transport._multiTransportId;
    }
    return null;
  }

  /**
   * Static method to check if a transport is multi-transport compatible.
   * @param {Object} transport - The transport instance.
   * @returns {boolean} True if the transport supports multi-transport mode.
   */
  static isMultiTransportCompatible(transport) {
    return transport && (
      typeof transport.setMultiTransportId === 'function' ||
      transport._multiTransportId !== undefined
    );
  }
}