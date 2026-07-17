const fetchWithTimeout = require('../fetchWithTimeout');
const {
    normalizeVentBaseUrls,
    normalizeRoomVentMap,
    findRoomVentEntryByExternalId,
} = require('./vent.automation.utils');

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

/** @type {Record<number, Record<string, unknown>|null>} Last successful payload per motorControllerId. */
const cachedVentPayloadByController = {};

const DEFAULT_VENT_BASE_URL = 'http://192.168.2.110';

/**
 * @returns {string[]} Base URLs for vent controllers (no trailing slash).
 */
function getVentBaseUrls() {
    return normalizeVentBaseUrls(global.appconfig?.ventAutomation?.ventBaseUrl, DEFAULT_VENT_BASE_URL);
}

/**
 * @param {number} [controllerId=0]
 * @returns {string} Base URL for the given controller (no trailing slash).
 */
function getVentBaseUrl(controllerId = 0) {
    const urls = getVentBaseUrls();
    const id = Number.isInteger(controllerId) && controllerId >= 0 ? controllerId : 0;
    if (id < urls.length) {
        return urls[id];
    }
    return urls[0] ?? DEFAULT_VENT_BASE_URL;
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
 * Merged status keyed by externalId for API/dashboard consumers.
 * @returns {Record<string, unknown>|null}
 */
function getCachedVentPayload() {
    const map = normalizeRoomVentMap(global.appconfig?.ventAutomation?.roomVentMap);
    /** @type {Record<string, unknown>} */
    const merged = {};
    let any = false;
    for (const entry of Object.values(map)) {
        const ctrlPayload = cachedVentPayloadByController[entry.motorControllerId];
        if (!ctrlPayload) {
            continue;
        }
        const block = findMotorBlock(ctrlPayload, entry.motorId);
        if (!block) {
            continue;
        }
        merged[String(entry.externalId)] = block;
        any = true;
    }
    if (!any && Object.keys(map).length === 0) {
        // Legacy single-controller cache with no roomVentMap yet: expose controller 0 as-is.
        const c0 = cachedVentPayloadByController[0];
        return c0 ?? null;
    }
    return any ? merged : null;
}

/**
 * @param {number} controllerId
 * @returns {Record<string, unknown>|null}
 */
function getCachedVentPayloadForController(controllerId) {
    return cachedVentPayloadByController[controllerId] ?? null;
}

/**
 * @param {number} controllerId
 * @param {Record<string, unknown>|null} payload
 * @returns {void}
 */
function setCachedVentPayload(controllerId, payload) {
    cachedVentPayloadByController[controllerId] = payload;
}

/**
 * Clear all per-controller caches.
 * @returns {void}
 */
function clearAllCachedVentPayloads() {
    for (const key of Object.keys(cachedVentPayloadByController)) {
        delete cachedVentPayloadByController[Number(key)];
    }
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
 * @param {number} controllerId
 * @param {number|string} motorId Hardware motor index on that controller.
 * @param {number} targetPos Clamped 0–100.
 * @returns {Promise<{ ok: boolean, data: Record<string, unknown>|null }>}
 */
async function pollUntilMotorNear(controllerId, motorId, targetPos) {
    const maxWaitMs = 55000;
    const intervalMs = 2500;
    const tolerance = 3;
    const deadline = Date.now() + maxWaitMs;
    let lastPayload = null;

    await sleep(800);

    while (Date.now() < deadline) {
        const payload = await getVentStatus(controllerId);
        if (payload && typeof payload === 'object') {
            lastPayload = payload;
        }
        const pos = readMotorPos(lastPayload, motorId);
        if (pos !== null && Math.abs(pos - targetPos) <= tolerance) {
            console.log(
                'Vent SET recovered via poll; controller',
                controllerId,
                'motor',
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
        'Vent SET poll gave up; controller',
        controllerId,
        'motor',
        motorId,
        'last pos',
        readMotorPos(lastPayload, motorId),
        'target',
        targetPos,
    );
    return { ok: false, data: null };
}

/**
 * Fetch current vent status from one controller (`t=1`).
 * @param {number} [controllerId=0]
 * @returns {Promise<Record<string, unknown>|null>} Parsed JSON when usable; otherwise null.
 */
async function getVentStatus(controllerId = 0) {
    const base = getVentBaseUrl(controllerId);
    const url = `${base}/?&t=1`;
    try {
        const response = await fetchWithTimeout(url, { timeoutMs: 8000 });
        if (!response.ok) {
            console.warn('Vent GET: HTTP not ok; controller', controllerId);
            return null;
        }
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.warn('Vent GET: invalid JSON; controller', controllerId, msg, text.slice(0, 200));
            return null;
        }
        if (data && typeof data === 'object' && isUsableVentPayload(data)) {
            cachedVentPayloadByController[controllerId] = /** @type {Record<string, unknown>} */ (data);
        }
        return /** @type {Record<string, unknown>} */ (data);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('Vent GET failed; controller', controllerId, msg);
        return null;
    }
}

/**
 * Poll every configured controller and refresh caches.
 * @returns {Promise<(Record<string, unknown>|null)[]>}
 */
async function getAllVentStatuses() {
    const urls = getVentBaseUrls();
    /** @type {(Record<string, unknown>|null)[]} */
    const results = [];
    for (let i = 0; i < urls.length; i++) {
        results.push(await getVentStatus(i));
    }
    return results;
}

/**
 * Set a vent motor position on a specific controller (raw device units, typically 0–100).
 * @param {number} controllerId
 * @param {number|string} motorId Hardware motor index as used in `m=` query parameter.
 * @param {number} raw Raw position (clamped 0–100 before send).
 * @returns {Promise<{ ok: boolean, data: Record<string, unknown>|null }>}
 */
async function setVentMotorRaw(controllerId, motorId, raw) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(raw))));
    const padded = ventNumberPad(clamped, 3);
    const base = getVentBaseUrl(controllerId);
    const url = `${base}/?a=6&t=1&m=${encodeURIComponent(String(motorId))}&d=${padded}`;

    /**
     * @param {Record<string, unknown>|null} data
     * @returns {{ ok: boolean, data: Record<string, unknown>|null }}
     */
    const finishFromPayload = (data) => {
        console.log('Vent SET response: ', data);
        if (data && typeof data === 'object' && isUsableVentPayload(data)) {
            cachedVentPayloadByController[controllerId] = data;
        }
        return { ok: true, data };
    };

    try {
        const response = await fetchWithTimeout(url, { timeoutMs: 90000 });
        if (!response.ok) {
            console.warn('Vent SET: HTTP not ok', response.status, 'controller', controllerId);
            return { ok: false, data: null };
        }
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (parseErr) {
            const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.warn('Vent SET: invalid JSON; controller', controllerId, msg, text.slice(0, 200));
            return { ok: false, data: null };
        }
        return finishFromPayload(data);
    } catch (e) {
        if (isRecoverableVentSetNetworkError(e)) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('Vent SET connection dropped; polling for position', clamped, msg);
            return pollUntilMotorNear(controllerId, motorId, clamped);
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('Vent SET failed; controller', controllerId, msg);
        return { ok: false, data: null };
    }
}

