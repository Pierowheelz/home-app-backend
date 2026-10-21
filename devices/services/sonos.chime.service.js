const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');

/**
 * Doorbell chime on Sonos (S1) speakers over local UPnP — no LMS / Sonos cloud involved.
 *
 * Speakers are found by SSDP at startup and every {@link REDISCOVER_MS} (or queried directly from `sonos.hosts`),
 * so a press never waits on discovery. A chime plays on each selected group's coordinator: speakers that are already
 * playing are skipped (unless `skipPlaying: false`), each member's volume is set for the chime and restored once it
 * finishes. Whatever was loaded on the speaker beforehand is not restored.
 *
 * The chime file is served by this API (`GET /sonos/chime.<ext>`, no auth) because Sonos fetches it by URL.
 */

/**
 * @typedef {{ uuid: string, ip: string, room: string }} SonosMember
 * @typedef {{ coordinator: SonosMember, members: SonosMember[] }} SonosGroup
 * @typedef {{
 *   enabled: boolean,
 *   chimeFile: string,
 *   serverUrl: string,
 *   hosts: string[],
 * }} SonosConfig
 * @typedef {{
 *   volume: number,
 *   volumes?: Record<string, number>,
 *   rooms?: string[],
 *   skipPlaying: boolean,
 * }} ChimeOptions
 * `volumes` overrides `volume` per room name; `rooms` limits which rooms chime (default all).
 */

const DEFAULT_CHIME_FILE = path.join(__dirname, '..', 'assets', 'doorbell-chime.wav');

const SONOS_PORT = 1400;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_WAIT_MS = 2500;
const SOAP_TIMEOUT_MS = 3000;

/** Refresh speakers / groups this often (IPs and grouping can change). */
const REDISCOVER_MS = 10 * 60 * 1000;

/** Poll the coordinator while the chime plays, to know when to restore volumes. */
const PLAYBACK_POLL_MS = 500;
const PLAYBACK_START_GRACE_MS = 1500;
const PLAYBACK_MAX_MS = 30_000;

const SERVICES = {
    AVTransport: { path: '/MediaRenderer/AVTransport/Control', urn: 'urn:schemas-upnp-org:service:AVTransport:1' },
    RenderingControl: { path: '/MediaRenderer/RenderingControl/Control', urn: 'urn:schemas-upnp-org:service:RenderingControl:1' },
    ZoneGroupTopology: { path: '/ZoneGroupTopology/Control', urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' },
};

/** @type {SonosGroup[]} */
let groups = [];

/** @type {Promise<SonosGroup[]>|null} */
let discovering = null;

/** Coordinator UUIDs with a chime in progress (a second press must not save the chime volume as "previous"). */
const chimingCoordinators = new Set();

/**
 * @returns {SonosConfig}
 */
function getSonosConfig() {
    const raw =
        typeof global.appconfig === 'object' && global.appconfig !== null
            ? /** @type {Record<string, unknown>} */ (global.appconfig).sonos
            : null;
    const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? /** @type {Record<string, unknown>} */ (raw)
        : {};
    return {
        enabled: src.enabled === true,
        chimeFile: typeof src.chimeFile === 'string' && src.chimeFile.trim() !== ''
            ? src.chimeFile.trim()
            : DEFAULT_CHIME_FILE,
        serverUrl: typeof src.serverUrl === 'string' ? src.serverUrl.trim().replace(/\/+$/, '') : '',
        hosts: Array.isArray(src.hosts)
            ? src.hosts.filter((h) => typeof h === 'string' && h.trim() !== '').map((h) => h.trim())
            : [],
    };
}

/**
 * URL path the chime file is served on (keeps the file's extension; Sonos uses it to pick a decoder).
 * @returns {string}
 */
function getChimePath() {
    const ext = path.extname(getSonosConfig().chimeFile).toLowerCase() || '.wav';
    return `/sonos/chime${ext}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {string} s
 * @returns {string}
 */
function xmlUnescape(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Text content of the first `<tag>` in a SOAP response.
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function xmlValue(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? xmlUnescape(m[1]) : '';
}

/**
 * @param {string} attrs Attribute source, e.g. `UUID="RINCON_1" ZoneName="Patio"`.
 * @returns {Record<string, string>}
 */
function parseAttributes(attrs) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const m of attrs.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
        out[m[1]] = xmlUnescape(m[2]);
    }
    return out;
}

/**
 * Call a Sonos UPnP action.
 * @param {string} ip
 * @param {keyof SERVICES} service
 * @param {string} action
 * @param {Record<string, string|number>} [args] Sent in order, after `InstanceID` for AVTransport / RenderingControl.
 * @returns {Promise<string>} Response XML.
 */
async function soap(ip, service, action, args = {}) {
    const svc = SERVICES[service];
    const allArgs = service === 'ZoneGroupTopology' ? args : { InstanceID: 0, ...args };
    const argXml = Object.entries(allArgs).map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`).join('');
    const body = '<?xml version="1.0" encoding="utf-8"?>'
        + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        + `<s:Body><u:${action} xmlns:u="${svc.urn}">${argXml}</u:${action}></s:Body></s:Envelope>`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOAP_TIMEOUT_MS);
    try {
        const res = await fetch(`http://${ip}:${SONOS_PORT}${svc.path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                SOAPACTION: `"${svc.urn}#${action}"`,
            },
            body,
            signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
            const code = xmlValue(text, 'errorCode');
            throw new Error(`Sonos ${action} on ${ip} failed: HTTP ${res.status}${code ? ` (UPnP error ${code})` : ''}`);
        }
        return text;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * SSDP search for Sonos ZonePlayers.
 * @returns {Promise<string[]>} Player IPs.
 */
function ssdpSearch() {
    return new Promise((resolve) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        /** @type {Set<string>} */
        const ips = new Set();
        const finish = () => {
            try {
                socket.close();
            } catch (e) {
                // already closed
            }
            resolve([...ips]);
        };
        socket.on('message', (msg) => {
            const m = msg.toString().match(/^location:\s*http:\/\/([\d.]+):1400\//im);
            if (m) {
                ips.add(m[1]);
            }
        });
        socket.on('error', (err) => {
            console.warn('Sonos: SSDP error:', err.message);
            finish();
        });
        socket.bind(0, () => {
            const search = Buffer.from([
                'M-SEARCH * HTTP/1.1',
                `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
                'MAN: "ssdp:discover"',
                'MX: 1',
                'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
                '', '',
            ].join('\r\n'));
            socket.send(search, SSDP_PORT, SSDP_ADDR);
            // Repeat once: SSDP is UDP and a single search is easily missed.
            setTimeout(() => socket.send(search, SSDP_PORT, SSDP_ADDR), 500);
            setTimeout(finish, SSDP_WAIT_MS);
        });
    });
}

