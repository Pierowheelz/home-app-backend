const ventClient = require('../lib/vent.client');
const ventActionLog = require('./vent.action.log');

/** @type {Record<string, number>} motorId (as string) -> manual override until epoch ms */
const manualOverrideUntilByMotor = /** @type {Record<string, number>} */ ({});

/** @type {Record<string, { temperature: number, lastUpdateMs: number }>} Optional Wi-Fi / supplemental readings by room name. */
const wifiSupplementByRoom = {};

/** Epoch ms when {@link evaluateAndAct} last ran while automation was enabled. */
let lastAutomationEvaluationAt = /** @type {number|null} */ (null);

const DEFAULTS = {
    enabled: true,
    coolTargetC: 23,
    heatTargetC: 21,
    roomHysteresisC: 0.5,
    manualOverrideMs: 3600000,
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
        manualOverrideMs: typeof r.manualOverrideMs === 'number' && Number.isFinite(r.manualOverrideMs) && r.manualOverrideMs >= 0
            ? r.manualOverrideMs
            : DEFAULTS.manualOverrideMs,
        controllerRoomName:
            typeof r.stairwellRoomName === 'string' && r.stairwellRoomName.trim() !== ''
                ? r.stairwellRoomName.trim()
                : (typeof r.controllerRoomName === 'string' && r.controllerRoomName.trim() !== ''
                    ? r.controllerRoomName.trim()
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
 * @returns {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>}
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
 * @param {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>} zigbeeSensors
 * @returns {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>}
 */
function mergeSensors(zigbeeSensors) {
    /** @type {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>} */
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
 * @param {Record<string, { temperature: number|null, lastUpdateMs?: number|null, humidity?: number|null }>} sensorsByRoom
 * @returns {Promise<void>}
 */
async function evaluateAndAct(sensorsByRoom) {
    const cfg = getVentAutomationConfig();
    if (!cfg.enabled) {
        return;
    }
    lastAutomationEvaluationAt = Date.now();
    const roomVentMap = cfg.roomVentMap;
    if (!roomVentMap || typeof roomVentMap !== 'object' || Object.keys(roomVentMap).length === 0) {
        return;
    }

    const merged = mergeSensors(sensorsByRoom);
    const stairName = cfg.controllerRoomName;
    const stairRow = merged[stairName];
    const stairTemp = stairRow && typeof stairRow.temperature === 'number' ? stairRow.temperature : null;
    if (stairTemp === null || !Number.isFinite(stairTemp)) {
        return;
    }

    const { coolTargetC, heatTargetC, roomHysteresisC } = cfg;
    if (stairTemp >= heatTargetC && stairTemp <= coolTargetC) {
        return;
    }

    const cooling = stairTemp > coolTargetC;
    const heating = stairTemp < heatTargetC;
    if (!cooling && !heating) {
        return;
    }

    const ventPayload = await ventClient.getVentStatus();
    if (!ventPayload || typeof ventPayload !== 'object') {
        console.warn('Vent automation: skipped tick (no status)');
        return;
    }

    const coolRoomTarget = coolTargetC - roomHysteresisC;
    const heatRoomTarget = heatTargetC + roomHysteresisC;

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
    const merged = mergeSensors(getReadingsSnapshotFromZigbee());
    const stairName = cfg.controllerRoomName;
    const stairRow = merged[stairName];
    const controllerTempC = stairRow && typeof stairRow.temperature === 'number' && Number.isFinite(stairRow.temperature)
        ? stairRow.temperature
        : null;

    const mode = resolveHvacMode(cfg.enabled, { coolTargetC: cfg.coolTargetC, heatTargetC: cfg.heatTargetC }, controllerTempC);

    const coolRoomTarget = cfg.coolTargetC - cfg.roomHysteresisC;
    const heatRoomTarget = cfg.heatTargetC + cfg.roomHysteresisC;

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
        let wantOpen = null;
        if (mode === 'cooling' && roomTemp !== null && Number.isFinite(roomTemp)) {
            wantOpen = roomTemp > coolRoomTarget;
        } else if (mode === 'heating' && roomTemp !== null && Number.isFinite(roomTemp)) {
            wantOpen = roomTemp < heatRoomTarget;
        }
        const isOpen = slot !== null && slot.pos > 0;
        ventFieldsByRoom.set(roomName, {
            motorId,
            displayName: slot?.name ?? null,
            pos: slot?.pos ?? null,
            isOpen,
            wantOpen,
            manualOverrideActive,
            manualOverrideUntilMs: manualOverrideActive ? until : null,
        });
    }

    /** @type {Array<Record<string, unknown>>} */
    const rooms = [];
    const roomNames = new Set([...Object.keys(merged), ...Object.keys(cfg.roomVentMap)]);
    for (const room of roomNames) {
        const row = merged[room] ?? { temperature: null, lastUpdateMs: null };
        const temp = row.temperature;
        const fromWifi = Object.prototype.hasOwnProperty.call(wifiSupplementByRoom, room);
        /** @type {Record<string, unknown>} */
        const entry = {
            room,
            temperatureC: typeof temp === 'number' && Number.isFinite(temp) ? temp : null,
            humidity: typeof row.humidity === 'number' && Number.isFinite(row.humidity) ? row.humidity : null,
            lastUpdateMs: typeof row.lastUpdateMs === 'number' ? row.lastUpdateMs : null,
            temperatureSource: fromWifi ? 'wifi' : 'zigbee',
        };
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
};
