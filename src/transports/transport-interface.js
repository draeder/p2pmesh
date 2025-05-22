// src/transports/transport-interface.js

/**
 * Abstract Transport Layer
 * Defines the interface for transport mechanisms used for signaling.
 * 
 * Transport implementations should emit the following standard events:
 * - 'signal': When a WebRTC signal is received from another peer
 * - 'connect_request': When another peer requests a connection
 * - 'peer_joined': When a new peer joins the network
 * - 'peer_left': When a peer leaves the network
 * - 'error': When an error occurs
 * - 'ack': When an acknowledgment is received
 * - 'bootstrap_peers': When a list of bootstrap peers is received
 * - 'kademlia_rpc_message': When a Kademlia RPC message is received
 * - 'open': When the transport connection is opened
 * - 'close': When the transport connection is closed
 */
export class AbstractTransport {
  constructor() {
    if (this.constructor === AbstractTransport) {
      throw new Error("Abstract classes can't be instantiated.");
    }
    this.eventListeners = new Map();
  }

  /**
   * Connects the transport layer.
   * @param {string} localPeerId - The ID of the local peer.
   * @returns {Promise<void>}
   */
  async connect(localPeerId) {
    throw new Error('Method "connect()" must be implemented.');
  }

  /**
   * Disconnects the transport layer.
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('Method "disconnect()" must be implemented.');
  }

  /**
   * Sends a message/signal to a specific peer.
   * @param {string} toPeerId - The ID of the recipient peer.
   * @param {object} message - The message/signal to send.
   * @returns {void}
   */
  send(toPeerId, message) {
    throw new Error('Method "send()" must be implemented.');
  }

  /**
   * Registers an event handler.
   * @param {string} eventName - The name of the event (e.g., 'signal', 'connect_request').
   * @param {Function} handler - The callback function to handle the event.
   */
  on(eventName, handler) {
    if (!this.eventListeners.has(eventName)) {
      this.eventListeners.set(eventName, []);
    }
    this.eventListeners.get(eventName).push(handler);
  }

  /**
   * Emits an event to all registered listeners.
   * @param {string} eventName - The name of the event.
   * @param {object} data - The data to pass to the event handlers.
   */
  emit(eventName, data) {
    if (this.eventListeners.has(eventName)) {
      this.eventListeners.get(eventName).forEach(handler => handler(data));
    }
  }

  /**
   * Sends a Kademlia RPC message to a specific peer.
   * @param {string} toPeerId - The Kademlia ID of the recipient peer.
   * @param {object} kademliaRpcMessage - The Kademlia RPC message to send.
   * @returns {Promise<object>} A promise that resolves with the Kademlia RPC reply or rejects on error/timeout.
   */
  sendKademliaRpc(toPeerId, kademliaRpcMessage) {
    throw new Error('Method "sendKademliaRpc()" must be implemented.');
  }

  /**
   * Gets the address information for a peer.
   * @param {string} peerId - The ID of the peer.
   * @returns {string|object} The address information for the peer.
   */
  getPeerAddress(peerId) {
    throw new Error('Method "getPeerAddress()" must be implemented.');
  }
  
  /**
   * Method to discover peers, e.g., via bootstrap servers.
   * This method's signature and behavior can vary greatly depending on the transport.
   * @param {Array<string>} bootstrapUrls - URLs or identifiers for discovery points.
   */
  discoverPeers(bootstrapUrls) {
    console.warn('discoverPeers() not implemented by this transport');
  }
}