const { getWallClockMinutesInTimeZone } = require('../lib/vent.automation.utils');

/**
 * @typedef {{ brightness: number, colour: number }} BulbDesiredState
 * @typedef {{
 *   brightness: number|null,
 *   colour: number|null,
 *   power: 'on'|'off'|null,
 *   lastUpdateMs: number|null,
 *   linkQuality: number|null,
 *   hue: number|null,
 *   sat: number|null,
 * }} BulbDeviceState
 * @typedef {{ power: 'off' } | { power: 'on', brightness: number, colour: number }} BulbCommandPlan
 * @typedef {{ from: string, to: string, brightness: number, colour: number }} BulbScheduleWindow
 * @typedef {{
 *   targetState: BulbDesiredState|null,
 *   overrideState: BulbDesiredState|null,
 *   overrideExpiry: number|null,
 *   deviceStateByBulb: Record<string, BulbDeviceState>,
 *   lastPushAtMs: number|null,
 * }} FixtureRuntimeState
 */

const DEFAULTS = {
    enabled: true,
    manualOverrideMs: 5_400_000,
    timezone: 'Australia/Sydney',
};

/** Brightness match tolerance (percent). */
const BRIGHTNESS_TOLERANCE = 1;

/** Kelvin match tolerance for white CT (covers ±50 send jitter + mired rounding). */
const KELVIN_TOLERANCE = 100;

/** Hue ≤ this and sat ≥ SAT_RED_MIN counts as red (colour 0). */
const HUE_RED_MAX = 10;
const SAT_RED_MIN = 200;

/**
 * @returns {BulbDeviceState}
 */
function emptyBulbDeviceState() {
    return {
        brightness: null,
        colour: null,
        power: null,
        lastUpdateMs: null,
        linkQuality: null,
        hue: null,
        sat: null,
    };
}

/**
 * True when cached/report HS still looks like red RGB (TS0505B often keeps Hue/Sat after CT is requested).
 * @param {{ colour?: number|null, hue?: number|null, sat?: number|null }} reported
 * @returns {boolean}
 */
function reportLooksRed(reported) {
    if (reported.colour === 0) {
        return true;
    }
    const hue = reported.hue;
    const sat = reported.sat;
    return (
        typeof hue === 'number' &&
        hue <= HUE_RED_MAX &&
        typeof sat === 'number' &&
        sat >= SAT_RED_MIN
    );
}

/** @type {Record<string, FixtureRuntimeState>} */
const fixtureStates = {};

/** @type {((fixtureId: string, plans: Record<string, BulbCommandPlan>) => void)|null} */
let pushCommandsFn = null;

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
 * @returns {typeof DEFAULTS & {
 *   fixtures: Record<string, { bulbs: string[] }>,
 *   schedules: Record<string, BulbScheduleWindow[]>,
 * }}
 */