/**
 * Parse a `GetZoneGroupState` response into groups of visible rooms.
 * @param {string} xml
 * @returns {SonosGroup[]}
 */
function parseZoneGroupState(xml) {
    const state = xmlValue(xml, 'ZoneGroupState');
    /** @type {SonosGroup[]} */
    const out = [];
    for (const g of state.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
        const coordinatorId = parseAttributes(g[1]).Coordinator;
        /** @type {SonosMember[]} */
        const members = [];
        for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
            const a = parseAttributes(m[1]);
            const ip = (a.Location || '').match(/^http:\/\/([\d.]+):/);
            if (!a.UUID || !ip || a.Invisible === '1') {
                continue;
            }
            members.push({ uuid: a.UUID, ip: ip[1], room: a.ZoneName || a.UUID });
        }
        const coordinator = members.find((m) => m.uuid === coordinatorId);
        if (coordinator) {
            out.push({ coordinator, members });
        }
    }
    return out;
}

/**
 * Refresh the speaker / group cache (concurrent calls share one discovery).
 * @returns {Promise<SonosGroup[]>}
 */
function discover() {
    if (discovering) {
        return discovering;
    }
    discovering = (async () => {
        const cfg = getSonosConfig();
        const ips = cfg.hosts.length > 0 ? cfg.hosts : await ssdpSearch();
        for (const ip of ips) {
            try {
                const found = parseZoneGroupState(await soap(ip, 'ZoneGroupTopology', 'GetZoneGroupState'));
                const changed = JSON.stringify(found) !== JSON.stringify(groups);
                groups = found;
                if (changed) {
                    console.log('Sonos: groups', groups.map((g) => g.members.map((m) => `${m.room} (${m.ip})`).join(' + ')));
                }
                return groups;
            } catch (e) {
                console.warn(`Sonos: zone group query to ${ip} failed:`, e.message);
            }
        }
        if (ips.length === 0) {
            console.warn('Sonos: no speakers found');
        }
        return groups;
    })().finally(() => {
        discovering = null;
    });
    return discovering;
}

/**
 * Chime URL as seen from the speakers: `sonos.serverUrl`, else this host's IP on the speaker's subnet.
 * @param {string} speakerIp
 * @returns {string|null}
 */
function chimeUrlFor(speakerIp) {
    const cfg = getSonosConfig();
    if (cfg.serverUrl !== '') {
        return cfg.serverUrl + getChimePath();
    }
    const target = ipToInt(speakerIp);
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family !== 'IPv4' || a.internal) {
                continue;
            }
            const mask = ipToInt(a.netmask);
            if ((ipToInt(a.address) & mask) === (target & mask)) {
                const scheme = typeof global.appconfig?.ssl_cert === 'string' && global.appconfig.ssl_cert.trim() !== ''
                    ? 'https'
                    : 'http';
                return `${scheme}://${a.address}:${global.appconfig.port}${getChimePath()}`;
            }
        }
    }
    return null;
}

