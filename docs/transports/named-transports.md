# Using Named Transports in P2PMesh

## Overview

P2PMesh now supports a named transport system that allows you to reference transport implementations by name instead of importing and instantiating them directly. This makes your code more flexible and allows for dynamic loading of transport modules.

## How to Use Named Transports

### Basic Usage

Instead of directly instantiating a transport like this:

```javascript
import { WebSocketTransport } from '../src/transports/websocket-transport.js';
const transport = new WebSocketTransport('ws://localhost:8080');

const mesh = await createMesh({
  transport: transport,
  // other options...
});
```

You can now use the named transport system:

```javascript
const mesh = await createMesh({
  transportName: 'websocket',
  transportOptions: {
    signalingServerUrl: 'ws://localhost:8080'
  },
  // other options...
});
```

### Benefits

- **Simplified Imports**: No need to import specific transport implementations
- **Dynamic Configuration**: Transport options can be provided as a configuration object
- **Extensibility**: Custom transports can be registered and used by name
- **Backward Compatibility**: Existing code using direct transport instances still works

## Using with Existing Examples

All existing examples in the P2PMesh project have been updated to support both methods:

### Chat Browser Example

```javascript
// Option 1: Direct transport instantiation (original method)
const transport = new WebSocketTransport(signalingServerUrl);
// ... configure transport events ...

mesh = await createMesh({
  transport,
  // other options...
});

// Option 2: Using named transport (new method)
mesh = await createMesh({
  transportName: 'websocket',
  transportOptions: {
    signalingServerUrl: signalingServerUrl
  },
  // other options...
});

// Option 3: Using multiple transports (new feature)
mesh = await createMesh({
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
    },
    {
      name: 'webtorrent',
      id: 'webtorrent-main',
      options: { infoHash: 'your-room-hash' }
    }
  ]
});
```

### Chat Node Example

The Node.js example follows the same pattern, allowing you to choose either method, plus new multi-transport support:

```bash
# Single WebSocket
node app.js --transport websocket --server ws://localhost:8080

# Multiple WebSocket servers
node app.js --servers ws://localhost:8080,ws://localhost:8081

# Multi-transport (WebSocket + WebTorrent)
node app.js --transport multi --server ws://localhost:8080 --room my-room
```

## Available Transports

### Built-in Transports

The following transports are included with P2PMesh:

#### WebSocket Transport (`websocket`)

WebSocket-based signaling for WebRTC connections.

```javascript
const mesh = await createMesh({
  transportName: 'websocket',
  transportOptions: {
    signalingServerUrl: 'ws://localhost:8080'
  }
});
```

**Options:**
- `signalingServerUrl` (required): WebSocket server URL

#### AWS WebSocket Transport (`aws-websocket` or `aws`)

AWS API Gateway WebSocket transport with specific optimizations for AWS deployment.

```javascript
const mesh = await createMesh({
  transportName: 'aws-websocket',
  transportOptions: {
    url: 'wss://your-api-id.execute-api.us-east-1.amazonaws.com/prod',
    stage: 'prod',
    region: 'us-east-1'
  }
});
```

**Options:**
- `url` (required): AWS API Gateway WebSocket URL
- `stage`: Deployment stage (default: 'prod')
- `region`: AWS region (default: 'us-east-1')

#### WebTorrent Transport (`webtorrent`)

WebTorrent-based peer discovery and signaling.

```javascript
const mesh = await createMesh({
  transportName: 'webtorrent',
  transportOptions: {
    infoHash: 'your-room-info-hash'
  }
});
```

**Options:**
- `infoHash` (required): WebTorrent swarm info hash

## Registering Custom Transports

You can register your own custom transport implementations:

```javascript
import transportRegistry from '../src/transports/transport-registry.js';
import { MyCustomTransport } from './my-custom-transport.js';

// Register your transport with a name
transportRegistry.register('my-custom-transport', MyCustomTransport);

// Then use it by name
const mesh = await createMesh({
  transportName: 'my-custom-transport',
  transportOptions: {
    // Your transport-specific options
  }
});
```

### Creating Custom Transports

Custom transports must extend the `InitiateTransport` class:

```javascript
import { InitiateTransport } from '../transports/transport-interface.js';

export class MyCustomTransport extends InitiateTransport {
  constructor(options = {}) {
    super(options);
    this.options = options;
    // Initialize your transport
  }

  async connect(localPeerId, options = {}) {
    // Implement connection logic
  }

  async disconnect() {
    // Implement disconnection logic
  }

  send(toPeerId, message) {
    // Implement message sending
  }

  getPeerAddress(peerId) {
    // Return peer address
    return peerId;
  }
}
```

## Transport Registry API

### Listing Available Transports

```javascript
import transportRegistry from '../src/transports/transport-registry.js';
console.log('Available transports:', transportRegistry.getNames());
```

### Checking Transport Availability

```javascript
if (transportRegistry.has('websocket')) {
  console.log('WebSocket transport is available');
}
```

### Getting Transport Class

```javascript
const TransportClass = transportRegistry.get('websocket');
const transport = new TransportClass(options);
```

### Creating Transport Instances

```javascript
// Create with options object
const transport = transportRegistry.createFromOptions('websocket', {
  signalingServerUrl: 'ws://localhost:8080'
});

// Create with constructor arguments
const transport = transportRegistry.create('websocket', 'ws://localhost:8080');
```

## Implementation Details

The named transport system is implemented through the `transport-registry.js` module, which maintains a registry of transport implementations. The `createMesh` function in `index.js` has been updated to support both direct transport instances and named transports.

### Registry Structure

The transport registry maps string names to transport classes and handles instantiation with appropriate options. This allows for:

- Dynamic transport loading
- Configuration-driven transport selection
- Plugin-style transport extensions
- Simplified testing with mock transports

### Backward Compatibility

The system maintains full backward compatibility with existing code that uses direct transport instances. You can mix and match approaches within the same application.
