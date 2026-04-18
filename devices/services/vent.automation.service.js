const ventClient = require('../lib/vent.client');
const ventActionLog = require('./vent.action.log');
const {
    roundToOneDecimal,
    isFiniteNum,
    finiteNumOrDefault,
    parseMotorId,
    readRowTemp,
    normalizedPauseHrsMap,
    parsePauseHrsWindow,
    getWallClockMinutesInTimeZone,
    roomNameForMotorInMap,
    isRedundantAltSensorLabel,
    primaryRoomFromRedundantAltLabel,
    redundantAltLabelForPrimaryRoom,
} = require('../lib/vent.automation.utils');

/** @type {Record<string, number>} motorId (as string) -> manual override until epoch ms */
const manualOverrideUntilByMotor = /** @type {Record<string, number>} */ ({});

/** @type {Record<string, { temperature: number, lastUpdateMs: number }>} Optional Wi-Fi / supplemental readings by room name. */
const wifiSupplementByRoom = {};

/** Epoch ms when {@link evaluateAndAct} last ran while automation was enabled. */
let lastAutomationEvaluationAt = /** @type {number|null} */ (null);

/**
 * Last controller band mode from {@link evaluateAndAct} (used to drop room target overrides on cooling ↔ heating).
 * @type {'cooling'|'heating'|'idle'|null}
 */
let lastVentAutomationHvacMode = null;

/** Epoch ms until which {@link ventHvacHeldMode} is reported instead of raw idle (see {@link applyVentAutomationHvacIdleHold}). */
let ventHvacActiveHoldUntilMs = /** @type {number|null} */ (null);

/**
 * Last non-idle mode while hold is active (after raw mode was heating or cooling).
 * @type {'cooling'|'heating'|null}
 */
let ventHvacHeldMode = null;

/**
 * Latest reading from the HVAC fan power monitor (watts), or `null` if never received.
 * @type {number|null}
 */
let hvacPowerW = null;

/** Epoch ms when {@link hvacPowerW} was last updated. */
let hvacPowerLastUpdateMs = /** @type {number|null} */ (null);

/**
 * Last temperature-derived non-idle controller mode (heating/cooling). Used to disambiguate
 * mode while the HVAC is reported active by the power monitor but the controller temperature
 * is inside the idle band (so we keep reporting whatever the system was last actively doing).
 * @type {'cooling'|'heating'|null}
 */
let lastActiveTempBasedHvacMode = null;

/** @type {Record<string, { targetC: number, untilMs: number }>} */
const roomTargetOverrideByRoom = {};

/** @type {Record<string, number>} Last automation-issued vent command per room (for directional hysteresis). */
const lastAutomationCmdByRoom = {};

/** Stale-after: if no temperature telegram within this window, redundant pair member is excluded from averaging. */
const REDUNDANT_SENSOR_OFFLINE_MS = 30 * 60 * 1000;

const DEFAULTS = {
    enabled: true,
    coolTargetC: 23,
    heatTargetC: 21,
    roomHysteresisC: 0.5,
    /** After raw HVAC mode is heating or cooling, raw idle is ignored until this many ms elapse from the last active tick. */
    hvacModeIdleHoldAfterActiveMs: 60 * 60 * 1000,
    manualOverrideMs: 3600000,
    /** How long {@link setRoomTargetTemperatureTemporary} keeps a per-room target active. */
    roomTargetOverrideDurationMs: 20 * 60 * 60 * 1000,
    controllerRoomName: 'Stairwell',
    ventOpenRaw: 100,
    ventClosedRaw: 0,
    hysteresisClosePercent: 50,
    roomVentMap: /** @type {Record<string, number>} */ ({
        "Guest Room": 2,
        "Peter's Room": 0,
        "Burton's Room": 1,
    }),
    /** Room label → `HH:mm-HH:mm` local window (may span midnight); evaluated in {@link getVentAutomationConfig}'s `timezone`. */
    pauseHrs: /** @type {Record<string, string>} */ ({}),
    /** IANA zone for {@link pauseHrs} (e.g. `Australia/Sydney`). */
    timezone: 'UTC',
    /** Tasmota Zigbee short address (e.g. `0xCD0D`) of the HVAC fan power monitor. Empty disables power gating. */
    hvacPowerSensorZigbeeAddr: '',
    /** Watts at/above which the HVAC is considered active (heating or cooling). */
    hvacPowerActiveThresholdW: 50,
    /** A power reading older than this is ignored and {@link resolveVentAutomationHvacMode} falls back to temperature-only logic. */
    hvacPowerStaleAfterMs: 5 * 60 * 1000,
};

/**
 * @param {typeof DEFAULTS & { ventBaseUrl?: string, pauseHrs: Record<string, string>, timezone: string }} cfg
 * @param {number|string} motorId
 * @param {number} nowMs
 * @returns {boolean}
 */
function isPauseHoursActiveForMotor(cfg, motorId, nowMs) {
    const room = roomNameForMotorInMap(cfg.roomVentMap, motorId);
    if (room === null) {
        return false;
    }
    const spec = cfg.pauseHrs[room];
    if (typeof spec !== 'string') {
        return false;
    }
    const window = parsePauseHrsWindow(spec);
    if (window === null) {
        return false;
    }
    const localMin = getWallClockMinutesInTimeZone(new Date(nowMs), cfg.timezone);
    if (localMin === null) {
        return false;
    }
    if (window.startMin < window.endMin) {
        return localMin >= window.startMin && localMin < window.endMin;
    }
    if (window.startMin > window.endMin) {
        return localMin >= window.startMin || localMin < window.endMin;
    }
    return false;
}

