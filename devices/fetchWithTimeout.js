const fetch = require('node-fetch');

const fetchWithTimeout = (url) => {
    console.log('Fetch command issued: ', url);
    
    const controller = new AbortController();
    const signal = controller.signal;
    setTimeout(() => {
        controller.abort()
    }, 4000);
    
    return fetch(
        url,
        {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-cache',
            signal
        }
    );
    
    // return Promise.race([
    //     fetch(
    //         url,
    //         {
    //             method: 'GET',
    //             mode: 'no-cors',
    //             cache: 'no-cache'
    //         }
    //     ),
    //     new Promise((_, reject) =>
    //         setTimeout(() => reject(new Error('timeout')), 5000)
    //     )
    // ]);
};

module.exports = fetchWithTimeout;
