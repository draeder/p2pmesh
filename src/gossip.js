// src/gossip.js

/**
 * Represents a gossip message.
 */
class GossipMessage {
    /**
     * @param {string} topic
     * @param {any} payload
     * @param {string} originPeerId
     * @param {string} [signature]
     * @param {number} [timestamp]
     */
    constructor(topic, payload, originPeerId, signature, timestamp) {
      this.id = `msg-${Math.random().toString(36).substring(2, 11)}-${Date.now()}`;
      this.topic = topic;
      this.payload = payload;
      this.originPeerId = originPeerId;
      this.signature = signature;
      this.timestamp = timestamp || Date.now();
      this.hops = 0;
      this.relayedBy = new Set();
    }
  }
  
  /**
   * Manages the gossip protocol with island detection and smart routing.
   */
  export class GossipProtocol {
    /**
     * @param {object} opts
     * @param {string} opts.localPeerId
     * @param {object} opts.dht
     * @param {function} opts.sendFunction
     * @param {object} [opts.cryptoProvider]
     */
    constructor({ localPeerId, dht, sendFunction, cryptoProvider }) {
      this.localPeerId = localPeerId;
      this.dht = dht;
      this.sendFunction = sendFunction;
      this.cryptoProvider = cryptoProvider;
      this.seenMessages = new Map();
      this.messageHandlers = new Map();
      this.maxHops = 10;
      this.cacheTTL = 5 * 60 * 1000;
      
      // Peer connectivity tracking
      this.peerReachability = new Map(); // peerId -> { lastSeen, failures, reachable }
      this.connectivityCheckInterval = 30000; // 30 seconds
      this.maxFailures = 3; // Mark peer as unreachable after 3 failures
      
      // Island detection and bridging
      this.knownPeers = new Set(); // All peers we've ever seen
      this.bridgePeers = new Set(); // Peers that can reach multiple islands
      this.lastConnectivityCheck = 0;
      
      console.log(`GossipProtocol initialized for peer ${localPeerId} with island detection`);
      
      // Start connectivity monitoring
      this.startConnectivityMonitoring();
    }

    /**
     * Start monitoring peer connectivity to detect islands
     */
    startConnectivityMonitoring() {
      setInterval(() => {
        this.checkPeerConnectivity();
        this.detectIslands();
      }, this.connectivityCheckInterval);
    }

    /**
     * Check connectivity to known peers
     */
    checkPeerConnectivity() {
      const now = Date.now();
      this.lastConnectivityCheck = now;
      
      // Get all known peers from DHT
      const allContacts = this.dht.routingTable.getAllContacts
        ? this.dht.routingTable.getAllContacts()
        : this.dht.routingTable.buckets.flat();
      
      for (const contact of allContacts) {
        if (contact.id === this.localPeerId) continue;
        
        this.knownPeers.add(contact.id);
        
        // Initialize reachability if not exists
        if (!this.peerReachability.has(contact.id)) {
          this.peerReachability.set(contact.id, {
            lastSeen: now,
            failures: 0,
            reachable: true
          });
        }
        
        // Check if peer hasn't been seen recently
        const reachability = this.peerReachability.get(contact.id);
        if (now - reachability.lastSeen > this.connectivityCheckInterval * 2) {
          reachability.failures++;
          if (reachability.failures >= this.maxFailures) {
            reachability.reachable = false;
            console.log(`Gossip: Marking peer ${contact.id} as unreachable (${reachability.failures} failures)`);
          }
        }
      }
    }

    /**
     * Detect peer islands and identify bridge peers
     */
    detectIslands() {
      const reachablePeers = new Set();
      const unreachablePeers = new Set();
      
      for (const [peerId, reachability] of this.peerReachability) {
        if (reachability.reachable) {
          reachablePeers.add(peerId);
        } else {
          unreachablePeers.add(peerId);
        }
      }
      
      if (unreachablePeers.size > 0) {
        console.log(`Gossip: Detected ${unreachablePeers.size} unreachable peers, ${reachablePeers.size} reachable`);
        
        // Identify potential bridge peers (peers that have recently relayed messages from unreachable peers)
        this.identifyBridgePeers(unreachablePeers);
      }
    }

    /**
     * Identify peers that can act as bridges between islands
     */
    identifyBridgePeers(unreachablePeers) {
      const now = Date.now();
      const recentWindow = 60000; // 1 minute
      
      // Look through recent messages to find peers that relayed from unreachable peers
      for (const [messageId, message] of this.seenMessages) {
        if (now - message.timestamp > recentWindow) continue;
        
        // Check if message originated from unreachable peer but was relayed by reachable peer
        if (unreachablePeers.has(message.originPeerId)) {
          for (const relayPeer of message.relayedBy) {
            if (relayPeer !== this.localPeerId && this.isPeerReachable(relayPeer)) {
              this.bridgePeers.add(relayPeer);
              console.log(`Gossip: Identified ${relayPeer} as bridge peer (relayed from unreachable ${message.originPeerId})`);
            }
          }
        }
      }
    }

    /**
     * Check if a peer is currently reachable
     */
    isPeerReachable(peerId) {
      const reachability = this.peerReachability.get(peerId);
      return reachability ? reachability.reachable : true; // Assume reachable if unknown
    }

    /**
     * Update peer reachability when we receive a message
     */
    updatePeerReachability(peerId) {
      const now = Date.now();
      const reachability = this.peerReachability.get(peerId) || {
        lastSeen: 0,
        failures: 0,
        reachable: true
      };
      
      reachability.lastSeen = now;
      reachability.failures = 0;
      reachability.reachable = true;
      this.peerReachability.set(peerId, reachability);
    }

    /**
     * Record a failed send attempt
     */
    recordSendFailure(peerId) {
      const reachability = this.peerReachability.get(peerId) || {
        lastSeen: 0,
        failures: 0,
        reachable: true
      };
      
      reachability.failures++;
      if (reachability.failures >= this.maxFailures) {
        reachability.reachable = false;
        console.log(`Gossip: Marking peer ${peerId} as unreachable after send failure`);
      }
      this.peerReachability.set(peerId, reachability);
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
     * Smart broadcast that only sends to reachable peers
     */
    async broadcast(topic, payload) {
      const msg = await this.createMessage(topic, payload);
      this.seenMessages.set(msg.id, msg);
      msg.relayedBy.add(this.localPeerId);
  
      console.log(`Gossip: Broadcasting message ${msg.id} on topic '${topic}'`);
  
      // Get all contacts and filter for reachable ones
      const allContacts = this.dht.routingTable.getAllContacts
        ? this.dht.routingTable.getAllContacts()
        : this.dht.routingTable.buckets.flat();
      
      const reachablePeers = allContacts
        .map(c => c.id)
        .filter(id => id !== this.localPeerId && this.isPeerReachable(id));
  
      console.log(`Gossip: Sending to ${reachablePeers.length} reachable peers (skipping unreachable)`);
  
      // Send to reachable peers only - no retry mechanism
      for (const peerId of reachablePeers) {
        try {
          this.sendFunction(peerId, {
            type: 'gossip',
            data: { ...msg, relayedBy: Array.from(msg.relayedBy) }
          });
        } catch (error) {
          console.error(`Gossip: Failed to send to ${peerId}:`, error);
          this.recordSendFailure(peerId);
        }
      }
  
      // Process locally
      this._processLocal(msg);
    }
  
    /**
     * Adaptive publish (gossip) after initial broadcast
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
  
      // Otherwise gossip via smart fanout
      const peersToNotify = this._selectPeersForGossip(
        message.topic,
        message.originPeerId,
        new Set([...message.relayedBy, this.localPeerId])
      );

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

      for (const peerId of peersToNotify) {
        try {
          console.log(`Gossip: Relaying ${message.id} → ${peerId}`);
          this.sendFunction(peerId, {
            type: 'gossip',
            data: messageToSend
          });
        } catch (error) {
          console.error(`Gossip: Failed to relay to ${peerId}:`, error);
          this.recordSendFailure(peerId);
        }
      }
      this._processLocal(message);
    }
  
    async handleIncomingMessage(raw, fromPeerId) {
      // Update reachability for sender
      this.updatePeerReachability(fromPeerId);
      
      // No more acknowledgment handling - removed retry mechanism
      if (raw.type === 'gossip_ack') {
        return; // Ignore acks since we don't use retries anymore
      }
  
      const md = raw.data;
      const payload = md.payload;
      
      console.log(`Gossip: Received raw payload type: ${typeof payload} from ${fromPeerId}`);
      if (typeof payload === 'string' && payload.length < 100) {
        console.log(`Gossip: Payload content: ${payload}`);
      }
  
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
  
      // Update reachability for origin peer (they're reachable via this relay)
      if (md.originPeerId !== fromPeerId) {
        this.updatePeerReachability(md.originPeerId);
      }
  
      // Dedupe & TTL/hops check
      if (this.seenMessages.has(msg.id) || msg.hops > this.maxHops) return;
      const valid = await this._verify(msg.payload, msg.signature, msg.originPeerId);
      if (!valid) return console.warn(`Gossip: Dropped invalid ${msg.id}`);
  
      this.seenMessages.set(msg.id, msg);
      console.log(`Gossip: Received ${msg.id} from ${fromPeerId} (hops=${msg.hops})`);
  
      // Local delivery
      this._processLocal(msg);
  
      // Continue gossip relay
      const peersToNotify = this._selectPeersForGossip(
        msg.topic,
        msg.originPeerId,
        new Set([...msg.relayedBy, this.localPeerId])
      );
      
      for (const peerId of peersToNotify) {
        try {
          console.log(`Gossip: Relaying ${msg.id} → ${peerId}`);
          this.sendFunction(peerId, {
            type: 'gossip',
            data: { ...msg, relayedBy: Array.from(msg.relayedBy) }
          });
        } catch (error) {
          console.error(`Gossip: Failed to relay to ${peerId}:`, error);
          this.recordSendFailure(peerId);
        }
      }
  
      this._cleanupSeenMessages();
    }
  
    _selectPeersForGossip(topic, originPeerId, excluded = new Set()) {
      const buckets = this.dht.routingTable.buckets;
      if (!Array.isArray(buckets)) return [];
      
      const allIds = [...new Set(buckets.flat().map(c => c.id))];
      const candidates = allIds.filter(id =>
        id !== this.localPeerId &&
        id !== originPeerId &&
        !excluded.has(id) &&
        this.isPeerReachable(id) // Only include reachable peers
      );
      
      if (candidates.length === 0) {
        // If no reachable candidates, try bridge peers
        const bridgeCandidates = Array.from(this.bridgePeers).filter(id =>
          id !== this.localPeerId &&
          id !== originPeerId &&
          !excluded.has(id)
        );
        
        if (bridgeCandidates.length > 0) {
          console.log(`Gossip: Using bridge peers for relay: ${bridgeCandidates.join(', ')}`);
          return bridgeCandidates.slice(0, 2); // Limit to 2 bridge peers
        }
        
        return [];
      }
      
      const N = allIds.length + 1; // Total network size including self
      
      // Adaptive fanout based on network size and reachability
      let ratio = N <= 5 ? 1.0 :     // 100% coverage for very small networks
                  N <= 10 ? 0.9 :    // 90% coverage for small networks
                  N <= 15 ? 0.8 :    // 80% coverage for medium networks
                  N <= 25 ? 0.7 :    // 70% coverage for larger networks
                  0.6;               // 60% baseline for very large networks
      
      // Increase fanout if we have unreachable peers (to compensate for islands)
      const unreachableCount = Array.from(this.peerReachability.values())
        .filter(r => !r.reachable).length;
      if (unreachableCount > 0) {
        ratio = Math.min(1.0, ratio + 0.2); // Increase by 20% if islands detected
        console.log(`Gossip: Increased fanout ratio to ${ratio} due to ${unreachableCount} unreachable peers`);
      }
      
      const minFanout = Math.max(3, Math.ceil(candidates.length * 0.5));
      const fanout = Math.min(
        candidates.length,
        Math.max(minFanout, Math.ceil(candidates.length * ratio))
      );
      
      if (fanout >= candidates.length - 1) return candidates;
  
      // Prioritize bridge peers for better island connectivity
      const bridgeCandidates = candidates.filter(id => this.bridgePeers.has(id));
      const regularCandidates = candidates.filter(id => !this.bridgePeers.has(id));
      
      const selected = [];
      
      // Always include some bridge peers if available
      if (bridgeCandidates.length > 0) {
        const bridgeCount = Math.min(bridgeCandidates.length, Math.ceil(fanout * 0.3));
        selected.push(...bridgeCandidates.slice(0, bridgeCount));
      }
      
      // Fill remaining slots with regular peers
      const remainingSlots = fanout - selected.length;
      if (remainingSlots > 0) {
        // Group by distance for diversity
        const groups = {};
        regularCandidates.forEach(id => {
          const g = id.substring(0, 2);
          (groups[g] ||= []).push(id);
        });
  
        const grpArr = Object.values(groups);
        const perGrp = Math.max(1, Math.floor(remainingSlots / grpArr.length));
        grpArr.forEach(g => {
          const pick = [...g].sort(() => 0.5 - Math.random()).slice(0, perGrp);
          selected.push(...pick);
        });
        
        if (selected.length < fanout) {
          const rest = regularCandidates.filter(id => !selected.includes(id));
          selected.push(...rest.sort(() => 0.5 - Math.random()).slice(0, fanout - selected.length));
        }
      }
      
      return selected.slice(0, fanout);
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
      console.log(`Gossip: Processing payload of type: ${typeof data} with value: ${typeof data === 'string' ? data : JSON.stringify(data).substring(0, 100)}`);
      
      if (typeof data === 'string') {
        try { 
          if (data.startsWith('{') || data.startsWith('[')) {
            data = JSON.parse(data);
            console.log(`Gossip: Successfully parsed JSON payload for local delivery`);
          } else {
            console.log(`Gossip: Payload is a simple string (not JSON), delivering as-is: '${data}'`);
          }
        } catch (e) {
          console.error(`Gossip: Error parsing payload in _processLocal:`, e);
          console.error(`Gossip: Problematic payload:`, data.substring(0, 100));
        }
      }
      
      console.log(`Gossip: Delivering message on topic '${message.topic}' to ${handlers.size} handlers`);
      for (const h of handlers) {
        try { 
          console.log(`Gossip: Calling handler with payload:`, data);
          h({ 
            topic: message.topic, 
            payload: data, 
            originPeerId: message.originPeerId, 
            timestamp: message.timestamp 
          }); 
        } catch (e) { 
          console.error(`Gossip: handler error:`, e); 
        }
      }
    }
  
    _cleanupSeenMessages() {
      const now = Date.now();
      for (const [id, msgObj] of this.seenMessages) {
        const timestamp = typeof msgObj === 'object' ? msgObj.timestamp : msgObj;
        if (now - timestamp > this.cacheTTL) this.seenMessages.delete(id);
      }
      
      // Clean up old reachability data
      for (const [peerId, reachability] of this.peerReachability) {
        if (now - reachability.lastSeen > this.cacheTTL) {
          this.peerReachability.delete(peerId);
        }
      }
    }

    /**
     * Get connectivity statistics for debugging
     */
    getConnectivityStats() {
      const reachable = Array.from(this.peerReachability.values()).filter(r => r.reachable).length;
      const unreachable = Array.from(this.peerReachability.values()).filter(r => !r.reachable).length;
      
      return {
        totalKnownPeers: this.knownPeers.size,
        reachablePeers: reachable,
        unreachablePeers: unreachable,
        bridgePeers: this.bridgePeers.size,
        lastConnectivityCheck: this.lastConnectivityCheck
      };
    }
  }
