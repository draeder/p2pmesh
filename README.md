# P2PMesh

> A batteries-included transport-agnostic peer-to-peer WebRTC mesh network library for both browsers and Node.js with reliable message broadcasting via gossip protocol.

This project provides a foundational library for creating peer-to-peer mesh networks using WebRTC (`simple-peer`). It features a platform-agnostic API and a pluggable transport layer for signaling, with an initial WebSocket transport implementation. The network implements a sophisticated gossip protocol for reliable message broadcasting across the partial mesh topology and a Kademlia distributed hash table (DHT) for peer discovery and routing.

## Features

- **Peer-to-Peer Mesh:** Connects peers in a partial mesh using `simple-peer` with WebRTC.
- **Reliable Message Broadcasting:** Implements an adaptive gossip protocol with acknowledgments and automatic retries.
- **Kademlia DHT:** Uses a distributed hash table for efficient peer discovery and message routing.
- **Agnostic Transport Layer:** Supports different signaling mechanisms with a pluggable transport system.
- **Message Security:** Optional cryptographic message signing and verification.
- **Platform Compatible:** Works in both Node.js and browser environments.
- **ESM First:** Written as ECMAScript Modules for modern JavaScript environments.
- **Signaling Server Example:** Includes a WebSocket-based signaling server.
- **Chat Examples:** Demonstrates usage in both browser and Node.js environments.

## Project Structure

```
.p2pmesh/
├── examples/
│   ├── chat-browser/       # Browser-based chat application example
│   │   ├── app.js
│   │   └── index.html
│   ├── chat-node/          # Node.js chat application example
│   │   └── app.js
│   └── signaling-server.js # WebSocket signaling server
├── src/
│   ├── transports/
│   │   ├── transport-interface.js # Interface for transport implementations
│   │   └── websocket-transport.js# WebSocket transport implementation
│   ├── gossip.js           # Gossip protocol implementation
│   ├── kademlia.js         # Kademlia DHT implementation
│   └── index.js            # Main P2PMesh API (createMesh function)
├── .gitignore
├── package.json
└── README.md
```

## Getting Started

### Prerequisites

- Node.js (v16+ recommended for ESM support)
- npm or yarn

### Installation

Clone the repository and install dependencies:

```bash
# HTTPS
git clone https://github.com/draeder/p2pmesh.git
# SSH
# git clone git@github.com:draeder/p2pmesh.git
cd p2pmesh
npm install
```

### Running the Examples

1.  **Start the Signaling Server:**

    Open a terminal and run:
    ```bash
    npm run start:server
    ```
    This will start the WebSocket signaling server on `ws://localhost:8080`.

2.  **Run the Browser Chat Example:**

    Open another terminal and run:
    ```bash
    npm run dev:chat
    ```
    This command will serve the `examples/chat-browser/` directory and open `index.html` in your default browser. If it doesn't open automatically, navigate to the URL provided in the console (usually `http://localhost:8081` or similar).

    Open multiple browser tabs or windows to simulate different peers.

3.  **Run the Node.js Chat Example (Optional):**

    Open a new terminal and run:
    ```bash
    node examples/chat-node/app.js
    ```
    You can run multiple instances of this script to simulate multiple Node.js peers. They will connect to the same signaling server and can interact with browser peers.

## API Documentation

### Creating a Mesh Network

```javascript
import { createMesh } from './src/index.js'; // Or from 'p2pmesh' if published
import { WebSocketTransport } from './src/transports/websocket-transport.js';

// For Node.js, you might need to polyfill WebSocket if your library expects a global one
// import WebSocket from 'ws';
// if (typeof global.WebSocket === 'undefined') {
//   global.WebSocket = WebSocket;
// }

const signalingServerUrl = 'ws://localhost:8080';
const transport = new WebSocketTransport(signalingServerUrl);

const mesh = await createMesh({
  peerId: 'optional-custom-peer-id', // Optional - will be generated if not provided
  transport: transport, // Required - the transport instance
  maxPeers: 5, // Maximum number of direct peer connections (default: 5)
  bootstrapNodes: [], // Optional array of bootstrap nodes for the Kademlia DHT
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], // ICE servers for WebRTC
  kademliaK: 20 // Optional - Kademlia K parameter (contacts per bucket)
});

// Join the mesh network
await mesh.join();
```

### Events

The mesh instance emits various events that you can listen to:

```javascript
// Connection events
mesh.on('peer:connect', (peerId) => {
  console.log(`Connected to peer: ${peerId}`);
});

mesh.on('peer:disconnect', (peerId) => {
  console.log(`Disconnected from peer: ${peerId}`);
});

mesh.on('peer:timeout', (peerId) => {
  console.log(`Connection to peer ${peerId} timed out`);
});

// Message receiving
mesh.on('message', ({ from, data }) => {
  console.log(`Message from ${from}:`, data);
});
```

