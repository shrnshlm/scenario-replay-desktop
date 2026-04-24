'use strict';

/**
 * Translates Appium-specific WebDriver paths to WDA-native paths.
 * Only 2 endpoints need translation; everything else passes through unchanged.
 * Port of EndpointRouter.swift.
 */

function route(method, path, body) {
  if (method === 'POST') {
    // activate_app → wda/apps/activate
    const activateMatch = path.match(/^\/session\/([^/]+)\/appium\/device\/activate_app$/);
    if (activateMatch) {
      return {
        method: 'POST',
        wdaPath: `/session/${activateMatch[1]}/wda/apps/activate`,
        body: remapBundleIdBody(body),
      };
    }

    // terminate_app → wda/apps/terminate
    const terminateMatch = path.match(/^\/session\/([^/]+)\/appium\/device\/terminate_app$/);
    if (terminateMatch) {
      return {
        method: 'POST',
        wdaPath: `/session/${terminateMatch[1]}/wda/apps/terminate`,
        body: remapBundleIdBody(body),
      };
    }
  }

  // All other endpoints pass through unchanged
  return { method, wdaPath: path, body };
}

function remapBundleIdBody(body) {
  if (!body) return body;
  try {
    const json = JSON.parse(body);
    if (json.bundleId) return JSON.stringify({ bundleId: json.bundleId });
  } catch (_) { /* fall through */ }
  return body;
}

module.exports = { route };
