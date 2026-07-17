const bulbAutomation = require('./bulb.automation.service');
const ventAutomation = require('./vent.automation.service');
const ventClient = require('../lib/vent.client');

/**
 * Config-driven Zigbee remotes: button presses run bulb/vent/bulbReset actions;
 * dimmer turns adjust fixture brightness / colour temp (including red below 2700K).
 */

/**
 * @typedef {{ type: 'bulb', fixtureId: string, brightness: number, colour: number }} BulbAction
 * @typedef {{ type: 'bulbReset', fixtureId: string }} BulbResetAction
 * @typedef {{ type: 'vent', percent: number, motorId?: number, room?: string }} VentAction
 * `motorId` on vent actions is the flat external id (same namespace as `POST /vents/:motorId`).
 * @typedef {BulbAction|BulbResetAction|VentAction} ControlAction
 * @typedef {'button'|'dimmer'} ControlDeviceType
 * @typedef {{
 *   type: ControlDeviceType,
 *   fixtureId?: string,
 *   single?: ControlAction,
 *   double?: ControlAction,
 *   long?: ControlAction,
 * }} ControlDeviceSpec
 * @typedef {{
 *   enabled: boolean,
 *   dimmerStepPerPercent: number,
 *   colorTempFullScaleSteps: number,
 *   devices: Record<string, ControlDeviceSpec>,
 * }} ZigbeeControlsConfig
 * @typedef {{ brightness: number, colour: number }} DesiredSnapshot
 * @typedef {{
 *   brightnessDeltaSteps: number,
 *   colorTempDeltaSteps: number,
 *   baseline: DesiredSnapshot,
 *   timer: ReturnType<typeof setTimeout>|null,
 * }} PendingDimmerBurst
 */

const DEFAULTS = {
    enabled: true,
    dimmerStepPerPercent: 10,
    colorTempFullScaleSteps: 1000,
};

/** Red band width on the virtual colour axis (maps to `colour: 0`). */
const RED_AXIS_WIDTH = 10;

/** Kelvin white range on the virtual colour axis. */
const KELVIN_MIN = 2700;
const KELVIN_MAX = 6000;

/** Virtual axis max: red 0–10 then Kelvin 2700–6000. */
const COLOUR_AXIS_MAX = RED_AXIS_WIDTH + (KELVIN_MAX - KELVIN_MIN);

/** Coalesce rapid DimmerStep / ColorTempStep telegrams into one override push. */
const DIMMER_COALESCE_MS = 120;

/** @type {Record<string, PendingDimmerBurst>} */
const pendingByAddr = {};

/**
 * Normalize Zigbee short address to `0xABCD` form.
 * @param {string} addr
 * @returns {string}
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
 * @returns {ZigbeeControlsConfig}
 */
