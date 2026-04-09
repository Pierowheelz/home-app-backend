const ventClient = require('../lib/vent.client');
const ventActionLog = require('./vent.action.log');

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

/** @type {Record<string, { targetC: number, untilMs: number }>} */
const roomTargetOverrideByRoom = {};

/**
 * Redundant Zigbee alt rows use the primary room name plus this suffix (see {@link isRedundantAltSensorLabel}).
 * @type {string}
 */
const REDUNDANT_ALT_SENSOR_SUFFIX = ' (alt)';

/**
 * @param {string} roomRowKey
 * @returns {boolean}
 */
function isRedundantAltSensorLabel(roomRowKey) {
    return typeof roomRowKey === 'string' && / \(alt\)$/.test(roomRowKey);
}

/**
 * @param {string} altRowKey
 * @returns {string|null} Primary room label, or null if `altRowKey` does not match `/^(.+) \(alt\)$/`.
 */
function primaryRoomFromRedundantAltLabel(altRowKey) {
    if (typeof altRowKey !== 'string') {
        return null;
    }
    const m = /^(.*) \(alt\)$/.exec(altRowKey);
    return m !== null && m[1].length > 0 ? m[1] : null;
}

/**
 * @param {string} primaryRoom
 * @returns {string}
 */
function redundantAltLabelForPrimaryRoom(primaryRoom) {
    return primaryRoom + REDUNDANT_ALT_SENSOR_SUFFIX;
}

/** Stale-after: if no temperature telegram within this window, redundant pair member is excluded from averaging. */
const REDUNDANT_SENSOR_OFFLINE_MS = 30 * 60 * 1000;

/**
 * @param {number} n
 * @returns {number}
 */
function roundToOneDecimal(n) {
    return Math.round(n * 10) / 10;
}

/**
 * @param {unknown} x
 * @returns {x is number}
 */
function isFiniteNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Return `val` if it is a finite number passing optional constraints, otherwise `fallback`.
 * @param {unknown} val
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [constraints]
 * @returns {number}
 */
function finiteNumOrDefault(val, fallback, constraints) {
    if (!isFiniteNum(val)) return fallback;
    if (constraints) {
        if (constraints.min !== undefined && val < constraints.min) return fallback;
        if (constraints.max !== undefined && val > constraints.max) return fallback;
    }
    return val;
}

/**
 * Parse a raw motorId (number or string) into a finite number, or null.
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseMotorId(raw) {
    const id = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(id) ? id : null;
}

/**
 * Extract a finite temperature from a sensor row, or null.
 * @param {{ temperature?: number|null }|null|undefined} row
 * @returns {number|null}
 */
function readRowTemp(row) {
    if (!row || typeof row !== 'object') return null;
    return isFiniteNum(row.temperature) ? row.temperature : null;
}

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
};

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
    };
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
 * @param {number|string} motorId
 * @returns {boolean}
 */
