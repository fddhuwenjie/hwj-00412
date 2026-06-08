const chalk = require('chalk');
const Table = require('cli-table3');
const dayjs = require('dayjs');
const db = require('./database');

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];
const STATUS_ORDER = ['investigating', 'identified', 'monitoring', 'resolved'];
const STATUS_LABELS = {
  investigating: '调查中',
  identified: '已定位',
  monitoring: '监控中',
  resolved: '已解决'
};
const SEVERITY_LABELS = {
  critical: '严重',
  major: '主要',
  minor: '次要',
  info: '信息'
};
const SEVERITY_COLORS = {
  critical: 'red',
  major: 'red',
  minor: 'yellow',
  info: 'blue'
};

class IncidentManager {
  async create(options) {
    const { title, severity, affected_targets, description } = options;

    if (!title) {
      throw new Error('事件标题是必填项');
    }

    if (severity && !SEVERITY_ORDER.includes(severity)) {
      throw new Error(`严重程度必须是: ${SEVERITY_ORDER.join(', ')}`);
    }

    let affectedTargets = null;
    if (affected_targets) {
      const targetNames = affected_targets.split(',').map(t => t.trim()).filter(Boolean);
      affectedTargets = [];
      for (const name of targetNames) {
        const target = await db.getTargetByName(name);
        if (!target) {
          console.log(chalk.yellow(`警告: 未找到目标 "${name}"，将以名称记录`));
        }
        affectedTargets.push(name);
      }
    }

    const id = await db.addIncident({
      title,
      severity: severity || 'major',
      status: 'investigating',
      affected_targets: affectedTargets,
      description: description || null
    });

    if (description) {
      await db.addIncidentUpdate(id, 'investigating', description);
    }

    console.log(chalk.green(`✓ 成功创建事件: ${title} (ID: ${id})`));
    console.log(chalk.gray(`  严重程度: ${SEVERITY_LABELS[severity || 'major']}`));
    console.log(chalk.gray(`  状态: ${STATUS_LABELS['investigating']}`));
    if (affectedTargets) {
      console.log(chalk.gray(`  影响目标: ${affectedTargets.join(', ')}`));
    }
    return id;
  }

  async update(incidentIdentifier, options) {
    let incident;
    if (/^\d+$/.test(incidentIdentifier)) {
      incident = await db.getIncidentById(parseInt(incidentIdentifier));
    } else {
      throw new Error('请使用事件ID进行更新');
    }

    if (!incident) {
      throw new Error(`事件不存在: ${incidentIdentifier}`);
    }

    if (options.status && !STATUS_ORDER.includes(options.status)) {
      throw new Error(`状态必须是: ${STATUS_ORDER.join(', ')}`);
    }

    if (options.severity && !SEVERITY_ORDER.includes(options.severity)) {
      throw new Error(`严重程度必须是: ${SEVERITY_ORDER.join(', ')}`);
    }

    const updates = {};
    if (options.title) updates.title = options.title;
    if (options.severity) updates.severity = options.severity;
    if (options.status) updates.status = options.status;
    if (options.affected_targets) {
      const targetNames = options.affected_targets.split(',').map(t => t.trim()).filter(Boolean);
      updates.affected_targets = targetNames;
    }

    if (Object.keys(updates).length > 0) {
      await db.updateIncident(incident.id, updates);
    }

    if (options.message) {
      await db.addIncidentUpdate(incident.id, options.status || incident.status, options.message);
    }

    console.log(chalk.green(`✓ 成功更新事件: ${incident.title} (ID: ${incident.id})`));
    if (options.status) {
      console.log(chalk.gray(`  新状态: ${STATUS_LABELS[options.status]}`));
    }
    if (options.message) {
      console.log(chalk.gray(`  更新内容: ${options.message}`));
    }
  }

  async close(incidentIdentifier, message = null) {
    let incident;
    if (/^\d+$/.test(incidentIdentifier)) {
      incident = await db.getIncidentById(parseInt(incidentIdentifier));
    } else {
      throw new Error('请使用事件ID进行关闭');
    }

    if (!incident) {
      throw new Error(`事件不存在: ${incidentIdentifier}`);
    }

    await db.resolveIncident(incident.id);
    await db.addIncidentUpdate(incident.id, 'resolved', message || '事件已解决');

    console.log(chalk.green(`✓ 成功关闭事件: ${incident.title} (ID: ${incident.id})`));
  }