/**
 * Resolve `appconfig.ventAutomation` merged with {@link DEFAULTS}.
 * @returns {typeof DEFAULTS & { ventBaseUrl?: string }}
 */
function getVentAutomationConfig() {
    const raw = global.appconfig?.ventAutomation;
    const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? /** @type {Record<string, unknown>} */ (raw)
        : {};
    const roomVentMap =
        r.roomVentMap !== null && typeof r.roomVentMap === 'object' && !Array.isArray(r.roomVentMap)
            ? /** @type {Record<string, number>} */ (/** @type {unknown} */ (r.roomVentMap))
            : DEFAULTS.roomVentMap;
    return {
        enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
        coolTargetC: finiteNumOrDefault(r.coolTargetC, DEFAULTS.coolTargetC),
        heatTargetC: finiteNumOrDefault(r.heatTargetC, DEFAULTS.heatTargetC),
        roomHysteresisC: finiteNumOrDefault(r.roomHysteresisC, DEFAULTS.roomHysteresisC),
        hvacModeIdleHoldAfterActiveMs: finiteNumOrDefault(
            r.hvacModeIdleHoldAfterActiveMs, DEFAULTS.hvacModeIdleHoldAfterActiveMs, { min: 0 },
        ),
        manualOverrideMs: finiteNumOrDefault(r.manualOverrideMs, DEFAULTS.manualOverrideMs, { min: 0 }),
        roomTargetOverrideDurationMs: finiteNumOrDefault(
            r.roomTargetOverrideDurationMs, DEFAULTS.roomTargetOverrideDurationMs, { min: 0 },
        ),
        controllerRoomName:
            typeof r.controllerRoomName === 'string' && r.controllerRoomName.trim() !== ''
                ? r.controllerRoomName.trim()
                : (typeof r.stairwellRoomName === 'string' && r.stairwellRoomName.trim() !== ''
                    ? r.stairwellRoomName.trim()
                    : DEFAULTS.controllerRoomName),
        ventOpenRaw: finiteNumOrDefault(r.ventOpenRaw, DEFAULTS.ventOpenRaw),
        ventClosedRaw: finiteNumOrDefault(r.ventClosedRaw, DEFAULTS.ventClosedRaw),
        hysteresisClosePercent: finiteNumOrDefault(
            r.hysteresisClosePercent, DEFAULTS.hysteresisClosePercent, { min: 0, max: 100 },
        ),
        roomVentMap,
        ventBaseUrl: typeof r.ventBaseUrl === 'string' ? r.ventBaseUrl : undefined,
        pauseHrs: normalizedPauseHrsMap(r.pauseHrs, DEFAULTS.pauseHrs),
        timezone:
            typeof r.timezone === 'string' && r.timezone.trim() !== ''
                ? r.timezone.trim()
                : DEFAULTS.timezone,
        hvacPowerSensorZigbeeAddr:
            typeof r.hvacPowerSensorZigbeeAddr === 'string'
                ? r.hvacPowerSensorZigbeeAddr.trim()
                : DEFAULTS.hvacPowerSensorZigbeeAddr,
        hvacPowerActiveThresholdW: finiteNumOrDefault(
            r.hvacPowerActiveThresholdW, DEFAULTS.hvacPowerActiveThresholdW, { min: 0 },
        ),
        hvacPowerStaleAfterMs: finiteNumOrDefault(
            r.hvacPowerStaleAfterMs, DEFAULTS.hvacPowerStaleAfterMs, { min: 0 },
        ),
    };
}

/**
 * True when {@link hvacPowerW} was updated within `cfg.hvacPowerStaleAfterMs` of `nowMs`
 * and a power sensor address is configured.
 * @param {ReturnType<typeof getVentAutomationConfig>} cfg
 * @param {number} nowMs
 * @returns {boolean}
 */
function hasFreshHvacPowerReading(cfg, nowMs) {
    if (typeof cfg.hvacPowerSensorZigbeeAddr !== 'string' || cfg.hvacPowerSensorZigbeeAddr === '') {
        return false;
    }
    if (!isFiniteNum(hvacPowerW) || !isFiniteNum(hvacPowerLastUpdateMs)) {
        return false;
    }
    return (nowMs - hvacPowerLastUpdateMs) <= cfg.hvacPowerStaleAfterMs;
}

/**
 * @returns {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }>}
 */
function getReadingsSnapshotFromZigbee() {
    try {
        // Lazy require avoids circular load with tasmota.zigbee.controller.
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const z = require('../controllers/tasmota.zigbee.controller');
        if (typeof z.getReadingsSnapshot === 'function') {
            return z.getReadingsSnapshot();
        }
    } catch {
        /* ignore */
    }
    return {};
}

/**
 * Merge Zigbee snapshot with supplemental Wi-Fi readings (Wi-Fi wins per room when present).
 * @param {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }>} zigbeeSensors
 * @returns {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }>}
 */
function mergeSensors(zigbeeSensors) {
    /** @type {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }>} */
    const out = { ...zigbeeSensors };
    for (const [room, row] of Object.entries(wifiSupplementByRoom)) {
        if (row && isFiniteNum(row.temperature)) {
            const prev = out[room] ?? { temperature: null, lastUpdateMs: null };
            out[room] = {
                ...prev,
                temperature: row.temperature,
                lastUpdateMs: row.lastUpdateMs,
            };
        }
    }
    return out;
}

