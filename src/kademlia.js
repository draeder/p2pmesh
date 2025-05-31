// src/kademlia.js

// Constants
const K = 20; // Kademlia k-bucket size
const ALPHA = 3; // Kademlia alpha concurrency parameter
const ID_LENGTH = 160; // Bits (SHA-1)

/**
 * Generates a random Kademlia ID (or uses a provided string).
 * For simplicity, this example will use hex strings. In a real scenario,
 * these would be byte arrays or BigInts for XOR distance.
 * @param {string} [idString] - Optional string to convert to an ID.
 * @returns {string} A Kademlia node ID.
 */
function generateNodeId(idString) {
  if (idString) return idString; // Use provided ID directly for now
  // In a real implementation, ensure it's a valid SHA-1 hex string or generate one
  let id = '';
  for (let i = 0; i < ID_LENGTH / 4; i++) { // 4 bits per hex char
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

/**
 * Calculates the XOR distance between two Kademlia IDs.
 * Assumes IDs are hex strings of the same length.
 * @param {string} id1
 * @param {string} id2
 * @returns {BigInt} The XOR distance.
 */
function calculateDistance(id1, id2) {
  if (id1.length !== id2.length) {
    throw new Error('Node IDs must have the same length for distance calculation.');
  }
  // Convert hex strings to BigInts for XOR operation
  const bigInt1 = BigInt('0x' + id1);
  const bigInt2 = BigInt('0x' + id2);
  return bigInt1 ^ bigInt2;
}

/**
 * Represents a Kademlia routing table.
 */
class RoutingTable {
  constructor(localNodeId) {
    this.localNodeId = localNodeId;
    this.buckets = Array.from({ length: ID_LENGTH }, () => []); // One bucket for each bit position
    this.dht = null; // Reference to parent DHT instance for connection checking
  }

  /**
   * FIXED: Adds a contact with stable eviction and connection status checking
   * @param {object} contact - Contact info { id: string, address: any, ... }
   */
  addContact(contact) {
    if (contact.id === this.localNodeId) return; // Don't add self

    const distance = calculateDistance(this.localNodeId, contact.id);
    const bucketIndex = this.getBucketIndex(distance);

    const bucket = this.buckets[bucketIndex];
    const existingContactIndex = bucket.findIndex(c => c.id === contact.id);

    if (existingContactIndex !== -1) {
      // Contact already exists, update timestamp and move to end (most recently seen)
      const existingContact = bucket.splice(existingContactIndex, 1)[0];
      existingContact.lastSeen = Date.now();
      existingContact.address = contact.address; // Update address if changed
      bucket.push(existingContact);
      console.log(`Kademlia: Updated existing contact ${contact.id} in bucket ${bucketIndex}`);
    } else {
      // Add timestamp to new contact
      const newContact = {
        ...contact,
        lastSeen: Date.now(),
        failureCount: 0
      };
      
      if (bucket.length < K) {
        bucket.push(newContact);
        console.log(`Kademlia: Added new contact ${contact.id} to bucket ${bucketIndex} (${bucket.length}/${K})`);
      } else {
        // FIXED: Stable bucket management - check connection status before eviction
        console.log(`Kademlia: Bucket ${bucketIndex} is full (${bucket.length}/${K}), evaluating eviction for ${contact.id}`);
        
        // Find the least recently seen contact that's not currently connected
        let candidateForEviction = null;
        let oldestTime = Date.now();
        
        for (const existingContact of bucket) {
          // Check if this contact is currently connected via WebRTC
          const isConnected = this.isContactConnected(existingContact.id);
          
          if (!isConnected && existingContact.lastSeen < oldestTime) {
            oldestTime = existingContact.lastSeen;
            candidateForEviction = existingContact;
          }
        }
        
        if (candidateForEviction) {
          // Remove the disconnected, oldest contact
          const evictIndex = bucket.indexOf(candidateForEviction);
          bucket.splice(evictIndex, 1);
          bucket.push(newContact);
          console.log(`Kademlia: Evicted disconnected contact ${candidateForEviction.id} for ${contact.id} in bucket ${bucketIndex}`);
        } else {
          // All contacts are connected, check failure counts
          let highestFailureContact = null;
          let highestFailures = -1;
          
          for (const existingContact of bucket) {
            if ((existingContact.failureCount || 0) > highestFailures) {
              highestFailures = existingContact.failureCount || 0;
              highestFailureContact = existingContact;
            }
          }
          
          if (highestFailureContact && highestFailures > 2) {
            // Evict contact with highest failure count
            const evictIndex = bucket.indexOf(highestFailureContact);
            bucket.splice(evictIndex, 1);
            bucket.push(newContact);
            console.log(`Kademlia: Evicted unreliable contact ${highestFailureContact.id} (${highestFailures} failures) for ${contact.id}`);
          } else {
            // All contacts are good, don't add the new one
            console.log(`Kademlia: Bucket ${bucketIndex} full with good contacts, not adding ${contact.id}`);
          }
        }
      }
    }
  }

  /**
   * FIXED: Check if a contact is currently connected via WebRTC
   * @param {string} contactId - Contact ID to check
   * @returns {boolean} True if connected
   */
  isContactConnected(contactId) {
    // This will be set by the DHT instance when peer manager is available
    if (this.dht && this.dht.peerManager) {
      const peers = this.dht.peerManager.getPeers();
      const peer = peers.get(contactId);
      return peer && peer.connected;
    }
    return false;
  }

  /**
   * FIXED: Mark a contact as failed (for RPC timeouts, etc.)
   * @param {string} contactId - Contact ID that failed
   */
  markContactFailed(contactId) {
    for (const bucket of this.buckets) {
      const contact = bucket.find(c => c.id === contactId);
      if (contact) {
        contact.failureCount = (contact.failureCount || 0) + 1;
        contact.lastFailure = Date.now();
        console.log(`Kademlia: Marked contact ${contactId} as failed (${contact.failureCount} failures)`);
        
        // Remove contact if it has too many failures and isn't connected
        if (contact.failureCount > 5 && !this.isContactConnected(contactId)) {
          this.removeContact(contactId);
          console.log(`Kademlia: Removed unreliable contact ${contactId} after ${contact.failureCount} failures`);
        }
        break;
      }
    }
  }

  /**
   * Finds the k closest contacts to a given target ID.
   * @param {string} targetId - The ID to find contacts close to.
   * @param {number} count - The number of contacts to return (k).
   * @returns {Array<object>} Sorted list of closest contacts.
   */
  findClosestContacts(targetId, count = K) {
    const allContacts = this.buckets.flat();
    if (allContacts.length === 0) return [];

    allContacts.sort((a, b) => {
      const distA = calculateDistance(targetId, a.id);
      const distB = calculateDistance(targetId, b.id);
      return distA < distB ? -1 : (distA > distB ? 1 : 0);
    });

    return allContacts.slice(0, count);
  }

  /**
   * Gets all contacts from all buckets (for Chord overlay)
   * @returns {Array<object>} All contacts in the routing table
   */
  getAllContacts() {
    return this.buckets.flat();
  }

  /**
   * Gets the bucket index for a given distance.
   * This is the index of the most significant bit of the XOR distance.
   * @param {BigInt} distance
   * @returns {number} The bucket index (0 to ID_LENGTH - 1).
   */
  getBucketIndex(distance) {
    if (distance === 0n) return 0; // Should not happen if not adding self
    let index = 0;
    let tempDistance = distance;
    while (tempDistance > 1n) {
      tempDistance >>= 1n;
      index++;
    }
    // Index should be from 0 to ID_LENGTH - 1
    // If distance is 2^i, index is i. We want ID_LENGTH - 1 - i for typical Kademlia bucket indexing
    // (closer peers in higher index buckets if MSB is used, or lower if LSB)
    // Let's use a common approach: index is the position of the MSB of the distance.
    // For distance d, bucket index is floor(log2(d)).
    // A simpler way: find the highest bit set in distance.
    // Example: ID_LENGTH = 160. If distance is 2^159, it goes in bucket 159.
    // If distance is 1 (2^0), it goes in bucket 0.
    return Math.max(0, ID_LENGTH - 1 - index); // This might need adjustment based on convention
    // A more direct way: find the length of the binary string of distance - 1
    // return distance.toString(2).length -1;
  }

  removeContact(peerId) {
    for (const bucket of this.buckets) {
        const index = bucket.findIndex(contact => contact.id === peerId);
        if (index !== -1) {
            bucket.splice(index, 1);
            console.log(`Kademlia: Removed contact ${peerId}`);
            return;
        }
    }
  }

  /**
   * Finds the contact with the largest XOR distance from the local node.
   * @returns {object|null} The furthest contact or null if no contacts.
   */
  getFurthestContact() {
    const allContacts = this.buckets.flat();
    if (allContacts.length === 0) return null;

    let furthestContact = null;
    let maxDistance = -1n; // BigInt(-1)

    for (const contact of allContacts) {
      if (contact.id === this.localNodeId) continue; // Should not happen if addContact filters self
      const distance = calculateDistance(this.localNodeId, contact.id);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthestContact = contact;
      }
    }
    return furthestContact;
  }
}

/**
 * Kademlia DHT instance.
 * FIXED: Now uses direct WebRTC peer connections instead of WebSocket transport
 */
class KademliaDHT {
  constructor(localNodeId, transport, options = {}) {
    this.nodeId = generateNodeId(localNodeId); // Ensure we have a Kademlia-style ID
    this.transport = transport; // Keep for initial bootstrapping only
    this.routingTable = new RoutingTable(this.nodeId);
    this.k = options.k || K;
    this.alpha = options.alpha || ALPHA;
    this.storage = new Map(); // Simple key-value store
    
    // FIXED: Reference to peer manager for direct WebRTC communication
    this.peerManager = null; // Will be set by P2PMesh
    
    // FIXED: Pending RPC requests (for handling responses)
    this.pendingRpcs = new Map();

    this.rpc = new KademliaRPC(this);
  }

  /**
   * FIXED: Set peer manager reference for direct WebRTC communication
   * @param {PeerManager} peerManager - The peer manager instance
   */
  setPeerManager(peerManager) {
    this.peerManager = peerManager;
    console.log('Kademlia: Peer manager reference set for direct WebRTC communication');
  }

  /**
   * Bootstrap the DHT by connecting to known peers.
   * @param {Array<object>} bootstrapNodes - Array of {id, address} objects.
   */
  async bootstrap(bootstrapNodes = []) {
    console.log(`Kademlia: Bootstrapping with nodes:`, bootstrapNodes);
    for (const node of bootstrapNodes) {
      this.routingTable.addContact(node); // Add them directly for now
      // In a real scenario, you'd PING them first
      // Then, perform a FIND_NODE for your own ID to populate buckets
      await this.findNode(this.nodeId); // Discover network around self
    }
    if (bootstrapNodes.length === 0) {
        console.log('Kademlia: No bootstrap nodes provided. Waiting for incoming connections.');
    }
  }

  /**
   * FIXED: Initiates a FIND_NODE RPC with better error handling and shorter timeouts
   * @param {string} targetId
   * @returns {Promise<Array<object>>} List of k closest contacts found.
   */
  async findNode(targetId) {
    console.log(`Kademlia: Initiating FIND_NODE for ${targetId}`);
    let closestNodes = this.routingTable.findClosestContacts(targetId, this.k);
    let queried = new Set();
    let lookupRound = 0;

    // Keep track of nodes to query in the current iteration
    let nodesToQuery = [...closestNodes];

    while (lookupRound < 5) { // FIXED: Reduced iterations to prevent long waits
        const promises = [];
        let newNodesFoundInRound = false;

        // Select alpha nodes that haven't been queried yet
        // If we have a peer manager, prefer nodes with WebRTC connections
        let candidateNodes = nodesToQuery.filter(n => !queried.has(n.id));
        
        if (this.peerManager) {
          const peers = this.peerManager.getPeers();
          const nodesWithConnections = candidateNodes.filter(n => {
            const peer = peers.get(n.id);
            return peer && peer.connected;
          });
          
          // If we have nodes with active connections, use only those
          // Otherwise, use all candidate nodes (for initial bootstrap)
          if (nodesWithConnections.length > 0) {
            candidateNodes = nodesWithConnections;
            console.log(`Kademlia: Found ${nodesWithConnections.length} nodes with active WebRTC connections`);
          } else {
            console.log(`Kademlia: No active WebRTC connections, using all ${candidateNodes.length} candidate nodes`);
          }
        } else {
          console.log(`Kademlia: No peer manager available, using all ${candidateNodes.length} candidate nodes`);
        }
        
        const currentBatchToQuery = candidateNodes.slice(0, this.alpha);

        if (currentBatchToQuery.length === 0) {
            // Check if we have any nodes in routing table but no WebRTC connections
            const unqueriedNodes = nodesToQuery.filter(n => !queried.has(n.id));
            if (unqueriedNodes.length > 0) {
              console.log(`Kademlia: FIND_NODE - ${unqueriedNodes.length} nodes available but no WebRTC connections established yet. Waiting for connections...`);
            } else {
              console.log('Kademlia: FIND_NODE - No new nodes to query in this batch.');
            }
            break; // No more unqueried nodes with active connections
        }

        for (const contact of currentBatchToQuery) {
            queried.add(contact.id);
            console.log(`Kademlia: FIND_NODE - Querying ${contact.id} for ${targetId}`);
            promises.push(
                this.rpc.sendFindNode(contact.id, targetId)
                    .then(foundContacts => {
                        if (foundContacts && foundContacts.length > 0) {
                            console.log(`Kademlia: FIND_NODE - Received ${foundContacts.length} contacts from ${contact.id}`);
                            foundContacts.forEach(foundContact => {
                                // Ensure foundContact has an 'id' property
                                if (foundContact && foundContact.id) {
                                    this.routingTable.addContact(foundContact); // Add to our routing table
                                    // Check if this node is closer and not already in closestNodes or queried
                                    if (!closestNodes.find(cn => cn.id === foundContact.id) && !queried.has(foundContact.id)) {
                                        newNodesFoundInRound = true;
                                    }
                                } else {
                                    console.warn('Kademlia: FIND_NODE - Received contact without ID from', contact.id, ':', foundContact);
                                }
                            });
                        } else {
                            console.log(`Kademlia: FIND_NODE - No contacts received from ${contact.id} or contact unresponsive.`);
                            // Optionally handle unresponsive nodes (e.g., remove from routing table after retries)
                        }
                    })
                    .catch(err => {
                        console.warn(`Kademlia: FIND_NODE - Error querying ${contact.id}:`, err.message);
                        // FIXED: Don't remove contact immediately, just log the error
                        // this.routingTable.removeContact(contact.id);
                    })
            );
        }

        await Promise.all(promises);

        // Update closestNodes with all known contacts and re-sort
        const allKnownContacts = this.routingTable.findClosestContacts(targetId, this.k * 2); // Get more to ensure we have k after filtering
        const newClosestNodes = allKnownContacts.sort((a, b) => {
            const distA = calculateDistance(targetId, a.id);
            const distB = calculateDistance(targetId, b.id);
            if (distA < distB) return -1;
            if (distA > distB) return 1;
            return 0;
        }).slice(0, this.k);

        // If the new set of closest nodes is the same as the old one, and no new nodes were found to query, we might be done
        if (JSON.stringify(newClosestNodes.map(n => n.id)) === JSON.stringify(closestNodes.map(n => n.id)) && !newNodesFoundInRound && currentBatchToQuery.length < this.alpha) {
            console.log('Kademlia: FIND_NODE - Converged.');
            break;
        }
        closestNodes = newClosestNodes;
        nodesToQuery = [...closestNodes]; // Prepare for next round based on the updated closest list

        if (!newNodesFoundInRound && currentBatchToQuery.length < this.alpha) {
            console.log('Kademlia: FIND_NODE - No new nodes discovered in this round and queried all available from current closest set.');
            break;
        }
        lookupRound++;
    }
    console.log(`Kademlia: FIND_NODE for ${targetId} completed. Found:`, closestNodes.map(c => c.id));
    return closestNodes;
  }

  // Placeholder for STORE RPC
  async store(key, value) {
    console.log(`Kademlia: Attempting to STORE key ${key}`);
    const targetId = generateNodeId(key); // Or hash the key to get a Kademlia ID
    const closestNodes = await this.findNode(targetId);
    // Send STORE RPC to these k nodes
    closestNodes.forEach(node => {
      this.rpc.sendStore(node.id, key, value);
    });
    console.log(`Kademlia: STORE RPC sent to ${closestNodes.length} nodes for key ${key}`);
  }

  // Placeholder for FIND_VALUE RPC
  async findValue(key) {
    console.log(`Kademlia: Attempting to FIND_VALUE for key ${key}`);
    const targetId = generateNodeId(key); // Or hash the key

    // Check local storage first
    if (this.storage.has(key)) {
      return { value: this.storage.get(key), foundNatively: true };
    }

    // Iterative lookup similar to findNode but for value
    // This is a simplified version
    let closestNodes = this.routingTable.findClosestContacts(targetId, this.k);
    let queried = new Set();
    let valueFound = null;

    for (let i = 0; i < 5 && !valueFound; i++) { // FIXED: Reduced iterations
        const promises = [];
        const currentBatchToQuery = closestNodes.filter(n => !queried.has(n.id)).slice(0, this.alpha);

        if (currentBatchToQuery.length === 0) break;

        for (const contact of currentBatchToQuery) {
            queried.add(contact.id);
            promises.push(
                this.rpc.sendFindValue(contact.id, key)
                    .then(response => {
                        if (response && response.value) {
                            console.log(`Kademlia: FIND_VALUE - Value found for ${key} at ${contact.id}`);
                            valueFound = response.value;
                            // TODO: Cache the value locally if rules allow
                            // TODO: Potentially send STORE to the closest node that didn't have it
                        } else if (response && response.contacts) {
                            console.log(`Kademlia: FIND_VALUE - Got ${response.contacts.length} closer contacts for ${key} from ${contact.id}`);
                            response.contacts.forEach(c => this.routingTable.addContact(c));
                        }
                    })
                    .catch(err => console.warn(`Kademlia: FIND_VALUE - Error querying ${contact.id}:`, err.message))
            );
        }
        await Promise.all(promises);
        if (valueFound) break;
        closestNodes = this.routingTable.findClosestContacts(targetId, this.k); // Re-evaluate closest nodes
    }

    if (valueFound) {
        return { value: valueFound, foundNatively: false };
    }
    console.log(`Kademlia: FIND_VALUE - Value for ${key} not found after lookup.`);
    return { value: null, foundNatively: false };
  }

  /**
   * FIXED: Handle incoming Kademlia RPC via direct WebRTC peer connection
   * @param {string} fromPeerId - Peer ID sending the message
   * @param {Object} message - Kademlia RPC message
   * @returns {Object|null} Response message or null
   */
  handleIncomingRpc(fromPeerId, message) {
    console.log(`Kademlia: Received RPC via WebRTC from ${fromPeerId}:`, message.type, `(RPC ID: ${message.rpcId})`);
    
    // Add sender to routing table (common Kademlia practice)
    this.routingTable.addContact({ id: fromPeerId, address: fromPeerId });

    const response = this.rpc.handleMessage(fromPeerId, message);
    
    // FIXED: Send response directly via WebRTC peer connection
    if (response && this.peerManager) {
      console.log(`Kademlia: Sending RPC response ${response.type} to ${fromPeerId} (in reply to: ${response.inReplyTo})`);
      this.peerManager.sendRawToPeer(fromPeerId, {
        type: 'kademlia_rpc',
        message: response
      });
    }
    
    return response;
  }

  /**
   * FIXED: Handle incoming Kademlia RPC response via direct WebRTC
   * @param {string} fromPeerId - Peer ID sending the response
   * @param {Object} response - Kademlia RPC response
   */
  handleIncomingRpcResponse(fromPeerId, response) {
    console.log(`Kademlia: Received RPC response via WebRTC from ${fromPeerId}:`, response.type, `(in reply to: ${response.inReplyTo})`);
    
    // Find and resolve the pending RPC promise
    if (response.inReplyTo && this.pendingRpcs.has(response.inReplyTo)) {
      const { resolve } = this.pendingRpcs.get(response.inReplyTo);
      this.pendingRpcs.delete(response.inReplyTo);
      
      console.log(`Kademlia: Resolving pending RPC ${response.inReplyTo} with response type ${response.type}`);
      
      // Process the response based on type
      switch (response.type) {
        case 'FIND_NODE_REPLY':
          resolve(response.contacts || []);
          break;
        case 'FIND_VALUE_REPLY':
          resolve(response);
          break;
        case 'PONG':
          resolve(true);
          break;
        case 'STORE_REPLY':
          resolve(response.success || false);
          break;
        default:
          resolve(response);
      }
    } else {
      console.warn(`Kademlia: Received response with unknown or missing RPC ID: ${response.inReplyTo}`);
    }
  }
}

/**
 * FIXED: Handles Kademlia RPC messages via direct WebRTC peer connections
 */
class KademliaRPC {
  constructor(dhtInstance) {
    this.dht = dhtInstance; // Reference to the main KademliaDHT instance
  }

  // --- FIXED: Methods to send RPCs via direct WebRTC peer connections ---
  async sendPing(toPeerId) {
    const rpcId = generateNodeId();
    const message = { type: 'PING', id: this.dht.nodeId, rpcId };
    console.log(`Kademlia: Sending PING via WebRTC to ${toPeerId}`);
    
    return this._sendRpcViaWebRTC(toPeerId, message, rpcId);
  }

  async sendFindNode(toPeerId, targetId) {
    const rpcId = generateNodeId();
    const message = { type: 'FIND_NODE', id: this.dht.nodeId, targetId, rpcId };
    console.log(`Kademlia: Sending FIND_NODE via WebRTC to ${toPeerId} for target ${targetId}`);
    
    return this._sendRpcViaWebRTC(toPeerId, message, rpcId);
  }

  async sendFindValue(toPeerId, key) {
    const rpcId = generateNodeId();
    const message = { type: 'FIND_VALUE', id: this.dht.nodeId, key, rpcId };
    console.log(`Kademlia: Sending FIND_VALUE via WebRTC to ${toPeerId} for key ${key}`);
    
    return this._sendRpcViaWebRTC(toPeerId, message, rpcId);
  }

  async sendStore(toPeerId, key, value) {
    const rpcId = generateNodeId();
    const message = { type: 'STORE', id: this.dht.nodeId, key, value, rpcId };
    console.log(`Kademlia: Sending STORE via WebRTC to ${toPeerId} for key ${key}`);
    
    return this._sendRpcViaWebRTC(toPeerId, message, rpcId);
  }

  /**
   * FIXED: Send RPC via direct WebRTC peer connection with shorter timeout and better debugging
   * @param {string} toPeerId - Target peer ID
   * @param {Object} message - RPC message
   * @param {string} rpcId - RPC ID for tracking responses
   * @returns {Promise} Promise that resolves with the response
   */
  async _sendRpcViaWebRTC(toPeerId, message, rpcId) {
    if (!this.dht.peerManager) {
      throw new Error('Kademlia: Peer manager not available for WebRTC communication');
    }

    // Check if we have a direct WebRTC connection to this peer
    const peers = this.dht.peerManager.getPeers();
    const peer = peers.get(toPeerId);
    
    if (!peer || !peer.connected) {
      console.log(`Kademlia: Skipping RPC to ${toPeerId} - WebRTC connection not available (peer exists: ${!!peer}, connected: ${peer?.connected})`);
      throw new Error(`No direct WebRTC connection to ${toPeerId}`);
    }

    console.log(`Kademlia: Peer ${toPeerId} is connected, sending RPC ${message.type} with ID ${rpcId}`);

    // Create a promise to track the response
    return new Promise((resolve, reject) => {
      // Store the promise for when the response arrives
      this.dht.pendingRpcs.set(rpcId, { resolve, reject });
      
      // FIXED: Shorter timeout for faster failure detection
      const timeout = setTimeout(() => {
        if (this.dht.pendingRpcs.has(rpcId)) {
          this.dht.pendingRpcs.delete(rpcId);
          console.warn(`Kademlia: RPC timeout for ${message.type} to ${toPeerId} (RPC ID: ${rpcId})`);
          reject(new Error(`Kademlia RPC timeout for ${message.type} to ${toPeerId}`));
        }
      }, 5000); // FIXED: Reduced to 5 second timeout
      
      // Update the stored promise to clear timeout on resolve
      const originalResolve = resolve;
      this.dht.pendingRpcs.set(rpcId, { 
        resolve: (value) => {
          clearTimeout(timeout);
          console.log(`Kademlia: RPC ${rpcId} resolved successfully`);
          originalResolve(value);
        }, 
        reject: (error) => {
          clearTimeout(timeout);
          console.warn(`Kademlia: RPC ${rpcId} rejected:`, error.message);
          reject(error);
        }
      });

      // Send the RPC via direct WebRTC connection
      try {
        this.dht.peerManager.sendRawToPeer(toPeerId, {
          type: 'kademlia_rpc',
          message: message
        });
        console.log(`Kademlia: Sent ${message.type} via WebRTC to ${toPeerId} (RPC ID: ${rpcId})`);
      } catch (error) {
        clearTimeout(timeout);
        this.dht.pendingRpcs.delete(rpcId);
        console.error(`Kademlia: Failed to send RPC to ${toPeerId}:`, error);
        reject(error);
      }
    });
  }

  // --- Methods to handle incoming RPCs ---
  // This method is called by KademliaDHT.handleIncomingRpc
  handleMessage(fromPeerId, message) {
    console.log(`KademliaRPC: Handling message from ${fromPeerId}:`, message.type, `(RPC ID: ${message.rpcId})`);
    switch (message.type) {
      case 'PING':
        return this.handlePing(fromPeerId, message);
      case 'FIND_NODE':
        return this.handleFindNode(fromPeerId, message);
      case 'FIND_VALUE':
        return this.handleFindValue(fromPeerId, message);
      case 'STORE':
        return this.handleStore(fromPeerId, message);
      // Handle replies (PONG, found nodes/value)
      // These are typically handled by the promises returned from sendX methods
      // But if they come unsolicited or the transport doesn't map replies to requests, handle here.
      default:
        console.warn(`KademliaRPC: Unknown message type from ${fromPeerId}: ${message.type}`);
        return null; // Or an error object
    }
  }

  handlePing(fromPeerId, message) {
    console.log(`KademliaRPC: Received PING from ${fromPeerId} (RPC ID: ${message.rpcId})`);
    // Reply with PONG
    return { type: 'PONG', id: this.dht.nodeId, inReplyTo: message.rpcId };
  }

  handleFindNode(fromPeerId, message) {
    console.log(`KademliaRPC: Received FIND_NODE from ${fromPeerId} for target ${message.targetId} (RPC ID: ${message.rpcId})`);
    const closest = this.dht.routingTable.findClosestContacts(message.targetId, this.dht.k);
    console.log(`KademliaRPC: Returning ${closest.length} closest contacts for FIND_NODE`);
    // Reply with found contacts
    return { type: 'FIND_NODE_REPLY', id: this.dht.nodeId, contacts: closest, inReplyTo: message.rpcId };
  }

  handleFindValue(fromPeerId, message) {
    console.log(`KademliaRPC: Received FIND_VALUE from ${fromPeerId} for key ${message.key} (RPC ID: ${message.rpcId})`);
    if (this.dht.storage.has(message.key)) {
      return {
        type: 'FIND_VALUE_REPLY',
        id: this.dht.nodeId,
        value: this.dht.storage.get(message.key),
        inReplyTo: message.rpcId
      };
    } else {
      const closest = this.dht.routingTable.findClosestContacts(message.key, this.dht.k);
      return {
        type: 'FIND_VALUE_REPLY',
        id: this.dht.nodeId,
        contacts: closest,
        inReplyTo: message.rpcId
      };
    }
  }

  handleStore(fromPeerId, message) {
    console.log(`KademliaRPC: Received STORE from ${fromPeerId} for key ${message.key} (RPC ID: ${message.rpcId})`);
    this.dht.storage.set(message.key, message.value);
    // Reply with ACK or success
    return { type: 'STORE_REPLY', id: this.dht.nodeId, success: true, inReplyTo: message.rpcId };
  }
}

export { KademliaDHT, RoutingTable, generateNodeId, calculateDistance, K, ID_LENGTH };
