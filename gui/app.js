// Copyright (C) 2014 Jakob Borg and Contributors (see the CONTRIBUTORS file).
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details.
//
// You should have received a copy of the GNU General Public License along
// with this program. If not, see <http://www.gnu.org/licenses/>.

/*jslint browser: true, continue: true, plusplus: true */
/*global $: false, angular: false, console: false, validLangs: false */

'use strict';

var syncthing = angular.module('syncthing', ['pascalprecht.translate']);
var urlbase = 'rest';
var guiVersion = null;

syncthing.config(function ($httpProvider, $translateProvider) {
    $httpProvider.defaults.xsrfHeaderName = 'X-CSRF-Token';
    $httpProvider.defaults.xsrfCookieName = 'CSRF-Token';
    $httpProvider.interceptors.push(function() {
      return {
        response: function(response) {
            var responseVersion = response.headers()['x-syncthing-version'];
            if (!guiVersion) {
                guiVersion = responseVersion;
            } else if (guiVersion != responseVersion) {
                document.location.reload(true);
            }
            return response;
        }
      };
    });

    $translateProvider.useStaticFilesLoader({
        prefix: 'lang/lang-',
        suffix: '.json'
    });
});

syncthing.controller('EventCtrl', function ($scope, $http) {
    $scope.lastEvent = null;
    var lastID = 0;

    var successFn = function (data) {
        // When Syncthing restarts while the long polling connection is in
        // progress the browser on some platforms returns a 200 (since the
        // headers has been flushed with the return code 200), with no data.
        // This basically means that the connection has been reset, and the call
        // was not actually sucessful.
        if (!data) {
            errorFn(data);
            return;
        }

        $scope.$emit('UIOnline');

        if (lastID > 0) {
            data.forEach(function (event) {
                console.log("event", event.id, event.type, event.data);
                $scope.$emit(event.type, event);
            });
        }

        $scope.lastEvent = data[data.length - 1];
        lastID = $scope.lastEvent.id;

        setTimeout(function () {
            $http.get(urlbase + '/events?since=' + lastID)
                .success(successFn)
                .error(errorFn);
        }, 500);
    };

    var errorFn = function (data) {
        $scope.$emit('UIOffline');

        setTimeout(function () {
            $http.get(urlbase + '/events?limit=1')
                .success(successFn)
                .error(errorFn);
        }, 1000);
    };

    $http.get(urlbase + '/events?limit=1')
        .success(successFn)
        .error(errorFn);
});

