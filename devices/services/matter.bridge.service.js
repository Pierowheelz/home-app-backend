const path = require('path');
const { Environment, ServerNode, Endpoint, VendorId, Logger } = require('@matter/main');
const { AggregatorEndpoint } = require('@matter/main/endpoints');
const {
    ColorTemperatureLightDevice,
    HumiditySensorDevice,
    OnOffPlugInUnitDevice,
    TemperatureSensorDevice,
    WindowCoveringDevice,
} = require('@matter/main/devices');
const {
    BridgedDeviceBasicInformationServer,
    OnOffServer,
    RelativeHumidityMeasurementServer,
    WindowCoveringServer,
} = require('@matter/main/behaviors');
const { ColorControl, WindowCovering } = require('@matter/main/clusters');
const { StatusResponseError, StatusCode } = require('@matter/main/types');
const { hasRemoteActor } = require('@matter/main/protocol');

const bulbAutomation = require('./bulb.automation.service');
const { version: appVersion } = require('../../package.json');

/**
 * Matter bridge exposing local devices to Matter controllers (Google Home via a Nest hub).
 *
 * Each configured device becomes a bridged endpoint under one aggregator:
 * - bulb fixtures → Color Temperature Light (on/off, brightness, white colour temperature)
 * - speakers → On/Off Plug-in Unit
 * - blinds → Window Covering (open / close / stop; no position feedback, so position is assumed)
 * - server → On/Off Plug-in Unit that only accepts "on" (off is rejected)
 * - room sensors → Temperature Sensor + Humidity Sensor (one endpoint per room)
 *
 * Controller → device: remote attribute changes / commands call the existing controllers & services.
 * Device → controller: {@link syncAll} polls local state and writes it to the endpoints.
 */

const DEFAULTS = {
    enabled: false,
    port: 5540,
    passcode: 20202021,
    discriminator: 3840,
    vendorId: 0xFFF1,
    productId: 0x8000,
    bridgeName: 'Home Controller',
    logLevel: 'notice',
};

/** Passcodes the Matter spec forbids. */
const INVALID_PASSCODES = [
    0, 11111111, 22222222, 33333333, 44444444, 55555555,
    66666666, 77777777, 88888888, 99999999, 12345678, 87654321,
];

/** How often local state is pushed to Matter endpoints. */
const SYNC_INTERVAL_MS = 2000;

/** After a controller command, skip syncing that device so a stale MQTT state can't flip it back. */
const SYNC_HOLD_AFTER_COMMAND_MS = 5000;

/** Remote light changes arrive as several attribute changes; apply them together. */
const LIGHT_APPLY_DEBOUNCE_MS = 100;

/** Colour temperature range exposed to controllers (Kelvin). Matches POST /bulbs validation. */
const KELVIN_MIN = 2000;
const KELVIN_MAX = 6500;
const MIREDS_MIN = Math.round(1_000_000 / KELVIN_MAX);
const MIREDS_MAX = Math.round(1_000_000 / KELVIN_MIN);

/** Room sensors with no reading for this long show as offline (unreachable) in controllers. */
const SENSOR_STALE_MS = 60 * 60 * 1000;

/** Blinds: Matter lift position 0 = fully open, 10000 = fully closed. */
const LIFT_OPEN = 0;
const LIFT_CLOSED = 10000;

/** @type {ServerNode|null} */
let serverNode = null;

/** @type {Array<{ id: string, sync: () => Promise<void> }>} */
const bridgedDevices = [];

/** @type {Record<string, number>} endpoint id → epoch ms until which sync is skipped */
const syncHoldUntil = {};

/**
 * @returns {typeof DEFAULTS & {
 *   storagePath: string,
 *   networkInterface: string,
 *   bulbFixtures: Record<string, string>,
 *   roomSensors: Record<string, string>,
 *   speakers: string,
 *   blinds: string,
 *   server: string,
 * }}
 */
