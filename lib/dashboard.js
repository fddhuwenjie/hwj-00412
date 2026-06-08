const blessed = require('blessed');
const chalk = require('chalk');
const dayjs = require('dayjs');
const db = require('./database');
const alertManager = require('./alerts');

class Dashboard {
  constructor() {
    this.screen = null;
    this.targetsBox = null;
    this.summaryBox = null;
    this.alertsBox = null;
    this.statusBar = null;
    this.refreshInterval = null;
    this.environment = null;
  }

  async start(environment = null) {
    this.environment = environment;
    
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'UpMon - 网站可用性监测仪表盘'
    });

    this.screen.key(['q', 'C-c'], () => {
      this.stop();
      process.exit(0);
    });

    this.summaryBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 5,
      label: chalk.bold.cyan(' 概览 '),
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        header: { fg: 'cyan', bold: true }
      }
    });

    this.targetsBox = blessed.box({
      top: 5,
      left: 0,
      width: '100%',
      height: '60%',
      label: chalk.bold.green(' 监测目标 '),
      border: { type: 'line' },
      style: {
        border: { fg: 'green' }
      }
    });

    this.alertsBox = blessed.box({
      bottom: 2,
      left: 0,
      width: '100%',
      height: '30%',
      label: chalk.bold.red(' 最近告警 '),
      border: { type: 'line' },
      style: {
        border: { fg: 'red' }
      }
    });

    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 2,
      content: chalk.gray(' 按 Q 退出 | 每5秒自动刷新'),
      style: {
        bg: 'blue',
        fg: 'white'
      }
    });

    this.screen.append(this.summaryBox);
    this.screen.append(this.targetsBox);
    this.screen.append(this.alertsBox);
    this.screen.append(this.statusBar);

    await this.refresh();
    
    this.refreshInterval = setInterval(() => {
      this.refresh().catch(err => {
        console.error('Dashboard refresh error:', err.message);
      });
    }, 5000);

    this.screen.render();
  }

  async refresh() {
    const targets = await db.getTargets(this.environment);
    const alerts = await alertManager.getRecentAlerts(10);

    let totalChecks = 0;
    let successfulChecks = 0;
    const targetLines = [];

    for (const target of targets) {
      const recentResults = await db.getRecentResults(target.id, 5);
      const latestResult = recentResults[0];
      
      const uptime24h = await db.getUptimeStats(target.id, 24);

      if (uptime24h.total > 0) {
        totalChecks += uptime24h.total;
        successfulChecks += uptime24h.successful;
      }

      const statusIcon = latestResult && latestResult.success 
        ? chalk.green('✓') 
        : chalk.red('✗');

      const statusDots = recentResults.slice().reverse().map(r => 
        r.success ? chalk.green('●') : chalk.red('●')
      ).join(' ');

      const responseTime = latestResult 
        ? `${latestResult.response_time}ms`.padStart(7)
        : '---'.padStart(7);

      const sslInfo = latestResult && latestResult.ssl_days_left !== null
        ? ` [SSL:${latestResult.ssl_days_left}d]`
        : '';

      const enabledIndicator = target.enabled ? '' : chalk.gray(' [已禁用]');

      targetLines.push(
        `  ${statusIcon} ${chalk.bold(target.name.padEnd(25))} ` +
        `${responseTime}  ${statusDots.padEnd(14)}  ` +
        `${chalk.cyan(uptime24h.uptime.toFixed(1) + '%')}${sslInfo}${enabledIndicator}`
      );
    }

    const overallUptime = totalChecks > 0 
      ? ((successfulChecks / totalChecks) * 100).toFixed(2)
      : '0.00';

    const uptimeColor = parseFloat(overallUptime) >= 99.9 ? 'green' 
      : parseFloat(overallUptime) >= 99 ? 'yellow' : 'red';

    const envText = this.environment 
      ? chalk.yellow(` [环境: ${this.environment}]`)
      : '';

    this.summaryBox.setContent(
      `\n  ${chalk.bold('总监测目标:')} ${targets.length}  |  ` +
      `${chalk.bold('整体可用率:')} ${chalk[uptimeColor](overallUptime + '%')}  |  ` +
      `${chalk.bold('总检测次数:')} ${totalChecks}  |  ` +
      `${chalk.bold('成功:')} ${successfulChecks}${envText}\n` +
      `  ${chalk.gray('刷新时间: ' + dayjs().format('YYYY-MM-DD HH:mm:ss'))}`
    );

    this.targetsBox.setContent(
      `\n  ${chalk.gray('状态  名称'.padEnd(30) + '响应时间  最近5次状态     24h可用率')}\n` +
      targetLines.join('\n')
    );

    const alertLines = alerts.map(alert => {
      const time = dayjs(alert.timestamp).format('MM-DD HH:mm:ss');
      const typeColor = alert.type === 'consecutive_failure' ? 'red' 
        : alert.type === 'ssl_expiry' ? 'yellow' : 'magenta';
      
      return `  ${chalk.gray(time)}  ${chalk[typeColor](alert.type.padEnd(20))}  ` +
        `${chalk.bold(alert.target_name.padEnd(20))}  ${alert.message}`;
    });

    this.alertsBox.setContent(
      alerts.length > 0 
        ? '\n' + alertLines.join('\n')
        : `\n  ${chalk.gray('暂无告警记录')}`
    );

    this.screen.render();
  }

  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
  }
}

module.exports = new Dashboard();