### Sending Messages

```javascript
// Send a direct message to a specific peer
mesh.send(peerId, 'Hello direct message');

// Broadcast a message to all peers (uses gossip protocol)
mesh.sendBroadcast('chat_topic', 'Hello broadcast message');
```

### Leaving the Mesh

```javascript
// Gracefully leave the mesh network
await mesh.leave();
```

### WebSocketTransport API

The WebSocketTransport class provides the signaling mechanism for WebRTC connections:

```javascript
import { WebSocketTransport } from './src/transports/websocket-transport.js';

const transport = new WebSocketTransport('ws://localhost:8080');

// Transport events
transport.on('open', () => {
  console.log('Connected to signaling server');
});

transport.on('close', () => {
  console.log('Disconnected from signaling server');
});

transport.on('error', (err) => {
  console.error('Transport error:', err);
});

// The transport is typically provided to createMesh() and not used directly after that
```

## Mesh Network Architecture

P2PMesh creates a partial mesh network where each peer maintains direct WebRTC connections with a subset of all peers (controlled by `maxPeers`). This approach balances connectivity and scalability:

1. **Connection Establishment:**
   - Peers connect to a central signaling server initially for WebRTC handshake
   - After the handshake, peers establish direct peer-to-peer connections
   - No further communication with the signaling server is needed for data exchange

2. **Peer Management:**
   - Each peer maintains up to `maxPeers` direct connections (default: 5)
   - Uses Kademlia DHT's distance metric to optimize peer selection
   - Implements connection timeout handling and automatic reconnection

3. **Peer Eviction Strategy:**
   - When `maxPeers` is reached, new connections are evaluated using Kademlia distance
   - Furthest peers may be evicted to make room for closer peers
   - This strategy optimizes network topology for efficient message routing

## Event System

P2PMesh uses an event-driven architecture for handling various network events:

- `peer:connect` - Emitted when a new peer connection is established
- `peer:disconnect` - Emitted when a peer disconnects
- `peer:timeout` - Emitted when a peer connection attempt times out
- `message` - Emitted when a message is received (direct or broadcast)

In addition, the transport layer emits its own events:

- `open` - Transport connection opened
- `close` - Transport connection closed
- `error` - Transport error occurred
- `signal` - Received WebRTC signaling data
- `connect_request` - Connection request from another peer
- `bootstrap_peers` - List of peers for Kademlia bootstrapping
- `kademlia_rpc_message` - Kademlia RPC messages

## Gossip Protocol Architecture

P2PMesh implements a sophisticated gossip protocol for reliable message broadcasting across the partial mesh network. This enables efficient propagation of messages to all peers even when direct connections don't exist between every pair of peers.

### Key Features

#### Adaptive Peer Selection

The gossip protocol dynamically adjusts its fanout ratio based on network size:

- In small networks (≤5 peers): 100% coverage for maximum reliability
- In medium networks (6-15 peers): 80-90% coverage
- In larger networks (>15 peers): 60-70% coverage with optimized selection

This adaptive approach ensures reliable message delivery while preventing network flooding in larger deployments.

#### Reliable Message Delivery

The protocol implements a sophisticated acknowledgment and retry system:

- Messages are tracked until acknowledged by all target peers
- Automatic retries for unacknowledged messages with exponential backoff
- Original message objects are preserved for perfect retransmission
- Configurable retry intervals and maximum retry attempts

#### Message Security and Integrity

- Optional cryptographic message signing using pluggable crypto providers
- Signature verification to ensure message authenticity
- Message deduplication to prevent cycles
- Time-to-live (TTL) limitation via hop counting

#### Topic-Based Subscription

Applications can subscribe to specific message topics with custom handler functions, creating a flexible pub/sub system across the mesh network.

## Kademlia DHT Implementation

P2PMesh uses a Kademlia Distributed Hash Table (DHT) for efficient peer discovery and message routing:

1. **Peer ID Generation:** 
   - Uses SHA-1 hashing for generating peer IDs compatible with Kademlia
   - Supports custom peer IDs for special network topologies

2. **Routing Table:** 
   - Organizes peers in k-buckets based on XOR distance
   - Provides O(log n) complexity for node lookups
   - Helps with optimizing the peer selection for connections

3. **Bootstrap Process:**
   - Signaling server provides initial peers for bootstrapping
   - Automatically refreshes routing table to maintain network connectivity

## Future Enhancements

- Further Kademlia DHT optimization for peer discovery and data lookup
- Additional transport layer implementations (WebRTC Data Channel, HTTP/WebSockets)  
- Distributed data storage capabilities on top of Kademlia DHT
- End-to-end encryption options for message payloads
- Connection quality metrics and routing optimization
- Comprehensive test suite
- UMD/CDN builds for browser usage without bundlers

## License

MIT