syncthing.controller('SyncthingCtrl', function ($scope, $http, $translate, $location) {
    var prevDate = 0;
    var getOK = true;
    var navigatingAway = false;
    var online = false;
    var restarting = false;

    $scope.completion = {};
    $scope.config = {};
    $scope.configInSync = true;
    $scope.connections = {};
    $scope.errors = [];
    $scope.model = {};
    $scope.myID = '';
    $scope.devices = [];
    $scope.protocolChanged = false;
    $scope.reportData = {};
    $scope.reportPreview = false;
    $scope.folders = {};
    $scope.seenError = '';
    $scope.upgradeInfo = null;
    $scope.stats = {};

    $http.get(urlbase + "/lang").success(function (langs) {
        // Find the first language in the list provided by the user's browser
        // that is a prefix of a language we have available. That is, "en"
        // sent by the browser will match "en" or "en-US", while "zh-TW" will
        // match only "zh-TW" and not "zh-CN".

        var lang, matching;
        for (var i = 0; i < langs.length; i++) {
            lang = langs[i];
            if (lang.length < 2) {
                continue;
            }
            matching = validLangs.filter(function (possibleLang) {
                // The langs returned by the /rest/langs call will be in lower
                // case. We compare to the lowercase version of the language
                // code we have as well.
                possibleLang = possibleLang.toLowerCase();
                if (possibleLang.length > lang.length) {
                    return possibleLang.indexOf(lang) === 0;
                } else {
                    return lang.indexOf(possibleLang) === 0;
                }
            });
            if (matching.length >= 1) {
                $translate.use(matching[0]);
                return;
            }
        }
        // Fallback if nothing matched
        $translate.use("en");
    });

    $(window).bind('beforeunload', function () {
        navigatingAway = true;
    });

    $scope.$on("$locationChangeSuccess", function () {
        var lang = $location.search().lang;
        if (lang) {
            $translate.use(lang);
        }
    });

    $scope.needActions = {
        'rm': 'Del',
        'rmdir': 'Del (dir)',
        'sync': 'Sync',
        'touch': 'Update',
    };
    $scope.needIcons = {
        'rm': 'remove',
        'rmdir': 'remove',
        'sync': 'download',
        'touch': 'asterisk',
    };

    $scope.$on('UIOnline', function (event, arg) {
        if (online && !restarting) {
            return;
        }

        console.log('UIOnline');
        $scope.init();
        online = true;
        restarting = false;
        $('#networkError').modal('hide');
        $('#restarting').modal('hide');
        $('#shutdown').modal('hide');
    });

    $scope.$on('UIOffline', function (event, arg) {
        if (navigatingAway || !online) {
            return;
        }

        console.log('UIOffline');
        online = false;
        if (!restarting) {
            $('#networkError').modal();
        }
    });

    $scope.$on('StateChanged', function (event, arg) {
        var data = arg.data;
        if ($scope.model[data.folder]) {
            $scope.model[data.folder].state = data.to;
        }
    });

    $scope.$on('LocalIndexUpdated', function (event, arg) {
        var data = arg.data;
        refreshFolder(data.folder);

        // Update completion status for all devices that we share this folder with.
        $scope.folders[data.folder].Devices.forEach(function (deviceCfg) {
            refreshCompletion(deviceCfg.DeviceID, data.folder);
        });
    });

    $scope.$on('RemoteIndexUpdated', function (event, arg) {
        var data = arg.data;
        refreshFolder(data.folder);
        refreshCompletion(data.device, data.folder);
    });

    $scope.$on('DeviceDisconnected', function (event, arg) {
        delete $scope.connections[arg.data.id];
        refreshDeviceStats();
    });

    $scope.$on('DeviceConnected', function (event, arg) {
        if (!$scope.connections[arg.data.id]) {
            $scope.connections[arg.data.id] = {
                inbps: 0,
                outbps: 0,
                InBytesTotal: 0,
                OutBytesTotal: 0,
                Address: arg.data.addr,
            };
            $scope.completion[arg.data.id] = {
                _total: 100,
            };
        }
    });

    $scope.$on('ConfigLoaded', function (event) {
        if ($scope.config.Options.URAccepted === 0) {
            // If usage reporting has been neither accepted nor declined,
            // we want to ask the user to make a choice. But we don't want
            // to bug them during initial setup, so we set a cookie with
            // the time of the first visit. When that cookie is present
            // and the time is more than four hours ago, we ask the
            // question.

            var firstVisit = document.cookie.replace(/(?:(?:^|.*;\s*)firstVisit\s*\=\s*([^;]*).*$)|^.*$/, "$1");
            if (!firstVisit) {
                document.cookie = "firstVisit=" + Date.now() + ";max-age=" + 30 * 24 * 3600;
            } else {
                if (+firstVisit < Date.now() - 4 * 3600 * 1000) {
                    $('#ur').modal();
                }
            }
        }
    });

    $scope.$on('ConfigSaved', function (event, arg) {
        updateLocalConfig(arg.data);

        $http.get(urlbase + '/config/sync').success(function (data) {
            $scope.configInSync = data.configInSync;
        });
    });

    var debouncedFuncs = {};

    function refreshFolder(folder) {
        var key = "refreshFolder" + folder;
        if (!debouncedFuncs[key]) {
            debouncedFuncs[key] = debounce(function () {
                $http.get(urlbase + '/model?folder=' + encodeURIComponent(folder)).success(function (data) {
                    $scope.model[folder] = data;
                    console.log("refreshFolder", folder, data);
                });
            }, 1000, true);
        }
        debouncedFuncs[key]();
    }

    function updateLocalConfig(config) {
        var hasConfig = !isEmptyObject($scope.config);

        $scope.config = config;
        $scope.config.Options.ListenStr = $scope.config.Options.ListenAddress.join(', ');

        $scope.devices = $scope.config.Devices;
        $scope.devices.forEach(function (deviceCfg) {
            $scope.completion[deviceCfg.DeviceID] = {
                _total: 100,
            };
        });
        $scope.devices.sort(deviceCompare);

        $scope.folders = folderMap($scope.config.Folders);
        Object.keys($scope.folders).forEach(function (folder) {
            refreshFolder(folder);
            $scope.folders[folder].Devices.forEach(function (deviceCfg) {
                refreshCompletion(deviceCfg.DeviceID, folder);
            });
        });

        if (!hasConfig) {
            $scope.$emit('ConfigLoaded');
        }
    }

    function refreshSystem() {
        $http.get(urlbase + '/system').success(function (data) {
            $scope.myID = data.myID;
            $scope.system = data;
            console.log("refreshSystem", data);
        });
    }

    function refreshCompletion(device, folder) {
        if (device === $scope.myID) {
            return;
        }

        var key = "refreshCompletion" + device + folder;
        if (!debouncedFuncs[key]) {
            debouncedFuncs[key] = debounce(function () {
                $http.get(urlbase + '/completion?device=' + device + '&folder=' + encodeURIComponent(folder)).success(function (data) {
                    if (!$scope.completion[device]) {
                        $scope.completion[device] = {};
                    }
                    $scope.completion[device][folder] = data.completion;

                    var tot = 0,
                        cnt = 0;
                    for (var cmp in $scope.completion[device]) {
                        if (cmp === "_total") {
                            continue;
                        }
                        tot += $scope.completion[device][cmp];
                        cnt += 1;
                    }
                    $scope.completion[device]._total = tot / cnt;

                    console.log("refreshCompletion", device, folder, $scope.completion[device]);
                });
            }, 1000, true);
        }
        debouncedFuncs[key]();
    }

    function refreshConnectionStats() {
        $http.get(urlbase + '/connections').success(function (data) {
            var now = Date.now(),
                td = (now - prevDate) / 1000,
                id;

            prevDate = now;
            for (id in data) {
                if (!data.hasOwnProperty(id)) {
                    continue;
                }
                try {
                    data[id].inbps = Math.max(0, 8 * (data[id].InBytesTotal - $scope.connections[id].InBytesTotal) / td);
                    data[id].outbps = Math.max(0, 8 * (data[id].OutBytesTotal - $scope.connections[id].OutBytesTotal) / td);
                } catch (e) {
                    data[id].inbps = 0;
                    data[id].outbps = 0;
                }
            }
            $scope.connections = data;
            console.log("refreshConnections", data);
        });
    }

    function refreshErrors() {
        $http.get(urlbase + '/errors').success(function (data) {
            $scope.errors = data.errors;
            console.log("refreshErrors", data);
        });
    }

    function refreshConfig() {
        $http.get(urlbase + '/config').success(function (data) {
            updateLocalConfig(data);
            console.log("refreshConfig", data);
        });

        $http.get(urlbase + '/config/sync').success(function (data) {
            $scope.configInSync = data.configInSync;
        });
    }

    var refreshDeviceStats = debounce(function () {
        $http.get(urlbase + "/stats/device").success(function (data) {
            $scope.stats = data;
            for (var device in $scope.stats) {
                $scope.stats[device].LastSeen = new Date($scope.stats[device].LastSeen);
                $scope.stats[device].LastSeenDays = (new Date() - $scope.stats[device].LastSeen) / 1000 / 86400;
            }
            console.log("refreshDeviceStats", data);
        });
    }, 500);

    $scope.init = function () {
        refreshSystem();
        refreshConfig();
        refreshConnectionStats();
        refreshDeviceStats();

        $http.get(urlbase + '/version').success(function (data) {
            $scope.version = data.version;
        });

        $http.get(urlbase + '/report').success(function (data) {
            $scope.reportData = data;
        });

        $http.get(urlbase + '/upgrade').success(function (data) {
            $scope.upgradeInfo = data;
        }).error(function () {
            $scope.upgradeInfo = null;
        });
    };

    $scope.refresh = function () {
        refreshSystem();
        refreshConnectionStats();
        refreshErrors();
    };

    $scope.folderStatus = function (folder) {
        if (typeof $scope.model[folder] === 'undefined') {
            return 'unknown';
        }

        if ($scope.model[folder].invalid !== '') {
            return 'stopped';
        }

        return '' + $scope.model[folder].state;
    };

    $scope.folderClass = function (folder) {
        if (typeof $scope.model[folder] === 'undefined') {
            return 'info';
        }

        if ($scope.model[folder].invalid !== '') {
            return 'danger';
        }

        var state = '' + $scope.model[folder].state;
        if (state == 'idle') {
            return 'success';
        }
        if (state == 'syncing') {
            return 'primary';
        }
        if (state == 'scanning') {
            return 'primary';
        }
        return 'info';
    };

    $scope.syncPercentage = function (folder) {
        if (typeof $scope.model[folder] === 'undefined') {
            return 100;
        }
        if ($scope.model[folder].globalBytes === 0) {
            return 100;
        }

        var pct = 100 * $scope.model[folder].inSyncBytes / $scope.model[folder].globalBytes;
        return Math.floor(pct);
    };

    $scope.deviceIcon = function (deviceCfg) {
        if ($scope.connections[deviceCfg.DeviceID]) {
            if ($scope.completion[deviceCfg.DeviceID] && $scope.completion[deviceCfg.DeviceID]._total === 100) {
                return 'ok';
            } else {
                return 'refresh';
            }
        }

        return 'minus';
    };

    $scope.deviceClass = function (deviceCfg) {
        if ($scope.connections[deviceCfg.DeviceID]) {
            if ($scope.completion[deviceCfg.DeviceID] && $scope.completion[deviceCfg.DeviceID]._total === 100) {
                return 'success';
            } else {
                return 'primary';
            }
        }

        return 'info';
    };

    $scope.deviceAddr = function (deviceCfg) {
        var conn = $scope.connections[deviceCfg.DeviceID];
        if (conn) {
            return conn.Address;
        }
        return '?';
    };

    $scope.deviceCompletion = function (deviceCfg) {
        var conn = $scope.connections[deviceCfg.DeviceID];
        if (conn) {
            return conn.Completion + '%';
        }
        return '';
    };

    $scope.findDevice = function (deviceID) {
        var matches = $scope.devices.filter(function (n) {
            return n.DeviceID == deviceID;
        });
        if (matches.length != 1) {
            return undefined;
        }
        return matches[0];
    };

    $scope.deviceName = function (deviceCfg) {
        if (typeof deviceCfg === 'undefined') {
            return "";
        }
        if (deviceCfg.Name) {
            return deviceCfg.Name;
        }
        return deviceCfg.DeviceID.substr(0, 6);
    };

    $scope.thisDeviceName = function () {
        var device = $scope.thisDevice();
        if (typeof device === 'undefined') {
            return "(unknown device)";
        }
        if (device.Name) {
            return device.Name;
        }
        return device.DeviceID.substr(0, 6);
    };

    $scope.editSettings = function () {
        // Make a working copy
        $scope.tmpOptions = angular.copy($scope.config.Options);
        $scope.tmpOptions.UREnabled = ($scope.tmpOptions.URAccepted > 0);
        $scope.tmpOptions.DeviceName = $scope.thisDevice().Name;
        $scope.tmpOptions.AutoUpgradeEnabled = ($scope.tmpOptions.AutoUpgradeIntervalH > 0);
        $scope.tmpGUI = angular.copy($scope.config.GUI);
        $('#settings').modal();
    };

    $scope.saveConfig = function () {
        var cfg = JSON.stringify($scope.config);
        var opts = {
            headers: {
                'Content-Type': 'application/json'
            }
        };
        $http.post(urlbase + '/config', cfg, opts).success(function () {
            $http.get(urlbase + '/config/sync').success(function (data) {
                $scope.configInSync = data.configInSync;
            });
        });
    };

    $scope.saveSettings = function () {
        // Make sure something changed
        var changed = !angular.equals($scope.config.Options, $scope.tmpOptions) ||
            !angular.equals($scope.config.GUI, $scope.tmpGUI);
        if (changed) {
            // Check if usage reporting has been enabled or disabled
            if ($scope.tmpOptions.UREnabled && $scope.tmpOptions.URAccepted <= 0) {
                $scope.tmpOptions.URAccepted = 1000;
            } else if (!$scope.tmpOptions.UREnabled && $scope.tmpOptions.URAccepted > 0) {
                $scope.tmpOptions.URAccepted = -1;
            }

            // Check if auto-upgrade has been enabled or disabled
            if ($scope.tmpOptions.AutoUpgradeEnabled) {
                $scope.tmpOptions.AutoUpgradeIntervalH = $scope.tmpOptions.AutoUpgradeIntervalH || 12;
            } else {
                $scope.tmpOptions.AutoUpgradeIntervalH = 0;
            }

            // Check if protocol will need to be changed on restart
            if ($scope.config.GUI.UseTLS !== $scope.tmpGUI.UseTLS) {
                $scope.protocolChanged = true;
            }

            // Apply new settings locally
            $scope.thisDevice().Name = $scope.tmpOptions.DeviceName;
            $scope.config.Options = angular.copy($scope.tmpOptions);
            $scope.config.GUI = angular.copy($scope.tmpGUI);
            $scope.config.Options.ListenAddress = $scope.config.Options.ListenStr.split(',').map(function (x) {
                return x.trim();
            });

            $scope.saveConfig();
        }

        $('#settings').modal("hide");
    };

    $scope.restart = function () {
        restarting = true;
        $('#restarting').modal();
        $http.post(urlbase + '/restart');
        $scope.configInSync = true;

        // Switch webpage protocol if needed
        if ($scope.protocolChanged) {
            var protocol = 'http';

            if ($scope.config.GUI.UseTLS) {
                protocol = 'https';
            }

            setTimeout(function () {
                window.location.protocol = protocol;
            }, 2500);

            $scope.protocolChanged = false;
        }
    };

    $scope.upgrade = function () {
        restarting = true;
        $('#upgrading').modal();
        $http.post(urlbase + '/upgrade').success(function () {
            $('#restarting').modal();
            $('#upgrading').modal('hide');
        }).error(function () {
            $('#upgrading').modal('hide');
        });
    };

    $scope.shutdown = function () {
        restarting = true;
        $http.post(urlbase + '/shutdown').success(function () {
            $('#shutdown').modal();
        });
        $scope.configInSync = true;
    };

    $scope.editDevice = function (deviceCfg) {
        $scope.currentDevice = $.extend({}, deviceCfg);
        $scope.editingExisting = true;
        $scope.editingSelf = (deviceCfg.DeviceID == $scope.myID);
        $scope.currentDevice.AddressesStr = deviceCfg.Addresses.join(', ');
        $scope.deviceEditor.$setPristine();
        $('#editDevice').modal();
    };

    $scope.idDevice = function () {
        $('#idqr').modal('show');
    };

    $scope.addDevice = function () {
        $http.get(urlbase + '/discovery')
		.success(function (registry) {
			$scope.discovery = registry;
		})
		.then(function () {
			$scope.currentDevice = {
			    AddressesStr: 'dynamic',
			    Compression: true,
			    Introducer: false
			};
			$scope.editingExisting = false;
			$scope.editingSelf = false;
			$scope.deviceEditor.$setPristine();
			$('#editDevice').modal();
		});
    };

    $scope.deleteDevice = function () {
        $('#editDevice').modal('hide');
        if (!$scope.editingExisting) {
            return;
        }

        $scope.devices = $scope.devices.filter(function (n) {
            return n.DeviceID !== $scope.currentDevice.DeviceID;
        });
        $scope.config.Devices = $scope.devices;

        for (var id in $scope.folders) {
            $scope.folders[id].Devices = $scope.folders[id].Devices.filter(function (n) {
                return n.DeviceID !== $scope.currentDevice.DeviceID;
            });
        }

        $scope.saveConfig();
    };

    $scope.saveDevice = function () {
        var deviceCfg, done, i;

        $('#editDevice').modal('hide');
        deviceCfg = $scope.currentDevice;
        deviceCfg.Addresses = deviceCfg.AddressesStr.split(',').map(function (x) {
            return x.trim();
        });

        done = false;
        for (i = 0; i < $scope.devices.length; i++) {
            if ($scope.devices[i].DeviceID === deviceCfg.DeviceID) {
                $scope.devices[i] = deviceCfg;
                done = true;
                break;
            }
        }

        if (!done) {
            $scope.devices.push(deviceCfg);
        }

        $scope.devices.sort(deviceCompare);
        $scope.config.Devices = $scope.devices;

        $scope.saveConfig();
    };

    $scope.otherDevices = function () {
        return $scope.devices.filter(function (n) {
            return n.DeviceID !== $scope.myID;
        });
    };

    $scope.thisDevice = function () {
        var i, n;

        for (i = 0; i < $scope.devices.length; i++) {
            n = $scope.devices[i];
            if (n.DeviceID === $scope.myID) {
                return n;
            }
        }
    };

    $scope.allDevices = function () {
        var devices = $scope.otherDevices();
        devices.push($scope.thisDevice());
        return devices;
    };

    $scope.errorList = function () {
        return $scope.errors.filter(function (e) {
            return e.Time > $scope.seenError;
        });
    };

    $scope.clearErrors = function () {
        $scope.seenError = $scope.errors[$scope.errors.length - 1].Time;
        $http.post(urlbase + '/error/clear');
    };

    $scope.friendlyDevices = function (str) {
        for (var i = 0; i < $scope.devices.length; i++) {
            var cfg = $scope.devices[i];
            str = str.replace(cfg.DeviceID, $scope.deviceName(cfg));
        }
        return str;
    };

    $scope.folderList = function () {
        return folderList($scope.folders);
    };

    $scope.directoryList = [];

    $scope.$watch('currentFolder.Path', function (newvalue) {
      $http({
        method: 'GET',
        url: urlbase + '/directoryAutocomplete',
        params: { soFar: newvalue }
      }).success(function (data) {
        $scope.directoryList = data;
      });
    });

    $scope.editFolder = function (deviceCfg) {
        $scope.currentFolder = angular.copy(deviceCfg);
        $scope.currentFolder.selectedDevices = {};
        $scope.currentFolder.Devices.forEach(function (n) {
            $scope.currentFolder.selectedDevices[n.DeviceID] = true;
        });
        if ($scope.currentFolder.Versioning && $scope.currentFolder.Versioning.Type === "simple") {
            $scope.currentFolder.simpleFileVersioning = true;
            $scope.currentFolder.FileVersioningSelector = "simple";
            $scope.currentFolder.simpleKeep = +$scope.currentFolder.Versioning.Params.keep;
        } else if ($scope.currentFolder.Versioning && $scope.currentFolder.Versioning.Type === "staggered") {
            $scope.currentFolder.staggeredFileVersioning = true;
            $scope.currentFolder.FileVersioningSelector = "staggered";
            $scope.currentFolder.staggeredMaxAge = Math.floor(+$scope.currentFolder.Versioning.Params.maxAge / 86400);
            $scope.currentFolder.staggeredCleanInterval = +$scope.currentFolder.Versioning.Params.cleanInterval;
            $scope.currentFolder.staggeredVersionsPath = $scope.currentFolder.Versioning.Params.versionsPath;
        } else {
            $scope.currentFolder.FileVersioningSelector = "none";
        }
        $scope.currentFolder.simpleKeep = $scope.currentFolder.simpleKeep || 5;
        $scope.currentFolder.staggeredCleanInterval = $scope.currentFolder.staggeredCleanInterval || 3600;
        $scope.currentFolder.staggeredVersionsPath = $scope.currentFolder.staggeredVersionsPath || "";

        // staggeredMaxAge can validly be zero, which we should not replace
        // with the default value of 365. So only set the default if it's
        // actually undefined.
        if (typeof $scope.currentFolder.staggeredMaxAge === 'undefined') {
            $scope.currentFolder.staggeredMaxAge = 365;
        }

        $scope.editingExisting = true;
        $scope.folderEditor.$setPristine();
        $('#editFolder').modal();
    };

    $scope.addFolder = function () {
        $scope.currentFolder = {
            selectedDevices: {}
        };
        $scope.currentFolder.RescanIntervalS = 60;
        $scope.currentFolder.FileVersioningSelector = "none";
        $scope.currentFolder.simpleKeep = 5;
        $scope.currentFolder.staggeredMaxAge = 365;
        $scope.currentFolder.staggeredCleanInterval = 3600;
        $scope.currentFolder.staggeredVersionsPath = "";
        $scope.editingExisting = false;
        $scope.folderEditor.$setPristine();
        $('#editFolder').modal();
    };

    $scope.saveFolder = function () {
        var folderCfg, done, i;

        $('#editFolder').modal('hide');
        folderCfg = $scope.currentFolder;
        folderCfg.Devices = [];
        folderCfg.selectedDevices[$scope.myID] = true;
        for (var deviceID in folderCfg.selectedDevices) {
            if (folderCfg.selectedDevices[deviceID] === true) {
                folderCfg.Devices.push({
                    DeviceID: deviceID
                });
            }
        }
        delete folderCfg.selectedDevices;

        if (folderCfg.FileVersioningSelector === "simple") {
            folderCfg.Versioning = {
                'Type': 'simple',
                'Params': {
                    'keep': '' + folderCfg.simpleKeep,
                }
            };
            delete folderCfg.simpleFileVersioning;
            delete folderCfg.simpleKeep;
        } else if (folderCfg.FileVersioningSelector === "staggered") {
            folderCfg.Versioning = {
                'Type': 'staggered',
                'Params': {
                    'maxAge': '' + (folderCfg.staggeredMaxAge * 86400),
                    'cleanInterval': '' + folderCfg.staggeredCleanInterval,
                    'versionsPath': '' + folderCfg.staggeredVersionsPath,
                }
            };
            delete folderCfg.staggeredFileVersioning;
            delete folderCfg.staggeredMaxAge;
            delete folderCfg.staggeredCleanInterval;
            delete folderCfg.staggeredVersionsPath;

        } else {
            delete folderCfg.Versioning;
        }

        $scope.folders[folderCfg.ID] = folderCfg;
        $scope.config.Folders = folderList($scope.folders);

        $scope.saveConfig();
    };

    $scope.sharesFolder = function (folderCfg) {
        var names = [];
        folderCfg.Devices.forEach(function (device) {
            names.push($scope.deviceName($scope.findDevice(device.DeviceID)));
        });
        names.sort();
        return names.join(", ");
    };

    $scope.deleteFolder = function () {
        $('#editFolder').modal('hide');
        if (!$scope.editingExisting) {
            return;
        }

        delete $scope.folders[$scope.currentFolder.ID];
        $scope.config.Folders = folderList($scope.folders);

        $scope.saveConfig();
    };

    $scope.editIgnores = function () {
        if (!$scope.editingExisting) {
            return;
        }

        $('#editIgnoresButton').attr('disabled', 'disabled');
        $http.get(urlbase + '/ignores?folder=' + encodeURIComponent($scope.currentFolder.ID))
            .success(function (data) {
                data.ignore = data.ignore || [];

                $('#editFolder').modal('hide');
                var textArea = $('#editIgnores textarea');

                textArea.val(data.ignore.join('\n'));

                $('#editIgnores').modal()
                    .on('hidden.bs.modal', function () {
                        $('#editFolder').modal();
                    })
                    .on('shown.bs.modal', function () {
                        textArea.focus();
                    });
            })
            .then(function () {
                $('#editIgnoresButton').removeAttr('disabled');
            });
    };

    $scope.saveIgnores = function () {
        if (!$scope.editingExisting) {
            return;
        }

        $http.post(urlbase + '/ignores?folder=' + encodeURIComponent($scope.currentFolder.ID), {
            ignore: $('#editIgnores textarea').val().split('\n')
        });
    };

    $scope.setAPIKey = function (cfg) {
        cfg.APIKey = randomString(30, 32);
    };

    $scope.showURPreview = function () {
        $('#settings').modal('hide');
        $('#urPreview').modal().on('hidden.bs.modal', function () {
            $('#settings').modal();
        });
    };

    $scope.acceptUR = function () {
        $scope.config.Options.URAccepted = 1000; // Larger than the largest existing report version
        $scope.saveConfig();
        $('#ur').modal('hide');
    };

    $scope.declineUR = function () {
        $scope.config.Options.URAccepted = -1;
        $scope.saveConfig();
        $('#ur').modal('hide');
    };

    $scope.showNeed = function (folder) {
        $scope.neededLoaded = false;
        $('#needed').modal();
        $http.get(urlbase + "/need?folder=" + encodeURIComponent(folder)).success(function (data) {
            $scope.needed = data;
            $scope.neededLoaded = true;
        });
    };

    $scope.needAction = function (file) {
        var fDelete = 4096;
        var fDirectory = 16384;

        if ((file.Flags & (fDelete + fDirectory)) === fDelete + fDirectory) {
            return 'rmdir';
        } else if ((file.Flags & fDelete) === fDelete) {
            return 'rm';
        } else if ((file.Flags & fDirectory) === fDirectory) {
            return 'touch';
        } else {
            return 'sync';
        }
    };

    $scope.override = function (folder) {
        $http.post(urlbase + "/model/override?folder=" + encodeURIComponent(folder));
    };

    $scope.about = function () {
        $('#about').modal('show');
    };

    $scope.showReportPreview = function () {
        $scope.reportPreview = true;
    };

    $scope.rescanFolder = function (folder) {
        $http.post(urlbase + "/scan?folder=" + encodeURIComponent(folder));
    };

    $scope.init();
    setInterval($scope.refresh, 10000);
});

