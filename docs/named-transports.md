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
```

### Chat Node Example

The Node.js example follows the same pattern, allowing you to choose either method.

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

## Available Transports

You can list all available transports:

```javascript
import transportRegistry from '../src/transports/transport-registry.js';
console.log('Available transports:', transportRegistry.getNames());
```

Currently, the following transports are available:

- `websocket`: WebSocket-based signaling for WebRTC connections

## Implementation Details

The named transport system is implemented through the `transport-registry.js` module, which maintains a registry of transport implementations. The `createMesh` function in `index.js` has been updated to support both direct transport instances and named transports.