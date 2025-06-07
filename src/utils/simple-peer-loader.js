// src/utils/simple-peer-loader.js
// Function to load SimplePeer and WebTorrent dynamically with WebRTC implementation for Node.js

let Peer;
let WebTorrent;

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

/**
 * Loads WebTorrent dynamically based on the environment (browser or Node.js)
 * @returns {Promise<Function>} WebTorrent constructor
 */
export async function loadWebTorrent() {
  if (WebTorrent) {
    console.log('WebTorrent: Using cached instance');
    return WebTorrent; // Return cached instance if already loaded
  }

  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    // Browser environment
    if (window.WebTorrent) {
      console.log('WebTorrent: Using global window.WebTorrent');
      WebTorrent = window.WebTorrent;
      return WebTorrent;
    }
    
    console.log('WebTorrent: Loading from CDN...');
    
    // Use working CDN URLs - avoid ESM versions that cause issues
    try {
      await new Promise((resolve, reject) => {
        const cdnUrls = [
          'https://cdn.jsdelivr.net/npm/webtorrent@1.9.7/webtorrent.min.js',
          'https://unpkg.com/webtorrent@1.9.7/webtorrent.min.js',
          'https://cdn.jsdelivr.net/npm/webtorrent@1.8.19/webtorrent.min.js',
          'https://unpkg.com/webtorrent@1.8.19/webtorrent.min.js',
          'https://cdnjs.cloudflare.com/ajax/libs/webtorrent/1.8.19/webtorrent.min.js'
        ];
        
        let currentIndex = 0;
        
        const tryNextCdn = () => {
          if (currentIndex >= cdnUrls.length) {
            reject(new Error('WebTorrent could not be loaded from any CDN. Please include WebTorrent manually or check your internet connection.'));
            return;
          }
          
          const script = document.createElement('script');
          script.src = cdnUrls[currentIndex];
          script.crossOrigin = 'anonymous';
          
          script.onload = () => {
            // Wait a bit for the global to be available
            setTimeout(() => {
              if (window.WebTorrent) {
                WebTorrent = window.WebTorrent;
                console.log(`WebTorrent loaded from CDN ${currentIndex + 1}: ${cdnUrls[currentIndex]}`);
                resolve();
              } else {
                console.warn(`WebTorrent not found in global scope after loading: ${cdnUrls[currentIndex]}`);
                currentIndex++;
                if (currentIndex < cdnUrls.length) {
                  document.head.removeChild(script);
                  setTimeout(tryNextCdn, 100);
                } else {
                  reject(new Error('WebTorrent not available in global scope from any CDN'));
                }
              }
            }, 200);
          };
          
          script.onerror = (err) => {
            console.warn(`Failed to load WebTorrent from: ${cdnUrls[currentIndex]}`, err);
            document.head.removeChild(script);
            currentIndex++;
            if (currentIndex < cdnUrls.length) {
              setTimeout(tryNextCdn, 100);
            } else {
              reject(new Error('All CDN attempts failed. Network connectivity issue or CDN unavailable.'));
            }
          };
          
          document.head.appendChild(script);
        };
        
        tryNextCdn();
      });
    } catch (error) {
      console.error('Error loading WebTorrent via script tags:', error);
      
      // Final fallback: try alternative methods with more specific error messages
      try {
        console.log('WebTorrent: Trying alternative import methods...');
        
        // Try different import approaches with proper error handling
        const importMethods = [
          async () => {
            const module = await import('https://esm.sh/webtorrent@1.9.7');
            return module.default || module;
          },
          async () => {
            const module = await import('https://cdn.skypack.dev/webtorrent@1.9.7');
            return module.default || module;
          },
          async () => {
            // Try to use a bundled version if available
            const module = await import('webtorrent');
            return module.default || module;
          }
        ];
        
        for (const importMethod of importMethods) {
          try {
            const WebTorrentModule = await importMethod();
            if (WebTorrentModule && typeof WebTorrentModule === 'function') {
              WebTorrent = WebTorrentModule;
              console.log('WebTorrent loaded via alternative import method');
              break;
            }
          } catch (e) {
            console.warn('Alternative import method failed:', e.message);
          }
        }
        
        if (!WebTorrent) {
          throw new Error('All import methods failed - WebTorrent is not available');
        }
      } catch (e) {
        console.error('Failed to load webtorrent module as fallback:', e);
        throw new Error(`WebTorrent could not be loaded via any method. Original error: ${error.message}. Fallback error: ${e.message}. Please ensure WebTorrent is available or include it manually via script tag.`);
      }
    }
  } else {
    // Node.js environment
    try {
      console.log('WebTorrent: Loading in Node.js environment...');
      const WebTorrentModule = await import('webtorrent');
      WebTorrent = WebTorrentModule.default || WebTorrentModule;
      console.log('WebTorrent loaded in Node.js');
    } catch (e) {
      console.error('Failed to load webtorrent in Node.js environment:', e);
      throw new Error(`WebTorrent could not be loaded in Node.js environment. Make sure webtorrent is installed: npm install webtorrent. Error: ${e.message}`);
    }
  }
  
  if (!WebTorrent) {
    throw new Error('WebTorrent failed to load from all sources. The WebTorrent library is required for this transport to function.');
  }
  
  console.log('WebTorrent successfully loaded and cached');
  return WebTorrent;
}

/**
 * Gets the cached WebTorrent instance if available
 * @returns {Function|null} WebTorrent constructor or null if not loaded
 */
export function getWebTorrent() {
  return WebTorrent;
}