function deviceCompare(a, b) {
    if (typeof a.Name !== 'undefined' && typeof b.Name !== 'undefined') {
        if (a.Name < b.Name)
            return -1;
        return a.Name > b.Name;
    }
    if (a.DeviceID < b.DeviceID) {
        return -1;
    }
    return a.DeviceID > b.DeviceID;
}

function folderCompare(a, b) {
    if (a.ID < b.ID) {
        return -1;
    }
    return a.ID > b.ID;
}

function folderMap(l) {
    var m = {};
    l.forEach(function (r) {
        m[r.ID] = r;
    });
    return m;
}

function folderList(m) {
    var l = [];
    for (var id in m) {
        l.push(m[id]);
    }
    l.sort(folderCompare);
    return l;
}

function decimals(val, num) {
    var digits, decs;

    if (val === 0) {
        return 0;
    }

    digits = Math.floor(Math.log(Math.abs(val)) / Math.log(10));
    decs = Math.max(0, num - digits);
    return decs;
}

function randomString(len, bits) {
    bits = bits || 36;
    var outStr = "",
        newStr;
    while (outStr.length < len) {
        newStr = Math.random().toString(bits).slice(2);
        outStr += newStr.slice(0, Math.min(newStr.length, (len - outStr.length)));
    }
    return outStr.toLowerCase();
}

