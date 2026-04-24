'use strict';

/**
 * HTTP proxy server that accepts WebDriver requests from the Chrome extension
 * and forwards them to WebDriverAgent via WDAClient.
 * Port of HTTPProxyServer.swift.
 */

const http = require('http');
const { EventEmitter } = require('events');
const router = require('./endpoint-router');
const wda = require('./wda-client');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

class ProxyServer extends EventEmitter {
  constructor() {
    super();
    this._server = null;
    this.isRunning = false;
    this.port = 4723;
    this.requestCount = 0;
  }

  start(port = 4723) {
    this.port = port;
    this._server = http.createServer((req, res) => this._handleRequest(req, res));

    this._server.on('error', (err) => {
      this.isRunning = false;
      this.emit('log', { level: 'error', source: 'proxy', message: `Server error: ${err.message}` });
      this.emit('stopped');
    });

    this._server.listen(port, '127.0.0.1', () => {
      this.isRunning = true;
      this.emit('log', { level: 'info', source: 'proxy', message: `Proxy server running on port ${port}` });
      this.emit('started');
    });
  }

  stop() {
    if (!this._server) return;
    this._server.close(() => {
      this.isRunning = false;
      this.emit('stopped');
    });
    this._server = null;
  }

  async _handleRequest(req, res) {
    // Collect body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
        'Content-Length': '0',
        'Connection': 'close',
      });
      res.end();
      return;
    }

    // Route: translate Appium-specific paths
    const { method, wdaPath, body: routedBody } = router.route(req.method, req.url, body);

    try {
      const result = await wda.forward(method, wdaPath, routedBody, req.headers);

      // Merge CORS headers into WDA response headers (drop hop-by-hop from WDA)
      const responseHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(result.data),
        'Connection': 'close',
        ...CORS_HEADERS,
      };

      res.writeHead(result.statusCode, responseHeaders);
      res.end(result.data);

      this.requestCount++;
      this.emit('request', { method: req.method, path: req.url, status: result.statusCode });
      this.emit('log', {
        level: 'info',
        source: 'proxy',
        message: `${req.method} ${req.url} → ${result.statusCode}`,
      });
    } catch (err) {
      const errorBody = JSON.stringify({
        value: { error: 'unknown error', message: err.message, stacktrace: '' },
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorBody),
        'Connection': 'close',
        ...CORS_HEADERS,
      });
      res.end(errorBody);
      this.emit('log', {
        level: 'error',
        source: 'proxy',
        message: `${req.method} ${req.url} → 500: ${err.message}`,
      });
    }
  }
}

module.exports = ProxyServer;