/**
 * @param {string} ip
 * @returns {number}
 */
function ipToInt(ip) {
    return ip.split('.').reduce((n, part) => ((n << 8) | (Number(part) & 255)) >>> 0, 0);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chime one group: set member volumes, play the chime on the coordinator, restore volumes once it ends.
 * @param {SonosGroup} group
 * @param {ChimeOptions} opts
 * @returns {Promise<void>}
 */
async function chimeGroup(group, opts) {
    const { coordinator, members } = group;
    const name = members.map((m) => m.room).join(' + ');
    if (chimingCoordinators.has(coordinator.uuid)) {
        return;
    }
    const url = chimeUrlFor(coordinator.ip);
    if (url === null) {
        console.warn(`Sonos: no local address on ${coordinator.ip}'s subnet; set sonos.serverUrl`);
        return;
    }

    chimingCoordinators.add(coordinator.uuid);
    /** @type {Array<{ member: SonosMember, volume: number }>} */
    const restore = [];
    try {
        const state = xmlValue(await soap(coordinator.ip, 'AVTransport', 'GetTransportInfo'), 'CurrentTransportState');
        if (opts.skipPlaying && (state === 'PLAYING' || state === 'TRANSITIONING')) {
            console.log(`Sonos: skipping chime on ${name} (playing)`);
            return;
        }

        for (const member of members) {
            const volume = Number(xmlValue(
                await soap(member.ip, 'RenderingControl', 'GetVolume', { Channel: 'Master' }),
                'CurrentVolume',
            ));
            const chimeVolume = opts.volumes?.[member.room] ?? opts.volume;
            if (Number.isInteger(volume) && volume !== chimeVolume) {
                restore.push({ member, volume });
            }
            await soap(member.ip, 'RenderingControl', 'SetVolume', { Channel: 'Master', DesiredVolume: chimeVolume });
        }

        await soap(coordinator.ip, 'AVTransport', 'SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: '' });
        await soap(coordinator.ip, 'AVTransport', 'Play', { Speed: 1 });
        console.log(`Sonos: chiming on ${name}`);

        // Wait until the chime ends (stopped) or something else replaces it.
        const startedAt = Date.now();
        await sleep(PLAYBACK_START_GRACE_MS);
        while (Date.now() - startedAt < PLAYBACK_MAX_MS) {
            const [transport, position] = await Promise.all([
                soap(coordinator.ip, 'AVTransport', 'GetTransportInfo'),
                soap(coordinator.ip, 'AVTransport', 'GetPositionInfo'),
            ]);
            const nowState = xmlValue(transport, 'CurrentTransportState');
            if ((nowState !== 'PLAYING' && nowState !== 'TRANSITIONING') || xmlValue(position, 'TrackURI') !== url) {
                break;
            }
            await sleep(PLAYBACK_POLL_MS);
        }
    } catch (e) {
        console.warn(`Sonos: chime on ${name} failed:`, e.message);
        // The speaker may have moved IP; refresh for next time.
        void discover();
    } finally {
        for (const { member, volume } of restore) {
            try {
                await soap(member.ip, 'RenderingControl', 'SetVolume', { Channel: 'Master', DesiredVolume: volume });
            } catch (e) {
                console.warn(`Sonos: restoring volume on ${member.room} failed:`, e.message);
            }
        }
        chimingCoordinators.delete(coordinator.uuid);
    }
}

/**
 * Play the chime on every selected group (in parallel).
 * @param {ChimeOptions} opts
 * @returns {Promise<void>}
 */
async function playChime(opts) {
    if (!getSonosConfig().enabled) {
        console.warn('Sonos: chime requested but sonos.enabled is false');
        return;
    }
    const known = groups.length > 0 ? groups : await discover();
    const wanted = Array.isArray(opts.rooms) && opts.rooms.length > 0 ? new Set(opts.rooms) : null;
    const selected = known.filter((g) => wanted === null || g.members.some((m) => wanted.has(m.room)));
    if (selected.length === 0) {
        console.warn('Sonos: no speakers to chime', wanted ? [...wanted] : '');
        return;
    }
    await Promise.all(selected.map((g) => chimeGroup(g, opts)));
}

/**
 * Start background discovery when `sonos.enabled`.
 * @returns {void}
 */
function start() {
    if (!getSonosConfig().enabled) {
        return;
    }
    void discover();
    setInterval(() => {
        void discover();
    }, REDISCOVER_MS);
}

module.exports = {
    getSonosConfig,
    getChimePath,
    parseZoneGroupState,
    chimeUrlFor,
    discover,
    playChime,
    start,
};
