const fs = require('fs');
const path = require('path');
const http = require('http');
const chalk = require('chalk');
const dayjs = require('dayjs');
const db = require('./database');
const incidentManager = require('./incident');

const STATUS_PORT = 9412;

class StatusPageGenerator {
  constructor() {
    this.server = null;
  }

  getUptimeColor(uptime) {
    if (uptime === null || uptime === undefined) return '#e0e0e0';
    if (uptime >= 99.5) return '#00b894';
    if (uptime >= 95) return '#fdcb6e';
    return '#e17055';
  }

  getUptimeLabel(uptime) {
    if (uptime === null || uptime === undefined) return '无数据';
    return uptime.toFixed(1) + '%';
  }

  async getTargetStatus(target) {
    const latest = await db.getLatestResult(target.id);
    const stats24h = await db.getUptimeStats(target.id, 24);
    
    let status = 'operational';
    let statusLabel = '在线';
    let statusColor = '#00b894';
    
    if (!latest) {
      status = 'unknown';
      statusLabel = '未知';
      statusColor = '#636e72';
    } else if (!latest.success) {
      const consecutive = await db.getConsecutiveFailures(target.id);
      if (consecutive >= target.alert_fail_count * 2) {
        status = 'major_outage';
        statusLabel = '离线';
        statusColor = '#e17055';
      } else if (consecutive >= target.alert_fail_count) {
        status = 'degraded';
        statusLabel = '降级';
        statusColor = '#fdcb6e';
      } else {
        status = 'degraded';
        statusLabel = '波动';
        statusColor = '#fdcb6e';
      }
    } else if (target.response_time_threshold && latest.response_time > target.response_time_threshold) {
      status = 'degraded';
      statusLabel = '慢速';
      statusColor = '#fdcb6e';
    }

    return {
      status,
      statusLabel,
      statusColor,
      latest,
      stats24h
    };
  }

  async getStatusData() {
    const targets = await db.getTargets();
    const incidents = await incidentManager.getActiveIncidentsForStatusPage();
    const targetData = [];

    for (const target of targets) {
      if (target.enabled !== 1) continue;
      
      const status = await this.getTargetStatus(target);
      const dailyUptime = await db.getDailyUptime(target.id, 90);
      const stats30d = await db.getUptimeStats(target.id, 24 * 30);
      
      targetData.push({
        id: target.id,
        name: target.name,
        url: target.url,
        environment: target.environment,
        ...status,
        dailyUptime,
        stats30d
      });
    }

    const overallStatus = this.calculateOverallStatus(targetData);

    return {
      generatedAt: dayjs().toISOString(),
      generatedAtFormatted: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      overallStatus,
      targets: targetData,
      incidents
    };
  }

  calculateOverallStatus(targetData) {
    const statuses = targetData.map(t => t.status);
    
    if (statuses.includes('major_outage')) {
      return {
        status: 'major_outage',
        label: '部分服务中断',
        color: '#e17055',
        description: '部分服务正在经历严重中断'
      };
    }
    if (statuses.includes('degraded')) {
      return {
        status: 'degraded',
        label: '部分服务降级',
        color: '#fdcb6e',
        description: '部分服务性能下降'
      };
    }
    if (statuses.every(s => s === 'operational')) {
      return {
        status: 'operational',
        label: '所有系统运行正常',
        color: '#00b894',
        description: '所有服务运行正常'
      };
    }
    return {
      status: 'unknown',
      label: '状态未知',
      color: '#636e72',
      description: '无法确定系统状态'
    };
  }

