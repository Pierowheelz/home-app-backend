const fetchWithTimeout = require('../fetchWithTimeout');

/**
 * @param {unknown} data
 * @returns {boolean}
 */
function isUsableVentPayload(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    const o = /** @type {Record<string, unknown>} */ (data);
    if (o['0']) {
        return true;
    }
    const st = o.status;
    if (st !== null && typeof st === 'object' && !Array.isArray(st) && /** @type {Record<string, unknown>} */ (st)['0']) {
        return true;
    }
    return false;
}

/** @type {Record<string, unknown>|null} Last successful vent API payload (shape varies by device). */
let cachedVentPayload = null;

const DEFAULT_VENT_BASE_URL = 'http://192.168.2.110';

/**
 * @returns {string} Base URL for the vent controller HTTP API (no trailing slash).
 */
function getVentBaseUrl() {
    const v = global.appconfig?.ventAutomation?.ventBaseUrl;
    if (typeof v === 'string' && v.trim() !== '') {
        return v.replace(/\/$/, '');
    }
    return DEFAULT_VENT_BASE_URL;
}

/**
 * @param {number} value Numeric vent position.
 * @param {number} padding Digit count.
 * @returns {string} Zero-padded string.
 */
function ventNumberPad(value, padding) {
    const zeroes = new Array(padding + 1).join('0');
    return (zeroes + String(value)).slice(-padding);
}

/**
 * @returns {Record<string, unknown>|null} Last payload after a successful GET or SET, or null.
 */
function getCachedVentPayload() {
    return cachedVentPayload;
}

/**
 * @param {Record<string, unknown>|null} payload
 * @returns {void}
 */
function setCachedVentPayload(payload) {
    cachedVentPayload = payload;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * True when the TCP peer likely closed during a long-running SET while the move may still succeed.
 * @param {unknown} err
 * @returns {boolean}
 */
function isRecoverableVentSetNetworkError(err) {
    if (!(err instanceof Error)) {
        return false;
    }
    const msg = err.message.toLowerCase();
    const code = /** @type {{ code?: string }} */ (err).code;
    if (code === 'ECONNRESET' || code === 'EPIPE') {
        return true;
    }
    if (msg.includes('socket hang up') || msg.includes('reason: socket hang up')) {
        return true;
    }
    return false;
}

/**
 * Poll status after SET dropped the connection; firmware often applies the move but closes HTTP early.
 * @param {number|string} motorId
 * @param {number} targetPos Clamped 0–100.
 * @returns {Promise<{ ok: boolean, data: Record<string, unknown>|null }>}
 */
async function pollUntilMotorNear(motorId, targetPos) {
    const maxWaitMs = 55000;
    const intervalMs = 2500;
    const tolerance = 3;
    const deadline = Date.now() + maxWaitMs;
    let lastPayload = null;

    await sleep(800);

    while (Date.now() < deadline) {
        const payload = await getVentStatus();
        if (payload && typeof payload === 'object') {
            lastPayload = payload;
        }
        const pos = readMotorPos(lastPayload, motorId);
        if (pos !== null && Math.abs(pos - targetPos) <= tolerance) {
            console.log(
                'Vent SET recovered via poll; motor',
                motorId,
                'at',
                pos,
                'target',
                targetPos,
            );
            return { ok: true, data: /** @type {Record<string, unknown>} */ (lastPayload) };
        }
        await sleep(intervalMs);
    }

    console.warn(
        'Vent SET poll gave up; motor',
        motorId,
        'last pos',
        readMotorPos(lastPayload, motorId),
        'target',
        targetPos,
    );
    return { ok: false, data: null };
}

/**
 * Fetch current vent status from the controller (`t=1`).
 * @returns {Promise<Record<string, unknown>|null>} Parsed JSON when usable; otherwise null.
 */
async function getVentStatus() {
    const base = getVentBaseUrl();
    const url = `${base}/?&t=1`;
    try {
        const response = await fetchWithTimeout(url, { timeoutMs: 8000 });
        if (!response.ok) {
            console.warn('Vent GET: HTTP not ok');
            return null;
        }
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.warn('Vent GET: invalid JSON', msg, text.slice(0, 200));
            return null;
        }
        if (data && typeof data === 'object' && isUsableVentPayload(data)) {
            cachedVentPayload = /** @type {Record<string, unknown>} */ (data);
        }
        return /** @type {Record<string, unknown>} */ (data);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('Vent GET failed', msg);
        return null;
    }
}

