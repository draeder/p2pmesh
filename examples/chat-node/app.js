// examples/chat-node/app.js
import { createMesh } from '../../src/index.js';
import { generateDeterministicRoomId } from '../../src/utils/room-id-generator.js';
import readline from 'readline';

// Parse command line arguments
const args = process.argv.slice(2);
let transport = 'websocket';
let signalingServerUrl = 'ws://localhost:8080';
let roomName = 'default-room';

// Parse command line options
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--transport':
    case '-t':
      transport = args[++i];
      break;
    case '--server':
    case '-s':
      signalingServerUrl = args[++i];
      break;
    case '--room':
    case '-r':
      roomName = args[++i];
      break;
    case '--help':
    case '-h':
      console.log('P2PMesh Node.js Chat Example');
      console.log('');
      console.log('Options:');
      console.log('  -t, --transport <transport>  Transport type: websocket or webtorrent (default: websocket)');
      console.log('  -s, --server <url>          WebSocket signaling server URL (default: ws://localhost:8080)');
      console.log('  -r, --room <name>           Room name for WebTorrent transport (default: default-room)');
      console.log('  -h, --help                  Show this help message');
      console.log('');
      console.log('Examples:');
      console.log('  node app.js                                    # Use WebSocket transport');
      console.log('  node app.js --transport webtorrent             # Use WebTorrent transport');
      console.log('  node app.js --transport webtorrent --room test # Use WebTorrent with custom room');
      console.log('  node app.js --server ws://localhost:9090       # Use custom WebSocket server');
      process.exit(0);
  }
}

let mesh;

// Set to track disconnected peers to prevent duplicate disconnect messages
const disconnectedPeers = new Set();

console.log(`Node.js P2PMesh Example - Starting with ${transport} transport...`);
if (transport === 'webtorrent') {
  console.log(`Room: ${roomName}`);
} else {
  console.log(`Signaling Server: ${signalingServerUrl}`);
}

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'p2pmesh> '
});

