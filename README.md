# P2PMesh

> A batteries-included transport-agnostic peer-to-peer WebRTC mesh network library for both browsers and Node.js with reliable message broadcasting via gossip protocol.

This project provides a foundational library for creating peer-to-peer mesh networks using WebRTC (`simple-peer`). It features a platform-agnostic API and a pluggable transport layer for signaling, with an initial WebSocket transport implementation. The network implements a sophisticated gossip protocol for reliable message broadcasting across the partial mesh topology and a Kademlia distributed hash table (DHT) for peer discovery and routing.

## Features

- **Peer-to-Peer Mesh:** Connects peers in a partial mesh using `simple-peer` with WebRTC
- **Reliable Message Broadcasting:** Implements an adaptive gossip protocol with acknowledgments and automatic retries
- **Kademlia DHT:** Uses a distributed hash table for efficient peer discovery and message routing
- **Named Transport System:** Flexible transport registration and configuration system
- **Signaling Optimization:** Intelligent signaling that minimizes server load by routing through the mesh when possible
- **Modular Architecture:** Separated concerns with dedicated managers for connections, events, data handling, and relay operations
- **Island Healing:** Advanced network partitioning detection and healing mechanisms
- **Chord Overlay:** Enhanced network topology for improved message routing
- **Platform Compatible:** Works in both Node.js and browser environments
- **ESM First:** Written as ECMAScript Modules for modern JavaScript environments
- **WebSocket Signaling Server:** Includes a production-ready signaling server with Kademlia-aware bootstrapping
- **Comprehensive Examples:** Demonstrates usage in both browser and Node.js environments with real-time chat applications

## Project Structure

```
p2pmesh/
├── docs/
│   ├── transports/
│   │   └── named-transports.md         # Documentation for named transport system
│   └── terraform/
│       └── aws/
│           └── README.md               # AWS deployment documentation
├── examples/
│   ├── chat-browser/                # Browser-based chat application example
│   │   ├── app.js
│   │   └── index.html
│   └── chat-node/                   # Node.js chat application example
│       └── app.js
├── src/
│   ├── gossip/                      # Gossip protocol components
│   │   ├── chord-overlay.js         # Chord-like overlay network
│   │   ├── gossip-message.js        # Message structure and validation
│   │   ├── island-healing.js        # Network partition healing
│   │   ├── message-router.js        # Intelligent message routing
│   │   └── peer-reachability.js     # Peer connectivity tracking
│   ├── peer-manager/                # Peer connection management
│   │   ├── connection-manager.js    # WebRTC connection lifecycle
│   │   ├── data-handler.js          # Message processing and routing
│   │   ├── event-manager.js         # Event handling and propagation
│   │   └── relay-manager.js         # Message relay and forwarding
│   ├── servers/
│   │   └── websocket-server.js      # Production WebSocket signaling server
│   ├── transports/
│   │   ├── aws-websocket-transport.js # AWS WebSocket transport
│   │   ├── transport-interface.js   # Abstract transport interface
│   │   ├── transport-registry.js    # Named transport registry system
│   │   ├── websocket-transport.js   # WebSocket transport implementation
│   │   └── webtorrent-transport.js  # WebTorrent transport implementation
│   ├── utils/
│   │   ├── peer-id-generator.js     # Secure peer ID generation
│   │   └── simple-peer-loader.js    # Cross-platform SimplePeer loading
│   ├── gossip.js                    # Main gossip protocol orchestrator
│   ├── index.js                     # Main P2PMesh API (createMesh function)
│   ├── kademlia.js                  # Kademlia DHT implementation
│   ├── p2p-mesh.js                  # Core P2PMesh class
│   ├── peer-discovery.js            # Peer discovery and connection strategies
│   ├── peer-manager.js              # Peer connection manager
│   └── signaling-optimizer.js       # Signaling optimization system
├── terraform/
│   └── aws/                         # AWS deployment infrastructure
│       ├── lambda/                  # Lambda function code
│       ├── main.tf                  # Terraform configuration
│       ├── variables.tf             # Terraform variables
│       └── deploy.sh                # Deployment script
├── .gitignore
├── LICENSE
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
git clone <repository-url>
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

## Signaling Server

The included WebSocket signaling server provides production-ready features:

### Features

- **Kademlia-aware bootstrapping**: Sends closest peers to new joiners
- **Batched signal handling**: Optimizes signaling traffic
- **Connection management**: Handles peer joins, leaves, and reconnections
- **Error handling**: Robust error handling and recovery

### Running the Server

```bash
npm run start:server
```

The server will start on `ws://localhost:8080` by default.

