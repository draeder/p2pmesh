// P2PMesh Main API
// The 'crypto' module will be imported dynamically for Node.js SHA-1 generation if needed.

import { KademliaDHT, generateNodeId as kademliaGenerateNodeId, K as KADEMLIA_K_VALUE } from './kademlia.js'; // Added Kademlia import
import { GossipProtocol } from './gossip.js'; // Added GossipProtocol import

let Peer;

// Function to load SimplePeer dynamically
async function loadSimplePeer() {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    // Browser environment
    if (window.SimplePeer) {
      Peer = window.SimplePeer;
      return Peer;
    }
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/simple-peer@9.11.1/simplepeer.min.js';
        script.onload = () => {
          Peer = window.SimplePeer;
          console.log('SimplePeer loaded from CDN');
          resolve();
        };
        script.onerror = (err) => {
          console.error('Failed to load SimplePeer from CDN:', err);
          reject(err);
        };
        document.head.appendChild(script);
      });
    } catch (error) {
      console.error('Error loading SimplePeer dynamically:', error);
      // Fallback or error handling if CDN fails
      // For now, we'll try a dynamic import as a last resort for module bundlers
      try {
        const SimplePeerModule = await import('simple-peer');
        Peer = SimplePeerModule.default || SimplePeerModule;
      } catch (e) {
        console.error('Failed to load simple-peer module as fallback:', e);
        throw new Error('SimplePeer could not be loaded.');
      }
    }
  } else {
    // Node.js environment
    const SimplePeerModule = await import('simple-peer');
    Peer = SimplePeerModule.default || SimplePeerModule; // Handles both CJS and ESM exports
  }
  if (!Peer) {
    throw new Error('SimplePeer failed to load.');
  }
  return Peer;
}

// Ensure Peer is loaded before createMesh is called or used internally
// This is a simplified approach; a more robust solution might involve
// making createMesh async or ensuring loadSimplePeer is called at the entry point.
// For now, we'll assume loadSimplePeer will be called before Peer is needed.
// Or, we can make functions that use Peer async and await loadSimplePeer() inside them.

/**
 * Creates a new P2PMesh instance.
 * @param {object} options - Configuration options.
 * @param {number} [options.maxPeers=5] - Maximum number of direct WebRTC peers to connect to.
 * @param {string} [options.peerId] - Optional pre-computed peer ID (should be SHA-1 hex for Kademlia).
 * @param {Array<object>} [options.bootstrapNodes=[]] - Initial Kademlia bootstrap nodes, e.g., [{id: 'peerId', address: 'ws://...'}] or transport-specific address info.
 * @param {Array<object>} [options.iceServers] - ICE servers configuration for WebRTC.
 * @param {object} options.transport - The transport instance for signaling.
 * @param {number} [options.kademliaK=20] - Kademlia K parameter (number of peers per bucket).
 * @returns {object} P2PMesh instance.
 */