/**
 * @param {{ temperature?: number|null, lastUpdateMs?: number|null }} row
 * @param {number} nowMs
 * @returns {boolean}
 */
function isRedundantSensorOnline(row, nowMs) {
    if (row === null || typeof row !== 'object') {
        return false;
    }
    if (!isFiniteNum(row.temperature) || !isFiniteNum(row.lastUpdateMs)) {
        return false;
    }
    return nowMs - row.lastUpdateMs <= REDUNDANT_SENSOR_OFFLINE_MS;
}

/**
 * Average temperature/humidity for a redundant pair when both are online; otherwise the sole online sensor.
 * @param {{ temperature?: number|null, lastUpdateMs?: number|null, humidity?: number|null }} primaryRow
 * @param {{ temperature?: number|null, lastUpdateMs?: number|null, humidity?: number|null }} altRow
 * @param {number} nowMs
 * @returns {{ temperature: number|null, humidity: number|null, lastUpdateMs: number|null }}
 */
function combineRedundantRoomReadings(primaryRow, altRow, nowMs) {
    const p = primaryRow && typeof primaryRow === 'object' ? primaryRow : {};
    const a = altRow && typeof altRow === 'object' ? altRow : {};
    const pOnline = isRedundantSensorOnline(p, nowMs);
    const aOnline = isRedundantSensorOnline(a, nowMs);

    if (pOnline && aOnline) {
        const pt = p.temperature;
        const at = a.temperature;
        const temperature = isFiniteNum(pt) && isFiniteNum(at)
            ? roundToOneDecimal((pt + at) / 2)
            : null;
        const ph = isFiniteNum(p.humidity) ? p.humidity : null;
        const ah = isFiniteNum(a.humidity) ? a.humidity : null;
        const humidity = ph !== null && ah !== null
            ? roundToOneDecimal((ph + ah) / 2)
            : (ph ?? ah);
        const plu = typeof p.lastUpdateMs === 'number' ? p.lastUpdateMs : 0;
        const alu = typeof a.lastUpdateMs === 'number' ? a.lastUpdateMs : 0;
        return { temperature, humidity, lastUpdateMs: Math.max(plu, alu) };
    }

    const online = pOnline ? p : aOnline ? a : null;
    if (!online) {
        return { temperature: null, humidity: null, lastUpdateMs: null };
    }
    return {
        temperature: isFiniteNum(online.temperature) ? online.temperature : null,
        humidity: isFiniteNum(online.humidity) ? online.humidity : null,
        lastUpdateMs: typeof online.lastUpdateMs === 'number' ? online.lastUpdateMs : null,
    };
}

/**
 * Replace primary room rows with averaged (or fallback) readings when a redundant alt sensor exists.
 * @param {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }>} sensorsByRoom
 * @returns {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }>}
 */
function applyRedundancyMerge(sensorsByRoom) {
    const nowMs = Date.now();
    /** @type {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }>} */
    const out = { ...sensorsByRoom };

    for (const alt of Object.keys(sensorsByRoom)) {
        const primary = primaryRoomFromRedundantAltLabel(alt);
        if (primary === null) {
            continue;
        }
        const primaryRow = sensorsByRoom[primary] ?? { temperature: null, lastUpdateMs: null, humidity: null };
        const altRow = sensorsByRoom[alt] ?? { temperature: null, lastUpdateMs: null, humidity: null };
        const c = combineRedundantRoomReadings(primaryRow, altRow, nowMs);
        out[primary] = {
            ...primaryRow,
            temperature: c.temperature,
            humidity: c.humidity,
            lastUpdateMs: c.lastUpdateMs,
        };
    }
    return out;
}

/**
 * @param {{ temperature?: number|null, lastUpdateMs?: number|null, humidity?: number|null, batteryLevel?: number|null, linkQuality?: number|null }|undefined} row
 * @returns {{ temperatureC: number|null, humidity: number|null, lastUpdateMs: number|null, battery: number|null, signal: number|null }}
 */
function sensorRowToDashboardFields(row) {
    if (!row || typeof row !== 'object') {
        return { temperatureC: null, humidity: null, lastUpdateMs: null, battery: null, signal: null };
    }
    return {
        temperatureC: isFiniteNum(row.temperature) ? row.temperature : null,
        humidity: isFiniteNum(row.humidity) ? row.humidity : null,
        lastUpdateMs: typeof row.lastUpdateMs === 'number' ? row.lastUpdateMs : null,
        battery: isFiniteNum(row.batteryLevel) ? row.batteryLevel : null,
        signal: isFiniteNum(row.linkQuality) ? row.linkQuality : null,
    };
}

/**
 * True while the manual API override timer is active or the room's configured {@link getVentAutomationConfig}'s `pauseHrs` window applies.
 * @param {number|string} motorId
 * @returns {boolean}
 */
function isManualOverrideActive(motorId) {
    const now = Date.now();
    const until = manualOverrideUntilByMotor[String(motorId)] ?? 0;
    if (now < until) {
        return true;
    }
    return isPauseHoursActiveForMotor(getVentAutomationConfig(), motorId, now);
}

/**
 * @param {number|string} motorId
 * @returns {void}
 */
