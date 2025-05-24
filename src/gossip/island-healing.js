// src/gossip/island-healing.js

/**
 * SIMPLIFIED: Island healing without peer reachability filtering
 * Focuses on bridge peer identification and connectivity probing
 */
export class IslandHealingManager {
  constructor({ localPeerId, sendFunction, createMessage, reachabilityManager }) {
    this.localPeerId = localPeerId;
    this.sendFunction = sendFunction;
    this.createMessage = createMessage;
    // REMOVED: reachabilityManager dependency
    
    this.bridgePeers = new Set(); // Peers that can reach multiple islands
    this.lastBridgeIdentification = 0;
    this.bridgeIdentificationInterval = 60000; // Check for bridge peers every minute
  }

  /**
   * SIMPLIFIED: Basic island detection without reachability filtering
   */
  detectAndHealIslands(seenMessages, dht) {
    const now = Date.now();
    
    // Always try to identify bridge peers
    if (now - this.lastBridgeIdentification > this.bridgeIdentificationInterval) {
      this.identifyBridgePeers(seenMessages, dht);
      this.lastBridgeIdentification = now;
    }
    
    console.log(`Gossip: Island detection - ${this.bridgePeers.size} bridge peers identified`);
  }

  /**
   * SIMPLIFIED: Bridge peer identification based on message relay patterns
   */
  identifyBridgePeers(seenMessages, dht) {
    const now = Date.now();
    const recentWindow = 180000; // 3 minutes
    
    // Add all currently connected peers as potential bridge peers
    if (dht) {
      const allContacts = dht.routingTable.getAllContacts
        ? dht.routingTable.getAllContacts()
        : dht.routingTable.buckets.flat() || [];
      
      for (const contact of allContacts) {
        if (contact.id === this.localPeerId) continue;
        
        // Any peer in the routing table is a potential bridge
        if (!this.bridgePeers.has(contact.id)) {
          this.bridgePeers.add(contact.id);
          console.log(`Gossip: Added ${contact.id} as bridge peer (in routing table)`);
        }
      }
    }
    
    // Look through recent messages to find active relay peers
    if (seenMessages) {
      for (const [messageId, message] of seenMessages) {
        if (now - message.timestamp > recentWindow) continue;
        
        // Check if message was relayed by multiple peers (indicates bridge behavior)
        if (message.relayedBy && message.relayedBy.size > 1) {
          for (const relayPeer of message.relayedBy) {
            if (relayPeer !== this.localPeerId) {
              if (!this.bridgePeers.has(relayPeer)) {
                this.bridgePeers.add(relayPeer);
                console.log(`Gossip: Identified ${relayPeer} as bridge peer (active relay behavior)`);
              }
            }
          }
        }
      }
    }
    
    console.log(`Gossip: Current bridge peers: ${Array.from(this.bridgePeers).join(', ')}`);
  }

  /**
   * SIMPLIFIED: Send connectivity probe to a peer
   */
  async sendConnectivityProbe(peerId) {
    try {
      const probeMessage = await this.createMessage('__gossip_connectivity_probe', {
        timestamp: Date.now(),
        probingPeer: this.localPeerId,
        probeId: Math.random().toString(36).substr(2, 9)
      });
      
      console.log(`Gossip: Sending connectivity probe to ${peerId}`);
      
      // Try direct send
      try {
        this.sendFunction(peerId, {
          type: 'gossip',
          data: { ...probeMessage, relayedBy: Array.from(probeMessage.relayedBy) }
        });
      } catch (error) {
        console.log(`Gossip: Direct probe to ${peerId} failed: ${error.message}`);
      }
      
      // Also try sending via bridge peers
      const bridgePeersArray = Array.from(this.bridgePeers);
      for (const bridgePeer of bridgePeersArray) {
        if (bridgePeer !== peerId) {
          try {
            console.log(`Gossip: Sending connectivity probe to ${peerId} via bridge ${bridgePeer}`);
            this.sendFunction(bridgePeer, {
              type: 'gossip',
              data: { ...probeMessage, relayedBy: Array.from(probeMessage.relayedBy) }
            });
          } catch (error) {
            console.log(`Gossip: Bridge probe via ${bridgePeer} failed: ${error.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`Gossip: Failed to create connectivity probe for ${peerId}:`, error);
    }
  }

  /**
   * SIMPLIFIED: Remove peer from suspected islands (no-op since we don't track islands)
   */
  removeSuspectedIsland(peerId) {
    console.log(`Gossip: Connectivity confirmed for ${peerId}`);
  }

  /**
   * Get bridge peers for routing
   */
  getBridgePeers() {
    return this.bridgePeers;
  }

  /**
   * SIMPLIFIED: Get suspected islands count (always 0 since we don't track)
   */
  getSuspectedIslandCount() {
    return 0; // No island tracking
  }

  /**
   * Add a peer as a bridge peer manually
   */
  addBridgePeer(peerId) {
    if (peerId !== this.localPeerId) {
      this.bridgePeers.add(peerId);
      console.log(`Gossip: Manually added ${peerId} as bridge peer`);
    }
  }

  /**
   * Remove a peer from bridge peers
   */
  removeBridgePeer(peerId) {
    if (this.bridgePeers.has(peerId)) {
      this.bridgePeers.delete(peerId);
      console.log(`Gossip: Removed ${peerId} from bridge peers`);
    }
  }
}
