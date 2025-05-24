// src/gossip.js

import { GossipMessage } from './gossip/gossip-message.js';
import { IslandHealingManager } from './gossip/island-healing.js';
import { MessageRouter } from './gossip/message-router.js';
import { ChordOverlay } from './gossip/chord-overlay.js';

/**
 * FIXED: Gossip protocol that only sends to actually connected WebRTC peers
 * This ensures reliable delivery with limited peer connections (maxPeers=3)
 */
export class GossipProtocol {
  /**
   * @param {object} opts
   * @param {string} opts.localPeerId
   * @param {object} opts.dht
   * @param {function} opts.sendFunction
   * @param {function} opts.getPeerConnectionStatus - Function to check actual peer connection status
   * @param {object} [opts.cryptoProvider]
   */
  constructor({ localPeerId, dht, sendFunction, getPeerConnectionStatus, cryptoProvider }) {
    this.localPeerId = localPeerId;
    this.dht = dht;
    this.sendFunction = sendFunction;
    this.getPeerConnectionStatus = getPeerConnectionStatus;
    this.cryptoProvider = cryptoProvider;
    this.seenMessages = new Map();
    this.messageHandlers = new Map();
    this.maxHops = 10;
    this.cacheTTL = 5 * 60 * 1000;
    
    // ENHANCED: Add Chord-like overlay for full network coverage
    this.chordOverlay = new ChordOverlay({
      localPeerId,
      dht,
      sendFunction,
      maxDirectConnections: 5
    });
    
    this.islandHealingManager = new IslandHealingManager({
      localPeerId,
      sendFunction,
      createMessage: this.createMessage.bind(this),
      reachabilityManager: null // Pass null since we removed it
    });
    
    this.messageRouter = new MessageRouter({
      localPeerId,
      islandHealingManager: this.islandHealingManager
      // REMOVED: reachabilityManager
    });
    
    console.log(`GossipProtocol initialized for peer ${localPeerId} - FIXED FOR RELIABLE DELIVERY`);
  }

  async _sign(payload) {
    if (!this.cryptoProvider?.sign) return null;
    try {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return await this.cryptoProvider.sign(data);
    } catch (e) {
      console.error('Gossip: Error signing:', e);
      return null;
    }
  }

  async _verify(payload, signature, originPeerId) {
    if (!this.cryptoProvider?.verify || !signature) return true;
    try {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return await this.cryptoProvider.verify(data, signature, originPeerId);
    } catch (e) {
      console.error(`Gossip: Error verifying from ${originPeerId}:`, e);
      return false;
    }
  }

  async createMessage(topic, payload) {
    // Store objects as serialized strings to ensure consistent handling
    const normalizedPayload = payload !== null && typeof payload === 'object' ? JSON.stringify(payload) : payload;
    const signature = await this._sign(normalizedPayload);
    return new GossipMessage(topic, normalizedPayload, this.localPeerId, signature);
  }

  /**
   * FIXED: Get only actually connected peers for reliable delivery
   */
  getConnectedPeers() {
    const connectedPeers = [];
    
    // Get all potential peers from various sources
    const allContacts = this.dht.routingTable.getAllContacts
      ? this.dht.routingTable.getAllContacts()
      : this.dht.routingTable.buckets.flat();
    
    const dhtPeers = allContacts.map(c => c.id).filter(id => id !== this.localPeerId);
    const bridgePeers = Array.from(this.islandHealingManager.getBridgePeers());
    const chordTargets = this.chordOverlay.getGossipTargets(new Set([this.localPeerId]));
    
    // Combine all potential targets
    const allPotentialPeers = [...new Set([...dhtPeers, ...bridgePeers, ...chordTargets])];
    
    // Filter to only actually connected peers
    for (const peerId of allPotentialPeers) {
      const status = this.getPeerConnectionStatus(peerId);
      if (status && status.connected) {
        connectedPeers.push(peerId);
      }
    }
    
    console.log(`Gossip: Found ${connectedPeers.length} actually connected peers out of ${allPotentialPeers.length} potential targets`);
    console.log(`Gossip: Connected peers: ${connectedPeers.join(', ')}`);
    
    return connectedPeers;
  }