function getMatterConfig() {
    const raw = global.appconfig?.matter;
    const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? /** @type {Record<string, unknown>} */ (raw)
        : {};
    const int = (v, def) => (Number.isInteger(v) ? /** @type {number} */ (v) : def);
    const str = (v) => (typeof v === 'string' ? v.trim() : '');

    /**
     * @param {unknown} v `{ id: "Display name" }`
     * @returns {Record<string, string>}
     */
    const nameMap = (v) => {
        /** @type {Record<string, string>} */
        const out = {};
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            for (const [id, name] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
                if (str(name) !== '') {
                    out[id] = str(name);
                }
            }
        }
        return out;
    };

    return {
        enabled: r.enabled === true,
        port: int(r.port, DEFAULTS.port),
        passcode: int(r.passcode, DEFAULTS.passcode),
        discriminator: int(r.discriminator, DEFAULTS.discriminator),
        vendorId: int(r.vendorId, DEFAULTS.vendorId),
        productId: int(r.productId, DEFAULTS.productId),
        bridgeName: str(r.bridgeName) || DEFAULTS.bridgeName,
        logLevel: str(r.logLevel) || DEFAULTS.logLevel,
        storagePath: str(r.storagePath),
        networkInterface: str(r.networkInterface),
        bulbFixtures: nameMap(r.bulbFixtures),
        roomSensors: nameMap(r.roomSensors),
        speakers: str(r.speakers),
        blinds: str(r.blinds),
        server: str(r.server),
    };
}

/**
 * @param {string} s
 * @returns {string} Endpoint-id-safe slug.
 */
function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Bridged device identity shown to controllers (nodeLabel is the default name in Google Home).
 * @param {string} id
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function bridgedInfo(id, name) {
    return {
        nodeLabel: name.slice(0, 32),
        productName: name.slice(0, 32),
        productLabel: name.slice(0, 64),
        serialNumber: id.slice(0, 32),
        uniqueId: ('home-app-' + id).slice(0, 32),
        reachable: true,
    };
}

/**
 * @param {string} id
 * @returns {void}
 */
function holdSync(id) {
    syncHoldUntil[id] = Date.now() + SYNC_HOLD_AFTER_COMMAND_MS;
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function isSyncHeld(id) {
    return (syncHoldUntil[id] ?? 0) > Date.now();
}

/**
 * @param {string} message
 * @returns {StatusResponseError}
 */
function failure(message) {
    return new StatusResponseError(message, StatusCode.Failure);
}

/**
 * Matter level (1–254) → fixture brightness percent (1–100).
 * @param {number} level
 * @returns {number}
 */
function levelToBrightness(level) {
    return Math.max(1, Math.min(100, bulbAutomation.dimmerToBrightness(level)));
}

/**
 * Fixture brightness percent → Matter level (1–254).
 * @param {number} brightness
 * @returns {number}
 */
function brightnessToLevel(brightness) {
    return Math.max(1, Math.min(254, bulbAutomation.brightnessToDimmer(brightness)));
}

/**
 * Matter mireds → Kelvin rounded to 50 K within the supported range.
 * @param {number} mireds
 * @returns {number}
 */
function miredsToKelvin(mireds) {
    const k = bulbAutomation.miredsToKelvin(mireds);
    return Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, Math.round(k / 50) * 50));
}

/**
 * Brightness / colour currently in effect for a fixture: desired state, else first bulb report.
 * @param {ReturnType<typeof bulbAutomation.getFixtureSnapshot>} snap
 * @returns {{ brightness: number|null, colour: number|null }}
 */
function fixtureLightState(snap) {
    if (snap.desiredState) {
        return { brightness: snap.desiredState.brightness, colour: snap.desiredState.colour };
    }
    for (const ds of Object.values(snap.deviceStateByBulb)) {
        if (ds.brightness !== null) {
            return { brightness: ds.brightness, colour: ds.colour };
        }
    }
    return { brightness: null, colour: null };
}

/**
 * Bulb fixture → Color Temperature Light.
 * Remote on/off → `setPower`; remote brightness / colour temperature → manual override (same as POST /bulbs/:id).
 * @param {Endpoint} aggregator
 * @param {string} fixtureId
 * @param {string} name
 * @returns {Promise<void>}
 */