function getBulbAutomationConfig() {
    const raw = global.appconfig?.bulbAutomation;
    const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? /** @type {Record<string, unknown>} */ (raw)
        : {};

    /** @type {Record<string, { bulbs: string[] }>} */
    const fixtures = {};
    const fixturesRaw = r.fixtures;
    if (fixturesRaw !== null && typeof fixturesRaw === 'object' && !Array.isArray(fixturesRaw)) {
        for (const [id, spec] of Object.entries(/** @type {Record<string, unknown>} */ (fixturesRaw))) {
            if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
                continue;
            }
            const bulbsRaw = /** @type {{ bulbs?: unknown }} */ (spec).bulbs;
            if (!Array.isArray(bulbsRaw)) {
                continue;
            }
            const bulbs = bulbsRaw
                .map((a) => (typeof a === 'string' ? normalizeZigbeeAddress(a) : ''))
                .filter((a) => a !== '');
            if (bulbs.length > 0) {
                fixtures[id] = { bulbs };
            }
        }
    }

    /** @type {Record<string, BulbScheduleWindow[]>} */
    const schedules = {};
    const schedulesRaw = r.schedules;
    if (schedulesRaw !== null && typeof schedulesRaw === 'object' && !Array.isArray(schedulesRaw)) {
        for (const [id, windows] of Object.entries(/** @type {Record<string, unknown>} */ (schedulesRaw))) {
            if (!Array.isArray(windows)) {
                continue;
            }
            /** @type {BulbScheduleWindow[]} */
            const parsed = [];
            for (const w of windows) {
                if (w === null || typeof w !== 'object' || Array.isArray(w)) {
                    continue;
                }
                const row = /** @type {Record<string, unknown>} */ (w);
                if (typeof row.from !== 'string' || typeof row.to !== 'string') {
                    continue;
                }
                const brightness = Number(row.brightness);
                const colour = Number(row.colour);
                if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
                    continue;
                }
                if (!Number.isInteger(colour) || colour < 0) {
                    continue;
                }
                parsed.push({ from: row.from, to: row.to, brightness, colour });
            }
            schedules[id] = parsed;
        }
    }

    return {
        enabled: r.enabled !== false,
        manualOverrideMs:
            typeof r.manualOverrideMs === 'number' && Number.isFinite(r.manualOverrideMs) && r.manualOverrideMs >= 0
                ? r.manualOverrideMs
                : DEFAULTS.manualOverrideMs,
        timezone:
            typeof r.timezone === 'string' && r.timezone.trim() !== ''
                ? r.timezone.trim()
                : DEFAULTS.timezone,
        fixtures,
        schedules,
    };
}

/**
 * Ensure runtime state exists for every configured fixture.
 * @returns {void}
 */
function ensureFixtureStates() {
    const cfg = getBulbAutomationConfig();
    for (const [fixtureId, spec] of Object.entries(cfg.fixtures)) {
        if (!fixtureStates[fixtureId]) {
            /** @type {Record<string, BulbDeviceState>} */
            const deviceStateByBulb = {};
            for (const addr of spec.bulbs) {
                deviceStateByBulb[addr] = emptyBulbDeviceState();
            }
            fixtureStates[fixtureId] = {
                targetState: null,
                overrideState: null,
                overrideExpiry: null,
                deviceStateByBulb,
                lastPushAtMs: null,
            };
        } else {
            const st = fixtureStates[fixtureId];
            for (const addr of spec.bulbs) {
                if (!st.deviceStateByBulb[addr]) {
                    st.deviceStateByBulb[addr] = emptyBulbDeviceState();
                } else {
                    // Backfill fields added after initial deploy.
                    if (st.deviceStateByBulb[addr].hue === undefined) {
                        st.deviceStateByBulb[addr].hue = null;
                    }
                    if (st.deviceStateByBulb[addr].sat === undefined) {
                        st.deviceStateByBulb[addr].sat = null;
                    }
                }
            }
        }
    }
}

/**
 * @param {string} hhmm
 * @returns {number|null} Minutes from midnight.
 */
function parseHhMm(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    if (m === null) {
        return null;
    }
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
        return null;
    }
    return h * 60 + min;
}

/**
 * Half-open window `[fromMin, toMin)`; overnight when fromMin > toMin.
 * @param {number} localMin
 * @param {number} fromMin
 * @param {number} toMin
 * @returns {boolean}
 */
function isInScheduleWindow(localMin, fromMin, toMin) {
    if (fromMin < toMin) {
        return localMin >= fromMin && localMin < toMin;
    }
    if (fromMin > toMin) {
        return localMin >= fromMin || localMin < toMin;
    }
    return false;
}

/**
 * Compute schedule target for a fixture at `nowMs`.
 * @param {string} fixtureId
 * @param {number} [nowMs]
 * @returns {BulbDesiredState|null}
 */
function scheduleStateForFixture(fixtureId, nowMs = Date.now()) {
    const cfg = getBulbAutomationConfig();
    const windows = cfg.schedules[fixtureId];
    if (!Array.isArray(windows) || windows.length === 0) {
        return null;
    }
    const localMin = getWallClockMinutesInTimeZone(new Date(nowMs), cfg.timezone);
    if (localMin === null) {
        return null;
    }
    for (const w of windows) {
        const fromMin = parseHhMm(w.from);
        const toMin = parseHhMm(w.to);
        if (fromMin === null || toMin === null) {
            continue;
        }
        if (isInScheduleWindow(localMin, fromMin, toMin)) {
            return { brightness: w.brightness, colour: w.colour };
        }
    }
    return null;
}

