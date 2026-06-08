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
  .action(async (options) => {
    try {
      await db.init();
      
      let result;
      if (options.target) {
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

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red('✗ 错误:'), err.message);
  process.exit(1);
});
