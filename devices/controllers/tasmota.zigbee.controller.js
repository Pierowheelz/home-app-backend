/**
 * Tasmota Zigbee bridge (`tele`/`stat` topic root `tasmota_zigbee`) with temperature sensors.
 *
 * Preferred input: `tele/.../SENSOR` JSON with `ZbReceived` (decoded Temperature/Humidity).
 *
 * Some setups only publish `stat/.../RESULT` with `{"ZbData":"ZbData 0xADDR,HEX..."}` — that string is not
 * human-readable; it is raw stack data. Where the HEX matches an Aqara-style report (marker `0E05010F00`),
 * we decode temp/humidity in centi-units (LE uint16/int16) so readings still update.
 */

/** @type {Record<string, string>} Normalized Zigbee address (e.g. 0x954D) → room label */
const SENSOR_MAP = {
    '0x954D': 'Guest Room',
    '0xD7D5': 'Stairwell',
    '0xA33F': 'Peter Room',
    '0x2047': 'Burton Room',
};

/**
 * @typedef {Object} ZigbeeSensorReading
 * @property {number|null} temperature Last temperature in °C, or null if never received.
 * @property {number|null} [humidity] Relative humidity % when reported.
 * @property {number|null} [lastUpdateMs] Epoch milliseconds when this sensor last updated.
 */

/** @type {Record<string, ZigbeeSensorReading>} Room label → last reading */
const readingsByRoom = {};

Object.values(SENSOR_MAP).forEach((room) => {
    readingsByRoom[room] = { temperature: null, lastUpdateMs: null };
});

/** Hex marker (lowercase) before temp/humidity centi-values in many Aqara temp/humidity frames inside ZbData. */
const ZB_DATA_TEMP_HUM_ANCHOR = '0e05010f00';

/**
 * Persist a decoded reading for a mapped room.
 * @param {string} room Room label from SENSOR_MAP.
 * @param {number} temperature Temperature in °C.
 * @param {number} [humidity] Relative humidity % when known.
 * @param {number} now `Date.now()`.
 * @returns {void}
 */
function applyReading(room, temperature, humidity, now) {
    /** @type {ZigbeeSensorReading} */
    const next = {
        ...readingsByRoom[room],
        temperature,
        lastUpdateMs: now,
    };
    if (typeof humidity === 'number' && Number.isFinite(humidity)) {
        next.humidity = humidity;
    }
    readingsByRoom[room] = next;
}

/**
 * Decode temperature/humidity from ZbData hex after {@link ZB_DATA_TEMP_HUM_ANCHOR}.
 * @param {string} hexPayload Hex string (optional 0x prefix); odd length or non-hex rejected.
 * @returns {{ temperature: number, humidity?: number }|null}
 */
function parseZbDataHexPayload(hexPayload) {
    const h = String(hexPayload)
        .replace(/^0x/i, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) {
        return null;
    }
    const idx = h.indexOf(ZB_DATA_TEMP_HUM_ANCHOR);
    if (idx === -1) {
        return null;
    }
    /** @type {Buffer} */
    const buf = Buffer.from(h, 'hex');
    const byteOffset = idx / 2 + ZB_DATA_TEMP_HUM_ANCHOR.length / 2;
    if (byteOffset + 6 > buf.length) {
        return null;
    }
    const tempCenti = buf.readInt16LE(byteOffset);
    const humCenti = buf.readUInt16LE(byteOffset + 4);
    if (tempCenti < -5000 || tempCenti > 6000) {
        return null;
    }
    const temperature = Math.round(tempCenti) / 100;
    if (humCenti > 10000) {
        return { temperature };
    }
    const humidity = Math.round(humCenti) / 100;
    return { temperature, humidity };
}

/**
 * Parse Tasmota `ZbData 0xADDR,<hex>` line from RESULT JSON.
 * @param {string} line Value of `ZbData` field.
 * @returns {{ addr: string, temperature: number, humidity?: number }|null}
 */
function parseZbDataLine(line) {
    const m = String(line)
        .trim()
        .match(/^ZbData\s+(0x[0-9a-f]+),([0-9a-f]+)\s*$/i);
    if (!m) {
        return null;
    }
    const addr = normalizeZigbeeAddress(m[1]);
    const decoded = parseZbDataHexPayload(m[2]);
    if (!decoded || !addr) {
        return null;
    }
    return { addr, ...decoded };
}

/**
 * Normalize Zigbee device address strings for map lookup.
 * @param {string} addr Raw key from JSON (e.g. "0x954D", "954d").
 * @returns {string} Uppercase "0x..." form, or empty string if invalid.
 */
function normalizeZigbeeAddress(addr) {
    const s = String(addr).trim();
    const hex = s.toLowerCase().startsWith('0x') ? s.slice(2) : s;
    if (!/^[0-9a-f]+$/i.test(hex)) {
        return '';
    }
    return '0x' + hex.toUpperCase();
}

