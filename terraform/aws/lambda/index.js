const { ApiGatewayManagementApi } = require('@aws-sdk/client-apigatewaymanagementapi');

// Store for connection management (in production, use DynamoDB)
const connections = new Map();
const peers = new Map();
const K_BOOTSTRAP_COUNT = 5;

// XOR distance calculator
function calculateXorDistance(id1, id2) {
  try {
    const bigInt1 = BigInt('0x' + id1);
    const bigInt2 = BigInt('0x' + id2);
    return bigInt1 ^ bigInt2;
  } catch (e) {
    return Math.abs(id1.localeCompare(id2));
  }
}

// API Gateway Management API client
let apiGatewayClient;

function initApiGatewayClient(event) {
  if (!apiGatewayClient) {
    const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
    apiGatewayClient = new ApiGatewayManagementApi({
      endpoint,
      region: process.env.AWS_REGION || process.env.REGION
    });
  }
  return apiGatewayClient;
}

async function sendToConnection(connectionId, data) {
  try {
    await apiGatewayClient.postToConnection({
      ConnectionId: connectionId,
      Data: JSON.stringify(data)
    });
    return true;
  } catch (error) {
    console.error(`Failed to send to connection ${connectionId}:`, error);
    if (error.statusCode === 410) {
      // Connection is stale, remove it
      handleDisconnect(connectionId);
    }
    return false;
  }
}

function handleDisconnect(connectionId) {
  const peerId = connections.get(connectionId);
  if (peerId) {
    connections.delete(connectionId);
    peers.delete(peerId);
    console.log(`Peer ${peerId} disconnected and removed.`);
    notifyPeerLeft(peerId);
  }
}

async function notifyPeerLeft(leftPeerId) {
  const notifications = [];
  for (const [connectionId, peerId] of connections) {
    if (peerId !== leftPeerId) {
      notifications.push(sendToConnection(connectionId, { 
        type: 'peer_left', 
        peerId: leftPeerId 
      }));
    }
  }
  await Promise.allSettled(notifications);
}

async function handleMessage(event, connectionId, message) {
  let parsedMessage;
  try {
    parsedMessage = JSON.parse(message);
    console.log('Received message:', parsedMessage);
  } catch (e) {
    console.error('Failed to parse message:', e);
    await sendToConnection(connectionId, { 
      type: 'error', 
      message: 'Invalid JSON message format.' 
    });
    return;
  }

  const currentPeerId = connections.get(connectionId);

  switch (parsedMessage.type) {
    case 'join':
      if (parsedMessage.peerId) {
        // Handle existing peer ID
        if (peers.has(parsedMessage.peerId)) {
          const oldConnectionId = [...connections.entries()]
            .find(([_, peerId]) => peerId === parsedMessage.peerId)?.[0];
          if (oldConnectionId && oldConnectionId !== connectionId) {
            await sendToConnection(oldConnectionId, { 
              type: 'error', 
              message: 'Another client joined with your ID.' 
            });
            handleDisconnect(oldConnectionId);
          }
        }

        connections.set(connectionId, parsedMessage.peerId);
        peers.set(parsedMessage.peerId, connectionId);
        console.log(`Peer ${parsedMessage.peerId} joined. Total peers: ${peers.size}`);

        // Send bootstrap peers
        const otherPeers = [];
        for (const [peerId, connId] of peers) {
          if (peerId !== parsedMessage.peerId) {
            otherPeers.push({ id: peerId, connectionId: connId });
          }
        }

        if (otherPeers.length > 0) {
          try {
            otherPeers.sort((a, b) => {
              const distA = calculateXorDistance(parsedMessage.peerId, a.id);
              const distB = calculateXorDistance(parsedMessage.peerId, b.id);
              return distA < distB ? -1 : (distA > distB ? 1 : 0);
            });
            
            const closestPeersInfo = otherPeers
              .slice(0, K_BOOTSTRAP_COUNT)
              .map(p => ({ id: p.id }));

            if (closestPeersInfo.length > 0) {
              await sendToConnection(connectionId, { 
                type: 'bootstrap_peers', 
                peers: closestPeersInfo 
              });
              console.log(`Sent ${closestPeersInfo.length} bootstrap peers`);
            }
          } catch (e) {
            console.error('Error calculating bootstrap peers:', e);
          }
        }

        // Notify other peers
        const notifications = [];
        for (const [peerId, connId] of peers) {
          if (peerId !== parsedMessage.peerId) {
            notifications.push(sendToConnection(connId, { 
              type: 'peer_joined', 
              peerId: parsedMessage.peerId 
            }));
          }
        }
        await Promise.allSettled(notifications);
      }
      break;

    case 'batched_signals':
    case 'signal':
    case 'offer':
    case 'answer':
    case 'candidate':
    case 'ack':
    case 'connection_rejected':
    case 'signal_rejected':
    case 'kademlia_rpc_request':
    case 'kademlia_rpc_response':
      if (parsedMessage.to && peers.has(parsedMessage.to)) {
        const recipientConnectionId = peers.get(parsedMessage.to);
        const messageToSend = { ...parsedMessage, from: currentPeerId };
        const success = await sendToConnection(recipientConnectionId, messageToSend);
        if (success) {
          console.log(`Relayed ${parsedMessage.type} from ${currentPeerId} to ${parsedMessage.to}`);
        }
      } else if (parsedMessage.to) {
        await sendToConnection(connectionId, { 
          type: 'error', 
          message: `Peer ${parsedMessage.to} not found.` 
        });
      }
      break;

    case 'leave':
      if (currentPeerId) {
        console.log(`Peer ${currentPeerId} explicitly leaving.`);
        handleDisconnect(connectionId);
      }
      break;

    default:
      console.log('Unknown message type:', parsedMessage.type);
      await sendToConnection(connectionId, { 
        type: 'error', 
        message: `Unknown message type: ${parsedMessage.type}` 
      });
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { requestContext } = event;
  const { connectionId, routeKey } = requestContext;
  
  // Initialize API Gateway client
  apiGatewayClient = initApiGatewayClient(event);

  try {
    switch (routeKey) {
      case '$connect':
        console.log(`Client ${connectionId} connected`);
        // WebSocket connections don't use traditional CORS headers
        // Origin validation would be handled here if needed
        const origin = event.headers?.Origin || event.headers?.origin;
        console.log(`Connection from origin: ${origin}`);
        return { statusCode: 200 };

      case '$disconnect':
        console.log(`Client ${connectionId} disconnected`);
        handleDisconnect(connectionId);
        return { statusCode: 200 };

      case '$default':
        if (event.body) {
          await handleMessage(event, connectionId, event.body);
        }
        return { statusCode: 200 };

      default:
        console.log('Unknown route:', routeKey);
        return { statusCode: 400 };
    }
  } catch (error) {
    console.error('Handler error:', error);
    return { statusCode: 500 };
  }
};
