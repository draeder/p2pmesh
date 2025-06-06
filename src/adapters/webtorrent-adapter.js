// Simple EventEmitter implementation for browser compatibility
class SimpleEventEmitter {
  constructor() {
    this.events = {};
  }

  on(event, listener) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  }

  emit(event, ...args) {
    if (this.events[event]) {
      this.events[event].forEach(listener => {
        try {
          listener(...args);
        } catch (error) {
          console.error('Event listener error:', error);
        }
      });
    }
  }

  removeListener(event, listener) {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter(l => l !== listener);
    }
  }

  removeAllListeners(event) {
    if (event) {
      delete this.events[event];
    } else {
      this.events = {};
    }
  }
}

/**
 * WebTorrent Adapter
 * Handles BitTorrent extension protocol for P2PMesh messaging over WebTorrent wires.
 * Separates extension handling logic from the transport layer.
 */
export class WebTorrentAdapter extends SimpleEventEmitter {
  constructor(options = {}) {
    super();
    this.extensionName = 'p2pmesh';
    this.wires = new Map(); // peerId -> wire
    this.extensionHandlers = new Map(); // peerId -> extension handler
    this.sentHellos = new Set();
    this.localPeerId = null;
    this.options = options;
  }

  /**
   * Sets the local peer ID for this adapter instance
   */
  setLocalPeerId(localPeerId) {
    this.localPeerId = localPeerId;
  }

  /**
   * Handles a new wire connection from WebTorrent
   */
  handleNewWire(wire, remotePeerId) {
    if (!remotePeerId || remotePeerId === this.localPeerId) {
      if (!remotePeerId) {
        console.log(`WebTorrentAdapter: Generating temporary peer ID for wire without peer ID`);
        remotePeerId = this.generateTempPeerId();
      } else {
        console.log(`WebTorrentAdapter: Ignoring wire to self`);
        return null;
      }
    }

    // Check if we already have this wire
    if (this.wires.has(remotePeerId)) {
      console.log(`WebTorrentAdapter: Already have wire for peer ${remotePeerId}, ignoring duplicate`);
      return remotePeerId;
    }

    console.log(`WebTorrentAdapter: Setting up new wire for peer: ${remotePeerId}`);
    
    // Store the wire connection
    this.wires.set(remotePeerId, wire);

    // Set up wire event handlers
    wire.on('close', () => {
      console.log(`WebTorrentAdapter: Wire closed for peer: ${remotePeerId}`);
      this.wires.delete(remotePeerId);
      this.extensionHandlers.delete(remotePeerId);
      this.sentHellos.delete(remotePeerId);
      this.emit('peer_disconnected', { peerId: remotePeerId });
    });

    wire.on('error', (err) => {
      console.error(`WebTorrentAdapter: Wire error for peer ${remotePeerId}:`, err);
      this.wires.delete(remotePeerId);
      this.extensionHandlers.delete(remotePeerId);
      this.sentHellos.delete(remotePeerId);
    });

    // Set up the P2PMesh extension protocol
    this.setupExtensionProtocol(wire, remotePeerId);

    // Send initial hello message after brief delay
    setTimeout(() => {
      this.sendHelloMessage(remotePeerId);
    }, 200);

    return remotePeerId;
  }

  /**
   * Sets up BitTorrent extended protocol for P2PMesh messages
   */
  setupExtensionProtocol(wire, remotePeerId) {
    try {
      console.log(`WebTorrentAdapter: Setting up extension protocol with ${remotePeerId}`);
      
      // Create a proper WebTorrent extension constructor
      const self = this;
      function P2PMeshExtension(wire) {
        // Handle incoming extension messages
        this.onMessage = function(buf) {
          try {
            console.log(`WebTorrentAdapter: Received raw extension message from ${remotePeerId}, length: ${buf?.length || 0} bytes`);
            
            // Convert buffer to string with proper encoding
            let messageStr;
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buf)) {
              messageStr = buf.toString('utf8');
            } else if (buf instanceof Uint8Array) {
              const decoder = new TextDecoder('utf-8');
              messageStr = decoder.decode(buf);
            } else {
              messageStr = String(buf);
            }
            
            // Clean up the message string
            messageStr = messageStr.trim().replace(/\0/g, '');
            
            // Find the JSON part if there are extra bytes
            let jsonStart = messageStr.indexOf('{');
            let jsonEnd = messageStr.lastIndexOf('}');
            
            if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
              messageStr = messageStr.substring(jsonStart, jsonEnd + 1);
            }
            
            // Parse and handle the message
            const message = JSON.parse(messageStr);
            console.log(`WebTorrentAdapter: Parsed extension message from ${remotePeerId}, type: ${message.type || 'unknown'}`);
            self.handleP2PMeshMessage(remotePeerId, message);
          } catch (error) {
            console.error(`WebTorrentAdapter: Failed to parse P2PMesh message from ${remotePeerId}:`, error.message);
          }
        };
        