function getZigbeeControlsConfig() {
    const raw =
        typeof global.appconfig === 'object' && global.appconfig !== null
            ? /** @type {Record<string, unknown>} */ (global.appconfig).zigbeeControls
            : null;
    const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? /** @type {Record<string, unknown>} */ (raw)
        : {};

    const dimmerStepPerPercent = Number(src.dimmerStepPerPercent);
    const colorTempFullScaleSteps = Number(src.colorTempFullScaleSteps);

    /** @type {Record<string, ControlDeviceSpec>} */
    const devices = {};
    const devicesRaw = src.devices;
    if (devicesRaw !== null && typeof devicesRaw === 'object' && !Array.isArray(devicesRaw)) {
        for (const [addrRaw, specRaw] of Object.entries(
            /** @type {Record<string, unknown>} */ (devicesRaw),
        )) {
            const addr = normalizeZigbeeAddress(addrRaw);
            if (addr === '' || specRaw === null || typeof specRaw !== 'object' || Array.isArray(specRaw)) {
                continue;
            }
            const parsed = parseDeviceSpec(/** @type {Record<string, unknown>} */ (specRaw));
            if (parsed) {
                devices[addr] = parsed;
            }
        }
    }

    return {
        enabled: src.enabled !== false,
        dimmerStepPerPercent:
            Number.isFinite(dimmerStepPerPercent) && dimmerStepPerPercent > 0
                ? dimmerStepPerPercent
                : DEFAULTS.dimmerStepPerPercent,
        colorTempFullScaleSteps:
            Number.isFinite(colorTempFullScaleSteps) && colorTempFullScaleSteps > 0
                ? colorTempFullScaleSteps
                : DEFAULTS.colorTempFullScaleSteps,
        devices,
    };
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {ControlDeviceSpec|null}
 */
function parseDeviceSpec(raw) {
    const type = raw.type === 'dimmer' ? 'dimmer' : raw.type === 'button' ? 'button' : null;
    if (!type) {
        return null;
    }
    /** @type {ControlDeviceSpec} */
    const out = { type };
    if (type === 'dimmer' && typeof raw.fixtureId === 'string' && raw.fixtureId.trim() !== '') {
        out.fixtureId = raw.fixtureId.trim();
    }
    for (const key of /** @type {const} */ (['single', 'double', 'long'])) {
        const action = parseAction(raw[key]);
        if (action) {
            out[key] = action;
        }
    }
    return out;
}

/**
 * @param {unknown} raw
 * @returns {ControlAction|null}
 */
function parseAction(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (o.type === 'bulb') {
        const fixtureId = typeof o.fixtureId === 'string' ? o.fixtureId.trim() : '';
        const brightness = Number(o.brightness);
        const colour = Number(o.colour);
        if (fixtureId === '' || !Number.isInteger(brightness) || brightness < 1 || brightness > 100) {
            return null;
        }
        if (!Number.isInteger(colour) || colour < 0) {
            return null;
        }
        return { type: 'bulb', fixtureId, brightness, colour };
    }
    if (o.type === 'bulbReset') {
        const fixtureId = typeof o.fixtureId === 'string' ? o.fixtureId.trim() : '';
        if (fixtureId === '') {
            return null;
        }
        return { type: 'bulbReset', fixtureId };
    }
    if (o.type === 'vent') {
        const percent = Number(o.percent);
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
            return null;
        }
        /** @type {VentAction} */
        const action = { type: 'vent', percent };
        if (typeof o.motorId === 'number' && Number.isInteger(o.motorId) && o.motorId >= 0) {
            action.motorId = o.motorId;
        } else if (typeof o.motorId === 'string' && /^\d+$/.test(o.motorId)) {
            action.motorId = Number(o.motorId);
        }
        if (typeof o.room === 'string' && o.room.trim() !== '') {
            action.room = o.room.trim();
        }
        if (action.motorId === undefined && action.room === undefined) {
            return null;
        }
        return action;
    }
    return null;
}

/**
 * All configured remote addresses.
 * @returns {string[]}
 */
function getAllControlAddresses() {
    return Object.keys(getZigbeeControlsConfig().devices);
}

/**
 * Map desired colour to virtual axis position.
 * @param {number} colour `0` = red; positive = Kelvin
 * @returns {number}
 */
function colourToAxis(colour) {
    if (!Number.isFinite(colour) || colour <= 0) {
        return 0;
    }
    const k = Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, colour));
    return RED_AXIS_WIDTH + (k - KELVIN_MIN);
}

/**
 * Map virtual axis position to API colour (`0` or Kelvin).
 * @param {number} p
 * @returns {number}
 */
function axisToColour(p) {
    const clamped = Math.min(COLOUR_AXIS_MAX, Math.max(0, p));
    if (clamped <= RED_AXIS_WIDTH) {
        return 0;
    }
    return Math.round(KELVIN_MIN + (clamped - RED_AXIS_WIDTH));
}

/**
 * Classify a ZbReceived payload into a press key and/or relative step deltas.
 * @param {Record<string, unknown>} payload
 * @returns {{ press: 'single'|'double'|'long'|null, dimmerSteps: number, colorTempSteps: number }}
 */
