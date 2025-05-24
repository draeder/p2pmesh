// src/gossip/chord-overlay.js

/**
 * Chord-like overlay network to ensure full connectivity for gossip protocol
 * This creates a structured overlay on top of the sparse WebRTC mesh
 */
export class ChordOverlay {
  constructor({ localPeerId, dht, sendFunction, maxDirectConnections = 5 }) {
    this.localPeerId = localPeerId;
    this.dht = dht;
    this.sendFunction = sendFunction;
    this.maxDirectConnections = maxDirectConnections;
    
    // Chord-like finger table for efficient routing
    this.fingerTable = new Map();
    this.successors = new Set(); // Multiple successors for redundancy
    this.predecessors = new Set(); // Multiple predecessors for redundancy
    this.allKnownPeers = new Set(); // All peers we know about
    
    // Update intervals
    this.lastFingerTableUpdate = 0;
    this.fingerTableUpdateInterval = 30000; // 30 seconds
    this.lastSuccessorUpdate = 0;
    this.successorUpdateInterval = 15000; // 15 seconds
    
    console.log(`ChordOverlay: Initialized for peer ${localPeerId}`);
  }

  /**
   * Update the chord overlay with current network state
   */
  updateOverlay() {
    const now = Date.now();
    
    // Get all known peers from Kademlia DHT
    this.updateKnownPeers();
    
    // Update finger table periodically
    if (now - this.lastFingerTableUpdate > this.fingerTableUpdateInterval) {
      this.updateFingerTable();
      this.lastFingerTableUpdate = now;
    }
    
    // Update successors/predecessors more frequently
    if (now - this.lastSuccessorUpdate > this.successorUpdateInterval) {
      this.updateSuccessorsAndPredecessors();
      this.lastSuccessorUpdate = now;
    }
  }

  /**
   * Get all known peers from Kademlia DHT
   */
  updateKnownPeers() {
    this.allKnownPeers.clear();
    
    if (this.dht && this.dht.routingTable) {
      // Get all contacts from all buckets
      const allContacts = this.dht.routingTable.getAllContacts
        ? this.dht.routingTable.getAllContacts()
        : this.dht.routingTable.buckets.flat();
      
      for (const contact of allContacts) {
        if (contact.id && contact.id !== this.localPeerId) {
          this.allKnownPeers.add(contact.id);
        }
      }
    }
    
    console.log(`ChordOverlay: Updated known peers - ${this.allKnownPeers.size} total peers known`);
  }

  /**
   * Update finger table for efficient routing (Chord-like)
   */
  updateFingerTable() {
    this.fingerTable.clear();
    
    const allPeers = Array.from(this.allKnownPeers).sort();
    if (allPeers.length === 0) return;
    
    // Create finger table entries for different distances
    const distances = [1, 2, 4, 8, 16, 32, 64, 128]; // Powers of 2
    
    for (const distance of distances) {
      const targetIndex = (allPeers.indexOf(this.localPeerId) + distance) % allPeers.length;
      if (targetIndex >= 0 && targetIndex < allPeers.length) {
        const fingerPeer = allPeers[targetIndex];
        if (fingerPeer !== this.localPeerId) {
          this.fingerTable.set(distance, fingerPeer);
        }
      }
    }
    
    console.log(`ChordOverlay: Updated finger table with ${this.fingerTable.size} entries`);
  }

  /**
   * Update successors and predecessors for redundancy
   */
  updateSuccessorsAndPredecessors() {
    this.successors.clear();
    this.predecessors.clear();
    
    const allPeers = Array.from(this.allKnownPeers).sort();
    if (allPeers.length === 0) return;
    
    const myIndex = allPeers.indexOf(this.localPeerId);
    if (myIndex === -1) return;
    
    // Add multiple successors (next 3 peers in ring)
    for (let i = 1; i <= 3 && i < allPeers.length; i++) {
      const successorIndex = (myIndex + i) % allPeers.length;
      const successor = allPeers[successorIndex];
      if (successor !== this.localPeerId) {
        this.successors.add(successor);
      }
    }
    
    // Add multiple predecessors (previous 3 peers in ring)
    for (let i = 1; i <= 3 && i < allPeers.length; i++) {
      const predecessorIndex = (myIndex - i + allPeers.length) % allPeers.length;
      const predecessor = allPeers[predecessorIndex];
      if (predecessor !== this.localPeerId) {
        this.predecessors.add(predecessor);
      }
    }
    
    console.log(`ChordOverlay: Updated ${this.successors.size} successors and ${this.predecessors.size} predecessors`);
  }