function isEmptyObject(obj) {
    var name;
    for (name in obj) {
        return false;
    }
    return true;
}

function debounce(func, wait) {
    var timeout, args, context, timestamp, result, again;

    var later = function () {
        var last = Date.now() - timestamp;
        if (last < wait) {
            timeout = setTimeout(later, wait - last);
        } else {
            timeout = null;
            if (again) {
                again = false;
                result = func.apply(context, args);
                context = args = null;
            }
        }
    };

    return function () {
        context = this;
        args = arguments;
        timestamp = Date.now();
        var callNow = !timeout;
        if (!timeout) {
            timeout = setTimeout(later, wait);
            result = func.apply(context, args);
            context = args = null;
        } else {
            again = true;
        }

        return result;
    };
}

syncthing.filter('natural', function () {
    return function (input, valid) {
        return input.toFixed(decimals(input, valid));
    };
});

syncthing.filter('binary', function () {
    return function (input) {
        if (input === undefined) {
            return '0 ';
        }
        if (input > 1024 * 1024 * 1024) {
            input /= 1024 * 1024 * 1024;
            return input.toFixed(decimals(input, 2)) + ' Gi';
        }
        if (input > 1024 * 1024) {
            input /= 1024 * 1024;
            return input.toFixed(decimals(input, 2)) + ' Mi';
        }
        if (input > 1024) {
            input /= 1024;
            return input.toFixed(decimals(input, 2)) + ' Ki';
        }
        return Math.round(input) + ' ';
    };
});

