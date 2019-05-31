/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_fs = require('fs');
var mod_util = require('util');
var mod_path = require('path');
var mod_fsm = require('mooremachine');
var mod_cueball = require('cueball');
var mod_url = require('url');

var lib_pghba = require('./lib/pg_hba');
var PgHbaPool = lib_pghba.PgHbaPool;

var lib_zk = require('./lib/zk');
var ZKCache = lib_zk.ZKCache;

var lib_sapi = require('./lib/sapi');
var SapiPoller = lib_sapi.SapiPoller;

var confDir = mod_path.join(__dirname, 'etc');
var confFile = mod_path.join(confDir, 'config.json');
var pgHbaBaseFile = mod_path.join(confDir, 'pg_hba.conf');
var config = JSON.parse(mod_fs.readFileSync(confFile, 'utf-8'));

mod_assert.object(config, 'config');
mod_assert.object(config.zookeeper, 'config.zookeeper');
mod_assert.number(config.holdTime, 'config.holdTime');
mod_assert.string(config.dns_domain, 'config.dns_domain');
mod_assert.string(config.sapi_url, 'config.sapi_url');
mod_assert.object(config.sapiPollingInterval, 'config.sapiPollingInterval');
mod_assert.number(config.sapiPollingInterval.min,
    'config.sapiPollingInterval.min');
mod_assert.number(config.sapiPollingInterval.max,
    'config.sapiPollingInterval.max');
mod_assert.optionalString(config.shard, 'config.shard');
mod_assert.object(config.pg_hba, 'config.pg_hba');
mod_assert.string(config.pg_hba.path, 'config.pg_hba.path');
mod_assert.string(config.pg_hba.pidFile, 'config.pg_hba.pidFile');
mod_assert.number(config.pg_hba.statInterval, 'config.pg_hba.statInterval');
mod_assert.number(config.pg_hba.hupInterval, 'config.pg_hba.hupInterval');

mod_assert.optionalArrayOfString(config.paths, 'config.paths');
mod_assert.optionalArrayOfString(config.domains, 'config.domains');
mod_assert.optionalArrayOfString(config.sapi_services, 'config.sapi_services');

if (config.paths === undefined)
	config.paths = [];
if (config.domains) {
	config.domains.forEach(function (domain) {
		var parts = domain.split('.').map(function (label) {
			return (label.toLowerCase());
		});
		parts.push('');
		parts.reverse();
		config.paths.push(parts.join('/'));
	});
}

var log = mod_bunyan.createLogger({
	name: 'waferlock',
	level: process.env.LOG_LEVEL || 'debug'
});

function AppFSM() {
	this.af_err = null;
	this.af_denials = {};
	this.af_log = log;
	this.af_sapis = {};
	this.af_pgHbaBase = null;

	var agopts = {
		spares: 1,
		maximum: 3,
		ping: '/ping',
		pingInterval: 90000,
		tcpKeepAliveInitialDelay: 5000,
		recovery: {
			default: {
				timeout: 2000,
				maxTimeout:
				    config.sapiPollingInterval.min * 1000,
				retries: 6,
				delay: 5000,
				maxDelay: config.sapiPollingInterval.max * 1000
			}
		}
	};
	var url = mod_url.parse(config.sapi_url);
	if (/^sapi\./.test(url.hostname)) {
		agopts.resolvers = [
		    url.hostname.replace(/^sapi\./, 'binder.') ];
	}
	this.af_agent = new mod_cueball.HttpAgent(agopts);

	mod_fsm.FSM.call(this, 'init');
}
mod_util.inherits(AppFSM, mod_fsm.FSM);

AppFSM.prototype.state_init = function (S) {
	S.gotoState('readPgHbaBaseFile');
};

AppFSM.prototype.state_readPgHbaBaseFile = function (S) {
	var self = this;
	mod_fs.readFile(pgHbaBaseFile, S.callback(function (err, data) {
		if (err) {
			self.af_err = err;
			S.gotoState('fatal');
			return;
		}
		self.af_pgHbaBase = data.toString('ascii');
		S.gotoState('setupPool');
	}));
};

AppFSM.prototype.state_setupPool = function (S) {
	this.af_pool = new PgHbaPool({
		log: log,
		statInterval: config.pg_hba.statInterval,
		hupInterval: config.pg_hba.hupInterval,
		path: config.pg_hba.path,
		pidFile: config.pg_hba.pidFile,
		holdTime: config.holdTime,
		baseText: this.af_pgHbaBase
	});
	S.gotoState('setupCache');
};

AppFSM.prototype.state_setupCache = function (S) {
	this.af_cache = new ZKCache({
		log: log,
		pool: this.af_pool,
		zkConfig: config.zookeeper,
		roots: config.paths
	});
	S.gotoState('waitInitialData');
};

AppFSM.prototype.state_waitInitialData = function (S) {
	var self = this;
	this.af_log.info('waiting for initial data set sync');

	var lastNodes = Object.keys(self.af_cache.ca_nodes).length;
	var roots = config.paths.length;
	S.interval(2000, function () {
		var nodes = Object.keys(self.af_cache.ca_nodes).length;
		if (nodes === lastNodes && nodes > roots) {
			/* Wait an extra sec just in case */
			S.timeout(1000, function () {
				S.gotoState('setupSapi');
			});
		}
		lastNodes = nodes;
	});
};

AppFSM.prototype.state_setupSapi = function (S) {
	if (!config.sapi_services || config.sapi_services.length === 0) {
		S.gotoState('loadRules');
		return;
	}
	var self = this;
	config.sapi_services.forEach(function (svc) {
		self.af_sapis[svc] = new SapiPoller({
			log: log,
			pool: self.af_pool,
			url: config.sapi_url,
			service: svc,
			dns_domain: config.dns_domain,
			minPoll: config.sapiPollingInterval.min,
			maxPoll: config.sapiPollingInterval.max,
			shard: config.shard,
			agent: self.af_agent
		});
		/*
		 * Wait for any one of these to finish polling and go to sleep.
		 * We don't care which one -- the first one that does will kick
		 * us out of this state.
		 */
		S.on(self.af_sapis[svc], 'stateChanged', function (st) {
			if (st === 'sleep') {
				S.gotoState('loadRules');
			}
		});
	});
};

AppFSM.prototype.state_loadRules = function (S) {
	S.gotoStateOn(this.af_pool, 'hupped', 'enforcing');
	this.af_pool.start();
};

AppFSM.prototype.state_enforcing = function (_S) {
	this.af_log.info('pg_hba.conf reloaded, now enforcing');
};

AppFSM.prototype.state_fatal = function (S) {
	S.validTransitions([]);
	log.error(this.af_err, 'fatal error');
	throw (this.af_err);
};

var app = new AppFSM();

function stopAndExit() {
	if (app.af_pool && !app.af_pool.isInState('stopped')) {
		log.info('shutting down pool, writing permissive pg_hba.conf');
		app.af_pool.on('stateChanged', function (st) {
			if (st === 'stopped') {
				log.info('shut down');
				process.exit(0);
			}
		});
		app.af_pool.stop();
	} else {
		process.exit(0);
	}
}
process.on('SIGINT', stopAndExit);
process.on('SIGTERM', stopAndExit);
