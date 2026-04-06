const ventClient = require('../lib/vent.client');
const ventAutomation = require('../services/vent.automation.service');
const ventActionLog = require('../services/vent.action.log');

// Fetch fresh status data every 5 minutes
const statusInterval = 5 * 60 * 1000;

/**
 * Poll vent hardware and refresh {@link ventClient} cache.
 * @returns {Promise<void>}
 */
const pollVentStatus = async () => {
    console.log('CRON: fetching vent status.');
    await ventClient.getVentStatus();
};
pollVentStatus();
setInterval(pollVentStatus, statusInterval);

exports.getStatus = async (req, res) => {
    res.status(200).send({ success: true, error: '', status: ventClient.getCachedVentPayload() });
};

/**
 * Action log plus live automation dashboard (temps, vents, mode).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
exports.getActionLog = async (req, res) => {
    try {
        const dashboard = await ventAutomation.getAutomationDashboard();
        res.status(200).send({
            success: true,
            error: '',
            actions: ventActionLog.getEntriesNewestFirst(),
            ...dashboard,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('getActionLog dashboard failed', msg);
        res.status(200).send({
            success: true,
            error: '',
            actions: ventActionLog.getEntriesNewestFirst(),
            mode: 'unknown',
            automationEnabled: false,
            controllerRoom: '',
            controllerTempC: null,
            targets: null,
            rooms: [],
            vents: [],
            lastAutomationEvaluationAt: null,
            statistics: null,
        });
    }
};

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
exports.updateStatus = async (req, res) => {
    const pathOnly = req.originalUrl.replace(/\?.*$/, '');
    const match = pathOnly.match(/^\/\w+\/(\d+)\/(\d+)$/);
    const requestDevice = match ? match[1] : '';
    let requestState = match ? Number(match[2]) : NaN;

    if (!match || !Number.isFinite(requestState)) {
        console.warn('Invalid vent route', req.originalUrl);
        res.status(400).send({ success: false, error: 'bad_route', status: '{}' });
        return;
    }

    requestState = Math.max(0, Math.min(100, Math.round(requestState)));

    console.log('Opening vent: ' + requestDevice + ' to: ' + requestState);
    try {
        const { ok, data } = await ventClient.setVentMotorRaw(requestDevice, requestState);
        if (!ok) {
            ventActionLog.append({
                source: 'manual',
                action: 'set',
                motorId: requestDevice,
                success: false,
                targetRaw: requestState,
            });
            console.warn('Failed to update vent status');
            res.status(500).send({ success: false, error: 'offline', status: '{}' });
            return;
        }
        ventAutomation.recordManualOverride(requestDevice);
        ventActionLog.append({
            source: 'manual',
            action: 'set',
            motorId: requestDevice,
            success: true,
            targetRaw: requestState,
        });
        console.log('Vents status: ', data);
    } catch (error) {
        ventClient.setCachedVentPayload(null);
        ventActionLog.append({
            source: 'manual',
            action: 'set',
            motorId: requestDevice,
            success: false,
            targetRaw: requestState,
        });
        console.log('Update vent status failed');
        res.status(500).send({ success: false, error: 'offline', status: ventClient.getCachedVentPayload() });
        return;
    }
    res.status(200).send({ success: true, error: '', status: ventClient.getCachedVentPayload() });
};
