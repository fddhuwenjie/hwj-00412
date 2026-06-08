const axios = require('axios');
const chalk = require('chalk');
const Table = require('cli-table3');
const dayjs = require('dayjs');
const crypto = require('crypto');
const db = require('./database');

class WebhookManager {
  constructor() {
    this.lastNotifiedStatus = {};
  }

  async add(options) {
    const { name, url, secret, enabled, notify_on_failure, notify_on_recovery } = options;

    if (!name || !url) {
      throw new Error('名称和URL是必填项');
    }

    const existing = await db.getWebhookByName(name);
    if (existing) {
      throw new Error(`Webhook名称已存在: ${name}`);
    }

    const id = await db.addWebhook({
      name, url,
      secret: secret || null,
      enabled: enabled !== undefined ? enabled : true,
      notify_on_failure: notify_on_failure !== undefined ? notify_on_failure : true,
      notify_on_recovery: notify_on_recovery !== undefined ? notify_on_recovery : true
    });

    console.log(chalk.green(`✓ 成功添加Webhook: ${name} (ID: ${id})`));
    return id;
  }

  async list(showDetails = false) {
    const webhooks = await db.getWebhooks();

    if (webhooks.length === 0) {
      console.log(chalk.yellow('暂无Webhook配置'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('名称'),
        chalk.bold('URL'),
        chalk.bold('状态'),
        chalk.bold('失败通知'),
        chalk.bold('恢复通知')
      ],
      colWidths: [6, 20, 40, 10, 12, 12]
    });

    for (const webhook of webhooks) {
      table.push([
        webhook.id,
        webhook.name,
        webhook.url,
        webhook.enabled ? chalk.green('已启用') : chalk.red('已禁用'),
        webhook.notify_on_failure ? chalk.green('是') : chalk.gray('否'),
        webhook.notify_on_recovery ? chalk.green('是') : chalk.gray('否')
      ]);
    }

    console.log(table.toString());

    if (showDetails) {
      for (const webhook of webhooks) {
        const logs = await db.getWebhookLogs(webhook.id, 5);
        console.log(chalk.bold.cyan(`\n=== ${webhook.name} 最近发送日志 ===`));
        if (logs.length === 0) {
          console.log(chalk.gray('  暂无发送记录'));
        } else {
          for (const log of logs) {
            const time = dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss');
            const status = log.success ? chalk.green('✓ 成功') : chalk.red('✗ 失败');
            console.log(`  ${time} ${status}`);
            if (log.error_message) {
              console.log(`    ${chalk.red(log.error_message)}`);
            }
          }
        }
      }
    }
  }

  async remove(webhookIdentifier) {
    let webhook;
    if (/^\d+$/.test(webhookIdentifier)) {
      webhook = await db.getWebhookById(parseInt(webhookIdentifier));
    } else {
      webhook = await db.getWebhookByName(webhookIdentifier);
    }

    if (!webhook) {
      throw new Error(`Webhook不存在: ${webhookIdentifier}`);
    }

    await db.removeWebhook(webhook.id);
    console.log(chalk.green(`✓ 成功删除Webhook: ${webhook.name}`));
  }

  async sendNotification(payload) {
    const webhooks = await db.getWebhooks(true);
    
    if (webhooks.length === 0) {
      return { sent: 0, success: 0, failed: 0 };
    }

    const shouldSend = (wh) => {
      if (payload.event_type === 'recovery' && !wh.notify_on_recovery) return false;
      if ((payload.event_type === 'warning' || payload.event_type === 'critical') && !wh.notify_on_failure) return false;
      return true;
    };

    let sent = 0, success = 0, failed = 0;

    for (const webhook of webhooks) {
      if (!shouldSend(webhook)) continue;
      sent++;

      try {
        const headers = { 'Content-Type': 'application/json' };
        
        if (webhook.secret) {
          const signature = crypto
            .createHmac('sha256', webhook.secret)
            .update(JSON.stringify(payload))
            .digest('hex');
          headers['X-UpMon-Signature'] = signature;
        }

        const response = await axios.post(webhook.url, payload, {
          headers,
          timeout: 10000
        });

        await db.addWebhookLog({
          webhook_id: webhook.id,
          timestamp: dayjs().toISOString(),
          payload,
          success: true,
          response: `HTTP ${response.status}`
        });

        success++;
      } catch (err) {
        await db.addWebhookLog({
          webhook_id: webhook.id,
          timestamp: dayjs().toISOString(),
          payload,
          success: false,
          error_message: err.message
        });
        failed++;
        console.error(chalk.red(`Webhook发送失败 [${webhook.name}]: ${err.message}`));
      }
    }

    return { sent, success, failed };
  }