function recordManualOverride(motorId) {
    const cfg = getVentAutomationConfig();
    manualOverrideUntilByMotor[String(motorId)] = Date.now() + cfg.manualOverrideMs;
}

/**
 * Cancel any active manual override for the motor mapped to `room`.
 * @param {string} room
 * @returns {void}
 */
function clearManualOverrideForRoom(room) {
    const cfg = getVentAutomationConfig();
    const motorId = parseMotorId(cfg.roomVentMap[room]);
    if (motorId === null) {
        return;
    }
    delete manualOverrideUntilByMotor[String(motorId)];
}

/**
 * Vent command for a room from temperature bands. Full open / full close use `ventOpenRaw` / `ventClosedRaw`;
 * the hysteresis band uses `hysteresisBandCmd` only when the temperature entered the band from the fully-open
 * side (directional hysteresis via `prevCmd`). When entering from the closed side the vent stays closed.
 *
 * Reopen hysteresis: once the vent has stepped down to `hysteresisBandCmd`, the room must exceed the target by
 * at least `roomHysteresisC` (cooling) / fall at least `roomHysteresisC` below the target (heating) before the
 * vent returns to `ventOpenRaw`. This prevents rapid 50%↔100% flapping when the temperature oscillates by a
 * fraction of a degree around the target.
 *
 * @param {'cooling'|'heating'} mode
 * @param {number} roomTempC
 * @param {number} coolTargetC
 * @param {number} heatTargetC
 * @param {number} roomHysteresisC
 * @param {number} hysteresisBandCmd 0–100 along closed→open.
 * @param {number} ventOpenRaw
 * @param {number} ventClosedRaw
 * @param {number} [prevCmd] Previous automation command for this room (undefined on first evaluation).
 * @returns {number}
 */
function ventTargetForRoom(
    mode,
    roomTempC,
    coolTargetC,
    heatTargetC,
    roomHysteresisC,
    hysteresisBandCmd,
    ventOpenRaw,
    ventClosedRaw,
    prevCmd,
) {
    const atBand = prevCmd === hysteresisBandCmd;
    if (mode === 'cooling') {
        const lowC = coolTargetC - roomHysteresisC;
        const reopenThresholdC = atBand ? coolTargetC + roomHysteresisC : coolTargetC;
        if (roomTempC > reopenThresholdC) {
            return ventOpenRaw;
        }
        if (roomTempC >= lowC) {
            if (prevCmd !== undefined && prevCmd !== ventOpenRaw && prevCmd !== hysteresisBandCmd) {
                return ventClosedRaw;
            }
            return hysteresisBandCmd;
        }
        return ventClosedRaw;
    }
    if (mode === 'heating') {
        const highH = heatTargetC + roomHysteresisC;
        const reopenThresholdC = atBand ? heatTargetC - roomHysteresisC : heatTargetC;
        if (roomTempC < reopenThresholdC) {
            return ventOpenRaw;
        }
        if (roomTempC <= highH) {
            if (prevCmd !== undefined && prevCmd !== ventOpenRaw && prevCmd !== hysteresisBandCmd) {
                return ventClosedRaw;
            }
            return hysteresisBandCmd;
        }
        return ventClosedRaw;
    }
    return ventClosedRaw;
}

/**
 * Per-room comfort target for vent open/close (same semantics as global `coolTargetC`/`heatTargetC` for that room only).
 * @param {string} room
 * @param {number} nowMs
 * @param {{ coolTargetC: number, heatTargetC: number }} globalTargets
 * @returns {{ coolTargetC: number, heatTargetC: number }}
 */
function effectiveRoomBandTargets(room, nowMs, globalTargets) {
    const o = roomTargetOverrideByRoom[room];
    if (
        o
        && isFiniteNum(o.targetC)
        && isFiniteNum(o.untilMs)
        && nowMs < o.untilMs
    ) {
        return { coolTargetC: o.targetC, heatTargetC: o.targetC };
    }
    return globalTargets;
}

/**
 * Set a single room's target temperature for a temporary duration (vent automation only).
 * When `durationMs` is omitted, `roomTargetOverrideDurationMs` from config is used.
 * @param {string} room Room key matching `roomVentMap`.
 * @param {number} targetC Target temperature (C).
 * @param {number} [durationMs] Optional override duration in milliseconds.
 * @returns {{ ok: true, untilMs: number } | { ok: false, error: string }}
 */
function setRoomTargetTemperatureTemporary(room, targetC, durationMs) {
    if (typeof room !== 'string' || room.trim() === '') {
        return { ok: false, error: 'invalid_room' };
    }
    const trimmed = room.trim();
    if (!isFiniteNum(targetC)) {
        return { ok: false, error: 'invalid_targetC' };
    }
    const cfg = getVentAutomationConfig();
    if (!Object.prototype.hasOwnProperty.call(cfg.roomVentMap, trimmed)) {
        return { ok: false, error: 'unknown_room' };
    }
    const overrideDurationMs = isFiniteNum(durationMs) && durationMs >= 0
        ? durationMs
        : cfg.roomTargetOverrideDurationMs;
    const untilMs = Date.now() + overrideDurationMs;
    clearManualOverrideForRoom(trimmed);
    roomTargetOverrideByRoom[trimmed] = { targetC, untilMs };
    return { ok: true, untilMs };
}

/**
 * Drop any stored per-room target for `room` so global band targets apply again.
 * @param {string} room Room key matching `roomVentMap`.
 * @returns {{ ok: true, hadActiveOverride: boolean } | { ok: false, error: string }}
 */
