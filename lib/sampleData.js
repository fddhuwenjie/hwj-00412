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
    
    console.log('示例数据初始化完成！');
    return true;
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