syncthing.filter('metric', function () {
    return function (input) {
        if (input === undefined) {
            return '0 ';
        }
        if (input > 1000 * 1000 * 1000) {
            input /= 1000 * 1000 * 1000;
            return input.toFixed(decimals(input, 2)) + ' G';
        }
        if (input > 1000 * 1000) {
            input /= 1000 * 1000;
            return input.toFixed(decimals(input, 2)) + ' M';
        }
        if (input > 1000) {
            input /= 1000;
            return input.toFixed(decimals(input, 2)) + ' k';
        }
        return Math.round(input) + ' ';
    };
});

syncthing.filter('alwaysNumber', function () {
    return function (input) {
        if (input === undefined) {
            return 0;
        }
        return input;
    };
});

syncthing.filter('basename', function () {
    return function (input) {
        if (input === undefined)
            return "";
        var parts = input.split(/[\/\\]/);
        if (!parts || parts.length < 1) {
            return input;
        }
        return parts[parts.length - 1];
    };
});

syncthing.directive('uniqueFolder', function () {
    return {
        require: 'ngModel',
        link: function (scope, elm, attrs, ctrl) {
            ctrl.$parsers.unshift(function (viewValue) {
                if (scope.editingExisting) {
                    // we shouldn't validate
                    ctrl.$setValidity('uniqueFolder', true);
                } else if (scope.folders[viewValue]) {
                    // the folder exists already
                    ctrl.$setValidity('uniqueFolder', false);
                } else {
                    // the folder is unique
                    ctrl.$setValidity('uniqueFolder', true);
                }
                return viewValue;
            });
        }
    };
});

