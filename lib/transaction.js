const axios = require('axios');
const chalk = require('chalk');
const Table = require('cli-table3');
const dayjs = require('dayjs');
const db = require('./database');
const webhookManager = require('./webhook');

class TransactionManager {
  constructor() {
    this.timers = new Map();
    this.running = false;
  }

  async add(options) {
    const { name, description, interval, timeout, alert_fail_count, environment } = options;

    if (!name) {
      throw new Error('事务名称是必填项');
    }

    const existing = await db.getTransactionByName(name);
    if (existing) {
      throw new Error(`事务名称已存在: ${name}`);
    }

    const id = await db.addTransaction({
      name,
      description: description || null,
      interval: interval ? parseInt(interval) : undefined,
      timeout: timeout ? parseInt(timeout) : undefined,
      alert_fail_count: alert_fail_count ? parseInt(alert_fail_count) : undefined,
      environment: environment || 'prod'
    });

    console.log(chalk.green(`✓ 成功创建事务: ${name} (ID: ${id})`));
    console.log(chalk.gray('  使用 "transaction add-step" 命令添加检测步骤'));
    return id;
  }

  async addStep(transactionIdentifier, options) {
    let transaction;
    if (/^\d+$/.test(transactionIdentifier)) {
      transaction = await db.getTransactionById(parseInt(transactionIdentifier));
    } else {
      transaction = await db.getTransactionByName(transactionIdentifier);
    }

    if (!transaction) {
      throw new Error(`事务不存在: ${transactionIdentifier}`);
    }

    const { name, method, url, headers, body, expected_status, expected_keyword, extract } = options;

    if (!name || !url) {
      throw new Error('步骤名称和URL是必填项');
    }

    const existingSteps = await db.getTransactionSteps(transaction.id);
    const stepOrder = existingSteps.length + 1;

    let parsedHeaders = null;
    if (headers) {
      try {
        parsedHeaders = JSON.parse(headers);
      } catch {
        throw new Error('headers必须是有效的JSON格式');
      }
    }

    let parsedExtract = null;
    if (extract) {
      try {
        parsedExtract = JSON.parse(extract);
      } catch {
        throw new Error('extract必须是有效的JSON格式，如 {"token": "data.access_token"}');
      }
    }

    const stepId = await db.addTransactionStep({
      transaction_id: transaction.id,
      step_order: stepOrder,
      name,
      method: method ? method.toUpperCase() : 'GET',
      url,
      headers: parsedHeaders,
      body: body || null,
      expected_status: expected_status ? parseInt(expected_status) : 200,
      expected_keyword: expected_keyword || null,
      extract_variables: parsedExtract
    });

    console.log(chalk.green(`✓ 成功添加步骤: ${name} (步骤 ${stepOrder})`));
    console.log(chalk.gray(`  ${method || 'GET'} ${url}`));
    return stepId;
  }

  async list(environment = null, showDetails = false) {
    const transactions = await db.getTransactions(environment);

    if (transactions.length === 0) {
      console.log(chalk.yellow('暂无事务配置'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('名称'),
        chalk.bold('步骤数'),
        chalk.bold('间隔'),
        chalk.bold('环境'),
        chalk.bold('状态'),
        chalk.bold('最后结果')
      ],
      colWidths: [6, 25, 10, 10, 12, 10, 15]
    });

    for (const tx of transactions) {
      const steps = await db.getTransactionSteps(tx.id);
      const latest = await db.getLatestTransactionResult(tx.id);
      
      let resultText = chalk.gray('未检测');
      if (latest) {
        resultText = latest.success 
          ? chalk.green(`✓ ${latest.total_time}ms`) 
          : chalk.red(`✗ 失败`);
      }

      const enabledText = tx.enabled ? chalk.green('已启用') : chalk.red('已禁用');

      table.push([
        tx.id,
        tx.name,
        steps.length,
        `${tx.interval}s`,
        tx.environment || 'prod',
        enabledText,
        resultText
      ]);
    }

    console.log(table.toString());

    if (showDetails) {
      for (const tx of transactions) {
        await this.showDetails(tx.id);
      }
    }
  }