/**
 * @param {BulbDesiredState|null} a
 * @param {BulbDesiredState|null} b
 * @returns {boolean}
 */
function desiredEqual(a, b) {
    if (a === null && b === null) {
        return true;
    }
    if (a === null || b === null) {
        return false;
    }
    return a.brightness === b.brightness && a.colour === b.colour;
}

/**
 * Effective desired state for a fixture (override wins while active).
 * @param {string} fixtureId
 * @param {number} [nowMs]
 * @returns {BulbDesiredState|null}
 */
function getEffectiveDesired(fixtureId, nowMs = Date.now()) {
    ensureFixtureStates();
    const st = fixtureStates[fixtureId];
    if (!st) {
        return null;
    }
    if (st.overrideState && typeof st.overrideExpiry === 'number' && st.overrideExpiry > nowMs) {
        return { ...st.overrideState };
    }
    return st.targetState ? { ...st.targetState } : null;
}

/**
 * Expand fixture desired into per-bulb command plans.
 * At brightness 1% with ≥2 bulbs, secondary is Power Off only.
 * @param {string} fixtureId
 * @param {BulbDesiredState} desired
 * @returns {Record<string, BulbCommandPlan>}
 */
function expandToBulbPlans(fixtureId, desired) {
    const cfg = getBulbAutomationConfig();
    const bulbs = cfg.fixtures[fixtureId]?.bulbs ?? [];
    /** @type {Record<string, BulbCommandPlan>} */
    const plans = {};
    if (bulbs.length === 0) {
        return plans;
    }
    if (desired.brightness === 1 && bulbs.length >= 2) {
        plans[bulbs[0]] = {
            power: 'on',
            brightness: desired.brightness,
            colour: desired.colour,
        };
        for (let i = 1; i < bulbs.length; i++) {
            plans[bulbs[i]] = { power: 'off' };
        }
        return plans;
    }
    for (const addr of bulbs) {
        plans[addr] = {
            power: 'on',
            brightness: desired.brightness,
            colour: desired.colour,
        };
    }
    return plans;
}

/**
 * Whether reported device state matches the expected command plan.
 * @param {BulbCommandPlan} expected
 * @param {BulbDeviceState} reported
 * @returns {boolean}
 */
function commandMatchesDevice(expected, reported) {
    if (expected.power === 'off') {
        return reported.power === 'off';
    }
    if (reported.power === 'off') {
        return false;
    }
    // power null or on is acceptable when we want on (wall switch may leave Power unreported)
    if (typeof reported.brightness !== 'number') {
        return false;
    }
    if (Math.abs(reported.brightness - expected.brightness) > BRIGHTNESS_TOLERANCE) {
        return false;
    }
    if (typeof reported.colour !== 'number') {
        return false;
    }
    if (expected.colour === 0) {
        return reported.colour === 0 || reportLooksRed(reported);
    }
    // White CT: do not accept stale CT while Hue/Sat still look like red RGB.
    if (reportLooksRed(reported)) {
        return false;
    }
    return Math.abs(reported.colour - expected.colour) <= KELVIN_TOLERANCE;
}

/**
 * Convert Dimmer 0–254 to brightness percent.
 * @param {number} dimmer
 * @returns {number}
 */
function dimmerToBrightness(dimmer) {
    return Math.round((dimmer * 100) / 254);
}

/**
 * Convert CT mireds to Kelvin.
 * @param {number} mireds
 * @returns {number}
 */