        // Send method for the extension
        this.send = function(message) {
          try {
            console.log(`WebTorrentAdapter: Sending extension message to ${remotePeerId}, type: ${message.type || 'unknown'}`);
            
            const messageText = JSON.stringify(message);
            let messageBuffer;
            
            if (typeof Buffer !== 'undefined') {
              messageBuffer = Buffer.from(messageText, 'utf8');
            } else {
              const encoder = new TextEncoder();
              messageBuffer = encoder.encode(messageText);
            }
            
            wire.extended(self.extensionName, messageBuffer);
            console.log(`WebTorrentAdapter: Extension message sent to ${remotePeerId}`);
          } catch (error) {
            console.error(`WebTorrentAdapter: Failed to send extension message:`, error.message);
          }
        };
      }
      
      // Set the extension name on the constructor
      P2PMeshExtension.prototype.name = this.extensionName;
      
      // Register the extension with WebTorrent
      if (wire.use && typeof wire.use === 'function') {
        try {
          wire.use(P2PMeshExtension);
          console.log(`WebTorrentAdapter: Successfully registered p2pmesh extension for ${remotePeerId}`);
        } catch (useError) {
          console.error(`WebTorrentAdapter: Failed to use extension for ${remotePeerId}:`, useError);
          this.setupFallbackExtension(wire, remotePeerId);
        }
      } else {
        console.log(`WebTorrentAdapter: Wire.use not available, using fallback extension setup for ${remotePeerId}`);
        this.setupFallbackExtension(wire, remotePeerId);
      }

      // Store extension info for sending
      wire._p2pmeshExtension = this.extensionName;
      wire._p2pmeshSend = (message) => {
        try {
          console.log(`WebTorrentAdapter: Preparing to send message to ${remotePeerId}, type: ${message.type || 'unknown'}`);
          
          const messageText = JSON.stringify(message);
          let messageBuffer;
          
          if (typeof Buffer !== 'undefined') {
            messageBuffer = Buffer.from(messageText);
          } else {
            const encoder = new TextEncoder();
            messageBuffer = encoder.encode(messageText);
          }
          
          if (wire.extended) {
            wire.extended(this.extensionName, messageBuffer);
            console.log(`WebTorrentAdapter: Extension message sent to ${remotePeerId}`);
          } else {
            console.warn(`WebTorrentAdapter: No extended method available for ${remotePeerId}`);
          }
        } catch (error) {
          console.error(`WebTorrentAdapter: Failed to send extension message to ${remotePeerId}:`, error.message);
        }
      };
      
    } catch (error) {
      console.error(`WebTorrentAdapter: Failed to setup extension protocol with ${remotePeerId}:`, error);
      this.setupFallbackExtension(wire, remotePeerId);
    }
  }

  /**
   * Sets up fallback extension handling when wire.use() fails
   */
  setupFallbackExtension(wire, remotePeerId) {
    try {
      console.log(`WebTorrentAdapter: Setting up fallback extension for ${remotePeerId}`);
      
      // Register extension in handshake
      if (!wire.extendedHandshake) {
        wire.extendedHandshake = {};
      }
      wire.extendedHandshake[this.extensionName] = 1;

      // Handle extended messages
      wire.on('extended', (ext, buf) => {
        if (ext === this.extensionName || (typeof ext === 'number' && wire.peerExtendedMapping && wire.peerExtendedMapping[ext] === this.extensionName)) {
          try {
            const message = JSON.parse(buf.toString());
            console.log(`WebTorrentAdapter: Received fallback extension message from ${remotePeerId}, type: ${message.type || 'unknown'}`);
            this.handleP2PMeshMessage(remotePeerId, message);
          } catch (error) {
            console.error(`WebTorrentAdapter: Failed to parse P2PMesh message from ${remotePeerId}:`, error.message);
          }
        }
      });
      
      console.log(`WebTorrentAdapter: Fallback extension setup complete for ${remotePeerId}`);
      
    } catch (error) {
      console.error(`WebTorrentAdapter: Failed to setup fallback extension for ${remotePeerId}:`, error);
    }
  }

  /**
   * Sends initial hello message to establish P2PMesh communication
   */
  sendHelloMessage(remotePeerId) {
    if (this.sentHellos.has(remotePeerId)) {
      return;
    }
    
    console.log(`WebTorrentAdapter: Sending hello message to peer ${remotePeerId}`);
    
    const helloMessage = {
      type: 'hello',
      from: this.localPeerId,
      timestamp: Date.now(),
      p2pmeshProtocol: '1.0'
    };
    
    this.send(remotePeerId, helloMessage);
    this.sentHellos.add(remotePeerId);
  }

  /**
   * Sends hello response message
   */
  sendHelloResponse(remotePeerId) {
    console.log(`WebTorrentAdapter: Sending hello response to peer ${remotePeerId}`);
    
    const response = {
      type: 'hello_response',
      from: this.localPeerId,
      timestamp: Date.now(),
      p2pmeshProtocol: '1.0'
    };
    
    this.send(remotePeerId, response);
    this.sentHellos.add(remotePeerId);
    
    // Mark peer as ready immediately after sending hello response
    this.markPeerReady(remotePeerId);
  }

  /**
   * Marks a peer as ready for P2PMesh communication
   */
  markPeerReady(peerId) {
    console.log(`WebTorrentAdapter: Peer ${peerId} is ready for P2PMesh communication`);
    this.emit('peer_ready', { peerId });
  }

  /**
   * Determines if this peer should initiate connection based on peer ID comparison
   */
  shouldInitiateConnection(remotePeerId) {
    return this.localPeerId > remotePeerId;
  }

  /**
   * Handles P2PMesh protocol messages received via WebTorrent
   */
  handleP2PMeshMessage(fromPeerId, message) {
    console.log(`WebTorrentAdapter: Received P2PMesh message from ${fromPeerId}, type: ${message.type || 'unknown'}`);

    switch (message.type) {
      case 'hello':
        console.log(`WebTorrentAdapter: Received hello from ${fromPeerId}, sending response`);
        this.sendHelloResponse(fromPeerId);
        break;
        
      case 'hello_response':
        console.log(`WebTorrentAdapter: Received hello response from ${fromPeerId}`);
        this.markPeerReady(fromPeerId);
        if (this.shouldInitiateConnection(fromPeerId)) {
          setTimeout(() => {
            console.log(`WebTorrentAdapter: Initiating connect request to ${fromPeerId} (we are initiator)`);
            this.emit('connect_request', {
              from: fromPeerId
            });
          }, 100);
        } else {
          console.log(`WebTorrentAdapter: Waiting for connect request from ${fromPeerId} (they are initiator)`);
        }
        break;

      case 'signal':
        console.log(`WebTorrentAdapter: Received WebRTC signal from ${fromPeerId}, forwarding to transport`);
        this.emit('signal', {
          from: fromPeerId,
          signal: message.signal
        });
        break;

      case 'connect_request':
        console.log(`WebTorrentAdapter: Received connect request from ${fromPeerId}`);
        if (this.shouldInitiateConnection(fromPeerId)) {
          console.log(`WebTorrentAdapter: Rejecting connect request from ${fromPeerId}, we should initiate`);
          this.send(fromPeerId, {
            type: 'connection_rejected',
            from: this.localPeerId,
            reason: 'initiator_conflict'
          });
          setTimeout(() => {
            console.log(`WebTorrentAdapter: Sending our own connect request to ${fromPeerId}`);
            this.emit('connect_request', {
              from: fromPeerId
            });
          }, 200);
        } else {
          console.log(`WebTorrentAdapter: Accepting connect request from ${fromPeerId}`);
          this.emit('connect_request', {
            from: fromPeerId,
            data: message.data
          });
        }
        break;

      case 'kademlia_rpc':
        console.log(`WebTorrentAdapter: Received Kademlia RPC from ${fromPeerId}, type: ${message.rpcMessage?.type || 'unknown'}`);
        this.emit('kademlia_rpc_message', {
          from: fromPeerId,
          rpcMessage: message.rpcMessage
        });
        break;

      case 'kademlia_rpc_reply':
        console.log(`WebTorrentAdapter: Received Kademlia RPC reply from ${fromPeerId}`);
        this.emit('kademlia_rpc_reply', {
          from: fromPeerId,
          rpcMessage: message.rpcMessage
        });
        break;

      case 'connection_rejected':
        console.log(`WebTorrentAdapter: Connection rejected by ${fromPeerId}, reason: ${message.reason}`);
        if (message.reason !== 'initiator_conflict') {
          this.emit('connection_rejected', {
            from: fromPeerId,
            reason: message.reason,
            alternatives: message.alternatives
          });
        }
        break;

      default:
        console.warn(`WebTorrentAdapter: Unknown P2PMesh message type: ${message.type}`);
    }
  }

  /**
   * Sends a message to a specific peer via WebTorrent wire protocol
   */
  send(toPeerId, message) {
    const wire = this.wires.get(toPeerId);
    
    if (!wire) {
      console.warn(`WebTorrentAdapter: No wire connection to peer ${toPeerId}`);
      return false;
    }

    try {
      console.log(`WebTorrentAdapter: Sending message to ${toPeerId}, type: ${message.type || 'unknown'}`);
      
      // FIXED: For WebRTC signals, send them directly through the wire
      if (message.type === 'signal') {
        const signalMessage = {
          type: 'signal',
          from: this.localPeerId,
          signal: message.signal
        };
        
        if (wire._p2pmeshSend) {
          wire._p2pmeshSend(signalMessage);
          return true;
        }
      }
      
      // For other messages, use the existing send logic
      if (wire._p2pmeshSend) {
        wire._p2pmeshSend(message);
        return true;
      }
      
      // Fallback to manual extension sending
      const messageText = JSON.stringify(message);
      let messageBuffer;
      
      if (typeof Buffer !== 'undefined') {
        messageBuffer = Buffer.from(messageText);
      } else {
        const encoder = new TextEncoder();
        messageBuffer = encoder.encode(messageText);
      }
      
      if (wire._p2pmeshExtension && wire.extended) {
        wire.extended(wire._p2pmeshExtension, messageBuffer);
        console.log(`WebTorrentAdapter: Sent fallback extension message to ${toPeerId}`);
        return true;
      } else {
        console.warn(`WebTorrentAdapter: P2PMesh extension not available for peer ${toPeerId}`);
        return false;
      }
    } catch (error) {
      console.error(`WebTorrentAdapter: Failed to send message to ${toPeerId}:`, error);
      return false;
    }
  }

  /**
   * Sends a Kademlia RPC message and returns a promise for the reply
   */
  async sendKademliaRpc(toPeerId, kademliaRpcMessage) {
    return new Promise((resolve, reject) => {
      const rpcId = this.generateRpcId();
      const timeoutMs = 5000;

      // Set up reply handler
      const replyHandler = (data) => {
        if (data.from === toPeerId && data.rpcMessage?.inReplyTo === rpcId) {
          this.removeListener('kademlia_rpc_reply', replyHandler);
          clearTimeout(timeout);
          resolve(data.rpcMessage);
        }
      };

      const timeout = setTimeout(() => {
        this.removeListener('kademlia_rpc_reply', replyHandler);
        reject(new Error(`Kademlia RPC timeout for peer ${toPeerId}`));
      }, timeoutMs);

      this.on('kademlia_rpc_reply', replyHandler);

      // Send the RPC message
      const message = {
        type: 'kademlia_rpc',
        rpcMessage: {
          ...kademliaRpcMessage,
          rpcId: rpcId
        }
      };

      console.log(`WebTorrentAdapter: Sending Kademlia RPC to ${toPeerId}, type: ${kademliaRpcMessage.type || 'unknown'}, rpcId: ${rpcId}`);
      
      const sent = this.send(toPeerId, message);
      if (!sent) {
        clearTimeout(timeout);
        this.removeListener('kademlia_rpc_reply', replyHandler);
        reject(new Error(`Failed to send Kademlia RPC to peer ${toPeerId}`));
      }
    });
  }

  /**
   * Generates a temporary peer ID if one is not available
   */
  generateTempPeerId() {
    const randomBytes = new Uint8Array(20);
    
    if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(randomBytes);
    } else {
      for (let i = 0; i < 20; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    
    return Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generates a unique RPC ID for Kademlia messages
   */
  generateRpcId() {
    return Math.random().toString(36).substr(2, 16) + Math.random().toString(36).substr(2, 16);
  }

  /**
   * Gets all connected peer IDs
   */
  getConnectedPeers() {
    return Array.from(this.wires.keys());
  }

  /**
   * Checks if a peer is connected
   */
  hasPeer(peerId) {
    return this.wires.has(peerId);
  }

  /**
   * Disconnects all wires and cleans up
   */
  disconnect() {
    console.log(`WebTorrentAdapter: Disconnecting ${this.wires.size} wires`);
    
    for (const [peerId, wire] of this.wires) {
      try {
        wire.destroy();
      } catch (e) {
        console.warn(`WebTorrentAdapter: Error destroying wire for ${peerId}:`, e.message);
      }
    }
    
    this.wires.clear();
    this.extensionHandlers.clear();
    this.sentHellos.clear();
    this.removeAllListeners();
  }
}
