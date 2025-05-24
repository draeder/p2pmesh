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
   * Manages the gossip protocol.
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
      this.pendingAcknowledgments = new Map();
      this.messageRetryInterval = 2000;
      this.maxRetryAttempts = 3; // Reduced from 6 to 3
  
      console.log(`GossipProtocol initialized for peer ${localPeerId}`);
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
      // This ensures payload is in a predictable format throughout the gossip process
      const normalizedPayload = payload !== null && typeof payload === 'object' ? JSON.stringify(payload) : payload;
      const signature = await this._sign(normalizedPayload);
      return new GossipMessage(topic, normalizedPayload, this.localPeerId, signature);
    }
  
    /**
     * Full broadcast to all known peers on first hop.
     */
    async broadcast(topic, payload) {
      const msg = await this.createMessage(topic, payload);
      // Mark seen & self - store the full message object not just timestamp
      this.seenMessages.set(msg.id, msg);
      msg.relayedBy.add(this.localPeerId);
  
      console.log(`Gossip: Broadcasting message ${msg.id} on topic '${topic}' to ALL peers`);
  
      // Gather every peer ID
      const allContacts = this.dht.routingTable.getAllContacts
        ? this.dht.routingTable.getAllContacts()
        : this.dht.routingTable.buckets.flat();
      const peerIds = allContacts.map(c => c.id).filter(id => id !== this.localPeerId);
  
      // Only track acknowledgments for direct broadcasts from origin peer
      // Don't track for relayed messages to avoid unnecessary retries
      if (peerIds.length > 0) {
        this._trackMessageDelivery(msg.id, peerIds, true); // true = is broadcast
      }
  
      // Send to everyone
      for (const peerId of peerIds) {
        this.sendFunction(peerId, {
          type: 'gossip',
          data: { ...msg, relayedBy: Array.from(msg.relayedBy) }
        });
      }
  
      // Local handlers
      this._processLocal(msg);
    }
  
    /**
     * Adaptive publish (gossip) after initial broadcast.
     */
    async publish(message) {
      if (this.seenMessages.has(message.id)) return;
      this.seenMessages.set(message.id, message); // Store complete message object
      message.relayedBy.add(this.localPeerId);
  
      console.log(`Gossip: Publishing message ${message.id} on topic '${message.topic}'`);
  
      // On origin, do full broadcast
      if (message.originPeerId === this.localPeerId && message.hops === 0) {
        return this.broadcast(message.topic, message.payload);
      }
  
      // Otherwise gossip via fanout - NO RETRY TRACKING for relayed messages
      const peersToNotify = this._selectPeersForGossip(
        message.topic,
        message.originPeerId,
        new Set([...message.relayedBy, this.localPeerId])
      );

      // Make sure we have a clean message object for serialization
      const messageToSend = {
        id: message.id,
        topic: message.topic,
        payload: message.payload, // Already in correct format from createMessage
        originPeerId: message.originPeerId,
        signature: message.signature,
        timestamp: message.timestamp,
        hops: message.hops,
        relayedBy: Array.from(message.relayedBy)
      };

      for (const peerId of peersToNotify) {
        console.log(`Gossip: Relaying ${message.id} → ${peerId}`);
        this.sendFunction(peerId, {
          type: 'gossip',
          data: messageToSend
        });
      }
      this._processLocal(message);
    }
  
    async handleIncomingMessage(raw, fromPeerId) {
      if (raw.type === 'gossip_ack') {
        this._handleAcknowledgment(raw.messageId, fromPeerId);
        return;
      }
  
      // Get message data
      const md = raw.data;
      // Keep the raw payload for verification - don't parse it yet
      const payload = md.payload;
      
      // Log the incoming payload for debugging
      console.log(`Gossip: Received raw payload type: ${typeof payload} from ${fromPeerId}`);
      if (typeof payload === 'string' && payload.length < 100) {
        console.log(`Gossip: Payload content: ${payload}`);
      }
  
      // Build GossipMessage
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
  
      // Send acknowledgment only for direct broadcasts (hops = 1)
      // Don't ack relayed messages to reduce network overhead
      if (msg.hops === 1) {
        this._sendAcknowledgment(msg.id, fromPeerId);
      }
  
      // Dedupe & TTL/hops check
      if (this.seenMessages.has(msg.id) || msg.hops > this.maxHops) return;
      const valid = await this._verify(msg.payload, msg.signature, msg.originPeerId);
      if (!valid) return console.warn(`Gossip: Dropped invalid ${msg.id}`);
  
      this.seenMessages.set(msg.id, msg); // Store complete message object
      console.log(`Gossip: Received ${msg.id} from ${fromPeerId} (hops=${msg.hops})`);
  
      // Local deliver
      this._processLocal(msg);
  
      // Continue gossip relay - NO RETRY TRACKING for relayed messages
      const peersToNotify = this._selectPeersForGossip(
        msg.topic,
        msg.originPeerId,
        new Set([...msg.relayedBy, this.localPeerId])
      );
      for (const peerId of peersToNotify) {
        console.log(`Gossip: Relaying ${msg.id} → ${peerId}`);
        this.sendFunction(peerId, {
          type: 'gossip',
          data: { ...msg, relayedBy: Array.from(msg.relayedBy) }
        });
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
        !excluded.has(id)
      );
      
      if (candidates.length === 0) return [];
      
      // In small networks, forward to all available peers for maximum reliability
      const N = allIds.length + 1; // Total network size including self
      
      // Ensure higher coverage in smaller networks and more reasonable fanout in larger ones
      let ratio = N <= 5 ? 1.0 :     // 100% coverage for very small networks
                  N <= 10 ? 0.9 :    // 90% coverage for small networks
                  N <= 15 ? 0.8 :    // 80% coverage for medium networks
                  N <= 25 ? 0.7 :    // 70% coverage for larger networks
                  0.6;               // 60% baseline for very large networks
      
      // Ensure minimum fanout of at least 3 peers or half the network (whichever is greater)
      const minFanout = Math.max(
        3,                              // Always reach at least 3 peers if possible
        Math.ceil(candidates.length * 0.5)  // Or at least half of available peers
      );
      
      // Calculate actual fanout based on ratio but ensure it meets minimum requirements
      const fanout = Math.min(
        candidates.length,              // Can't forward to more peers than available
        Math.max(minFanout, Math.ceil(candidates.length * ratio))
      );
      
      // If we're close to forwarding to all candidates anyway, just send to everyone
      if (fanout >= candidates.length - 1) return candidates;
  
      // Semi-random by distance-groups
      const groups = {};
      candidates.forEach(id => {
        const g = id.substring(0, 2);
        (groups[g] ||= []).push(id);
      });
  
      const selected = [];
      const grpArr = Object.values(groups);
      const perGrp = Math.max(1, Math.floor(fanout / grpArr.length));
      grpArr.forEach(g => {
        const pick = [...g].sort(() => 0.5 - Math.random()).slice(0, perGrp);
        selected.push(...pick);
      });
      if (selected.length < fanout) {
        const rest = candidates.filter(id => !selected.includes(id));
        selected.push(...rest.sort(() => 0.5 - Math.random()).slice(0, fanout - selected.length));
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
        // Try to find the '*' wildcard handler as a fallback
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
          // Only try to parse if it looks like JSON
          if (data.startsWith('{') || data.startsWith('[')) {
            data = JSON.parse(data);
            console.log(`Gossip: Successfully parsed JSON payload for local delivery`);
          } else {
            console.log(`Gossip: Payload is a simple string (not JSON), delivering as-is: '${data}'`);
          }
        } catch (e) {
          console.error(`Gossip: Error parsing payload in _processLocal:`, e);
          console.error(`Gossip: Problematic payload:`, data.substring(0, 100));
          // Keep the original string if parsing fails
        }
      }
      
      // Call all subscribed handlers with the processed payload
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
      // Handle the new data structure where messages are stored as objects with timestamps
      for (const [id, msgObj] of this.seenMessages) {
        const timestamp = typeof msgObj === 'object' ? msgObj.timestamp : msgObj;
        if (now - timestamp > this.cacheTTL) this.seenMessages.delete(id);
      }
      for (const [mid, tr] of this.pendingAcknowledgments) {
        if (now - tr.timestamp > this.cacheTTL) {
          clearTimeout(tr.timerId);
          this.pendingAcknowledgments.delete(mid);
        }
      }
    }
  
    _sendAcknowledgment(messageId, toPeer) {
      this.sendFunction(toPeer, { type: 'gossip_ack', messageId, from: this.localPeerId });
    }
  
    _handleAcknowledgment(messageId, fromPeer) {
      const tr = this.pendingAcknowledgments.get(messageId);
      if (!tr) return;
      tr.acknowledged.add(fromPeer);
      
      // Check if we have enough acknowledgments (not necessarily all)
      const ackRatio = tr.acknowledged.size / tr.expected.length;
      const isComplete = ackRatio >= 0.8 || tr.acknowledged.size >= Math.min(tr.expected.length, 5);
      
      if (isComplete) {
        clearTimeout(tr.timerId);
        this.pendingAcknowledgments.delete(messageId);
        console.log(`Gossip: Sufficient ACKs received for ${messageId} (${tr.acknowledged.size}/${tr.expected.length})`);
      }
    }
  
    _trackMessageDelivery(messageId, expectedPeers, isBroadcast = false) {
      if (this.pendingAcknowledgments.has(messageId)) return;
      
      // Only track delivery for direct broadcasts, not relayed messages
      if (!isBroadcast) {
        console.log(`Gossip: Skipping delivery tracking for relayed message ${messageId}`);
        return;
      }
      
      // Get original message for retry mechanism
      const originalMessage = this.seenMessages.get(messageId);
      if (!originalMessage) {
        console.warn(`Gossip: Cannot track ${messageId}, message not found in seen messages`);
        return;
      }
      
      const tr = {
        expected: expectedPeers,
        acknowledged: new Set(),
        timestamp: Date.now(),
        retryCount: 0,
        timerId: null,
        originalMessage, // Store original message for reliable retries
        isBroadcast
      };
      tr.timerId = setTimeout(() => this._retryMessageDelivery(messageId), this.messageRetryInterval);
      this.pendingAcknowledgments.set(messageId, tr);
      console.log(`Gossip: Tracking delivery of ${messageId} to ${expectedPeers.length} peers`);
    }
  
    _retryMessageDelivery(messageId) {
      const tr = this.pendingAcknowledgments.get(messageId);
      if (!tr) return;
      
      tr.retryCount++;
      
      // More aggressive retry limits
      const maxAttempts = tr.expected.length <= 3 ? 2 : this.maxRetryAttempts;
      
      if (tr.retryCount > maxAttempts) {
        clearTimeout(tr.timerId);
        this.pendingAcknowledgments.delete(messageId);
        console.log(`Gossip: Gave up on ${messageId} after ${tr.retryCount} retries`);
        return;
      }
      
      const unacked = tr.expected.filter(id => !tr.acknowledged.has(id) && id !== this.localPeerId);
      if (!unacked.length) {
        clearTimeout(tr.timerId);
        this.pendingAcknowledgments.delete(messageId);
        return;
      }
      
      // Check if we have sufficient acknowledgments even without all peers
      const ackRatio = tr.acknowledged.size / tr.expected.length;
      if (ackRatio >= 0.7 && tr.acknowledged.size >= 2) {
        clearTimeout(tr.timerId);
        this.pendingAcknowledgments.delete(messageId);
        console.log(`Gossip: Sufficient coverage achieved for ${messageId}, stopping retries`);
        return;
      }
      
      // Retrieve the original message
      const original = tr.originalMessage || this.seenMessages.get(messageId);
      if (!original) {
        console.warn(`Gossip: Cannot retry ${messageId}, original message not found`);
        clearTimeout(tr.timerId);
        this.pendingAcknowledgments.delete(messageId);
        return;
      }
  
      // Exponential backoff with jitter
      const baseInterval = this.messageRetryInterval * Math.pow(1.5, tr.retryCount - 1);
      const jitter = Math.random() * 500; // Add up to 500ms jitter
      const nextInterval = Math.min(baseInterval + jitter, 8000);
      
      console.log(`Gossip: Retry #${tr.retryCount} for ${messageId} to ${unacked.length} peers (next in ${Math.round(nextInterval)}ms)`);
      
      for (const peerId of unacked) {
        try {
          this.sendFunction(peerId, {
            type: 'gossip',
            data: { ...original, relayedBy: Array.from(original.relayedBy) }
          });
        } catch (err) {
          console.error(`Gossip: Error sending retry to ${peerId}:`, err);
        }
      }
      
      tr.timerId = setTimeout(() => this._retryMessageDelivery(messageId), nextInterval);
    }
  }