  /**
   * FIXED: Broadcast only to actually connected peers for reliable delivery
   */
  async broadcast(topic, payload) {
    const msg = await this.createMessage(topic, payload);
    this.seenMessages.set(msg.id, msg);
    msg.relayedBy.add(this.localPeerId);

    console.log(`Gossip: Broadcasting message ${msg.id} on topic '${topic}' - FIXED FOR RELIABLE DELIVERY`);

    // FIXED: Only send to actually connected peers
    const connectedPeers = this.getConnectedPeers();
    
    if (connectedPeers.length === 0) {
      console.warn(`Gossip: No connected peers found for broadcast! Message ${msg.id} will only be processed locally.`);
      this._processLocal(msg);
      return;
    }

    console.log(`Gossip: Broadcasting to ${connectedPeers.length} connected peers: ${connectedPeers.join(', ')}`);

    // FIXED: Send to all connected peers with error handling
    let successCount = 0;
    let failureCount = 0;
    
    for (const peerId of connectedPeers) {
      try {
        this.sendFunction(peerId, {
          type: 'gossip',
          data: { ...msg, relayedBy: Array.from(msg.relayedBy) }
        });
        successCount++;
        console.log(`Gossip: ✓ Successfully sent broadcast to ${peerId}`);
      } catch (error) {
        failureCount++;
        console.error(`Gossip: ✗ Failed to send broadcast to ${peerId}:`, error);
      }
    }
    
    console.log(`Gossip: BROADCAST COMPLETE - ${successCount} successful, ${failureCount} failed out of ${connectedPeers.length} connected peers`);

    // Process locally
    this._processLocal(msg);
  }

  /**
   * FIXED: Publish using only connected peers for relay
   */
  async publish(message) {
    if (this.seenMessages.has(message.id)) return;
    this.seenMessages.set(message.id, message);
    message.relayedBy.add(this.localPeerId);

    console.log(`Gossip: Publishing message ${message.id} on topic '${message.topic}'`);

    // On origin, do full broadcast
    if (message.originPeerId === this.localPeerId && message.hops === 0) {
      return this.broadcast(message.topic, message.payload);
    }

    // FIXED: Only relay to connected peers that haven't seen the message
    const connectedPeers = this.getConnectedPeers();
    const excludePeers = new Set([...message.relayedBy, this.localPeerId]);
    const peersToNotify = connectedPeers.filter(peerId => !excludePeers.has(peerId));

    const messageToSend = {
      id: message.id,
      topic: message.topic,
      payload: message.payload,
      originPeerId: message.originPeerId,
      signature: message.signature,
      timestamp: message.timestamp,
      hops: message.hops,
      relayedBy: Array.from(message.relayedBy)
    };

    console.log(`Gossip: RELAY to ${peersToNotify.length} connected peers: ${peersToNotify.join(', ')}`);

    for (const peerId of peersToNotify) {
      try {
        console.log(`Gossip: ✓ Relaying ${message.id} → ${peerId}`);
        this.sendFunction(peerId, {
          type: 'gossip',
          data: messageToSend
        });
      } catch (error) {
        console.error(`Gossip: ✗ Failed to relay to ${peerId}:`, error);
      }
    }
    this._processLocal(message);
  }

  async handleIncomingMessage(raw, fromPeerId) {
    // Handle connectivity probes (simplified)
    if (raw.type === 'gossip' && raw.data && raw.data.topic === '__gossip_connectivity_probe') {
      console.log(`Gossip: Received connectivity probe from ${fromPeerId}`);
      try {
        const response = await this.createMessage('__gossip_connectivity_response', {
          originalProbe: raw.data.payload,
          respondingPeer: this.localPeerId,
          timestamp: Date.now()
        });
        this.sendFunction(fromPeerId, {
          type: 'gossip',
          data: { ...response, relayedBy: Array.from(response.relayedBy) }
        });
      } catch (error) {
        console.error(`Gossip: Failed to send connectivity response to ${fromPeerId}:`, error);
      }
      return;
    }
    
    // Handle connectivity responses
    if (raw.type === 'gossip' && raw.data && raw.data.topic === '__gossip_connectivity_response') {
      console.log(`Gossip: Received connectivity response from ${fromPeerId}`);
      return;
    }
    
    // Ignore acks
    if (raw.type === 'gossip_ack') {
      return;
    }

    const md = raw.data;
    const payload = md.payload;
    
    console.log(`Gossip: Received message from ${fromPeerId}, payload type: ${typeof payload}`);

    const msg = new GossipMessage(
      md.topic,
      payload,
      md.originPeerId,
      md.signature,
      md.timestamp
    );
    msg.id = md.id;
    msg.hops = (md.hops || 0) + 1;
    msg.relayedBy = new Set(md.relayedBy || []);
    msg.relayedBy.add(fromPeerId);

    // Dedupe & TTL/hops check
    if (this.seenMessages.has(msg.id) || msg.hops > this.maxHops) return;
    const valid = await this._verify(msg.payload, msg.signature, msg.originPeerId);
    if (!valid) return console.warn(`Gossip: Dropped invalid ${msg.id}`);

    this.seenMessages.set(msg.id, msg);
    console.log(`Gossip: Received ${msg.id} from ${fromPeerId} (hops=${msg.hops})`);

    // Local delivery
    this._processLocal(msg);

    // FIXED: Continue relay only to connected peers that haven't seen the message
    const connectedPeers = this.getConnectedPeers();
    const excludePeers = new Set([...msg.relayedBy, this.localPeerId]);
    const peersToNotify = connectedPeers.filter(peerId => !excludePeers.has(peerId));
    
    console.log(`Gossip: RELAY CONTINUE to ${peersToNotify.length} connected peers: ${peersToNotify.join(', ')}`);
    
    for (const peerId of peersToNotify) {
      try {
        console.log(`Gossip: ✓ Relaying ${msg.id} → ${peerId}`);
        this.sendFunction(peerId, {
          type: 'gossip',
          data: { ...msg, relayedBy: Array.from(msg.relayedBy) }
        });
      } catch (error) {
        console.error(`Gossip: ✗ Failed to relay to ${peerId}:`, error);
      }
    }

    this._cleanupSeenMessages();
  }