### Server Configuration

The server can be customized by modifying `src/servers/websocket-server.js`:

```javascript
// Change port
const wss = new WebSocketServer({ port: 9090 });

// Adjust bootstrap peer count
const K_BOOTSTRAP_COUNT = 10;
```

## Troubleshooting

### Common Issues

#### Connection Problems

1. **Peers not connecting**: Check that the signaling server is running and accessible
2. **WebRTC failures**: Verify ICE servers are configured correctly
3. **Firewall issues**: Ensure required ports are open for WebRTC

#### Performance Issues

1. **High CPU usage**: Reduce `maxPeers` or adjust discovery intervals
2. **Memory leaks**: Ensure proper cleanup by calling `mesh.leave()`
3. **Message delivery delays**: Check network topology and gossip configuration

### Debug Mode

Enable debug logging for detailed information:

```bash
# For Node.js examples
DEBUG=1 node examples/chat-node/app.js
```

### Network Diagnostics

```javascript
// Check peer connections
console.log('Connected peers:', mesh.getPeerCount());
console.log('Peer list:', Array.from(mesh.peers.keys()));

// Monitor gossip protocol
mesh.gossipProtocol.on('message:delivered', (messageId) => {
  console.log('Message delivered:', messageId);
});

mesh.gossipProtocol.on('message:failed', (messageId, reason) => {
  console.log('Message failed:', messageId, reason);
});
```

## API Documentation

### Creating a Mesh Network

#### Using Named Transports (Recommended)

```javascript
import { createMesh } from './src/index.js';

const mesh = await createMesh({
  transportName: 'websocket',
  transportOptions: {
    signalingServerUrl: 'ws://localhost:8080'
  },
  maxPeers: 3, // Maximum number of direct peer connections (default: 3)
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], // ICE servers for WebRTC
  kademliaK: 20 // Optional - Kademlia K parameter (contacts per bucket)
});

// Join the mesh network
await mesh.join();
```

#### Using Direct Transport Instances (Alternative)

```javascript
import { createMesh } from './src/index.js';
import { WebSocketTransport } from './src/transports/websocket-transport.js';

const transport = new WebSocketTransport('ws://localhost:8080');

const mesh = await createMesh({
  peerId: 'optional-custom-peer-id', // Optional - will be generated if not provided
  transport: transport,
  maxPeers: 3,
  bootstrapNodes: [], // Optional array of bootstrap nodes for the Kademlia DHT
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  kademliaK: 20
});

await mesh.join();
```

#### Using Multiple Transports (Multi-Transport)

```javascript
import { createMesh } from './src/index.js';

const mesh = await createMesh({
  transportConfigs: [
    {
      name: 'websocket',
      id: 'websocket-primary',
      options: { signalingServerUrl: 'ws://localhost:8080' }
    },
    {
      name: 'websocket',
      id: 'websocket-backup', 
      options: { signalingServerUrl: 'ws://localhost:8081' }
    }
  ],
  maxPeers: 10
});

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

mesh.on('peer:error', (data) => {
  console.log(`Peer error:`, data);
});

mesh.on('peer:evicted', (data) => {
  console.log(`Evicted from mesh:`, data.reason);
  console.log(`Alternative peers provided:`, data.alternativePeers);
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

// Send structured data
mesh.send(peerId, JSON.stringify({
  type: 'chat',
  message: 'Hello from the mesh!',
  timestamp: Date.now()
}));

// Broadcast a message to all peers (uses gossip protocol)
mesh.sendBroadcast('chat_topic', 'Hello broadcast message');

// Broadcast with custom options
mesh.sendBroadcast('announcements', {
  type: 'system',
  message: 'Network maintenance in 5 minutes'
}, {
  ttl: 30000, // Time to live in milliseconds
  maxHops: 5  // Maximum number of hops
});
```

### Leaving the Mesh

```javascript
// Gracefully leave the mesh network
await mesh.leave();
```

## Architecture Overview

### Core Components

- **P2PMesh**: Main orchestrator class that coordinates all components
- **PeerManager**: Manages WebRTC peer connections and their lifecycle
- **KademliaDHT**: Distributed hash table for peer discovery and routing
- **GossipProtocol**: Reliable message broadcasting with acknowledgments
- **PeerDiscovery**: Intelligent peer discovery and connection strategies
- **SignalingOptimizer**: Reduces signaling server load by routing through mesh