function clearRoomTargetTemperatureOverride(room) {
    if (typeof room !== 'string' || room.trim() === '') {
        return { ok: false, error: 'invalid_room' };
    }
    const trimmed = room.trim();
    const cfg = getVentAutomationConfig();
    if (!Object.prototype.hasOwnProperty.call(cfg.roomVentMap, trimmed)) {
        return { ok: false, error: 'unknown_room' };
    }
    const hadActiveOverride = getRoomTargetOverride(trimmed) !== null;
    clearManualOverrideForRoom(trimmed);
    delete roomTargetOverrideByRoom[trimmed];
    return { ok: true, hadActiveOverride };
}

/**
 * @param {string} room
 * @param {number} [nowMs]
 * @returns {{ targetC: number, untilMs: number }|null}
 */
function getRoomTargetOverride(room, nowMs = Date.now()) {
    const o = roomTargetOverrideByRoom[room];
    if (!o || !isFiniteNum(o.targetC) || !isFiniteNum(o.untilMs)) {
        return null;
    }
    if (nowMs >= o.untilMs) {
        return null;
    }
    return { targetC: o.targetC, untilMs: o.untilMs };
}

/**
 * Resolve the controller-room HVAC band.
 *
 * When a fresh reading from the configured fan power monitor is available
 * (see {@link ingestHvacPowerReading}), the result is **gated by power**:
 * - Power **&lt;** `hvacPowerActiveThresholdW` → always `idle`.
 * - Power **≥** `hvacPowerActiveThresholdW` → always `heating` or `cooling` (never `idle`).
 *   When the controller temperature is outside the idle band, that direction wins
 *   (and is remembered as {@link lastActiveTempBasedHvacMode}). When the temperature
 *   is inside the idle band, the last remembered active direction is returned (falling
 *   back to the closest band edge if no prior active mode is known).
 *
 * Without a fresh power reading this falls back to the temperature-only behaviour:
 * idle is between `heatTargetC + roomHysteresisC` and `coolTargetC - roomHysteresisC`,
 * above `coolBandC` is `cooling`, below `heatBandC` is `heating`.
 *
 * When the controller sits inside the idle band but power says HVAC is active, all
 * supplied room sensors (whose `lastUpdateMs` is within `REDUNDANT_SENSOR_OFFLINE_MS`)
 * are scanned: the one with the greatest margin outside the hysteresis-adjusted band
 * (`heatBandC`..`coolBandC`) decides the direction (above → `cooling`, below →
 * `heating`). Stale rows are skipped. If no fresh sensor is outside the band, the
 * previously remembered active mode (or a mid-band fallback) is used.
 *
 * @param {number} controllerTempC
 * @param {number} heatTargetC
 * @param {number} coolTargetC
 * @param {number} [roomHysteresisC=0]
 * @param {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>} [sensorsByRoom]
 *   Optional per-room sensor snapshot used to disambiguate direction when the
 *   controller temperature is inside the idle band but HVAC power is active.
 * @returns {'cooling'|'heating'|'idle'}
 */
function resolveVentAutomationHvacMode(controllerTempC, heatTargetC, coolTargetC, roomHysteresisC = 0, sensorsByRoom) {
    const h = isFiniteNum(roomHysteresisC) ? roomHysteresisC : 0;
    const coolBandC = coolTargetC - h;
    const heatBandC = heatTargetC + h;
    /** @type {'cooling'|'heating'|'idle'} */
    let tempBasedMode;
    if (controllerTempC >= heatBandC && controllerTempC <= coolBandC) {
        tempBasedMode = 'idle';
    } else if (controllerTempC > coolBandC) {
        tempBasedMode = 'cooling';
    } else {
        tempBasedMode = 'heating';
    }
    if (tempBasedMode !== 'idle') {
        lastActiveTempBasedHvacMode = tempBasedMode;
    }

    const cfg = getVentAutomationConfig();
    const nowMs = Date.now();
    if (!hasFreshHvacPowerReading(cfg, nowMs)) {
        return tempBasedMode;
    }

    if (/** @type {number} */ (hvacPowerW) < cfg.hvacPowerActiveThresholdW) {
        return 'idle';
    }
    if (tempBasedMode !== 'idle') {
        return tempBasedMode;
    }

    // Controller is inside the idle band but HVAC power is active: pick the
    // direction from whichever room sensor sits furthest outside the band.
    if (sensorsByRoom !== null && typeof sensorsByRoom === 'object') {
        /** @type {number|null} */
        let maxTempC = null;
        /** @type {number|null} */
        let minTempC = null;
        for (const key of Object.keys(sensorsByRoom)) {
            const row = sensorsByRoom[key];
            if (row === null || typeof row !== 'object') {
                continue;
            }
            const lastUpdateMs = row.lastUpdateMs;
            if (!isFiniteNum(lastUpdateMs)
                || nowMs - /** @type {number} */ (lastUpdateMs) > REDUNDANT_SENSOR_OFFLINE_MS) {
                continue;
            }
            const t = readRowTemp(row);
            if (!isFiniteNum(t)) {
                continue;
            }
            const tempC = /** @type {number} */ (t);
            if (maxTempC === null || tempC > maxTempC) {
                maxTempC = tempC;
            }
            if (minTempC === null || tempC < minTempC) {
                minTempC = tempC;
            }
        }
        if (maxTempC !== null && minTempC !== null) {
            const coolMargin = maxTempC - coolBandC;
            const heatMargin = heatBandC - minTempC;
            if (coolMargin > 0 && coolMargin >= heatMargin) {
                return 'cooling';
            }
            if (heatMargin > 0 && heatMargin > coolMargin) {
                return 'heating';
            }
        }
    }

    if (lastActiveTempBasedHvacMode !== null) {
        return lastActiveTempBasedHvacMode;
    }
    const midC = (heatTargetC + coolTargetC) / 2;
    return controllerTempC >= midC ? 'cooling' : 'heating';
}