function isManualOverrideActive(motorId) {
    const until = manualOverrideUntilByMotor[String(motorId)] ?? 0;
    return Date.now() < until;
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
 * the hysteresis band interpolates between them using `hysteresisBandCmd` as 0–100 along that span.
 * @param {'cooling'|'heating'} mode
 * @param {number} roomTempC
 * @param {number} coolTargetC
 * @param {number} heatTargetC
 * @param {number} roomHysteresisC
 * @param {number} hysteresisBandCmd 0–100 along closed→open.
 * @param {number} ventOpenRaw
 * @param {number} ventClosedRaw
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
) {
    if (mode === 'cooling') {
        const lowC = coolTargetC - roomHysteresisC;
        if (roomTempC > coolTargetC) {
            return ventOpenRaw;
        }
        if (roomTempC >= lowC && roomTempC <= coolTargetC) {
            return hysteresisBandCmd;
        }
        return ventClosedRaw;
    }
    if (mode === 'heating') {
        const highH = heatTargetC + roomHysteresisC;
        if (roomTempC < heatTargetC) {
            return ventOpenRaw;
        }
        if (roomTempC >= heatTargetC && roomTempC <= highH) {
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
 * Controller-room band from temperature (single source of truth for hysteresis bands).
 * Idle is between `heatTargetC + roomHysteresisC` and `coolTargetC - roomHysteresisC`
 * (aligned with per-room `heatRoomTarget` / `coolRoomTarget`). {@link resolveHvacMode} delegates here after guards.
 * @param {number} controllerTempC
 * @param {number} heatTargetC
 * @param {number} coolTargetC
 * @param {number} [roomHysteresisC=0]
 * @returns {'cooling'|'heating'|'idle'}
 */
function resolveVentAutomationHvacMode(controllerTempC, heatTargetC, coolTargetC, roomHysteresisC = 0) {
    const h = isFiniteNum(roomHysteresisC) ? roomHysteresisC : 0;
    const coolBandC = coolTargetC - h;
    const heatBandC = heatTargetC + h;
    if (controllerTempC >= heatBandC && controllerTempC <= coolBandC) {
        return 'idle';
    }
    if (controllerTempC > coolBandC) {
        return 'cooling';
    }
    return 'heating';
}

/**
 * When raw mode is heating or cooling, refreshes the hold window and returns that mode.
 * When raw mode is idle, returns the held mode until {@link ventHvacActiveHoldUntilMs}, then idle.
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
    if (holdMs > 0 && ventHvacHeldMode !== null && ventHvacActiveHoldUntilMs !== null && nowMs < ventHvacActiveHoldUntilMs) {
        return ventHvacHeldMode;
    }
    ventHvacActiveHoldUntilMs = null;
    ventHvacHeldMode = null;
    return 'idle';
}

/**
 * @returns {void}
 */
function clearAllRoomTargetOverrides() {
    for (const key of Object.keys(roomTargetOverrideByRoom)) {
        delete roomTargetOverrideByRoom[key];
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
    const rawHvacMode = resolveVentAutomationHvacMode(stairTemp, heatTargetC, coolTargetC, roomHysteresisC);
    const currHvacMode = applyVentAutomationHvacIdleHold(rawHvacMode, hvacModeIdleHoldAfterActiveMs, now);
    const prevHvacMode = lastVentAutomationHvacMode;
    if (
        (prevHvacMode === 'cooling' && currHvacMode === 'heating')
        || (prevHvacMode === 'heating' && currHvacMode === 'cooling')
    ) {
        clearAllRoomTargetOverrides();
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
        );

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
 * HVAC mode for dashboards: disabled/unknown guards, then {@link resolveVentAutomationHvacMode}.
 * @param {boolean} enabled
 * @param {{ coolTargetC: number, heatTargetC: number, roomHysteresisC?: number }} targets
 * @param {number|null} controllerTempC
 * @returns {'idle'|'cooling'|'heating'|'unknown'|'disabled'}
 */
function resolveHvacMode(enabled, targets, controllerTempC) {
    if (!enabled) {
        return 'disabled';
    }
    if (!isFiniteNum(controllerTempC)) {
        return 'unknown';
    }
    const { coolTargetC, heatTargetC, roomHysteresisC } = targets;
    return resolveVentAutomationHvacMode(controllerTempC, heatTargetC, coolTargetC, roomHysteresisC);
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
    const rawMode = resolveHvacMode(cfg.enabled, {
        coolTargetC: cfg.coolTargetC,
        heatTargetC: cfg.heatTargetC,
        roomHysteresisC: cfg.roomHysteresisC,
    }, controllerTempC);
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
        const manualOverrideActive = nowDash < until;
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
            manualOverrideUntilMs: manualOverrideActive ? until : null,
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
    getAutomationDashboard,
    setRoomTargetTemperatureTemporary,
    clearRoomTargetTemperatureOverride,
    runAutomationTickFromSnapshot,
};
