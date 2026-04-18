const ventAutomation = require('../services/vent.automation.service');

/**
 * Tasmota Zigbee bridge (`tele`/`stat` topic root `tasmota_zigbee`) with temperature sensors.
 *
 * Preferred input: `tele/.../SENSOR` JSON with `ZbReceived` (decoded Temperature/Humidity).
 * Tuya TS0601-class sensors may instead report Tuya datapoints such as `EF00/0201` (temp),
 * `EF00/0202` (humidity), and `EF00/0204` (battery) which we normalize here.
 *
 * Some setups only publish `stat/.../RESULT` with `{"ZbData":"ZbData 0xADDR,HEX..."}` — that string is not
 * human-readable; it is raw stack data. Where the HEX matches an Aqara-style report (marker `0E05010F00`),
 * we decode temp/humidity in centi-units (LE uint16/int16) so readings still update.
 */

/**
 * Normalized Zigbee address (e.g. `0x954D`) → room label from `appconfig.ventAutomation.zigbeeSensorMap`.
 * @returns {Record<string, string>}
 */
function getZigbeeSensorMap() {
    const m = appconfig?.ventAutomation?.zigbeeSensorMap;
    if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
        return /** @type {Record<string, string>} */ (m);
    }
    return {};
}

/**
 * Normalized Zigbee short address of the configured HVAC fan power monitor, or empty when not configured.
 * @returns {string}
 */
function getHvacPowerSensorAddr() {
    const raw = appconfig?.ventAutomation?.hvacPowerSensorZigbeeAddr;
    if (typeof raw !== 'string' || raw.trim() === '') {
        return '';
    }
    return normalizeZigbeeAddress(raw.trim());
}

/**
 * Extract instantaneous power (W) from Tuya datapoints in a `ZbReceived` payload.
 *
 * The PJ-1203 / `_TZE284_cjbofhxw` energy monitor reports power on standard Tuya DP 19
 * (`0x13`), type uint32 (`0x02`), in deci-watts — surfaced by Tasmota as
 * `EF00/<type><dpid>` (e.g. `EF00/0213`). We accept any type byte for forward-compat.
 *
 * Note on handshake (PJ-1203A `_TZE284_cjbofhxw` and kin): this firmware gates its Tuya DP
 * reports behind a `mcuGatewayConnectionStatus` handshake. The MCU periodically emits Tuya
 * cluster command `0x25` (surfaced by Tasmota as `EF00?25`, `?` = unrecognized command) with
 * a 2-byte sequence payload, and will not send DP reports until each one is acknowledged.
 * The reply — cluster `0xEF00`, command `0x25`, payload `<seq_bytes>0100` — must be sent by
 * the Tasmota bridge itself via a persisted rule (Tasmota's generic ZCL sender is only
 * reachable from the bridge, not from this backend). Expected bridge config:
 *   Rule1 ON ZbReceived#<addr>#EF00?25 DO ZbSend {"Device":"<addr>","Endpoint":1,"Send":"EF00!25/%value%0100"} ENDON
 *   Rule1 1
 * Once the rule is active the device streams real DPs (DP `0x13` power in deci-watts,
 * `0x14` voltage in deci-volts, `0x12` current in mA, etc.), which we decode here. The raw
 * `EF00?25` heartbeats themselves carry only the rolling frame sequence and are ignored.
 *
 * @param {Record<string, unknown>} payload Device object from `ZbReceived`.
 * @returns {number|null} Watts, or `null` when no power datapoint is present.
 */
function readTuyaPowerWatts(payload) {
    for (const [key, value] of Object.entries(payload)) {
        const m = String(key).match(/^EF00\/([0-9A-F]{4})$/i);
        if (!m || typeof value !== 'number' || !Number.isFinite(value)) {
            continue;
        }
        const dpid = m[1].toUpperCase().slice(2, 4);
        if (dpid === '13') {
            return value / 10;
        }
    }
    return null;
}

/**
 * @typedef {Object} ZigbeeSensorReading
 * @property {number|null} temperature Last temperature in °C, or null if never received.
 * @property {number|null} [humidity] Relative humidity % when reported.
 * @property {number|null} [lastUpdateMs] Epoch milliseconds when this sensor last updated.
 * @property {number|null} [batteryLevel] Battery charge 0–100 from `BatteryPercentage` when reported.
 * @property {number|null} [linkQuality] Zigbee link quality from `LinkQuality` when reported.
 */

/** @type {Record<string, ZigbeeSensorReading>} Room label → last reading */
const readingsByRoom = {};

Object.values(getZigbeeSensorMap()).forEach((room) => {
    readingsByRoom[room] = { temperature: null, lastUpdateMs: null };
});

/** Hex marker (lowercase) before temp/humidity centi-values in many Aqara temp/humidity frames inside ZbData. */
const ZB_DATA_TEMP_HUM_ANCHOR = '0e05010f00';

/**
 * Extract optional humidity / radio fields Tasmota exposes on Zigbee device objects.
 * @param {Record<string, unknown>} payload Device object from `ZbInfo` / `ZbReceived`.
 * @returns {{ humidity?: number, batteryLevel?: number, linkQuality?: number }}
 */