  async test(webhookIdentifier) {
    let webhook;
    if (/^\d+$/.test(webhookIdentifier)) {
      webhook = await db.getWebhookById(parseInt(webhookIdentifier));
    } else {
      webhook = await db.getWebhookByName(webhookIdentifier);
    }

    if (!webhook) {
      throw new Error(`Webhook不存在: ${webhookIdentifier}`);
    }

    const testPayload = {
      event_type: 'test',
      severity: 'info',
      target_name: 'Test Target',
      target_url: 'https://example.com',
      failure_type: 'test_notification',
      response_time_ms: 123,
      timestamp: dayjs().toISOString(),
      message: '这是一条测试通知，用于验证Webhook连通性'
    };

    console.log(chalk.cyan(`正在发送测试通知到 ${webhook.name} (${webhook.url})...`));

    try {
      const headers = { 'Content-Type': 'application/json' };
      
      if (webhook.secret) {
        const signature = crypto
          .createHmac('sha256', webhook.secret)
          .update(JSON.stringify(testPayload))
          .digest('hex');
        headers['X-UpMon-Signature'] = signature;
      }

      const startTime = Date.now();
      const response = await axios.post(webhook.url, testPayload, {
        headers,
        timeout: 10000
      });
      const duration = Date.now() - startTime;

      await db.addWebhookLog({
        webhook_id: webhook.id,
        timestamp: dayjs().toISOString(),
        payload: testPayload,
        success: true,
        response: `HTTP ${response.status}`
      });

      console.log(chalk.green(`✓ 测试通知发送成功! 响应时间: ${duration}ms, HTTP状态: ${response.status}`));
      if (response.data) {
        console.log(chalk.gray(`  响应内容: ${typeof response.data === 'string' ? response.data : JSON.stringify(response.data)}`));
      }
      return true;
    } catch (err) {
      await db.addWebhookLog({
        webhook_id: webhook.id,
        timestamp: dayjs().toISOString(),
        payload: testPayload,
        success: false,
        error_message: err.message
      });

      console.log(chalk.red(`✗ 测试通知发送失败: ${err.message}`));
      if (err.response) {
        console.log(chalk.gray(`  HTTP状态: ${err.response.status}`));
        console.log(chalk.gray(`  响应内容: ${err.response.data}`));
      }
      return false;
    }
  }

  async checkAndNotify(target, result) {
    const consecutiveFailures = await db.getConsecutiveFailures(target.id);
    const alertThreshold = target.alert_fail_count;
    
    const statusKey = `target-${target.id}`;
    const previousStatus = this.lastNotifiedStatus[statusKey];

    const payloadBase = {
      target_name: target.name,
      target_url: target.url,
      response_time_ms: result.response_time,
      timestamp: result.timestamp
    };

    if (result.success) {
      if (previousStatus && previousStatus !== 'ok') {
        this.lastNotifiedStatus[statusKey] = 'ok';
        const payload = {
          ...payloadBase,
          event_type: 'recovery',
          severity: 'info',
          failure_type: previousStatus,
          message: `${target.name} 已恢复正常，连续失败 ${previousStatus === 'critical' ? alertThreshold * 2 : alertThreshold} 次后恢复`
        };
        await this.sendNotification(payload);
      } else {
        this.lastNotifiedStatus[statusKey] = 'ok';
      }
    } else {
      if (consecutiveFailures >= alertThreshold * 2 && previousStatus !== 'critical') {
        this.lastNotifiedStatus[statusKey] = 'critical';
        const payload = {
          ...payloadBase,
          event_type: 'critical',
          severity: 'critical',
          failure_type: 'consecutive_failure',
          consecutive_failures: consecutiveFailures,
          message: `${target.name} 严重告警: 连续 ${consecutiveFailures} 次检测失败`,
          error_message: result.error_message,
          status_code: result.status_code
        };
        await this.sendNotification(payload);
      } else if (consecutiveFailures >= alertThreshold && consecutiveFailures < alertThreshold * 2 && previousStatus !== 'warning' && previousStatus !== 'critical') {
        this.lastNotifiedStatus[statusKey] = 'warning';
        const payload = {
          ...payloadBase,
          event_type: 'warning',
          severity: 'warning',
          failure_type: 'consecutive_failure',
          consecutive_failures: consecutiveFailures,
          message: `${target.name} 告警: 连续 ${consecutiveFailures} 次检测失败`,
          error_message: result.error_message,
          status_code: result.status_code
        };
        await this.sendNotification(payload);
      }
    }
  }

  async checkTransactionAndNotify(transaction, result) {
    const consecutiveFailures = await db.getTransactionConsecutiveFailures(transaction.id);
    const alertThreshold = transaction.alert_fail_count;
    
    const statusKey = `transaction-${transaction.id}`;
    const previousStatus = this.lastNotifiedStatus[statusKey];

    const payloadBase = {
      target_name: transaction.name,
      target_url: `transaction://${transaction.name}`,
      response_time_ms: result.total_time,
      timestamp: result.timestamp,
      is_transaction: true
    };

    if (result.success) {
      if (previousStatus && previousStatus !== 'ok') {
        this.lastNotifiedStatus[statusKey] = 'ok';
        const payload = {
          ...payloadBase,
          event_type: 'recovery',
          severity: 'info',
          failure_type: previousStatus,
          message: `事务 ${transaction.name} 已恢复正常`
        };
        await this.sendNotification(payload);
      } else {
        this.lastNotifiedStatus[statusKey] = 'ok';
      }
    } else {
      if (consecutiveFailures >= alertThreshold * 2 && previousStatus !== 'critical') {
        this.lastNotifiedStatus[statusKey] = 'critical';
        const payload = {
          ...payloadBase,
          event_type: 'critical',
          severity: 'critical',
          failure_type: 'transaction_failure',
          consecutive_failures: consecutiveFailures,
          message: `事务 ${transaction.name} 严重告警: 连续 ${consecutiveFailures} 次失败，失败步骤: ${result.failed_step}`,
          error_message: result.error_message,
          failed_step: result.failed_step
        };
        await this.sendNotification(payload);
      } else if (consecutiveFailures >= alertThreshold && consecutiveFailures < alertThreshold * 2 && previousStatus !== 'warning' && previousStatus !== 'critical') {
        this.lastNotifiedStatus[statusKey] = 'warning';
        const payload = {
          ...payloadBase,
          event_type: 'warning',
          severity: 'warning',
          failure_type: 'transaction_failure',
          consecutive_failures: consecutiveFailures,
          message: `事务 ${transaction.name} 告警: 连续 ${consecutiveFailures} 次失败，失败步骤: ${result.failed_step}`,
          error_message: result.error_message,
          failed_step: result.failed_step
        };
        await this.sendNotification(payload);
      }
    }
  }
}

module.exports = new WebhookManager();
