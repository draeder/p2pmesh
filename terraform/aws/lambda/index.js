const { ApiGatewayManagementApi } = require('@aws-sdk/client-apigatewaymanagementapi');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const K_BOOTSTRAP_COUNT = 5;
const TTL_SECONDS = 300; // 5 minutes TTL for connections

// DynamoDB client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || process.env.REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;

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

async function storePeerConnection(connectionId, peerId) {
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  
  try {
    await docClient.send(new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        peerId,
        ttl,
        lastSeen: Date.now()
      }
    }));
    console.log(`Stored peer ${peerId} with connection ${connectionId}`);
  } catch (error) {
    console.error('Error storing peer connection:', error);
    throw error;
  }
}

async function removePeerConnection(connectionId) {
  try {
    // First get the peer info
    const result = await docClient.send(new GetCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId }
    }));
    
    if (result.Item) {
      await docClient.send(new DeleteCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId }
      }));
      console.log(`Removed peer ${result.Item.peerId} with connection ${connectionId}`);
      return result.Item.peerId;
    }
  } catch (error) {
    console.error('Error removing peer connection:', error);
  }
  return null;
}

async function getAllActivePeers() {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: CONNECTIONS_TABLE,
      FilterExpression: '#ttl > :now',
      ExpressionAttributeNames: {
        '#ttl': 'ttl'
      },
      ExpressionAttributeValues: {
        ':now': Math.floor(Date.now() / 1000)
      }
    }));
    
    return result.Items || [];
  } catch (error) {
    console.error('Error getting active peers:', error);
    return [];
  }
}

async function getPeerByConnectionId(connectionId) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId }
    }));
    return result.Item?.peerId || null;
  } catch (error) {
    console.error('Error getting peer by connection:', error);
    return null;
  }
}

async function handleDisconnect(connectionId) {
  const peerId = await removePeerConnection(connectionId);
  if (peerId) {
    console.log(`Peer ${peerId} disconnected and removed.`);
    await notifyPeerLeft(peerId);
  }
}

async function notifyPeerLeft(leftPeerId) {
  const activePeers = await getAllActivePeers();
  const notifications = [];
  
  for (const peer of activePeers) {
    if (peer.peerId !== leftPeerId) {
      notifications.push(sendToConnection(peer.connectionId, { 
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

  const currentPeerId = await getPeerByConnectionId(connectionId);

  switch (parsedMessage.type) {
    case 'join':
      if (parsedMessage.peerId) {
        const currentPeerId = await getPeerByConnectionId(connectionId);
        const activePeers = await getAllActivePeers();
        
        // Check if peer ID is already in use
        const existingPeer = activePeers.find(p => p.peerId === parsedMessage.peerId);
        if (existingPeer && existingPeer.connectionId !== connectionId) {
          await sendToConnection(existingPeer.connectionId, { 
            type: 'error', 
            message: 'Another client joined with your ID.' 
          });
          await removePeerConnection(existingPeer.connectionId);
        }

        // Store the new connection
        await storePeerConnection(connectionId, parsedMessage.peerId);
        console.log(`Peer ${parsedMessage.peerId} joined. Total active peers: ${activePeers.length + 1}`);

        // Send bootstrap peers (exclude self)
        const otherPeers = activePeers.filter(p => p.peerId !== parsedMessage.peerId);

        if (otherPeers.length > 0) {
          try {
            otherPeers.sort((a, b) => {
              const distA = calculateXorDistance(parsedMessage.peerId, a.peerId);
              const distB = calculateXorDistance(parsedMessage.peerId, b.peerId);
              return distA < distB ? -1 : (distA > distB ? 1 : 0);
            });
            
            const closestPeersInfo = otherPeers
              .slice(0, K_BOOTSTRAP_COUNT)
              .map(p => ({ 
                id: p.peerId,
                lastSeen: p.lastSeen 
              }));

            if (closestPeersInfo.length > 0) {
              await sendToConnection(connectionId, { 
                type: 'bootstrap_peers', 
                peers: closestPeersInfo 
              });
              console.log(`Sent ${closestPeersInfo.length} bootstrap peers to ${parsedMessage.peerId}`);
            }
          } catch (e) {
            console.error('Error calculating bootstrap peers:', e);
          }
        }

        // Notify other peers
        const notifications = [];
        for (const peer of otherPeers) {
          notifications.push(sendToConnection(peer.connectionId, { 
            type: 'peer_joined', 
            peerId: parsedMessage.peerId 
          }));
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
      const activePeers = await getAllActivePeers();
      const targetPeer = activePeers.find(p => p.peerId === parsedMessage.to);
      
      if (targetPeer) {
        const currentPeerId = await getPeerByConnectionId(connectionId);
        const messageToSend = { ...parsedMessage, from: currentPeerId };
        const success = await sendToConnection(targetPeer.connectionId, messageToSend);
        if (!success) {
          // Peer connection failed, send error back to sender
          await sendToConnection(connectionId, {
            type: 'error',
            message: `Peer ${parsedMessage.to} not found.`
          });
        }
      } else {
        // Target peer not found
        await sendToConnection(connectionId, {
          type: 'error',
          message: `Peer ${parsedMessage.to} not found.`
        });
      }
      break;

    default:
      console.log(`Unknown message type: ${parsedMessage.type}`);
      await sendToConnection(connectionId, {
        type: 'error',
        message: `Unknown message type: ${parsedMessage.type}`
      });
      break;
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const connectionId = event.requestContext.connectionId;
  const routeKey = event.requestContext.routeKey;
  
  // Initialize API Gateway client
  initApiGatewayClient(event);
  
  try {
    switch (routeKey) {
      case '$connect':
        console.log(`Connection established: ${connectionId}`);
        return { statusCode: 200 };
        
      case '$disconnect':
        await handleDisconnect(connectionId);
        return { statusCode: 200 };
        
      case '$default':
        if (event.body) {
          await handleMessage(event, connectionId, event.body);
        }
        return { statusCode: 200 };
        
      default:
        console.log(`Unknown route: ${routeKey}`);
        return { statusCode: 400 };
    }
  } catch (error) {
    console.error('Handler error:', error);
    return { statusCode: 500 };
  }
};