function readPayloadMetrics(payload) {
    /** @type {{ humidity?: number, batteryLevel?: number, linkQuality?: number }} */
    const m = {};
    if (typeof payload.Humidity === 'number' && Number.isFinite(payload.Humidity)) {
        m.humidity = payload.Humidity;
    }
    if (typeof payload.BatteryPercentage === 'number' && Number.isFinite(payload.BatteryPercentage)) {
        m.batteryLevel = payload.BatteryPercentage;
    }
    if (typeof payload.LinkQuality === 'number' && Number.isFinite(payload.LinkQuality)) {
        m.linkQuality = payload.LinkQuality;
    }
    return m;
}

/**
 * Parse Tuya `EF00/xxxx` datapoints from a Zigbee payload object.
 * Common TS0601 mappings used by these temperature/humidity sensors:
 * - `0201`: temperature in deci-degrees C
 * - `0202`: humidity in deci-percent RH
 * - `0204`: battery percentage
 * @param {Record<string, unknown>} payload Device object from `ZbReceived`.
 * @returns {{ temperature?: number, humidity?: number, batteryLevel?: number }}
 */
function readTuyaEf00Metrics(payload) {
    /** @type {{ temperature?: number, humidity?: number, batteryLevel?: number }} */
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
        const m = String(key).match(/^EF00\/([0-9A-F]{4})$/i);
        if (!m || typeof value !== 'number' || !Number.isFinite(value)) {
            continue;
        }
        const dp = m[1].toUpperCase();
        if (dp === '0201') {
            // Tuya temp datapoint is typically tenths of a degree.
            out.temperature = value / 10;
            continue;
        }
        if (dp === '0202') {
            // Tuya humidity datapoint is typically tenths of a percent.
            out.humidity = value / 10;
            continue;
        }
        if (dp === '0204') {
            // Battery often comes as percentage (0-100); clamp to keep sane values.
            out.batteryLevel = Math.max(0, Math.min(100, Math.round(value)));
        }
    }
    return out;
}

/**
 * Update humidity / battery / link quality when no temperature is present in the telegram.
 * @param {string} room Room label from configured zigbeeSensorMap.
 * @param {{ humidity?: number, batteryLevel?: number, linkQuality?: number }} metrics
 * @returns {boolean} True when any field was stored.
 */
function applyAuxiliaryMetrics(room, metrics) {
    if (!Object.prototype.hasOwnProperty.call(readingsByRoom, room)) {
        return false;
    }
    const { humidity, batteryLevel, linkQuality } = metrics;
    /** @type {ZigbeeSensorReading} */
    const next = { ...readingsByRoom[room] };
    let changed = false;
    if (typeof humidity === 'number' && Number.isFinite(humidity)) {
        next.humidity = humidity;
        changed = true;
    }
    if (typeof batteryLevel === 'number' && Number.isFinite(batteryLevel)) {
        next.batteryLevel = batteryLevel;
        changed = true;
    }
    if (typeof linkQuality === 'number' && Number.isFinite(linkQuality)) {
        next.linkQuality = linkQuality;
        changed = true;
    }
    if (changed) {
        readingsByRoom[room] = next;
    }
    return changed;
}

/**
 * Persist a decoded reading for a mapped room.
 * @param {string} room Room label from configured zigbeeSensorMap.
 * @param {number} temperature Temperature in °C.
 * @param {number} [humidity] Relative humidity % when known.
 * @param {number} now `Date.now()`.
 * @param {{ batteryLevel?: number, linkQuality?: number }} [extras] From {@link readPayloadMetrics}.
 * @returns {boolean} True when a mapped room reading was stored.
 */
function applyReading(room, temperature, humidity, now, extras = {}) {
    if (!Object.prototype.hasOwnProperty.call(readingsByRoom, room)) {
        return false;
    }
    /** @type {ZigbeeSensorReading} */
    const next = {
        ...readingsByRoom[room],
        temperature,
        lastUpdateMs: now,
    };
    if (typeof humidity === 'number' && Number.isFinite(humidity)) {
        next.humidity = humidity;
    }
    if (typeof extras.batteryLevel === 'number' && Number.isFinite(extras.batteryLevel)) {
        next.batteryLevel = extras.batteryLevel;
    }
    if (typeof extras.linkQuality === 'number' && Number.isFinite(extras.linkQuality)) {
        next.linkQuality = extras.linkQuality;
    }
    readingsByRoom[room] = next;
    return true;
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
    for (const addr of Object.keys(getZigbeeSensorMap())) {
        const payload = msgJson[addr];
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
            out.push([addr, /** @type {Record<string, unknown>} */ (payload)]);
        }
    }
    return out;
}

/**
 * Immutable snapshot of {@link readingsByRoom} for consumers (vent automation, APIs).
 * @returns {Record<string, ZigbeeSensorReading>}
 */
function getReadingsSnapshot() {
    return Object.fromEntries(
        Object.entries(readingsByRoom).map(([k, v]) => [k, { ...v }]),
    );
}

