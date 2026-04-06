/** Default retention: 48 hours (milliseconds). */
const DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000;

/** @type {{ at: number, seq: number }} Monotonic-ish ordering within same ms. */
let idCounter = 0;

/**
 * @typedef {Object} VentActionLogEntry
 * @property {string} id Unique id for this entry.
 * @property {number} at Epoch milliseconds when the action occurred.
 * @property {'automation'|'manual'} source
 * @property {string} action Short verb: `open`, `close`, or `set`.
 * @property {string|number} motorId Vent motor index.
 * @property {boolean} success Whether the hardware call succeeded.
 * @property {number} [targetRaw] Commanded position (device units).
 * @property {string} [roomName] Room label when known.
 * @property {'cooling'|'heating'} [mode] HVAC mode when automation-driven.
 * @property {number} [controllerTempC] Controller room (e.g. stairwell) temperature °C.
 * @property {number} [roomTempC] Room temperature °C when known.
 * @property {number} [posBefore] Reported `pos` before the command.
 */

/** @type {VentActionLogEntry[]} Oldest at index 0. */
const entries = /** @type {VentActionLogEntry[]} */ ([]);

/**
 * @returns {number} Max age for kept entries, from config or default.
 */
function getRetentionMs() {
    const v = global.appconfig?.ventAutomation?.actionLogRetentionMs;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        return v;
    }
    return DEFAULT_RETENTION_MS;
}

/**
 * Drop entries older than retention window (called on append and read).
 * @returns {void}
 */
function prune() {
    const cutoff = Date.now() - getRetentionMs();
    while (entries.length > 0 && entries[0].at < cutoff) {
        entries.shift();
    }
}

/**
 * Append one log line after pruning stale entries.
 * @param {Omit<VentActionLogEntry, 'id'> & { id?: string }} row
 * @returns {void}
 */
function append(row) {
    prune();
    idCounter += 1;
    const id = row.id ?? `${Date.now()}-${idCounter}`;
    const at = typeof row.at === 'number' ? row.at : Date.now();
    entries.push({
        id,
        at,
        source: row.source,
        action: row.action,
        motorId: row.motorId,
        success: row.success,
        targetRaw: row.targetRaw,
        roomName: row.roomName,
        mode: row.mode,
        controllerTempC: row.controllerTempC,
        roomTempC: row.roomTempC,
        posBefore: row.posBefore,
    });
}

/**
 * @returns {VentActionLogEntry[]} Newest actions first; stale entries removed.
 */
function getEntriesNewestFirst() {
    prune();
    return entries.slice().reverse();
}

module.exports = {
    append,
    getEntriesNewestFirst,
    getRetentionMs,
};
