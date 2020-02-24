/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

'use strict';

var mod_assert = require('assert-plus');
var mod_util = require('util');
var mod_ipaddr = require('ipaddr.js');
var mod_fs = require('fs');
var mod_fsm = require('mooremachine');

function PgHbaPool(options) {
	mod_assert.object(options, 'options');
	mod_assert.object(options.log, 'options.log');
	mod_assert.number(options.hupInterval, 'options.hupInterval');
	mod_assert.number(options.statInterval, 'options.statInterval');
	mod_assert.number(options.holdTime, 'options.holdTime');
	mod_assert.string(options.baseText, 'options.baseText');
	mod_assert.string(options.path, 'options.path');
	mod_assert.string(options.pidFile, 'options.pidFile');

	this.php_log = options.log.child({
		component: 'PgHbaPool',
		path: options.path
	});
	this.php_path = options.path;
	this.php_statInterval = options.statInterval * 1000;
	this.php_hupInterval = options.hupInterval * 1000;
	this.php_hold = options.holdTime * 1000;
	this.php_baseText = options.baseText;
	this.php_pidFile = options.pidFile;

	this.php_addrs = {};
	this.php_held = {};
	this.php_tags = {};
	this.php_timers = {};
	this.php_lastWrite = Date.now();
	this.php_lastSize = 0;
	this.php_pid = null;
	this.php_dirty = false;
	this.php_stopping = false;

	mod_fsm.FSM.call(this, 'stopped');
}
mod_util.inherits(PgHbaPool, mod_fsm.FSM);
PgHbaPool.prototype.setDirty = function () {
	this.php_dirty = true;
	this.emit('dirty');
};
PgHbaPool.prototype.stop = function () {
	this.php_stopping = true;
	this.php_dirty = true;
	this.emit('dirty');
};
PgHbaPool.prototype.state_stopped = function (S) {
	S.gotoStateOn(this, 'start', 'waiting');
};
PgHbaPool.prototype.state_running = function (S) {
	var self = this;
	S.gotoStateOn(this, 'dirty', 'writing');
	if (this.php_dirty) {
		S.gotoState('writing');
		return;
	}
	if (this.php_stopping) {
		S.gotoState('stopped');
		return;
	}

	S.interval(this.php_statInterval, function () {
		mod_fs.stat(self.php_path, S.callback(function (err, stats) {
			if (err || !stats.isFile()) {
				self.php_log.debug(err,
				    'failed to stat pg_hba.conf');
				return;
			}
			var mtime = stats.mtime.getTime();
			if (Math.abs(mtime - self.php_lastWrite) > 100 ||
			    stats.size !== self.php_lastSize) {
				S.gotoState('writing');
			}
		}));
	});
};
PgHbaPool.prototype.state_waiting = function (S) {
	var self = this;

	this.php_log.debug('waiting for stat on pg_hba.conf to clear...');
	S.interval(this.php_statInterval, function () {
		mod_fs.stat(self.php_path, S.callback(function (err, stats) {
			if (err || !stats.isFile()) {
				self.php_log.debug(err,
				    'failed to stat pg_hba.conf');
				return;
			}
			S.gotoState('writing');
		}));
	});

	S.on(this, 'dirty', function () {
		if (self.php_stopping)
			S.gotoState('stopped');
	});
};
PgHbaPool.prototype.state_writing = function (S) {
	var self = this;
	var data = this.php_baseText;
	if (this.php_stopping) {
		data += 'host  all  all  0.0.0.0/0  trust\n';
		data += 'host  replication  all  0.0.0.0/0  trust\n';
	} else {
		for (var key in this.php_addrs) {
			data += mod_util.format('# %s\n',
			    this.php_addrs[key].join(', '));
			data += mod_util.format(
			    'host  all  all  %s/32  trust\n', key);
			data += mod_util.format(
			    'host  replication  all  %s/32  trust\n', key);
		}
		for (key in this.php_held) {
			data += mod_util.format('# %s (HELD)\n',
			    this.php_held[key].join(', '));
			data += mod_util.format(
			    'host  all  all  %s/32  trust\n', key);
			data += mod_util.format(
			    'host  replication  all  %s/32  trust\n', key);
		}
	}
	this.php_dirty = false;

	mod_fs.writeFile(this.php_path, data, S.callback(function (err) {
		if (err) {
			self.php_log.warn(err, 'failed to write pg_hba.conf, ' +
			    'will retry', self.php_path);
			S.gotoState('waiting');
			return;
		}
		self.php_log.info('wrote new pg_hba.conf');
		self.php_lastSize = data.length;
		self.php_lastWrite = Date.now();
		S.gotoState('findingPid');
	}));
};
PgHbaPool.prototype.state_findingPid = function (S) {
	var self = this;
	mod_fs.readFile(this.php_pidFile, S.callback(function (err, data) {
		if (err) {
			self.php_log.error(err,
			    'failed reading postmaster.pid');
			S.gotoState('waiting');
			return;
		}
		var lines = data.toString('ascii').split('\n');
		if (/[^0-9]/.test(lines[0])) {
			self.php_log.error('failed parsing postmaster.pid: ' +
			    'first line is not a number');
			S.gotoState('waiting');
			return;
		}
		self.php_pid = parseInt(lines[0], 10);
		S.gotoState('hupping');
	}));
};
PgHbaPool.prototype.state_hupping = function (S) {
	this.php_log.info('sending SIGHUP to postmaster (pid %d)',
	    this.php_pid);
	try {
		process.kill(this.php_pid, 'SIGHUP');
	} catch (err) {
		this.php_log.error(err, 'failed sending SIGHUP to ' +
		    'postmaster (pid %d)', this.php_pid);
		S.gotoState('waiting');
		return;
	}
	setImmediate(this.emit.bind(this, 'hupped'));
	S.gotoState('debouncing');
};
PgHbaPool.prototype.state_debouncing = function (S) {
	S.gotoStateTimeout(this.php_hupInterval, 'running');
	if (this.php_stopping) {
		S.gotoState('stopped');
		return;
	}
};

