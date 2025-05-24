// src/gossip/message-router.js

/**
 * Handles message routing and peer selection for gossip protocol
 * SIMPLIFIED: No reachability filtering - send to ALL peers
 */
export class MessageRouter {
  constructor({ localPeerId, islandHealingManager }) {
    this.localPeerId = localPeerId;
    this.islandHealingManager = islandHealingManager;
    // REMOVED: reachabilityManager - no more filtering!
  }

  /**
   * SIMPLIFIED: Select ALL available peers for gossip relay
   */
  selectPeersForGossip(dht, topic, originPeerId, excluded = new Set()) {
    const buckets = dht.routingTable.buckets;
    if (!Array.isArray(buckets)) return [];
    
    const allIds = [...new Set(buckets.flat().map(c => c.id))];
    
    // SIMPLIFIED: Include ALL peers, no filtering whatsoever
    const allCandidates = allIds.filter(id =>
      id !== this.localPeerId &&
      id !== originPeerId &&
      !excluded.has(id)
    );
    
    console.log(`Gossip: Found ${allCandidates.length} total candidates - using ALL for maximum coverage`);
    
    if (allCandidates.length === 0) {
      console.log(`Gossip: No candidates available for gossip relay`);
      return [];
    }
    
    // SIMPLIFIED: Always return ALL candidates for maximum coverage
    console.log(`Gossip: Selecting ALL ${allCandidates.length} peers: ${allCandidates.join(', ')}`);
    return allCandidates;
  }

  /**
   * SIMPLIFIED: For broadcast, return ALL peers
   */
  getReachablePeersForBroadcast(dht) {
    // Get all contacts
    const allContacts = dht.routingTable.getAllContacts
      ? dht.routingTable.getAllContacts()
      : dht.routingTable.buckets.flat();
    
    // SIMPLIFIED: Include ALL peers
    const allPeers = allContacts
      .map(c => c.id)
      .filter(id => id !== this.localPeerId);
    
    console.log(`Gossip: Broadcasting to ALL ${allPeers.length} known peers`);
    
    // Also include bridge peers
    const bridgePeers = this.islandHealingManager.getBridgePeers();
    const bridgePeersToInclude = Array.from(bridgePeers).filter(id => 
      id !== this.localPeerId && !allPeers.includes(id)
    );
    
    if (bridgePeersToInclude.length > 0) {
      console.log(`Gossip: Also including ${bridgePeersToInclude.length} additional bridge peers`);
      allPeers.push(...bridgePeersToInclude);
    }

    console.log(`Gossip: Final broadcast targets: ${allPeers.length} peers: ${allPeers.join(', ')}`);
    return allPeers;
  }
}
