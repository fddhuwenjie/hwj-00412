const dayjs = require('dayjs');
const db = require('./database');

class SampleDataGenerator {
  async init() {
    const existing = await db.getTargets();
    if (existing.length > 0) {
      console.log('数据库已有目标，跳过示例数据初始化');
      return false;
    }

    const targets = [
      {
        name: 'Example官网',
        url: 'https://example.com',
        interval: 60,
        timeout: 10,
        expected_status: 200,
        expected_keyword: 'Example Domain',
        alert_fail_count: 3,
        response_time_threshold: 2000,
        ssl_alert_days: 7,
        environment: 'prod'
      },
      {
        name: 'HTTPBin测试',
        url: 'https://httpbin.org/status/200',
        interval: 120,
        timeout: 15,
        expected_status: 200,
        expected_keyword: null,
        alert_fail_count: 3,
        response_time_threshold: 3000,
        ssl_alert_days: 7,
        environment: 'staging'
      },
      {
        name: 'Mock超时服务',
        url: 'https://httpbin.org/delay/30',
        interval: 180,
        timeout: 5,
        expected_status: 200,
        expected_keyword: null,
        alert_fail_count: 2,
        response_time_threshold: null,
        ssl_alert_days: 7,
        environment: 'dev'
      },
      {
        name: 'Postman Echo',
        url: 'https://postman-echo.com/get',
        interval: 90,
        timeout: 10,
        expected_status: 200,
        expected_keyword: 'postman-echo',
        alert_fail_count: 3,
        response_time_threshold: 2500,
        ssl_alert_days: 7,
        environment: 'prod'
      },
      {
        name: 'JSONPlaceholder',
        url: 'https://jsonplaceholder.typicode.com/todos/1',
        interval: 150,
        timeout: 10,
        expected_status: 200,
        expected_keyword: 'delectus aut autem',
        alert_fail_count: 3,
        response_time_threshold: 2000,
        ssl_alert_days: 14,
        environment: 'staging'
      }
    ];

    console.log('正在添加5个示例监测目标...');
    const targetIds = [];
    for (const target of targets) {
      const id = await db.addTarget(target);
      targetIds.push({ id, ...target });
      console.log(`  ✓ ${target.name} (${target.environment})`);
    }

    console.log('\n正在生成24小时模拟检测数据...');
    await this.generate24HourData(targetIds);
    
    console.log('\n正在添加示例事务...');
    await this.generateSampleTransactions();

    console.log('\n正在添加示例Webhook配置...');
    await this.generateSampleWebhooks();

    console.log('\n正在添加示例事件...');
    await this.generateSampleIncidents();

    console.log('\n示例数据初始化完成！');
    return true;
  }

