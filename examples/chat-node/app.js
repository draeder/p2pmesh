// examples/chat-node/app.js
import { createMesh } from '../../src/index.js';
import { WebSocketTransport } from '../../src/transports/websocket-transport.js';
// Removed WebSocket import - WebSocketTransport handles platform detection
// Removed crypto import as we'll let the library handle ID generation

const signalingServerUrl = 'ws://localhost:8080';
// Remove manual peer ID generation - let the library handle it
let mesh;

console.log(`Node.js P2PMesh Example - Starting...`);

async function main() {
  try {
    console.log(`Connecting to signaling server ${signalingServerUrl}...`);
    const transport = new WebSocketTransport(signalingServerUrl);

    transport.on('open', () => {
      console.log('Transport: Connected to signaling server. Joining mesh...');
    });

    transport.on('close', () => {
      console.log('Transport: Disconnected from signaling server.');
    });

    transport.on('error', (err) => {
      console.error('Transport Error:', err.message || err);
    });

    // Properly await the createMesh function to ensure it's fully initialized
    mesh = await createMesh({
      // Removed peerId parameter to let the library handle ID generation
      transport: transport,
      maxPeers: 3, // Example: limit to 3 peers for the Node.js client
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] // Public STUN server
    });
    
    // Override internal mesh protocol logging functions to suppress verbose output
    // This monkey-patches the mesh object to clean up console output for end users
    const originalConsoleLog = console.log;
    console.log = function() {
      // Filter out internal gossip protocol messages unless DEBUG mode is enabled
      const message = arguments[0];
      if (typeof message === 'string' && 
          (message.includes('Gossip:') || 
           message.includes('Broadcasting message on topic') ||
           message.includes('tracking delivery'))) {
        // Only show these messages if DEBUG is enabled
        if (process.env.DEBUG) {
          originalConsoleLog.apply(console, arguments);
        }
      } else {
        // Pass through all other messages normally
        originalConsoleLog.apply(console, arguments);
      }
    };
    
    // Store original function to restore on exit
    process.originalConsoleLog = originalConsoleLog;

    console.log(`Mesh created with Peer ID: ${mesh.peerId}`);

    // Custom event handling for Node.js example
    mesh.on('peer:connect', (peerId) => {
      console.log(`MESH EVENT: Connected to peer: ${peerId}`);
      // Try sending a message upon connection
      setTimeout(() => {
        // Format consistent with browser example, using a structured message
        mesh.send(peerId, JSON.stringify({
          type: 'direct',
          payload: `Hello from Node.js peer ${mesh.peerId}!`
        }));
      }, 1000);
    });

    mesh.on('peer:disconnect', (peerId) => {
      console.log(`MESH EVENT: Disconnected from peer: ${peerId}`);
    });

    mesh.on('message', ({ from, data }) => {
      let parsedData = data;
      try {
        const messagePayload = JSON.parse(data);
        if (messagePayload.type === 'direct' || messagePayload.type === 'broadcast') {
          parsedData = messagePayload.payload;
        }
      } catch (e) {
        // If not JSON, use as is
      }
      
      // If parsedData is an object, convert it to a readable string
      if (typeof parsedData === 'object' && parsedData !== null) {
        parsedData = JSON.stringify(parsedData, null, 2);
      }
      console.log(`MESH EVENT: Message from ${from}: ${parsedData}`);
    });
    
    // Enhancing peer event logging for Node.js (similar to browser example but simpler)
    const originalConnectToPeer = mesh._connectToPeer;
    mesh._connectToPeer = (targetPeerId) => {
      originalConnectToPeer(targetPeerId);
      if (mesh.peers.has(targetPeerId)) {
        const peerInstance = mesh.peers.get(targetPeerId);
        if (!peerInstance._nodeListenersAttached) {
          peerInstance.on('connect', () => {
            console.log(`Peer: Connected to peer: ${targetPeerId}`);
            mesh.emit('peer:connect', targetPeerId); // Ensure mesh event fires
          });
          peerInstance.on('data', (d) => {
            const dataString = d.toString();
            // Handle data without excessive logging
            // Only log for debugging if needed
            if (process.env.DEBUG) {
              console.log(`Peer Instance: Raw data from ${targetPeerId}: ${dataString}`);
            }
            
            // Filter out internal protocol messages from UI
            try {
              const parsedData = JSON.parse(dataString);
              
              // Filter out all internal protocol messages
              if (parsedData.type === 'gossip_ack') {
                if (process.env.DEBUG) {
                  console.log(`Filtered internal gossip_ack message from ${targetPeerId}`);
                }
                return; // Don't forward acknowledgments to application layer
              }
              
              // Filter gossip protocol messages except actual chat messages
              if (parsedData.type === 'gossip') {
                if (process.env.DEBUG) {
                  console.log(`Processing gossip message on topic: ${parsedData.topic}`);
                }
                
                if (parsedData.topic !== 'chat_message') {
                  return; // Filter out non-chat gossip messages
                }
              }
              
              // Process broadcast messages without logging delivery details
              if ((parsedData.type === 'broadcast' && parsedData.topic === 'chat_message') ||
                  parsedData.type === 'direct') {
                // Only pass through chat-related messages
              }
            } catch (e) {
              // If not JSON, continue with raw data but only log in debug mode
              if (process.env.DEBUG) {
                console.log(`Node: Non-JSON data from ${targetPeerId}, passing through`);
              }
            }
            
            mesh.emit('message', { from: targetPeerId, data: dataString });
          });
          peerInstance.on('close', () => {
            console.log(`Peer: Connection closed with ${targetPeerId}`);
            mesh.emit('peer:disconnect', targetPeerId);
          });
          peerInstance.on('error', (err) => {
            console.error(`Peer: Error with ${targetPeerId}: ${err.message || err}`);
            mesh.emit('peer:disconnect', targetPeerId); // Treat error as disconnect for simplicity
          });
          peerInstance._nodeListenersAttached = true;
        }
      }
    };

    await mesh.join();
    console.log('Mesh joined. Waiting for peers or messages...');
    
    // Subscribe to the same 'chat_message' topic as browser clients to ensure consistency
    mesh.subscribe('chat_message', (message) => {
      // Properly handle message object to display actual content instead of [object Object]
      const messageContent = typeof message === 'object' ? JSON.stringify(message) : message;
      console.log(`MESH EVENT: Received broadcast chat message: ${messageContent}`);
    });
    
    // Removed periodic broadcasting as it's redundant with the gossip protocol
    // The gossip protocol already handles message propagation through the network
    // If you want to test broadcasting, you can manually trigger it or implement a command-based approach instead

  } catch (error) {
    console.error('Failed to initialize P2PMesh in Node.js:', error);
  }
}

main();

process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  if (mesh) {
    await mesh.leave();
    console.log('Mesh left.');
  }
  // Restore original console.log function before exit
  if (process.originalConsoleLog) {
    console.log = process.originalConsoleLog;
    console.log('Logging restored.');
  }
  process.exit(0);
});