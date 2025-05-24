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

    // Initialize Kademlia DHT
    this.kademliaInstance = new KademliaDHT(this.localPeerId, this.transportInstance, { k: this.kademliaK });

    // Set up transport event handlers for Kademlia
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
        'signal': (data) => this.emit('signal', data),
        'gossip': (data, remotePeerId) => this.gossipProtocol?.handleIncomingMessage(data, remotePeerId),
        'reconnection_data': (data, remotePeerId) => this.handleReconnectionData(data, remotePeerId)
      }
    });

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
      sendFunction: (peerId, data) => this.peerManager.sendRawToPeer(peerId, data)
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
   * Sets up transport event handlers for Kademlia
   */
  setupTransportEventHandlers() {
    if (typeof this.transportInstance.on === 'function') {
      this.transportInstance.on('kademlia_rpc_message', ({ from, message, reply }) => {
        console.log(`P2PMesh: Received Kademlia RPC from ${from} via transport wrapper`);
        const response = this.kademliaInstance.handleIncomingRpc(from, message);
        if (response && reply && typeof reply === 'function') {
          reply(response); // If transport supports direct replies for RPCs
        } else if (response && message.rpcId) {
          // If no direct reply mechanism, Kademlia's sendKademliaRpc would handle responses via rpcId matching
          // Or the transport sends the response back to 'from' using its own mechanisms
          // For now, this assumes the KademliaRPC methods that return values will be sent back by transport.
          // e.g., transport.sendKademliaRpcResponse(from, response)
        }
      });

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
      console.warn('P2PMesh: Transport does not support .on method for Kademlia RPC messages or bootstrap_peers.');
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
  }

  /**
   * Handles incoming WebRTC signals
   * @param {string} from - Peer ID sending the signal
   * @param {Object} signal - WebRTC signal data
   */
  async handleIncomingSignal(from, signal) {
    const peers = this.peerManager.getPeers();
    let peer = peers.get(from);
    
    if (peer) {
      peer.signal(signal);
    } else {
      // Potentially a new peer trying to connect (WebRTC handshake)
      if (peers.size < this.maxPeers) {
        console.log(`Received signal for WebRTC from new peer ${from}, attempting to connect.`);
        await this.peerManager.connectToPeer(from, false);
        const newPeer = peers.get(from);
        if (newPeer) {
          newPeer.signal(signal);
        }
      } else {
        // Max peers reached, implement eviction strategy
        const evicted = this.peerManager.evictFurthestPeer(from);
        if (evicted) {
          // Connect the new peer
          await this.peerManager.connectToPeer(from, false);
          const newPeer = peers.get(from);
          if (newPeer) {
            newPeer.signal(signal);
          }
        } else {
          console.log(`Max peers (${this.maxPeers}) reached. Ignoring signal from ${from}.`);
        }
      }
    }
  }

  /**
   * Handles incoming connection requests
   * @param {string} from - Peer ID requesting connection
   */
  async handleConnectRequest(from) {
    const peers = this.peerManager.getPeers();
    
    if (peers.size < this.maxPeers && !peers.has(from)) {
      console.log(`Received connect request for WebRTC from ${from}, initiating connection.`);
      await this.peerManager.connectToPeer(from, true);
    } else if (!peers.has(from)) { // Max peers reached, and not already connected/connecting
      const evicted = this.peerManager.evictFurthestPeer(from);
      if (evicted) {
        // Connect the new peer
        await this.peerManager.connectToPeer(from, true);
      } else {
        console.log(`Max peers (${this.maxPeers}) reached. Ignoring connect_request from ${from}.`);
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

    // Start periodic timeout check for stalled peer connections
    const connectionTimeoutInterval = setInterval(() => {
      this.peerManager.checkForConnectionTimeouts();
    }, 5000); // Check every 5 seconds
    
    // Store the interval for cleanup when leaving the mesh
    this._cleanupIntervals.push(connectionTimeoutInterval);
  }

  /**
   * Leaves the mesh network
   */
  async leave() {
    console.log('Leaving mesh...');
    
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
    
    // Special handling for signal events - needed for relay_signal processing
    if (event === 'signal' && data && data.from && data.signal) {
      this.handleIncomingSignal(data.from, data.signal);
    }
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
    await this.peerManager.connectToPeer(targetPeerId, true);
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