  async showDetails(transactionId) {
    const transaction = await db.getTransactionById(transactionId);
    if (!transaction) {
      throw new Error(`事务不存在: ${transactionId}`);
    }

    const steps = await db.getTransactionSteps(transaction.id);
    const stats24h = await db.getTransactionUptimeStats(transaction.id, 24);
    const stepAvgTimes = await db.getTransactionStepAvgTimes(transaction.id, 24);
    const recent = await db.getTransactionResults(transaction.id, 5);

    console.log(chalk.bold.cyan(`\n=== ${transaction.name} (ID: ${transaction.id}) ===`));
    console.log(`  ${chalk.bold('描述:')} ${transaction.description || '(无)'}`);
    console.log(`  ${chalk.bold('检测间隔:')} ${transaction.interval}秒`);
    console.log(`  ${chalk.bold('超时时间:')} ${transaction.timeout}秒`);
    console.log(`  ${chalk.bold('连续失败告警:')} ${transaction.alert_fail_count}次`);
    console.log(`  ${chalk.bold('环境:')} ${transaction.environment || 'prod'}`);
    console.log(`  ${chalk.bold('状态:')} ${transaction.enabled ? chalk.green('已启用') : chalk.red('已禁用')}`);
    console.log(`  ${chalk.bold('24h通过率:')} ${stats24h.pass_rate.toFixed(2)}% (${stats24h.successful}/${stats24h.total})`);
    console.log(`  ${chalk.bold('24h平均耗时:')} ${stats24h.avgTotalTime}ms`);

    if (steps.length > 0) {
      console.log(`\n  ${chalk.bold('检测步骤:')}`);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const avgTime = stepAvgTimes[step.name] || 0;
        console.log(`    ${i + 1}. ${chalk.bold(step.name)}`);
        console.log(`       ${step.method} ${step.url}`);
        if (avgTime > 0) {
          console.log(`       平均耗时: ${avgTime}ms`);
        }
        if (step.expected_keyword) {
          console.log(`       预期关键词: ${step.expected_keyword}`);
        }
        if (step.extract_variables) {
          console.log(`       提取变量: ${JSON.stringify(step.extract_variables)}`);
        }
      }
    }

