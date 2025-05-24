// src/signaling-optimizer.js

/**
 * Signaling Optimizer - Minimizes signaling server usage by preferring mesh-based signaling
 * 
 * Flow:
 * 1. New peer connects via signaling server
 * 2. Once connected to existing peers, subsequent signaling uses the mesh
 * 3. Signals for new peers are batched and sent via signaling server
 * 4. Fallback to signaling server when mesh signaling fails
 */
export class SignalingOptimizer {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.transportInstance = options.transportInstance;
    this.peerManager = options.peerManager;
    
    // Track signaling state for each peer
    this.peerSignalingState = new Map(); // peerId -> { state: 'connecting'|'connected', lastSignal: timestamp }
    
    // Batch signals for new peers
    this.pendingSignalBatch = new Map(); // peerId -> [signals]
    this.batchTimeout = null;
    this.BATCH_DELAY = 100; // ms to wait before sending batched signals
    this.MAX_BATCH_SIZE = 10; // Maximum signals per batch
    
    // Mesh signaling statistics
    this.stats = {
      meshSignals: 0,
      serverSignals: 0,
      batchedSignals: 0,
      failedMeshSignals: 0
    };
    
    // Bind methods
    this.optimizeSignaling = this.optimizeSignaling.bind(this);
    this.sendBatchedSignals = this.sendBatchedSignals.bind(this);
  }

  /**
   * Optimizes signaling by choosing the best path (mesh vs server)
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @param {Object} options - Signaling options
   * @returns {Promise<boolean>} True if signaling was handled, false if fallback needed
   */
  async optimizeSignaling(toPeerId, signalData, options = {}) {
    const peerState = this.peerSignalingState.get(toPeerId);
    const isNewPeer = !peerState || peerState.state === 'connecting';
    const forceServer = options.forceServer || false;
    
    // Update peer state
    this.updatePeerState(toPeerId, signalData);
    
    // For new peers or when forced, use signaling server (potentially batched)
    if (isNewPeer || forceServer) {
      return this.handleNewPeerSignaling(toPeerId, signalData);
    }
    
    // For established peers, try mesh-first signaling
    return this.handleEstablishedPeerSignaling(toPeerId, signalData);
  }

  /**
   * Handles signaling for new peers (not yet connected)
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @returns {Promise<boolean>} True if handled
   */
  async handleNewPeerSignaling(toPeerId, signalData) {
    // Check if we should batch this signal
    if (this.shouldBatchSignal(toPeerId, signalData)) {
      this.addToBatch(toPeerId, signalData);
      return true;
    }
    
    // Send immediately via signaling server
    return this.sendViaSignalingServer(toPeerId, signalData);
  }

  /**
   * Handles signaling for established peers (already connected)
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @returns {Promise<boolean>} True if handled
   */
  async handleEstablishedPeerSignaling(toPeerId, signalData) {
    // Try mesh signaling first
    const meshSuccess = await this.sendViaMesh(toPeerId, signalData);
    
    if (meshSuccess) {
      this.stats.meshSignals++;
      console.log(`SignalingOptimizer: Successfully sent signal to ${toPeerId} via mesh`);
      return true;
    }
    
    // Fallback to signaling server
    this.stats.failedMeshSignals++;
    console.log(`SignalingOptimizer: Mesh signaling failed for ${toPeerId}, falling back to server`);
    return this.sendViaSignalingServer(toPeerId, signalData);
  }

  /**
   * Sends signal via mesh (through connected peers)
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @returns {Promise<boolean>} True if sent successfully
   */
  async sendViaMesh(toPeerId, signalData) {
    const connectedPeers = this.getConnectedPeers();
    
    if (connectedPeers.length === 0) {
      return false;
    }
    
    // Try to find the best relay peer (closest to target or most reliable)
    const relayPeer = this.selectBestRelayPeer(toPeerId, connectedPeers);
    
    if (!relayPeer) {
      return false;
    }
    
    try {
      // Send signal through the selected relay peer
      const relayMessage = {
        type: 'optimized_relay_signal',
        from: this.localPeerId,
        to: toPeerId,
        signal: signalData,
        timestamp: Date.now(),
        relayPath: [this.localPeerId]
      };
      
      relayPeer.send(JSON.stringify(relayMessage));
      
      // Wait briefly to see if relay succeeds (optional optimization)
      return await this.waitForRelayConfirmation(toPeerId, 500); // 500ms timeout
      
    } catch (error) {
      console.error(`SignalingOptimizer: Error sending via mesh to ${toPeerId}:`, error);
      return false;
    }
  }

  /**
   * Sends signal via signaling server
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @returns {Promise<boolean>} True if sent successfully
   */
  async sendViaSignalingServer(toPeerId, signalData) {
    try {
      this.transportInstance.send(toPeerId, {
        type: 'signal',
        from: this.localPeerId,
        signal: signalData
      });
      
      this.stats.serverSignals++;
      console.log(`SignalingOptimizer: Sent signal to ${toPeerId} via signaling server`);
      return true;
      
    } catch (error) {
      console.error(`SignalingOptimizer: Error sending via signaling server to ${toPeerId}:`, error);
      return false;
    }
  }

  /**
   * Determines if a signal should be batched
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @returns {boolean} True if should be batched
   */
  shouldBatchSignal(toPeerId, signalData) {
    // Don't batch critical signals that need immediate delivery
    const criticalSignalTypes = ['answer', 'offer'];
    if (signalData.type && criticalSignalTypes.includes(signalData.type)) {
      return false;
    }
    
    // Don't batch if we already have too many pending signals for this peer
    const existingBatch = this.pendingSignalBatch.get(toPeerId);
    if (existingBatch && existingBatch.length >= this.MAX_BATCH_SIZE) {
      return false;
    }
    
    // Batch ICE candidates and other non-critical signals
    return true;
  }

  /**
   * Adds a signal to the batch
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   */
  addToBatch(toPeerId, signalData) {
    if (!this.pendingSignalBatch.has(toPeerId)) {
      this.pendingSignalBatch.set(toPeerId, []);
    }
    
    this.pendingSignalBatch.get(toPeerId).push({
      signal: signalData,
      timestamp: Date.now()
    });
    
    // Schedule batch sending if not already scheduled
    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(this.sendBatchedSignals, this.BATCH_DELAY);
    }
    
    console.log(`SignalingOptimizer: Added signal to batch for ${toPeerId} (batch size: ${this.pendingSignalBatch.get(toPeerId).length})`);
  }

  /**
   * Sends all batched signals
   */
  async sendBatchedSignals() {
    this.batchTimeout = null;
    
    if (this.pendingSignalBatch.size === 0) {
      return;
    }
    
    console.log(`SignalingOptimizer: Sending batched signals for ${this.pendingSignalBatch.size} peers`);
    
    // Send batched signals for each peer
    for (const [toPeerId, signals] of this.pendingSignalBatch.entries()) {
      try {
        // Send as a batch message
        this.transportInstance.send(toPeerId, {
          type: 'batched_signals',
          from: this.localPeerId,
          signals: signals.map(s => s.signal),
          batchTimestamp: Date.now()
        });
        
        this.stats.batchedSignals += signals.length;
        console.log(`SignalingOptimizer: Sent batch of ${signals.length} signals to ${toPeerId}`);
        
      } catch (error) {
        console.error(`SignalingOptimizer: Error sending batched signals to ${toPeerId}:`, error);
        
        // Fallback: send signals individually
        for (const signalItem of signals) {
          try {
            await this.sendViaSignalingServer(toPeerId, signalItem.signal);
          } catch (fallbackError) {
            console.error(`SignalingOptimizer: Fallback signaling also failed for ${toPeerId}:`, fallbackError);
          }
        }
      }
    }
    
    // Clear the batch
    this.pendingSignalBatch.clear();
  }

  /**
   * Updates peer signaling state
   * @param {string} peerId - Peer ID
   * @param {Object} signalData - Signal data (used to infer state)
   */
  updatePeerState(peerId, signalData) {
    const currentState = this.peerSignalingState.get(peerId);
    const now = Date.now();
    
    // Determine new state based on signal type
    let newState = 'connecting';
    if (signalData.type === 'answer' || (currentState && currentState.state === 'connected')) {
      newState = 'connected';
    }
    
    this.peerSignalingState.set(peerId, {
      state: newState,
      lastSignal: now
    });
  }

  /**
   * Gets list of connected peers that can be used for relaying
   * @returns {Array} Array of connected peer objects
   */
  getConnectedPeers() {
    const connectedPeers = [];
    const peers = this.peerManager.getPeers();
    
    peers.forEach((peer, peerId) => {
      if (peer.connected) {
        connectedPeers.push({ id: peerId, peer });
      }
    });
    
    return connectedPeers;
  }

  /**
   * Selects the best peer for relaying signals
   * @param {string} toPeerId - Target peer ID
   * @param {Array} connectedPeers - Available connected peers
   * @returns {Object|null} Best relay peer or null
   */
  selectBestRelayPeer(toPeerId, connectedPeers) {
    if (connectedPeers.length === 0) {
      return null;
    }
    
    // For now, use simple selection (first available peer)
    // Could be enhanced with distance calculation, reliability metrics, etc.
    return connectedPeers[0].peer;
  }

  /**
   * Waits for relay confirmation (optional optimization)
   * @param {string} toPeerId - Target peer ID
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<boolean>} True if confirmed
   */
  async waitForRelayConfirmation(toPeerId, timeout) {
    // For now, assume success (could be enhanced with actual confirmation tracking)
    return new Promise(resolve => {
      setTimeout(() => resolve(true), Math.min(timeout, 100));
    });
  }

  /**
   * Handles incoming optimized relay signals
   * @param {Object} message - Relay message
   * @param {string} fromPeerId - Peer that sent the relay
   */
  handleOptimizedRelaySignal(message, fromPeerId) {
    if (message.to === this.localPeerId) {
      // Signal is for us
      console.log(`SignalingOptimizer: Received optimized relay signal from ${message.from} via ${fromPeerId}`);
      
      // Process the signal
      if (this.onSignalReceived) {
        this.onSignalReceived(message.from, message.signal);
      }
      
      // Send confirmation back (optional)
      this.sendRelayConfirmation(fromPeerId, message.from);
      
    } else {
      // Relay further if possible
      this.relaySignalFurther(message, fromPeerId);
    }
  }

  /**
   * Sends relay confirmation
   * @param {string} relayPeerId - Peer that relayed the signal
   * @param {string} originalSender - Original sender of the signal
   */
  sendRelayConfirmation(relayPeerId, originalSender) {
    try {
      const peer = this.peerManager.getPeers().get(relayPeerId);
      if (peer && peer.connected) {
        peer.send(JSON.stringify({
          type: 'optimized_relay_confirmation',
          from: this.localPeerId,
          originalSender: originalSender,
          timestamp: Date.now()
        }));
      }
    } catch (error) {
      console.error(`SignalingOptimizer: Error sending relay confirmation:`, error);
    }
  }

  /**
   * Relays signal further through the mesh
   * @param {Object} message - Original relay message
   * @param {string} fromPeerId - Peer that sent us the relay
   */
  relaySignalFurther(message, fromPeerId) {
    const targetPeer = this.peerManager.getPeers().get(message.to);
    
    if (targetPeer && targetPeer.connected) {
      try {
        // Add ourselves to relay path to prevent loops
        const updatedMessage = {
          ...message,
          relayPath: [...(message.relayPath || []), this.localPeerId]
        };
        
        targetPeer.send(JSON.stringify(updatedMessage));
        console.log(`SignalingOptimizer: Relayed signal from ${message.from} to ${message.to}`);
        
      } catch (error) {
        console.error(`SignalingOptimizer: Error relaying signal further:`, error);
      }
    } else {
      console.warn(`SignalingOptimizer: Cannot relay to ${message.to}: not connected`);
    }
  }

  /**
   * Handles peer connection events
   * @param {string} peerId - Peer ID that connected
   */
  onPeerConnected(peerId) {
    this.peerSignalingState.set(peerId, {
      state: 'connected',
      lastSignal: Date.now()
    });
    
    console.log(`SignalingOptimizer: Peer ${peerId} connected, enabling mesh signaling`);
  }

  /**
   * Handles peer disconnection events
   * @param {string} peerId - Peer ID that disconnected
   */
  onPeerDisconnected(peerId) {
    this.peerSignalingState.delete(peerId);
    
    // Remove any pending batched signals for this peer
    this.pendingSignalBatch.delete(peerId);
    
    console.log(`SignalingOptimizer: Peer ${peerId} disconnected, removed from signaling state`);
  }

  /**
   * Sets the signal received callback
   * @param {Function} callback - Callback function for received signals
   */
  setSignalReceivedCallback(callback) {
    this.onSignalReceived = callback;
  }

  /**
   * Gets signaling statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      ...this.stats,
      connectedPeers: this.getConnectedPeers().length,
      pendingBatches: this.pendingSignalBatch.size,
      trackedPeers: this.peerSignalingState.size
    };
  }

  /**
   * Resets statistics
   */
  resetStats() {
    this.stats = {
      meshSignals: 0,
      serverSignals: 0,
      batchedSignals: 0,
      failedMeshSignals: 0
    };
  }

  /**
   * Cleanup method
   */
  destroy() {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    
    this.peerSignalingState.clear();
    this.pendingSignalBatch.clear();
  }
}
