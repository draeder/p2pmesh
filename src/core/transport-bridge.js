/**
 * Transport Bridge - Enables peer connectivity across different transports
 * This allows peers on WebSocket transport to communicate with peers on WebTorrent transport, etc.
 */
export class TransportBridge {
  constructor(options = {}) {
    this.localPeerId = options.localPeerId;
    this.transports = new Map(); // transportId -> transport instance
    this.peerTransportMap = new Map(); // peerId -> Set of transportIds where peer is available
    this.routingTable = new Map(); // peerId -> preferred transportId for routing
    this.messageRouting = new Map(); // messageId -> routing metadata
    this.crossTransportPeers = new Set(); // peers available across multiple transports
    
    // Event handling
    this._eventHandlers = new Map();
    
    // Bridge statistics
    this.stats = {
      crossTransportMessages: 0,
      routingFailures: 0,
      bridgedConnections: 0
    };
    
    console.log(`TransportBridge: Initialized for peer ${this.localPeerId}`);
  }

  /**
   * Event emitter methods
   */
  on(eventName, handler) {
    if (!this._eventHandlers.has(eventName)) {
      this._eventHandlers.set(eventName, []);
    }
    this._eventHandlers.get(eventName).push(handler);
  }

  emit(eventName, data) {
    if (this._eventHandlers.has(eventName)) {
      this._eventHandlers.get(eventName).forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`TransportBridge: Error in event handler for ${eventName}:`, error);
        }
      });
    }
  }

  /**
   * Register a transport with the bridge
   */
  registerTransport(transportId, transport) {
    this.transports.set(transportId, transport);
    console.log(`TransportBridge: Registered transport ${transportId}`);
    
    // Set up event handlers for this transport
    this.setupTransportEventHandlers(transportId, transport);
  }

  /**
   * Unregister a transport from the bridge
   */
  unregisterTransport(transportId) {
    const transport = this.transports.get(transportId);
    if (transport) {
      // Clean up peer mappings for this transport
      for (const [peerId, transportIds] of this.peerTransportMap.entries()) {
        transportIds.delete(transportId);
        if (transportIds.size === 0) {
          this.peerTransportMap.delete(peerId);
          this.routingTable.delete(peerId);
          this.crossTransportPeers.delete(peerId);
        } else if (transportIds.size === 1) {
          this.crossTransportPeers.delete(peerId);
        }
      }
      
      this.transports.delete(transportId);
      console.log(`TransportBridge: Unregistered transport ${transportId}`);
    }
  }

  /**
   * Set up event handlers for a transport to enable bridging
   */
  setupTransportEventHandlers(transportId, transport) {
    // Listen for peer discoveries
    transport.on('peer_discovered', ({ peerId, address }) => {
      this.addPeerToTransport(peerId, transportId);
    });

    transport.on('peer_joined', ({ peerId }) => {
      this.addPeerToTransport(peerId, transportId);
    });

    transport.on('peer_ready', ({ peerId }) => {
      this.addPeerToTransport(peerId, transportId);
    });

    transport.on('peer_left', ({ peerId }) => {
      this.removePeerFromTransport(peerId, transportId);
    });

    transport.on('peer_disconnected', ({ peerId }) => {
      this.removePeerFromTransport(peerId, transportId);
    });

    // CRITICAL FIX: Listen for messages and forward them to other transports/mesh layer
    transport.on('message', ({ from, message }) => {
      console.log(`TransportBridge: Message received on ${transportId} from ${from}:`, message?.type);
      
      // FIXED: Ensure message exists before handling
      if (message) {
        this.handleMessage(from, message, transportId);
        
        // Forward to mesh layer for processing
        this.emit('message', { from, message, transportId });
      } else {
        console.warn(`TransportBridge: Ignoring null/undefined message from ${from} on ${transportId}`);
      }
    });

    transport.on('gossip_message', ({ from, message }) => {
      console.log(`TransportBridge: Gossip message received on ${transportId} from ${from}`);
      
      // FIXED: Ensure message exists before handling
      if (message) {
        this.handleGossipMessage(from, message, transportId);
        
        // Forward to mesh layer for gossip processing
        this.emit('gossip_message', { from, message, transportId });
      } else {
        console.warn(`TransportBridge: Ignoring null/undefined gossip message from ${from} on ${transportId}`);
      }
    });
  }

  /**
   * Add a peer to a specific transport
   */
  addPeerToTransport(peerId, transportId) {
    if (peerId === this.localPeerId) return;
    
    if (!this.peerTransportMap.has(peerId)) {
      this.peerTransportMap.set(peerId, new Set());
    }
    
    const transportIds = this.peerTransportMap.get(peerId);
    const wasMultiTransport = transportIds.size > 1;
    
    transportIds.add(transportId);
    
    // Update routing preference (prefer newest transport)
    this.routingTable.set(peerId, transportId);
    
    // Check if peer is now available across multiple transports
    if (transportIds.size > 1) {
      if (!wasMultiTransport) {
        this.crossTransportPeers.add(peerId);
        this.stats.bridgedConnections++;
        console.log(`TransportBridge: Peer ${peerId} is now bridged across ${transportIds.size} transports`);
      }
    }
    
    console.log(`TransportBridge: Added peer ${peerId} to transport ${transportId} (total transports: ${transportIds.size})`);
  }

  /**
   * Remove a peer from a specific transport
   */
  removePeerFromTransport(peerId, transportId) {
    const transportIds = this.peerTransportMap.get(peerId);
    if (!transportIds) return;
    
    const wasMultiTransport = transportIds.size > 1;
    transportIds.delete(transportId);
    
    if (transportIds.size === 0) {
      this.peerTransportMap.delete(peerId);
      this.routingTable.delete(peerId);
      this.crossTransportPeers.delete(peerId);
    } else {
      // Update routing to use a different transport
      const remainingTransports = Array.from(transportIds);
      this.routingTable.set(peerId, remainingTransports[0]);
      
      if (transportIds.size === 1 && wasMultiTransport) {
        this.crossTransportPeers.delete(peerId);
        console.log(`TransportBridge: Peer ${peerId} no longer bridged (only on ${remainingTransports[0]})`);
      }
    }
    
    console.log(`TransportBridge: Removed peer ${peerId} from transport ${transportId} (remaining transports: ${transportIds.size})`);
  }

  /**
   * Send a message to a peer using the best available transport
   */
  sendToPeer(peerId, message) {
    const preferredTransport = this.routingTable.get(peerId);
    if (!preferredTransport) {
      console.warn(`TransportBridge: No route to peer ${peerId}`);
      this.stats.routingFailures++;
      return false;
    }
    
    const transport = this.transports.get(preferredTransport);
    if (!transport) {
      console.warn(`TransportBridge: Transport ${preferredTransport} not available for peer ${peerId}`);
      this.stats.routingFailures++;
      return false;
    }
    
    try {
      // Add bridge metadata to message
      const bridgedMessage = {
        ...message,
        _bridge: {
          sourceTransport: preferredTransport,
          routedBy: this.localPeerId,
          timestamp: Date.now()
        }
      };
      
      const success = transport.send(peerId, bridgedMessage);
      if (success) {
        this.stats.crossTransportMessages++;
        console.log(`TransportBridge: Routed message to ${peerId} via ${preferredTransport}`);
      }
      return success;
    } catch (error) {
      console.error(`TransportBridge: Failed to send message to ${peerId} via ${preferredTransport}:`, error);
      this.stats.routingFailures++;
      return false;
    }
  }

  /**
   * Broadcast a message to all peers across all transports
   */
  broadcastToAll(message) {
    const allPeers = new Set();
    
    // Collect all unique peers across all transports
    for (const [peerId, transportIds] of this.peerTransportMap.entries()) {
      allPeers.add(peerId);
    }
    
    console.log(`TransportBridge: Broadcasting to ${allPeers.size} unique peers across ${this.transports.size} transports`);
    
    let successCount = 0;
    for (const peerId of allPeers) {
      if (this.sendToPeer(peerId, message)) {
        successCount++;
      }
    }
    
    return { sent: successCount, total: allPeers.size };
  }

  /**
   * Handle incoming messages for potential cross-transport routing
   */
  handleMessage(from, message, sourceTransportId) {
    // FIXED: Add null checks to prevent undefined access
    if (!message) {
      console.warn(`TransportBridge: Received null/undefined message from ${from} via ${sourceTransportId}`);
      return;
    }
    
    console.log(`TransportBridge: Handling message from ${from} via ${sourceTransportId}:`, message?.type || 'unknown');
    
    // Check if this message needs to be relayed to peers on other transports
    if (message._bridge && message._bridge.routedBy === this.localPeerId) {
      console.log(`TransportBridge: Preventing message routing loop from ${from}`);
      return; // Prevent routing loops
    }
    
    // CRITICAL: If this is a gossip/broadcast message, handle it specially
    if (message.type === 'gossip' || message.type === 'broadcast' || message.messageId) {
      console.log(`TransportBridge: Detected gossip message in general message handler, delegating to gossip handler`);
      this.handleGossipMessage(from, message, sourceTransportId);
      return;
    }
    
    // If the sender is available on multiple transports but the message came from one,
    // we might need to relay it to peers who can only reach us via other transports
    const senderTransports = this.peerTransportMap.get(from);
    if (senderTransports && senderTransports.size > 1) {
      console.log(`TransportBridge: Message from multi-transport peer ${from} via ${sourceTransportId}`);
    }
  }

  /**
   * Handle gossip messages for cross-transport propagation
   */
  handleGossipMessage(from, message, sourceTransportId) {
    // FIXED: Add null checks to prevent undefined access
    if (!message) {
      console.warn(`TransportBridge: Received null/undefined gossip message from ${from} via ${sourceTransportId}`);
      return;
    }
    
    console.log(`TransportBridge: Handling gossip message from ${from} via ${sourceTransportId}:`, message?.type || 'unknown');
    
    // Enhanced gossip routing across transports
    if (message._bridge && message._bridge.routedBy === this.localPeerId) {
      console.log(`TransportBridge: Preventing gossip routing loop from ${from}`);
      return; // Prevent routing loops
    }
    
    // CRITICAL: Relay gossip to ALL other transports to ensure cross-transport propagation
    let relayCount = 0;
    for (const [transportId, transport] of this.transports.entries()) {
      if (transportId !== sourceTransportId) {
        try {
          const bridgedMessage = {
            ...(message || {}),
            _bridge: {
              sourceTransport: sourceTransportId,
              routedBy: this.localPeerId,
              timestamp: Date.now()
            }
          };
          
          // Use broadcast if available, otherwise send to all connected peers
          if (typeof transport.broadcast === 'function') {
            transport.broadcast(bridgedMessage);
            relayCount++;
            console.log(`TransportBridge: Relayed gossip via broadcast from ${sourceTransportId} to ${transportId}`);
          } else {
            // Send to individual peers on this transport
            const connectedPeers = transport.getConnectedPeers ? transport.getConnectedPeers() : [];
            for (const peerId of connectedPeers) {
              if (transport.send(peerId, bridgedMessage)) {
                relayCount++;
              }
            }
            console.log(`TransportBridge: Relayed gossip to ${connectedPeers.length} peers on ${transportId}`);
          }
        } catch (error) {
          console.error(`TransportBridge: Failed to relay gossip to ${transportId}:`, error);
        }
      }
    }
    
    console.log(`TransportBridge: Successfully relayed gossip message to ${relayCount} targets`);
  }

  /**
   * Get all peers that are available across multiple transports
   */
  getCrossTransportPeers() {
    return Array.from(this.crossTransportPeers);
  }

  /**
   * Get transport availability for a specific peer
   */
  getPeerTransports(peerId) {
    const transportIds = this.peerTransportMap.get(peerId);
    return transportIds ? Array.from(transportIds) : [];
  }

  /**
   * Get the preferred transport for reaching a peer
   */
  getPreferredTransport(peerId) {
    return this.routingTable.get(peerId) || null;
  }

  /**
   * Get all unique peers across all transports
   */
  getAllPeers() {
    return Array.from(this.peerTransportMap.keys());
  }

  /**
   * Get bridge statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalTransports: this.transports.size,
      totalPeers: this.peerTransportMap.size,
      crossTransportPeers: this.crossTransportPeers.size,
      routingTableSize: this.routingTable.size
    };
  }

  /**
   * Get detailed connectivity information
   */
  getConnectivityReport() {
    const report = {
      transports: Array.from(this.transports.keys()),
      peers: {},
      crossTransportPeers: Array.from(this.crossTransportPeers),
      stats: this.getStats()
    };
    
    for (const [peerId, transportIds] of this.peerTransportMap.entries()) {
      report.peers[peerId] = {
        transports: Array.from(transportIds),
        preferredTransport: this.routingTable.get(peerId),
        isBridged: transportIds.size > 1
      };
    }
    
    return report;
  }

  /**
   * Get transport information for all peers (for UI display)
   */
  getPeerTransportInfo() {
    const peerInfo = {};
    
    for (const [peerId, transportIds] of this.peerTransportMap.entries()) {
      const transports = Array.from(transportIds);
      peerInfo[peerId] = {
        transports,
        transportCount: transports.length,
        preferredTransport: this.routingTable.get(peerId),
        isMultiTransport: transports.length > 1,
        transportDetails: transports.map(transportId => {
          const transport = this.transports.get(transportId);
          return {
            id: transportId,
            type: transport?.getTransportType ? transport.getTransportType() : 'unknown',
            connected: transport?.hasPeerConnected ? transport.hasPeerConnected(peerId) : true
          };
        })
      };
    }
    
    return peerInfo;
  }

  /**
   * Get transport connectivity summary for UI
   */
  getConnectivitySummary() {
    const summary = {
      totalPeers: this.peerTransportMap.size,
      totalTransports: this.transports.size,
      multiTransportPeers: this.crossTransportPeers.size,
      transportBreakdown: {},
      peersByTransport: {}
    };
    
    // Count peers by transport
    for (const [transportId] of this.transports.entries()) {
      summary.transportBreakdown[transportId] = 0;
      summary.peersByTransport[transportId] = [];
    }
    
    for (const [peerId, transportIds] of this.peerTransportMap.entries()) {
      for (const transportId of transportIds) {
        summary.transportBreakdown[transportId]++;
        summary.peersByTransport[transportId].push(peerId);
      }
    }
    
    return summary;
  }

  /**
   * Get specific peer's transport information
   */
  getPeerTransportDetails(peerId) {
    const transportIds = this.peerTransportMap.get(peerId);
    if (!transportIds) return null;
    
    return {
      peerId,
      transports: Array.from(transportIds),
      preferredTransport: this.routingTable.get(peerId),
      isMultiTransport: transportIds.size > 1,
      transportDetails: Array.from(transportIds).map(transportId => {
        const transport = this.transports.get(transportId);
        return {
          id: transportId,
          type: transport?.getTransportType ? transport.getTransportType() : 'unknown',
          multiTransportId: transport?.getMultiTransportId ? transport.getMultiTransportId() : null
        };
      })
    };
  }

  /**
   * Clean up the bridge
   */
  destroy() {
    this.transports.clear();
    this.peerTransportMap.clear();
    this.routingTable.clear();
    this.crossTransportPeers.clear();
    this.messageRouting.clear();
    console.log(`TransportBridge: Destroyed for peer ${this.localPeerId}`);
  }
}