  async generateSampleTransactions() {
    const transactionId = await db.addTransaction({
      name: 'API登录流程',
      description: '模拟用户登录完整流程',
      interval: 300,
      timeout: 30,
      alert_fail_count: 2,
      environment: 'prod'
    });

    const steps = [
      {
        transaction_id: transactionId,
        step_order: 1,
        name: '获取登录页面',
        method: 'GET',
        url: 'https://httpbin.org/headers',
        headers: null,
        body: null,
        expected_status: 200,
        expected_keyword: null,
        extract_variables: null
      },
      {
        transaction_id: transactionId,
        step_order: 2,
        name: '提交登录',
        method: 'POST',
        url: 'https://httpbin.org/post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test', password: 'test123' }),
        expected_status: 200,
        expected_keyword: null,
        extract_variables: { 'token': 'json.username' }
      },
      {
        transaction_id: transactionId,
        step_order: 3,
        name: '获取用户信息',
        method: 'GET',
        url: 'https://httpbin.org/get?user=${token}',
        headers: { 'Authorization': 'Bearer ${token}' },
        body: null,
        expected_status: 200,
        expected_keyword: null,
        extract_variables: null
      }
    ];

    for (const step of steps) {
      await db.addTransactionStep(step);
    }

    console.log(`  ✓ API登录流程 (ID: ${transactionId})`);
    console.log('    - 步骤1: GET 获取登录页面');
    console.log('    - 步骤2: POST 提交登录 (提取token)');
    console.log('    - 步骤3: GET 获取用户信息 (使用token)');

    await this.generateTransactionMockData(transactionId);
  }

  async generateTransactionMockData(transactionId) {
    const now = dayjs();
    const startTime = now.subtract(24, 'hour');
    const totalChecks = 24 * 2;

    let currentTime = startTime.clone();
    for (let i = 0; i < totalChecks; i++) {
      currentTime = currentTime.add(30, 'minute');
      
      const success = Math.random() > 0.1;
      const totalTime = this.randomInt(500, 2000);
      let failedStep = null;
      let errorMessage = null;
      const stepDetails = [];

      for (let s = 1; s <= 3; s++) {
        const stepSuccess = success || s < 3;
        const stepTime = this.randomInt(100, 800);
        stepDetails.push({
          step: `步骤${s}`,
          step_order: s,
          success: stepSuccess,
          response_time: stepTime,
          status_code: 200,
          error_message: null
        });
        
        if (!stepSuccess && !success) {
          failedStep = `步骤${s}`;
          errorMessage = `步骤${s}执行失败`;
          break;
        }
      }

      await db.addTransactionResult({
        transaction_id: transactionId,
        timestamp: currentTime.toISOString(),
        success,
        total_time: totalTime,
        failed_step: failedStep,
        error_message: errorMessage,
        step_details: stepDetails
      });
    }

    console.log(`    已生成 ${totalChecks} 条模拟检测记录`);
  }

  async generateSampleWebhooks() {
    const webhookId = await db.addWebhook({
      name: '企业微信告警',
      url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR-KEY-HERE',
      secret: null,
      enabled: 0,
      notify_on_failure: 1,
      notify_on_recovery: 1
    });

    console.log(`  ✓ 企业微信告警 (ID: ${webhookId}) [已禁用，请配置真实URL后启用]`);

    const webhookId2 = await db.addWebhook({
      name: 'Slack通知',
      url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL',
      secret: 'my-secret-key',
      enabled: 0,
      notify_on_failure: 1,
      notify_on_recovery: 1
    });

    console.log(`  ✓ Slack通知 (ID: ${webhookId2}) [已禁用，请配置真实URL后启用]`);
  }

  async generateSampleIncidents() {
    const incidentId = await db.addIncident({
      title: 'API网关响应延迟',
      severity: 'minor',
      status: 'monitoring',
      affected_targets: ['Example官网', 'Postman Echo'],
      description: '监测到部分API响应时间高于正常水平，正在监控中'
    });

    await db.addIncidentUpdate(incidentId, 'investigating', '发现API网关响应时间异常，正在调查原因');
    await db.addIncidentUpdate(incidentId, 'identified', '确认是第三方服务商网络波动导致');
    await db.addIncidentUpdate(incidentId, 'monitoring', '第三方服务商已修复，正在观察恢复情况');

    console.log(`  ✓ API网关响应延迟 (ID: ${incidentId}) [监控中]`);

    const incidentId2 = await db.addIncident({
      title: '计划维护 - 数据库升级',
      severity: 'info',
      status: 'investigating',
      affected_targets: ['JSONPlaceholder'],
      description: '计划于今晚进行数据库版本升级，期间服务可能短暂中断'
    });

    await db.addIncidentUpdate(incidentId2, 'investigating', '维护通知已发布');

    console.log(`  ✓ 计划维护 - 数据库升级 (ID: ${incidentId2}) [调查中]`);
  }

  async generate24HourData(targets) {
    const now = dayjs();
    const startTime = now.subtract(24, 'hour');
    const totalChecks = 24 * 60 / 5;

    for (const target of targets) {
      const targetData = targets.find(t => t.id === target.id);
      const isTimeoutMock = targetData.name === 'Mock超时服务';
      
      let currentTime = startTime.clone();
      let successCount = 0;
      let totalCount = 0;

      for (let i = 0; i < totalChecks; i++) {
        currentTime = currentTime.add(5, 'minute');
        
        let success = true;
        let responseTime = this.randomInt(100, 500);
        let statusCode = 200;
        let keywordMatch = 1;
        let sslDaysLeft = this.randomInt(30, 365);
        let errorMessage = null;

        if (isTimeoutMock) {
          const failChance = 0.85;
          if (Math.random() < failChance) {
            success = false;
            responseTime = targetData.timeout * 1000 + this.randomInt(100, 500);
            errorMessage = `请求超时 (${targetData.timeout}秒)`;
            statusCode = null;
            keywordMatch = null;
          } else {
            responseTime = this.randomInt(300, 800);
          }
        } else {
          const failChance = 0.05;
          if (Math.random() < failChance) {
            success = false;
            const errorTypes = [
              { code: 500, msg: '状态码不匹配: 预期 200, 实际 500' },
              { code: 503, msg: '状态码不匹配: 预期 200, 实际 503' },
              { code: 404, msg: '状态码不匹配: 预期 200, 实际 404' },
              { code: null, msg: '网络连接错误' }
            ];
            const error = errorTypes[Math.floor(Math.random() * errorTypes.length)];
            statusCode = error.code;
            errorMessage = error.msg;
            responseTime = this.randomInt(50, 200);
            keywordMatch = null;
          } else {
            if (targetData.expected_keyword && Math.random() < 0.02) {
              success = false;
              keywordMatch = 0;
              errorMessage = `响应体不包含预期关键词: "${targetData.expected_keyword}"`;
            }
            
            if (Math.random() < 0.1) {
              responseTime = this.randomInt(1500, 3000);
            }
          }
        }

        if (success) successCount++;
        totalCount++;

        await db.addCheckResult({
          target_id: target.id,
          timestamp: currentTime.toISOString(),
          status_code: statusCode,
          response_time: responseTime,
          success: success,
          keyword_match: keywordMatch,
          ssl_days_left: sslDaysLeft,
          error_message: errorMessage
        });
      }

      console.log(`  ${targetData.name}: ${totalCount}条记录, 可用率 ${((successCount / totalCount) * 100).toFixed(1)}%`);
    }
  }

  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

module.exports = new SampleDataGenerator();