/**
 * Collect `ZbInfo` blocks (cached device details from `ZbInfo` / startup refresh).
 * @param {Record<string, unknown>} msgJson Parsed MQTT JSON body.
 * @returns {Array<[string, Record<string, unknown>]>} Pairs of normalized address key and device object.
 */
function collectZbInfoEntries(msgJson) {
    const zb = msgJson.ZbInfo;
    if (zb === null || typeof zb !== 'object' || Array.isArray(zb)) {
        return [];
    }
    /** @type {Array<[string, Record<string, unknown>]>} */
    const out = [];
    for (const [nameKey, v] of Object.entries(/** @type {Record<string, unknown>} */ (zb))) {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
            continue;
        }
        const payload = /** @type {Record<string, unknown>} */ (v);
        let addrRaw = payload.Device;
        if (typeof addrRaw !== 'string' || addrRaw.trim() === '') {
            addrRaw = nameKey;
        }
        out.push([String(addrRaw), payload]);
    }
    return out;
}

/**
 * Collect device entries from a Tasmota Zigbee JSON payload.
 * @param {Record<string, unknown>} msgJson Parsed MQTT JSON body.
 * @returns {Array<[string, Record<string, unknown>]>} Pairs of address key and device object.
 */
function collectZbEntries(msgJson) {
    const zb = msgJson.ZbReceived;
    if (zb !== null && typeof zb === 'object' && !Array.isArray(zb)) {
        return Object.entries(/** @type {Record<string, Record<string, unknown>>} */ (zb));
    }
    /** @type {Array<[string, Record<string, unknown>]>} */
    const out = [];
    for (const addr of Object.keys(SENSOR_MAP)) {
        const payload = msgJson[addr];
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
            out.push([addr, /** @type {Record<string, unknown>} */ (payload)]);
        }
    }
    return out;
}

/**
 * Handle MQTT JSON from the Zigbee bridge.
 * @param {Record<string, unknown>} msgJson Parsed payload from Tasmota.
 * @returns {void}
 */
const onMessage = (msgJson) => {
    console.log('tasmota zigbee message received.');
    const now = Date.now();

    for (const [addrRaw, payload] of collectZbInfoEntries(msgJson)) {
        const addr = normalizeZigbeeAddress(addrRaw);
        const room = SENSOR_MAP[addr];
        if (!room) {
            continue;
        }
        const temp = payload.Temperature;
        const hum = payload.Humidity;
        if (typeof temp === 'number') {
            applyReading(room, temp, typeof hum === 'number' ? hum : undefined, now);
        }
    }

    const zbDataField = msgJson.ZbData;
    if (typeof zbDataField === 'string') {
        const parsed = parseZbDataLine(zbDataField);
        if (parsed) {
            const room = SENSOR_MAP[parsed.addr];
            if (room) {
                applyReading(room, parsed.temperature, parsed.humidity, now);
            }
        }
    }

    const entries = collectZbEntries(msgJson);
    for (const [addrRaw, payload] of entries) {
        const addr = normalizeZigbeeAddress(addrRaw);
        const room = SENSOR_MAP[addr];
        if (!room || payload === null || typeof payload !== 'object') {
            continue;
        }

        const temp = payload.Temperature;
        const hum = payload.Humidity;
        if (typeof temp !== 'number') {
            continue;
        }

        applyReading(room, temp, typeof hum === 'number' ? hum : undefined, now);
    }
};

/** Stagger between `ZbInfo` queries so the coordinator is not flooded. */
const ZB_BOOTSTRAP_STAGGER_MS = 400;

/** Delay before the first `ZbInfo` after MQTT subscribe (broker / stack settle time). */
const ZB_BOOTSTRAP_INITIAL_MS = 200;

/**
 * Attach this controller to the shared MQTT session (subscribe/publish prefix `tasmota_zigbee`).
 * On connect, requests cached sensor details via `ZbInfo` (one publish per short address) so GET `/tasmota-zigbee` can populate quickly.
 * @param {{ addDevice: (name: string, handler: (msg: Record<string, unknown>) => void, options?: { bootstrap?: (publish: (topic: string, payload?: string) => void) => void }) => void }} mqttController Application MQTT handler.
 * @returns {void}
 */
exports.attachMqtt = (mqttController) => {
    mqttController.addDevice('tasmota_zigbee', onMessage, {
        bootstrap: (publish) => {
            const addrs = Object.keys(SENSOR_MAP);
            addrs.forEach((addr, i) => {
                setTimeout(() => {
                    publish('cmnd/tasmota_zigbee/ZbInfo', addr);
                }, ZB_BOOTSTRAP_INITIAL_MS + i * ZB_BOOTSTRAP_STAGGER_MS);
            });
        },
    });
};

/**
 * Return last known temperatures (and optional humidity) for all mapped sensors.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
exports.getState = (req, res) => {
    res.status(200).send({
        device: 'tasmota_zigbee',
        sensors: readingsByRoom,
    });
};