  async list(status = null, showDetails = false) {
    const incidents = status 
      ? await db.getIncidents(status)
      : await db.getIncidents();

    if (incidents.length === 0) {
      console.log(chalk.yellow('暂无事件记录'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('状态'),
        chalk.bold('严重程度'),
        chalk.bold('标题'),
        chalk.bold('影响目标'),
        chalk.bold('创建时间')
      ],
      colWidths: [6, 12, 12, 30, 25, 22]
    });

    for (const incident of incidents) {
      const statusColor = incident.status === 'resolved' ? 'gray' : 
        incident.status === 'monitoring' ? 'yellow' : 'red';
      const sevColor = SEVERITY_COLORS[incident.severity] || 'white';
      
      let affectedTargets = '-';
      if (incident.affected_targets) {
        try {
          const targets = JSON.parse(incident.affected_targets);
          affectedTargets = targets.join(', ');
        } catch {
          affectedTargets = incident.affected_targets;
        }
      }

      table.push([
        incident.id,
        chalk[statusColor](STATUS_LABELS[incident.status] || incident.status),
        chalk[sevColor](SEVERITY_LABELS[incident.severity] || incident.severity),
        incident.title,
        affectedTargets,
        dayjs(incident.created_at).format('YYYY-MM-DD HH:mm')
      ]);
    }

    console.log(table.toString());

    if (showDetails) {
      for (const incident of incidents) {
        if (incident.status === 'resolved') continue;
        await this.showDetails(incident.id);
      }
    }
  }

  async showDetails(incidentId) {
    const incident = await db.getIncidentById(incidentId);
    if (!incident) {
      throw new Error(`事件不存在: ${incidentId}`);
    }

    const updates = await db.getIncidentUpdates(incidentId);

    console.log(chalk.bold.cyan(`\n=== 事件详情 #${incident.id} ===`));
    console.log(`  ${chalk.bold('标题:')} ${incident.title}`);
    console.log(`  ${chalk.bold('状态:')} ${STATUS_LABELS[incident.status] || incident.status}`);
    console.log(`  ${chalk.bold('严重程度:')} ${SEVERITY_LABELS[incident.severity] || incident.severity}`);
    console.log(`  ${chalk.bold('创建时间:')} ${dayjs(incident.created_at).format('YYYY-MM-DD HH:mm:ss')}`);
    if (incident.resolved_at) {
      console.log(`  ${chalk.bold('解决时间:')} ${dayjs(incident.resolved_at).format('YYYY-MM-DD HH:mm:ss')}`);
    }
    
    if (incident.affected_targets) {
      try {
        const targets = JSON.parse(incident.affected_targets);
        console.log(`  ${chalk.bold('影响目标:')} ${targets.join(', ')}`);
      } catch {
        console.log(`  ${chalk.bold('影响目标:')} ${incident.affected_targets}`);
      }
    }

    if (updates.length > 0) {
      console.log(`\n  ${chalk.bold('更新历史:')}`);
      for (const update of updates) {
        const time = dayjs(update.created_at).format('YYYY-MM-DD HH:mm:ss');
        const statusLabel = STATUS_LABELS[update.status] || update.status;
        console.log(`    [${time}] ${chalk.yellow(statusLabel)}: ${update.message}`);
      }
    }
    console.log('');
  }

  async getActiveIncidentsForStatusPage() {
    const incidents = await db.getActiveIncidents();
    const result = [];
    
    for (const incident of incidents) {
      const updates = await db.getIncidentUpdates(incident.id);
      
      let affectedTargets = [];
      if (incident.affected_targets) {
        try {
          affectedTargets = JSON.parse(incident.affected_targets);
        } catch {
          affectedTargets = [incident.affected_targets];
        }
      }

      result.push({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        statusLabel: STATUS_LABELS[incident.status] || incident.status,
        severityLabel: SEVERITY_LABELS[incident.severity] || incident.severity,
        affectedTargets,
        description: incident.description,
        createdAt: incident.created_at,
        updatedAt: incident.updated_at,
        updates: updates.map(u => ({
          status: u.status,
          statusLabel: STATUS_LABELS[u.status] || u.status,
          message: u.message,
          createdAt: u.created_at
        }))
      });
    }
    
    return result;
  }
}

module.exports = new IncidentManager();
