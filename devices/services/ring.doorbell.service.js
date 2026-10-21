const zigbeeControls = require('./zigbee.controls.service');

/**
 * Ring doorbells via ring-mqtt (https://github.com/tsightler/ring-mqtt): each press runs the configured actions.
 * Actions use the same types as Zigbee remotes (bulb / bulbReset / bulbPower / vent).
 *
 * Presses are detected from `<topic>/<location>/camera/<device>/ding/attributes`, keyed on `lastDing` (press time,
 * epoch seconds). The `ding/state` topic isn't used: it stays ON for ring-mqtt's ding duration (180 s by default)
 * and is republished on reconnect, so it doesn't map 1:1 to presses.
 */

/**
 * @typedef {import('./zigbee.controls.service').ControlAction} ControlAction
 * @typedef {{ name: string, ding: ControlAction[] }} DoorbellSpec
 * @typedef {{
 *   enabled: boolean,
 *   topic: string,
 *   doorbells: Record<string, DoorbellSpec>,
 * }} RingConfig
 */

const DEFAULTS = {
    enabled: false,
    topic: 'ring',
};

/** Ignore presses older than this, e.g. the last historical ding that ring-mqtt publishes when it starts. */
const MAX_DING_AGE_MS = 60 * 1000;

/** @type {Record<string, number>} device id → newest `lastDing` seen (epoch seconds) */
const lastDingByDevice = {};

/**
 * @returns {RingConfig}
 */
function getRingConfig() {
    const raw =
        typeof global.appconfig === 'object' && global.appconfig !== null
            ? /** @type {Record<string, unknown>} */ (global.appconfig).ring
            : null;
    const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? /** @type {Record<string, unknown>} */ (raw)
        : {};

    /** @type {Record<string, DoorbellSpec>} */
    const doorbells = {};
    const doorbellsRaw = src.doorbells;
    if (doorbellsRaw !== null && typeof doorbellsRaw === 'object' && !Array.isArray(doorbellsRaw)) {
        for (const [deviceId, specRaw] of Object.entries(
            /** @type {Record<string, unknown>} */ (doorbellsRaw),
        )) {
            if (specRaw === null || typeof specRaw !== 'object' || Array.isArray(specRaw)) {
                continue;
            }
            const spec = /** @type {Record<string, unknown>} */ (specRaw);
            const dingRaw = Array.isArray(spec.ding) ? spec.ding : spec.ding !== undefined ? [spec.ding] : [];
            /** @type {ControlAction[]} */
            const ding = [];
            for (const actionRaw of dingRaw) {
                const action = zigbeeControls.parseAction(actionRaw);
                if (action) {
                    ding.push(action);
                } else {
                    console.warn(`Ring: ignoring invalid ding action for doorbell "${deviceId}":`, actionRaw);
                }
            }
            doorbells[deviceId] = {
                name: typeof spec.name === 'string' && spec.name.trim() !== '' ? spec.name.trim() : deviceId,
                ding,
            };
        }
    }

    return {
        enabled: src.enabled === true,
        topic: typeof src.topic === 'string' && src.topic.trim() !== '' ? src.topic.trim() : DEFAULTS.topic,
        doorbells,
    };
}

/**
 * Handle a ring-mqtt `ding/attributes` payload; runs the doorbell's actions when it reports a new press.
 * @param {string} deviceId
 * @param {Record<string, unknown>} attributes `{ lastDing: <epoch s>, lastDingTime: <ISO> }`
 * @param {number} [nowMs]
 * @returns {boolean} True when the payload was treated as a new press.
 */
function handleDingAttributes(deviceId, attributes, nowMs = Date.now()) {
    const lastDing = Number(attributes.lastDing);
    if (!Number.isFinite(lastDing) || lastDing <= 0) {
        return false;
    }

    const prev = lastDingByDevice[deviceId];
    if (prev !== undefined && lastDing <= prev) {
        return false;
    }
    lastDingByDevice[deviceId] = lastDing;
    if (nowMs - lastDing * 1000 > MAX_DING_AGE_MS) {
        return false;
    }

    const doorbell = getRingConfig().doorbells[deviceId];
    if (!doorbell) {
        console.log(`Ring: press on unconfigured doorbell "${deviceId}" (add it to ring.doorbells to run actions)`);
        return true;
    }

    console.log(`Ring: doorbell "${doorbell.name}" pressed`);
    for (const action of doorbell.ding) {
        void zigbeeControls.executeAction(action).catch((e) => {
            console.warn('Ring doorbell action error:', e);
        });
    }
    return true;
}

module.exports = {
    getRingConfig,
    handleDingAttributes,
};