/**
 * Handle MQTT JSON from the Zigbee bridge.
 * @param {Record<string, unknown>} msgJson Parsed payload from Tasmota.
 * @param {string} [topic] MQTT topic (e.g. `tele/tasmota_zigbee/SENSOR`).
 * @returns {void}
 */
const onMessage = (msgJson, topic = '') => {
    console.log('tasmota zigbee message received.');
    const now = Date.now();
    let didApplyTemperature = false;

    for (const [addrRaw, payload] of collectZbInfoEntries(msgJson)) {
        const addr = normalizeZigbeeAddress(addrRaw);
        const room = getZigbeeSensorMap()[addr];
        if (!room) {
            continue;
        }
        const metrics = readPayloadMetrics(payload);
        const temp = payload.Temperature;
        if (typeof temp === 'number') {
            if (applyReading(room, temp, metrics.humidity, now, {
                batteryLevel: metrics.batteryLevel,
                linkQuality: metrics.linkQuality,
            })) {
                didApplyTemperature = true;
            }
        } else {
            applyAuxiliaryMetrics(room, metrics);
        }
    }

    const zbDataField = msgJson.ZbData;
    if (typeof zbDataField === 'string') {
        const parsed = parseZbDataLine(zbDataField);
        if (parsed) {
            const room = getZigbeeSensorMap()[parsed.addr];
            if (room) {
                if (applyReading(room, parsed.temperature, parsed.humidity, now)) {
                    didApplyTemperature = true;
                }
            }
        }
    }

    const entries = collectZbEntries(msgJson);
    const powerSensorAddr = getHvacPowerSensorAddr();
    for (const [addrRaw, payload] of entries) {
        const addr = normalizeZigbeeAddress(addrRaw);
        if (payload === null || typeof payload !== 'object') {
            continue;
        }

        if (powerSensorAddr !== '' && addr === powerSensorAddr) {
            const watts = readTuyaPowerWatts(payload);
            if (watts !== null) {
                void ventAutomation.ingestHvacPowerReading(watts).catch((e) => {
                    console.warn('Vent automation power ingest error:', e);
                });
            }
            continue;
        }

        const room = getZigbeeSensorMap()[addr];
        if (!room) {
            continue;
        }

        const metrics = readPayloadMetrics(payload);
        const tuya = readTuyaEf00Metrics(payload);
        const tempRaw = payload.Temperature;
        const temperature = typeof tempRaw === 'number' ? tempRaw : tuya.temperature;
        const humidity = typeof metrics.humidity === 'number' ? metrics.humidity : tuya.humidity;
        const batteryLevel = typeof metrics.batteryLevel === 'number' ? metrics.batteryLevel : tuya.batteryLevel;
        const auxMetrics = {
            humidity,
            batteryLevel,
            linkQuality: metrics.linkQuality,
        };
        if (typeof temperature !== 'number') {
            applyAuxiliaryMetrics(room, auxMetrics);
            continue;
        }

        if (applyReading(room, temperature, humidity, now, {
            batteryLevel,
            linkQuality: metrics.linkQuality,
        })) {
            didApplyTemperature = true;
        }
    }

    const topicStr = String(topic);
    const isSensorTopic = /\/SENSOR$/i.test(topicStr);
    const isStatResult = /\/RESULT$/i.test(topicStr) && topicStr.includes('tasmota_zigbee');
    if (didApplyTemperature && (isSensorTopic || isStatResult)) {
        void ventAutomation.onSensorTelegram(getReadingsSnapshot()).catch((e) => {
            console.warn('Vent automation error:', e);
        });
    }
};

/** Stagger between `ZbInfo` queries so the coordinator is not flooded. */
const ZB_BOOTSTRAP_STAGGER_MS = 400;

/** Delay before the first `ZbInfo` after MQTT subscribe (broker / stack settle time). */
const ZB_BOOTSTRAP_INITIAL_MS = 200;

/**
 * Attach this controller to the shared MQTT session (subscribe/publish prefix `tasmota_zigbee`).
 * On connect, requests cached sensor details via `ZbInfo` (one publish per short address) so GET `/temperatures` can populate quickly.
 * @param {{ addDevice: (name: string, handler: (msg: Record<string, unknown>) => void, options?: { bootstrap?: (publish: (topic: string, payload?: string) => void) => void }) => void }} mqttController Application MQTT handler.
 * @returns {void}
 */
exports.attachMqtt = (mqttController) => {
    mqttController.addDevice('tasmota_zigbee', onMessage, {
        bootstrap: (publish) => {
            const addrs = Object.keys(getZigbeeSensorMap());
            addrs.forEach((addr, i) => {
                setTimeout(() => {
                    publish('cmnd/tasmota_zigbee/ZbInfo', addr);
                }, ZB_BOOTSTRAP_INITIAL_MS + i * ZB_BOOTSTRAP_STAGGER_MS);
            });
        },
    });
};

/**
 * Return last known temperature, humidity, battery level, and link quality for all mapped sensors.
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

exports.getReadingsSnapshot = getReadingsSnapshot;
