const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const db = require('./database');

const ALERT_LOG_FILE = path.join(process.cwd(), 'alerts.log');

class AlertManager {
  constructor() {
    this.lastAlertTimestamps = {};
    this.alertCooldown = 60000;
  }

  async checkAll(target, latestResult) {
    const alerts = [];

    const consecutiveFailures = await db.getConsecutiveFailures(target.id);
    if (consecutiveFailures >= target.alert_fail_count) {
      alerts.push({
        type: 'consecutive_failure',
        target_id: target.id,
        message: `连续 ${consecutiveFailures} 次检测失败，超过阈值 ${target.alert_fail_count} 次`
      });
    }

    if (target.response_time_threshold && latestResult && 
        latestResult.response_time > target.response_time_threshold && latestResult.success) {
      alerts.push({
        type: 'response_time',
        target_id: target.id,
        message: `响应时间 ${latestResult.response_time}ms 超过阈值 ${target.response_time_threshold}ms`
      });
    }

    if (latestResult && latestResult.ssl_days_left !== null && 
        latestResult.ssl_days_left <= target.ssl_alert_days) {
      alerts.push({
        type: 'ssl_expiry',
        target_id: target.id,
        message: `SSL证书将在 ${latestResult.ssl_days_left} 天后到期`
      });
    }

    for (const alert of alerts) {
      await this.processAlert(alert, target);
    }

    return alerts;
  }

  async processAlert(alert, target) {
    const alertKey = `${target.id}-${alert.type}`;
    const now = Date.now();
    const lastAlert = this.lastAlertTimestamps[alertKey];

    if (lastAlert && (now - lastAlert) < this.alertCooldown) {
      return;
    }

    this.lastAlertTimestamps[alertKey] = now;

    alert.timestamp = dayjs().toISOString();
    
    try {
      await db.addAlert(alert);
    } catch (err) {
      console.error('Failed to save alert:', err.message);
    }

    this.writeAlertLog(alert, target);
    this.terminalBell();
  }

  writeAlertLog(alert, target) {
    const logEntry = `${dayjs(alert.timestamp).format('YYYY-MM-DD HH:mm:ss')} | ` +
      `${alert.type.toUpperCase().padEnd(20)} | ` +
      `${target.name.padEnd(20)} | ` +
      `${target.url} | ` +
      `${alert.message}\n`;

    try {
      fs.appendFileSync(ALERT_LOG_FILE, logEntry);
    } catch (err) {
      console.error('Failed to write alert log:', err.message);
    }
  }

  terminalBell() {
    process.stdout.write('\x07');
  }

  async getRecentAlerts(limit = 10) {
    return db.getRecentAlerts(limit);
  }

  getAlertLogPath() {
    return ALERT_LOG_FILE;
  }

  async checkSslExpiry(target, sslDaysLeft) {
    if (sslDaysLeft !== null && sslDaysLeft <= target.ssl_alert_days) {
      const alert = {
        type: 'ssl_expiry',
        target_id: target.id,
        timestamp: dayjs().toISOString(),
        message: `SSL证书将在 ${sslDaysLeft} 天后到期`
      };
      await this.processAlert(alert, target);
      return alert;
    }
    return null;
  }
}

module.exports = new AlertManager();