/**
 * When raw mode is heating or cooling, refreshes the hold window and returns that mode.
 * When raw mode is idle, returns the held mode until {@link ventHvacActiveHoldUntilMs}, then idle.
 *
 * If a fresh power reading is available, the time-based hold is bypassed entirely:
 * the power monitor is authoritative for HVAC active/idle status, so a raw `idle`
 * is returned immediately (held state is also cleared so it doesn't resurface later).
 *
 * @param {'cooling'|'heating'|'idle'} rawMode
 * @param {number} holdAfterActiveMs Hold duration in ms; 0 disables idle hold.
 * @param {number} nowMs
 * @returns {'cooling'|'heating'|'idle'}
 */
function applyVentAutomationHvacIdleHold(rawMode, holdAfterActiveMs, nowMs) {
    const holdMs = isFiniteNum(holdAfterActiveMs) && holdAfterActiveMs > 0
        ? holdAfterActiveMs
        : 0;
    if (rawMode === 'heating' || rawMode === 'cooling') {
        ventHvacActiveHoldUntilMs = nowMs + holdMs;
        ventHvacHeldMode = rawMode;
        return rawMode;
    }
    if (hasFreshHvacPowerReading(getVentAutomationConfig(), nowMs)) {
        ventHvacActiveHoldUntilMs = null;
        ventHvacHeldMode = null;
        return 'idle';
    }
    if (holdMs > 0 && ventHvacHeldMode !== null && ventHvacActiveHoldUntilMs !== null && nowMs < ventHvacActiveHoldUntilMs) {
        return ventHvacHeldMode;
    }
    ventHvacActiveHoldUntilMs = null;
    ventHvacHeldMode = null;
    return 'idle';
}

/**
 * Record a new reading from the HVAC fan power monitor (in watts). Triggers a fresh
 * automation tick when the reported active/idle state flips so vents react immediately
 * to the HVAC turning on or off.
 *
 * @param {number} watts Instantaneous power draw in W.
 * @returns {Promise<void>}
 */
async function ingestHvacPowerReading(watts) {
    if (!isFiniteNum(watts)) {
        return;
    }
    const cfg = getVentAutomationConfig();
    const nowMs = Date.now();
    const wasActive = hasFreshHvacPowerReading(cfg, nowMs)
        && /** @type {number} */ (hvacPowerW) >= cfg.hvacPowerActiveThresholdW;
    hvacPowerW = watts;
    hvacPowerLastUpdateMs = nowMs;
    const isActive = watts >= cfg.hvacPowerActiveThresholdW;
    if (wasActive !== isActive) {
        await runAutomationTickFromSnapshot();
    }
}

/**
 * @param {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>} sensorsByRoom
 * @returns {Promise<void>}
 */
async function evaluateAndAct(sensorsByRoom) {
    const cfg = getVentAutomationConfig();
    if (!cfg.enabled) {
        return;
    }
    const now = Date.now();
    lastAutomationEvaluationAt = now;

    const merged = applyRedundancyMerge(mergeSensors(sensorsByRoom));
    const stairName = cfg.controllerRoomName;
    const stairTemp = readRowTemp(merged[stairName]);
    if (stairTemp === null) {
        return;
    }

    const { coolTargetC, heatTargetC, roomHysteresisC, hvacModeIdleHoldAfterActiveMs } = cfg;
    const rawHvacMode = resolveVentAutomationHvacMode(stairTemp, heatTargetC, coolTargetC, roomHysteresisC, merged);
    const currHvacMode = applyVentAutomationHvacIdleHold(rawHvacMode, hvacModeIdleHoldAfterActiveMs, now);
    const prevHvacMode = lastVentAutomationHvacMode;
    if (
        (prevHvacMode === 'cooling' && currHvacMode === 'heating')
        || (prevHvacMode === 'heating' && currHvacMode === 'cooling')
    ) {
        for (const key of Object.keys(roomTargetOverrideByRoom)) {
            delete roomTargetOverrideByRoom[key];
        }
        for (const key of Object.keys(lastAutomationCmdByRoom)) {
            delete lastAutomationCmdByRoom[key];
        }
    }
    lastVentAutomationHvacMode = currHvacMode;

    const roomVentMap = cfg.roomVentMap;
    if (!roomVentMap || typeof roomVentMap !== 'object' || Object.keys(roomVentMap).length === 0) {
        return;
    }

    if (currHvacMode === 'idle') {
        return;
    }

    const ventPayload = await ventClient.getVentStatus();
    if (!ventPayload || typeof ventPayload !== 'object') {
        console.warn('Vent automation: skipped tick (no status)');
        return;
    }

    const globalTargets = { coolTargetC, heatTargetC };
    const posMatchTol = 3;

    for (const [roomName, motorIdRaw] of Object.entries(roomVentMap)) {
        if (roomName === stairName) {
            continue;
        }
        const motorId = parseMotorId(motorIdRaw);
        if (motorId === null) {
            continue;
        }
        if (isManualOverrideActive(motorId)) {
            continue;
        }

        const roomTemp = readRowTemp(merged[roomName]);
        if (roomTemp === null) {
            continue;
        }

        const eff = effectiveRoomBandTargets(roomName, now, globalTargets);
        const targetRaw = ventTargetForRoom(
            currHvacMode,
            roomTemp,
            eff.coolTargetC,
            eff.heatTargetC,
            roomHysteresisC,
            cfg.hysteresisClosePercent,
            cfg.ventOpenRaw,
            cfg.ventClosedRaw,
            lastAutomationCmdByRoom[roomName],
        );
        lastAutomationCmdByRoom[roomName] = targetRaw;

        const pos = ventClient.readMotorPos(ventPayload, motorId);
        if (pos === null) {
            continue;
        }

        if (Math.abs(pos - targetRaw) <= posMatchTol) {
            continue;
        }
        const { ok } = await ventClient.setVentMotorRaw(motorId, targetRaw);
        const openR = Math.round(cfg.ventOpenRaw);
        const closedR = Math.round(cfg.ventClosedRaw);
        const action =
            Math.abs(targetRaw - openR) <= posMatchTol ? 'open'
                : Math.abs(targetRaw - closedR) <= posMatchTol ? 'close'
                : 'set';
        ventActionLog.append({
            source: 'automation',
            action,
            motorId,
            roomName,
            success: ok,
            targetRaw,
            mode: currHvacMode,
            controllerTempC: stairTemp,
            roomTempC: roomTemp,
            posBefore: pos,
        });
    }
}

