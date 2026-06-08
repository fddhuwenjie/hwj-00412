#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const dayjs = require('dayjs');
const db = require('./lib/database');
const targetManager = require('./lib/targets');
const checkEngine = require('./lib/checker');
const dashboard = require('./lib/dashboard');
const reporter = require('./lib/reporter');
const configManager = require('./lib/config');
const sampleData = require('./lib/sampleData');
const alertManager = require('./lib/alerts');
const webhookManager = require('./lib/webhook');
const incidentManager = require('./lib/incident');
const statusPage = require('./lib/statusPage');
const transactionManager = require('./lib/transaction');

const program = new Command();

program
  .name('upmon')
  .description('网站可用性监测与告警工具')
  .version('1.0.0');

program
  .command('init')
  .description('初始化数据库并加载示例数据')
  .action(async () => {
    try {
      await db.init();
      await sampleData.init();
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 初始化失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('add')
  .description('添加监测目标')
  .requiredOption('-n, --name <name>', '目标名称')
  .requiredOption('-u, --url <url>', '监测URL')
  .option('-i, --interval <seconds>', '检测间隔秒数', '60')
  .option('-t, --timeout <seconds>', '超时时间秒数', '10')
  .option('-s, --expected-status <code>', '预期状态码', '200')
  .option('-k, --expected-keyword <keyword>', '预期响应体关键词')
  .option('-f, --alert-fail-count <count>', '连续失败告警次数', '3')
  .option('-r, --response-time-threshold <ms>', '响应时间告警阈值(ms)')
  .option('-l, --ssl-alert-days <days>', 'SSL到期告警天数', '7')
  .option('-e, --environment <env>', '环境(dev/staging/prod)', 'prod')
  .action(async (options) => {
    try {
      await db.init();
      await targetManager.add(options);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 添加失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('列出所有监测目标')
  .option('-e, --environment <env>', '按环境过滤')
  .option('-d, --details', '显示详细信息')
  .action(async (options) => {
    try {
      await db.init();
      await targetManager.list(options.environment, options.details);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 查询失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('remove <target>')
  .description('删除监测目标(ID或名称)')
  .action(async (target) => {
    try {
      await db.init();
      await targetManager.remove(target);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 删除失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('edit <target>')
  .description('编辑监测目标(ID或名称)')
  .option('-n, --name <name>', '目标名称')
  .option('-u, --url <url>', '监测URL')
  .option('-i, --interval <seconds>', '检测间隔秒数')
  .option('-t, --timeout <seconds>', '超时时间秒数')
  .option('-s, --expected-status <code>', '预期状态码')
  .option('-k, --expected-keyword <keyword>', '预期响应体关键词')
  .option('-f, --alert-fail-count <count>', '连续失败告警次数')
  .option('-r, --response-time-threshold <ms>', '响应时间告警阈值(ms)')
  .option('-l, --ssl-alert-days <days>', 'SSL到期告警天数')
  .option('-e, --environment <env>', '环境(dev/staging/prod)')
  .option('--enable', '启用目标')
  .option('--disable', '禁用目标')
  .action(async (target, options) => {
    try {
      await db.init();
      const updates = { ...options };
      if (options.enable) updates.enabled = true;
      if (options.disable) updates.enabled = false;
      delete updates.enable;
      delete updates.disable;
      await targetManager.edit(target, updates);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 编辑失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('start')
  .description('启动后台监测服务')
  .option('-e, --environment <env>', '只监测指定环境的目标')
  .option('--once', '只执行一次检测')
  .action(async (options) => {
    try {
      await db.init();
      
      const targets = await db.getTargets(options.environment);
      if (targets.length === 0) {
        console.log(chalk.yellow('未找到监测目标，请先使用 add 命令添加或使用 init 初始化示例数据'));
        await db.close();
        process.exit(0);
      }

      if (options.once) {
        console.log(chalk.cyan('执行单次检测...\n'));
        const results = await checkEngine.runOnce(options.environment);
        for (const { target, result } of results) {
          const status = result.success 
            ? chalk.green(`✓ ${result.response_time}ms`)
            : chalk.red(`✗ ${result.error_message || '失败'}`);
          console.log(`  ${target.name}: ${status}`);
        }
        await db.close();
        process.exit(0);
      }

      console.log(chalk.bold.cyan('\n=== UpMon 监测服务启动 ===\n'));
      console.log(chalk.gray(`启动时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`));
      console.log(chalk.gray(`告警日志: ${alertManager.getAlertLogPath()}\n`));

      await checkEngine.startAll(options.environment);

      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\n\n正在停止监测服务...'));
        checkEngine.stopAll();
        await db.close();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        checkEngine.stopAll();
        await db.close();
        process.exit(0);
      });

    } catch (err) {
      console.error(chalk.red('✗ 启动失败:'), err.message);
      await db.close();
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('停止监测服务(通过PID)')
  .option('-p, --pid <pid>', '进程ID')
  .action(async (options) => {
    if (options.pid) {
      try {
        process.kill(parseInt(options.pid), 'SIGINT');
        console.log(chalk.green(`✓ 已发送停止信号到进程 ${options.pid}`));
      } catch (err) {
        console.error(chalk.red('✗ 停止失败:'), err.message);
        process.exit(1);
      }
    } else {
      console.log(chalk.yellow('请使用 --pid 参数指定要停止的进程ID'));
      console.log('查找进程: ps aux | grep "upmon start"');
    }
  });

program
  .command('dashboard')
  .description('启动仪表盘(TUI界面)')
  .option('-e, --environment <env>', '只显示指定环境的目标')
  .action(async (options) => {
    try {
      await db.init();
      const targets = await db.getTargets(options.environment);
      if (targets.length === 0) {
        console.log(chalk.yellow('未找到监测目标，请先使用 add 命令添加或使用 init 初始化示例数据'));
        await db.close();
        process.exit(0);
      }
      await dashboard.start(options.environment);
    } catch (err) {
      console.error(chalk.red('✗ 仪表盘启动失败:'), err.message);
      dashboard.stop();
      await db.close();
      process.exit(1);
    }
  });

program
  .command('report')
  .description('生成监测报告')
  .option('-f, --format <format>', '输出格式: table/html', 'table')
  .option('-o, --output <file>', '输出文件路径(HTML格式)')
  .option('-e, --environment <env>', '只生成指定环境的报告')
  .option('-t, --target <id>', '只生成指定目标的报告(ID或名称)')
  .option('--transaction', '生成事务监测报告')
  .action(async (options) => {
    try {
      await db.init();
      
      let result;
      if (options.transaction) {
        result = await reporter.generateTransactionReport(options.format, options.output);
      } else if (options.target) {
        let target;
        if (/^\d+$/.test(options.target)) {
          target = await db.getTargetById(parseInt(options.target));
        } else {
          target = await db.getTargetByName(options.target);
        }
        if (!target) {
          throw new Error(`目标不存在: ${options.target}`);
        }
        result = await reporter.generateTargetReport(target.id, options.format, options.output);
      } else {
        result = await reporter.generate(options.format, options.output, options.environment);
      }

      if (result.file) {
        console.log(chalk.green(`✓ 报告已生成: ${result.file}`));
      }
      
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 报告生成失败:'), err.message);
      await db.close();
      process.exit(1);
    }
  });

program
  .command('import')
  .description('从YAML文件导入监测目标')
  .requiredOption('-f, --file <path>', 'YAML配置文件路径')
  .option('-e, --environment <env>', '目标环境', 'prod')
  .option('-r, --replace', '替换现有目标')
  .action(async (options) => {
    try {
      await db.init();
      const results = await configManager.importFromYaml(options.file, options.environment, options.replace);
      console.log(chalk.green(`✓ 导入完成: 新增 ${results.added} 个, 更新 ${results.updated} 个`));
      if (results.errors.length > 0) {
        console.log(chalk.yellow(`警告: ${results.errors.length} 个错误`));
        results.errors.forEach(e => console.log(`  - ${e}`));
      }
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 导入失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('导出配置到YAML文件')
  .requiredOption('-f, --file <path>', '输出YAML文件路径')
  .option('-e, --environment <env>', '只导出指定环境的目标')
  .action(async (options) => {
    try {
      await db.init();
      const count = await configManager.exportToYaml(options.file, options.environment);
      console.log(chalk.green(`✓ 已导出 ${count} 个目标到 ${options.file}`));
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 导出失败:'), err.message);
      process.exit(1);
    }
  });

program
  .command('envs')
  .description('列出可用环境配置')
  .action(() => {
    const envs = configManager.getAvailableEnvironments();
    if (envs.length === 0) {
      console.log(chalk.yellow('未找到环境配置文件'));
      console.log('配置目录: ./config/');
    } else {
      console.log(chalk.cyan('可用环境:'));
      envs.forEach(e => console.log(`  - ${e}`));
    }
  });

program
  .command('alerts')
  .description('查看最近告警')
  .option('-n, --limit <number>', '显示条数', '10')
  .action(async (options) => {
    try {
      await db.init();
      const alerts = await alertManager.getRecentAlerts(parseInt(options.limit));
      
      if (alerts.length === 0) {
        console.log(chalk.yellow('暂无告警记录'));
      } else {
        console.log(chalk.bold.cyan('\n=== 最近告警 ===\n'));
        for (const alert of alerts) {
          const time = dayjs(alert.timestamp).format('YYYY-MM-DD HH:mm:ss');
          const typeColor = alert.type === 'consecutive_failure' ? 'red' 
            : alert.type === 'ssl_expiry' ? 'yellow' : 'magenta';
          console.log(`  ${chalk.gray(time)}  ${chalk[typeColor](alert.type.padEnd(20))}  ` +
            `${chalk.bold(alert.target_name.padEnd(20))}  ${alert.message}`);
        }
      }
      
      console.log(chalk.gray(`\n告警日志文件: ${alertManager.getAlertLogPath()}`));
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 查询失败:'), err.message);
      process.exit(1);
    }
  });

const webhookCmd = program
  .command('webhook')
  .description('Webhook通知渠道管理');

webhookCmd
  .command('add')
  .description('添加Webhook通知渠道')
  .requiredOption('-n, --name <name>', 'Webhook名称')
  .requiredOption('-u, --url <url>', 'Webhook URL')
  .option('-s, --secret <secret>', '签名密钥')
  .option('--disable-failure-notify', '禁用失败通知')
  .option('--disable-recovery-notify', '禁用恢复通知')
  .option('--disabled', '创建时禁用')
  .action(async (options) => {
    try {
      await db.init();
      await webhookManager.add({
        ...options,
        notify_on_failure: !options.disable_failure_notify,
        notify_on_recovery: !options.disable_recovery_notify,
        enabled: !options.disabled
      });
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 添加失败:'), err.message);
      process.exit(1);
    }
  });

webhookCmd
  .command('list')
  .description('列出所有Webhook配置')
  .option('-d, --details', '显示详细信息和发送日志')
  .action(async (options) => {
    try {
      await db.init();
      await webhookManager.list(options.details);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 查询失败:'), err.message);
      process.exit(1);
    }
  });

webhookCmd
  .command('remove <webhook>')
  .description('删除Webhook配置(ID或名称)')
  .action(async (webhook) => {
    try {
      await db.init();
      await webhookManager.remove(webhook);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 删除失败:'), err.message);
      process.exit(1);
    }
  });

webhookCmd
  .command('test <webhook>')
  .description('发送测试通知验证Webhook连通性')
  .action(async (webhook) => {
    try {
      await db.init();
      await webhookManager.test(webhook);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 测试失败:'), err.message);
      process.exit(1);
    }
  });

const incidentCmd = program
  .command('incident')
  .description('事件(故障/维护)管理');

incidentCmd
  .command('create')
  .description('创建新事件')
  .requiredOption('-t, --title <title>', '事件标题')
  .option('-s, --severity <severity>', '严重程度: critical/major/minor/info', 'major')
  .option('-a, --affected-targets <targets>', '影响目标名称，逗号分隔')
  .option('-d, --description <description>', '事件描述/初始更新')
  .action(async (options) => {
    try {
      await db.init();
      await incidentManager.create(options);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 创建失败:'), err.message);
      process.exit(1);
    }
  });

incidentCmd
  .command('update <id>')
  .description('更新事件')
  .option('-t, --title <title>', '更新标题')
  .option('-s, --severity <severity>', '更新严重程度')
  .option('--status <status>', '更新状态: investigating/identified/monitoring/resolved')
  .option('-a, --affected-targets <targets>', '更新影响目标')
  .option('-m, --message <message>', '状态更新消息')
  .action(async (id, options) => {
    try {
      await db.init();
      await incidentManager.update(id, options);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 更新失败:'), err.message);
      process.exit(1);
    }
  });

incidentCmd
  .command('close <id>')
  .description('关闭(解决)事件')
  .option('-m, --message <message>', '关闭消息')
  .action(async (id, options) => {
    try {
      await db.init();
      await incidentManager.close(id, options.message);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 关闭失败:'), err.message);
      process.exit(1);
    }
  });

incidentCmd
  .command('list')
  .description('列出所有事件')
  .option('-s, --status <status>', '按状态过滤')
  .option('-d, --details', '显示未解决事件的详细信息')
  .action(async (options) => {
    try {
      await db.init();
      await incidentManager.list(options.status, options.details);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 查询失败:'), err.message);
      process.exit(1);
    }
  });

incidentCmd
  .command('show <id>')
  .description('显示事件详情')
  .action(async (id) => {
    try {
      await db.init();
      await incidentManager.showDetails(id);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 查询失败:'), err.message);
      process.exit(1);
    }
  });

const statusPageCmd = program
  .command('status-page')
  .description('生成状态页面');

statusPageCmd
  .command('generate')
  .description('生成静态HTML状态页面')
  .option('-o, --output <file>', '输出文件路径', 'status.html')
  .action(async (options) => {
    try {
      await db.init();
      await statusPage.generate(options.output);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 生成失败:'), err.message);
      process.exit(1);
    }
  });

statusPageCmd
  .command('serve')
  .description('启动本地HTTP服务提供实时状态页(端口9412)')
  .action(async () => {
    try {
      await db.init();
      await statusPage.serve();

      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\n\n正在停止状态页面服务...'));
        statusPage.stop();
        await db.close();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        statusPage.stop();
        await db.close();
        process.exit(0);
      });

    } catch (err) {
      console.error(chalk.red('✗ 启动失败:'), err.message);
      await db.close();
      process.exit(1);
    }
  });

const transactionCmd = program
  .command('transaction')
  .description('多步骤事务检测管理');

transactionCmd
  .command('add')
  .description('创建新事务')
  .requiredOption('-n, --name <name>', '事务名称')
  .option('-d, --description <desc>', '事务描述')
  .option('-i, --interval <seconds>', '检测间隔秒数', '300')
  .option('-t, --timeout <seconds>', '超时时间秒数', '30')
  .option('-f, --alert-fail-count <count>', '连续失败告警次数', '2')
  .option('-e, --environment <env>', '环境', 'prod')
  .action(async (options) => {
    try {
      await db.init();
      await transactionManager.add(options);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 创建失败:'), err.message);
      process.exit(1);
    }
  });

transactionCmd
  .command('add-step <transaction>')
  .description('添加事务步骤')
  .requiredOption('-n, --name <name>', '步骤名称')
  .option('-m, --method <method>', 'HTTP方法', 'GET')
  .requiredOption('-u, --url <url>', '请求URL')
  .option('-h, --headers <json>', '请求头(JSON格式)')
  .option('-b, --body <body>', '请求体')
  .option('-s, --expected-status <code>', '预期状态码', '200')
  .option('-k, --expected-keyword <keyword>', '预期响应关键词')
  .option('-x, --extract <json>', '提取变量(JSON格式，如{"token":"data.access_token"})')
  .action(async (transaction, options) => {
    try {
      await db.init();
      await transactionManager.addStep(transaction, options);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 添加步骤失败:'), err.message);
      process.exit(1);
    }
  });

transactionCmd
  .command('list')
  .description('列出所有事务')
  .option('-e, --environment <env>', '按环境过滤')
  .option('-d, --details', '显示详细信息')
  .action(async (options) => {
    try {
      await db.init();
      await transactionManager.list(options.environment, options.details);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 查询失败:'), err.message);
      process.exit(1);
    }
  });

transactionCmd
  .command('show <transaction>')
  .description('显示事务详情')
  .action(async (transaction) => {
    try {
      let txId;
      if (/^\d+$/.test(transaction)) {
        txId = parseInt(transaction);
      } else {
        const tx = await db.getTransactionByName(transaction);
        if (!tx) throw new Error(`事务不存在: ${transaction}`);
        txId = tx.id;
      }
      await db.init();
      await transactionManager.showDetails(txId);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 查询失败:'), err.message);
      process.exit(1);
    }
  });

transactionCmd
  .command('remove <transaction>')
  .description('删除事务(ID或名称)')
  .action(async (transaction) => {
    try {
      await db.init();
      await transactionManager.remove(transaction);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 删除失败:'), err.message);
      process.exit(1);
    }
  });

transactionCmd
  .command('run <transaction>')
  .description('执行单次事务检测')
  .action(async (transaction) => {
    try {
      let txId;
      if (/^\d+$/.test(transaction)) {
        txId = parseInt(transaction);
      } else {
        await db.init();
        const tx = await db.getTransactionByName(transaction);
        if (!tx) throw new Error(`事务不存在: ${transaction}`);
        txId = tx.id;
        await db.close();
      }
      await db.init();
      await transactionManager.runOnceById(txId);
      await db.close();
    } catch (err) {
      console.error(chalk.red('✗ 执行失败:'), err.message);
      process.exit(1);
    }
  });

const originalStartAction = program.commands.find(c => c.name() === 'start').action;
program.commands.find(c => c.name() === 'start').action(async (options) => {
  try {
    await db.init();
    
    const targets = await db.getTargets(options.environment);
    const transactions = await db.getTransactions(options.environment);
    
    if (targets.length === 0 && transactions.length === 0) {
      console.log(chalk.yellow('未找到监测目标或事务，请先使用 add 命令添加或使用 init 初始化示例数据'));
      await db.close();
      process.exit(0);
    }

    if (options.once) {
      console.log(chalk.cyan('执行单次检测...\n'));
      
      const targetResults = await checkEngine.runOnce(options.environment);
      for (const { target, result } of targetResults) {
        const status = result.success 
          ? chalk.green(`✓ ${result.response_time}ms`)
          : chalk.red(`✗ ${result.error_message || '失败'}`);
        console.log(`  ${target.name}: ${status}`);
      }

      const txResults = await transactionManager.runOnce(options.environment);
      for (const { transaction, result } of txResults) {
        const status = result.success 
          ? chalk.green(`✓ ${result.total_time}ms`)
          : chalk.red(`✗ ${result.error_message || '失败'}`);
        console.log(`  [事务] ${transaction.name}: ${status}`);
      }
      
      await db.close();
      process.exit(0);
    }

    console.log(chalk.bold.cyan('\n=== UpMon 监测服务启动 ===\n'));
    console.log(chalk.gray(`启动时间: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`));
    console.log(chalk.gray(`告警日志: ${alertManager.getAlertLogPath()}\n`));

    await checkEngine.startAll(options.environment);
    await transactionManager.startAll(options.environment);

    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n正在停止监测服务...'));
      checkEngine.stopAll();
      transactionManager.stopAll();
      await db.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      checkEngine.stopAll();
      transactionManager.stopAll();
      await db.close();
      process.exit(0);
    });

  } catch (err) {
    console.error(chalk.red('✗ 启动失败:'), err.message);
    await db.close();
    process.exit(1);
  }
});

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red('✗ 错误:'), err.message);
  process.exit(1);
});
