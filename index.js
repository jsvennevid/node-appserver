var config = require('config');
config.setModuleDefaults('appserver', {
    "web": {
        "port": 8888,
        "wsPort": 0
    },
    "production": false,
    "compress": false,
    "preload": false,
    "logformat": "default",
    "session": {
        "type": "memory",

        "key": "connect.sid",
        "client_key": "connect.cid",
        "secret": "SECRET",
        "secure": false,
        "timeout": 48 * (60 * 60) * 1000,

        "redis": {
            "host": "localhost",
            "port": 6379
        }
    },
    "streaming": {
        "registry": {
            "type": "local",
            "amqp": {
                "url": ""
            },
            "redis": {
                "host": "localhost",
                "port": 6379,
                "prefix": "registry:"
            }
        },
    },
    "memcached": {
        "host": ""
    }
});

module.exports = require('./lib/server');
