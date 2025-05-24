// src/p2p-mesh.js
import { KademliaDHT, K as KADEMLIA_K_VALUE } from './kademlia.js';
import { GossipProtocol } from './gossip.js';
import { PeerManager } from './peer-manager.js';
import { PeerDiscovery } from './peer-discovery.js';
import { generatePeerId } from './utils/peer-id-generator.js';
import { loadSimplePeer } from './utils/simple-peer-loader.js';

/**
 * Main P2PMesh class that orchestrates all components
 */
export class P2PMesh {
  constructor(options = {}) {
    this.options = options;
    this.localPeerId = options.peerId;
    this.maxPeers = options.maxPeers || 5;
    this.iceServers = options.iceServers;
    this.transportInstance = options.transport;
    this.kademliaK = options.kademliaK || KADEMLIA_K_VALUE;
    this.bootstrapNodes = options.bootstrapNodes || [];
    
    this.eventHandlers = {}; // Object to store event handlers
    this._cleanupIntervals = []; // Store intervals for cleanup
    
    // Components will be initialized in init()
    this.kademliaInstance = null;
    this.peerManager = null;
    this.peerDiscovery = null;
    this.gossipProtocol = null;
  }

  /**
   * Initializes the P2PMesh instance
   */
  async init() {
    // Ensure SimplePeer is loaded
    await loadSimplePeer();

    // Generate peer ID if not provided
    if (!this.localPeerId) {
      this.localPeerId = await generatePeerId();
    }

    console.log(`Initializing P2PMesh with ID: ${this.localPeerId}`);

    // FIXED: Initialize Kademlia DHT (transport only for initial bootstrapping)
    this.kademliaInstance = new KademliaDHT(this.localPeerId, this.transportInstance, { k: this.kademliaK });

    // Set up transport event handlers for initial bootstrapping only
    this.setupTransportEventHandlers();

    // Initialize PeerManager
    this.peerManager = new PeerManager({
      localPeerId: this.localPeerId,
      maxPeers: this.maxPeers,
      iceServers: this.iceServers,
      kademlia: this.kademliaInstance,
      transportInstance: this.transportInstance,
      eventHandlers: {
        'peer:connect': (peerId) => this.emit('peer:connect', peerId),
        'peer:disconnect': (peerId) => this.emit('peer:disconnect', peerId),
        'peer:timeout': (peerId) => this.emit('peer:timeout', peerId),
        'peer:error': (data) => this.emit('peer:error', data),
        'peer:evicted': (data) => this.emit('peer:evicted', data),
        'message': (data) => this.emit('message', data),
        'signal': (data) => {
          // FIXED: Don't emit signal events to prevent circular handling
          // Signals are already handled directly by transport event handlers
          console.log(`Signal event from peer manager (not emitted to prevent circular handling): ${data.from}`);
        },
        'gossip': (data, remotePeerId) => this.gossipProtocol?.handleIncomingMessage(data, remotePeerId),
        'reconnection_data': (data, remotePeerId) => this.handleReconnectionData(data, remotePeerId),
        // FIXED: Handle Kademlia RPC via direct WebRTC
        'kademlia_rpc': (data, remotePeerId) => this.handleKademliaRpc(data, remotePeerId)
      }
    });

    // FIXED: Wire up Kademlia with PeerManager for direct WebRTC communication
    this.kademliaInstance.setPeerManager(this.peerManager);
    
    // FIXED: Set up bidirectional reference for routing table connection status checking
    this.kademliaInstance.routingTable.dht = this.kademliaInstance;

    // Initialize PeerDiscovery
    this.peerDiscovery = new PeerDiscovery({
      localPeerId: this.localPeerId,
      kademlia: this.kademliaInstance,
      peerManager: this.peerManager,
      maxPeers: this.maxPeers,
      eventHandlers: this.eventHandlers
    });

    // Initialize Gossip Protocol
    this.gossipProtocol = new GossipProtocol({
      localPeerId: this.localPeerId,
      dht: this.kademliaInstance,
      sendFunction: (peerId, data) => this.peerManager.sendRawToPeer(peerId, data),
      getPeerConnectionStatus: (peerId) => this.getPeerConnectionStatus(peerId)
    });

    // Connect gossip protocol to mesh event system
    this.gossipProtocol.subscribe('*', ({ topic, payload, originPeerId }) => {
      // Only emit if there's a message handler
      if (this.eventHandlers['message']) {
        console.log(`Gossip: Forwarding message from ${originPeerId} on topic '${topic}' to application`); 
        this.eventHandlers['message']({
          from: originPeerId,
          data: { type: 'broadcast', topic, payload }
        });
      }
    });

    // Set up transport event handlers for peer connections
    this.setupPeerConnectionHandlers();
  }

