const fetch = require('node-fetch');
const ewelink = require('ewelink-api');
const config = require('../../common/config/env.config');
const datastore = require('nedb');

const getConnection = async ( force ) => {
    const db = new datastore({ filename: 'connection.db' });
    db.loadDatabase();
    
    console.log('Connecting to eWelink API');
    // Attempt recovery of existing session
    const exTokens = new Promise((resolve, reject) => {
        db.find({ name: 'tokens' }, (err,data) => {
            if( data && data.length >= 1 ){
                resolve(data[0].value);
            } else {
                resolve(null);
            }
        });
    });
    let tokens = await exTokens;
    //console.log('Saved Tokens: ', tokens);
    
    let connection = null;
    if( force || null == tokens || tokens.length < 1 ){
        console.log('No existing connection - establishing new connection');
        connection = new ewelink({
            email: config.ewelink_email,
            password: config.ewelink_password,
            region: config.ewelink_region,
        });
    
        const credentials = await connection.getCredentials();
    
        const tokens = {};
        tokens.accessToken = credentials.at;
        tokens.apiKey = credentials.user.apikey
        tokens.region = credentials.region;
        console.log('Got new tokens: ', tokens);
    
        // Save token for next time
        db.update(
            { name: 'tokens' },
            { $set: { value: tokens } },
            { upsert: true },
            (err, numReplaced) => {
                console.log('Tokens saved to DB');
            }
        );
    } else {
        // Re-establish connection from tokens
        connection = new ewelink({
            at: tokens.accessToken,
            apiKey: tokens.apiKey,
            region: tokens.region
        });
    }
    
    return connection;
};

const getDeviceId = async ( connection, deviceName ) => {
    let devices = await connection.getDevices();
    const connectionError = devices?.error ?? 0;
    if( connectionError >= 400 && connectionError <= 499 ){ // If auth error, access key likely expired. Try logging in again
        connection = await getConnection( true );
        devices = await connection.getDevices();
    }
    // loop through devices to find the matching one
    let matchedDevice = false;
    for( const dev of devices ) {
        const devName = dev.name ?? 'Unknown';
        if( devName == deviceName ){
            matchedDevice = dev;
            break;
        }
    }
    
    return matchedDevice.deviceid;
};

const getDeviceStatus = async ( connection, deviceId ) => {
    let status = await connection.getDevicePowerState( deviceId );
    const connectionError = status?.error ?? 0;
    if( connectionError >= 400 && connectionError <= 499 ){ // If auth error, access key likely expired. Try logging in again
        connection = await getConnection( true );
        status = await connection.getDevicePowerState( deviceId );
    }
    
    return status;
};

const setDeviceStatus = async ( connection, deviceId, newState ) => {
    let status = await connection.setDevicePowerState(deviceId, newState);
    const connectionError = status?.error ?? 0;
    if( connectionError >= 400 && connectionError <= 499 ){ // If auth error, access key likely expired. Try logging in again
        connection = await getConnection( true );
        status = await connection.setDevicePowerState( deviceId, newState );
    }
      
    return status;
};

exports.lookupDevice = async (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = await getConnection( false );
    getDeviceId( con, requestDevice ).then( (deviceId) => {
        console.log('Matched device: ', deviceId);
        if( false === deviceId ){
            res.status(200).send({success:false,device:false,error:'not_found'});
        } else {
            res.status(200).send({success:true,device:deviceId,error:''});
        }
    });
};

exports.getStatus = async (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = await getConnection( false );
    getDeviceStatus( con, requestDevice ).then( (status) => {
        console.log('Device status: ', status);
        
        res.status(200).send({success:true,error:'', ...status});
    });
};

exports.turnOn = async (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = await getConnection( false );
    setDeviceStatus( con, requestDevice, 'on' ).then( (status) => {
        console.log('Device status: ', status);
        
        res.status(200).send({success:true,error:'', ...status});
    });
};

exports.turnOff = async (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\//, '');
    
    const con = await getConnection( false );
    setDeviceStatus( con, requestDevice, 'off' ).then( (status) => {
        console.log('Device status: ', status);
        
        res.status(200).send({success:true,error:'', ...status});
    });
};
