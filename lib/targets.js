const chalk = require('chalk');
const Table = require('cli-table3');
const dayjs = require('dayjs');
const db = require('./database');

class TargetManager {
  async add(options) {
    const { name, url, interval, timeout, expected_status, expected_keyword,
            alert_fail_count, response_time_threshold, ssl_alert_days, environment } = options;

    if (!name || !url) {
      throw new Error('名称和URL是必填项');
    }

    const existing = await db.getTargetByName(name);
    if (existing) {
      throw new Error(`目标名称已存在: ${name}`);
    }

    const id = await db.addTarget({
      name, url,
      interval: interval ? parseInt(interval) : undefined,
      timeout: timeout ? parseInt(timeout) : undefined,
      expected_status: expected_status ? parseInt(expected_status) : undefined,
      expected_keyword,
      alert_fail_count: alert_fail_count ? parseInt(alert_fail_count) : undefined,
      response_time_threshold: response_time_threshold ? parseInt(response_time_threshold) : undefined,
      ssl_alert_days: ssl_alert_days ? parseInt(ssl_alert_days) : undefined,
      environment
    });

    console.log(chalk.green(`✓ 成功添加目标: ${name} (ID: ${id})`));
    return id;
  }

  async list(environment = null, showDetails = false) {
    const targets = await db.getTargets(environment);

    if (targets.length === 0) {
      console.log(chalk.yellow('暂无监测目标'));
      return;
    }

    if (showDetails) {
      await this.listWithDetails(targets);
    } else {
      await this.listSimple(targets);
    }
  }

  async listSimple(targets) {
    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('名称'),
        chalk.bold('URL'),
        chalk.bold('间隔'),
        chalk.bold('状态')
      ],
      colWidths: [6, 20, 40, 10, 12]
    });

    for (const target of targets) {
      const latest = await db.getLatestResult(target.id);
      let statusText = '';
      let statusColor = 'gray';

      if (latest) {
        if (latest.success) {
          statusText = `${chalk.green('✓')} ${latest.response_time}ms`;
          statusColor = 'green';
        } else {
          statusText = `${chalk.red('✗')} 失败`;
          statusColor = 'red';
        }
      } else {
        statusText = chalk.gray('未检测');
      }

      const enabledIcon = target.enabled ? '' : chalk.gray(' [禁用]');

      table.push([
        target.id,
        target.name + enabledIcon,
        target.url,
        `${target.interval}s`,
        statusText
      ]);
    }

    console.log(table.toString());
  }

  async listWithDetails(targets) {
    for (const target of targets) {
      console.log(chalk.bold.cyan(`\n=== ${target.name} (ID: ${target.id}) ===`));
      console.log(`  URL:                ${target.url}`);
      console.log(`  检测间隔:           ${target.interval}秒`);
      console.log(`  超时时间:           ${target.timeout}秒`);
      console.log(`  预期状态码:         ${target.expected_status}`);
      console.log(`  预期关键词:         ${target.expected_keyword || '(无)'}`);
      console.log(`  连续失败告警阈值:   ${target.alert_fail_count}次`);
      console.log(`  响应时间阈值:       ${target.response_time_threshold ? target.response_time_threshold + 'ms' : '(未设置)'}`);
      console.log(`  SSL告警天数:        ${target.ssl_alert_days}天`);
      console.log(`  环境:               ${target.environment || 'prod'}`);
      console.log(`  状态:               ${target.enabled ? chalk.green('已启用') : chalk.red('已禁用')}`);
      console.log(`  创建时间:           ${dayjs(target.created_at).format('YYYY-MM-DD HH:mm:ss')}`);

      const uptime = await db.getUptimeStats(target.id, 24);
      console.log(`  24h可用率:          ${uptime.uptime.toFixed(2)}% (${uptime.successful}/${uptime.total})`);

      const recent = await db.getRecentResults(target.id, 5);
      if (recent.length > 0) {
        console.log(`  最近5次检测:`);
        for (const result of recent) {
          const icon = result.success ? chalk.green('✓') : chalk.red('✗');
          const time = dayjs(result.timestamp).format('HH:mm:ss');
          const details = result.success 
            ? `${result.response_time}ms, ${result.status_code}`
            : result.error_message || '失败';
          console.log(`    ${icon} ${time} - ${details}`);
        }
      }
    }
    console.log('');
  }

  async remove(targetIdentifier) {
    let target;
    if (/^\d+$/.test(targetIdentifier)) {
      target = await db.getTargetById(parseInt(targetIdentifier));
    } else {
      target = await db.getTargetByName(targetIdentifier);
    }

    if (!target) {
      throw new Error(`目标不存在: ${targetIdentifier}`);
    }

    await db.removeTarget(target.id);
    console.log(chalk.green(`✓ 成功删除目标: ${target.name}`));
  }

  async edit(targetIdentifier, updates) {
    let target;
    if (/^\d+$/.test(targetIdentifier)) {
      target = await db.getTargetById(parseInt(targetIdentifier));
    } else {
      target = await db.getTargetByName(targetIdentifier);
    }

    if (!target) {
      throw new Error(`目标不存在: ${targetIdentifier}`);
    }

    const cleanUpdates = {};
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined && val !== null && val !== '') {
        if (['interval', 'timeout', 'expected_status', 'alert_fail_count', 
             'response_time_threshold', 'ssl_alert_days'].includes(key)) {
          cleanUpdates[key] = parseInt(val);
        } else {
          cleanUpdates[key] = val;
        }
      }
    }

    if (updates.enabled !== undefined) {
      cleanUpdates.enabled = updates.enabled ? 1 : 0;
    }

    if (Object.keys(cleanUpdates).length === 0) {
      console.log(chalk.yellow('没有提供需要更新的字段'));
      return;
    }

    await db.updateTarget(target.id, cleanUpdates);
    console.log(chalk.green(`✓ 成功更新目标: ${target.name}`));
    console.log('  更新字段:', Object.keys(cleanUpdates).join(', '));
  }

  async enable(targetIdentifier) {
    return this.edit(targetIdentifier, { enabled: true });
  }

  async disable(targetIdentifier) {
    return this.edit(targetIdentifier, { enabled: false });
  }
}

module.exports = new TargetManager();
