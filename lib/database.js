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

    await this.run(`
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        status TEXT NOT NULL DEFAULT 'investigating',
        affected_targets TEXT,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS incident_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        interval INTEGER NOT NULL DEFAULT 300,
        timeout INTEGER NOT NULL DEFAULT 30,
        alert_fail_count INTEGER NOT NULL DEFAULT 2,
        environment TEXT DEFAULT 'prod',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS transaction_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        step_order INTEGER NOT NULL,
        name TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        url TEXT NOT NULL,
        headers TEXT,
        body TEXT,
        expected_status INTEGER NOT NULL DEFAULT 200,
        expected_keyword TEXT,
        extract_variables TEXT,
        created_at TEXT NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS transaction_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        success INTEGER NOT NULL,
        total_time INTEGER NOT NULL,
        failed_step INTEGER,
        error_message TEXT,
        step_details TEXT
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_on_failure INTEGER NOT NULL DEFAULT 1,
        notify_on_recovery INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        payload TEXT,
        success INTEGER NOT NULL,
        response TEXT,
        error_message TEXT
      )
    `);

    await this.run(`CREATE INDEX IF NOT EXISTS idx_results_target_time ON check_results(target_id, timestamp)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(timestamp)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_transaction_results_time ON transaction_results(transaction_id, timestamp)`);
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

  async addIncident(incident) {
    const now = dayjs().toISOString();
    const result = await this.run(`
      INSERT INTO incidents (title, severity, status, affected_targets, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      incident.title,
      incident.severity || 'info',
      incident.status || 'investigating',
      incident.affected_targets ? JSON.stringify(incident.affected_targets) : null,
      incident.description || null,
      now, now
    ]);
    return result.lastID;
  }

  async updateIncident(id, updates) {
    const now = dayjs().toISOString();
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined && key !== 'id') {
        fields.push(`${key} = ?`);
        if (key === 'affected_targets' && Array.isArray(val)) {
          values.push(JSON.stringify(val));
        } else {
          values.push(val);
        }
      }
    }
    fields.push('updated_at = ?');
    values.push(now, id);
    await this.run(`UPDATE incidents SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async addIncidentUpdate(incidentId, status, message) {
    const now = dayjs().toISOString();
    return this.run(`
      INSERT INTO incident_updates (incident_id, status, message, created_at)
      VALUES (?, ?, ?, ?)
    `, [incidentId, status, message, now]);
  }

  async getIncidents(status = null) {
    if (status) {
      return this.all('SELECT * FROM incidents WHERE status = ? ORDER BY created_at DESC', [status]);
    }
    return this.all('SELECT * FROM incidents ORDER BY created_at DESC');
  }

  async getIncidentById(id) {
    return this.get('SELECT * FROM incidents WHERE id = ?', [id]);
  }

  async getIncidentUpdates(incidentId) {
    return this.all('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC', [incidentId]);
  }

  async getActiveIncidents() {
    return this.all(`
      SELECT * FROM incidents 
      WHERE status IN ('investigating', 'identified', 'monitoring') 
      ORDER BY created_at DESC
    `);
  }

  async resolveIncident(id) {
    const now = dayjs().toISOString();
    return this.run(`
      UPDATE incidents SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?
    `, [now, now, id]);
  }

  async addTransaction(transaction) {
    const now = dayjs().toISOString();
    const result = await this.run(`
      INSERT INTO transactions (name, description, interval, timeout, alert_fail_count, environment, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      transaction.name,
      transaction.description || null,
      transaction.interval || 300,
      transaction.timeout || 30,
      transaction.alert_fail_count || 2,
      transaction.environment || 'prod',
      transaction.enabled !== undefined ? (transaction.enabled ? 1 : 0) : 1,
      now, now
    ]);
    return result.lastID;
  }

  async updateTransaction(id, updates) {
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
    await this.run(`UPDATE transactions SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async getTransactions(environment = null) {
    if (environment) {
      return this.all('SELECT * FROM transactions WHERE environment = ? ORDER BY name', [environment]);
    }
    return this.all('SELECT * FROM transactions ORDER BY name');
  }

  async getTransactionById(id) {
    return this.get('SELECT * FROM transactions WHERE id = ?', [id]);
  }

  async getTransactionByName(name) {
    return this.get('SELECT * FROM transactions WHERE name = ?', [name]);
  }

  async removeTransaction(id) {
    await this.run('DELETE FROM transaction_steps WHERE transaction_id = ?', [id]);
    await this.run('DELETE FROM transaction_results WHERE transaction_id = ?', [id]);
    await this.run('DELETE FROM transactions WHERE id = ?', [id]);
  }

  async addTransactionStep(step) {
    const now = dayjs().toISOString();
    const result = await this.run(`
      INSERT INTO transaction_steps (transaction_id, step_order, name, method, url, headers, body, expected_status, expected_keyword, extract_variables, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      step.transaction_id,
      step.step_order,
      step.name,
      step.method || 'GET',
      step.url,
      step.headers ? JSON.stringify(step.headers) : null,
      step.body || null,
      step.expected_status || 200,
      step.expected_keyword || null,
      step.extract_variables ? JSON.stringify(step.extract_variables) : null,
      now
    ]);
    return result.lastID;
  }

  async getTransactionSteps(transactionId) {
    const rows = await this.all(`
      SELECT * FROM transaction_steps 
      WHERE transaction_id = ? 
      ORDER BY step_order ASC
    `, [transactionId]);
    return rows.map(row => ({
      ...row,
      headers: row.headers ? JSON.parse(row.headers) : null,
      extract_variables: row.extract_variables ? JSON.parse(row.extract_variables) : null
    }));
  }

  async removeTransactionSteps(transactionId) {
    await this.run('DELETE FROM transaction_steps WHERE transaction_id = ?', [transactionId]);
  }

  async addTransactionResult(result) {
    return this.run(`
      INSERT INTO transaction_results (transaction_id, timestamp, success, total_time, failed_step, error_message, step_details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      result.transaction_id,
      result.timestamp,
      result.success ? 1 : 0,
      result.total_time,
      result.failed_step || null,
      result.error_message || null,
      result.step_details ? JSON.stringify(result.step_details) : null
    ]);
  }

  async getTransactionResults(transactionId, limit = 100) {
    const rows = await this.all(`
      SELECT * FROM transaction_results 
      WHERE transaction_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `, [transactionId, limit]);
    return rows.map(row => ({
      ...row,
      step_details: row.step_details ? JSON.parse(row.step_details) : null
    }));
  }

  async getLatestTransactionResult(transactionId) {
    const row = await this.get(`
      SELECT * FROM transaction_results 
      WHERE transaction_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 1
    `, [transactionId]);
    if (row) {
      row.step_details = row.step_details ? JSON.parse(row.step_details) : null;
    }
    return row;
  }

  async getTransactionUptimeStats(transactionId, hours) {
    const startTime = dayjs().subtract(hours, 'hour').toISOString();
    const result = await this.get(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
        AVG(total_time) as avg_total_time
      FROM transaction_results 
      WHERE transaction_id = ? AND timestamp >= ?
    `, [transactionId, startTime]);

    if (!result || result.total === 0) {
      return { total: 0, successful: 0, pass_rate: 0, avgTotalTime: 0 };
    }

    return {
      total: result.total,
      successful: result.successful,
      pass_rate: (result.successful / result.total) * 100,
      avgTotalTime: Math.round(result.avg_total_time)
    };
  }

  async getTransactionStepAvgTimes(transactionId, hours) {
    const startTime = dayjs().subtract(hours, 'hour').toISOString();
    const rows = await this.all(`
      SELECT step_details FROM transaction_results 
      WHERE transaction_id = ? AND timestamp >= ? AND success = 1
      ORDER BY timestamp DESC
    `, [transactionId, startTime]);

    const stepTimes = {};
    for (const row of rows) {
      const details = row.step_details ? JSON.parse(row.step_details) : [];
      for (const detail of details) {
        if (!stepTimes[detail.step]) {
          stepTimes[detail.step] = [];
        }
        stepTimes[detail.step].push(detail.response_time || 0);
      }
    }

    const result = {};
    for (const [stepName, times] of Object.entries(stepTimes)) {
      if (times.length > 0) {
        result[stepName] = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      }
    }
    return result;
  }

  async getTransactionConsecutiveFailures(transactionId) {
    const rows = await this.all(`
      SELECT success FROM transaction_results 
      WHERE transaction_id = ? 
      ORDER BY timestamp DESC
    `, [transactionId]);
    let count = 0;
    for (const row of rows) {
      if (row.success === 0) count++;
      else break;
    }
    return count;
  }

  async addWebhook(webhook) {
    const now = dayjs().toISOString();
    const result = await this.run(`
      INSERT INTO webhooks (name, url, secret, enabled, notify_on_failure, notify_on_recovery, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      webhook.name,
      webhook.url,
      webhook.secret || null,
      webhook.enabled !== undefined ? (webhook.enabled ? 1 : 0) : 1,
      webhook.notify_on_failure !== undefined ? (webhook.notify_on_failure ? 1 : 0) : 1,
      webhook.notify_on_recovery !== undefined ? (webhook.notify_on_recovery ? 1 : 0) : 1,
      now
    ]);
    return result.lastID;
  }

  async updateWebhook(id, updates) {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined && key !== 'id') {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }
    values.push(id);
    await this.run(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  async getWebhooks(enabledOnly = false) {
    if (enabledOnly) {
      return this.all('SELECT * FROM webhooks WHERE enabled = 1 ORDER BY name');
    }
    return this.all('SELECT * FROM webhooks ORDER BY name');
  }

  async getWebhookById(id) {
    return this.get('SELECT * FROM webhooks WHERE id = ?', [id]);
  }

  async getWebhookByName(name) {
    return this.get('SELECT * FROM webhooks WHERE name = ?', [name]);
  }

  async removeWebhook(id) {
    await this.run('DELETE FROM webhook_logs WHERE webhook_id = ?', [id]);
    await this.run('DELETE FROM webhooks WHERE id = ?', [id]);
  }

  async addWebhookLog(log) {
    return this.run(`
      INSERT INTO webhook_logs (webhook_id, timestamp, payload, success, response, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      log.webhook_id,
      log.timestamp,
      log.payload ? JSON.stringify(log.payload) : null,
      log.success ? 1 : 0,
      log.response || null,
      log.error_message || null
    ]);
  }

  async getWebhookLogs(webhookId, limit = 50) {
    const rows = await this.all(`
      SELECT * FROM webhook_logs 
      WHERE webhook_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `, [webhookId, limit]);
    return rows.map(row => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload) : null
    }));
  }

  async getDailyUptime(targetId, days = 90) {
    const results = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dayjs().subtract(i, 'day');
      const startOfDay = date.startOf('day').toISOString();
      const endOfDay = date.endOf('day').toISOString();
      
      const result = await this.get(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful
        FROM check_results 
        WHERE target_id = ? AND timestamp >= ? AND timestamp <= ?
      `, [targetId, startOfDay, endOfDay]);

      const uptime = result && result.total > 0 
        ? (result.successful / result.total) * 100 
        : null;
      
      results.push({
        date: date.format('YYYY-MM-DD'),
        uptime,
        total: result ? result.total : 0,
        successful: result ? result.successful : 0
      });
    }
    return results;
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
