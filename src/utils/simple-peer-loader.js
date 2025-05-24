// src/utils/simple-peer-loader.js
// Function to load SimplePeer dynamically with WebRTC implementation for Node.js

let Peer;

/**
 * Loads SimplePeer dynamically based on the environment (browser or Node.js)
 * @returns {Promise<Function>} SimplePeer constructor
 */
export async function loadSimplePeer() {
  if (Peer) {
    return Peer; // Return cached instance if already loaded
  }

  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    // Browser environment
    if (window.SimplePeer) {
      Peer = window.SimplePeer;
      return Peer;
    }
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/simple-peer@9.11.1/simplepeer.min.js';
        script.onload = () => {
          Peer = window.SimplePeer;
          console.log('SimplePeer loaded from CDN');
          resolve();
        };
        script.onerror = (err) => {
          console.error('Failed to load SimplePeer from CDN:', err);
          reject(err);
        };
        document.head.appendChild(script);
      });
    } catch (error) {
      console.error('Error loading SimplePeer dynamically:', error);
      // Fallback or error handling if CDN fails
      // For now, we'll try a dynamic import as a last resort for module bundlers
      try {
        const SimplePeerModule = await import('simple-peer');
        Peer = SimplePeerModule.default || SimplePeerModule;
      } catch (e) {
        console.error('Failed to load simple-peer module as fallback:', e);
        throw new Error('SimplePeer could not be loaded.');
      }
    }
  } else {
    // Node.js environment
    try {
      // Try to load the WebRTC implementation for Node.js
      const wrtc = await import('@koush/wrtc').catch(e => {
        console.warn('Optional @koush/wrtc package not available, SimplePeer will use defaults:', e.message);
        return null;
      });
      
      // Load simple-peer with wrtc implementation if available
      const SimplePeerModule = await import('simple-peer');
      Peer = SimplePeerModule.default || SimplePeerModule; // Handles both CJS and ESM exports
      
      // Inject wrtc implementation if loaded successfully
      if (wrtc && wrtc.default) {
        console.log('Using @koush/wrtc for WebRTC in Node.js environment');
        // Create a modified SimplePeer constructor that includes wrtc by default
        const OriginalPeer = Peer;
        Peer = function(opts) {
          return new OriginalPeer({
            ...opts,
            wrtc: wrtc.default
          });
        };
        // Copy over static properties and methods
        Object.assign(Peer, OriginalPeer);
      }
    } catch (e) {
      console.error('Failed to load simple-peer in Node.js environment:', e);
      throw new Error('SimplePeer could not be loaded in Node.js environment.');
    }
  }
  if (!Peer) {
    throw new Error('SimplePeer failed to load.');
  }
  return Peer;
}

/**
 * Gets the cached SimplePeer instance if available
 * @returns {Function|null} SimplePeer constructor or null if not loaded
 */
export function getSimplePeer() {
  return Peer;
}
