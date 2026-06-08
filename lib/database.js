const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dayjs = require('dayjs');

const DB_PATH = path.join(process.cwd(), 'upmon.db');

class Database {
  constructor() {
    this.db = null;
  }

  init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) return reject(err);
        this.createTables().then(resolve).catch(reject);
      });
    });
  }

  async createTables() {
    await this.run('PRAGMA foreign_keys = ON');
    
    await this.run(`
      CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        interval INTEGER NOT NULL DEFAULT 60,
        timeout INTEGER NOT NULL DEFAULT 10,
        expected_status INTEGER NOT NULL DEFAULT 200,
        expected_keyword TEXT,
        alert_fail_count INTEGER NOT NULL DEFAULT 3,
        response_time_threshold INTEGER,
        ssl_alert_days INTEGER NOT NULL DEFAULT 7,
        environment TEXT DEFAULT 'prod',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        status_code INTEGER,
        response_time INTEGER NOT NULL,
        success INTEGER NOT NULL,
        keyword_match INTEGER,
        ssl_days_left INTEGER,
        error_message TEXT
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0
      )
    `);

    await this.run(`CREATE INDEX IF NOT EXISTS idx_results_target_time ON check_results(target_id, timestamp)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(timestamp)`);
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async addTarget(target) {
    const now = dayjs().toISOString();
    const result = await this.run(`
      INSERT INTO targets 
      (name, url, interval, timeout, expected_status, expected_keyword, 
       alert_fail_count, response_time_threshold, ssl_alert_days, environment, 
       enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      target.name, target.url, target.interval || 60, target.timeout || 10,
      target.expected_status || 200, target.expected_keyword || null,
      target.alert_fail_count || 3, target.response_time_threshold || null,
      target.ssl_alert_days || 7, target.environment || 'prod',
      1, now, now
    ]);
    return result.lastID;
  }

  async updateTarget(id, updates) {
    const now = dayjs().toISOString();
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined && key !== 'id') {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }
    fields.push('updated_at = ?');
    values.push(now, id);
    await this.run(`UPDATE targets SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async removeTarget(id) {
    await this.run('DELETE FROM targets WHERE id = ?', [id]);
    await this.run('DELETE FROM check_results WHERE target_id = ?', [id]);
    await this.run('DELETE FROM alerts WHERE target_id = ?', [id]);
  }

  async getTargets(environment = null) {
    if (environment) {
      return this.all('SELECT * FROM targets WHERE environment = ? ORDER BY name', [environment]);
    }
    return this.all('SELECT * FROM targets ORDER BY name');
  }

  async getTargetById(id) {
    return this.get('SELECT * FROM targets WHERE id = ?', [id]);
  }

  async getTargetByName(name) {
    return this.get('SELECT * FROM targets WHERE name = ?', [name]);
  }

  async addCheckResult(result) {
    return this.run(`
      INSERT INTO check_results 
      (target_id, timestamp, status_code, response_time, success, keyword_match, 
       ssl_days_left, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      result.target_id, result.timestamp, result.status_code,
      result.response_time, result.success ? 1 : 0,
      result.keyword_match !== undefined ? (result.keyword_match ? 1 : 0) : null,
      result.ssl_days_left !== undefined ? result.ssl_days_left : null,
      result.error_message || null
    ]);
  }

  async getRecentResults(targetId, limit = 5) {
    return this.all(
      'SELECT * FROM check_results WHERE target_id = ? ORDER BY timestamp DESC LIMIT ?',
      [targetId, limit]
    );
  }

  async getResultsInRange(targetId, startTime, endTime) {
    return this.all(
      'SELECT * FROM check_results WHERE target_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp',
      [targetId, startTime, endTime]
    );
  }

  async getLatestResult(targetId) {
    return this.get(
      'SELECT * FROM check_results WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1',
      [targetId]
    );
  }

  async getConsecutiveFailures(targetId) {
    const rows = await this.all(
      'SELECT success FROM check_results WHERE target_id = ? ORDER BY timestamp DESC',
      [targetId]
    );
    let count = 0;
    for (const row of rows) {
      if (row.success === 0) count++;
      else break;
    }
    return count;
  }

  async addAlert(alert) {
    return this.run(`
      INSERT INTO alerts (target_id, timestamp, type, message)
      VALUES (?, ?, ?, ?)
    `, [alert.target_id, alert.timestamp, alert.type, alert.message]);
  }

  async getRecentAlerts(limit = 10) {
    return this.all(
      `SELECT a.*, t.name as target_name 
       FROM alerts a JOIN targets t ON a.target_id = t.id 
       ORDER BY a.timestamp DESC LIMIT ?`,
      [limit]
    );
  }

  async getUptimeStats(targetId, hours) {
    const startTime = dayjs().subtract(hours, 'hour').toISOString();
    const result = await this.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
        AVG(response_time) as avg_response_time
      FROM check_results 
      WHERE target_id = ? AND timestamp >= ?
    `, [targetId, startTime]);

    if (!result || result.total === 0) {
      return { total: 0, successful: 0, uptime: 0, avgResponseTime: 0 };
    }

    return {
      total: result.total,
      successful: result.successful,
      uptime: (result.successful / result.total) * 100,
      avgResponseTime: Math.round(result.avg_response_time)
    };
  }

  async getResponseTimePercentiles(targetId, hours) {
    const startTime = dayjs().subtract(hours, 'hour').toISOString();
    const rows = await this.all(`
      SELECT response_time FROM check_results 
      WHERE target_id = ? AND timestamp >= ? AND success = 1
      ORDER BY response_time
    `, [targetId, startTime]);

    if (rows.length === 0) return { p95: 0, p99: 0 };

    const times = rows.map(r => r.response_time);
    const p95Index = Math.ceil(times.length * 0.95) - 1;
    const p99Index = Math.ceil(times.length * 0.99) - 1;

    return {
      p95: times[p95Index] || 0,
      p99: times[p99Index] || 0
    };
  }

  async getDowntimePeriods(targetId, hours) {
    const startTime = dayjs().subtract(hours, 'hour').toISOString();
    const rows = await this.all(`
      SELECT * FROM check_results 
      WHERE target_id = ? AND timestamp >= ?
      ORDER BY timestamp
    `, [targetId, startTime]);

    const periods = [];
    let currentDowntime = null;

    for (const row of rows) {
      if (row.success === 0) {
        if (!currentDowntime) {
          currentDowntime = { start: row.timestamp, end: row.timestamp, count: 1 };
        } else {
          currentDowntime.end = row.timestamp;
          currentDowntime.count++;
        }
      } else {
        if (currentDowntime) {
          periods.push(currentDowntime);
          currentDowntime = null;
        }
      }
    }
    if (currentDowntime) periods.push(currentDowntime);

    return periods;
  }

  async getAllUptimeStats(hours) {
    const targets = await this.getTargets();
    const stats = [];
    for (const target of targets) {
      const uptime = await this.getUptimeStats(target.id, hours);
      const percentiles = await this.getResponseTimePercentiles(target.id, hours);
      stats.push({ ...target, ...uptime, ...percentiles });
    }
    return stats;
  }

  close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = new Database();
