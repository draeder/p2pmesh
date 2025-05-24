// src/peer-manager/relay-manager.js

/**
 * Manages signaling relay functionality through peers
 */
export class RelayManager {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.peers = options.peers; // Reference to main peers Map
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
}
