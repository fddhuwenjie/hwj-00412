const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const db = require('./database');

class ConfigManager {
  constructor() {
    this.configDir = path.join(process.cwd(), 'config');
    this.ensureConfigDir();
  }

  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  getConfigPath(environment = 'prod') {
    return path.join(this.configDir, `${environment}.yaml`);
  }

  async importFromYaml(filePath, environment = 'prod', replace = false) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Config file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const config = yaml.load(content);

    if (!config || !config.targets || !Array.isArray(config.targets)) {
      throw new Error('Invalid config format: targets array required');
    }

    if (replace) {
      const existing = await db.getTargets(environment);
      for (const target of existing) {
        await db.removeTarget(target.id);
      }
    }

    const results = { added: 0, updated: 0, errors: [] };

    for (const targetConfig of config.targets) {
      try {
        targetConfig.environment = environment;
        const existing = await db.getTargetByName(targetConfig.name);
        
        if (existing) {
          await db.updateTarget(existing.id, targetConfig);
          results.updated++;
        } else {
          await db.addTarget(targetConfig);
          results.added++;
        }
      } catch (err) {
        results.errors.push(`Target "${targetConfig.name}": ${err.message}`);
      }
    }

    return results;
  }

  async exportToYaml(filePath, environment = null) {
    const targets = await db.getTargets(environment);
    
    const exportData = {
      environment: environment || 'all',
      exportedAt: new Date().toISOString(),
      targets: targets.map(t => ({
        name: t.name,
        url: t.url,
        interval: t.interval,
        timeout: t.timeout,
        expected_status: t.expected_status,
        expected_keyword: t.expected_keyword,
        alert_fail_count: t.alert_fail_count,
        response_time_threshold: t.response_time_threshold,
        ssl_alert_days: t.ssl_alert_days,
        environment: t.environment,
        enabled: t.enabled === 1
      }))
    };

    const yamlContent = yaml.dump(exportData, { indent: 2 });
    fs.writeFileSync(filePath, yamlContent);
    return targets.length;
  }

  async saveEnvironmentConfig(environment) {
    const filePath = this.getConfigPath(environment);
    return this.exportToYaml(filePath, environment);
  }

  async loadEnvironmentConfig(environment) {
    const filePath = this.getConfigPath(environment);
    if (fs.existsSync(filePath)) {
      return this.importFromYaml(filePath, environment, true);
    }
    return null;
  }

  getAvailableEnvironments() {
    if (!fs.existsSync(this.configDir)) return [];
    return fs.readdirSync(this.configDir)
      .filter(f => f.endsWith('.yaml'))
      .map(f => path.basename(f, '.yaml'));
  }

  createSampleConfig() {
    const sampleConfig = {
      targets: [
        {
          name: 'Example Homepage',
          url: 'https://example.com',
          interval: 60,
          timeout: 10,
          expected_status: 200,
          expected_keyword: 'Example Domain',
          alert_fail_count: 3,
          response_time_threshold: 2000,
          ssl_alert_days: 7
        }
      ]
    };
    const filePath = path.join(this.configDir, 'example.yaml');
    fs.writeFileSync(filePath, yaml.dump(sampleConfig, { indent: 2 }));
    return filePath;
  }
}

module.exports = new ConfigManager();