async function addBulbFixture(aggregator, fixtureId, name) {
    if (!bulbAutomation.getFixtureSnapshot(fixtureId)) {
        console.warn(`Matter: bulb fixture "${fixtureId}" is not in bulbAutomation.fixtures; skipping.`);
        return;
    }
    const id = 'bulb-' + slug(fixtureId);
    const endpoint = new Endpoint(ColorTemperatureLightDevice.with(BridgedDeviceBasicInformationServer), {
        id,
        bridgedDeviceBasicInformation: bridgedInfo(id, name),
        onOff: { onOff: false },
        levelControl: { currentLevel: 254, minLevel: 1, maxLevel: 254 },
        colorControl: {
            colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
            enhancedColorMode: ColorControl.EnhancedColorMode.ColorTemperatureMireds,
            colorTemperatureMireds: 250,
            colorTempPhysicalMinMireds: MIREDS_MIN,
            colorTempPhysicalMaxMireds: MIREDS_MAX,
            coupleColorTempToLevelMinMireds: MIREDS_MIN,
            startUpColorTemperatureMireds: null,
        },
    });
    await aggregator.add(endpoint);

    /** @type {{ power?: boolean, level?: number, mireds?: number }} */
    let pending = {};
    /** @type {NodeJS.Timeout|null} */
    let applyTimer = null;

    const applyPending = () => {
        applyTimer = null;
        const change = pending;
        pending = {};
        const snap = bulbAutomation.getFixtureSnapshot(fixtureId);
        if (!snap) {
            return;
        }
        if (change.power === false) {
            console.log(`Matter: ${fixtureId} → off`);
            bulbAutomation.setPower(fixtureId, 'off');
        } else if (change.level !== undefined || change.mireds !== undefined) {
            const current = fixtureLightState(snap);
            const brightness = change.level !== undefined
                ? levelToBrightness(change.level)
                : current.brightness ?? levelToBrightness(endpoint.state.levelControl.currentLevel ?? 254);
            // Keep red (colour 0) when only brightness changes.
            const colour = change.mireds !== undefined
                ? miredsToKelvin(change.mireds)
                : current.colour ?? miredsToKelvin(endpoint.state.colorControl.colorTemperatureMireds);
            console.log(`Matter: ${fixtureId} → brightness ${brightness}, colour ${colour}`);
            bulbAutomation.setOverride(fixtureId, brightness, colour);
        } else if (change.power === true) {
            console.log(`Matter: ${fixtureId} → on`);
            bulbAutomation.setPower(fixtureId, 'on');
        } else {
            return;
        }
        bulbAutomation.reconcileFixture(fixtureId, { force: true });
    };

    /**
     * @param {Partial<typeof pending>} change
     * @param {unknown} context
     */
    const queueRemote = (change, context) => {
        if (!hasRemoteActor(/** @type {any} */ (context))) {
            return; // our own sync write
        }
        Object.assign(pending, change);
        if (applyTimer === null) {
            applyTimer = setTimeout(applyPending, LIGHT_APPLY_DEBOUNCE_MS);
        }
    };

    endpoint.events.onOff.onOff$Changed.on((value, _old, context) => queueRemote({ power: value }, context));
    endpoint.events.levelControl.currentLevel$Changed.on((value, _old, context) => {
        if (value !== null) {
            queueRemote({ level: value }, context);
        }
    });
    endpoint.events.colorControl.colorTemperatureMireds$Changed.on(
        (value, _old, context) => queueRemote({ mireds: value }, context),
    );

    bridgedDevices.push({
        id,
        sync: async () => {
            const snap = bulbAutomation.getFixtureSnapshot(fixtureId);
            if (!snap || applyTimer !== null) {
                return;
            }
            const { brightness, colour } = fixtureLightState(snap);
            const state = endpoint.state;
            /** @type {Record<string, Record<string, unknown>>} */
            const update = {};
            const onOff = snap.power === 'on';
            if (state.onOff.onOff !== onOff) {
                update.onOff = { onOff };
            }
            if (brightness !== null && levelToBrightness(state.levelControl.currentLevel ?? 254) !== Math.max(1, brightness)) {
                update.levelControl = { currentLevel: brightnessToLevel(brightness) };
            }
            // colour 0 is red: not representable as colour temperature, so leave the CT attribute alone.
            if (colour !== null && colour > 0
                && Math.abs(miredsToKelvin(state.colorControl.colorTemperatureMireds) - colour) > 100) {
                const mireds = Math.round(1_000_000 / Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, colour)));
                update.colorControl = { colorTemperatureMireds: mireds };
            }
            if (Object.keys(update).length > 0) {
                await endpoint.set(update);
            }
        },
    });
}

/**
 * Speakers → On/Off Plug-in Unit.
 * @param {Endpoint} aggregator
 * @param {string} name
 * @returns {Promise<void>}
 */
