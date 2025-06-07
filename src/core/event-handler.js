/**
 * Centralized event handling for P2PMesh
 */
export class MeshEventHandler {
  constructor(mesh) {
    this.mesh = mesh;
    this.eventHandlers = {};
  }

  setupTransportEventHandlers() {
    // Setup events for primary transport (backward compatibility)
    if (this.mesh.transportInstance) {
      this.setupSingleTransportEvents(this.mesh.transportInstance);
    }
    
    // Setup events for all transports in multi-transport mode
    if (this.mesh.transportInstances && this.mesh.transportInstances.length > 1) {
      this.mesh.transportInstances.forEach((transport, index) => {
        console.log(`Setting up events for transport ${index}: ${transport.constructor.name}`);
        this.setupSingleTransportEvents(transport, index);
      });
    }
  }

  setupSingleTransportEvents(transport, transportIndex = 0) {
    if (typeof transport.on !== 'function') {
      console.warn(`Transport ${transportIndex} does not support .on method for events.`);
      return;
    }

    // Bootstrap peers from transport
    transport.on('bootstrap_peers', async ({ peers: newBootstrapPeers }) => {
      if (newBootstrapPeers && newBootstrapPeers.length > 0) {
        console.log(`P2PMesh: Received bootstrap_peers from transport ${transportIndex}:`, newBootstrapPeers);
        const formattedPeers = newBootstrapPeers.map(p => ({ id: p.id, address: p.id }));
        await this.mesh.kademliaInstance.bootstrap(formattedPeers);
      }
    });

    // Peer discovery from transport
    transport.on('peer_joined', async ({ peerId }) => {
      if (peerId && peerId !== this.mesh.localPeerId) {
        console.log(`P2PMesh: Transport ${transportIndex} discovered new peer: ${peerId}`);
        
        await this.mesh.kademliaInstance.bootstrap([{ id: peerId, address: peerId }]);
        
        const currentPeerCount = this.mesh.peerManager.getPeerCount();
        if (currentPeerCount < this.mesh.maxPeers) {
          console.log(`P2PMesh: Attempting to connect to discovered peer ${peerId} (${currentPeerCount}/${this.mesh.maxPeers})`);
          try {
            const shouldBeInitiator = this.mesh.localPeerId < peerId;
            await this.mesh.peerManager.requestConnection(peerId, shouldBeInitiator);
          } catch (error) {
            console.warn(`P2PMesh: Failed to connect to discovered peer ${peerId}:`, error.message);
          }
        }
      }
    });

    // Batched signals
    transport.on('batched_signals', ({ from, signals, batchTimestamp }) => {
      console.log(`P2PMesh: Received batched signals from ${from} (${signals.length} signals) via transport ${transportIndex}`);
      signals.forEach(signal => {
        this.handleIncomingSignal(from, signal);
      });
    });
  }

  setupPeerConnectionHandlers() {
    this.mesh.transportInstance.on('signal', ({ from, signal }) => {
      this.handleIncomingSignal(from, signal);
    });

    this.mesh.transportInstance.on('connect_request', ({ from }) => {
      this.handleConnectRequest(from);
    });

    this.mesh.transportInstance.on('connection_rejected', ({ from, reason, alternativePeers }) => {
      this.handleConnectionRejection(from, reason, alternativePeers);
    });

    this.mesh.transportInstance.on('signal_rejected', ({ from, reason, correctInitiator }) => {
      this.handleSignalRejection(from, reason, correctInitiator);
    });
  }

  async handleIncomingSignal(from, signal) {
    // Delegate to main mesh for now - could be extracted further
    return this.mesh.handleIncomingSignal(from, signal);
  }

  async handleConnectRequest(from) {
    return this.mesh.handleConnectRequest(from);
  }

  async handleConnectionRejection(from, reason, alternativePeers) {
    return this.mesh.handleConnectionRejection(from, reason, alternativePeers);
  }

  async handleSignalRejection(from, reason, correctInitiator) {
    return this.mesh.handleSignalRejection(from, reason, correctInitiator);
  }

  on(event, handler) {
    if (typeof handler === 'function') {
      this.eventHandlers[event] = handler;
    } else {
      console.error(`Handler for event '${event}' is not a function.`);
    }
  }

  emit(event, data) {
    if (this.eventHandlers[event] && typeof this.eventHandlers[event] === 'function') {
      this.eventHandlers[event](data);
    }
  }
}
