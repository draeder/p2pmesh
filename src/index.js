// P2PMesh Main API
import { P2PMesh } from './p2p-mesh.js';

/**
 * Creates a new P2PMesh instance.
 * @param {object} options - Configuration options.
 * @param {number} [options.maxPeers=5] - Maximum number of direct WebRTC peers to connect to.
 * @param {string} [options.peerId] - Optional pre-computed peer ID (should be SHA-1 hex for Kademlia).
 * @param {Array<object>} [options.bootstrapNodes=[]] - Initial Kademlia bootstrap nodes, e.g., [{id: 'peerId', address: 'ws://...'}] or transport-specific address info.
 * @param {Array<object>} [options.iceServers] - ICE servers configuration for WebRTC.
 * @param {object} options.transport - The transport instance for signaling.
 * @param {string} options.transportName - Named transport to use (alternative to transport).
 * @param {object} [options.transportOptions={}] - Options for named transport.
 * @param {number} [options.kademliaK=20] - Kademlia K parameter (number of peers per bucket).
 * @returns {object} P2PMesh instance.
 */
export async function createMesh(options = {}) {
  console.log('P2PMesh creating with options:', options);

  const { 
    maxPeers = 3, 
    peerId, 
    bootstrapNodes = [], 
    iceServers, 
    transport, 
    transportName, 
    transportOptions = {}, 
    kademliaK 
  } = options;
  
  // Handle transport initialization
  let transportInstance = transport;
  if (!transportInstance) {
    // If no direct transport instance is provided, try to use named transport
    // Import the transport registry
    const transportRegistry = await import('./transports/transport-registry.js').then(m => m.default);
    
    if (transportName) {
      // Named transport specified
      if (!transportRegistry.has(transportName)) {
        throw new Error(`Transport '${transportName}' is not registered in the transport registry`);
      }
      
      // Use the new helper method for creating transports with options
      transportInstance = transportRegistry.createFromOptions(transportName, transportOptions);
      if (!transportInstance) {
        throw new Error(`Failed to create transport instance for '${transportName}'`);
      }
    } else {
      // No transport or transportName provided
      throw new Error('Either a transport instance (options.transport) or a transport name (options.transportName) must be provided');
    }
  }

  // Create and initialize the P2PMesh instance
  const mesh = new P2PMesh({
    peerId,
    maxPeers,
    iceServers,
    transport: transportInstance,
    kademliaK,
    bootstrapNodes
  });

  // Initialize the mesh
  await mesh.init();

  return mesh;
}

// Export the P2PMesh class for direct use if needed
export { P2PMesh };

// Export utility functions
export { generatePeerId } from './utils/peer-id-generator.js';
export { loadSimplePeer } from './utils/simple-peer-loader.js';

// Export core components for advanced usage
export { PeerManager } from './peer-manager.js';
export { PeerDiscovery } from './peer-discovery.js';
