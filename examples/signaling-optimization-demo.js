// examples/signaling-optimization-demo.js

import { P2PMesh } from '../src/p2p-mesh.js';
import { WebSocketTransport } from '../src/transports/websocket-transport.js';

/**
 * Demo showing signaling optimization in action
 * 
 * This demo creates multiple peers and shows how signaling is optimized:
 * 1. New peers use signaling server initially
 * 2. Once connected, subsequent signaling uses the mesh
 * 3. Signals are batched when appropriate
 * 4. Statistics show the optimization in action
 */

const SIGNALING_SERVER_URL = 'ws://localhost:8080';
const NUM_PEERS = 4;
const peers = [];

async function createPeer(peerId) {
  const transport = new WebSocketTransport(SIGNALING_SERVER_URL);
  const mesh = new P2PMesh({
    peerId: peerId,
    transport: transport,
    maxPeers: 3,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  await mesh.init();

  // Set up event handlers
  mesh.on('peer:connect', (connectedPeerId) => {
    console.log(`[${peerId}] Connected to peer: ${connectedPeerId}`);
    
    // Show signaling optimizer stats
    const stats = mesh.peerManager.signalingOptimizer.getStats();
    console.log(`[${peerId}] Signaling stats:`, stats);
  });

  mesh.on('peer:disconnect', (disconnectedPeerId) => {
    console.log(`[${peerId}] Disconnected from peer: ${disconnectedPeerId}`);
  });

  mesh.on('message', ({ from, data }) => {
    console.log(`[${peerId}] Received message from ${from}:`, data);
  });

  return mesh;
}

async function demonstrateSignalingOptimization() {
  console.log('=== Signaling Optimization Demo ===\n');
  
  console.log('Creating peers...');
  
  // Create peers sequentially to show the optimization in action
  for (let i = 0; i < NUM_PEERS; i++) {
    const peerId = `peer-${i + 1}`;
    console.log(`\nCreating ${peerId}...`);
    
    const peer = await createPeer(peerId);
    peers.push(peer);
    
    // Join the mesh
    await peer.join();
    
    // Wait a bit for connections to establish
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Show current signaling stats for this peer
    const stats = peer.peerManager.signalingOptimizer.getStats();
    console.log(`[${peerId}] Current signaling stats:`, stats);
  }
  
  console.log('\n=== All peers created and connected ===\n');
  
  // Wait for all connections to stabilize
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Show final stats for all peers
  console.log('=== Final Signaling Statistics ===');
  peers.forEach((peer, index) => {
    const stats = peer.peerManager.signalingOptimizer.getStats();
    console.log(`[peer-${index + 1}] Final stats:`, stats);
  });
  
  // Demonstrate message sending (which may trigger additional signaling)
  console.log('\n=== Testing Message Broadcasting ===');
  
  // Send some broadcast messages to trigger potential signaling
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i];
    const peerId = `peer-${i + 1}`;
    
    console.log(`[${peerId}] Broadcasting test message...`);
    peer.sendBroadcast('test', { 
      message: `Hello from ${peerId}`, 
      timestamp: Date.now() 
    });
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Wait for messages to propagate
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Show updated stats after messaging
  console.log('\n=== Post-Messaging Signaling Statistics ===');
  peers.forEach((peer, index) => {
    const stats = peer.peerManager.signalingOptimizer.getStats();
    console.log(`[peer-${index + 1}] Post-messaging stats:`, stats);
  });
  
  // Calculate total optimization impact
  let totalMeshSignals = 0;
  let totalServerSignals = 0;
  let totalBatchedSignals = 0;
  let totalFailedMeshSignals = 0;
  
  peers.forEach(peer => {
    const stats = peer.peerManager.signalingOptimizer.getStats();
    totalMeshSignals += stats.meshSignals;
    totalServerSignals += stats.serverSignals;
    totalBatchedSignals += stats.batchedSignals;
    totalFailedMeshSignals += stats.failedMeshSignals;
  });
  
  console.log('\n=== Overall Optimization Impact ===');
  console.log(`Total mesh signals: ${totalMeshSignals}`);
  console.log(`Total server signals: ${totalServerSignals}`);
  console.log(`Total batched signals: ${totalBatchedSignals}`);
  console.log(`Total failed mesh signals: ${totalFailedMeshSignals}`);
  
  const totalSignals = totalMeshSignals + totalServerSignals;
  if (totalSignals > 0) {
    const meshPercentage = ((totalMeshSignals / totalSignals) * 100).toFixed(1);
    const serverPercentage = ((totalServerSignals / totalSignals) * 100).toFixed(1);
    
    console.log(`\nSignaling distribution:`);
    console.log(`- Mesh signaling: ${meshPercentage}%`);
    console.log(`- Server signaling: ${serverPercentage}%`);
    
    if (totalBatchedSignals > 0) {
      console.log(`- Batched signals: ${totalBatchedSignals} (reduced server load)`);
    }
    
    console.log(`\nOptimization effectiveness: ${meshPercentage}% of signals avoided signaling server`);
  }
}

async function cleanup() {
  console.log('\n=== Cleaning up ===');
  
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i];
    const peerId = `peer-${i + 1}`;
    
    console.log(`Disconnecting ${peerId}...`);
    await peer.leave();
  }
  
  console.log('All peers disconnected.');
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, cleaning up...');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, cleaning up...');
  await cleanup();
  process.exit(0);
});

// Run the demo
async function main() {
  try {
    await demonstrateSignalingOptimization();
    
    // Keep running for a bit to observe the system
    console.log('\nDemo running... Press Ctrl+C to exit.');
    
    // Keep the process alive
    setInterval(() => {
      // Show live stats every 10 seconds
      console.log('\n=== Live Stats Update ===');
      peers.forEach((peer, index) => {
        const stats = peer.peerManager.signalingOptimizer.getStats();
        console.log(`[peer-${index + 1}] Live stats:`, stats);
      });
    }, 10000);
    
  } catch (error) {
    console.error('Demo error:', error);
    await cleanup();
    process.exit(1);
  }
}

// Check if signaling server is running
console.log(`Make sure the signaling server is running on ${SIGNALING_SERVER_URL}`);
console.log('You can start it with: node src/servers/signaling-server.js\n');

main().catch(console.error);
