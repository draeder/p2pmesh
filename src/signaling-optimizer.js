// src/signaling-optimizer.js

/**
 * Signaling Optimizer - STABILIZED: Simplified signaling with reduced complexity
 * 
 * STABILIZED Flow:
 * 1. Use signaling server for all initial connections
 * 2. Minimal batching to reduce overhead
 * 3. Fallback to direct signaling when mesh fails
 * 4. Reduced complexity to prevent race conditions
 */
export class SignalingOptimizer {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.transportInstance = options.transportInstance;
    this.peerManager = options.peerManager;
    
    // STABILIZED: Simplified state tracking
    this.peerSignalingState = new Map(); // peerId -> { state: 'connecting'|'connected', lastSignal: timestamp }
    
    // STABILIZED: Reduced batching complexity
    this.pendingSignalBatch = new Map(); // peerId -> [signals]
    this.batchTimeout = null;
    this.BATCH_DELAY = 200; // Increased delay for stability
    this.MAX_BATCH_SIZE = 5; // Reduced batch size
    
    // STABILIZED: Simplified statistics
    this.stats = {
      serverSignals: 0,
      batchedSignals: 0,
      failedSignals: 0
    };
    
    console.log(`SignalingOptimizer initialized in STABILIZED mode for peer ${this.localPeerId}`);
  }

  /**
   * STABILIZED: Simplified signaling - prefer server for reliability
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @param {Object} options - Signaling options
   * @returns {Promise<boolean>} True if signaling was handled
   */
  async optimizeSignaling(toPeerId, signalData, options = {}) {
    const forceServer = options.forceServer || false;
    
    // Update peer state
    this.updatePeerState(toPeerId, signalData);
    
    // STABILIZED: Always use server signaling for reliability
    // This eliminates race conditions and complexity from mesh signaling
    if (forceServer || true) { // Always use server for now
      return this.handleServerSignaling(toPeerId, signalData);
    }
  }

  /**
   * STABILIZED: Handle signaling via server (primary method)
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @returns {Promise<boolean>} True if handled
   */
  async handleServerSignaling(toPeerId, signalData) {
    // STABILIZED: Minimal batching for non-critical signals only
    if (this.shouldBatchSignal(toPeerId, signalData)) {
      this.addToBatch(toPeerId, signalData);
      return true;
    }
    
    // Send immediately via signaling server
    return this.sendViaSignalingServer(toPeerId, signalData);
  }

  /**
   * STABILIZED: Send signal via signaling server (primary method)
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
      this.stats.failedSignals++;
      return false;
    }
  }

  /**
   * STABILIZED: Conservative signal batching
   * @param {string} toPeerId - Target peer ID
   * @param {Object} signalData - WebRTC signal data
   * @returns {boolean} True if should be batched
   */
  shouldBatchSignal(toPeerId, signalData) {
    // STABILIZED: Only batch ICE candidates, never critical signals
    if (!signalData.candidate) {
      return false; // Don't batch offers, answers, or other critical signals
    }
    
    // Don't batch if we already have too many pending signals for this peer
    const existingBatch = this.pendingSignalBatch.get(toPeerId);
    if (existingBatch && existingBatch.length >= this.MAX_BATCH_SIZE) {
      return false;
    }
    
    return true;
  }

  /**
   * STABILIZED: Add signal to batch with conservative limits
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
      this.batchTimeout = setTimeout(() => this.sendBatchedSignals(), this.BATCH_DELAY);
    }
    
    console.log(`SignalingOptimizer: Added ICE candidate to batch for ${toPeerId} (batch size: ${this.pendingSignalBatch.get(toPeerId).length})`);
  }

  /**
   * STABILIZED: Send batched signals with error handling
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
        console.log(`SignalingOptimizer: Sent batch of ${signals.length} ICE candidates to ${toPeerId}`);
        
      } catch (error) {
        console.error(`SignalingOptimizer: Error sending batched signals to ${toPeerId}:`, error);
        this.stats.failedSignals += signals.length;
        
        // STABILIZED: Fallback to individual signals
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
   * STABILIZED: Update peer signaling state
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
   * STABILIZED: Handle peer connection events
   * @param {string} peerId - Peer ID that connected
   */
  onPeerConnected(peerId) {
    this.peerSignalingState.set(peerId, {
      state: 'connected',
      lastSignal: Date.now()
    });
    
    console.log(`SignalingOptimizer: Peer ${peerId} connected`);
  }

  /**
   * STABILIZED: Handle peer disconnection events
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
   * STABILIZED: Get simplified statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      ...this.stats,
      pendingBatches: this.pendingSignalBatch.size,
      trackedPeers: this.peerSignalingState.size,
      stabilizedMode: true
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      serverSignals: 0,
      batchedSignals: 0,
      failedSignals: 0
    };
  }

  /**
   * STABILIZED: Cleanup method
   */
  destroy() {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    
    this.peerSignalingState.clear();
    this.pendingSignalBatch.clear();
    
    console.log(`SignalingOptimizer: Destroyed for peer ${this.localPeerId}`);
  }
}
