// src/transports/websocket-transport.js

import { InitiateTransport } from './transport-interface.js';

/**
 * WebSocket Transport Layer
 * Implements the InitiateTransport interface for signaling via WebSockets.
 */
export class WebSocketTransport extends InitiateTransport {
  /**
   * @param {string} signalingServerUrl - The URL of the WebSocket signaling server.
   */
  constructor(signalingServerUrl, options = {}) {
    super({ ...options, transportType: 'websocket' });
    if (!signalingServerUrl) {
      throw new Error('WebSocketTransport requires a signalingServerUrl.');
    }
    this.signalingServerUrl = signalingServerUrl;
    this.ws = null;
    this.localPeerId = null;
    this.isConnected = false;
    this.pendingKademliaRpcs = new Map();
  }

  async connect(localPeerId, options = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('WebSocket already connected.');
      return;
    }
    
    // Call parent connect to start cleanup timer
    await super.connect(localPeerId).catch(() => {}); // Ignore the "must be implemented" error
    
    this.localPeerId = localPeerId;
    this.isConnected = false;
    
    const silentConnect = options.silentConnect || false;
    if (!silentConnect) {
      const transportId = this._multiTransportId ? `[${this._multiTransportId}] ` : '';
      console.log(`${transportId}WebSocketTransport: Connecting to ${this.signalingServerUrl} as ${localPeerId}`);
    }

    return new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        const transportId = this._multiTransportId ? `[${this._multiTransportId}] ` : '';
        console.error(`${transportId}WebSocketTransport: Connection timeout`);
        if (this.ws) {
          this.ws.close();
        }
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      this.ws = new WebSocket(this.signalingServerUrl);