async function addSpeakers(aggregator, name) {
    const speakers = require('../controllers/speakers.controller');
    const id = 'speakers';

    class SpeakersOnOffServer extends OnOffServer {
        on() {
            console.log('Matter: speakers → on');
            if (!speakers.setPower(true)) {
                throw failure('MQTT unavailable');
            }
            holdSync(id);
            return super.on();
        }

        off() {
            console.log('Matter: speakers → off');
            if (!speakers.setPower(false)) {
                throw failure('MQTT unavailable');
            }
            holdSync(id);
            return super.off();
        }
    }

    const endpoint = new Endpoint(OnOffPlugInUnitDevice.with(SpeakersOnOffServer, BridgedDeviceBasicInformationServer), {
        id,
        bridgedDeviceBasicInformation: bridgedInfo(id, name),
        onOff: { onOff: speakers.getPowerState() === 'on' },
    });
    await aggregator.add(endpoint);

    bridgedDevices.push({
        id,
        sync: async () => {
            const state = speakers.getPowerState();
            if (state !== 'unknown' && endpoint.state.onOff.onOff !== (state === 'on')) {
                await endpoint.set({ onOff: { onOff: state === 'on' } });
            }
        },
    });
}

/**
 * Server → On/Off Plug-in Unit that only turns on. Off is rejected so "turn off everything" can't shut it down.
 * @param {Endpoint} aggregator
 * @param {string} name
 * @returns {Promise<void>}
 */
async function addServer(aggregator, name) {
    const server = require('../controllers/server.controller');
    const id = 'server';

    class ServerOnOffServer extends OnOffServer {
        on() {
            console.log('Matter: server → on');
            const boot = server.powerOn();
            if (!boot.ok && boot.error !== 'already_on') {
                throw failure(boot.error);
            }
            if (!boot.ok && server.getPowerState() === 'unknown') {
                throw failure('Server power state unknown');
            }
            holdSync(id);
            return super.on();
        }

        off() {
            console.log('Matter: server → off rejected (on-only device)');
            throw new StatusResponseError('Server can only be turned on', StatusCode.UnsupportedAccess);
        }
    }

    const endpoint = new Endpoint(OnOffPlugInUnitDevice.with(ServerOnOffServer, BridgedDeviceBasicInformationServer), {
        id,
        bridgedDeviceBasicInformation: bridgedInfo(id, name),
        onOff: { onOff: server.getPowerState() === 'on' },
    });
    await aggregator.add(endpoint);

    bridgedDevices.push({
        id,
        sync: async () => {
            const state = server.getPowerState();
            if (state !== 'unknown' && endpoint.state.onOff.onOff !== (state === 'on')) {
                await endpoint.set({ onOff: { onOff: state === 'on' } });
            }
        },
    });
}

/**
 * Blinds → Window Covering (lift). The controller has no position feedback, so after each command the position is
 * assumed to be fully open / closed. Partial targets round to the nearest end.
 * @param {Endpoint} aggregator
 * @param {string} name
 * @returns {Promise<void>}
 */
async function addBlinds(aggregator, name) {
    const blinds = require('../controllers/blinds.controller');
    const id = 'blinds';

    class BlindsServer extends WindowCoveringServer.with('Lift', 'PositionAwareLift') {
        handleMovement(type, _reversed, direction, targetPercent100ths) {
            if (type !== 0 /* Lift */) {
                return;
            }
            const close = targetPercent100ths !== undefined
                ? targetPercent100ths >= (LIFT_OPEN + LIFT_CLOSED) / 2
                : direction === 1 /* Close */;
            const final = close ? LIFT_CLOSED : LIFT_OPEN;
            this.state.targetPositionLiftPercent100ths = final;
            this.state.currentPositionLiftPercent100ths = final;
            // No motion feedback: report stopped rather than leaving "Opening"/"Closing" set.
            const stopped = WindowCovering.MovementStatus.Stopped;
            this.state.operationalStatus = { global: stopped, lift: stopped, tilt: stopped };
            return blinds.sendAction(close ? 'close' : 'open').then((ok) => {
                if (!ok) {
                    console.warn('Matter: blinds command failed');
                }
            });
        }

        handleStopMovement() {
            blinds.sendAction('stop');
            return super.handleStopMovement();
        }
    }

    const endpoint = new Endpoint(WindowCoveringDevice.with(BlindsServer, BridgedDeviceBasicInformationServer), {
        id,
        bridgedDeviceBasicInformation: bridgedInfo(id, name),
        windowCovering: {
            type: WindowCovering.WindowCoveringType.Rollershade,
            endProductType: WindowCovering.EndProductType.RollerShade,
        },
    });
    await aggregator.add(endpoint);

    // Nothing to sync: the controller has no state feedback.
    bridgedDevices.push({ id, sync: async () => {} });
}