/**
 * Set a vent motor position (raw device units, typically 0–100).
 * @param {number|string} motorId Motor index as used in `m=` query parameter.
 * @param {number} raw Raw position (clamped 0–100 before send).
 * @returns {Promise<{ ok: boolean, data: Record<string, unknown>|null }>}
 */
async function setVentMotorRaw(motorId, raw) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(raw))));
    const padded = ventNumberPad(clamped, 3);
    const base = getVentBaseUrl();
    const url = `${base}/?a=6&t=1&m=${encodeURIComponent(String(motorId))}&d=${padded}`;

    /**
     * @param {Record<string, unknown>|null} data
     * @returns {{ ok: boolean, data: Record<string, unknown>|null }}
     */
    const finishFromPayload = (data) => {
        console.log('Vent SET response: ', data);
        if (data && typeof data === 'object' && isUsableVentPayload(data)) {
            cachedVentPayload = data;
        }
        return { ok: true, data };
    };

    try {
        const response = await fetchWithTimeout(url, { timeoutMs: 90000 });
        if (!response.ok) {
            console.warn('Vent SET: HTTP not ok', response.status);
            return { ok: false, data: null };
        }
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.warn('Vent SET: invalid JSON', msg, text.slice(0, 200));
            return { ok: false, data: null };
        }
        return finishFromPayload(data);
    } catch (e) {
        if (isRecoverableVentSetNetworkError(e)) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('Vent SET connection dropped; polling for position', clamped, msg);
            return pollUntilMotorNear(motorId, clamped);
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('Vent SET failed', msg);
        return { ok: false, data: null };
    }
}

/**
 * Locate the status object for a motor on the vent payload.
 * @param {Record<string, unknown>|null|undefined} payload Root JSON from vent API.
 * @param {number|string} motorId
 * @returns {Record<string, unknown>|null}
 */
function findMotorBlock(payload, motorId) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const id = String(motorId);
    const statusRoot = payload.status;
    let block = null;
    if (statusRoot !== null && typeof statusRoot === 'object' && !Array.isArray(statusRoot)) {
        const s = /** @type {Record<string, unknown>} */ (statusRoot);
        const b = s[id];
        if (b !== null && typeof b === 'object') {
            block = /** @type {Record<string, unknown>} */ (b);
        }
    }
    if (!block) {
        const top = payload[id];
        if (top !== null && typeof top === 'object') {
            block = /** @type {Record<string, unknown>} */ (top);
        }
    }
    return block;
}

/**
 * Read `pos` for a motor from a vent status payload.
 * @param {Record<string, unknown>|null|undefined} payload Root JSON from vent API.
 * @param {number|string} motorId
 * @returns {number|null} Positive or zero position, or null if unknown.
 */
function readMotorPos(payload, motorId) {
    const block = findMotorBlock(payload, motorId);
    if (!block || typeof block !== 'object') {
        return null;
    }
    const pos = block.pos;
    if (typeof pos !== 'number' || !Number.isFinite(pos)) {
        return null;
    }
    return pos;
}

/**
 * Read display name and position when the slot exists on the payload.
 * @param {Record<string, unknown>|null|undefined} payload Root JSON from vent API.
 * @param {number|string} motorId
 * @returns {{ pos: number, name: string|null }|null}
 */
function readMotorSlot(payload, motorId) {
    const block = findMotorBlock(payload, motorId);
    if (!block || typeof block !== 'object') {
        return null;
    }
    const pos = block.pos;
    if (typeof pos !== 'number' || !Number.isFinite(pos)) {
        return null;
    }
    const n = block.name;
    const name = typeof n === 'string' && n.trim() !== '' ? n : null;
    return { pos, name };
}

module.exports = {
    getVentBaseUrl,
    ventNumberPad,
    getCachedVentPayload,
    setCachedVentPayload,
    getVentStatus,
    setVentMotorRaw,
    readMotorPos,
    readMotorSlot,
};