  /**
   * FIXED: Handle Kademlia RPC messages via direct WebRTC
   * @param {Object} data - Kademlia RPC data
   * @param {string} remotePeerId - Peer ID that sent the RPC
   */
  handleKademliaRpc(data, remotePeerId) {
    if (data.message) {
      // Check if this is a response to a pending RPC
      if (data.message.inReplyTo) {
        console.log(`P2PMesh: Received Kademlia RPC response via WebRTC from ${remotePeerId}`);
        this.kademliaInstance.handleIncomingRpcResponse(remotePeerId, data.message);
      } else {
        // This is a new RPC request
        console.log(`P2PMesh: Received Kademlia RPC request via WebRTC from ${remotePeerId}`);
        this.kademliaInstance.handleIncomingRpc(remotePeerId, data.message);
      }
    }
  }

  /**
   * FIXED: Sets up transport event handlers for initial bootstrapping only
   * Kademlia RPC will NOT go through WebSocket transport
   */
  setupTransportEventHandlers() {
    if (typeof this.transportInstance.on === 'function') {
      // REMOVED: kademlia_rpc_message handler - now uses direct WebRTC

      // Listen for bootstrap peers provided by the transport (e.g., from signaling server)
      this.transportInstance.on('bootstrap_peers', async ({ peers: newBootstrapPeers }) => {
        if (newBootstrapPeers && newBootstrapPeers.length > 0) {
          console.log('P2PMesh: Received bootstrap_peers from transport:', newBootstrapPeers);
          // Map to {id, address} format; for WebSocket transport, address can be the id.
          const formattedPeers = newBootstrapPeers.map(p => ({ id: p.id, address: p.id }));
          await this.kademliaInstance.bootstrap(formattedPeers);
          // Optionally, try to connect to some of these new peers immediately
          // await this.peerDiscovery.findAndConnectPeers(); // Be cautious of calling this too often or in loops
        }
      });

      // Listen for batched signals from SignalingOptimizer
      this.transportInstance.on('batched_signals', ({ from, signals, batchTimestamp }) => {
        console.log(`P2PMesh: Received batched signals from ${from} (${signals.length} signals)`);
        // Process each signal in the batch
        signals.forEach(signal => {
          this.handleIncomingSignal(from, signal);
        });
      });
    } else {
      console.warn('P2PMesh: Transport does not support .on method for bootstrap_peers.');
    }
  }

  /**
   * Sets up transport event handlers for peer connections
   */
  setupPeerConnectionHandlers() {
    this.transportInstance.on('signal', ({ from, signal }) => {
      this.handleIncomingSignal(from, signal);
    });

    this.transportInstance.on('connect_request', ({ from }) => {
      this.handleConnectRequest(from);
    });

    // FIXED: Handle connection rejections intelligently
    this.transportInstance.on('connection_rejected', ({ from, reason, alternativePeers }) => {
      this.handleConnectionRejection(from, reason, alternativePeers);
    });
  }

