// src/servers/websocket-server.js
import { WebSocketServer } from 'ws';
// Import Kademlia utilities from the parent directory
import { calculateDistance, K as KADEMLIA_K } from '../kademlia.js';

const wss = new WebSocketServer({ port: 8080 });

// Store connected peers: Map<peerId, WebSocket connection>
const peers = new Map();
const K_BOOTSTRAP_COUNT = 5; // Number of closest peers to send for bootstrapping

console.log('Signaling server started on ws://localhost:8080');

wss.on('connection', (ws) => {
  let currentPeerId = null;
  console.log('Client connected');

  ws.on('message', (message) => {
    let parsedMessage;
    try {
      parsedMessage = JSON.parse(message);
      console.log('Received message:', parsedMessage);
    } catch (e) {
      console.error('Failed to parse message or message is not JSON:', message, e);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message format.' }));
      return;
    }

    switch (parsedMessage.type) {
      case 'join':
        if (parsedMessage.peerId) {
          currentPeerId = parsedMessage.peerId;
          if (peers.has(currentPeerId)) {
            console.warn(`Peer ID ${currentPeerId} already exists. Overwriting.`);
            const oldWs = peers.get(currentPeerId);
            if (oldWs && oldWs !== ws) {
                oldWs.send(JSON.stringify({ type: 'error', message: 'Another client joined with your ID.'}));
                oldWs.close();
            }
          }
          peers.set(currentPeerId, ws);
          console.log(`Peer ${currentPeerId} joined. Total peers: ${peers.size}`);

          // Send a list of k-closest peers for bootstrapping
          const otherPeers = [];
          peers.forEach((peerWs, peerId) => {
            if (peerId !== currentPeerId) {
              otherPeers.push({ id: peerId, ws: peerWs });
            }
          });

          if (otherPeers.length > 0) {
            try {
              otherPeers.sort((a, b) => {
                const distA = calculateDistance(currentPeerId, a.id);
                const distB = calculateDistance(currentPeerId, b.id);
                return distA < distB ? -1 : (distA > distB ? 1 : 0);
              });
              
              const closestPeersInfo = otherPeers
                .slice(0, K_BOOTSTRAP_COUNT)
                .map(p => ({ id: p.id })); // Only send IDs, client will resolve address/connection

              if (closestPeersInfo.length > 0) {
                ws.send(JSON.stringify({ type: 'bootstrap_peers', peers: closestPeersInfo }));
                console.log(`Sent ${closestPeersInfo.length} bootstrap peers to ${currentPeerId}:`, closestPeersInfo.map(p=>p.id));
              }
            } catch (e) {
                console.error(`Error calculating or sending bootstrap peers for ${currentPeerId}:`, e);
                // Fallback: send a random subset or all if distance calculation fails (e.g. invalid ID format)
                const fallbackPeers = otherPeers.slice(0, K_BOOTSTRAP_COUNT).map(p => ({id: p.id}));
                if (fallbackPeers.length > 0) {
                    ws.send(JSON.stringify({ type: 'bootstrap_peers', peers: fallbackPeers }));
                    console.log(`Sent ${fallbackPeers.length} (fallback) bootstrap peers to ${currentPeerId}`);
                }
            }
          }

          // Notify other peers about the new peer (existing behavior)
          peers.forEach((peerWs, peerId) => {
            if (peerId !== currentPeerId) {
              try {
                peerWs.send(JSON.stringify({ type: 'peer_joined', peerId: currentPeerId }));
              } catch (err) {
                console.error(`Error sending peer_joined to ${peerId}:`, err);
              }
            }
          });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'peerId is required for join message.' }));
        }
        break;

      // Handle batched signals from SignalingOptimizer
      case 'batched_signals':
        if (parsedMessage.to && peers.has(parsedMessage.to)) {
          const recipientWs = peers.get(parsedMessage.to);
          if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
            const messageToSend = { ...parsedMessage, from: currentPeerId };
            recipientWs.send(JSON.stringify(messageToSend));
            console.log(`Relayed batched signals from ${currentPeerId} to ${parsedMessage.to} (${parsedMessage.signals ? parsedMessage.signals.length : 0} signals)`);
          } else {
            console.warn(`Recipient ${parsedMessage.to} is not open for batched signals. Removing.`);
            peers.delete(parsedMessage.to);
            notifyPeerLeft(parsedMessage.to);
          }
        } else if (parsedMessage.to) {
          console.warn(`Recipient ${parsedMessage.to} not found for batched signals.`);
          ws.send(JSON.stringify({ type: 'error', message: `Peer ${parsedMessage.to} not found for batched signals.`}));
        }
        break;

      // Relay messages to a specific peer or broadcast
      // Assumes messages have a 'to' field for direct, or are broadcast if 'to' is missing
      // Or specific types like 'signal', 'offer', 'answer', 'candidate'
      case 'signal': // Generic signal for WebRTC
      case 'offer': // Specific SDP offer
      case 'answer': // Specific SDP answer
      case 'candidate': // Specific ICE candidate
      case 'ack': // Acknowledge message for connection setup
      case 'connection_rejected': // Connection rejection message
        if (parsedMessage.to && peers.has(parsedMessage.to)) {
          const recipientWs = peers.get(parsedMessage.to);
          // Check if recipientWs is defined and its readyState is OPEN
          if (recipientWs && recipientWs.readyState === WebSocket.OPEN) { // Corrected to WebSocket.OPEN
            // Add 'from' field if not present, using currentPeerId
            const messageToSend = { ...parsedMessage, from: currentPeerId };
            recipientWs.send(JSON.stringify(messageToSend));
            console.log(`Relayed ${parsedMessage.type} message from ${currentPeerId} to ${parsedMessage.to}`);
          } else {
            console.warn(`Recipient ${parsedMessage.to} is not open. Removing.`);
            peers.delete(parsedMessage.to);
            // Notify others that this peer might have left abruptly
            notifyPeerLeft(parsedMessage.to);
          }
        } else if (parsedMessage.to) {
          console.warn(`Recipient ${parsedMessage.to} not found.`);
          ws.send(JSON.stringify({ type: 'error', message: `Peer ${parsedMessage.to} not found.`}));
        } else {
          // Handle as broadcast or error if 'to' is expected
          console.warn(`Message type ${parsedMessage.type} without 'to' field. Ignoring or define broadcast logic.`);
        }
        break;

      case 'leave':
        if (currentPeerId) {
          console.log(`Peer ${currentPeerId} explicitly leaving.`);
          handleDisconnect(currentPeerId);
          currentPeerId = null; // Prevent further operations for this ws after leave
          ws.close();
        }
        break;

      case 'kademlia_rpc_request':
      case 'kademlia_rpc_response':
        if (parsedMessage.to && peers.has(parsedMessage.to)) {
          const recipientWs = peers.get(parsedMessage.to);
          if (recipientWs && recipientWs.readyState === WebSocket.OPEN) { // Ensure ws is imported or use WebSocket.OPEN
            // Add 'from' field if not present, using currentPeerId (already done by client transport)
            // const messageToSend = { ...parsedMessage, from: currentPeerId };
            recipientWs.send(JSON.stringify(parsedMessage)); // Relay the original message
            console.log(`Relayed ${parsedMessage.type} from ${parsedMessage.from || currentPeerId} to ${parsedMessage.to}`);
          } else {
            console.warn(`Recipient ${parsedMessage.to} for ${parsedMessage.type} is not open or not found. Removing if exists.`);
            if (peers.has(parsedMessage.to)) {
                peers.delete(parsedMessage.to);
                notifyPeerLeft(parsedMessage.to);
            }
            // Optionally notify sender about the failure
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: `Peer ${parsedMessage.to} not available for ${parsedMessage.type}.`}));
            }
          }
        } else if (parsedMessage.to) {
          console.warn(`Recipient ${parsedMessage.to} for ${parsedMessage.type} not found.`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: `Peer ${parsedMessage.to} not found for ${parsedMessage.type}.`}));
          }
        } else {
          console.warn(`Message type ${parsedMessage.type} without 'to' field. Ignoring.`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: `'to' field is required for ${parsedMessage.type}.`}));
          }
        }
        break;

      default:
        console.log('Unknown message type:', parsedMessage.type);
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${parsedMessage.type}` }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (currentPeerId) {
      handleDisconnect(currentPeerId);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    if (currentPeerId) {
      handleDisconnect(currentPeerId);
    }
  });

  function handleDisconnect(peerIdToDisconnect) {
    if (peers.has(peerIdToDisconnect)) {
      peers.delete(peerIdToDisconnect);
      console.log(`Peer ${peerIdToDisconnect} disconnected and removed.`);
      notifyPeerLeft(peerIdToDisconnect);
    }
  }

  function notifyPeerLeft(leftPeerId) {
    // Notify remaining peers
    peers.forEach((peerWs, peerId) => {
      try {
        peerWs.send(JSON.stringify({ type: 'peer_left', peerId: leftPeerId }));
      } catch (err) {
        console.error(`Error sending peer_left to ${peerId}:`, err);
      }
    });
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down signaling server...');
  
  // Set a forced exit timeout in case connections don't close properly
  const forceExitTimeout = setTimeout(() => {
    console.log('Forcing server shutdown after timeout...');
    process.exit(0);
  }, 3000); // 3 seconds timeout
  
  // Close all open WebSocket connections
  let connectionCount = 0;
  peers.forEach((ws, peerId) => {
    if (ws.readyState === WebSocket.OPEN) {
      connectionCount++;
      try {
        ws.close();
      } catch (err) {
        console.error(`Error closing connection to ${peerId}:`, err);
      }
    }
  });
  console.log(`Closing ${connectionCount} active connections...`);
  
  // Close the WebSocket server
  wss.close(() => {
    console.log('All connections closed.');
    clearTimeout(forceExitTimeout); // Clear the timeout if we exit normally
    process.exit(0);
  });
});
