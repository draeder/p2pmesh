// P2PMesh Main API
// The 'crypto' module will be imported dynamically for Node.js SHA-1 generation if needed.

import { KademliaDHT, generateNodeId as kademliaGenerateNodeId, K as KADEMLIA_K_VALUE } from './kademlia.js'; // Added Kademlia import
import { GossipProtocol } from './gossip.js'; // Added GossipProtocol import

let Peer;

// Function to load SimplePeer dynamically with WebRTC implementation for Node.js
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
    try {
      // Try to load the WebRTC implementation for Node.js
      const wrtc = await import('@koush/wrtc').catch(e => {
        console.warn('Optional @koush/wrtc package not available, SimplePeer will use defaults:', e.message);
        return null;
      });
      
      // Load simple-peer with wrtc implementation if available
      const SimplePeerModule = await import('simple-peer');
      Peer = SimplePeerModule.default || SimplePeerModule; // Handles both CJS and ESM exports
      
      // Inject wrtc implementation if loaded successfully
      if (wrtc && wrtc.default) {
        console.log('Using @koush/wrtc for WebRTC in Node.js environment');
        // Create a modified SimplePeer constructor that includes wrtc by default
        const OriginalPeer = Peer;
        Peer = function(opts) {
          return new OriginalPeer({
            ...opts,
            wrtc: wrtc.default
          });
        };
        // Copy over static properties and methods
        Object.assign(Peer, OriginalPeer);
      }
    } catch (e) {
      console.error('Failed to load simple-peer in Node.js environment:', e);
      throw new Error('SimplePeer could not be loaded in Node.js environment.');
    }
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
    try {
      // Dynamic SHA-1 generation based on environment
      if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
        // Browser environment with SubtleCrypto API
        const encoder = new TextEncoder();
        const data = encoder.encode(randomString);
        const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        localPeerId = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        // Node.js environment - dynamically import crypto
        try {
          const { createHash } = await import('crypto');
          localPeerId = createHash('sha1').update(randomString).digest('hex');
          console.log('Using Node.js crypto module for SHA-1 generation');
        } catch (e) {
          console.error('Failed to load crypto module for SHA-1 generation:', e);
          throw e; // Re-throw to be caught by outer try/catch
        }
      }
    } catch (e) {
      console.warn('Falling back to Kademlia ID generator:', e.message);
      localPeerId = 'fallback-' + kademliaGenerateNodeId(); // Use Kademlia's generator as a fallback if SHA-1 fails
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
  
  // Removed hardcoded subscriptions to specific topics
  // Clients should subscribe to topics they're interested in

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
              // Before destroying, send reconnection data to the evicted peer
              // Collect information about other peers for reconnection assistance
              const reconnectPeers = [];
              peers.forEach((peerConn, peerId) => {
                // Don't include the peer we're about to evict
                if (peerId !== furthestPeerContact.id) {
                  reconnectPeers.push(peerId);
                }
              });
              
              // Send reconnection data to the evicted peer
              try {
                furthestPeerConnection.send(JSON.stringify({
                  type: 'reconnection_data',
                  peers: reconnectPeers,
                  reason: 'evicted_for_closer_peer'
                }));
                console.log(`Sent reconnection data to evicted peer ${furthestPeerContact.id} with ${reconnectPeers.length} alternative peers`);
              } catch (error) {
                console.error(`Failed to send reconnection data to evicted peer ${furthestPeerContact.id}:`, error);
              }
              
              // Short delay to allow the message to be sent before destroying the connection
              setTimeout(() => {
                furthestPeerConnection.destroy(); // This should trigger 'close' event and removal
              }, 100);
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
              // Before destroying, send reconnection data to the evicted peer
              // Collect information about other peers for reconnection assistance
              const reconnectPeers = [];
              peers.forEach((peerConn, peerId) => {
                // Don't include the peer we're about to evict
                if (peerId !== furthestPeerContact.id) {
                  reconnectPeers.push(peerId);
                }
              });
              
              // Send reconnection data to the evicted peer
              try {
                furthestPeerConnection.send(JSON.stringify({
                  type: 'reconnection_data',
                  peers: reconnectPeers,
                  reason: 'evicted_for_connect_request'
                }));
                console.log(`Sent reconnection data to evicted peer ${furthestPeerContact.id} with ${reconnectPeers.length} alternative peers`);
              } catch (error) {
                console.error(`Failed to send reconnection data to evicted peer ${furthestPeerContact.id}:`, error);
              }
              
              // Short delay to allow the message to be sent before destroying the connection
              setTimeout(() => {
                furthestPeerConnection.destroy(); // This should trigger 'close' event and removal
              }, 100);
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
      console.log(`Preparing WebRTC signal to ${remotePeerId}`);
      
      // Attempt peer relay for all connections for resilience
      // Even if we have only 1 peer, it might be connected to our target
      if (peers.size > 0) {
        // Attempt to relay through existing peers
        // This function always returns false now, ensuring we use signaling server
        // but we still attempt relays to increase connection success probability
        relaySignalingData(remotePeerId, data);
      }
      
      // ALWAYS use the signaling server for reliable connections
      // Using multiple signal paths improves connection success rates
      console.log(`Sending WebRTC signal to ${remotePeerId} via signaling server`);
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

      // Handle relay_signal messages - relay WebRTC signaling data through peers
      if (parsedData && parsedData.type === 'relay_signal') {
        if (parsedData.to && parsedData.from && parsedData.signal) {
          // Add received timestamp for tracking relay timing
          const receivedTime = Date.now();
          const relayLatency = parsedData.timestamp ? (receivedTime - parsedData.timestamp) : 'unknown';
          
          if (parsedData.to === localPeerId) {
            // Signal is for us - process it directly and acknowledge receipt
            console.log(`Received relayed signal from ${parsedData.from} via peer ${remotePeerId} (latency: ${relayLatency}ms)`);
            
            // Process the signal data
            mesh.emit('signal', { from: parsedData.from, signal: parsedData.signal });
            
            // Send acknowledgment back to the sender
            try {
              peer.send(JSON.stringify({
                type: 'relay_ack',
                to: parsedData.from,
                from: localPeerId,
                originalTimestamp: parsedData.timestamp,
                receivedTimestamp: receivedTime
              }));
            } catch (error) {
              console.error(`Failed to send relay acknowledgment to ${remotePeerId}:`, error);
            }
          } else {
            // Signal is for another peer - relay it further if we can
            console.log(`Relaying signal from ${parsedData.from} to ${parsedData.to}`);
            const targetPeer = peers.get(parsedData.to);
            if (targetPeer && targetPeer.connected) {
              try {
                // Preserve original timestamp for accurate latency measurement
                targetPeer.send(JSON.stringify({
                  ...parsedData,
                  relayPath: [...(parsedData.relayPath || []), localPeerId] // Track relay path
                }));
                console.log(`Successfully relayed signal to ${parsedData.to}`);
              } catch (error) {
                console.error(`Error relaying signal to ${parsedData.to}:`, error);
                // Notify original sender of relay failure if possible
                try {
                  peer.send(JSON.stringify({
                    type: 'relay_failure',
                    to: parsedData.from,
                    from: localPeerId,
                    targetPeer: parsedData.to,
                    reason: error.message || 'Send error'
                  }));
                } catch (e) {
                  console.error(`Failed to send relay failure notification:`, e);
                }
              }
            } else {
              console.warn(`Cannot relay signal to ${parsedData.to}: not connected`);
              // Notify original sender that we couldn't complete the relay
              try {
                peer.send(JSON.stringify({
                  type: 'relay_failure',
                  to: parsedData.from,
                  from: localPeerId,
                  targetPeer: parsedData.to,
                  reason: 'Peer not connected'
                }));
              } catch (error) {
                console.error(`Failed to send relay failure notification:`, error);
              }
            }
          }
          return; // Don't pass relay_signal messages to application layer
        }
      }
      
      // Handle relay acknowledgments
      if (parsedData && parsedData.type === 'relay_ack') {
        const latency = parsedData.receivedTimestamp - parsedData.originalTimestamp;
        console.log(`Relay to ${parsedData.from} was acknowledged (latency: ${latency}ms)`);
        return; // Don't pass ack messages to application layer
      }
      
      // Handle relay failures
      if (parsedData && parsedData.type === 'relay_failure') {
        console.warn(`Relay to ${parsedData.targetPeer} failed: ${parsedData.reason}`);
        return; // Don't pass failure messages to application layer
      }

      // console.log(`P2PMesh: Received parsed data from ${remotePeerId}:`, parsedData);

      if (parsedData && parsedData.type === 'reconnection_data') {
        // Store reconnection data for later use if disconnected
        console.log(`Received reconnection data from ${remotePeerId} with ${parsedData.peers.length} alternative peers`);
        mesh._reconnectionPeers = parsedData.peers;
        // Create a timestamp to track when we received this data
        mesh._reconnectionDataTimestamp = Date.now();
        
        // Emit a special event that applications can listen for
        if (eventHandlers['peer:evicted']) {
          eventHandlers['peer:evicted']({ 
            reason: parsedData.reason, 
            alternativePeers: parsedData.peers 
          });
        }
        
        // Store these peers for potential direct connection attempts on next join
        if (mesh._alternativePeers) {
          // Merge with existing alternative peers, avoiding duplicates
          mesh._alternativePeers = [...new Set([...mesh._alternativePeers, ...parsedData.peers])];
        } else {
          mesh._alternativePeers = [...parsedData.peers];
        }
        
        // Don't forward this internal protocol message to application
      } else if (parsedData && parsedData.type === 'gossip') {
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

  // Relay messages to a peer via another peer (used when direct connection isn't available)
  function relayMessage(viaNodeId, toNodeId, message) {
    const peer = peers.get(viaNodeId);
    if (!peer || !peer.connected) {
      console.warn(`Cannot relay message: Relay peer ${viaNodeId} not connected.`);
      return false;
    }
    try {
      peer.send(JSON.stringify({
        type: 'relay',
        to: toNodeId,
        message
      }));
      return true;
    } catch (error) {
      console.error(`Error relaying message via ${viaNodeId}:`, error);
      return false;
    }
  }
  
  // Relay signaling data through peers instead of the signaling server
  function relaySignalingData(toPeerId, signalData) {
    if (peers.size === 0) {
      console.warn('No connected peers to relay signaling data through');
      return false;
    }
    
    // Check if the target peer is directly connected to us
    // If it is, we don't need to relay and should return false to use signaling server
    if (peers.has(toPeerId) && peers.get(toPeerId).connected) {
      console.log(`Target peer ${toPeerId} is already directly connected. No relay needed.`);
      return false;
    }
    
    // Track if we've attempted to relay, not that it was successful
    let relayAttempted = false;
    
    // Try to relay through connected peers
    let potentialRelayPeers = [];
    peers.forEach((peer, peerId) => {
      if (peer.connected) {
        potentialRelayPeers.push(peerId);
      }
    });
    
    // Select up to 3 peers for relay to avoid overwhelming the network
    // but increase chances of successful relay
    if (potentialRelayPeers.length > 3) {
      potentialRelayPeers = potentialRelayPeers.slice(0, 3);
    }
    
    // Attempt relay through selected peers
    for (const peerId of potentialRelayPeers) {
      const peer = peers.get(peerId);
      if (peer && peer.connected) {
        try {
          console.log(`Attempting to relay signaling data to ${toPeerId} via peer ${peerId}`);
          peer.send(JSON.stringify({
            type: 'relay_signal',
            from: localPeerId,
            to: toPeerId,
            signal: signalData,
            timestamp: Date.now() // Add timestamp for tracking purposes
          }));
          relayAttempted = true;
        } catch (error) {
          console.error(`Failed to relay signal via peer ${peerId}:`, error);
        }
      }
    }
    
    // Just because we sent the relay doesn't mean it will succeed
    // Return false to ensure fallback to signaling server as a reliability measure
    console.log(`Relay attempts made: ${relayAttempted}. Recommending signaling server fallback for reliability.`);
    return false; // Always use signaling server to ensure connection reliability
  }

  const mesh = {
    peerId: localPeerId,
    kademlia,
    // Store reconnection data for peer-assisted reconnection
    _reconnectionPeers: [],
    _reconnectionDataTimestamp: 0,
    get peers() { return peers; }, // Expose connected WebRTC peers
    join: async () => {
      console.log('Joining mesh...');
      
      // Check if we have recent reconnection data from previous sessions (within 10 minutes)
      const hasRecentReconnectionData = mesh._reconnectionPeers && 
                                     mesh._reconnectionPeers.length > 0 && 
                                     (Date.now() - mesh._reconnectionDataTimestamp < 10 * 60 * 1000);
      
      // Check for alternative peers collected from peer evictions
      const hasAlternativePeers = mesh._alternativePeers && mesh._alternativePeers.length > 0;
      
      let reconnectedViaPeers = false;
      
      // Try peer-assisted reconnection first if we have recent data
      // or if we know of existing peers in the network
      const knownPeersFromRouting = kademlia.routingTable.getAllContacts ? kademlia.routingTable.getAllContacts() : [];
      const hasKnownPeers = knownPeersFromRouting.length > 0;
      
      // Create a combined list of potential peers for connection attempts
      // Prioritize recently known peers for faster connection
      let potentialPeers = [];
      
      if (hasRecentReconnectionData) {
        potentialPeers = [...mesh._reconnectionPeers];
      }
      
      if (hasAlternativePeers) {
        // Add alternative peers, avoiding duplicates
        mesh._alternativePeers.forEach(peerId => {
          if (!potentialPeers.includes(peerId)) {
            potentialPeers.push(peerId);
          }
        });
      }
      
      if (hasKnownPeers) {
        // Add known peers from routing table, avoiding duplicates
        knownPeersFromRouting.forEach(contact => {
          if (!potentialPeers.includes(contact.id)) {
            potentialPeers.push(contact.id);
          }
        });
      }
      
      if (potentialPeers.length > 0) {
        console.log(`Attempting peer-based connection with ${potentialPeers.length} potential peers...`);
        
        // First connect transport minimally to facilitate peer connection if needed
        if (!transport.isConnected) {
          try {
            await transport.connect(localPeerId, {silentConnect: true});
          } catch (error) {
            console.warn('Failed to connect transport silently:', error);
            // Continue anyway - we might still be able to connect through peers
          }
        }
        
        // Try connecting to each potential peer
        for (const alternatePeerId of potentialPeers) {
          if (peers.size >= maxPeers) break; // Stop if we've reached max peers
          
          try {
            console.log(`Trying peer-assisted connection to ${alternatePeerId}...`);
            const peerConnection = new Peer({ initiator: true, trickle: false, iceServers });
            setupPeerEvents(peerConnection, alternatePeerId);
            peers.set(alternatePeerId, peerConnection);
            
            // First attempt direct relay through any existing connected peers
            let relayAttempted = false;
            if (peers.size >= 2) {
              // Find existing peers to relay through
              peers.forEach((peer, peerId) => {
                if (peerId !== alternatePeerId && peer.connected) {
                  try {
                    // Send a connect request that will be relayed
                    peer.send(JSON.stringify({
                      type: 'relay_signal',
                      from: localPeerId,
                      to: alternatePeerId,
                      signal: { type: 'connect_request' } // A minimal signal to initiate connection
                    }));
                    console.log(`Sent relay connection request to ${alternatePeerId} via ${peerId}`);
                    relayAttempted = true;
                  } catch (error) {
                    console.error(`Failed to send relay request via peer ${peerId}:`, error);
                  }
                }
              });
            }
            
            // If no peers available for relay or relay not attempted, fall back to transport
            if (!relayAttempted) {
              // Request connection via transport - this uses signaling but is direct
              transport.send(alternatePeerId, { type: 'connect_request', from: localPeerId });
            }
            
            // If this successfully connects, peer:connect event will be triggered
            // Wait a bit to see if connection establishes before trying next peer
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check if we connected successfully
            if (peers.has(alternatePeerId) && peers.get(alternatePeerId).connected) {
              console.log(`Successfully connected to peer ${alternatePeerId}!`);
              reconnectedViaPeers = true;
              
              // If this is our first peer connection and we have max peers > 1,
              // try to connect to one more peer for redundancy
              if (peers.size === 1 && maxPeers > 1) {
                console.log('Connected to one peer, continuing to try one more for redundancy');
                continue;
              }
              
              break; // Successfully connected to at least one peer (or two if needed)
            }
          } catch (error) {
            console.error(`Failed to connect via peer ${alternatePeerId}:`, error);
            // Continue to try the next peer
          }
        }
      }
      
      // If peer-assisted reconnection failed or wasn't attempted, connect normally
      if (!reconnectedViaPeers) {
        console.log('Using signaling server for mesh join...');
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
        await findAndConnectPeers();
      } else {
        // If we reconnected via peers, we should still bootstrap Kademlia with our connected peers
        const connectedPeers = [];
        peers.forEach((_, peerId) => {
          connectedPeers.push({ id: peerId, address: peerId });
        });
        
        if (connectedPeers.length > 0) {
          console.log(`Bootstrapping Kademlia with ${connectedPeers.length} connected peers...`);
          await kademlia.bootstrap(connectedPeers);
        }
      }

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
    emit: (event, data) => {
      // Internal method to emit events to registered handlers
      if (eventHandlers[event] && typeof eventHandlers[event] === 'function') {
        eventHandlers[event](data);
      }
      
      // Special handling for signal events - needed for relay_signal processing
      if (event === 'signal' && data && data.from && data.signal) {
        // Process the relayed signal like it came from the transport
        const { from, signal } = data;
        const peer = peers.get(from);
        if (peer) {
          console.log(`Processing relayed signal from ${from}`);
          peer.signal(signal);
        } else {
          // This is a new peer trying to connect via relay
          console.log(`Received relayed signal from new peer ${from}, attempting to connect.`);
          if (peers.size < maxPeers) {
            const newPeerInstance = new Peer({ initiator: false, trickle: false, iceServers });
            setupPeerEvents(newPeerInstance, from);
            newPeerInstance.signal(signal);
            peers.set(from, newPeerInstance);
          } else {
            // Handle max peers case with priority logic
            console.log(`Max peers (${maxPeers}) reached, applying eviction strategy for relayed signal.`);
            // Use the same eviction strategy as with regular signals
            const furthestPeerContact = kademlia.routingTable.getFurthestContact();
            if (furthestPeerContact) {
              const distanceToNewPeer = calculateDistance(localPeerId, from);
              const distanceToFurthestPeer = calculateDistance(localPeerId, furthestPeerContact.id);

              if (distanceToNewPeer < distanceToFurthestPeer) {
                console.log(`New peer ${from} (dist: ${distanceToNewPeer}) is closer than furthest peer ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer}). Evicting furthest for relayed signal.`);
                const furthestPeerConnection = peers.get(furthestPeerContact.id);
                if (furthestPeerConnection) {
                  // Before destroying, send reconnection data to the evicted peer
                  // Collect information about other peers for reconnection assistance
                  const reconnectPeers = [];
                  peers.forEach((peerConn, peerId) => {
                    // Don't include the peer we're about to evict
                    if (peerId !== furthestPeerContact.id) {
                      reconnectPeers.push(peerId);
                    }
                  });
                  
                  // Send reconnection data to the evicted peer
                  try {
                    furthestPeerConnection.send(JSON.stringify({
                      type: 'reconnection_data',
                      peers: reconnectPeers,
                      reason: 'evicted_for_relayed_signal'
                    }));
                    console.log(`Sent reconnection data to evicted peer ${furthestPeerContact.id} with ${reconnectPeers.length} alternative peers`);
                  } catch (error) {
                    console.error(`Failed to send reconnection data to evicted peer ${furthestPeerContact.id}:`, error);
                  }
                  
                  // Short delay to allow the message to be sent before destroying the connection
                  setTimeout(() => {
                    furthestPeerConnection.destroy(); // This should trigger 'close' event and removal
                  }, 100);
                }
                // Connect the new peer
                const newPeerInstance = new Peer({ initiator: false, trickle: false, iceServers });
                setupPeerEvents(newPeerInstance, from);
                newPeerInstance.signal(signal);
                peers.set(from, newPeerInstance);
              } else {
                console.log(`Max peers (${maxPeers}) reached. New peer ${from} (dist: ${distanceToNewPeer}) is not closer than furthest ${furthestPeerContact.id} (dist: ${distanceToFurthestPeer}). Ignoring relayed signal.`);
              }
            } else {
              console.log(`Max peers (${maxPeers}) reached, but no furthest peer found to compare. Ignoring relayed signal from ${from}.`);
            }
          }
        }
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
    },
    // Direct subscribe method for backward compatibility
    // This delegates to the gossip protocol's subscribe method
    subscribe: (topic, handler) => {
      if (!gossipProtocol) throw new Error('Gossip protocol not initialized.');
      console.log(`P2PMesh: Client subscribing to topic '${topic}'`);
      gossipProtocol.subscribe(topic, handler);
    },
    // Direct unsubscribe method for backward compatibility
    unsubscribe: (topic, handler) => {
      if (!gossipProtocol) throw new Error('Gossip protocol not initialized.');
      gossipProtocol.unsubscribe(topic, handler);
    }
  };

  return mesh;
}