  /**
   * FIXED: Handle connection rejections and use alternative peers
   * @param {string} from - Peer that rejected the connection
   * @param {string} reason - Reason for rejection
   * @param {Array} alternativePeers - Alternative peers suggested
   */
  async handleConnectionRejection(from, reason, alternativePeers) {
    console.log(`P2PMesh: Connection rejected by ${from} (${reason}), received ${alternativePeers?.length || 0} alternative peers`);
    
    // Clean up the failed connection attempt
    const peers = this.peerManager.getPeers();
    if (peers.has(from)) {
      const peer = peers.get(from);
      if (peer && !peer.connected) {
        console.log(`P2PMesh: Cleaning up failed connection attempt to ${from}`);
        peer.destroy();
        peers.delete(from);
      }
    }
    
    // Store alternative peers for future discovery
    if (alternativePeers && alternativePeers.length > 0) {
      console.log(`P2PMesh: Storing ${alternativePeers.length} alternative peers for future connections`);
      this.peerDiscovery.storeReconnectionData(alternativePeers);
      
      // ENHANCED: Try connecting to alternative peers immediately if we're under-connected
      const currentPeerCount = this.peerManager.getPeerCount();
      if (currentPeerCount < Math.floor(this.maxPeers * 0.5)) {
        console.log(`P2PMesh: Under-connected (${currentPeerCount}/${this.maxPeers}), trying alternative peers immediately`);
        
        // Try up to 2 alternative peers with delays
        const peersToTry = alternativePeers
          .filter(peerId => peerId !== this.localPeerId && !peers.has(peerId))
          .slice(0, 2);
        
        for (const altPeerId of peersToTry) {
          if (this.peerManager.getPeerCount() >= this.maxPeers) break;
          
          try {
            console.log(`P2PMesh: Attempting connection to alternative peer: ${altPeerId}`);
            await this.peerManager.requestConnection(altPeerId, true);
            
            // Add delay between attempts
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            console.error(`P2PMesh: Failed to connect to alternative peer ${altPeerId}:`, error);
          }
        }
      }
    }
  }

  /**
   * FIXED: Handles incoming WebRTC signals with proper state management
   * @param {string} from - Peer ID sending the signal
   * @param {Object} signal - WebRTC signal data
   */
  async handleIncomingSignal(from, signal) {
    const peers = this.peerManager.getPeers();
    let peer = peers.get(from);
    
    if (peer) {
      // FIXED: Check peer connection state before applying signal
      if (peer.destroyed) {
        console.log(`Ignoring signal from ${from}: peer connection is destroyed`);
        return;
      }
      
      // FIXED: Add proper signal state validation to prevent "stable" state errors
      if (!this.isSignalValidForCurrentState(peer, signal)) {
        console.log(`Ignoring signal from ${from}: signal type ${signal.type || 'candidate'} not valid for current state ${peer._pc?.signalingState || 'unknown'}`);
        return;
      }
      
      try {
        peer.signal(signal);
        console.log(`Applied ${signal.type || 'ICE candidate'} signal from ${from}`);
      } catch (error) {
        console.error(`Error applying signal from ${from}:`, error);
        // If signal application fails, clean up the connection
        if (peer && !peer.destroyed) {
          peer.destroy();
        }
        peers.delete(from);
        this.peerManager.peerConnectionAttempts.delete(from);
        this.peerManager.pendingConnections.delete(from);
      }
    } else {
      // Potentially a new peer trying to connect (WebRTC handshake)
      // Use deterministic initiator selection to prevent race conditions
      // The peer with the lexicographically smaller ID becomes the initiator
      const shouldBeInitiator = this.localPeerId < from;
      
      console.log(`Received signal for WebRTC from new peer ${from}, requesting connection (initiator: ${shouldBeInitiator}).`);
      const connectionAllowed = await this.peerManager.requestConnection(from, shouldBeInitiator);
      
      if (connectionAllowed) {
        const newPeer = peers.get(from);
        if (newPeer && !newPeer.destroyed) {
          try {
            newPeer.signal(signal);
            console.log(`Applied initial ${signal.type || 'ICE candidate'} signal from new peer ${from}`);
          } catch (error) {
            console.error(`Error applying initial signal from ${from}:`, error);
            // Clean up failed connection
            if (newPeer && !newPeer.destroyed) {
              newPeer.destroy();
            }
            peers.delete(from);
            this.peerManager.peerConnectionAttempts.delete(from);
            this.peerManager.pendingConnections.delete(from);
          }
        }
      } else {
        console.log(`Connection to ${from} was rejected due to maxPeers limit or other constraints.`);
        // Send rejection message with alternative peers
        const alternativePeers = this.peerManager.getAlternativePeers();
        this.transportInstance.send(from, {
          type: 'connection_rejected',
          reason: 'max_peers_reached',
          maxPeers: this.maxPeers,
          alternativePeers: alternativePeers
        });
      }
    }
  }