async function main() {
  try {
    let meshConfig;
    
    if (transport === 'websocket') {
      console.log(`Connecting to signaling server ${signalingServerUrl} using WebSocket transport...`);
      
      meshConfig = {
        transportName: 'websocket',
        transportOptions: {
          signalingServerUrl: signalingServerUrl
        },
        maxPeers: 3,
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      };
    } else if (transport === 'webtorrent') {
      console.log(`Generating room ID for "${roomName}"...`);
      
      // Generate deterministic room ID from room name
      const roomId = await generateDeterministicRoomId(roomName);
      console.log(`Connecting to WebTorrent swarm: ${roomId.substring(0, 8)}...`);
      
      meshConfig = {
        transportName: 'webtorrent',
        transportOptions: {
          infoHash: roomId
        },
        maxPeers: 10 // WebTorrent can handle more peers
      };
    } else {
      throw new Error(`Unsupported transport: ${transport}. Use 'websocket' or 'webtorrent'.`);
    }
    
    mesh = await createMesh(meshConfig);
    
    // Note: Event handlers like 'open', 'close', and 'error' are handled internally
    // by the named transport system. The mesh object will still emit appropriate events.
    
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
      // Reset the disconnected state when a peer connects/reconnects
      disconnectedPeers.delete(peerId);
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
      // Add tracking to prevent duplicate disconnect messages
      if (!disconnectedPeers.has(peerId)) {
        disconnectedPeers.add(peerId);
        console.log(`MESH EVENT: Disconnected from peer: ${peerId}`);
      }
    });
    
    // Handler for the new peer eviction event
    mesh.on('peer:evicted', (data) => {
      console.log(`MESH EVENT: Evicted from mesh with reason: ${data.reason}`);
      console.log(`MESH EVENT: Received ${data.alternativePeers.length} alternative peers for reconnection`);
      console.log(`MESH EVENT: Will attempt peer-assisted reconnection on next join`);
    });

    mesh.on('message', ({ from, data }) => {
      let displayData = data;
      try {
        let messageObject = data;
        if (typeof data === 'string') {
          try {
            messageObject = JSON.parse(data);
          } catch {
            messageObject = data;
          }
        }

        if (messageObject && typeof messageObject.payload !== 'undefined') {
          displayData = messageObject.payload;
        } else {
          displayData = messageObject;
        }

        if (typeof displayData === 'object' && displayData !== null) {
          displayData = JSON.stringify(displayData, null, 2);
        }
      } catch (e) {
        console.error('Error processing message:', e);
        displayData = String(data);
      }
      
      console.log(`${from}: ${displayData}`);
      rl.prompt(); // Re-prompt after receiving a message
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
            rl.prompt(); // Re-prompt after connection event
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
                // We'll handle the formatting in the message event handler
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
            // Only emit the event if the peer hasn't been marked as disconnected
            if (!disconnectedPeers.has(targetPeerId)) {
              disconnectedPeers.add(targetPeerId);
              mesh.emit('peer:disconnect', targetPeerId);
            }
            rl.prompt(); // Re-prompt after disconnection event
          });
          peerInstance.on('error', (err) => {
            console.error(`Peer: Error with ${targetPeerId}: ${err.message || err}`);
            // Only emit the event if the peer hasn't been marked as disconnected
            if (!disconnectedPeers.has(targetPeerId)) {
              disconnectedPeers.add(targetPeerId);
              mesh.emit('peer:disconnect', targetPeerId); // Treat error as disconnect for simplicity
            }
            rl.prompt(); // Re-prompt after error event
          });
          peerInstance._nodeListenersAttached = true;
        }
      }
    };

    await mesh.join();
    console.log('Mesh joined. Waiting for peers or messages...');
    
    // Subscribe to the same 'chat_message' topic as browser clients to ensure consistency
    mesh.subscribe('chat_message', (message) => {
      let displayData = message;
      try {
        if (typeof message === 'object' && message !== null) {
          if (typeof message.payload !== 'undefined') {
            displayData = message.payload;
          }
          
          if (typeof displayData === 'object' && displayData !== null) {
            displayData = JSON.stringify(displayData, null, 2);
          }
        }
      } catch (e) {
        console.error('Error processing broadcast message:', e);
        displayData = String(message);
      }
      
      // Display in the same format as direct messages
      if (message.originPeerId) {
        console.log(`${message.originPeerId}: ${displayData}`);
      } else {
        console.log(`Broadcast: ${displayData}`);
      }
      rl.prompt(); // Re-prompt after broadcast message
    });
    
    // Start the readline interface
    console.log('\nAvailable commands:');
    console.log('  peers - List connected peers');
    console.log('  send <peerId> <message> - Send direct message to peer');
    console.log('  send <message> - Send broadcast message to all peers');
    console.log('  help - Show this help message');
    console.log('  exit - Exit the application\n');
    
    rl.prompt();
    
    rl.on('line', (line) => {
      const trimmedLine = line.trim();
      const args = trimmedLine.split(' ');
      const command = args[0].toLowerCase();
      
      switch (command) {
        case 'peers':
          // List connected peers
          console.log('\nConnected peers:');
          if (mesh.peers.size === 0) {
            console.log('  No peers connected.');
          } else {
            mesh.peers.forEach((peer, peerId) => {
              console.log(`  ${peerId} (${peer.connected ? 'Connected' : 'Connecting...'})`); 
            });
          }
          break;
          
        case 'send':
          if (args.length < 2) {
            console.log('Error: Missing message. Usage: send <peerId> <message> or send <message>');
          } else if (args.length === 2) {
            // Broadcast message to all peers
            const message = args[1];
            console.log(`Broadcasting message to all peers: ${message}`);
            mesh.sendBroadcast('chat_message', message);
            // Display the message locally in the same format as received messages
            console.log(`${mesh.peerId}: ${message}`);
          } else {
            // Direct message to specific peer
            const targetPeerId = args[1];
            const message = args.slice(2).join(' ');
            
            if (mesh.peers.has(targetPeerId)) {
              console.log(`Sending direct message to ${targetPeerId}: ${message}`);
              mesh.send(targetPeerId, message);
              // Display the message locally in the same format as received messages
              console.log(`${mesh.peerId} → ${targetPeerId}: ${message}`);
            } else {
              console.log(`Error: Peer ${targetPeerId} not connected.`);
            }
          }
          break;
          
        case 'help':
          console.log('\nAvailable commands:');
          console.log('  peers - List connected peers');
          console.log('  send <peerId> <message> - Send direct message to peer');
          console.log('  send <message> - Send broadcast message to all peers');
          console.log('  help - Show this help message');
          console.log('  exit - Exit the application');
          break;
          
        case 'exit':
          console.log('Exiting...');
          rl.close();
          process.emit('SIGINT');
          return;
          
        default:
          console.log(`Unknown command: ${command}. Type 'help' for available commands.`);
      }
      
      rl.prompt();
    });

  } catch (error) {
    console.error('Failed to initialize P2PMesh in Node.js:', error);
    rl.close();
  }
}

main();

process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  rl.close();
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
