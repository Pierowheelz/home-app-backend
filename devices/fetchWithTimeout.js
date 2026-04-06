const fetch = require('node-fetch');

/** @typedef {{ timeoutMs?: number }} FetchWithTimeoutOptions */

/**
 * GET with AbortSignal timeout. Intended for local-device HTTP APIs.
 * @param {string} url
 * @param {FetchWithTimeoutOptions} [options]
 * @returns {Promise<import('node-fetch').Response>}
 */
const fetchWithTimeout = (url, options = {}) => {
    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : 4000;
    console.log('Fetch command issued: ', url);

    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    return fetch(url, {
        method: 'GET',
        cache: 'no-cache',
        signal,
    }).finally(() => {
        clearTimeout(timer);
    });
};

module.exports = fetchWithTimeout;
