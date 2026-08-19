/** Widget types that require a matching `devices.*` config key. */
const WIDGET_DEVICE_KEYS = {
    garage: 'garage',
    speakers: 'speakers',
    blinds: 'blinds',
    server: 'server',
};

/**
 * @param {unknown} visibleToUserIds
 * @param {number} userId
 * @returns {boolean}
 */
function pageVisibleToUser(visibleToUserIds, userId) {
    if (visibleToUserIds == null) {
        return true;
    }
    if (!Array.isArray(visibleToUserIds)) {
        return true;
    }
    return visibleToUserIds.some((id) => parseInt(id, 10) === userId);
}

/**
 * @param {string} widgetType
 * @param {Record<string, unknown>} devices
 * @returns {boolean}
 */
function widgetDeviceConfigured(widgetType, devices) {
    const deviceKey = WIDGET_DEVICE_KEYS[widgetType];
    if (!deviceKey) {
        return true;
    }
    return devices[deviceKey] != null;
}

/**
 * Drop widgets whose device is missing, then drop empty rows.
 *
 * @param {Array<{ className?: string, widgets?: object[] }>} rows
 * @param {Record<string, unknown>} devices
 * @param {Set<string>} visiblePageIds
 * @returns {Array<{ className?: string, widgets: object[] }>}
 */
function filterRows(rows, devices, visiblePageIds) {
    if (!Array.isArray(rows)) {
        return [];
    }
    const out = [];
    for (const row of rows) {
        const widgets = Array.isArray(row.widgets) ? row.widgets : [];
        const kept = widgets.filter((widget) => {
            if (!widget || typeof widget.type !== 'string') {
                return false;
            }
            if (!widgetDeviceConfigured(widget.type, devices)) {
                return false;
            }
            if (widget.type === 'pageLink') {
                const pageId = widget.pageId;
                if (typeof pageId !== 'string' || !visiblePageIds.has(pageId)) {
                    return false;
                }
            }
            return true;
        });
        if (kept.length === 0) {
            continue;
        }
        const next = { widgets: kept };
        if (typeof row.className === 'string' && row.className !== '') {
            next.className = row.className;
        }
        out.push(next);
    }
    return out;
}

/**
 * Sanitized UI layout for the logged-in user. Omits MQTT names and secrets.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
exports.getLayout = (req, res) => {
    const userId = parseInt(req.jwt.userId, 10);
    const devices = appconfig.devices && typeof appconfig.devices === 'object'
        ? appconfig.devices
        : {};
    const rawLayout = appconfig.appLayout && typeof appconfig.appLayout === 'object'
        ? appconfig.appLayout
        : {};
    const rawPages = Array.isArray(rawLayout.pages) ? rawLayout.pages : [];

    const visiblePages = rawPages.filter((page) =>
        page && typeof page.id === 'string' && pageVisibleToUser(page.visibleToUserIds, userId)
    );
    const visiblePageIds = new Set(visiblePages.map((page) => page.id));

    const pages = visiblePages.map((page) => {
        const out = {
            id: page.id,
            path: typeof page.path === 'string' ? page.path : '/' + page.id,
            showInNav: page.showInNav === true,
            navName: typeof page.navName === 'string' ? page.navName : page.id,
            miniName: typeof page.miniName === 'string' ? page.miniName : '',
            rows: filterRows(page.rows, devices, visiblePageIds),
        };
        return out;
    });

    const nav = {
        name: typeof rawLayout.nav?.name === 'string' ? rawLayout.nav.name : 'Dashboards',
        icon: typeof rawLayout.nav?.icon === 'string' ? rawLayout.nav.icon : 'tachometer',
    };

    res.status(200).send({ nav, pages });
};