syncthing.directive('validDeviceid', function ($http) {
    return {
        require: 'ngModel',
        link: function (scope, elm, attrs, ctrl) {
            ctrl.$parsers.unshift(function (viewValue) {
                if (scope.editingExisting) {
                    // we shouldn't validate
                    ctrl.$setValidity('validDeviceid', true);
                } else {
                    $http.get(urlbase + '/deviceid?id=' + viewValue).success(function (resp) {
                        if (resp.error) {
                            ctrl.$setValidity('validDeviceid', false);
                        } else {
                            ctrl.$setValidity('validDeviceid', true);
                        }
                    });
                }
                return viewValue;
            });
        }
    };
});

syncthing.directive('modal', function () {
    return {
        restrict: 'E',
        templateUrl: 'modal.html',
        replace: true,
        transclude: true,
        scope: {
            title: '@',
            status: '@',
            icon: '@',
            close: '@',
            large: '@',
        },
    };
});

syncthing.directive('identicon', ['$window', function ($window) {
  var svgNS = 'http://www.w3.org/2000/svg';

  function Identicon (value, size) {
    var svg = document.createElementNS(svgNS, 'svg');
    var shouldFillRectAt = function (row, col) {
      return !($window.parseInt(value.charCodeAt(row + col * size), 10) % 2);
    };
    var shouldMirrorRectAt = function (row, col) {
      return !(size % 2 && col === middleCol)
    };
    var mirrorColFor = function (col) {
      return size - col - 1;
    };
    var fillRectAt = function (row, col) {
      var rect = document.createElementNS(svgNS, 'rect');

      rect.setAttribute('x', (col * rectSize) + '%');
      rect.setAttribute('y', (row * rectSize) + '%');
      rect.setAttribute('width', rectSize + '%');
      rect.setAttribute('height', rectSize + '%');

      svg.appendChild(rect);
    };
    var rect;
    var row;
    var col;
    var middleCol;
    var rectSize;

    svg.setAttribute('class', 'identicon');
    size = size || 5;
    rectSize = 100 / size;
    middleCol = Math.ceil(size / 2) - 1;

    if (value) {
      value = value.toString().replace(/[\W_]/i, '');

      for (row = 0; row < size; ++row) {
        for (col = middleCol; col > -1; --col) {
          if (shouldFillRectAt(row, col)) {
            fillRectAt(row, col);

            if (shouldMirrorRectAt(row, col)) {
              fillRectAt(row, mirrorColFor(col));
            }
          }
        }
      }
    }

    return svg;
  }

  return {
    restrict: 'E',
    scope: {
      value: '='
    },
    link: function (scope, element, attributes) {
      element.append(new Identicon(scope.value));
    }
  }
}]);
