const bulbAutomation = require('../services/bulb.automation.service');

/**
 * Zigbee RGB+WW+CW bulbs via the shared Tasmota Zigbee bridge (`tasmota_zigbee`).
 * Fixture-level schedule / override live in {@link bulbAutomation}; this module handles MQTT I/O and HTTP.
 */

/** @type {((topic: string, payload: string) => boolean)|null} */
let sendMqttCommand = null;

/** Stagger between `ZbInfo` queries so the coordinator is not flooded. */
const ZB_BOOTSTRAP_STAGGER_MS = 400;

/** Delay before the first `ZbInfo` after MQTT subscribe. */
const ZB_BOOTSTRAP_INITIAL_MS = 200;

/** Schedule evaluation interval. */
const SCHEDULE_TICK_MS = 60_000;

/**
 * Collect `ZbInfo` blocks from a Tasmota JSON payload.
 * @param {Record<string, unknown>} msgJson
 * @returns {Array<[string, Record<string, unknown>]>}
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
 * Collect `ZbReceived` (or top-level address) device entries.
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
    const known = new Set(bulbAutomation.getAllBulbAddresses());
    for (const [key, value] of Object.entries(msgJson)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }
        const addr = bulbAutomation.normalizeZigbeeAddress(key);
        if (addr !== '' && known.has(addr)) {
            out.push([addr, /** @type {Record<string, unknown>} */ (value)]);
        }
    }
    return out;
}

/**
 * Random integer in `[base - spread, base + spread]`, clamped to `[min, max]`.
 * Used so repeated CT/Hue commands are not identical (TS0505B firmware quirk).
 * @param {number} base
 * @param {number} spread
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function jitterInt(base, spread, min, max) {
    const delta = Math.floor(Math.random() * (2 * spread + 1)) - spread;
    return Math.min(max, Math.max(min, base + delta));
}

/**
 * Build Tasmota `ZbSend` JSON messages for a single bulb command plan.
 * Power (0x0006), colour (0x0300), then Dimmer (0x0008) — colour before level so CT can
 * exit RGB mode on TS0505B before brightness is applied.
 * Hue+Sat must be one `HueSat` field — Tasmota rejects `{"Hue":…,"Sat":…}` with
 * "Only 1 command allowed (2)".
 * Kelvin and red hue are jittered slightly each send so the value is unlikely to match
 * the bulb's last-seen command (suspected firmware no-op when unchanged).
 * @param {string} addr
 * @param {{ power: 'off' } | { power: 'on', brightness: number, colour: number }} plan
 * @returns {string[]} JSON payload strings for `cmnd/tasmota_zigbee/ZbSend`
 */
function buildZbSendPayloads(addr, plan) {
    /** @type {string[]} */
    const payloads = [];
    if (plan.power === 'off') {
        payloads.push(JSON.stringify({ Device: addr, Send: { Power: 'Off' } }));
        return payloads;
    }
    payloads.push(JSON.stringify({ Device: addr, Send: { Power: 'On' } }));
    if (plan.colour === 0) {
        // Red ≈ hue 0; jitter within 0–8 so it still reads as red but differs per send.
        const hue = jitterInt(0, 8, 0, 8);
        payloads.push(JSON.stringify({ Device: addr, Send: { HueSat: `${hue},254` } }));
    } else {
        const kelvin = jitterInt(plan.colour, 50, 2000, 6500);
        payloads.push(JSON.stringify({
            Device: addr,
            Send: { CT: bulbAutomation.kelvinToMireds(kelvin) },
        }));
    }
    payloads.push(JSON.stringify({
        Device: addr,
        Send: { Dimmer: bulbAutomation.brightnessToDimmer(plan.brightness) },
    }));
    return payloads;
}

/**
 * Publish command plans for mismatched bulbs on a fixture.
 * Staggers ZbSend slightly so the coordinator / bulb can finish each cluster command.
 * @param {string} _fixtureId
 * @param {Record<string, { power: 'off' } | { power: 'on', brightness: number, colour: number }>} plans
 * @returns {void}
 */
function pushFixtureCommands(_fixtureId, plans) {
    if (typeof sendMqttCommand !== 'function') {
        console.warn('Bulb automation: MQTT not attached; cannot push commands.');
        return;
    }
    let delayMs = 0;
    for (const [addr, plan] of Object.entries(plans)) {
        for (const payload of buildZbSendPayloads(addr, plan)) {
            const wait = delayMs;
            setTimeout(() => {
                sendMqttCommand('cmnd/tasmota_zigbee/ZbSend', payload);
            }, wait);
            delayMs += 120;
        }
    }
}

/**
 * Handle MQTT JSON from the Zigbee bridge; update bulb deviceState and reconcile on mismatch.
 * @param {Record<string, unknown>} msgJson
 * @param {string} [_topic]
 * @returns {void}
 */