/**
 * Room temperature / humidity (merged Zigbee + Wi-Fi + redundant sensors, as on the dashboard) → one endpoint
 * typed as both Temperature Sensor and Humidity Sensor. Read-only; marked unreachable when readings go stale.
 * @param {Endpoint} aggregator
 * @param {string} room Room label from `ventAutomation.zigbeeSensorMap`.
 * @param {string} name
 * @returns {Promise<void>}
 */
async function addRoomSensor(aggregator, room, name) {
    const ventAutomation = require('./vent.automation.service');
    const id = 'sensor-' + slug(room);
    const endpoint = new Endpoint(
        TemperatureSensorDevice.with(RelativeHumidityMeasurementServer, BridgedDeviceBasicInformationServer),
        {
            id,
            bridgedDeviceBasicInformation: bridgedInfo(id, name),
            descriptor: {
                deviceTypeList: [
                    { deviceType: TemperatureSensorDevice.deviceType, revision: TemperatureSensorDevice.deviceRevision },
                    { deviceType: HumiditySensorDevice.deviceType, revision: HumiditySensorDevice.deviceRevision },
                ],
            },
            temperatureMeasurement: { measuredValue: null, minMeasuredValue: -4000, maxMeasuredValue: 8000 },
            relativeHumidityMeasurement: { measuredValue: null, minMeasuredValue: 0, maxMeasuredValue: 10000 },
        },
    );
    await aggregator.add(endpoint);

    bridgedDevices.push({
        id,
        sync: async () => {
            const row = ventAutomation.getRoomReadings()[room];
            const fresh = row !== undefined && row.lastUpdateMs !== null && Date.now() - row.lastUpdateMs < SENSOR_STALE_MS;
            // Matter units: 0.01 °C and 0.01 %RH.
            const temperature = fresh && row.temperature !== null ? Math.round(row.temperature * 100) : null;
            const humidity = fresh && row.humidity !== null
                ? Math.max(0, Math.min(10000, Math.round(row.humidity * 100)))
                : null;
            const state = endpoint.state;
            /** @type {Record<string, Record<string, unknown>>} */
            const update = {};
            if (state.temperatureMeasurement.measuredValue !== temperature) {
                update.temperatureMeasurement = { measuredValue: temperature };
            }
            if (state.relativeHumidityMeasurement.measuredValue !== humidity) {
                update.relativeHumidityMeasurement = { measuredValue: humidity };
            }
            if (state.bridgedDeviceBasicInformation.reachable !== fresh) {
                update.bridgedDeviceBasicInformation = { reachable: fresh };
            }
            if (Object.keys(update).length > 0) {
                await endpoint.set(update);
            }
        },
    });
}

/**
 * Push local state into every bridged endpoint.
 * @returns {Promise<void>}
 */
async function syncAll() {
    if (!serverNode?.lifecycle.isOnline) {
        return; // starting up or shutting down
    }
    for (const device of bridgedDevices) {
        if (isSyncHeld(device.id)) {
            continue;
        }
        try {
            await device.sync();
        } catch (e) {
            console.warn(`Matter: sync failed for ${device.id}:`, e instanceof Error ? e.message : e);
        }
    }
}

/**
 * Start the bridge when `appconfig.matter.enabled` is true. Logs pairing codes until commissioned.
 * @param {{ isDocker?: boolean }} [opts]
 * @returns {Promise<void>}
 */
