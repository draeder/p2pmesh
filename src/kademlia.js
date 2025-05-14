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
  }

  /**
   * Adds a contact (peer) to the appropriate k-bucket.
   * @param {object} contact - Contact info { id: string, address: any, ... }
   */
  addContact(contact) {
    if (contact.id === this.localNodeId) return; // Don't add self

    const distance = calculateDistance(this.localNodeId, contact.id);
    const bucketIndex = this.getBucketIndex(distance);

    const bucket = this.buckets[bucketIndex];
    const existingContactIndex = bucket.findIndex(c => c.id === contact.id);

    if (existingContactIndex !== -1) {
      // Contact already exists, move to the end (most recently seen)
      const existingContact = bucket.splice(existingContactIndex, 1)[0];
      bucket.push(existingContact);
    } else {
      if (bucket.length < K) {
        bucket.push(contact);
      } else {
        // Bucket is full, try to ping the least recently seen contact (head of the list)
        // If it doesn't respond, remove it and add the new one.
        // This part requires RPC (PING) and is simplified here.
        console.log(`Bucket ${bucketIndex} is full. Eviction logic needed for contact ${contact.id}.`);
        // For now, we'll just drop the new contact if the bucket is full
        // In a real implementation: ping bucket[0], if no response, remove bucket[0] and add contact
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
 */
class KademliaDHT {
  constructor(localNodeId, transport, options = {}) {
    this.nodeId = generateNodeId(localNodeId); // Ensure we have a Kademlia-style ID
    this.transport = transport; // For sending RPC messages
    this.routingTable = new RoutingTable(this.nodeId);
    this.k = options.k || K;
    this.alpha = options.alpha || ALPHA;
    this.storage = new Map(); // Simple key-value store

    this.rpc = new KademliaRPC(this);
    // The transport should be adapted to route Kademlia RPC messages
    // e.g., transport.on('kademlia_rpc', ({from, message}) => this.rpc.handleMessage(from, message));
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
   * Initiates a FIND_NODE RPC to find k closest peers to targetId.
   * This is a simplified iterative process.
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

    while (lookupRound < 10) { // Limit iterations to prevent infinite loops
        const promises = [];
        let newNodesFoundInRound = false;

        // Select alpha nodes that haven't been queried yet
        const currentBatchToQuery = nodesToQuery
            .filter(n => !queried.has(n.id))
            .slice(0, this.alpha);

        if (currentBatchToQuery.length === 0) {
            console.log('Kademlia: FIND_NODE - No new nodes to query in this batch.');
            break; // No more unqueried nodes in the current closest set
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
                        console.error(`Kademlia: FIND_NODE - Error querying ${contact.id}:`, err);
                        // Handle unresponsive node, e.g., remove from routing table or mark as stale
                        this.routingTable.removeContact(contact.id);
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

    for (let i = 0; i < 10 && !valueFound; i++) { // Limit iterations
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
                    .catch(err => console.error(`Kademlia: FIND_VALUE - Error querying ${contact.id}:`, err))
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

  // Method to be called by transport when a Kademlia message is received
  handleIncomingRpc(fromPeerId, message) {
    // Assuming 'fromPeerId' is the Kademlia ID of the sender
    // and 'message' is the parsed Kademlia RPC message object
    // The actual peer object (with transport details) might be needed for sending replies
    // This requires the transport to map its internal peer IDs/connections to Kademlia IDs
    console.log(`Kademlia: Received RPC from ${fromPeerId}:`, message);
    // Add sender to routing table (common Kademlia practice)
    // The 'address' here is conceptual; it's whatever the transport needs to reply.
    // This might be implicit if the transport handles replies based on incoming connection.
    this.routingTable.addContact({ id: fromPeerId, address: 'unknown' /* placeholder */ });

    return this.rpc.handleMessage(fromPeerId, message);
  }
}

/**
 * Handles Kademlia RPC messages (PING, FIND_NODE, FIND_VALUE, STORE).
 */
class KademliaRPC {
  constructor(dhtInstance) {
    this.dht = dhtInstance; // Reference to the main KademliaDHT instance
  }

  // --- Methods to send RPCs (via transport) ---
  async sendPing(toPeerId) {
    const message = { type: 'PING', id: this.dht.nodeId, rpcId: generateNodeId() };
    console.log(`Kademlia: Sending PING to ${toPeerId}`);
    // The transport needs a way to send to a Kademlia ID, or this needs the transport-specific peer object.
    // For now, assume transport.sendKademliaMessage(toPeerId, message) exists or similar.
    // This will be a promise that resolves with the PONG or times out.
    return this.dht.transport.sendKademliaRpc(toPeerId, message); // Conceptual
  }

  async sendFindNode(toPeerId, targetId) {
    const message = { type: 'FIND_NODE', id: this.dht.nodeId, targetId, rpcId: generateNodeId() };
    console.log(`Kademlia: Sending FIND_NODE to ${toPeerId} for target ${targetId}`);
    return this.dht.transport.sendKademliaRpc(toPeerId, message); // Conceptual, returns Promise<contacts[]>
  }

  async sendFindValue(toPeerId, key) {
    const message = { type: 'FIND_VALUE', id: this.dht.nodeId, key, rpcId: generateNodeId() };
    console.log(`Kademlia: Sending FIND_VALUE to ${toPeerId} for key ${key}`);
    return this.dht.transport.sendKademliaRpc(toPeerId, message); // Conceptual, returns Promise<{value?:any, contacts?:[]}>
  }

  async sendStore(toPeerId, key, value) {
    const message = { type: 'STORE', id: this.dht.nodeId, key, value, rpcId: generateNodeId() };
    console.log(`Kademlia: Sending STORE to ${toPeerId} for key ${key}`);
    return this.dht.transport.sendKademliaRpc(toPeerId, message); // Conceptual, returns Promise<ack>
  }

  // --- Methods to handle incoming RPCs ---
  // This method is called by KademliaDHT.handleIncomingRpc
  handleMessage(fromPeerId, message) {
    console.log(`KademliaRPC: Handling message from ${fromPeerId}:`, message);
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
    // The transport needs to send this reply back to fromPeerId, associated with this request (e.g. using rpcId)
    return { type: 'PONG', id: this.dht.nodeId, inReplyTo: message.rpcId };
  }

  handleFindNode(fromPeerId, message) {
    console.log(`KademliaRPC: Received FIND_NODE from ${fromPeerId} for target ${message.targetId} (RPC ID: ${message.rpcId})`);
    const closest = this.dht.routingTable.findClosestContacts(message.targetId, this.dht.k);
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