export async function createMesh(options = {}) {
  if (!Peer) await loadSimplePeer(); // Ensure Peer is loaded
  console.log('P2PMesh creating with options:', options);

  const { maxPeers = 5, peerId, bootstrapNodes = [], iceServers, transport, kademliaK = KADEMLIA_K_VALUE } = options;
  const { calculateDistance } = await import('./kademlia.js'); // Import calculateDistance for eviction logic

  if (!transport) {
    throw new Error('A transport instance must be provided in options.transport');
  }

  const peers = new Map(); // Map of peerId to Peer instance (direct WebRTC connections)
  const peerConnectionAttempts = new Map(); // Track connection attempt timestamps
  const CONNECTION_TIMEOUT = 15000; // 15 seconds timeout for stalled connections
  let localPeerId = peerId;

  if (!localPeerId) {
    const randomString = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(randomString);
      const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      localPeerId = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
      try {
        const { createHash } = await import('crypto');
        localPeerId = createHash('sha1').update(randomString).digest('hex');
      } catch (e) {
        console.error('Failed to load crypto module for SHA-1 generation:', e);
        localPeerId = 'fallback-' + kademliaGenerateNodeId(); // Use Kademlia's generator as a fallback if SHA-1 fails
      }
    }
  }
  const eventHandlers = {}; // Object to store event handlers
  let gossipProtocol; // Will be initialized later

  console.log(`Initializing P2PMesh with ID: ${localPeerId}`);

  // Initialize Kademlia DHT
  // The transport needs to be adapted to handle Kademlia RPCs.
  // It should provide: 
  // 1. transport.sendKademliaRpc(toPeerId, message): Promise for sending Kademlia messages.
  // 2. Emit 'kademlia_rpc_message', { from: string, message: object } for incoming Kademlia messages.
  const kademlia = new KademliaDHT(localPeerId, transport, { k: kademliaK });

  // Listen for Kademlia RPC messages from the transport
  // This is a conceptual event; the transport implementation needs to support this.
  if (typeof transport.on === 'function') {
    transport.on('kademlia_rpc_message', ({ from, message, reply }) => {
        console.log(`P2PMesh: Received Kademlia RPC from ${from} via transport wrapper`);
        const response = kademlia.handleIncomingRpc(from, message);
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
    transport.on('bootstrap_peers', async ({ peers: newBootstrapPeers }) => {
        if (newBootstrapPeers && newBootstrapPeers.length > 0) {
            console.log('P2PMesh: Received bootstrap_peers from transport:', newBootstrapPeers);
            // Map to {id, address} format; for WebSocket transport, address can be the id.
            const formattedPeers = newBootstrapPeers.map(p => ({ id: p.id, address: p.id }));
            await kademlia.bootstrap(formattedPeers);
            // Optionally, try to connect to some of these new peers immediately
            // await findAndConnectPeers(); // Be cautious of calling this too often or in loops
        }
    });

  } else {
    console.warn('P2PMesh: Transport does not support .on method for Kademlia RPC messages or bootstrap_peers.');
  }

  // Helper to send raw data to a peer, used by GossipProtocol
  async function sendRawToPeer(peerId, data) {
    const peerConnection = peers.get(peerId);
    if (peerConnection && peerConnection.connected) {
      try {
        // Gossip messages need to be stringified only once for sending
        // Check if data is already a string to prevent double serialization
        const dataToSend = typeof data === 'string' ? data : JSON.stringify(data);
        peerConnection.send(dataToSend);
      } catch (error) {
        console.error(`Error sending raw data to peer ${peerId}:`, error);
      }
    } else {
      // Uncomment for debugging if needed
      // console.warn(`Cannot send raw data: Peer ${peerId} not connected or does not exist.`);
    }
  }

  // Initialize Gossip Protocol after Kademlia and localPeerId are set up
  gossipProtocol = new GossipProtocol({
    localPeerId,
    dht: kademlia,
    sendFunction: sendRawToPeer,
    // cryptoProvider: {} // Optionally pass a crypto provider here
  });

  // Connect gossip protocol to mesh event system
  // This ensures broadcast messages via gossip are emitted to application layer
  gossipProtocol.subscribe('*', ({ topic, payload, originPeerId }) => {
    // Only emit if there's a message handler
    if (eventHandlers['message']) {
      console.log(`Gossip: Forwarding message from ${originPeerId} on topic '${topic}' to application`); 
      eventHandlers['message']({
        from: originPeerId,
        data: { type: 'broadcast', topic, payload }
      });
    }
  });
  
  // Additionally subscribe to each specific topic used with sendBroadcast
  // This ensures backward compatibility with existing code
  gossipProtocol.subscribe('node_chat', ({ topic, payload, originPeerId }) => {
    if (eventHandlers['message']) {
      eventHandlers['message']({
        from: originPeerId,
        data: { type: 'broadcast', topic, payload }
      });
    }
  });

  transport.on('signal', ({ from, signal }) => {
    let peer = peers.get(from);
    if (peer) {
      peer.signal(signal);
    } else {
      // Potentially a new peer trying to connect (WebRTC handshake)
      if (peers.size < maxPeers) {
        console.log(`Received signal for WebRTC from new peer ${from}, attempting to connect.`);
        const newPeerInstance = new Peer({ initiator: false, trickle: false, iceServers });
        setupPeerEvents(newPeerInstance, from);
        newPeerInstance.signal(signal);
        peers.set(from, newPeerInstance);
      } else {
        // Max peers reached, implement eviction strategy
        const furthestPeerContact = kademlia.routingTable.getFurthestContact();
        if (furthestPeerContact) {
          const distanceToNewPeer = calculateDistance(localPeerId, from);
          const distanceToFurthestPeer = calculateDistance(localPeerId, furthestPeerContact.id);

          if (distanceToNewPeer < distanceToFurthestPeer) {
            console.log(`New peer ${from} (dist: ${distanceToNewPeer}) is closer than furthest peer ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer}). Evicting furthest.`);
            const furthestPeerConnection = peers.get(furthestPeerContact.id);
            if (furthestPeerConnection) {
              furthestPeerConnection.destroy(); // This should trigger 'close' event and removal
            }
            // Connect the new peer
            const newPeerInstance = new Peer({ initiator: false, trickle: false, iceServers });
            setupPeerEvents(newPeerInstance, from);
            newPeerInstance.signal(signal);
            peers.set(from, newPeerInstance);
          } else {
            console.log(`Max peers (${maxPeers}) reached. New peer ${from} (dist: ${distanceToNewPeer}) is not closer than furthest ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer}). Ignoring signal.`);
          }
        } else {
          console.log(`Max peers (${maxPeers}) reached, but no furthest peer found to compare. Ignoring signal from ${from}.`);
        }
      }
    }
  });

  transport.on('connect_request', ({ from }) => {
    if (peers.size < maxPeers && !peers.has(from)) {
      console.log(`Received connect request for WebRTC from ${from}, initiating connection.`);
      const newPeerInstance = new Peer({ initiator: true, trickle: false, iceServers });
      setupPeerEvents(newPeerInstance, from);
      peers.set(from, newPeerInstance);
    } else if (!peers.has(from)) { // Max peers reached, and not already connected/connecting
        const furthestPeerContact = kademlia.routingTable.getFurthestContact();
        if (furthestPeerContact) {
          const distanceToNewPeer = calculateDistance(localPeerId, from);
          const distanceToFurthestPeer = calculateDistance(localPeerId, furthestPeerContact.id);

          if (distanceToNewPeer < distanceToFurthestPeer) {
            console.log(`New peer ${from} (dist: ${distanceToNewPeer}) is closer than furthest peer ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer}). Evicting furthest for connect_request.`);
            const furthestPeerConnection = peers.get(furthestPeerContact.id);
            if (furthestPeerConnection) {
              furthestPeerConnection.destroy(); // This should trigger 'close' event and removal
            }
            // Connect the new peer
            const newPeerInstance = new Peer({ initiator: true, trickle: false, iceServers });
            setupPeerEvents(newPeerInstance, from);
            peers.set(from, newPeerInstance);
          } else {
            console.log(`Max peers (${maxPeers}) reached. New peer ${from} (dist: ${distanceToNewPeer}) is not closer than furthest ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer}). Ignoring connect_request.`);
          }
        } else {
          console.log(`Max peers (${maxPeers}) reached, but no furthest peer found to compare. Ignoring connect_request from ${from}.`);
        }
    } else {
        console.log(`Already have a connection or pending with ${from}. Ignoring connect_request.`);
    }
  });

  // transport.on('ack', ({ from }) => {
  //   console.log(`P2PMesh: Received ack from ${from} via transport`);
  // });

  function setupPeerEvents(peer, remotePeerId) {
    // Track connection attempt start time
    peerConnectionAttempts.set(remotePeerId, Date.now());
    
    peer.on('signal', (data) => {
      console.log(`Sending WebRTC signal to ${remotePeerId}`);
      // This 'send' is for WebRTC signaling, not Kademlia RPCs
      transport.send(remotePeerId, { type: 'signal', from: localPeerId, signal: data });
    });

    peer.on('connect', () => {
      console.log(`Connected (WebRTC) to peer: ${remotePeerId}`);
      // Connection established, clear connection attempt tracking
      peerConnectionAttempts.delete(remotePeerId);
      
      // Add to Kademlia routing table. 'address' would be transport-specific info if needed.
      // For simple-peer over a signaling server, the 'remotePeerId' is often enough.
      kademlia.routingTable.addContact({ id: remotePeerId, address: transport.getPeerAddress ? transport.getPeerAddress(remotePeerId) : remotePeerId });
      
      if (eventHandlers['peer:connect']) {
        eventHandlers['peer:connect'](remotePeerId);
      }
      // peer.send(`Hello from ${localPeerId}`); // Example: send initial message
    });

    peer.on('data', (data) => {
      let parsedData;
      const dataString = data.toString();
      try {
        parsedData = JSON.parse(dataString);
      } catch (e) {
        // Log the error for better debugging instead of silently ignoring it
        console.error(`Error parsing JSON data from ${remotePeerId}:`, e);
        console.error(`Problematic data: ${dataString.substring(0, 100)}${dataString.length > 100 ? '...' : ''}`);
        
        // Emit as a generic 'message' event (as per previous behavior for non-JSON)
        if (eventHandlers['message']) {
          eventHandlers['message']({ from: remotePeerId, data: dataString });
        } else {
          console.log(`Received non-JSON data from ${remotePeerId} (no 'message' handler)`);
        }
        return; // Stop processing if not valid JSON for structured messages
      }

      // console.log(`P2PMesh: Received parsed data from ${remotePeerId}:`, parsedData);

      if (parsedData && parsedData.type === 'gossip') {
        // console.log(`P2PMesh: Received gossip message from ${remotePeerId}`);
        gossipProtocol.handleIncomingMessage(parsedData, remotePeerId);
      } else if (parsedData && parsedData.type === 'gossip_ack') {
        // Handle gossip acknowledgments internally but don't forward to application
        gossipProtocol.handleIncomingMessage(parsedData, remotePeerId);
        // No need to emit to application layer - this is an internal protocol message
      } else if (parsedData && parsedData.type === 'kademlia_rpc_response') { // Conceptual
        // console.log(`P2PMesh: Received Kademlia RPC response from ${remotePeerId}`);
        // if (kademlia.handleRpcResponse) { // Kademlia should have this method if used
        //   kademlia.handleRpcResponse(parsedData.rpcId, parsedData.response, parsedData.error, remotePeerId);
        // }
        // Fallback for other structured messages if not Kademlia response or no handler
        if (eventHandlers['message']) {
            eventHandlers['message']({ from: remotePeerId, data: parsedData });
        } else {
            // console.log(`Received unhandled Kademlia-like structured data from ${remotePeerId}:`, parsedData);
        }
      } else if (parsedData) {
        // Emit as a generic 'message' event if it's structured but not internal protocol messages
        if (eventHandlers['message']) {
          eventHandlers['message']({ from: remotePeerId, data: parsedData });
        } else {
            // console.log(`Received other JSON data from ${remotePeerId}:`, parsedData);
        }
      }
    });

    peer.on('close', () => {
      console.log(`Connection closed with peer: ${remotePeerId}`);
      peers.delete(remotePeerId);
      peerConnectionAttempts.delete(remotePeerId); // Clean up connection tracking
      kademlia.routingTable.removeContact(remotePeerId);
      if (eventHandlers['peer:disconnect']) {
        eventHandlers['peer:disconnect'](remotePeerId);
      }
      // Optionally, try to find new peers via Kademlia to maintain connectivity
      // findAndConnectPeers(); 
    });

    peer.on('error', (err) => {
      console.error(`Error with peer ${remotePeerId}:`, err);
      peers.delete(remotePeerId);
      peerConnectionAttempts.delete(remotePeerId); // Clean up connection tracking
      kademlia.routingTable.removeContact(remotePeerId);
      if (eventHandlers['peer:error']) {
          eventHandlers['peer:error']({peerId: remotePeerId, error: err});
      }
      if (eventHandlers['peer:disconnect']) {
        eventHandlers['peer:disconnect'](remotePeerId); // Or a specific error event
      }
    });

  }

  // Check for peer connection timeouts and clean up stalled connections
  function checkForConnectionTimeouts() {
    const now = Date.now();
    let timedOutPeers = [];
    
    // Identify peers that have been in connecting state for too long
    peerConnectionAttempts.forEach((timestamp, peerId) => {
      const connectionDuration = now - timestamp;
      
      if (connectionDuration > CONNECTION_TIMEOUT) {
        console.log(`Connection to peer ${peerId} timed out after ${connectionDuration}ms`);
        timedOutPeers.push(peerId);
      }
    });
    
    // Clean up timed out peers
    timedOutPeers.forEach(peerId => {
      const peer = peers.get(peerId);
      if (peer) {
        console.log(`Destroying timed out peer connection to ${peerId}`);
        peer.destroy();
        peers.delete(peerId);
        peerConnectionAttempts.delete(peerId);
        kademlia.routingTable.removeContact(peerId);
        
        // Emit timeout event
        if (eventHandlers['peer:timeout']) {
          eventHandlers['peer:timeout'](peerId);
        }
        // Also emit disconnect event for UI consistency
        if (eventHandlers['peer:disconnect']) {
          eventHandlers['peer:disconnect'](peerId);
        }
      }
    });
    
    return timedOutPeers.length > 0;
  }
  
  async function findAndConnectPeers() {
    if (peers.size >= maxPeers) return;

    console.log('Kademlia: Attempting to find new peers...');
    // Find nodes near our own ID to discover the network
    const potentialPeers = await kademlia.findNode(localPeerId);
    console.log('Kademlia: Found potential peers:', potentialPeers.map(p => p.id));

    for (const contact of potentialPeers) {
        if (peers.size >= maxPeers) break;
        if (contact.id !== localPeerId && !peers.has(contact.id)) {
            console.log(`Attempting to establish WebRTC connection with Kademlia peer: ${contact.id}`);
            // Initiate WebRTC connection (simple-peer)
            const newPeer = new Peer({ initiator: true, trickle: false, iceServers });
            setupPeerEvents(newPeer, contact.id);
            peers.set(contact.id, newPeer);
            // The 'signal' event from newPeer will send the offer via transport.send
            // This assumes the transport can route a 'signal' to a Kademlia peer ID.
            // If Kademlia peers are only known by ID, the transport needs to resolve ID to a routable address.
        }
    }
  }

  const mesh = {
    peerId: localPeerId,
    kademlia,
    get peers() { return peers; }, // Expose connected WebRTC peers
    join: async () => {
      console.log('Joining mesh...');
      await transport.connect(localPeerId); // Connect transport (e.g., WebSocket to signaling server)
      
      console.log('Bootstrapping Kademlia DHT with configured bootstrapNodes...');
      // Bootstrap nodes should be {id: string, address: any}
      // The 'address' is what transport.sendKademliaRpc would use.
      // If bootstrapNodes are just IDs, transport needs to resolve them or use ID as address.
      const initialBootstrapNodes = bootstrapNodes.map(node => 
        typeof node === 'string' ? {id: node, address: node} : node
      );
      if(initialBootstrapNodes.length > 0) {
        await kademlia.bootstrap(initialBootstrapNodes);
      }
      
      // Discover the network & populate routing table further. 
      // findAndConnectPeers will use Kademlia's findNode.
      // The signaling server might also send 'bootstrap_peers' which will trigger the listener above.
      await findAndConnectPeers();

      // Start periodic timeout check for stalled peer connections
      const connectionTimeoutInterval = setInterval(checkForConnectionTimeouts, 5000); // Check every 5 seconds
      
      // Store the interval for cleanup when leaving the mesh
      mesh._cleanupIntervals = mesh._cleanupIntervals || [];
      mesh._cleanupIntervals.push(connectionTimeoutInterval);

      // Periodically try to find more peers if below maxPeers
      // setInterval(findAndConnectPeers, 30000); // Example: every 30 seconds
    },
    leave: async () => {
      console.log('Leaving mesh...');
      peers.forEach(peer => peer.destroy());
      peers.clear();
      peerConnectionAttempts.clear();
      
      // Clear all intervals created for this mesh instance
      if (mesh._cleanupIntervals && mesh._cleanupIntervals.length > 0) {
        mesh._cleanupIntervals.forEach(intervalId => clearInterval(intervalId));
        mesh._cleanupIntervals = [];
      }
      
      await transport.disconnect();
    },
    sendBroadcast: (topic, payload) => {
      console.log(`Broadcasting message on topic '${topic}':`, payload);
      
      // Use the gossip protocol for reliable network-wide broadcasting instead of direct peers only
      if (gossipProtocol) {
        // Asynchronously broadcast via gossip protocol
        gossipProtocol.broadcast(topic, payload).catch(error => {
          console.error('Error broadcasting via gossip protocol:', error);
        });
      } else {
        console.warn('Gossip protocol not available, falling back to direct peer broadcast');
        // Fallback to direct broadcast to immediate peers only
        peers.forEach(peer => {
          try {
            peer.send(JSON.stringify({ type: 'broadcast', topic, payload }));
          } catch (error) {
            console.error('Error sending broadcast to peer:', error);
          }
        });
      }
    },
    send: (toPeerId, payload) => {
      const peer = peers.get(toPeerId);
      if (peer && peer.connected) {
        console.log(`Sending direct message to ${toPeerId}:`, payload);
        try {
          peer.send(JSON.stringify({ type: 'direct', payload }));
        } catch (error) {
          console.error(`Error sending direct message to ${toPeerId}:`, error);
        }
      } else {
        console.warn(`Cannot send message: Peer ${toPeerId} not found or not connected.`);
      }
    },
    on: (event, handler) => {
      // Basic event emitter placeholder
      // console.warn(`Event handling for '${event}' not fully implemented.`);
      if (typeof handler === 'function') {
        eventHandlers[event] = handler;
      } else {
        console.error(`Handler for event '${event}' is not a function.`);
      }
    },
    getRoutingTable: () => {
      return kademlia.routingTable.getAllContacts ? kademlia.routingTable.getAllContacts() : [];
    },
    // Internal method to connect to a new peer if needed
    _connectToPeer: (targetPeerId) => {
      if (!peers.has(targetPeerId) && peers.size < maxPeers) {
        console.log(`Attempting to connect to new peer: ${targetPeerId}`);
        const peer = new Peer({ initiator: true, trickle: false, iceServers });
        setupPeerEvents(peer, targetPeerId);
        peers.set(targetPeerId, peer);
      } else if (peers.has(targetPeerId)) {
        console.log(`Already connected or connecting to ${targetPeerId}`);
      } else {
        console.log(`Max peers reached, cannot connect to ${targetPeerId}`);
      }
    },
    // Gossip Protocol methods
    gossipPublish: async (topic, payload) => {
      if (!gossipProtocol) throw new Error('Gossip protocol not initialized.');
      const message = await gossipProtocol.createMessage(topic, payload);
      return gossipProtocol.publish(message);
    },
    gossipSubscribe: (topic, handler) => {
      if (!gossipProtocol) throw new Error('Gossip protocol not initialized.');
      gossipProtocol.subscribe(topic, handler);
    },
    gossipUnsubscribe: (topic, handler) => {
      if (!gossipProtocol) throw new Error('Gossip protocol not initialized.');
      gossipProtocol.unsubscribe(topic, handler);
    }
  };

  return mesh;
}