/**
 * Resolve `externalId` via roomVentMap and set the hardware motor.
 * @param {number|string} externalId
 * @param {number} raw
 * @returns {Promise<{ ok: boolean, data: Record<string, unknown>|null, externalId?: number, entry?: import('./vent.automation.utils').RoomVentEntry }>}
 */
async function setVentMotorByExternalId(externalId, raw) {
    const map = normalizeRoomVentMap(global.appconfig?.ventAutomation?.roomVentMap);
    const found = findRoomVentEntryByExternalId(map, externalId);
    if (found === null) {
        console.warn('Vent SET: unknown externalId', externalId);
        return { ok: false, data: null };
    }
    const { entry } = found;
    const result = await setVentMotorRaw(entry.motorControllerId, entry.motorId, raw);
    return { ...result, externalId: entry.externalId, entry };
}

/**
 * Locate the status object for a motor on the vent payload.
 * @param {Record<string, unknown>|null|undefined} payload Root JSON from vent API (or merged-by-externalId cache).
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
    getVentBaseUrls,
    ventNumberPad,
    getCachedVentPayload,
    getCachedVentPayloadForController,
    setCachedVentPayload,
    clearAllCachedVentPayloads,
    getVentStatus,
    getAllVentStatuses,
    setVentMotorRaw,
    setVentMotorByExternalId,
    readMotorPos,
    readMotorSlot,
};