function miredsToKelvin(mireds) {
    if (!Number.isFinite(mireds) || mireds <= 0) {
        return 0;
    }
    return Math.round(1_000_000 / mireds);
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
function hasLightStateFields(payload) {
    if (payload.Power !== undefined && payload.Power !== null) {
        return true;
    }
    if (typeof payload.Dimmer === 'number' && Number.isFinite(payload.Dimmer)) {
        return true;
    }
    if (typeof payload.CT === 'number' && Number.isFinite(payload.CT)) {
        return true;
    }
    if (typeof payload.Hue === 'number' && Number.isFinite(payload.Hue)) {
        return true;
    }
    if (typeof payload.Sat === 'number' && Number.isFinite(payload.Sat)) {
        return true;
    }
    return false;
}

/**
 * Normalize a Tasmota ZbReceived / ZbInfo light payload into app device state fields.
 * TS0505B (`_TZ3210_*`) often omits / does not support `ColorMode`; both Hue/Sat and CT may appear
 * together in `ZbInfo`. Use `preferMode` from the current command plan when available.
 * @param {Record<string, unknown>} payload
 * @param {{ preferMode?: 'red'|'ct'|null }} [opts]
 * @returns {Partial<BulbDeviceState>}
 */
function normalizeLightReport(payload, opts = {}) {
    /** @type {Partial<BulbDeviceState>} */
    const out = {};
    const preferMode = opts.preferMode ?? null;

    const powerRaw = payload.Power;
    if (powerRaw === 1 || powerRaw === true || powerRaw === 'On' || powerRaw === 'ON' || powerRaw === 'on') {
        out.power = 'on';
    } else if (powerRaw === 0 || powerRaw === false || powerRaw === 'Off' || powerRaw === 'OFF' || powerRaw === 'off') {
        out.power = 'off';
    }

    if (typeof payload.Dimmer === 'number' && Number.isFinite(payload.Dimmer)) {
        out.brightness = dimmerToBrightness(payload.Dimmer);
    }

    // ColorMode may be missing/unsupported on Tuya TS0505B — treat non-numbers as null.
    const colorMode = typeof payload.ColorMode === 'number' && Number.isFinite(payload.ColorMode)
        ? payload.ColorMode
        : null;
    const hue = typeof payload.Hue === 'number' && Number.isFinite(payload.Hue) ? payload.Hue : null;
    const sat = typeof payload.Sat === 'number' && Number.isFinite(payload.Sat) ? payload.Sat : null;
    const ct = typeof payload.CT === 'number' && Number.isFinite(payload.CT) ? payload.CT : null;
    const looksRed = hue !== null && hue <= HUE_RED_MAX && sat !== null && sat >= SAT_RED_MIN;

    if (hue !== null) {
        out.hue = hue;
    }
    if (sat !== null) {
        out.sat = sat;
    }

    if (preferMode === 'red') {
        if (looksRed || (hue !== null && hue <= HUE_RED_MAX)) {
            out.colour = 0;
        }
    } else if (preferMode === 'ct') {
        // Stale CT attributes arrive while the bulb is still in RGB red — do not treat as white yet.
        if (looksRed) {
            out.colour = 0;
        } else if (ct !== null) {
            out.colour = miredsToKelvin(ct);
        }
    } else if (colorMode === 0) {
        if (looksRed) {
            out.colour = 0;
        }
    } else if (colorMode === 2 || colorMode === 1) {
        if (ct !== null) {
            out.colour = miredsToKelvin(ct);
        }
    } else {
        // No ColorMode: red HS wins over stale CT; otherwise use CT when present.
        if (looksRed) {
            out.colour = 0;
        } else if (ct !== null) {
            out.colour = miredsToKelvin(ct);
        }
    }

    if (typeof payload.LinkQuality === 'number' && Number.isFinite(payload.LinkQuality)) {
        out.linkQuality = payload.LinkQuality;
    }

    return out;
}

/**
 * Apply a MQTT light report for a known bulb address.
 * @param {string} addrRaw
 * @param {Record<string, unknown>} payload
 * @returns {{ fixtureId: string, needsReconcile: boolean }|null}
 */
function applyDeviceReport(addrRaw, payload) {
    ensureFixtureStates();
    const addr = normalizeZigbeeAddress(addrRaw);
    if (addr === '') {
        return null;
    }
    const cfg = getBulbAutomationConfig();
    let fixtureId = /** @type {string|null} */ (null);
    for (const [id, spec] of Object.entries(cfg.fixtures)) {
        if (spec.bulbs.includes(addr)) {
            fixtureId = id;
            break;
        }
    }
    if (fixtureId === null) {
        return null;
    }
    const st = fixtureStates[fixtureId];
    if (!st || !st.deviceStateByBulb[addr]) {
        return null;
    }

    // Still allow LQI-only updates on known bulbs, but skip ConfigResponse / LocalTime / empty noise.
    if (payload.ConfigResponse !== undefined || payload.Read !== undefined || payload.ReadNames !== undefined) {
        if (typeof payload.LinkQuality === 'number' && Number.isFinite(payload.LinkQuality)) {
            st.deviceStateByBulb[addr] = {
                ...st.deviceStateByBulb[addr],
                linkQuality: payload.LinkQuality,
            };
        }
        return { fixtureId, needsReconcile: false };
    }
    if (!hasLightStateFields(payload)) {
        if (typeof payload.LinkQuality === 'number' && Number.isFinite(payload.LinkQuality)) {
            st.deviceStateByBulb[addr] = {
                ...st.deviceStateByBulb[addr],
                linkQuality: payload.LinkQuality,
            };
        }
        return { fixtureId, needsReconcile: false };
    }

    /** @type {'red'|'ct'|null} */
    let preferMode = null;
    const desired = getEffectiveDesired(fixtureId);
    if (desired) {
        const plans = expandToBulbPlans(fixtureId, desired);
        const plan = plans[addr];
        if (plan && plan.power === 'on') {
            preferMode = plan.colour === 0 ? 'red' : 'ct';
        }
    }

    const patch = normalizeLightReport(payload, { preferMode });
    const prev = st.deviceStateByBulb[addr];
    const powerOnEdge = patch.power === 'on' && prev.power !== 'on';

    // Wall-switch restore: drop colour/brightness trust so we force a full desired push.
    if (powerOnEdge) {
        st.deviceStateByBulb[addr] = {
            brightness: patch.brightness !== undefined ? patch.brightness : null,
            colour: patch.colour !== undefined ? patch.colour : null,
            power: 'on',
            lastUpdateMs: Date.now(),
            linkQuality: patch.linkQuality !== undefined ? patch.linkQuality : prev.linkQuality,
            hue: patch.hue !== undefined ? patch.hue : null,
            sat: patch.sat !== undefined ? patch.sat : null,
        };
        return { fixtureId, needsReconcile: Boolean(desired && cfg.enabled) };
    }

    st.deviceStateByBulb[addr] = {
        brightness: patch.brightness !== undefined ? patch.brightness : prev.brightness,
        colour: patch.colour !== undefined ? patch.colour : prev.colour,
        power: patch.power !== undefined ? patch.power : prev.power,
        lastUpdateMs: Date.now(),
        linkQuality: patch.linkQuality !== undefined ? patch.linkQuality : prev.linkQuality,
        hue: patch.hue !== undefined ? patch.hue : prev.hue,
        sat: patch.sat !== undefined ? patch.sat : prev.sat,
    };

    if (!desired || !cfg.enabled) {
        return { fixtureId, needsReconcile: false };
    }
    const plans = expandToBulbPlans(fixtureId, desired);
    const plan = plans[addr];
    if (!plan) {
        return { fixtureId, needsReconcile: false };
    }
    const needsReconcile = !commandMatchesDevice(plan, st.deviceStateByBulb[addr]);
    return { fixtureId, needsReconcile };
}

/**
 * Recompute targetState from each fixture's schedule; return fixtures whose target changed.
 * @param {number} [nowMs]
 * @returns {string[]} Fixture ids whose targetState changed.
 */
function tickSchedules(nowMs = Date.now()) {
    ensureFixtureStates();
    const cfg = getBulbAutomationConfig();
    /** @type {string[]} */
    const changed = [];
    for (const fixtureId of Object.keys(cfg.fixtures)) {
        const next = scheduleStateForFixture(fixtureId, nowMs);
        const st = fixtureStates[fixtureId];
        if (!st) {
            continue;
        }
        if (!desiredEqual(st.targetState, next)) {
            st.targetState = next;
            changed.push(fixtureId);
        }
    }
    return changed;
}

/**
 * Set a manual override on a fixture.
 * @param {string} fixtureId
 * @param {number} brightness
 * @param {number} colour
 * @returns {boolean} False when fixture unknown.
 */
function setOverride(fixtureId, brightness, colour) {
    ensureFixtureStates();
    const st = fixtureStates[fixtureId];
    if (!st) {
        return false;
    }
    const cfg = getBulbAutomationConfig();
    st.overrideState = { brightness, colour };
    st.overrideExpiry = Date.now() + cfg.manualOverrideMs;
    return true;
}

/**
 * Clear a fixture's manual override so effective desired returns to schedule `targetState`.
 * Refreshes `targetState` from the fixture's schedule before returning.
 * @param {string} fixtureId
 * @param {number} [nowMs]
 * @returns {boolean} False when fixture unknown.
 */
function clearOverride(fixtureId, nowMs = Date.now()) {
    ensureFixtureStates();
    const st = fixtureStates[fixtureId];
    if (!st) {
        return false;
    }
    st.overrideState = null;
    st.overrideExpiry = null;
    st.targetState = scheduleStateForFixture(fixtureId, nowMs);
    return true;
}

/**
 * Collect bulb addresses that mismatch the effective desired plan.
 * @param {string} fixtureId
 * @returns {Record<string, BulbCommandPlan>|null} Plans to push, or null if nothing to do / no desired.
 */
function plansNeedingPush(fixtureId) {
    ensureFixtureStates();
    const cfg = getBulbAutomationConfig();
    if (!cfg.enabled) {
        return null;
    }
    const desired = getEffectiveDesired(fixtureId);
    if (!desired) {
        return null;
    }
    const st = fixtureStates[fixtureId];
    if (!st) {
        return null;
    }
    const allPlans = expandToBulbPlans(fixtureId, desired);
    /** @type {Record<string, BulbCommandPlan>} */
    const need = {};
    for (const [addr, plan] of Object.entries(allPlans)) {
        const reported = st.deviceStateByBulb[addr];
        if (!reported || !commandMatchesDevice(plan, reported)) {
            need[addr] = plan;
        }
    }
    return Object.keys(need).length > 0 ? need : null;
}

/**
 * Reconcile one fixture: push commands for mismatched bulbs via registered push fn.
 * @param {string} fixtureId
 * @param {{ force?: boolean }} [opts] When `force`, push all plans even if they appear matched.
 * @returns {boolean} True if a push was attempted.
 */
function reconcileFixture(fixtureId, opts = {}) {
    ensureFixtureStates();
    const cfg = getBulbAutomationConfig();
    if (!cfg.enabled || !cfg.fixtures[fixtureId]) {
        return false;
    }
    const desired = getEffectiveDesired(fixtureId);
    if (!desired) {
        return false;
    }
    const plans = opts.force
        ? expandToBulbPlans(fixtureId, desired)
        : plansNeedingPush(fixtureId);
    if (!plans || Object.keys(plans).length === 0) {
        return false;
    }
    if (typeof pushCommandsFn === 'function') {
        pushCommandsFn(fixtureId, plans);
        const st = fixtureStates[fixtureId];
        if (st) {
            st.lastPushAtMs = Date.now();
            // After requesting white CT, clear colour/HS cache so stale CT+red Hue cannot false-match.
            for (const [addr, plan] of Object.entries(plans)) {
                if (plan.power === 'on' && plan.colour > 0) {
                    const ds = st.deviceStateByBulb[addr];
                    if (ds) {
                        ds.colour = null;
                        ds.hue = null;
                        ds.sat = null;
                    }
                }
            }
        }
        return true;
    }
    return false;
}

/**
 * After schedule tick: push fixtures whose target changed and that have no active override.
 * @param {number} [nowMs]
 * @returns {void}
 */
function onScheduleTick(nowMs = Date.now()) {
    const changed = tickSchedules(nowMs);
    for (const fixtureId of changed) {
        const st = fixtureStates[fixtureId];
        const overrideActive =
            st &&
            st.overrideState &&
            typeof st.overrideExpiry === 'number' &&
            st.overrideExpiry > nowMs;
        if (!overrideActive) {
            reconcileFixture(fixtureId, { force: true });
        }
    }
    // Also clear expired overrides and re-apply schedule desired when expiry passes
    ensureFixtureStates();
    for (const fixtureId of Object.keys(getBulbAutomationConfig().fixtures)) {
        const st = fixtureStates[fixtureId];
        if (
            st &&
            st.overrideExpiry !== null &&
            typeof st.overrideExpiry === 'number' &&
            st.overrideExpiry <= nowMs &&
            st.overrideState !== null
        ) {
            st.overrideState = null;
            st.overrideExpiry = null;
            reconcileFixture(fixtureId, { force: true });
        }
    }
}

/**
 * Snapshot for API responses.
 * @param {string} fixtureId
 * @param {number} [nowMs]
 * @returns {object|null}
 */
function getFixtureSnapshot(fixtureId, nowMs = Date.now()) {
    ensureFixtureStates();
    const cfg = getBulbAutomationConfig();
    const spec = cfg.fixtures[fixtureId];
    const st = fixtureStates[fixtureId];
    if (!spec || !st) {
        return null;
    }
    const overrideActive =
        st.overrideState !== null &&
        typeof st.overrideExpiry === 'number' &&
        st.overrideExpiry > nowMs;
    return {
        fixtureId,
        bulbs: [...spec.bulbs],
        enabled: cfg.enabled,
        targetState: st.targetState ? { ...st.targetState } : null,
        overrideState: overrideActive && st.overrideState ? { ...st.overrideState } : null,
        overrideExpiry: overrideActive ? st.overrideExpiry : null,
        desiredState: getEffectiveDesired(fixtureId, nowMs),
        deviceStateByBulb: Object.fromEntries(
            Object.entries(st.deviceStateByBulb).map(([k, v]) => [k, { ...v }]),
        ),
        lastPushAtMs: st.lastPushAtMs,
    };
}

/**
 * @param {number} [nowMs]
 * @returns {object[]}
 */
function getAllFixtureSnapshots(nowMs = Date.now()) {
    ensureFixtureStates();
    return Object.keys(getBulbAutomationConfig().fixtures)
        .map((id) => getFixtureSnapshot(id, nowMs))
        .filter((s) => s !== null);
}

/**
 * All configured bulb short addresses (for MQTT bootstrap / filtering).
 * @returns {string[]}
 */
function getAllBulbAddresses() {
    const cfg = getBulbAutomationConfig();
    /** @type {string[]} */
    const out = [];
    for (const spec of Object.values(cfg.fixtures)) {
        for (const addr of spec.bulbs) {
            if (!out.includes(addr)) {
                out.push(addr);
            }
        }
    }
    return out;
}

/**
 * Register the MQTT command publisher used by reconcile.
 * @param {(fixtureId: string, plans: Record<string, BulbCommandPlan>) => void} fn
 * @returns {void}
 */
function setPushCommandsFn(fn) {
    pushCommandsFn = fn;
}

/**
 * Convert brightness percent to Zigbee Dimmer 0–254.
 * @param {number} pct
 * @returns {number}
 */
function brightnessToDimmer(pct) {
    if (pct <= 0) {
        return 0;
    }
    return Math.min(254, Math.max(1, Math.round((pct * 254) / 100)));
}

/**
 * Convert Kelvin to CT mireds.
 * @param {number} kelvin
 * @returns {number}
 */
function kelvinToMireds(kelvin) {
    if (!Number.isFinite(kelvin) || kelvin <= 0) {
        return 370;
    }
    return Math.round(1_000_000 / kelvin);
}

module.exports = {
    normalizeZigbeeAddress,
    getBulbAutomationConfig,
    ensureFixtureStates,
    scheduleStateForFixture,
    getEffectiveDesired,
    expandToBulbPlans,
    commandMatchesDevice,
    normalizeLightReport,
    applyDeviceReport,
    tickSchedules,
    setOverride,
    clearOverride,
    plansNeedingPush,
    reconcileFixture,
    onScheduleTick,
    getFixtureSnapshot,
    getAllFixtureSnapshots,
    getAllBulbAddresses,
    setPushCommandsFn,
    brightnessToDimmer,
    kelvinToMireds,
    dimmerToBrightness,
    miredsToKelvin,
};
