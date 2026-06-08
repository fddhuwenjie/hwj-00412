const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const dayjs = require('dayjs');
const Table = require('cli-table3');
const db = require('./database');

class Reporter {
  async generate(format = 'table', outputFile = null, environment = null) {
    const targets = await db.getTargets(environment);
    const periods = [
      { label: '24小时', hours: 24 },
      { label: '7天', hours: 24 * 7 },
      { label: '30天', hours: 24 * 30 }
    ];

    const reportData = [];
    for (const target of targets) {
      const targetData = {
        target,
        periods: {}
      };
      
      for (const period of periods) {
        const uptime = await db.getUptimeStats(target.id, period.hours);
        const percentiles = await db.getResponseTimePercentiles(target.id, period.hours);
        const downtime = await db.getDowntimePeriods(target.id, period.hours);
        
        targetData.periods[period.hours] = {
          ...uptime,
          ...percentiles,
          downtime
        };
      }
      
      reportData.push(targetData);
    }

    if (format === 'html') {
      const html = this.generateHTML(reportData, periods);
      if (outputFile) {
        fs.writeFileSync(outputFile, html);
        return { file: outputFile, targets: targets.length };
      }
      console.log(html);
      return { targets: targets.length };
    }

    return this.generateTerminalTable(reportData, periods);
  }

  generateTerminalTable(reportData, periods) {
    console.log(chalk.bold.cyan('\n=== 网站可用性监测报告 ===\n'));
    console.log(chalk.gray(`生成时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}\n`));

    for (const data of reportData) {
      const { target, periods: periodData } = data;
      
      console.log(chalk.bold.green(`目标: ${target.name}`));
      console.log(chalk.gray(`URL: ${target.url}`));
      console.log(chalk.gray(`环境: ${target.environment || 'prod'}\n`));

      const table = new Table({
        head: [
          chalk.bold('时间段'),
          chalk.bold('可用率'),
          chalk.bold('平均响应'),
          chalk.bold('P95响应'),
          chalk.bold('P99响应'),
          chalk.bold('检测次数'),
          chalk.bold('故障次数')
        ],
        colWidths: [12, 12, 12, 12, 12, 12, 12]
      });

      for (const period of periods) {
        const stats = periodData[period.hours];
        const uptimeColor = stats.uptime >= 99.9 ? 'green' 
          : stats.uptime >= 99 ? 'yellow' : 'red';
        
        table.push([
          period.label,
          chalk[uptimeColor](stats.uptime.toFixed(2) + '%'),
          `${stats.avgResponseTime}ms`,
          `${stats.p95}ms`,
          `${stats.p99}ms`,
          stats.total.toString(),
          stats.downtime.length.toString()
        ]);
      }

      console.log(table.toString());

      for (const period of periods) {
        const stats = periodData[period.hours];
        if (stats.downtime.length > 0) {
          console.log(chalk.bold.yellow(`\n${period.label}故障时段明细:`));
          for (const dt of stats.downtime) {
            const duration = dayjs(dt.end).diff(dayjs(dt.start), 'minute');
            console.log(`  ${chalk.red('●')} ${dayjs(dt.start).format('YYYY-MM-DD HH:mm:ss')} - ` +
              `${dayjs(dt.end).format('HH:mm:ss')} (持续${duration}分钟, ${dt.count}次检测失败)`);
          }
        }
      }
      
      console.log('\n' + '─'.repeat(80) + '\n');
    }

    this.printSummary(reportData);
    
    return { targets: reportData.length };
  }

  async getTransactionReportData() {
    const transactions = await db.getTransactions();
    const periods = [
      { label: '24小时', hours: 24 },
      { label: '7天', hours: 24 * 7 },
      { label: '30天', hours: 24 * 30 }
    ];

    const reportData = [];
    for (const tx of transactions) {
      const txData = {
        transaction: tx,
        periods: {}
      };
      
      for (const period of periods) {
        const stats = await db.getTransactionUptimeStats(tx.id, period.hours);
        const stepAvgTimes = await db.getTransactionStepAvgTimes(tx.id, period.hours);
        const steps = await db.getTransactionSteps(tx.id);
        
        txData.periods[period.hours] = {
          ...stats,
          stepAvgTimes,
          steps
        };
      }
      
      reportData.push(txData);
    }
    return { reportData, periods };
  }

