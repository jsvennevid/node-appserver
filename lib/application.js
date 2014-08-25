var _ = require("underscore"),
    glob = require("glob"),
    path = require("path")
    fs = require("fs"),
    url = require("url"),
    config = require('config').appserver,
    global_config = require('config'),
    UglifyJS = undefined,
    sqwish = undefined;

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
        var target = this.get('target');
        if (_.isUndefined(target)) {
            callback(null);
            return;
        }

        var express = this.express();
        if (_.isArray(target)) {
            _.each(target, function (tgt) {
                app.use(tgt, express);
            }, this);
        } else {
            app.use(target, express);
        }

        callback(null);
    },

    express: function () {
        return function (req, res, next) {
            var file = this.files[req.url.slice(1)];
            if (!file) {
                next();
                return;
            }

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

        if (this.get('publish')) {
            this.publish(this.get('use'));
        }
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
            fs.readFile(file.src, callback);
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
                meta: file
            })
        }, this);
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
                var absolute = path.join(this.getPrimaryTarget(), key, use, file);

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

    getPrimaryTarget: function () {
        var target = this.get('target');
        if (_.isArray(target)) {
            return _.first(target);
        } else {
            return target;
        }
    },

    getParents: function () {
        var parents = [];
        for (var curr = this.parent; !_.isUndefined(curr); curr = curr.parent) {
            parents.push(curr);
        }
        return parents;
    },

    publish: function publish(uses) {
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
                var result = template(data);

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

            _.each([this].concat(this.getParents()), function (app) {
                if (app.cache) {
                    _.each(app.glob(app.cache), function (file) {
                        result += file.dest + "\n";
                    }, app);
                }
            });

            result += "NETWORK:\n*\n";

            callback(null, result);
        }.bind(this);

        this.files[''] = {
            generate: generateIndex,
            type: 'text/html'
        };

        this.files[this.get('name') + '.appcache'] = {
            generate: generateCacheManifest,
            type: 'text/cache-manifest'
        };
    }
});
