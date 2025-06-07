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
 * @param {Array<object>} options.transports - Array of transport instances for multi-transport setup.
 * @param {string} options.transportName - Named transport to use (alternative to transport).
 * @param {Array} options.transportConfigs - Array of transport configurations for multi-transport.
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
    transports,
    transportName, 
    transportConfigs,
    transportOptions = {}, 
    kademliaK 
  } = options;
  
  // Handle transport initialization
  let transportInstances = [];
  
  if (transports && Array.isArray(transports)) {
    // Multiple transport instances provided directly
    transportInstances = transports;
  } else if (transportConfigs && Array.isArray(transportConfigs)) {
    // Multiple transport configurations provided
    const transportRegistry = await import('./transports/transport-registry.js').then(m => m.default);
    transportInstances = await transportRegistry.createMultipleFromConfigs(transportConfigs);
  } else if (transport) {
    // Single transport instance provided
    transportInstances = [transport];
  } else if (transportName) {
    // Single named transport specified
    const transportRegistry = await import('./transports/transport-registry.js').then(m => m.default);
    
    if (!(await transportRegistry.has(transportName))) {
      throw new Error(`Transport '${transportName}' is not registered in the transport registry`);
    }
    
    const transportInstance = await transportRegistry.createFromOptions(transportName, transportOptions);
    if (!transportInstance) {
      throw new Error(`Failed to create transport instance for '${transportName}'`);
    }
    transportInstances = [transportInstance];
  } else {
    throw new Error('Either transport instance(s), transport configurations, or a transport name must be provided');
  }

  if (transportInstances.length === 0) {
    throw new Error('No valid transport instances could be created');
  }

  // Mark transports for multi-transport mode if more than one
  if (transportInstances.length > 1) {
    transportInstances.forEach((transport, index) => {
      if (!transport._multiTransportId) {
        transport.setMultiTransportId(`transport-${index}`);
      }
    });
  } else if (transportInstances.length === 1) {
    // Even single transports should be marked for bridge compatibility
    const transport = transportInstances[0];
    if (!transport._multiTransportId) {
      transport.setMultiTransportId('transport-0');
    }
  }

  // Create and initialize the P2PMesh instance
  const mesh = new P2PMesh({
    peerId,
    maxPeers,
    iceServers,
    transport: transportInstances[0], // Primary transport for backward compatibility
    transports: transportInstances, // All transports for multi-transport support
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