  async generateTransactionReport(format = 'table', outputFile = null) {
    const { reportData, periods } = await this.getTransactionReportData();

    if (format === 'html') {
      const html = this.generateTransactionHTML(reportData, periods);
      if (outputFile) {
        fs.writeFileSync(outputFile, html);
        return { file: outputFile, transactions: reportData.length };
      }
      console.log(html);
      return { transactions: reportData.length };
    }

    return this.printTransactionReport(reportData, periods);
  }

  printTransactionReport(reportData, periods) {
    console.log(chalk.bold.cyan('\n=== 事务监测报告 ===\n'));
    console.log(chalk.gray(`生成时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}\n`));

    if (reportData.length === 0) {
      console.log(chalk.yellow('暂无事务配置'));
      return { transactions: 0 };
    }

    for (const data of reportData) {
      const { transaction, periods: periodData } = data;
      
      console.log(chalk.bold.green(`事务: ${transaction.name}`));
      console.log(chalk.gray(`描述: ${transaction.description || '(无)'}`));
      console.log(chalk.gray(`环境: ${transaction.environment || 'prod'}\n`));

      const table = new Table({
        head: [
          chalk.bold('时间段'),
          chalk.bold('通过率'),
          chalk.bold('平均耗时'),
          chalk.bold('执行次数'),
          chalk.bold('失败次数')
        ],
        colWidths: [12, 12, 12, 12, 12]
      });

      for (const period of periods) {
        const stats = periodData[period.hours];
        const passColor = stats.pass_rate >= 99 ? 'green' 
          : stats.pass_rate >= 95 ? 'yellow' : 'red';
        
        table.push([
          period.label,
          chalk[passColor](stats.pass_rate.toFixed(2) + '%'),
          `${stats.avgTotalTime}ms`,
          stats.total.toString(),
          (stats.total - stats.successful).toString()
        ]);
      }

      console.log(table.toString());

      for (const period of periods) {
        const stats = periodData[period.hours];
        if (stats.steps && stats.steps.length > 0) {
          console.log(chalk.bold.yellow(`\n${period.label}各步骤平均耗时:`));
          const stepTable = new Table({
            head: [chalk.bold('步骤'), chalk.bold('平均耗时'), chalk.bold('顺序')],
            colWidths: [30, 15, 10]
          });
          
          for (let i = 0; i < stats.steps.length; i++) {
            const step = stats.steps[i];
            const avgTime = stats.stepAvgTimes[step.name] || '-';
            stepTable.push([
              step.name,
              avgTime !== '-' ? `${avgTime}ms` : '-',
              i + 1
            ]);
          }
          console.log(stepTable.toString());
        }
      }
      
      console.log('\n' + '─'.repeat(80) + '\n');
    }

    this.printTransactionSummary(reportData);
    return { transactions: reportData.length };
  }

  printTransactionSummary(reportData) {
    const total24h = reportData.reduce((sum, d) => sum + (d.periods[24].total || 0), 0);
    const success24h = reportData.reduce((sum, d) => sum + (d.periods[24].successful || 0), 0);
    const overallPassRate = total24h > 0 ? ((success24h / total24h) * 100).toFixed(2) : '0.00';
    
    console.log(chalk.bold.cyan('=== 事务总体摘要 ==='));
    console.log(`事务总数: ${reportData.length}`);
    console.log(`24小时整体通过率: ${chalk.green(overallPassRate + '%')}`);
    console.log(`24小时总执行次数: ${total24h}`);
    
    const failedTx = reportData.filter(d => d.periods[24].total > d.periods[24].successful);
    if (failedTx.length > 0) {
      console.log(chalk.red(`24小时内有失败的事务: ${failedTx.map(d => d.transaction.name).join(', ')}`));
    }
    console.log('');
  }