function classifyRemotePayload(payload) {
    /** @type {'single'|'double'|'long'|null} */
    let press = null;
    let dimmerSteps = 0;
    let colorTempSteps = 0;

    if (Object.prototype.hasOwnProperty.call(payload, 'LidlPower')) {
        const v = Number(payload.LidlPower);
        if (v === 0) {
            press = 'single';
        } else if (v === 1) {
            press = 'double';
        } else if (v === 2) {
            press = 'long';
        }
    } else if (payload.Power === 2 || payload.Power === '2') {
        // Dimmer single press (Zigbee toggle)
        press = 'single';
    }

    if (typeof payload.DimmerStepUp === 'number' && Number.isFinite(payload.DimmerStepUp)) {
        dimmerSteps += payload.DimmerStepUp;
    }
    if (typeof payload.DimmerStepDown === 'number' && Number.isFinite(payload.DimmerStepDown)) {
        dimmerSteps -= payload.DimmerStepDown;
    }
    if (typeof payload.ColorTempStepUp === 'number' && Number.isFinite(payload.ColorTempStepUp)) {
        colorTempSteps += payload.ColorTempStepUp;
    }
    if (typeof payload.ColorTempStepDown === 'number' && Number.isFinite(payload.ColorTempStepDown)) {
        colorTempSteps -= payload.ColorTempStepDown;
    }

    return { press, dimmerSteps, colorTempSteps };
}

/**
 * Resolve vent mapping from action (`motorId` as externalId wins over `room`).
 * @param {VentAction} action
 * @returns {import('../lib/vent.automation.utils').RoomVentEntry|null}
 */
function resolveVentEntry(action) {
    const map = ventAutomation.getVentAutomationConfig().roomVentMap;
    if (typeof action.motorId === 'number' && Number.isInteger(action.motorId) && action.motorId >= 0) {
        for (const entry of Object.values(map)) {
            if (entry.externalId === action.motorId) {
                return entry;
            }
        }
        console.warn(`Zigbee controls: unknown vent externalId ${action.motorId}`);
        return null;
    }
    if (typeof action.room === 'string' && action.room !== '') {
        const entry = map[action.room];
        if (entry) {
            return entry;
        }
        console.warn(`Zigbee controls: unknown vent room "${action.room}"`);
        return null;
    }
    return null;
}

/**
 * Execute a configured press action.
 * @param {ControlAction} action
 * @returns {Promise<void>}
 */
async function executeAction(action) {
    if (action.type === 'bulb') {
        if (!bulbAutomation.setOverride(action.fixtureId, action.brightness, action.colour)) {
            console.warn(`Zigbee controls: unknown fixture "${action.fixtureId}" for bulb action`);
            return;
        }
        bulbAutomation.reconcileFixture(action.fixtureId, { force: true });
        return;
    }
    if (action.type === 'bulbReset') {
        if (!bulbAutomation.clearOverride(action.fixtureId)) {
            console.warn(`Zigbee controls: unknown fixture "${action.fixtureId}" for bulbReset`);
            return;
        }
        bulbAutomation.reconcileFixture(action.fixtureId, { force: true });
        return;
    }
    if (action.type === 'vent') {
        const entry = resolveVentEntry(action);
        if (entry === null) {
            return;
        }
        const { ok } = await ventClient.setVentMotorRaw(
            entry.motorControllerId,
            entry.motorId,
            action.percent,
        );
        if (!ok) {
            console.warn(
                `Zigbee controls: vent set failed externalId=${entry.externalId} percent=${action.percent}`,
            );
            return;
        }
        ventAutomation.recordManualOverride(entry.externalId);
    }
}

/**
 * Flush coalesced dimmer steps for one remote into a fixture override.
 * @param {string} addr
 * @returns {void}
 */