PgHbaPool.prototype.start = function () {
	this.emit('start');
};

PgHbaPool.prototype.expire = function (key) {
	if (this.php_stopping)
		return;
	delete (this.php_timers[key]);
	delete (this.php_held[key]);
	this.setDirty();
};
PgHbaPool.prototype.refreshTag = function (tag, addrs, cb) {
	var self = this;

	if (this.php_stopping)
		return;

	var keys = addrs.map(function (addr) {
		var ipaddr = mod_ipaddr.parse(addr);
		return (ipaddr.toNormalizedString());
	});

	var oldKeys = this.php_tags[tag];
	if (oldKeys === undefined)
		oldKeys = [];
	this.php_tags[tag] = keys;

	var added = keys.filter(function (k) {
		return (oldKeys.indexOf(k) === -1);
	});
	var removed = oldKeys.filter(function (k) {
		return (keys.indexOf(k) === -1);
	});

	var held = [];
	removed.forEach(function (k) {
		var tags = self.php_addrs[k];
		mod_assert.arrayOfString(tags);
		mod_assert.ok(tags.length > 0);
		var idx = tags.indexOf(tag);
		mod_assert.notStrictEqual(idx, -1);
		tags.splice(idx, 1);
		if (tags.length === 0) {
			delete (self.php_addrs[k]);
			held.push(k);
		}
	});

	if (held.length > 0) {
		var now = Date.now();
		var expiry = Math.ceil((now + this.php_hold) / 5000) * 5000;
		var timeout = expiry - now;

		held.forEach(function (k) {
			mod_assert.strictEqual(self.php_timers[k], undefined);
			self.php_timers[k] = setTimeout(
			    self.expire.bind(self, k), timeout);
			self.php_held[k] = true;
		});

		self.php_log.info({ addrs: held, tag: tag }, 'holding %d ' +
		    'addresses for %d ms', held.length, timeout);
	}

	var news = [];
	added.forEach(function (k) {
		var timer = self.php_timers[k];
		if (timer !== undefined) {
			clearTimeout(timer);
			delete (self.php_timers[k]);
			delete (self.php_held[k]);
			mod_assert.strictEqual(self.php_addrs[k], undefined);
			self.php_addrs[k] = [tag];
			return;
		}
		var tags = self.php_addrs[k];
		if (tags === undefined) {
			tags = (self.php_addrs[k] = []);
			news.push(k);
		}
		tags.push(tag);
	});

	if (news.length > 0) {
		self.php_log.info({ addrs: news, tag: tag },
		    'adding new addresses');
		this.setDirty();
	}
	if (cb)
		setImmediate(cb);
};

module.exports = {
	PgHbaPool: PgHbaPool
};
