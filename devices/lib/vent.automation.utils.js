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
 * @typedef {{ motorId: number, motorControllerId: number, externalId: number }} RoomVentEntry
 */

/**
 * Parse a `roomVentMap` value: number (legacy) or `{ motorId, motorControllerId?, externalId? }`.
 * @param {unknown} raw
 * @returns {RoomVentEntry|null}
 */
function parseRoomVentEntry(raw) {
    if (typeof raw === 'number' || typeof raw === 'string') {
        const motorId = parseMotorId(raw);
        if (motorId === null || !Number.isInteger(motorId) || motorId < 0) {
            return null;
        }
        return { motorId, motorControllerId: 0, externalId: motorId };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const o = /** @type {Record<string, unknown>} */ (raw);
    const motorId = parseMotorId(o.motorId);
    if (motorId === null || !Number.isInteger(motorId) || motorId < 0) {
        return null;
    }
    let motorControllerId = 0;
    if (Object.prototype.hasOwnProperty.call(o, 'motorControllerId')) {
        const c = parseMotorId(o.motorControllerId);
        if (c === null || !Number.isInteger(c) || c < 0) {
            return null;
        }
        motorControllerId = c;
    }
    let externalId = motorId;
    if (Object.prototype.hasOwnProperty.call(o, 'externalId')) {
        const e = parseMotorId(o.externalId);
        if (e === null || !Number.isInteger(e) || e < 0) {
            return null;
        }
        externalId = e;
    }
    return { motorId, motorControllerId, externalId };
}

/**
 * Normalize `roomVentMap` to room → {@link RoomVentEntry}. Warns on duplicate `externalId`.
 * @param {unknown} raw
 * @param {Record<string, number|RoomVentEntry>} [fallback]
 * @returns {Record<string, RoomVentEntry>}
 */
function normalizeRoomVentMap(raw, fallback) {
    const source =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
            ? /** @type {Record<string, unknown>} */ (raw)
            : (fallback ?? {});
    /** @type {Record<string, RoomVentEntry>} */
    const out = {};
    /** @type {Map<number, string>} */
    const externalIdOwner = new Map();
    for (const [roomRaw, v] of Object.entries(source)) {
        if (typeof roomRaw !== 'string' || roomRaw.trim() === '') {
            continue;
        }
        const room = roomRaw.trim();
        const entry = parseRoomVentEntry(v);
        if (entry === null) {
            continue;
        }
        const prior = externalIdOwner.get(entry.externalId);
        if (prior !== undefined && prior !== room) {
            console.warn(
                `ventAutomation.roomVentMap: duplicate externalId ${entry.externalId} for "${room}" and "${prior}"`,
            );
        }
        externalIdOwner.set(entry.externalId, room);
        out[room] = entry;
    }
    return out;
}

/**
 * Normalize `ventBaseUrl` string or string[] to a non-empty list (no trailing slash).
 * @param {unknown} raw
 * @param {string} [defaultUrl]
 * @returns {string[]}
 */
function normalizeVentBaseUrls(raw, defaultUrl = 'http://192.168.2.110') {
    /** @type {string[]} */
    const urls = [];
    if (typeof raw === 'string' && raw.trim() !== '') {
        urls.push(raw.trim().replace(/\/$/, ''));
    } else if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item === 'string' && item.trim() !== '') {
                urls.push(item.trim().replace(/\/$/, ''));
            }
        }
    }
    if (urls.length === 0) {
        return [defaultUrl.replace(/\/$/, '')];
    }
    return urls;
}

/**
 * Find a normalized roomVentMap entry by external id.
 * @param {Record<string, RoomVentEntry>} roomVentMap
 * @param {number|string} externalId
 * @returns {{ room: string, entry: RoomVentEntry }|null}
 */
function findRoomVentEntryByExternalId(roomVentMap, externalId) {
    const want = String(externalId);
    for (const [room, entry] of Object.entries(roomVentMap)) {
        if (String(entry.externalId) === want) {
            return { room, entry };
        }
    }
    return null;
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
 * @param {Date} date
 * @param {string} timeZone IANA time zone name
 * @returns {number|null} Calendar month 1–12, or `null` if `timeZone` is invalid for `Intl`
 */
function getCalendarMonthInTimeZone(date, timeZone) {
    try {
        const dtf = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            month: 'numeric',
        });
        const parts = dtf.formatToParts(date);
        const monthPart = parts.find((p) => p.type === 'month');
        if (!monthPart) {
            return null;
        }
        const month = Number(monthPart.value);
        if (!Number.isInteger(month) || month < 1 || month > 12) {
            return null;
        }
        return month;
    } catch {
        return null;
    }
}

/**
 * Normalize a config list of calendar months to unique integers 1–12.
 * @param {unknown} raw
 * @returns {number[]}
 */
function normalizedMonthList(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    /** @type {number[]} */
    const out = [];
    const seen = new Set();
    for (const v of raw) {
        const n = typeof v === 'number'
            ? v
            : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
        if (!Number.isInteger(n) || n < 1 || n > 12 || seen.has(n)) {
            continue;
        }
        seen.add(n);
        out.push(n);
    }
    return out;
}

/**
 * Match on externalId (API / dashboard motor id).
 * @param {Record<string, RoomVentEntry|number>} roomVentMap
 * @param {number|string} externalId
 * @returns {string|null}
 */
function roomNameForMotorInMap(roomVentMap, externalId) {
    const found = findRoomVentEntryByExternalId(
        normalizeRoomVentMap(roomVentMap),
        externalId,
    );
    return found !== null ? found.room : null;
}

module.exports = {
    isRedundantAltSensorLabel,
    primaryRoomFromRedundantAltLabel,
    redundantAltLabelForPrimaryRoom,
    roundToOneDecimal,
    isFiniteNum,
    finiteNumOrDefault,
    parseMotorId,
    parseRoomVentEntry,
    normalizeRoomVentMap,
    normalizeVentBaseUrls,
    findRoomVentEntryByExternalId,
    readRowTemp,
    normalizedPauseHrsMap,
    parsePauseHrsWindow,
    getWallClockMinutesInTimeZone,
    getCalendarMonthInTimeZone,
    normalizedMonthList,
    roomNameForMotorInMap,
};
