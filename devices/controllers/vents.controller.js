const fetchWithTimeout = require('../fetchWithTimeout');

const ventNumberPad = ( value, padding ) => {
    const zeroes = new Array(padding+1).join("0");
    return (zeroes + value).slice(-padding);
};

let ventStatus = null;
// Fetch fresh status data every 5 minutes
let statusInterval = 5 * 60 * 1000;

const getVentStatus = async () => {
    console.log('CRON: fetching vent status.');
    try{
        const response = await fetchWithTimeout("http://192.168.2.110/?&t=1");
        if (!response.ok) {
            console.warn('Failed to fetch vent status');
            console.log(err);
            return;
        }
        const data = await response.json();
        console.log('Vents status: ',data);
        if( data['0'] ){
            // We have usable data
            ventStatus = data;
        }
    } catch (error) {
        ventStatus = null;
        console.log('Fetch vent status failed');
    }
};
getVentStatus();
setInterval(getVentStatus,statusInterval);

exports.getStatus = async (req, res) => {
    res.status(200).send({success:true,error:'',status:ventStatus});
};

exports.updateStatus = async (req, res) => {
    const requestDevice = req.url.replace(/^\/\w+\/(\d+)\/(\d+)$/, '$1');
    let requestState = req.url.replace(/^\/\w+\/(\d+)\/(\d+)$/, '$2');
    
    requestState = Math.max( 0, requestState );
    requestState = Math.min( 175, requestState );
    const paddedState = ventNumberPad( requestState, 3 );
    
    console.log('Opening vent: '+requestDevice+' to: '+paddedState);
    try{
        const response = await fetchWithTimeout("http://192.168.2.110/?a=6&t=1&m="+requestDevice+"&d="+paddedState);
        if (!response.ok) {
            console.warn('Failed to update vent status');
            res.status(500).send({success:false,error:'offline',status:'{}'});
            return;
        }
        const data = await response.json();
        if( data['0'] ){
            // We have usable data
            ventStatus = data;
        }
        
        console.log('Vents status: '+data);
    } catch (error) {
        ventStatus = null;
        console.log('Update vent status failed');
    }
    res.status(200).send({success:true,error:'',status:ventStatus});
};