  /**
   * Get all peers that should receive a gossip message for maximum coverage
   */
  getGossipTargets(excludePeers = new Set()) {
    this.updateOverlay();
    
    const targets = new Set();
    
    // 1. Add all finger table entries (for efficient routing)
    for (const fingerPeer of this.fingerTable.values()) {
      if (!excludePeers.has(fingerPeer)) {
        targets.add(fingerPeer);
      }
    }
    
    // 2. Add all successors (for ring connectivity)
    for (const successor of this.successors) {
      if (!excludePeers.has(successor)) {
        targets.add(successor);
      }
    }
    
    // 3. Add all predecessors (for reverse ring connectivity)
    for (const predecessor of this.predecessors) {
      if (!excludePeers.has(predecessor)) {
        targets.add(predecessor);
      }
    }
    
    // 4. Add random peers for additional redundancy (epidemic-style)
    const remainingPeers = Array.from(this.allKnownPeers).filter(peer => 
      !targets.has(peer) && !excludePeers.has(peer)
    );
    
    // Add up to 5 random additional peers
    const randomCount = Math.min(5, remainingPeers.length);
    for (let i = 0; i < randomCount; i++) {
      const randomIndex = Math.floor(Math.random() * remainingPeers.length);
      const randomPeer = remainingPeers.splice(randomIndex, 1)[0];
      targets.add(randomPeer);
    }
    
    // 5. If we still don't have enough targets, add more peers
    const minTargets = Math.min(10, this.allKnownPeers.size);
    if (targets.size < minTargets) {
      for (const peer of remainingPeers) {
        if (targets.size >= minTargets) break;
        targets.add(peer);
      }
    }
    
    const targetArray = Array.from(targets);
    console.log(`ChordOverlay: Selected ${targetArray.length} gossip targets from ${this.allKnownPeers.size} known peers`);
    console.log(`ChordOverlay: Targets: ${targetArray.join(', ')}`);
    
    return targetArray;
  }

  /**
   * Get routing path to a specific peer (for directed messages)
   */
  getRoutingPath(targetPeerId, maxHops = 5) {
    if (this.allKnownPeers.has(targetPeerId)) {
      // Direct route available
      return [targetPeerId];
    }
    
    // Use finger table to find best next hop
    const allPeers = Array.from(this.allKnownPeers).sort();
    const targetIndex = allPeers.indexOf(targetPeerId);
    const myIndex = allPeers.indexOf(this.localPeerId);
    
    if (targetIndex === -1 || myIndex === -1) {
      // Fallback to any available peer
      return Array.from(this.allKnownPeers).slice(0, 3);
    }
    
    // Find closest finger table entry to target
    let bestNextHop = null;
    let bestDistance = Infinity;
    
    for (const fingerPeer of this.fingerTable.values()) {
      const fingerIndex = allPeers.indexOf(fingerPeer);
      if (fingerIndex !== -1) {
        const distance = Math.abs(fingerIndex - targetIndex);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestNextHop = fingerPeer;
        }
      }
    }
    
    return bestNextHop ? [bestNextHop] : Array.from(this.successors).slice(0, 2);
  }

  /**
   * Get network statistics
   */
  getNetworkStats() {
    return {
      totalKnownPeers: this.allKnownPeers.size,
      fingerTableSize: this.fingerTable.size,
      successorCount: this.successors.size,
      predecessorCount: this.predecessors.size,
      allKnownPeers: Array.from(this.allKnownPeers),
      fingerTable: Object.fromEntries(this.fingerTable),
      successors: Array.from(this.successors),
      predecessors: Array.from(this.predecessors)
    };
  }

  /**
   * Force update of overlay (for testing/debugging)
   */
  forceUpdate() {
    this.lastFingerTableUpdate = 0;
    this.lastSuccessorUpdate = 0;
    this.updateOverlay();
  }
}
