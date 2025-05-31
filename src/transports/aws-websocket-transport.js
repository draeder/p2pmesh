import { WebSocketTransport } from './websocket-transport.js';

/**
 * AWS WebSocket Transport for P2P Mesh networking
 * Extends the base WebSocket transport with AWS-specific configurations
 */
export class AWSWebSocketTransport extends WebSocketTransport {
  constructor(url, options = {}) {
    // AWS API Gateway WebSocket URLs don't need '/websocket' suffix
    const cleanUrl = url.replace(/\/websocket$/, '');
    
    super(cleanUrl, {
      ...options,
      // AWS-specific configurations
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      // AWS API Gateway has specific timeout handling
      heartbeatInterval: 30000, // Send ping every 30 seconds
      ...options
    });
    
    this.isAWS = true;
    this.stage = options.stage || 'prod';
    this.region = options.region || 'us-east-1';
  }

  /**
   * Override connect method to handle AWS-specific connection logic
   */
  async connect() {
    try {
      console.log(`Connecting to AWS WebSocket: ${this.url}`);
      await super.connect();
      
      // AWS-specific connection handling
      this.setupAWSHeartbeat();
      
    } catch (error) {
      console.error('AWS WebSocket connection failed:', error);
      throw error;
    }
  }

  /**
   * Setup AWS-specific heartbeat to prevent connection timeout
   */
  setupAWSHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send a ping message to keep connection alive
        this.send({
          type: 'ping',
          timestamp: Date.now()
        });
      }
    }, this.options.heartbeatInterval);
  }

  /**
   * Override message handling for AWS-specific responses
   */
  handleMessage(data) {
    const message = JSON.parse(data);
    
    // Handle AWS-specific messages
    if (message.type === 'ping') {
      // Respond to ping with pong
      this.send({
        type: 'pong',
        timestamp: Date.now()
      });
      return;
    }

    if (message.type === 'pong') {
      // Handle pong response
      console.log('Received pong from AWS WebSocket');
      return;
    }

    // Pass other messages to parent handler
    super.handleMessage(data);
  }

  /**
   * Override cleanup to clear AWS-specific timers
   */
  cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    super.cleanup();
  }

  /**
   * Get AWS-specific connection info
   */
  getConnectionInfo() {
    return {
      ...super.getConnectionInfo(),
      provider: 'aws',
      stage: this.stage,
      region: this.region,
      isAWS: true
    };
  }
}

// Register with transport factory
export function registerAWSTransport(transportFactory) {
  transportFactory.register('aws-websocket', (url, options) => {
    return new AWSWebSocketTransport(url, options);
  });
  
  transportFactory.register('aws', (url, options) => {
    return new AWSWebSocketTransport(url, options);
  });
}
