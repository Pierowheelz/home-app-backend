/**
 * Suffix for redundant Zigbee alt sensor row keys (primary name + this string).
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

/**
 * @param {unknown} raw
 * @param {Record<string, string>} defaultPauseHrs
 * @returns {Record<string, string>}
 */
function normalizedPauseHrsMap(raw, defaultPauseHrs) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ...defaultPauseHrs };
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
        if (typeof k !== 'string' || k.trim() === '') {
            continue;
        }
        if (typeof v !== 'string' || v.trim() === '') {
            continue;
        }
        out[k.trim()] = v.trim();
    }
    return Object.keys(out).length > 0 ? out : { ...defaultPauseHrs };
}

/**
 * Parse `HH:mm-HH:mm` into minutes-from-midnight; end may be earlier than start (overnight window).
 * @param {string} spec
 * @returns {{ startMin: number, endMin: number }|null}
 */
function parsePauseHrsWindow(spec) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
    if (m === null) {
        return null;
    }
    const sh = Number(m[1]);
    const sm = Number(m[2]);
    const eh = Number(m[3]);
    const em = Number(m[4]);
    if (![sh, sm, eh, em].every((n) => Number.isInteger(n))) {
        return null;
    }
    if (sh < 0 || sh > 23 || eh < 0 || eh > 23 || sm < 0 || sm > 59 || em < 0 || em > 59) {
        return null;
    }
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin === endMin) {
        return null;
    }
    return { startMin, endMin };
}

/**
 * Local wall-clock minutes from midnight in `timeZone` for `date` (0–1439).
 * @param {Date} date
 * @param {string} timeZone IANA time zone name
 * @returns {number|null} `null` if `timeZone` is invalid for `Intl`
 */
function getWallClockMinutesInTimeZone(date, timeZone) {
    try {
        const dtf = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false,
            hourCycle: 'h23',
        });
        const parts = dtf.formatToParts(date);
        const hourPart = parts.find((p) => p.type === 'hour');
        const minutePart = parts.find((p) => p.type === 'minute');
        if (!hourPart || !minutePart) {
            return null;
        }
        const hour = Number(hourPart.value);
        const minute = Number(minutePart.value);
        if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
            return null;
        }
        return hour * 60 + minute;
    } catch {
        return null;
    }
}

/**
 * @param {Record<string, number>} roomVentMap
 * @param {number|string} motorId
 * @returns {string|null}
 */
function roomNameForMotorInMap(roomVentMap, motorId) {
    const want = String(motorId);
    for (const [room, raw] of Object.entries(roomVentMap)) {
        const id = parseMotorId(raw);
        if (id !== null && String(id) === want) {
            return room;
        }
    }
    return null;
}

module.exports = {
    isRedundantAltSensorLabel,
    primaryRoomFromRedundantAltLabel,
    redundantAltLabelForPrimaryRoom,
    roundToOneDecimal,
    isFiniteNum,
    finiteNumOrDefault,
    parseMotorId,
    readRowTemp,
    normalizedPauseHrsMap,
    parsePauseHrsWindow,
    getWallClockMinutesInTimeZone,
    roomNameForMotorInMap,
};
