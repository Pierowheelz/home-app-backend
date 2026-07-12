const zigbeeControls = require('../services/zigbee.controls.service');

/**
 * Zigbee button / dimmer remotes via the shared Tasmota Zigbee bridge (`tasmota_zigbee`).
 * Config-driven actions live in {@link zigbeeControls}; this module only fans MQTT into the service.
 */

/**
 * Collect `ZbReceived` (or top-level address) entries for configured remotes.
 * @param {Record<string, unknown>} msgJson
 * @returns {Array<[string, Record<string, unknown>]>}
 */
function collectZbReceivedEntries(msgJson) {
    const zb = msgJson.ZbReceived;
    if (zb !== null && typeof zb === 'object' && !Array.isArray(zb)) {
        return Object.entries(/** @type {Record<string, Record<string, unknown>>} */ (zb));
    }
    /** @type {Array<[string, Record<string, unknown>]>} */
    const out = [];
    const known = new Set(zigbeeControls.getAllControlAddresses());
    for (const [key, value] of Object.entries(msgJson)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }
        const addr = zigbeeControls.normalizeZigbeeAddress(key);
        if (addr !== '' && known.has(addr)) {
            out.push([addr, /** @type {Record<string, unknown>} */ (value)]);
        }
    }
    return out;
}

/**
 * MQTT message handler for `tasmota_zigbee`.
 * @param {Record<string, unknown>} msgJson
 * @param {string} _topic
 * @returns {void}
 */
function onMessage(msgJson, _topic) {
    for (const [addrRaw, payload] of collectZbReceivedEntries(msgJson)) {
        try {
            zigbeeControls.handleDeviceReport(addrRaw, payload);
        } catch (e) {
            console.warn('Zigbee controls handler error:', e);
        }
    }
}

/**
 * Register on the shared MQTT session (same bridge name as sensors/bulbs).
 * @param {{
 *   addDevice: (
 *     name: string,
 *     onMessage: (msgJson: Record<string, unknown>, topic: string) => void,
 *     opts?: { bootstrap?: (publish: (topic: string, payload?: string) => void) => void }
 *   ) => void,
 * }} mqttController
 * @returns {void}
 */
exports.attachMqtt = (mqttController) => {
    mqttController.addDevice('tasmota_zigbee', onMessage);
};