    if (recent.length > 0) {
      console.log(`\n  ${chalk.bold('最近5次检测:')}`);
      for (const result of recent) {
        const icon = result.success ? chalk.green('✓') : chalk.red('✗');
        const time = dayjs(result.timestamp).format('HH:mm:ss');
        const details = result.success 
          ? `${result.total_time}ms`
          : result.error_message || '失败';
        console.log(`    ${icon} ${time} - ${details}`);
      }
    }
    console.log('');
  }

  async remove(transactionIdentifier) {
    let transaction;
    if (/^\d+$/.test(transactionIdentifier)) {
      transaction = await db.getTransactionById(parseInt(transactionIdentifier));
    } else {
      transaction = await db.getTransactionByName(transactionIdentifier);
    }

    if (!transaction) {
      throw new Error(`事务不存在: ${transactionIdentifier}`);
    }

    await db.removeTransaction(transaction.id);
    console.log(chalk.green(`✓ 成功删除事务: ${transaction.name}`));
  }

  async runTransaction(transaction) {
    const steps = await db.getTransactionSteps(transaction.id);
    const startTime = Date.now();
    const variables = {};
    const stepDetails = [];
    let success = true;
    let failedStep = null;
    let errorMessage = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStartTime = Date.now();
      let stepSuccess = true;
      let stepError = null;
      let responseData = null;
      let statusCode = null;

      try {
        const processedUrl = this.interpolateVariables(step.url, variables);
        let processedHeaders = step.headers ? { ...step.headers } : {};
        processedHeaders = this.interpolateVariablesInObject(processedHeaders, variables);
        let processedBody = step.body ? this.interpolateVariables(step.body, variables) : null;

        const axiosConfig = {
          method: step.method.toLowerCase(),
          url: processedUrl,
          timeout: transaction.timeout * 1000,
          headers: processedHeaders,
          validateStatus: () => true
        };

        if (processedBody) {
          try {
            axiosConfig.data = JSON.parse(processedBody);
            if (!axiosConfig.headers['Content-Type']) {
              axiosConfig.headers['Content-Type'] = 'application/json';
            }
          } catch {
            axiosConfig.data = processedBody;
          }
        }

        const response = await axios(axiosConfig);
        statusCode = response.status;
        responseData = response.data;

        if (response.status !== step.expected_status) {
          stepSuccess = false;
          stepError = `状态码不匹配: 预期 ${step.expected_status}, 实际 ${response.status}`;
        }

        if (stepSuccess && step.expected_keyword) {
          let dataStr = '';
          if (typeof response.data === 'string') {
            dataStr = response.data;
          } else if (response.data !== null && response.data !== undefined) {
            dataStr = JSON.stringify(response.data);
          }
          if (!dataStr.includes(step.expected_keyword)) {
            stepSuccess = false;
            stepError = `响应体不包含预期关键词: "${step.expected_keyword}"`;
          }
        }

        if (stepSuccess && step.extract_variables) {
          for (const [varName, jsonPath] of Object.entries(step.extract_variables)) {
            const value = this.extractValue(response.data, jsonPath);
            if (value !== undefined && value !== null) {
              variables[varName] = value;
            }
          }
        }

      } catch (err) {
        stepSuccess = false;
        stepError = err.code === 'ECONNABORTED' 
          ? `请求超时 (${transaction.timeout}秒)` 
          : err.message;
      }

      const stepEndTime = Date.now();
      stepDetails.push({
        step: step.name,
        step_order: i + 1,
        success: stepSuccess,
        response_time: stepEndTime - stepStartTime,
        status_code: statusCode,
        error_message: stepError
      });

      if (!stepSuccess) {
        success = false;
        failedStep = step.name;
        errorMessage = stepError;
        break;
      }
    }

    const totalTime = Date.now() - startTime;

    const result = {
      transaction_id: transaction.id,
      timestamp: dayjs().toISOString(),
      success,
      total_time: totalTime,
      failed_step: failedStep,
      error_message: errorMessage,
      step_details: stepDetails
    };

    await db.addTransactionResult(result);

    try {
      await webhookManager.checkTransactionAndNotify(transaction, result);
    } catch (err) {
      console.error(`Transaction webhook check failed for ${transaction.name}:`, err.message);
    }

    return result;
  }

  interpolateVariables(str, variables) {
    return str.replace(/\$\{(\w+)\}/g, (match, varName) => {
      return variables[varName] !== undefined ? variables[varName] : match;
    });
  }

  interpolateVariablesInObject(obj, variables) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.interpolateVariables(value, variables);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  extractValue(data, path) {
    if (!data || !path) return undefined;
    
    const parts = path.split('.');
    let current = data;
    
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const arrName = arrayMatch[1];
        const index = parseInt(arrayMatch[2]);
        current = current[arrName];
        if (Array.isArray(current) && index < current.length) {
          current = current[index];
        } else {
          return undefined;
        }
      } else {
        current = current[part];
      }
    }
    
    return current;
  }

  start(transaction) {
    if (this.timers.has(transaction.id)) return;

    const intervalMs = transaction.interval * 1000;
    
    this.runTransaction(transaction).catch(err => {
      console.error(`Initial transaction check failed for ${transaction.name}:`, err.message);
    });

    const timer = setInterval(() => {
      this.runTransaction(transaction).catch(err => {
        console.error(`Transaction check failed for ${transaction.name}:`, err.message);
      });
    }, intervalMs);

    this.timers.set(transaction.id, timer);
    console.log(`[${dayjs().format('HH:mm:ss')}] 开始事务监测: ${transaction.name} (每${transaction.interval}秒)`);
  }

  stop(transactionId) {
    const timer = this.timers.get(transactionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(transactionId);
    }
  }

  async startAll(environment = null) {
    const transactions = await db.getTransactions(environment);
    const enabled = transactions.filter(t => t.enabled === 1);
    
    console.log(`发现 ${enabled.length} 个已启用的事务监测`);
    
    for (const tx of enabled) {
      this.start(tx);
    }
    
    this.running = true;
    return enabled.length;
  }

  stopAll() {
    for (const [txId, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.running = false;
    console.log('所有事务监测任务已停止');
  }

  async runOnce(environment = null) {
    const transactions = await db.getTransactions(environment);
    const enabled = transactions.filter(t => t.enabled === 1);
    const results = [];

    for (const tx of enabled) {
      const result = await this.runTransaction(tx);
      results.push({ transaction: tx, result });
    }

    return results;
  }

  async runOnceById(transactionId) {
    const transaction = await db.getTransactionById(transactionId);
    if (!transaction) {
      throw new Error(`事务不存在: ${transactionId}`);
    }

    const steps = await db.getTransactionSteps(transaction.id);
    if (steps.length === 0) {
      console.log(chalk.yellow(`事务 "${transaction.name}" 没有配置检测步骤`));
      return null;
    }

    console.log(chalk.cyan(`\n执行事务: ${transaction.name}\n`));
    
    const result = await this.runTransaction(transaction);
    
    for (let i = 0; i < result.step_details.length; i++) {
      const step = result.step_details[i];
      const status = step.success 
        ? chalk.green(`✓ ${step.response_time}ms`) 
        : chalk.red(`✗ ${step.error_message}`);
      console.log(`  步骤 ${i + 1} ${step.step}: ${status}`);
    }

    const overall = result.success 
      ? chalk.green(`\n✓ 事务执行成功，总耗时: ${result.total_time}ms`) 
      : chalk.red(`\n✗ 事务执行失败: ${result.error_message}`);
    console.log(overall);

    return result;
  }

  isRunning() {
    return this.running;
  }
}

module.exports = new TransactionManager();
