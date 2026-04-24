'use strict';

/**
 * HTTP client that forwards requests to WebDriverAgent running on localhost:8100.
 * Port of WDAClient.swift.
 */

const http = require('http');

const WDA_HOST = 'localhost';
const WDA_PORT = 8100;

const DEFAULT_TIMEOUT = 30_000;   // 30s
const SESSION_TIMEOUT = 120_000;  // 120s — WDA app launch takes 60–90s on real device
const HEALTH_TIMEOUT  = 3_000;    // 3s

// Headers that must not be forwarded (hop-by-hop)
const HOP_BY_HOP = new Set(['host', 'connection', 'transfer-encoding']);

/**
 * Check whether WDA is responding.
 * Returns true if any HTTP response comes back within 3 s.
 */
function isReady() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: WDA_HOST, port: WDA_PORT, path: '/status', method: 'GET', timeout: HEALTH_TIMEOUT },
      () => { req.destroy(); resolve(true); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Forward a WebDriver request to WDA.
 * Returns { statusCode, headers, data }.
 */
function forward(method, path, body, incomingHeaders) {
  const isSessionCreation = method === 'POST' && path === '/session';
  const timeout = isSessionCreation ? SESSION_TIMEOUT : DEFAULT_TIMEOUT;

  // Build forwarded headers — strip hop-by-hop
  const headers = {};
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }

  const bodyBuffer = body ? Buffer.from(body) : null;
  if (bodyBuffer) {
    headers['Content-Length'] = bodyBuffer.length;
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: WDA_HOST,
        port: WDA_PORT,
        path,
        method,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`WDA request timed out after ${timeout}ms: ${method} ${path}`));
    });
    req.on('error', reject);

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

module.exports = { isReady, forward };
