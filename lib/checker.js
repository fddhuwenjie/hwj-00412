const axios = require('axios');
const https = require('https');
const dayjs = require('dayjs');
const db = require('./database');
const alertManager = require('./alerts');

class CheckEngine {
  constructor() {
    this.timers = new Map();
    this.running = false;
  }

  async checkTarget(target) {
    const startTime = Date.now();
    const result = {
      target_id: target.id,
      timestamp: dayjs().toISOString(),
      status_code: null,
      response_time: 0,
      success: false,
      keyword_match: null,
      ssl_days_left: null,
      error_message: null
    };

    try {
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
        timeout: target.timeout * 1000
      });

      let sslDaysLeft = null;
      if (target.url.startsWith('https://')) {
        sslDaysLeft = await this.getSSLDaysLeft(target.url);
        result.ssl_days_left = sslDaysLeft;
      }

      const response = await axios.get(target.url, {
        timeout: target.timeout * 1000,
        httpsAgent: target.url.startsWith('https://') ? httpsAgent : undefined,
        validateStatus: () => true
      });

      result.status_code = response.status;
      result.response_time = Date.now() - startTime;

      const statusMatch = response.status === target.expected_status;
      
      let keywordMatch = true;
      if (target.expected_keyword) {
        let dataStr = '';
        if (typeof response.data === 'string') {
          dataStr = response.data;
        } else if (response.data !== null && response.data !== undefined) {
          dataStr = JSON.stringify(response.data);
        }
        keywordMatch = dataStr.includes(target.expected_keyword);
        result.keyword_match = keywordMatch;
      }

      result.success = statusMatch && keywordMatch;

      if (!statusMatch) {
        result.error_message = `状态码不匹配: 预期 ${target.expected_status}, 实际 ${response.status}`;
      } else if (target.expected_keyword && !keywordMatch) {
        result.error_message = `响应体不包含预期关键词: "${target.expected_keyword}"`;
      }

    } catch (err) {
      result.response_time = Date.now() - startTime;
      result.error_message = err.code === 'ECONNABORTED' 
        ? `请求超时 (${target.timeout}秒)` 
        : err.message;
      result.success = false;
    }

    try {
      await db.addCheckResult(result);
    } catch (dbErr) {
      console.error(`Failed to save check result for ${target.name}:`, dbErr.message);
    }

    try {
      await alertManager.checkAll(target, result);
    } catch (alertErr) {
      console.error(`Alert check failed for ${target.name}:`, alertErr.message);
    }

    return result;
  }

  async getSSLDaysLeft(url) {
    return new Promise((resolve) => {
      try {
        const urlObj = new URL(url);
        const options = {
          host: urlObj.hostname,
          port: urlObj.port || 443,
          method: 'GET',
          rejectUnauthorized: false,
          timeout: 5000
        };

        const req = https.request(options, (res) => {
          const cert = res.socket.getPeerCertificate();
          if (cert && cert.valid_to) {
            const expiryDate = dayjs(cert.valid_to);
            const daysLeft = expiryDate.diff(dayjs(), 'day');
            resolve(daysLeft);
          } else {
            resolve(null);
          }
          res.destroy();
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
        req.end();
      } catch {
        resolve(null);
      }
    });
  }

  start(target) {
    if (this.timers.has(target.id)) return;

    const intervalMs = target.interval * 1000;
    
    this.checkTarget(target).catch(err => {
      console.error(`Initial check failed for ${target.name}:`, err.message);
    });

    const timer = setInterval(() => {
      this.checkTarget(target).catch(err => {
        console.error(`Check failed for ${target.name}:`, err.message);
      });
    }, intervalMs);

    this.timers.set(target.id, timer);
    console.log(`[${dayjs().format('HH:mm:ss')}] 开始监测: ${target.name} (每${target.interval}秒)`);
  }

  stop(targetId) {
    const timer = this.timers.get(targetId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(targetId);
    }
  }

  async startAll(environment = null) {
    const targets = await db.getTargets(environment);
    const enabledTargets = targets.filter(t => t.enabled === 1);
    
    console.log(`发现 ${enabledTargets.length} 个已启用的监测目标`);
    
    for (const target of enabledTargets) {
      this.start(target);
    }
    
    this.running = true;
    return enabledTargets.length;
  }

  stopAll() {
    for (const [targetId, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.running = false;
    console.log('所有监测任务已停止');
  }

  isRunning() {
    return this.running;
  }

  async runOnce(environment = null) {
    const targets = await db.getTargets(environment);
    const enabledTargets = targets.filter(t => t.enabled === 1);
    const results = [];

    for (const target of enabledTargets) {
      const result = await this.checkTarget(target);
      results.push({ target, result });
    }

    return results;
  }
}

module.exports = new CheckEngine();