  generateTransactionHTML(reportData, periods) {
    const rows = [];
    const detailSections = [];

    for (const data of reportData) {
      const { transaction, periods: periodData } = data;
      
      const periodCells = periods.map(p => {
        const stats = periodData[p.hours];
        const passColor = stats.pass_rate >= 99 ? '#28a745' 
          : stats.pass_rate >= 95 ? '#ffc107' : '#dc3545';
        
        return `
          <td style="padding: 8px; border: 1px solid #ddd;">${p.label}</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: ${passColor}; font-weight: bold;">${stats.pass_rate.toFixed(2)}%</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.avgTotalTime}ms</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.total}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.total - stats.successful}</td>
        `;
      }).join('</tr><tr>');

      rows.push(`
        <tr>
          <td rowspan="${periods.length}" style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f8f9fa;">${transaction.name}</td>
          <td rowspan="${periods.length}" style="padding: 8px; border: 1px solid #ddd;">${transaction.description || '-'}</td>
          ${periodCells}
        </tr>
      `);

      for (const period of periods) {
        const stats = periodData[period.hours];
        if (stats.steps && stats.steps.length > 0) {
          const stepRows = stats.steps.map((step, i) => {
            const avgTime = stats.stepAvgTimes[step.name] || '-';
            return `<tr><td>${i + 1}</td><td>${step.name}</td><td>${avgTime !== '-' ? avgTime + 'ms' : '-'}</td></tr>`;
          }).join('');

          detailSections.push(`
            <div style="margin: 20px 0; padding: 15px; background: #e8f5e8; border-radius: 5px;">
              <h3 style="margin-top: 0; color: #155724;">${transaction.name} - ${period.label}步骤平均耗时</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><th style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa; width: 80px;">顺序</th><th style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa;">步骤名称</th><th style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa; width: 120px;">平均耗时</th></tr>
                ${stepRows}
              </table>
            </div>
          `);
        }
      }
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>事务监测报告</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #28a745; border-bottom: 2px solid #28a745; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { padding: 12px; border: 1px solid #ddd; background: #28a745; color: white; text-align: left; }
    .summary { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>事务监测报告</h1>
    <p style="color: #666;">生成时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}</p>
    
    <table>
      <tr>
        <th>事务名称</th>
        <th>描述</th>
        <th>时间段</th>
        <th>通过率</th>
        <th>平均耗时</th>
        <th>执行次数</th>
        <th>失败次数</th>
      </tr>
      ${rows.join('')}
    </table>
    
    ${detailSections.join('')}
  </div>
</body>
</html>`;
  }

  printSummary(reportData) {
    const total24h = reportData.reduce((sum, d) => sum + (d.periods[24].total || 0), 0);
    const success24h = reportData.reduce((sum, d) => sum + (d.periods[24].successful || 0), 0);
    const overallUptime = total24h > 0 ? ((success24h / total24h) * 100).toFixed(2) : '0.00';
    
    console.log(chalk.bold.cyan('=== 总体摘要 ==='));
    console.log(`监测目标总数: ${reportData.length}`);
    console.log(`24小时整体可用率: ${chalk.green(overallUptime + '%')}`);
    console.log(`24小时总检测次数: ${total24h}`);
    
    const downtimeTargets = reportData.filter(d => d.periods[24].downtime.length > 0);
    if (downtimeTargets.length > 0) {
      console.log(chalk.red(`24小时内有故障的目标: ${downtimeTargets.map(d => d.target.name).join(', ')}`));
    }
    console.log('');
  }

  generateHTML(reportData, periods) {
    const rows = [];
    const detailSections = [];

    for (const data of reportData) {
      const { target, periods: periodData } = data;
      
      const periodCells = periods.map(p => {
        const stats = periodData[p.hours];
        const uptimeColor = stats.uptime >= 99.9 ? '#28a745' 
          : stats.uptime >= 99 ? '#ffc107' : '#dc3545';
        
        return `
          <td style="padding: 8px; border: 1px solid #ddd;">${p.label}</td>
          <td style="padding: 8px; border: 1px solid #ddd; color: ${uptimeColor}; font-weight: bold;">${stats.uptime.toFixed(2)}%</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.avgResponseTime}ms</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.p95}ms</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.p99}ms</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.total}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${stats.downtime.length}</td>
        `;
      }).join('</tr><tr>');

      rows.push(`
        <tr>
          <td rowspan="${periods.length}" style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f8f9fa;">${target.name}</td>
          <td rowspan="${periods.length}" style="padding: 8px; border: 1px solid #ddd; font-family: monospace;">${target.url}</td>
          ${periodCells}
        </tr>
      `);

      for (const period of periods) {
        const stats = periodData[period.hours];
        if (stats.downtime.length > 0) {
          const downtimeRows = stats.downtime.map(dt => {
            const duration = dayjs(dt.end).diff(dayjs(dt.start), 'minute');
            return `<tr><td>${dayjs(dt.start).format('YYYY-MM-DD HH:mm:ss')}</td><td>${dayjs(dt.end).format('HH:mm:ss')}</td><td>${duration}分钟</td><td>${dt.count}</td></tr>`;
          }).join('');

          detailSections.push(`
            <div style="margin: 20px 0; padding: 15px; background: #fff3cd; border-radius: 5px;">
              <h3 style="margin-top: 0; color: #856404;">${target.name} - ${period.label}故障时段</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr><th style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa;">开始时间</th><th style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa;">结束时间</th><th style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa;">持续时间</th><th style="padding: 8px; border: 1px solid #ddd; background: #f8f9fa;">失败次数</th></tr>
                ${downtimeRows}
              </table>
            </div>
          `);
        }
      }
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>网站可用性监测报告</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #007bff; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { padding: 12px; border: 1px solid #ddd; background: #007bff; color: white; text-align: left; }
    .summary { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 20px 0; }
    .green { color: #28a745; }
    .yellow { color: #ffc107; }
    .red { color: #dc3545; }
  </style>
</head>
<body>
  <div class="container">
    <h1>网站可用性监测报告</h1>
    <p style="color: #666;">生成时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}</p>
    
    <table>
      <tr>
        <th>目标名称</th>
        <th>URL</th>
        <th>时间段</th>
        <th>可用率</th>
        <th>平均响应</th>
        <th>P95响应</th>
        <th>P99响应</th>
        <th>检测次数</th>
        <th>故障次数</th>
      </tr>
      ${rows.join('')}
    </table>
    
    ${detailSections.join('')}
  </div>
</body>
</html>`;
  }

  async generateTargetReport(targetId, format = 'table', outputFile = null) {
    const target = await db.getTargetById(targetId);
    if (!target) {
      throw new Error(`目标不存在: ${targetId}`);
    }
    
    const periods = [
      { label: '24小时', hours: 24 },
      { label: '7天', hours: 24 * 7 },
      { label: '30天', hours: 24 * 30 }
    ];

    const targetData = {
      target,
      periods: {}
    };

    for (const period of periods) {
      const uptime = await db.getUptimeStats(target.id, period.hours);
      const percentiles = await db.getResponseTimePercentiles(target.id, period.hours);
      const downtime = await db.getDowntimePeriods(target.id, period.hours);
      
      targetData.periods[period.hours] = {
        ...uptime,
        ...percentiles,
        downtime
      };
    }

    const reportData = [targetData];

    if (format === 'html') {
      const html = this.generateHTML(reportData, periods);
      if (outputFile) {
        fs.writeFileSync(outputFile, html);
        return { file: outputFile };
      }
      console.log(html);
      return {};
    }

    return this.generateTerminalTable(reportData, periods);
  }
}

module.exports = new Reporter();