### Modular Peer Management

The peer management system is split into specialized components:

- **ConnectionManager**: Handles WebRTC connection establishment and maintenance
- **DataHandler**: Processes incoming messages and routes them appropriately
- **EventManager**: Manages event propagation and handling
- **RelayManager**: Handles message forwarding and relay operations

### Advanced Gossip Features

- **Island Healing**: Detects and repairs network partitions
- **Chord Overlay**: Provides enhanced network topology for better coverage
- **Message Router**: Intelligent routing based on network topology
- **Peer Reachability**: Tracks peer connectivity and availability

# P2P Mesh Network

A peer-to-peer mesh networking library with advanced routing, discovery, and communication capabilities.

## Architecture Layers

The P2P mesh network is built using a layered architecture that separates concerns and provides modularity:

### 1. Application Layer
- **User Interface**: Where applications interact with the mesh network
- **Event Handlers**: Custom handlers for `message`, `peer:connected`, `peer:disconnected`, etc.
- **Business Logic**: Application-specific functionality built on top of the mesh

### 2. Protocol Layer
- **Message Routing**: High-level message passing between peers
- **Data Serialization**: JSON-based message formatting and parsing
- **Event Management**: Publishing and subscribing to network events
- **Error Handling**: Application-level error recovery and reporting

### 3. Mesh Management Layer
- **Peer Discovery**: Finding and connecting to peers in the network
- **Connection Management**: Maintaining peer connections and handling reconnections
- **Network Topology**: Managing the mesh structure and peer relationships
- **Load Balancing**: Distributing connections and traffic across the network

### 4. Signaling Layer
- **WebRTC Signaling**: ICE candidate exchange and SDP offer/answer negotiation
- **Relay Mechanisms**: Signal routing through intermediate peers when direct connection fails
- **Signaling Optimization**: Batching and optimizing signaling messages for efficiency
- **Connection Establishment**: Coordinating the WebRTC connection setup process

### 5. Routing Layer
- **Kademlia DHT**: Distributed hash table for peer discovery and data storage
- **Gossip Protocol**: Efficient message dissemination across the network
- **Path Finding**: Determining optimal routes for message delivery
- **Network Maintenance**: Keeping routing tables updated and handling topology changes

### 6. Transport Layer
- **WebRTC Data Channels**: Low-level peer-to-peer communication
- **Connection State Management**: Tracking connection status and quality
- **Flow Control**: Managing data transmission rates and buffering
- **Reliability**: Ensuring message delivery and handling transmission errors

### 7. Data Handling Layer
- **Message Parsing**: Converting raw data into structured messages
- **Protocol Filtering**: Separating internal protocol messages from application data
- **Message Validation**: Ensuring data integrity and format compliance
- **Type Routing**: Directing different message types to appropriate handlers

## Layer Interactions

```
┌─────────────────────┐
│  Application Layer  │ ← User code, event handlers
├─────────────────────┤
│   Protocol Layer    │ ← Message routing, serialization
├─────────────────────┤
│ Mesh Management     │ ← Peer discovery, topology
├─────────────────────┤
│  Signaling Layer    │ ← WebRTC signaling, relay
├─────────────────────┤
│   Routing Layer     │ ← Kademlia DHT, gossip
├─────────────────────┤
│  Transport Layer    │ ← WebRTC data channels
├─────────────────────┤
│ Data Handling Layer │ ← Message parsing, filtering
└─────────────────────┘
```

### Internal vs External Messages

The data handling layer filters messages to prevent internal protocol communications from reaching the application:

- **Internal Messages**: `kademlia_rpc`, `relay_signal`, `relay_ack`, `relay_failure`, `optimized_relay_signal`, `batched_signals`
- **Application Messages**: User-defined messages, `gossip` data, general `message` events

This separation ensures that protocol-level communications don't interfere with application logic while maintaining transparency for debugging and monitoring.

## Getting Started

```javascript
import { P2PMesh } from './src/index.js';

const mesh = new P2PMesh({
  localPeerId: 'your-peer-id'
});

// Application layer event handling
mesh.on('message', ({ from, data }) => {
  console.log('Received message from', from, ':', data);
});

mesh.on('peer:connected', (peerId) => {
  console.log('Peer connected:', peerId);
});

await mesh.start();
```
