const fetchWithTimeout = require('../fetchWithTimeout');

exports.openBlinds = async (req, res) => {
    let result = false;
    
    console.log('Open Blinds');
    const response = fetchWithTimeout("http://192.168.2.102/?a=1&b=1");
    if (!response.ok) {
        console.warn('Failed to open blinds');
        res.status(500).send({success:false,error:'offline'});
        return;
    }
    //const response = await response.json();
    res.status(200).send({success:true,error:''});
};

exports.closeBlinds = async (req, res) => {
    let result = false;
    
    console.log('Close Blinds');
    const response = fetchWithTimeout("http://192.168.2.102/?a=1&b=2");
    if (!response.ok) {
        console.warn('Failed to close blinds');
        res.status(500).send({success:false,error:'offline'});
        return;
    }
    //const response = await response.json();
    res.status(200).send({success:true,error:''});
};

exports.stopBlinds = async (req, res) => {
    let result = false;
    
    console.log('Stop Blinds');
    const response = fetchWithTimeout("http://192.168.2.102/?a=1&b=5");
    if (!response.ok) {
        console.warn('Failed to stop blinds');
        res.status(500).send({success:false,error:'offline'});
        return;
    }
    //const response = await response.json();
    res.status(200).send({success:true,error:''});
};