function flushDimmerBurst(addr) {
    const pending = pendingByAddr[addr];
    if (!pending) {
        return;
    }
    if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = null;
    }
    delete pendingByAddr[addr];

    const cfg = getZigbeeControlsConfig();
    const spec = cfg.devices[addr];
    if (!spec || spec.type !== 'dimmer' || !spec.fixtureId) {
        return;
    }

    const { baseline, brightnessDeltaSteps, colorTempDeltaSteps } = pending;
    if (brightnessDeltaSteps === 0 && colorTempDeltaSteps === 0) {
        return;
    }

    let brightness = baseline.brightness;
    let colour = baseline.colour;

    if (brightnessDeltaSteps !== 0) {
        const pctDelta = brightnessDeltaSteps / cfg.dimmerStepPerPercent;
        brightness = Math.min(100, Math.max(1, Math.round(baseline.brightness + pctDelta)));
    }

    if (colorTempDeltaSteps !== 0) {
        const axisDelta = colorTempDeltaSteps * (COLOUR_AXIS_MAX / cfg.colorTempFullScaleSteps);
        colour = axisToColour(colourToAxis(baseline.colour) + axisDelta);
    }

    if (!bulbAutomation.setOverride(spec.fixtureId, brightness, colour)) {
        console.warn(`Zigbee controls: unknown fixture "${spec.fixtureId}" for dimmer`);
        return;
    }
    bulbAutomation.reconcileFixture(spec.fixtureId, { force: true });
}

/**
 * Queue relative dimmer / CT steps; coalesce bursts into one override.
 * @param {string} addr
 * @param {ControlDeviceSpec} spec
 * @param {number} dimmerSteps
 * @param {number} colorTempSteps
 * @returns {void}
 */
function queueDimmerSteps(addr, spec, dimmerSteps, colorTempSteps) {
    if (spec.type !== 'dimmer' || !spec.fixtureId) {
        return;
    }
    if (dimmerSteps === 0 && colorTempSteps === 0) {
        return;
    }

    let pending = pendingByAddr[addr];
    if (!pending) {
        const desired = bulbAutomation.getEffectiveDesired(spec.fixtureId);
        if (!desired) {
            console.warn(`Zigbee controls: no desired state for fixture "${spec.fixtureId}"`);
            return;
        }
        pending = {
            brightnessDeltaSteps: 0,
            colorTempDeltaSteps: 0,
            baseline: {
                brightness: Math.min(100, Math.max(1, Math.round(desired.brightness))),
                colour: desired.colour,
            },
            timer: null,
        };
        pendingByAddr[addr] = pending;
    }

    pending.brightnessDeltaSteps += dimmerSteps;
    pending.colorTempDeltaSteps += colorTempSteps;

    if (pending.timer) {
        clearTimeout(pending.timer);
    }
    pending.timer = setTimeout(() => {
        flushDimmerBurst(addr);
    }, DIMMER_COALESCE_MS);
}

/**
 * Handle one remote device report from `ZbReceived`.
 * @param {string} addrRaw
 * @param {Record<string, unknown>} payload
 * @returns {void}
 */
function handleDeviceReport(addrRaw, payload) {
    const cfg = getZigbeeControlsConfig();
    if (!cfg.enabled) {
        return;
    }
    if (payload.ConfigResponse !== undefined) {
        return;
    }

    const addr = normalizeZigbeeAddress(addrRaw);
    if (addr === '') {
        return;
    }
    const spec = cfg.devices[addr];
    if (!spec) {
        return;
    }

    const { press, dimmerSteps, colorTempSteps } = classifyRemotePayload(payload);

    if (press !== null) {
        const action = spec[press];
        if (action) {
            void executeAction(action).catch((e) => {
                console.warn('Zigbee controls action error:', e);
            });
        }
    }

    if (dimmerSteps !== 0 || colorTempSteps !== 0) {
        queueDimmerSteps(addr, spec, dimmerSteps, colorTempSteps);
    }
}

module.exports = {
    normalizeZigbeeAddress,
    getZigbeeControlsConfig,
    getAllControlAddresses,
    colourToAxis,
    axisToColour,
    classifyRemotePayload,
    executeAction,
    handleDeviceReport,
};
