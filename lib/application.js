var _ = require("underscore"),
    glob = require("glob"),
    path = require("path")
    fs = require("fs"),
    url = require("url"),
    config = require('config').appserver,
    global_config = require('config'),
    UglifyJS = require('uglify-js'),
    sqwish = require('sqwish'),
    async = require('async'),
    crypto = require('crypto');

module.exports = Application;

function Application()
{
    this.scripts = {};
    this.templates = {};
    this.styles = {};

    this.files = {};
}

_.extend(Application, {
    create: function (options) {
        var app = new Application();

        app.options = options;
        app.build();

        return app;
    }
});

_.extend(Application.prototype, {
    get: function (option, inherit) {
        if (this.options.hasOwnProperty(option)) {
            return this.options[option];
        }

        if (this.parent && (!!inherit || _.isUndefined(inherit))) {
            return this.parent.get(option);
        }

        return undefined;
    },

    mount: function mount (app, callback) {
        async.series([
            function (callback) {
                if (this.get('publish') && !this.published) {
                    this.published = true;
                    this.publish(this.get('use'), callback);
                } else {
                    callback(null);
                }
            }.bind(this),
            function (callback) {
                var target = this.get('target');
                if (!_.isUndefined(target)) {
                    var express = this.express();
                    if (_.isArray(target)) {
                        _.each(target, function (tgt) {
                            app.use(tgt, express);
                        }, this);
                    } else {
                        app.use(target, express);
                    }
                }
                callback(null);
            }.bind(this)
        ], callback);
    },

    express: function () {
        return function (req, res, next) {
            var file;
            do {
                if (file = this.files[req.url.slice(1)]) {
                    break;
                }

                var redirect = this.get('redirect');
                if (!_.isUndefined(redirect) && (file = this.files[redirect])) {
                    break;
                }

                next();
                return;
            } while (0);

            var data = file.data;
            if (data) {
                res.sendResponse(data, {"Content-Type": file.type}, 200);
            } else {
                file.generate(function(err, data) {
                    if (err) {
                        res.sendResponse("NOT FOUND", 404);
                        return;
                    }

                    if (config.production) {
                        file.data = data;
                    }
                    res.sendResponse(data, {"Content-Type": file.type}, 200);
                });
            }
        }.bind(this);
    },

    extend: function (options) {
        var app = new Application();

        app.parent = this;
        app.options = options;
        app.build();

        return app;
    },

    build: function () {
        _.each(this.options.js, function (scripts, name) {
            var matches = this.glob(scripts, {
                group: name
            });

            this.compile(matches, name, this.scripts, 'scripts', 'text/javascript');
        }, this);

        _.each(this.options.templates, function (templates, name) {
            var matches = this.glob(templates, {
                group: name
            });

            this.compile(matches, name, this.templates, 'templates', 'text/javascript', function (file, root) {
                var rname = path.basename(file.dest, '.html').replace(/[-]/g, '_');
                var vname = (file.group + '/' + rname).replace(/[\/]/g, '_');
                var bname = rname + '.js';
                return path.normalize(path.join(root, file.group, bname)).split(path.sep).join('/');
            }, function (file, callback) {
                fs.readFile(file.src, 'utf-8', function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    var rname = path.basename(file.dest, '.html').replace(/[-]/g, '_');
                    var vname = (file.group + '/' + rname).replace(/[\/]/g, '_');

                    var output = _.template(data);
                    var patchData = 'Templates.' + vname + ' = ' + output.source;

                    callback(null, patchData);
                });
            });
        }, this);

        _.each(this.options.styles, function (styles, name) {
            var matches = this.glob(styles, {
                group: name
            });

            this.compile(matches, name, this.styles, 'styles', 'text/css');
        }, this);
    },

    glob: function (specs, options) {
        var files = [];
        options = options || {};

        _.each(specs, function (spec) {
            var filespec, tags;
            if (_.isObject(spec)) {
                filespec = spec.file;
                tags = spec.tags;
            } else {
                filespec = spec;
            }

            if (_.first(filespec) == '/') {
                var foundMatches = false;
                _.each(this.get('static'), function (target) {
                    var root = path.normalize(path.join(this.get('root', false), target)).split(path.sep).join('/');
                    var search = path.normalize(path.join(root, filespec)).split(path.sep).join('/');
                    var match = glob.sync(search);

                    _.each(match, function (file) {
                        files.push(_.extend(_.clone(options), {
                            src: file,
                            dest: file.substr(root.length-1),
                            tags: tags
                        }));
                    });

                    foundMatches = foundMatches || match.length > 0;
                }, this);

                if (!foundMatches) {
                    files.push(_.extend(_.clone(options), {
                        src: null,
                        dest: filespec,
                        tags: tags
                    }));
                }

                return;
            }

            var root = path.normalize(path.join(this.get('root', false),'/')).split(path.sep).join('/');
            var search = path.normalize(path.join(root, filespec)).split(path.sep).join('/');
            var match = glob.sync(search);

            _.each(match, function (file) {
                files.push(_.extend(_.clone(options), {
                    src: file,
                    dest: file.substr(root.length),
                    tags: tags
                }));
            }, this);
        }, this);
        return files;
    },

    compile: function (files, group, target, root, type, transform, compile) {
        output = target[group] = (target[group] || []);

        transform = transform || function (file, root) {
            var bname = path.basename(file.dest);
            return path.normalize(path.join(root, file.group, bname)).split(path.sep).join('/');
        };

        compile = compile || function (file, callback) {
            fs.readFile(file.src, 'utf-8', callback);
        };

        _.each(files, function (file) {
            if (_.first(file.dest) == '/') {
                output.push({
                    name: file.dest,
                    tags: file.tags,
                    meta: file
                });
                return;
            }

            target = transform(file, root);

            var generate = function (callback) {
                compile(file, callback);
            };

            this.files[target] = {
                generate: generate,
                type: type,
                tags: file.tags,
                meta: file
            };

            output.push({
                name: path.basename(target),
                tags: file.tags,
                meta: file,
                target: target
            })
        }, this);
    },

    optimize: function (callback) {
        if (!config.production) {
            callback(null);
            return;
        }

        var types = {
            'styles': {
                'mime': 'text/css',
                'compress': function (input, callback) {
                    var output = sqwish.minify(input);
                    callback(null, output);
                }
            },
            'scripts': {
                'mime': 'text/javascript',
                'compress': function (input, callback) {
                    var output = UglifyJS.minify(input, {
                        fromString: true
                    });
                    callback(null, output.code);
                }
            },
            'templates': {
                'mime': 'text/javascript',
                'compress': function (input, callback) {
                    var output = UglifyJS.minify(input, {
                        fromString: true
                    });
                    callback(null, output.code);
                }
            }
        };

        async.eachSeries(_.keys(types), function (type, callback) {
            var groups = {};

            _.each(this[type], function (entries, group) {
                var bundles = [];
                var bundle = [];

                _.each(entries, function (entry) {
                    var excluded = !_.isUndefined(entry.tags) || !_.isString(entry.meta.src);

                    if (excluded) {
                        if (bundle.length > 0) {
                            bundles.push(bundle);
                            bundle = [];
                        }
                        bundles.push([entry]);
                    } else {
                        bundle.push(entry);
                    }
                }, this);

                if (bundle.length > 0) {
                    bundles.push(bundle);
                }

                groups[group] = bundles;
            }, this);

            async.eachSeries(_.keys(groups), function (name, callback) {
                var entries = [], current = 1;
                async.eachSeries(groups[name], function (bundle, callback) {
                    var files = _.filter(bundle, function (entry) {
                        return !(!_.isUndefined(entry.tags) || !_.isString(entry.meta.src));
                    });

                    if (files.length == 0) {
                        entries = entries.concat(bundle);
                        callback(null);
                        return;
                    }

                    async.concatSeries(files, function (entry, callback) {
                        if (entry.target) {
                            this.files[entry.target].generate(callback);
                        } else {
                            fs.readFile(entry.meta.src, 'utf-8', callback);
                        }
                    }.bind(this), function (err, result) {
                        if (err) {
                            callback(err);
                            return;
                        }
                        var data = result.join("\n");

                        var filename = path.normalize(path.join(type, name, name + (current++) + path.extname(_.first(files).name))).split(path.sep).join("/");

                        this.files[filename] = {
                            data: data,
                            type: types[type].mime
                        };

                        async.eachSeries(files, function (entry, callback) {
                            if (entry.target) {
                                delete this.files[entry.target];
                            }
                            callback(null);
                        }.bind(this));

                        entries.push({
                            name: path.basename(filename),
                            target: filename
                        });

                        callback(null);
                    }.bind(this));
                }.bind(this), function (err) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    this[type][name] = entries;
                    callback(null);
                }.bind(this));
            }.bind(this), callback);
        }.bind(this), function (err) {
            if (err || !config.compress) {
                callback(err);
                return;
            }

            async.eachSeries(_.keys(types), function (type, callback) {
                var compressor = types[type].compress;
                var groups = this[type];

                async.eachSeries(_.keys(groups), function (name, callback) {
                    var group = groups[name];

                    async.eachSeries(group, function (entry, callback) {
                        if (!entry.target) {
                            callback(null);
                            return;
                        }

                        var file = this.files[entry.target];
                        if (!file.data) {
                            callback(null);
                            return;
                        }

                        this.compressBundle(this.get('name'), type, name, entry.name, file.data, compressor, function (err, output) {
                            if (err) {
                                callback(err);
                                return;
                            }

                            file.data = output;
                            callback(null);
                        });
                    }.bind(this), callback);
                }.bind(this), callback);
            }.bind(this), callback);
        }.bind(this));
    },

    gather: function (target, key, use, root) {
        if (!this.hasOwnProperty(key)) {
            return;
        }

        var types = this[key];
        root = path.normalize(root).split(path.sep).join('/');

        _.each(types[use], function (entry) {
            var file = entry.name;
            if (file[0] != '/') {
                var absolute = path.normalize(path.join(this.getPrimaryTarget(), key, use, file)).split(path.sep).join("/");

                target.push({
                    name: absolute,
                    tags: entry.tags,
                    meta: entry.meta
                });
            } else {
                target.push(entry);
            }
        }, this);
    },

    compressBundle: function (app, type, group, name, data, compressor, callback) {
        if (!config.bundlecache) {
            callback(null, data);
            return;
        }

        if (!fs.existsSync(config.bundlecache)) {
            var err = fs.mkdirSync(config.bundlecache)
            if (err) {
                callback("Could not create bundle cache %s: %s", config.bundlecache, err);
                return;
            }
        }

        var hash = crypto.createHash('sha1');
        hash.update(data);

        var d = hash.digest('hex');

        var filename = path.join(config.bundlecache, path.join(app, group, name, d).split(path.sep).join("_"));

        fs.exists(filename, function (exists) {
            if (exists) {
                fs.readFile(filename, callback);
            } else {
                compressor(data, function (err, output) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    fs.writeFile(filename, output, {
                        encoding: 'utf8'
                    }, function (err) {
                        callback(err, output);
                    });
                });
            }
        });
    },

    getPrimaryTarget: function () {
        var target = this.get('target');
        if (_.isArray(target)) {
            return _.first(target);
        } else {
            return target;
        }
    },

    getTargets: function () {
        var target = this.get('target');
        if (_.isArray(target)) {
            return target;
        } else {
            return [target];
        }
    },

    getParents: function () {
        var parents = [];
        for (var curr = this.parent; !_.isUndefined(curr); curr = curr.parent) {
            parents.push(curr);
        }
        return parents;
    },

    publish: function publish(uses, callback) {
        var data = {
            styles: [],
            scripts: [],
            templates: []
        };

        _.each(uses, function (use) {
            _.each(this.getParents().reverse().concat(this), function (app) {
                _.each(data, function (target, key) {
                    app.gather(target, key, use, this.getPrimaryTarget());
                }, this);
            }, this);
        }, this);

        var generateIndex = function (callback) {
            var input = fs.readFile(path.join(this.get('root'), 'index.html'), 'utf-8', function (err, input) {
                if (err) {
                    callback(err);
                    return;
                }

                var template = _.template(input);
                var result = template.call(this, data);

                callback(null, result);
            }.bind(this));
        }.bind(this);

        var dateTime = new Date().toString();
        var generateCacheManifest = function (callback) {
            var result = "CACHE MANIFEST\n# Timestamp: " + dateTime + "\n";
            if (!config.production) {
                callback(null, result);
                return;
            }

            result += "# Application\n";

            _.each(data, function (target, key) {
                _.each(target, function (entry) {
                    result += entry.name + "\n";
                });
            });

            result += "# Explicitly cached\n";

            _.each([this].concat(this.getParents()).reverse(), function (app) {
                var cache = app.get('cache', false);
                if (cache) {
                    _.each(app.glob(cache), function (file) {
                        result += file.dest + "\n";
                    }, app);
                }
            });

            result += "NETWORK:\n*\n";

            callback(null, result);
        }.bind(this);

        var index = {
            generate: generateIndex,
            type: 'text/html'
        };

        var appCache = {
            generate: generateCacheManifest,
            type: 'text/cache-manifest'
        };

        this.files[''] = index;
        this.files[this.get('name') + '.appcache'] = appCache;

        if (config.production) {
            async.eachSeries([index, appCache], function (file, callback) {
                file.generate(function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    file.data = data;
                    callback(null);
                })
            }, callback);
        } else {
            callback(null);
        }
    }
});