  /**
   * FIXED: Validates if a signal is appropriate for the current peer connection state
   * @param {Object} peer - SimplePeer instance
   * @param {Object} signal - WebRTC signal data
   * @returns {boolean} True if signal is valid for current state
   */
  isSignalValidForCurrentState(peer, signal) {
    // Always allow ICE candidates
    if (signal.candidate) {
      return true;
    }
    
    // Get the current signaling state
    const signalingState = peer._pc?.signalingState || 'closed';
    
    // For offers
    if (signal.type === 'offer') {
      // Offers are valid when we don't have a remote description yet
      return signalingState === 'stable' || signalingState === 'closed';
    }
    
    // For answers
    if (signal.type === 'answer') {
      // Answers are only valid when we have a local offer but no remote answer
      return signalingState === 'have-local-offer' || signalingState === 'have-remote-pranswer';
    }
    
    // Default to allowing the signal if we can't determine the state
    return true;
  }

  /**
   * Handles incoming connection requests
   * @param {string} from - Peer ID requesting connection
   */
  async handleConnectRequest(from) {
    const peers = this.peerManager.getPeers();
    
    if (!peers.has(from)) {
      // Use deterministic initiator selection to prevent race conditions
      // The peer with the lexicographically smaller ID becomes the initiator
      const shouldBeInitiator = this.localPeerId < from;
      
      console.log(`Received connect request for WebRTC from ${from}, requesting connection (initiator: ${shouldBeInitiator}).`);
      // Use requestConnection to properly enforce maxPeers limit
      const connectionAllowed = await this.peerManager.requestConnection(from, shouldBeInitiator);
      
      if (!connectionAllowed) {
        console.log(`Connection request from ${from} was rejected due to maxPeers limit or other constraints.`);
        // Send rejection message with alternative peers
        const alternativePeers = this.peerManager.getAlternativePeers();
        this.transportInstance.send(from, {
          type: 'connection_rejected',
          reason: 'max_peers_reached',
          maxPeers: this.maxPeers,
          alternativePeers: alternativePeers
        });
      }
    } else {
      console.log(`Already have a connection or pending with ${from}. Ignoring connect_request.`);
    }
  }

  /**
   * Handles reconnection data from peers
   * @param {Object} data - Reconnection data
   * @param {string} remotePeerId - Peer that sent the data
   */
  handleReconnectionData(data, remotePeerId) {
    this.peerDiscovery.storeReconnectionData(data.peers);
    
    // Emit a special event that applications can listen for
    if (this.eventHandlers['peer:evicted']) {
      this.eventHandlers['peer:evicted']({ 
        reason: data.reason, 
        alternativePeers: data.peers 
      });
    }
  }

  /**
   * Joins the mesh network
   */
  async join() {
    console.log('Joining mesh...');
    
    // Try peer-assisted reconnection first
    const reconnectedViaPeers = await this.peerDiscovery.attemptPeerAssistedReconnection(this.transportInstance);
    
    if (!reconnectedViaPeers) {
      console.log('Using signaling server for mesh join...');
      await this.transportInstance.connect(this.localPeerId); // Connect transport (e.g., WebSocket to signaling server)
      
      console.log('Bootstrapping Kademlia DHT with configured bootstrapNodes...');
      // Bootstrap nodes should be {id: string, address: any}
      // The 'address' is what transportInstance.sendKademliaRpc would use.
      // If bootstrapNodes are just IDs, transport needs to resolve them or use ID as address.
      const initialBootstrapNodes = this.bootstrapNodes.map(node => 
        typeof node === 'string' ? {id: node, address: node} : node
      );
      if(initialBootstrapNodes.length > 0) {
        await this.kademliaInstance.bootstrap(initialBootstrapNodes);
      }
      
      // Discover the network & populate routing table further.
      await this.peerDiscovery.findAndConnectPeers();
    } else {
      // If we reconnected via peers, we should still bootstrap Kademlia with our connected peers
      const connectedPeers = [];
      this.peerManager.getPeers().forEach((_, peerId) => {
        connectedPeers.push({ id: peerId, address: peerId });
      });
      
      if (connectedPeers.length > 0) {
        await this.peerDiscovery.bootstrapWithConnectedPeers(connectedPeers);
      }
    }

    // STABILIZED: Less frequent timeout check to reduce churn
    const connectionTimeoutInterval = setInterval(() => {
      this.peerManager.checkForConnectionTimeouts();
    }, 30000); // STABILIZED: Check every 30 seconds instead of 5
    
    // Store the interval for cleanup when leaving the mesh
    this._cleanupIntervals.push(connectionTimeoutInterval);
  }

