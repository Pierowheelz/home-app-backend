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
        coolTargetC: typeof r.coolTargetC === 'number' && Number.isFinite(r.coolTargetC)
            ? r.coolTargetC
            : DEFAULTS.coolTargetC,
        heatTargetC: typeof r.heatTargetC === 'number' && Number.isFinite(r.heatTargetC)
            ? r.heatTargetC
            : DEFAULTS.heatTargetC,
        roomHysteresisC: typeof r.roomHysteresisC === 'number' && Number.isFinite(r.roomHysteresisC)
            ? r.roomHysteresisC
            : DEFAULTS.roomHysteresisC,
        hvacModeIdleHoldAfterActiveMs:
            typeof r.hvacModeIdleHoldAfterActiveMs === 'number'
                && Number.isFinite(r.hvacModeIdleHoldAfterActiveMs)
                && r.hvacModeIdleHoldAfterActiveMs >= 0
                ? r.hvacModeIdleHoldAfterActiveMs
                : DEFAULTS.hvacModeIdleHoldAfterActiveMs,
        manualOverrideMs: typeof r.manualOverrideMs === 'number' && Number.isFinite(r.manualOverrideMs) && r.manualOverrideMs >= 0
            ? r.manualOverrideMs
            : DEFAULTS.manualOverrideMs,
        roomTargetOverrideDurationMs:
            typeof r.roomTargetOverrideDurationMs === 'number'
                && Number.isFinite(r.roomTargetOverrideDurationMs)
                && r.roomTargetOverrideDurationMs >= 0
                ? r.roomTargetOverrideDurationMs
                : DEFAULTS.roomTargetOverrideDurationMs,
        controllerRoomName:
            typeof r.controllerRoomName === 'string' && r.controllerRoomName.trim() !== ''
                ? r.controllerRoomName.trim()
                : (typeof r.stairwellRoomName === 'string' && r.stairwellRoomName.trim() !== ''
                    ? r.stairwellRoomName.trim()
                    : DEFAULTS.controllerRoomName),
        ventOpenRaw: typeof r.ventOpenRaw === 'number' && Number.isFinite(r.ventOpenRaw)
            ? r.ventOpenRaw
            : DEFAULTS.ventOpenRaw,
        ventClosedRaw: typeof r.ventClosedRaw === 'number' && Number.isFinite(r.ventClosedRaw)
            ? r.ventClosedRaw
            : DEFAULTS.ventClosedRaw,
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
        if (row && typeof row.temperature === 'number' && Number.isFinite(row.temperature)) {
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
    const t = row.temperature;
    const lu = row.lastUpdateMs;
    if (typeof t !== 'number' || !Number.isFinite(t)) {
        return false;
    }
    if (typeof lu !== 'number' || !Number.isFinite(lu)) {
        return false;
    }
    return nowMs - lu <= REDUNDANT_SENSOR_OFFLINE_MS;
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

    /** @type {number|null} */
    let temperature = null;
    /** @type {number|null} */
    let humidity = null;
    /** @type {number|null} */
    let lastUpdateMs = null;

    if (pOnline && aOnline) {
        const pt = p.temperature;
        const at = a.temperature;
        if (typeof pt === 'number' && Number.isFinite(pt) && typeof at === 'number' && Number.isFinite(at)) {
            temperature = roundToOneDecimal((pt + at) / 2);
        }
        const ph = typeof p.humidity === 'number' && Number.isFinite(p.humidity) ? p.humidity : null;
        const ah = typeof a.humidity === 'number' && Number.isFinite(a.humidity) ? a.humidity : null;
        if (ph !== null && ah !== null) {
            humidity = roundToOneDecimal((ph + ah) / 2);
        } else if (ph !== null) {
            humidity = ph;
        } else if (ah !== null) {
            humidity = ah;
        }
        const plu = typeof p.lastUpdateMs === 'number' ? p.lastUpdateMs : 0;
        const alu = typeof a.lastUpdateMs === 'number' ? a.lastUpdateMs : 0;
        lastUpdateMs = Math.max(plu, alu);
    } else if (pOnline) {
        temperature = typeof p.temperature === 'number' && Number.isFinite(p.temperature) ? p.temperature : null;
        humidity = typeof p.humidity === 'number' && Number.isFinite(p.humidity) ? p.humidity : null;
        lastUpdateMs = typeof p.lastUpdateMs === 'number' ? p.lastUpdateMs : null;
    } else if (aOnline) {
        temperature = typeof a.temperature === 'number' && Number.isFinite(a.temperature) ? a.temperature : null;
        humidity = typeof a.humidity === 'number' && Number.isFinite(a.humidity) ? a.humidity : null;
        lastUpdateMs = typeof a.lastUpdateMs === 'number' ? a.lastUpdateMs : null;
    }

    return { temperature, humidity, lastUpdateMs };
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
    const t = row.temperature;
    const h = row.humidity;
    const lu = row.lastUpdateMs;
    const bat = row.batteryLevel;
    const lq = row.linkQuality;
    return {
        temperatureC: typeof t === 'number' && Number.isFinite(t) ? t : null,
        humidity: typeof h === 'number' && Number.isFinite(h) ? h : null,
        lastUpdateMs: typeof lu === 'number' ? lu : null,
        battery: typeof bat === 'number' && Number.isFinite(bat) ? bat : null,
        signal: typeof lq === 'number' && Number.isFinite(lq) ? lq : null,
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
    const motorIdRaw = cfg.roomVentMap[room];
    const motorId = typeof motorIdRaw === 'number' ? motorIdRaw : Number(motorIdRaw);
    if (!Number.isFinite(motorId)) {
        return;
    }
    delete manualOverrideUntilByMotor[String(motorId)];
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
        && typeof o.targetC === 'number'
        && Number.isFinite(o.targetC)
        && typeof o.untilMs === 'number'
        && Number.isFinite(o.untilMs)
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
    if (typeof targetC !== 'number' || !Number.isFinite(targetC)) {
        return { ok: false, error: 'invalid_targetC' };
    }
    const cfg = getVentAutomationConfig();
    if (!Object.prototype.hasOwnProperty.call(cfg.roomVentMap, room)) {
        return { ok: false, error: 'unknown_room' };
    }
    const overrideDurationMs =
        typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
            ? durationMs
            : cfg.roomTargetOverrideDurationMs;
    const untilMs = Date.now() + overrideDurationMs;
    clearManualOverrideForRoom(room);
    roomTargetOverrideByRoom[room] = { targetC, untilMs };
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
    if (
        !o
        || typeof o.targetC !== 'number'
        || !Number.isFinite(o.targetC)
        || typeof o.untilMs !== 'number'
        || !Number.isFinite(o.untilMs)
    ) {
        return null;
    }
    if (nowMs >= o.untilMs) {
        return null;
    }
    return { targetC: o.targetC, untilMs: o.untilMs };
}

/**
 * Controller-room band mode (matches {@link resolveHvacMode} for a known temperature).
 * Applies room hysteresis so idle is between `heatTargetC + roomHysteresisC` and `coolTargetC - roomHysteresisC`
 * (aligned with per-room `heatRoomTarget` / `coolRoomTarget`).
 * @param {number} stairTempC
 * @param {number} heatTargetC
 * @param {number} coolTargetC
 * @param {number} [roomHysteresisC=0]
 * @returns {'cooling'|'heating'|'idle'}
 */
function resolveVentAutomationHvacMode(stairTempC, heatTargetC, coolTargetC, roomHysteresisC = 0) {
    const h = typeof roomHysteresisC === 'number' && Number.isFinite(roomHysteresisC) ? roomHysteresisC : 0;
    const coolBandC = coolTargetC - h;
    const heatBandC = heatTargetC + h;
    if (stairTempC >= heatBandC && stairTempC <= coolBandC) {
        return 'idle';
    }
    if (stairTempC > coolBandC) {
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
    const holdMs = typeof holdAfterActiveMs === 'number' && Number.isFinite(holdAfterActiveMs) && holdAfterActiveMs > 0
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
    lastAutomationEvaluationAt = Date.now();

    const merged = applyRedundancyMerge(mergeSensors(sensorsByRoom));
    const stairName = cfg.controllerRoomName;
    const stairRow = merged[stairName];
    const stairTemp = stairRow && typeof stairRow.temperature === 'number' ? stairRow.temperature : null;
    if (stairTemp === null || !Number.isFinite(stairTemp)) {
        return;
    }

    const { coolTargetC, heatTargetC, roomHysteresisC, hvacModeIdleHoldAfterActiveMs } = cfg;
    const nowEval = Date.now();
    const rawHvacMode = resolveVentAutomationHvacMode(stairTemp, heatTargetC, coolTargetC, roomHysteresisC);
    const currHvacMode = applyVentAutomationHvacIdleHold(rawHvacMode, hvacModeIdleHoldAfterActiveMs, nowEval);
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

    const cooling = currHvacMode === 'cooling';
    const heating = currHvacMode === 'heating';

    const ventPayload = await ventClient.getVentStatus();
    if (!ventPayload || typeof ventPayload !== 'object') {
        console.warn('Vent automation: skipped tick (no status)');
        return;
    }

    const nowTick = Date.now();

    for (const [roomName, motorIdRaw] of Object.entries(roomVentMap)) {
        if (roomName === stairName) {
            continue;
        }
        const motorId = typeof motorIdRaw === 'number' ? motorIdRaw : Number(motorIdRaw);
        if (!Number.isFinite(motorId)) {
            continue;
        }
        if (isManualOverrideActive(motorId)) {
            continue;
        }

        const row = merged[roomName];
        const roomTemp = row && typeof row.temperature === 'number' ? row.temperature : null;
        if (roomTemp === null || !Number.isFinite(roomTemp)) {
            continue;
        }

        const eff = effectiveRoomBandTargets(roomName, nowTick, { coolTargetC, heatTargetC });
        const coolRoomTarget = eff.coolTargetC - roomHysteresisC;
        const heatRoomTarget = eff.heatTargetC + roomHysteresisC;

        let wantOpen = false;
        if (cooling) {
            wantOpen = roomTemp > coolRoomTarget;
        } else if (heating) {
            wantOpen = roomTemp < heatRoomTarget;
        }

        const pos = ventClient.readMotorPos(ventPayload, motorId);
        if (pos === null) {
            continue;
        }

        const mode = cooling ? /** @type {const} */ ('cooling') : /** @type {const} */ ('heating');
        if (wantOpen) {
            if (pos <= 0) {
                const { ok } = await ventClient.setVentMotorRaw(motorId, cfg.ventOpenRaw);
                ventActionLog.append({
                    source: 'automation',
                    action: 'open',
                    motorId,
                    roomName,
                    success: ok,
                    targetRaw: cfg.ventOpenRaw,
                    mode,
                    controllerTempC: stairTemp,
                    roomTempC: roomTemp,
                    posBefore: pos,
                });
            }
        } else if (pos > 0) {
            const { ok } = await ventClient.setVentMotorRaw(motorId, cfg.ventClosedRaw);
            ventActionLog.append({
                source: 'automation',
                action: 'close',
                motorId,
                roomName,
                success: ok,
                targetRaw: cfg.ventClosedRaw,
                mode,
                controllerTempC: stairTemp,
                roomTempC: roomTemp,
                posBefore: pos,
            });
        }
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
 * Resolve HVAC mode from controller room temperature and config.
 * @param {boolean} enabled
 * @param {number|null} controllerTempC
 * @param {{ coolTargetC: number, heatTargetC: number }} targets
 * @returns {'idle'|'cooling'|'heating'|'unknown'|'disabled'}
 */
function resolveHvacMode(enabled, targets, controllerTempC) {
    if (!enabled) {
        return 'disabled';
    }
    if (controllerTempC === null || !Number.isFinite(controllerTempC)) {
        return 'unknown';
    }
    const { coolTargetC, heatTargetC } = targets;
    if (controllerTempC >= heatTargetC && controllerTempC <= coolTargetC) {
        return 'idle';
    }
    if (controllerTempC > coolTargetC) {
        return 'cooling';
    }
    return 'heating';
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
    const stairRow = merged[stairName];
    const controllerTempC = stairRow && typeof stairRow.temperature === 'number' && Number.isFinite(stairRow.temperature)
        ? stairRow.temperature
        : null;

    const mode = resolveHvacMode(cfg.enabled, { coolTargetC: cfg.coolTargetC, heatTargetC: cfg.heatTargetC }, controllerTempC);

    const nowDash = Date.now();

    await ventClient.getVentStatus();
    const ventPayload = ventClient.getCachedVentPayload();

    /** @type {Map<string, Record<string, unknown>>} */
    const ventFieldsByRoom = new Map();
    for (const [roomName, motorIdRaw] of Object.entries(cfg.roomVentMap)) {
        const motorId = typeof motorIdRaw === 'number' ? motorIdRaw : Number(motorIdRaw);
        if (!Number.isFinite(motorId)) {
            continue;
        }
        const until = manualOverrideUntilByMotor[String(motorId)] ?? 0;
        const now = Date.now();
        const manualOverrideActive = now < until;
        const slot = ventClient.readMotorSlot(ventPayload, motorId);
        const row = merged[roomName];
        const roomTemp = row && typeof row.temperature === 'number' ? row.temperature : null;
        const eff = effectiveRoomBandTargets(roomName, nowDash, { coolTargetC: cfg.coolTargetC, heatTargetC: cfg.heatTargetC });
        const coolRoomTarget = eff.coolTargetC - cfg.roomHysteresisC;
        const heatRoomTarget = eff.heatTargetC + cfg.roomHysteresisC;
        let wantOpen = null;
        if (mode === 'cooling' && roomTemp !== null && Number.isFinite(roomTemp)) {
            wantOpen = roomTemp > coolRoomTarget;
        } else if (mode === 'heating' && roomTemp !== null && Number.isFinite(roomTemp)) {
            wantOpen = roomTemp < heatRoomTarget;
        }
        const isOpen = slot !== null && slot.pos > 0;
        const rtOverride = getRoomTargetOverride(roomName, nowDash);
        ventFieldsByRoom.set(roomName, {
            motorId,
            displayName: slot?.name ?? null,
            pos: slot?.pos ?? null,
            isOpen,
            wantOpen,
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
            temperatureC: typeof temp === 'number' && Number.isFinite(temp) ? temp : null,
            humidity: typeof row.humidity === 'number' && Number.isFinite(row.humidity) ? row.humidity : null,
            lastUpdateMs: typeof row.lastUpdateMs === 'number' ? row.lastUpdateMs : null,
            temperatureSource: fromWifi ? 'wifi' : 'zigbee',
            battery: primaryDash.battery,
            signal: primaryDash.signal,
        };
        const altLabel = redundantAltLabelForPrimaryRoom(room);
        if (Object.prototype.hasOwnProperty.call(rawMerged, altLabel)) {
            const pRaw = sensorRowToDashboardFields(rawMerged[room]);
            const aRaw = sensorRowToDashboardFields(rawMerged[altLabel]);
            entry.sensorPrimaryTemperatureC = pRaw.temperatureC;
            entry.sensorAltTemperatureC = aRaw.temperatureC;
            entry.sensorPrimaryHumidity = pRaw.humidity;
            entry.sensorAltHumidity = aRaw.humidity;
            entry.sensorPrimaryLastUpdateMs = pRaw.lastUpdateMs;
            entry.sensorAltLastUpdateMs = aRaw.lastUpdateMs;
            entry.battery = pRaw.battery;
            entry.signal = pRaw.signal;
            entry.batteryAlt = aRaw.battery;
            entry.signalAlt = aRaw.signal;
        }
        const ventExtra = ventFieldsByRoom.get(room);
        rooms.push(ventExtra ? { ...entry, ...ventExtra } : entry);
    }
    rooms.sort((a, b) => String(a.room).localeCompare(String(b.room)));

    const MS_DAY = 86400000;
    const since = Date.now() - MS_DAY;
    const actions = ventActionLog.getEntriesNewestFirst();
    const last24h = actions.filter((a) => a.at >= since);
    const automation24h = last24h.filter((a) => a.source === 'automation');
    const failures24h = last24h.filter((a) => !a.success);

    return {
        mode,
        automationEnabled: cfg.enabled,
        controllerTempC,
        targets: {
            coolTargetC: cfg.coolTargetC,
            heatTargetC: cfg.heatTargetC,
            roomHysteresisC: cfg.roomHysteresisC,
        },
        rooms,
        lastAutomationEvaluationAt,
        statistics: {
            actionsLast24h: last24h.length,
            automationActionsLast24h: automation24h.length,
            manualActionsLast24h: last24h.filter((a) => a.source === 'manual').length,
            failedActionsLast24h: failures24h.length,
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
    if (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC)) {
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
