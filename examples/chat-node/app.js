// examples/chat-node/app.js
import { createMesh } from '../../src/index.js';
import { WebSocketTransport } from '../../src/transports/websocket-transport.js';
import WebSocket from 'ws'; // Import 'ws' for Node.js WebSocket client

// Polyfill WebSocket for Node.js environment if not globally available for the library
// This is often needed if the library expects a browser-like WebSocket global.
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WebSocket;
}

const signalingServerUrl = 'ws://localhost:8080';
const localPeerId = `node-${Math.random().toString(36).substring(2, 9)}`;
let mesh;

console.log(`Node.js P2PMesh Example - My Peer ID: ${localPeerId}`);

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

    mesh = createMesh({
      peerId: localPeerId,
      transport: transport,
      maxPeers: 3, // Example: limit to 3 peers for the Node.js client
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] // Public STUN server
    });

    console.log(`Mesh created with Peer ID: ${mesh.peerId}`);

    // Custom event handling for Node.js example
    mesh.on('peer:connect', (peerId) => {
      console.log(`MESH EVENT: Connected to peer: ${peerId}`);
      // Try sending a message upon connection
      setTimeout(() => {
        mesh.send(peerId, `Hello from Node.js peer ${localPeerId}!`);
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
            console.log(`Peer Instance: Successfully established connection with ${targetPeerId}.`);
            mesh.emit('peer:connect', targetPeerId); // Ensure mesh event fires
          });
          peerInstance.on('data', (d) => {
            const dataString = d.toString();
            // Only log internal messages for debugging, don't emit them to UI
            console.log(`Peer Instance: Raw data from ${targetPeerId}: ${dataString}`);
            
            // Filter out internal protocol messages (gossip_ack) from UI
            try {
              const parsedData = JSON.parse(dataString);
              
              // Only filter out specific internal protocol messages
              if (parsedData.type === 'gossip_ack') {
                console.log(`Node: Filtered out internal gossip_ack message from ${targetPeerId}`);
                return; // Don't forward acknowledgments to application layer
              }
              
              // Make sure to explicitly pass through broadcast messages
              if (parsedData.type === 'gossip' || parsedData.type === 'broadcast' || 
                 (parsedData.payload && typeof parsedData.payload === 'string')) {
                console.log(`Node: Passing through broadcast/gossip message from ${targetPeerId}`);
              }
            } catch (e) {
              // If not JSON, continue with raw data
              console.log(`Node: Non-JSON data from ${targetPeerId}, passing through`);
            }
            
            mesh.emit('message', { from: targetPeerId, data: dataString });
          });
          peerInstance.on('close', () => {
            console.log(`Peer Instance: Connection closed with ${targetPeerId}.`);
            mesh.emit('peer:disconnect', targetPeerId);
          });
          peerInstance.on('error', (err) => {
            console.error(`Peer Instance: Error with ${targetPeerId}:`, err.message || err);
            mesh.emit('peer:disconnect', targetPeerId); // Treat error as disconnect for simplicity
          });
          peerInstance._nodeListenersAttached = true;
        }
      }
    };

    await mesh.join();
    console.log('Mesh joined. Waiting for peers or messages...');

    // Example: Periodically try to send a broadcast message if peers are connected
    setInterval(() => {
      if (mesh && mesh.peers.size > 0) {
        const message = `Node.js broadcast message at ${new Date().toLocaleTimeString()}`;
        console.log(`Sending broadcast: "${message}"`);
        mesh.sendBroadcast('node_chat', message);
      }
    }, 15000); // Broadcast every 15 seconds

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
  process.exit(0);
});