  generateHTML(data) {
    const targetRows = data.targets.map(target => {
      const heatmapCells = target.dailyUptime.map(day => {
        const color = this.getUptimeColor(day.uptime);
        const title = `${day.date}: ${this.getUptimeLabel(day.uptime)}`;
        return `<div class="uptime-cell" style="background-color: ${color};" title="${title}"></div>`;
      }).join('');

      const avg30d = target.stats30d.uptime.toFixed(2);
      const avg30dColor = this.getUptimeColor(target.stats30d.uptime);

      return `
        <div class="target-row">
          <div class="target-header">
            <div class="target-info">
              <span class="status-dot" style="background-color: ${target.statusColor};"></span>
              <span class="target-name">${target.name}</span>
              <span class="target-env">${target.environment || 'prod'}</span>
            </div>
            <div class="target-status">
              <span class="status-badge" style="background-color: ${target.statusColor}20; color: ${target.statusColor};">
                ${target.statusLabel}
              </span>
              <span class="target-uptime" style="color: ${avg30dColor};">
                ${avg30d}% <span style="color: #636e72; font-weight: normal; font-size: 12px;">(30天)</span>
              </span>
            </div>
          </div>
          <div class="target-heatmap">
            ${heatmapCells}
          </div>
          <div class="heatmap-labels">
            <span>${dayjs().subtract(89, 'day').format('MM-DD')}</span>
            <span>${dayjs().subtract(45, 'day').format('MM-DD')}</span>
            <span>${dayjs().format('MM-DD')}</span>
          </div>
        </div>
      `;
    }).join('');

    const incidentCards = data.incidents.map(incident => {
      const sevColor = incident.severity === 'critical' ? '#e17055' : '#fdcb6e';
      const updates = incident.updates.map(u => `
        <div class="incident-update">
          <span class="update-time">${dayjs(u.createdAt).format('MM-DD HH:mm')}</span>
          <span class="update-status" style="color: ${sevColor};">[${u.statusLabel}]</span>
          <span class="update-message">${u.message}</span>
        </div>
      `).join('');

      return `
        <div class="incident-card" style="border-left: 4px solid ${sevColor};">
          <div class="incident-header">
            <span class="incident-severity" style="background-color: ${sevColor}20; color: ${sevColor};">
              ${incident.severityLabel}
            </span>
            <span class="incident-title">${incident.title}</span>
            <span class="incident-status">${incident.statusLabel}</span>
          </div>
          ${incident.affectedTargets.length > 0 ? `
            <div class="incident-affected">
              影响: ${incident.affectedTargets.join(', ')}
            </div>
          ` : ''}
          ${updates}
        </div>
      `;
    }).join('');

    const legend = `
      <div class="legend">
        <span>图例:</span>
        <span class="legend-item"><span class="legend-color" style="background-color: #00b894;"></span> >99.5%</span>
        <span class="legend-item"><span class="legend-color" style="background-color: #fdcb6e;"></span> 95-99.5%</span>
        <span class="legend-item"><span class="legend-color" style="background-color: #e17055;"></span> <95%</span>
        <span class="legend-item"><span class="legend-color" style="background-color: #e0e0e0;"></span> 无数据</span>
      </div>
    `;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>系统状态 - UpMon</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f5f6fa;
      color: #2d3436;
      min-height: 100vh;
    }
    .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
    .header {
      background: white;
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    .overall-status {
      display: flex;
      align-items: center;
      gap: 15px;
      margin-bottom: 10px;
    }
    .status-indicator {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .status-text { font-size: 24px; font-weight: 600; }
    .status-description { color: #636e72; margin-top: 5px; }
    .generated-at {
      color: #b2bec3;
      font-size: 13px;
      margin-top: 15px;
    }
    .section {
      background: white;
      border-radius: 12px;
      padding: 25px;
      margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    .section-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 20px;
      color: #2d3436;
    }
    .target-row {
      padding: 20px 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .target-row:last-child { border-bottom: none; }
    .target-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .target-info {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .target-name {
      font-weight: 500;
      font-size: 15px;
    }
    .target-env {
      background: #f0f0f0;
      color: #636e72;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    .target-status {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    .target-uptime {
      font-weight: 600;
      font-size: 14px;
    }
    .target-heatmap {
      display: grid;
      grid-template-columns: repeat(90, 1fr);
      gap: 2px;
      height: 30px;
    }
    .uptime-cell {
      border-radius: 2px;
      cursor: help;
      transition: transform 0.2s;
    }
    .uptime-cell:hover {
      transform: scale(1.5);
      z-index: 10;
    }
    .heatmap-labels {
      display: flex;
      justify-content: space-between;
      color: #b2bec3;
      font-size: 11px;
      margin-top: 5px;
    }
    .legend {
      display: flex;
      align-items: center;
      gap: 15px;
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #f0f0f0;
      color: #636e72;
      font-size: 13px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 2px;
    }
    .incident-card {
      background: #fafafa;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
    }
    .incident-card:last-child { margin-bottom: 0; }
    .incident-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .incident-severity {
      padding: 3px 10px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 500;
    }
    .incident-title { font-weight: 500; }
    .incident-status {
      margin-left: auto;
      color: #636e72;
      font-size: 13px;
    }
    .incident-affected {
      color: #636e72;
      font-size: 13px;
      margin-bottom: 10px;
    }
    .incident-update {
      padding: 8px 0;
      border-top: 1px solid #eee;
      font-size: 13px;
      display: flex;
      gap: 10px;
    }
    .incident-update:first-of-type { border-top: none; }
    .update-time { color: #b2bec3; }
    .update-status { font-weight: 500; }
    .no-incidents {
      text-align: center;
      padding: 30px;
      color: #b2bec3;
    }
    .no-incidents-icon {
      font-size: 40px;
      margin-bottom: 10px;
    }
    h1 {
      font-size: 20px;
      margin-bottom: 5px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔔 系统状态</h1>
      <div class="overall-status">
        <span class="status-indicator" style="background-color: ${data.overallStatus.color};"></span>
        <span class="status-text" style="color: ${data.overallStatus.color};">${data.overallStatus.label}</span>
      </div>
      <p class="status-description">${data.overallStatus.description}</p>
      <p class="generated-at">最后更新: ${data.generatedAtFormatted}</p>
    </div>

    <div class="section">
      <h2 class="section-title">服务状态</h2>
      ${targetRows}
      ${legend}
    </div>

    <div class="section">
      <h2 class="section-title">当前事件</h2>
      ${data.incidents.length > 0 ? incidentCards : `
        <div class="no-incidents">
          <div class="no-incidents-icon">✅</div>
          <div>当前没有进行中的事件</div>
        </div>
      `}
    </div>
  </div>
</body>
</html>`;
  }

  async generate(outputFile = null) {
    const data = await this.getStatusData();
    const html = this.generateHTML(data);

    if (outputFile) {
      const fullPath = path.resolve(outputFile);
      fs.writeFileSync(fullPath, html);
      console.log(chalk.green(`✓ 状态页面已生成: ${fullPath}`));
      return { file: fullPath, data };
    }

    console.log(html);
    return { html, data };
  }

  async serve() {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/' || req.url === '/status') {
        try {
          const data = await this.getStatusData();
          const html = this.generateHTML(data);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`错误: ${err.message}`);
        }
      } else if (req.url === '/api/status') {
        try {
          const data = await this.getStatusData();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(data, null, 2));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
    });

    this.server = server;

    return new Promise((resolve, reject) => {
      server.listen(STATUS_PORT, () => {
        console.log(chalk.green(`\n✓ 状态页面服务已启动`));
        console.log(chalk.cyan(`  访问地址: http://localhost:${STATUS_PORT}`));
        console.log(chalk.cyan(`  API 接口: http://localhost:${STATUS_PORT}/api/status`));
        console.log(chalk.gray(`  按 Ctrl+C 停止服务\n`));
        resolve(server);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(chalk.yellow(`端口 ${STATUS_PORT} 已被占用，尝试下一个端口...`));
          server.close();
          server.listen(STATUS_PORT + 1, () => {
            console.log(chalk.green(`\n✓ 状态页面服务已启动`));
            console.log(chalk.cyan(`  访问地址: http://localhost:${STATUS_PORT + 1}`));
            console.log(chalk.gray(`  按 Ctrl+C 停止服务\n`));
            resolve(server);
          });
        } else {
          reject(err);
        }
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log(chalk.yellow('状态页面服务已停止'));
    }
  }
}

module.exports = new StatusPageGenerator();