const onMessage = (msgJson, _topic = '') => {
    /** @type {Set<string>} */
    const fixturesToReconcile = new Set();

    for (const [addrRaw, payload] of collectZbInfoEntries(msgJson)) {
        const result = bulbAutomation.applyDeviceReport(addrRaw, payload);
        if (result && result.needsReconcile) {
            fixturesToReconcile.add(result.fixtureId);
        }
    }
    for (const [addrRaw, payload] of collectZbReceivedEntries(msgJson)) {
        const result = bulbAutomation.applyDeviceReport(addrRaw, payload);
        if (result && result.needsReconcile) {
            fixturesToReconcile.add(result.fixtureId);
        }
    }

    for (const fixtureId of fixturesToReconcile) {
        bulbAutomation.reconcileFixture(fixtureId);
    }
};

/**
 * Attach to the shared MQTT session (same topic root as temperature sensors).
 * @param {{
 *   addDevice: (name: string, handler: (msg: Record<string, unknown>, topic?: string) => void, options?: { bootstrap?: (publish: (topic: string, payload?: string) => void) => void }) => void,
 *   getCommandFunction: () => (topic: string, payload: string) => boolean,
 * }} mqttController
 * @returns {void}
 */
exports.attachMqtt = (mqttController) => {
    sendMqttCommand = mqttController.getCommandFunction();
    bulbAutomation.setPushCommandsFn(pushFixtureCommands);
    bulbAutomation.ensureFixtureStates();
    bulbAutomation.tickSchedules();

    mqttController.addDevice('tasmota_zigbee', onMessage, {
        bootstrap: (publish) => {
            const addrs = bulbAutomation.getAllBulbAddresses();
            addrs.forEach((addr, i) => {
                setTimeout(() => {
                    publish('cmnd/tasmota_zigbee/ZbInfo', addr);
                }, ZB_BOOTSTRAP_INITIAL_MS + i * ZB_BOOTSTRAP_STAGGER_MS);
            });
            // After bootstrap stagger, force-push scheduled desired (devices may be offline).
            setTimeout(() => {
                for (const snap of bulbAutomation.getAllFixtureSnapshots()) {
                    bulbAutomation.reconcileFixture(snap.fixtureId, { force: true });
                }
            }, ZB_BOOTSTRAP_INITIAL_MS + addrs.length * ZB_BOOTSTRAP_STAGGER_MS + 500);
        },
    });

    setInterval(() => {
        try {
            bulbAutomation.onScheduleTick();
        } catch (e) {
            console.warn('Bulb schedule tick error:', e);
        }
    }, SCHEDULE_TICK_MS);
};

/**
 * GET /bulbs — all fixtures (reconcile-on-read).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
exports.listFixtures = (req, res) => {
    for (const snap of bulbAutomation.getAllFixtureSnapshots()) {
        bulbAutomation.reconcileFixture(snap.fixtureId);
    }
    res.status(200).send({
        device: 'tasmota_zigbee',
        fixtures: bulbAutomation.getAllFixtureSnapshots(),
    });
};

/**
 * GET /bulbs/:fixtureId — one fixture (reconcile-on-read).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
exports.getFixture = (req, res) => {
    const fixtureId = String(req.params.fixtureId || '');
    const snap = bulbAutomation.getFixtureSnapshot(fixtureId);
    if (!snap) {
        res.status(404).send({ error: 'unknown_fixture' });
        return;
    }
    bulbAutomation.reconcileFixture(fixtureId);
    res.status(200).send(bulbAutomation.getFixtureSnapshot(fixtureId));
};

/**
 * POST /bulbs/:fixtureId — set manual override and push immediately.
 * Body: `{ brightness: 0–100, colour: 0 | kelvin }`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
exports.setFixture = (req, res) => {
    const fixtureId = String(req.params.fixtureId || '');
    if (!bulbAutomation.getFixtureSnapshot(fixtureId)) {
        res.status(404).send({ error: 'unknown_fixture' });
        return;
    }

    const body = req.body !== null && typeof req.body === 'object' ? req.body : {};
    const brightness = Number(body.brightness);
    const colour = Number(body.colour);

    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
        res.status(400).send({ error: 'invalid_brightness', message: 'brightness must be an integer 0–100' });
        return;
    }
    if (!Number.isInteger(colour) || colour < 0) {
        res.status(400).send({ error: 'invalid_colour', message: 'colour must be 0 (red) or a positive Kelvin value' });
        return;
    }
    if (colour !== 0 && (colour < 2000 || colour > 6500)) {
        res.status(400).send({ error: 'invalid_colour', message: 'Kelvin colour must be 2000–6500 (or 0 for red)' });
        return;
    }

    bulbAutomation.setOverride(fixtureId, brightness, colour);
    bulbAutomation.reconcileFixture(fixtureId, { force: true });
    res.status(200).send(bulbAutomation.getFixtureSnapshot(fixtureId));
};

/**
 * POST /bulbs/:fixtureId/reset — clear override and push schedule `targetState`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
exports.resetFixture = (req, res) => {
    const fixtureId = String(req.params.fixtureId || '');
    if (!bulbAutomation.clearOverride(fixtureId)) {
        res.status(404).send({ error: 'unknown_fixture' });
        return;
    }
    bulbAutomation.reconcileFixture(fixtureId, { force: true });
    res.status(200).send(bulbAutomation.getFixtureSnapshot(fixtureId));
};