  /**
   * Leaves the mesh network
   */
  async leave() {
    console.log('Leaving mesh...');
    
    // ENHANCED: Destroy peer discovery first to stop continuous discovery
    if (this.peerDiscovery) {
      this.peerDiscovery.destroy();
    }
    
    // Destroy all peer connections
    this.peerManager.destroy();
    
    // Clear all intervals created for this mesh instance
    if (this._cleanupIntervals.length > 0) {
      this._cleanupIntervals.forEach(intervalId => clearInterval(intervalId));
      this._cleanupIntervals = [];
    }
    
    // Disconnect transport
    await this.transportInstance.disconnect();
  }

  /**
   * Sends a broadcast message to all peers via gossip protocol
   * @param {string} topic - Message topic
   * @param {any} payload - Message payload
   */
  sendBroadcast(topic, payload) {
    console.log(`Broadcasting message on topic '${topic}':`, payload);
    
    // Use the gossip protocol for reliable network-wide broadcasting instead of direct peers only
    if (this.gossipProtocol) {
      // Asynchronously broadcast via gossip protocol
      this.gossipProtocol.broadcast(topic, payload).catch(error => {
        console.error('Error broadcasting via gossip protocol:', error);
      });
    } else {
      console.warn('Gossip protocol not available, falling back to direct peer broadcast');
      // Fallback to direct broadcast to immediate peers only
      this.peerManager.getPeers().forEach(peer => {
        try {
          peer.send(JSON.stringify({ type: 'broadcast', topic, payload }));
        } catch (error) {
          console.error('Error sending broadcast to peer:', error);
        }
      });
    }
  }

  /**
   * Sends a direct message to a specific peer
   * @param {string} toPeerId - Target peer ID
   * @param {any} payload - Message payload
   */
  send(toPeerId, payload) {
    this.peerManager.sendToPeer(toPeerId, payload);
  }

  /**
   * Registers an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function
   */
  on(event, handler) {
    if (typeof handler === 'function') {
      this.eventHandlers[event] = handler;
    } else {
      console.error(`Handler for event '${event}' is not a function.`);
    }
  }

  /**
   * Emits an event to registered handlers
   * @param {string} event - Event name
   * @param {any} data - Event data
   */
  emit(event, data) {
    // Internal method to emit events to registered handlers
    if (this.eventHandlers[event] && typeof this.eventHandlers[event] === 'function') {
      this.eventHandlers[event](data);
    }
    
    // FIXED: When a peer connects, add them as a bridge peer and reset discovery backoff
    if (event === 'peer:connect' && data && this.gossipProtocol) {
      console.log(`P2PMesh: Adding newly connected peer ${data} as bridge peer`);
      this.gossipProtocol.islandHealingManager.addBridgePeer(data);
      
      // FIXED: Reset peer discovery backoff when a peer connects
      if (this.peerDiscovery) {
        this.peerDiscovery.onPeerConnected();
      }
    }
    
    // REMOVED: Circular signal handling that was preventing connections
  }

  /**
   * Gets the routing table contacts
   * @returns {Array} Array of routing table contacts
   */
  getRoutingTable() {
    return this.kademliaInstance.routingTable.getAllContacts ? this.kademliaInstance.routingTable.getAllContacts() : [];
  }