/**
 * Run automation from current Zigbee + MQTT SENSOR/RESULT snapshot.
 * @param {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>} sensorsByRoom Zigbee snapshot (not mutated).
 * @returns {Promise<void>}
 */
async function onSensorTelegram(sensorsByRoom) {
    await evaluateAndAct(sensorsByRoom);
}

/**
 * Run one automation evaluation from the current Zigbee snapshot (e.g. after config or room target change).
 * @returns {Promise<void>}
 */
async function runAutomationTickFromSnapshot() {
    await evaluateAndAct(getReadingsSnapshotFromZigbee());
}

/**
 * Snapshot for dashboards: per-room temps and optional vent fields, mode, targets, and recent log stats.
 * Refreshes vent hardware once via {@link ventClient.getVentStatus}.
 * @returns {Promise<Record<string, unknown>>}
 */
async function getAutomationDashboard() {
    const cfg = getVentAutomationConfig();
    const rawMerged = mergeSensors(getReadingsSnapshotFromZigbee());
    const merged = applyRedundancyMerge(rawMerged);
    const stairName = cfg.controllerRoomName;
    const controllerTempC = readRowTemp(merged[stairName]);

    const nowDash = Date.now();
    /** @type {'idle'|'cooling'|'heating'|'unknown'|'disabled'} */
    let rawMode;
    if (!cfg.enabled) {
        rawMode = 'disabled';
    } else if (!isFiniteNum(controllerTempC)) {
        rawMode = 'unknown';
    } else {
        rawMode = resolveVentAutomationHvacMode(
            controllerTempC,
            cfg.heatTargetC,
            cfg.coolTargetC,
            cfg.roomHysteresisC,
            merged,
        );
    }
    const mode = rawMode === 'idle' || rawMode === 'cooling' || rawMode === 'heating'
        ? applyVentAutomationHvacIdleHold(rawMode, cfg.hvacModeIdleHoldAfterActiveMs, nowDash)
        : rawMode;

    await ventClient.getVentStatus();
    const ventPayload = ventClient.getCachedVentPayload();

    const globalTargets = { coolTargetC: cfg.coolTargetC, heatTargetC: cfg.heatTargetC };

    /** @type {Map<string, Record<string, unknown>>} */
    const ventFieldsByRoom = new Map();
    for (const [roomName, motorIdRaw] of Object.entries(cfg.roomVentMap)) {
        const motorId = parseMotorId(motorIdRaw);
        if (motorId === null) {
            continue;
        }
        const until = manualOverrideUntilByMotor[String(motorId)] ?? 0;
        const manualTimerActive = nowDash < until;
        const manualOverrideActive = manualTimerActive || isPauseHoursActiveForMotor(cfg, motorId, nowDash);
        const slot = ventClient.readMotorSlot(ventPayload, motorId);
        const roomTemp = readRowTemp(merged[roomName]);
        const eff = effectiveRoomBandTargets(roomName, nowDash, globalTargets);
        let ventTargetOpenPercent = null;
        let wantOpen = null;
        if ((mode === 'cooling' || mode === 'heating') && isFiniteNum(roomTemp)) {
            ventTargetOpenPercent = ventTargetForRoom(
                mode,
                roomTemp,
                eff.coolTargetC,
                eff.heatTargetC,
                cfg.roomHysteresisC,
                cfg.hysteresisClosePercent,
                cfg.ventOpenRaw,
                cfg.ventClosedRaw,
                lastAutomationCmdByRoom[roomName],
            );
            wantOpen = ventTargetOpenPercent > 0;
        }
        const isOpen = slot !== null && slot.pos > 0;
        const rtOverride = getRoomTargetOverride(roomName, nowDash);
        ventFieldsByRoom.set(roomName, {
            motorId,
            displayName: slot?.name ?? null,
            pos: slot?.pos ?? null,
            isOpen,
            wantOpen,
            ventTargetOpenPercent,
            manualOverrideActive,
            manualOverrideUntilMs: manualTimerActive ? until : null,
            roomTargetOverrideC: rtOverride?.targetC ?? null,
            roomTargetOverrideUntilMs: rtOverride?.untilMs ?? null,
        });
    }

    /** @type {Array<Record<string, unknown>>} */
    const rooms = [];
    const roomNames = new Set([...Object.keys(merged), ...Object.keys(cfg.roomVentMap)]);
    for (const room of roomNames) {
        if (isRedundantAltSensorLabel(room)) {
            continue;
        }
        const row = merged[room] ?? { temperature: null, lastUpdateMs: null };
        const temp = row.temperature;
        const fromWifi = Object.prototype.hasOwnProperty.call(wifiSupplementByRoom, room);
        const primaryDash = sensorRowToDashboardFields(rawMerged[room]);
        /** @type {Record<string, unknown>} */
        const entry = {
            room,
            temperatureC: isFiniteNum(temp) ? temp : null,
            humidity: isFiniteNum(row.humidity) ? row.humidity : null,
            lastUpdateMs: typeof row.lastUpdateMs === 'number' ? row.lastUpdateMs : null,
            temperatureSource: fromWifi ? 'wifi' : 'zigbee',
            battery: primaryDash.battery,
            signal: primaryDash.signal,
        };
        const altLabel = redundantAltLabelForPrimaryRoom(room);
        if (Object.prototype.hasOwnProperty.call(rawMerged, altLabel)) {
            const aRaw = sensorRowToDashboardFields(rawMerged[altLabel]);
            entry.sensorPrimaryTemperatureC = primaryDash.temperatureC;
            entry.sensorAltTemperatureC = aRaw.temperatureC;
            entry.sensorPrimaryHumidity = primaryDash.humidity;
            entry.sensorAltHumidity = aRaw.humidity;
            entry.sensorPrimaryLastUpdateMs = primaryDash.lastUpdateMs;
            entry.sensorAltLastUpdateMs = aRaw.lastUpdateMs;
            entry.batteryAlt = aRaw.battery;
            entry.signalAlt = aRaw.signal;
        }
        const ventExtra = ventFieldsByRoom.get(room);
        rooms.push(ventExtra ? { ...entry, ...ventExtra } : entry);
    }
    rooms.sort((a, b) => String(a.room).localeCompare(String(b.room)));

    const MS_DAY = 86400000;
    const since = nowDash - MS_DAY;
    const actions = ventActionLog.getEntriesNewestFirst();
    let actionsLast24h = 0;
    let automationActionsLast24h = 0;
    let manualActionsLast24h = 0;
    let failedActionsLast24h = 0;
    for (const a of actions) {
        if (a.at < since) break;
        actionsLast24h++;
        if (a.source === 'automation') automationActionsLast24h++;
        else if (a.source === 'manual') manualActionsLast24h++;
        if (!a.success) failedActionsLast24h++;
    }

    const powerFresh = hasFreshHvacPowerReading(cfg, nowDash);
    return {
        mode,
        automationEnabled: cfg.enabled,
        controllerTempC,
        targets: {
            coolTargetC: cfg.coolTargetC,
            heatTargetC: cfg.heatTargetC,
            roomHysteresisC: cfg.roomHysteresisC,
            hysteresisClosePercent: cfg.hysteresisClosePercent,
            ventOpenRaw: cfg.ventOpenRaw,
            ventClosedRaw: cfg.ventClosedRaw,
        },
        hvacPower: {
            thresholdW: cfg.hvacPowerActiveThresholdW,
            powerW: isFiniteNum(hvacPowerW) ? hvacPowerW : null,
            lastUpdateMs: hvacPowerLastUpdateMs,
            fresh: powerFresh,
            active: powerFresh && /** @type {number} */ (hvacPowerW) >= cfg.hvacPowerActiveThresholdW,
            lastActiveTempBasedHvacMode,
        },
        rooms,
        lastAutomationEvaluationAt,
        statistics: {
            actionsLast24h,
            automationActionsLast24h,
            manualActionsLast24h,
            failedActionsLast24h,
        },
    };
}

/**
 * Record a supplemental room temperature (e.g. Wi-Fi sensor array) and run the same evaluation as Zigbee-driven updates.
 * @param {string} room Room label matching `roomVentMap` / Zigbee names.
 * @param {number} temperatureC Temperature in °C.
 * @returns {Promise<void>}
 */
async function ingestRoomReading(room, temperatureC) {
    if (typeof room !== 'string' || room.trim() === '') {
        return;
    }
    if (!isFiniteNum(temperatureC)) {
        return;
    }
    wifiSupplementByRoom[room] = { temperature: temperatureC, lastUpdateMs: Date.now() };
    const zig = getReadingsSnapshotFromZigbee();
    await evaluateAndAct(zig);
}

module.exports = {
    getVentAutomationConfig,
    recordManualOverride,
    onSensorTelegram,
    ingestRoomReading,
    ingestHvacPowerReading,
    getAutomationDashboard,
    setRoomTargetTemperatureTemporary,
    clearRoomTargetTemperatureOverride,
    runAutomationTickFromSnapshot,
};
