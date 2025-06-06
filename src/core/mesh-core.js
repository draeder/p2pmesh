import { KademliaDHT, K as KADEMLIA_K_VALUE } from '../kademlia.js';
import { GossipProtocol } from '../gossip.js';
import { PeerManager } from '../peer-manager.js';
import { PeerDiscovery } from '../peer-discovery.js';
import { generatePeerId } from '../utils/peer-id-generator.js';
import { loadSimplePeer } from '../utils/simple-peer-loader.js';

/**
 * Core mesh functionality separated from main P2PMesh class
 */
export class MeshCore {
  constructor(options = {}) {
    this.options = options;
    this.localPeerId = options.peerId;
    this.maxPeers = options.maxPeers || 5;
    this.iceServers = options.iceServers;
    this.transportInstance = options.transport;
    this.kademliaK = options.kademliaK || KADEMLIA_K_VALUE;
    this.bootstrapNodes = options.bootstrapNodes || [];
    
    this._cleanupIntervals = [];
    
    // Components
    this.kademliaInstance = null;
    this.peerManager = null;
    this.peerDiscovery = null;
    this.gossipProtocol = null;
  }

  async initialize() {
    await loadSimplePeer();

    if (!this.localPeerId) {
      this.localPeerId = await generatePeerId();
    }

    console.log(`Initializing MeshCore with ID: ${this.localPeerId}`);

    // Handle WebTorrent transport connection
    if (this.transportInstance.constructor.name === 'WebTorrentTransport') {
      console.log('Detected WebTorrent transport, connecting to get transport peer ID...');
      await this.transportInstance.connect(this.localPeerId);
      
      if (this.transportInstance.localPeerId) {
        console.log(`Using WebTorrent peer ID: ${this.transportInstance.localPeerId} instead of generated ID: ${this.localPeerId}`);
        this.localPeerId = this.transportInstance.localPeerId;
      }
    }

    // Initialize components
    this.kademliaInstance = new KademliaDHT(this.localPeerId, this.transportInstance, { k: this.kademliaK });
    
    return {
      localPeerId: this.localPeerId,
      kademlia: this.kademliaInstance
    };
  }

  initializePeerManager(eventHandlers) {
    this.peerManager = new PeerManager({
      localPeerId: this.localPeerId,
      maxPeers: this.maxPeers,
      iceServers: this.iceServers,
      kademlia: this.kademliaInstance,
      transportInstance: this.transportInstance,
      eventHandlers
    });

    this.kademliaInstance.setPeerManager(this.peerManager);
    this.kademliaInstance.routingTable.dht = this.kademliaInstance;

    return this.peerManager;
  }

  initializePeerDiscovery(eventHandlers) {
    this.peerDiscovery = new PeerDiscovery({
      localPeerId: this.localPeerId,
      kademlia: this.kademliaInstance,
      peerManager: this.peerManager,
      transport: this.transportInstance,
      maxPeers: this.maxPeers,
      eventHandlers
    });

    return this.peerDiscovery;
  }

  initializeGossipProtocol() {
    this.gossipProtocol = new GossipProtocol({
      localPeerId: this.localPeerId,
      dht: this.kademliaInstance,
      sendFunction: (peerId, data) => this.peerManager.sendRawToPeer(peerId, data),
      getPeerConnectionStatus: (peerId) => this.getPeerConnectionStatus(peerId)
    });

    return this.gossipProtocol;
  }

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

  destroy() {
    if (this.peerDiscovery) {
      this.peerDiscovery.destroy();
    }
    
    if (this.peerManager) {
      this.peerManager.destroy();
    }
    
    if (this._cleanupIntervals.length > 0) {
      this._cleanupIntervals.forEach(intervalId => clearInterval(intervalId));
      this._cleanupIntervals = [];
    }
  }
}