  subscribe(topic, handler) {
    (this.messageHandlers.get(topic) || this.messageHandlers.set(topic, new Set()).get(topic))
      .add(handler);
    console.log(`Gossip: Subscribed to '${topic}'`);
  }

  unsubscribe(topic, handler) {
    const hs = this.messageHandlers.get(topic);
    if (!hs) return;
    hs.delete(handler);
    if (!hs.size) this.messageHandlers.delete(topic);
    console.log(`Gossip: Unsubscribed from '${topic}'`);
  }

  _processLocal(message) {
    // Skip messages originated by the local peer
    if (message.originPeerId === this.localPeerId) {
      console.log(`Gossip: Skipping local delivery of own message ${message.id} on topic '${message.topic}'`);
      return;
    }

    // Skip internal connectivity messages
    if (message.topic === '__gossip_connectivity_probe' || message.topic === '__gossip_connectivity_response') {
      return;
    }

    // Get handlers for the topic or use wildcard handlers as fallback
    let handlers = this.messageHandlers.get(message.topic);
    if (!handlers) {
      console.warn(`Gossip: No handlers found for topic '${message.topic}', available topics: [${Array.from(this.messageHandlers.keys()).join(', ')}]`);
      const wildcardHandlers = this.messageHandlers.get('*');
      if (!wildcardHandlers) {
        console.warn(`Gossip: No wildcard handlers found either, message will not be delivered`);
        return;
      }
      console.log(`Gossip: Found wildcard handlers, will deliver message to them`);
      handlers = wildcardHandlers;
    }
    
    // Process payload - parse JSON strings consistently
    let data = message.payload;
    console.log(`Gossip: Processing payload of type: ${typeof data}`);
    
    if (typeof data === 'string') {
      try {
        // Try to parse as JSON if it looks like JSON
        if (data.startsWith('{') || data.startsWith('[')) {
          data = JSON.parse(data);
          console.log(`Gossip: Parsed JSON payload, now type: ${typeof data}`);
        }
      } catch (e) {
        // If parsing fails, keep as string
        console.log(`Gossip: Failed to parse as JSON, keeping as string: ${e.message}`);
      }
    }

    console.log(`Gossip: Delivering message ${message.id} to ${handlers.size} handlers for topic '${message.topic}'`);
    
    // Deliver to all handlers
    for (const handler of handlers) {
      try {
        handler({
          topic: message.topic,
          data: data,
          from: message.originPeerId,
          messageId: message.id,
          timestamp: message.timestamp,
          hops: message.hops
        });
      } catch (error) {
        console.error(`Gossip: Error in message handler for topic '${message.topic}':`, error);
      }
    }
  }

  _cleanupSeenMessages() {
    const now = Date.now();
    for (const [id, msg] of this.seenMessages) {
      if (now - msg.timestamp > this.cacheTTL) {
        this.seenMessages.delete(id);
      }
    }
  }

  /**
   * Get network statistics for debugging
   */
  getNetworkStats() {
    return this.chordOverlay.getNetworkStats();
  }

  /**
   * Force update of overlay network (for testing)
   */
  forceOverlayUpdate() {
    this.chordOverlay.forceUpdate();
  }
}

// Export the GossipMessage class as well for backward compatibility
export { GossipMessage };
