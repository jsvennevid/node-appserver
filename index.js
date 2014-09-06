var config = require('config');
config.util.setModuleDefaults('appserver', {
    "web": {
        "host": undefined,
        "backlog": undefined,
        "port": 8888,
        "wsPort": 0,
        "allowProxy": false
    },
    "production": false,
    "compress": false,
    "bundlecache": undefined,
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
            "host": "localhost:6379"
        }
    },
    "streaming": {
        "registry": {
            "type": "local",
            "redis": {
                "host": "localhost:6379",
                "prefix": "registry:"
            }
        },
    },
    "memcached": {
        "host": ""
    },
    "cdn": {
        "host": ""
    },
    "aws": undefined
});

module.exports = require('./lib/server');