      this.ws.onopen = () => {
        clearTimeout(connectionTimeout);
        const transportId = this._multiTransportId ? `[${this._multiTransportId}] ` : '';
        console.log(`${transportId}WebSocketTransport: Connected to ${this.signalingServerUrl}`);
        this.ws.send(JSON.stringify({ type: 'join', peerId: this.localPeerId }));
        this.isConnected = true;
        this.emit('open');
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('WebSocketTransport: Received message from server:', message);

          switch (message.type) {
            case 'signal': // A WebRTC signal from another peer
              if (message.from && message.signal) {
                this.emit('signal', { from: message.from, signal: message.signal });
              }
              break;
            case 'connect_request': // A request from another peer to establish a direct WebRTC connection
              if (message.from) {
                this.emit('connect_request', { from: message.from });
              }
              break;
            case 'peer_joined': // Notification that a new peer joined the signaling server
              if (message.peerId && message.peerId !== this.localPeerId) {
                console.log(`WebSocketTransport: Peer ${message.peerId} joined, emitting connect_request.`);
                // This could be a trigger to initiate a connection
                this.emit('connect_request', { 
                  from: message.peerId,
                  transport: 'websocket',
                  transportId: this._multiTransportId || 'websocket'
                });
              }
              break;
            case 'peer_left': // Notification that a peer left
              console.log(`WebSocketTransport: Peer ${message.peerId} left.`);
              // Potentially emit an event to the mesh to handle this disconnection
              this.emit('peer_left', { 
                peerId: message.peerId,
                transport: 'websocket',
                transportId: this._multiTransportId || 'websocket'
              });
              break;
            case 'error':
              console.error('WebSocketTransport: Server sent error:', message.message);
              this.emit('error', new Error(message.message));
              break;
            case 'ack': // Acknowledge message from another peer
              if (message.from) {
                console.log(`WebSocketTransport: Received ack from ${message.from}`);
                this.emit('ack', { from: message.from });
              }
              break;
            case 'batched_signals': // Batched signals from SignalingOptimizer
              if (message.from && message.signals && Array.isArray(message.signals)) {
                console.log(`WebSocketTransport: Received batched signals from ${message.from} (${message.signals.length} signals)`);
                this.emit('batched_signals', { 
                  from: message.from, 
                  signals: message.signals,
                  batchTimestamp: message.batchTimestamp 
                });
              }
              break;
            case 'bootstrap_peers': // List of peers from signaling server for Kademlia bootstrap
              if (message.peers) {
                console.log(`WebSocketTransport: Received bootstrap_peers:`, message.peers);
                this.emit('bootstrap_peers', { 
                  peers: message.peers.map(peer => ({
                    ...peer,
                    transport: 'websocket',
                    transportId: this._multiTransportId || 'websocket'
                  }))
                });
              }
              break;
            case 'kademlia_rpc_request': // An incoming Kademlia RPC request
              if (message.from && message.rpcMessage) {
                console.log(`WebSocketTransport: Received kademlia_rpc_request from ${message.from}:`, message.rpcMessage);
                this.emit('kademlia_rpc_message', {
                  from: message.from,
                  message: message.rpcMessage,
                  reply: (responseRpcMessage) => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                      const replyPayload = {
                        type: 'kademlia_rpc_response',
                        to: message.from, // Send reply back to the original sender
                        from: this.localPeerId,
                        rpcMessage: responseRpcMessage
                      };
                      console.log(`WebSocketTransport: Sending kademlia_rpc_response to ${message.from}:`, replyPayload);
                      this.ws.send(JSON.stringify(replyPayload));
                    } else {
                      console.error('WebSocketTransport: Cannot send Kademlia RPC reply, WebSocket not open.');
                    }
                  }
                });
              }
              break;
            case 'kademlia_rpc_response': // A reply to one of our Kademlia RPCs
              if (message.from && message.rpcMessage && message.rpcMessage.inReplyTo) {
                console.log(`WebSocketTransport: Received kademlia_rpc_response from ${message.from}:`, message.rpcMessage);
                const rpcId = message.rpcMessage.inReplyTo;
                if (this.pendingKademliaRpcs.has(rpcId)) {
                  const { resolve, reject } = this.pendingKademliaRpcs.get(rpcId);
                  // KademliaRPC expects the rpcMessage part (e.g. {type: 'PONG', ...} or {type: 'FIND_NODE_REPLY', contacts: ...})
                  resolve(message.rpcMessage);
                  this.pendingKademliaRpcs.delete(rpcId);
                } else {
                  console.warn(`WebSocketTransport: Received Kademlia RPC reply for unknown rpcId: ${rpcId}`);
                }
              }
              break;
            case 'connection_rejected': // Connection rejection message from another peer
              if (message.from) {
                console.log(`WebSocketTransport: Received connection_rejected from ${message.from}:`, message.reason || 'No reason provided');
                this.emit('connection_rejected', { 
                  from: message.from, 
                  reason: message.reason,
                  maxPeers: message.maxPeers,
                  alternativePeers: message.alternativePeers || []
                });
              }
              break;
            case 'signal_rejected': // Signal rejection message (race condition prevention)
              if (message.from) {
                console.log(`WebSocketTransport: Received signal_rejected from ${message.from}: ${message.reason || 'No reason provided'}`);
                this.emit('signal_rejected', { 
                  from: message.from, 
                  reason: message.reason,
                  correctInitiator: message.correctInitiator
                });
              }
              break;
            default:
              console.warn('WebSocketTransport: Received unknown message type:', message.type);
          }
        } catch (error) {
          console.error('WebSocketTransport: Error processing message from server:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocketTransport: Error connecting to signaling server:', error);
        this.emit('error', error);
        reject(error);
      };

      this.ws.onclose = (event) => {
        console.log(`WebSocketTransport: Disconnected from ${this.signalingServerUrl}. Code: ${event.code}, Reason: ${event.reason}`);
        this.ws = null;
        this.isConnected = false;
        this.emit('close');
      };
    });
  }

  async disconnect() {
    // Call parent disconnect for cleanup
    await super.disconnect().catch(() => {}); // Ignore the "must be implemented" error
    
    if (this.ws) {
      console.log('WebSocketTransport: Disconnecting...');
      this.ws.send(JSON.stringify({ type: 'leave', peerId: this.localPeerId }));
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Sends a message/signal to a specific peer via the signaling server.
   * @param {string} toPeerId - The ID of the recipient peer.
   * @param {object} message - The message/signal to send (e.g., { type: 'signal', from: localPeerId, signal: data }).
   */
  send(toPeerId, message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocketTransport: Not connected. Cannot send message.');
      return;
    }
    const payload = {
      to: toPeerId,
      ...message // Spread the original message (which should include type, from, signal etc.)
    };
    console.log(`WebSocketTransport: Sending message to ${toPeerId} via server:`, payload);
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Sends a Kademlia RPC message to a specific peer via the signaling server.
   * @param {string} toPeerId - The Kademlia ID of the recipient peer.
   * @param {object} kademliaRpcMessage - The Kademlia RPC message to send (e.g., { type: 'PING', id: '...', rpcId: '...' }).
   * @returns {Promise<object>} A promise that resolves with the Kademlia RPC reply or rejects on error/timeout.
   */
  sendKademliaRpc(toPeerId, kademliaRpcMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocketTransport: Not connected. Cannot send Kademlia RPC.');
      return Promise.reject(new Error('WebSocket not connected'));
    }
    if (!kademliaRpcMessage.rpcId) {
        // Should be set by KademliaRPC, but as a fallback
        kademliaRpcMessage.rpcId = `rpc-${Date.now()}-${Math.random().toString(36).substring(2,9)}`;
        console.warn('WebSocketTransport: Kademlia RPC message was missing rpcId, generated one:', kademliaRpcMessage.rpcId);
    }

    const rpcId = kademliaRpcMessage.rpcId;

    const promise = new Promise((resolve, reject) => {
      this.pendingKademliaRpcs.set(rpcId, { resolve, reject });
      // Timeout for RPCs
      setTimeout(() => {
        if (this.pendingKademliaRpcs.has(rpcId)) {
          reject(new Error(`Kademlia RPC to ${toPeerId} (rpcId: ${rpcId}, type: ${kademliaRpcMessage.type}) timed out`));
          this.pendingKademliaRpcs.delete(rpcId);
        }
      }, 30000); // 30-second timeout
    });

    const payload = {
      type: 'kademlia_rpc_request',
      to: toPeerId,
      from: this.localPeerId,
      rpcMessage: kademliaRpcMessage
    };

    console.log(`WebSocketTransport: Sending Kademlia RPC request to ${toPeerId} (rpcId: ${rpcId}):`, payload);
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  /**
   * Gets connected peers with transport information
   */
  getConnectedPeersWithTransport() {
    // For WebSocket transport, we can't easily track individual peer connections
    // since it goes through a signaling server, but we can indicate transport availability
    return [{
      transport: 'websocket',
      transportId: this._multiTransportId || 'websocket',
      isSignalingServerConnected: this.isConnected
    }];
  }

  /**
   * Check if this transport can reach a peer (via signaling server)
   */
  canReachPeer(peerId) {
    return this.isConnected;
  }

  // Method to get peer address, conceptual, might not be needed if peerId is enough for signaling server
  getPeerAddress(peerId) {
    // For WebSocket transport, the peerId itself is usually the identifier used by the signaling server.
    // If the signaling server needed more (e.g. IP/port if it wasn't a pure relay), this would provide it.
    return peerId; 
  }

  // discoverPeers can be implemented if the signaling server supports a peer list request
  // For example:
  // discoverPeers() {
  //   if (this.ws && this.ws.readyState === WebSocket.OPEN) {
  //     this.ws.send(JSON.stringify({ type: 'get_peers', from: this.localPeerId }));
  //   }
  // }
}