async function start(opts = {}) {
    const cfg = getMatterConfig();
    if (!cfg.enabled) {
        return;
    }
    if (INVALID_PASSCODES.includes(cfg.passcode) || cfg.passcode < 1 || cfg.passcode > 99999998) {
        console.error('Matter: invalid passcode in config (must be 1–99999998 and not a trivial sequence). Bridge not started.');
        return;
    }

    Logger.level = cfg.logLevel;
    const storagePath = cfg.storagePath
        || (opts.isDocker ? '/config/matter' : path.join(__dirname, '..', '..', 'matter-storage'));
    const env = Environment.default;
    env.vars.set('path.root', storagePath);
    env.vars.set('storage.path', storagePath);
    if (cfg.networkInterface !== '') {
        env.vars.set('mdns.networkInterface', cfg.networkInterface);
    }
    // matter.js would trap SIGINT/SIGTERM and only stop itself, leaving Express / MQTT running. Handle them here.
    env.vars.set('runtime.signals', false);

    serverNode = await ServerNode.create({
        id: 'home-app-bridge',
        network: { port: cfg.port },
        commissioning: { passcode: cfg.passcode, discriminator: cfg.discriminator },
        productDescription: { name: cfg.bridgeName, deviceType: AggregatorEndpoint.deviceType },
        basicInformation: {
            vendorName: 'Home App',
            vendorId: VendorId(cfg.vendorId),
            nodeLabel: cfg.bridgeName.slice(0, 32),
            productName: 'Matter Bridge',
            productLabel: 'Matter Bridge',
            productId: cfg.productId,
            serialNumber: 'bridge-0001',
            uniqueId: 'home-app-bridge',
            hardwareVersion: 1,
            softwareVersion: 1,
            softwareVersionString: appVersion,
        },
    });

    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await serverNode.add(aggregator);

    for (const [fixtureId, name] of Object.entries(cfg.bulbFixtures)) {
        await addBulbFixture(aggregator, fixtureId, name);
    }
    const devices = global.appconfig.devices || {};
    if (cfg.speakers !== '' && devices.speakers) {
        await addSpeakers(aggregator, cfg.speakers);
    }
    if (cfg.blinds !== '' && devices.blinds) {
        await addBlinds(aggregator, cfg.blinds);
    }
    if (cfg.server !== '' && devices.server) {
        await addServer(aggregator, cfg.server);
    }
    for (const [room, name] of Object.entries(cfg.roomSensors)) {
        await addRoomSensor(aggregator, room, name);
    }

    await serverNode.start();
    console.log(`Matter: bridge "${cfg.bridgeName}" running on UDP ${cfg.port} with ${aggregator.parts.size} device(s); storage ${storagePath}`);
    logPairingInfo();

    setInterval(() => {
        syncAll();
    }, SYNC_INTERVAL_MS);

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

/**
 * Close the bridge (flushes pairing storage) then exit, as Node would by default on SIGINT / SIGTERM.
 * @param {NodeJS.Signals} signal
 * @returns {Promise<void>}
 */
async function shutdown(signal) {
    console.log(`Matter: ${signal} received; closing bridge.`);
    setTimeout(() => process.exit(0), 5000).unref();
    try {
        await serverNode?.close();
    } catch (e) {
        console.warn('Matter: error closing bridge:', e instanceof Error ? e.message : e);
    }
    process.exit(0);
}

/**
 * @returns {{ commissioned: boolean, manualPairingCode: string, qrPairingCode: string } | null}
 */
function getPairingInfo() {
    if (!serverNode) {
        return null;
    }
    const { qrPairingCode, manualPairingCode } = serverNode.state.commissioning.pairingCodes;
    return {
        commissioned: serverNode.lifecycle.isCommissioned,
        manualPairingCode,
        qrPairingCode,
    };
}

/**
 * @returns {void}
 */
function logPairingInfo() {
    const info = getPairingInfo();
    if (!info) {
        return;
    }
    if (info.commissioned) {
        console.log('Matter: bridge already paired. Use the Google Home app to share it with another controller.');
        return;
    }
    // matter.js also logs the QR code itself at "notice" level.
    console.log(`Matter: not paired yet. In Google Home: Add device → Matter-enabled device → manual code ${info.manualPairingCode}, or scan:`);
    console.log(`Matter: https://project-chip.github.io/connectedhomeip/qrcode.html?data=${encodeURIComponent(info.qrPairingCode)}`);
}

/**
 * GET /matter — bridge status and pairing codes.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
function getStatus(req, res) {
    const info = getPairingInfo();
    if (!info) {
        res.status(404).send({ error: 'matter_disabled' });
        return;
    }
    res.status(200).send({
        ...info,
        devices: bridgedDevices.map((d) => d.id),
    });
}

module.exports = {
    getMatterConfig,
    start,
    getPairingInfo,
    getStatus,
};
