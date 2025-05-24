// src/gossip/gossip-message.js

/**
 * Represents a gossip message.
 */
export class GossipMessage {
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