  /**
   * Connects to a new peer if needed (internal method)
   * @param {string} targetPeerId - Target peer ID
   */
  async _connectToPeer(targetPeerId) {
    // Use deterministic initiator selection to prevent race conditions
    // The peer with the lexicographically smaller ID becomes the initiator
    const shouldBeInitiator = this.localPeerId < targetPeerId;
    
    // Use requestConnection instead of connectToPeer to enforce maxPeers
    return await this.peerManager.requestConnection(targetPeerId, shouldBeInitiator);
  }

  /**
   * Gets the connection status of a specific peer
   * @param {string} peerId - Peer ID to check
   * @returns {Object|null} Connection status object or null if peer not found
   */
  getPeerConnectionStatus(peerId) {
    if (!this.peerManager) return null;
    
    const peers = this.peerManager.getPeers();
    const peer = peers.get(peerId);
    
    if (!peer) return null;
    
    return {
      connected: peer.connected || false,
      connecting: peer.connecting || false,
      destroyed: peer.destroyed || false,
      readyState: peer.readyState || 'closed'
    };
  }

  /**
   * Gossip Protocol methods
   */
  async gossipPublish(topic, payload) {
    if (!this.gossipProtocol) throw new Error('Gossip protocol not initialized.');
    const message = await this.gossipProtocol.createMessage(topic, payload);
    return this.gossipProtocol.publish(message);
  }

  gossipSubscribe(topic, handler) {
    if (!this.gossipProtocol) throw new Error('Gossip protocol not initialized.');
    this.gossipProtocol.subscribe(topic, handler);
  }

  gossipUnsubscribe(topic, handler) {
    if (!this.gossipProtocol) throw new Error('Gossip protocol not initialized.');
    this.gossipProtocol.unsubscribe(topic, handler);
  }

  /**
   * Direct subscribe method for backward compatibility
   * This delegates to the gossip protocol's subscribe method
   */
  subscribe(topic, handler) {
    if (!this.gossipProtocol) throw new Error('Gossip protocol not initialized.');
    console.log(`P2PMesh: Client subscribing to topic '${topic}'`);
    this.gossipProtocol.subscribe(topic, handler);
  }

  /**
   * Direct unsubscribe method for backward compatibility
   */
  unsubscribe(topic, handler) {
    if (!this.gossipProtocol) throw new Error('Gossip protocol not initialized.');
    this.gossipProtocol.unsubscribe(topic, handler);
  }

  /**
   * Gets the peer ID
   * @returns {string} Local peer ID
   */
  get peerId() {
    return this.localPeerId;
  }

  /**
   * Gets the connected peers
   * @returns {Map} Map of connected peers
   */
  get peers() {
    return this.peerManager ? this.peerManager.getPeers() : new Map();
  }

  /**
   * Gets the Kademlia DHT instance
   * @returns {KademliaDHT} Kademlia instance
   */
  get kademlia() {
    return this.kademliaInstance;
  }

  /**
   * Gets reconnection data (for backward compatibility)
   * @returns {Object} Reconnection data
   */
  get _reconnectionPeers() {
    return this.peerDiscovery ? this.peerDiscovery.getReconnectionData().peers : [];
  }

  set _reconnectionPeers(peers) {
    if (this.peerDiscovery) {
      this.peerDiscovery.storeReconnectionData(peers);
    }
  }

  get _reconnectionDataTimestamp() {
    return this.peerDiscovery ? this.peerDiscovery.getReconnectionData().timestamp : 0;
  }

  set _reconnectionDataTimestamp(timestamp) {
    if (this.peerDiscovery) {
      const data = this.peerDiscovery.getReconnectionData();
      this.peerDiscovery.storeReconnectionData(data.peers, timestamp);
    }
  }

  get _alternativePeers() {
    return this.peerDiscovery ? this.peerDiscovery.getReconnectionData().alternativePeers : [];
  }

  set _alternativePeers(peers) {
    if (this.peerDiscovery) {
      const data = this.peerDiscovery.getReconnectionData();
      this.peerDiscovery.storeReconnectionData([...data.peers, ...peers]);
    }
  }
}
