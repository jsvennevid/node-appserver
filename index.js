var config = require('config');
config.setModuleDefaults('appserver', {
    "web": {
        "port": 8888,
        "wsPort": 0
    },
    "production": false,
    "compress": false,
    "preload": false,
    "session": {
        "key": "connect.sid",
        "secret": "SECRET",
        "timeout": 48 * (60 * 60) * 1000
    },
    "streaming": {
        "registry": "local",
        "amqp": {
            "url": ""
        }
    },
    "memcached": {
        host: ""
    }
});

module.exports = require('./lib/server');