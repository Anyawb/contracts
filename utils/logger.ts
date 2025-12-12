import chalk from 'chalk';
import ora, { Ora } from 'ora';

/**
 * 简单的 Mutex 实现，用于保护共享资源
 */
class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.waitQueue.push(resolve);
      }
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
    } else {
      this.locked = false;
    }
  }
}

export class Logger {
  private static instance: Logger;
  private spinners: Map<string, Ora> = new Map();
  private spinnerMutex: Mutex = new Mutex();

  private constructor() {}

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    return `[${chalk.gray(timestamp)}] ${level} ${message}`;
  }
  

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  info(message: string): void {
    console.log(this.formatMessage(chalk.blue('INFO'), message));
  }
  
  success(message: string): void {
    console.log(this.formatMessage(chalk.green('SUCCESS'), message));
  }
  
  warning(message: string): void {
    console.warn(this.formatMessage(chalk.yellow('WARN'), message));
  }
  
  error(message: string, error?: Error): void {
    console.error(this.formatMessage(chalk.red('ERROR'), message));
    if (error) {
      console.error(this.formatMessage(chalk.red('STACK'), error.stack || error.message));
    }
  }

  async startSpinner(id: string, message: string): Promise<void> {
    await this.spinnerMutex.acquire();
    try {
      const spinner = ora(message).start();
      this.spinners.set(id, spinner);
      console.log(this.formatMessage(chalk.blue('SPIN'), `开始任务: ${message}`));
    } finally {
      this.spinnerMutex.release();
    }
  }

  async updateSpinner(id: string, message: string): Promise<void> {
    await this.spinnerMutex.acquire();
    try {
      const spinner = this.spinners.get(id);
      if (spinner) {
        spinner.text = message;
        console.log(this.formatMessage(chalk.blue('SPIN'), `更新任务 [${id}]: ${message}`));
      }
    } finally {
      this.spinnerMutex.release();
    }
  }

  async stopSpinner(id: string, success: boolean, message?: string): Promise<void> {
    await this.spinnerMutex.acquire();
    try {
      const spinner = this.spinners.get(id);
      if (spinner) {
        const finalMsg = message || spinner.text;

        if (success) {
          spinner.succeed(finalMsg);
          this.success(`完成任务: ${finalMsg}`);
        } else {
          spinner.fail(finalMsg);
          this.error(`任务失败: ${finalMsg}`);
        }

        this.spinners.delete(id);
      }
    } finally {
      this.spinnerMutex.release();
    }
  }

  /**
   * 批量操作多个 spinner 的便捷方法
   */
  async batchSpinnerOperations<T>(
    operations: Array<{
      id: string;
      operation: 'start' | 'update' | 'stop';
      message: string;
      success?: boolean;
    }>,
    processor: () => Promise<T>
  ): Promise<T> {
    await this.spinnerMutex.acquire();
    try {
      // 执行所有 spinner 操作（不递归获取 mutex）
      for (const op of operations) {
        switch (op.operation) {
        case 'start': {
          const spinner = ora(op.message).start();
          this.spinners.set(op.id, spinner);
          console.log(this.formatMessage(chalk.blue('SPIN'), `开始任务: ${op.message}`));
          break;
        }
        case 'update': {
          const updateSpinner = this.spinners.get(op.id);
          if (updateSpinner) {
            updateSpinner.text = op.message;
            console.log(this.formatMessage(chalk.blue('SPIN'), `更新任务 [${op.id}]: ${op.message}`));
          }
          break;
        }
        case 'stop': {
          const stopSpinner = this.spinners.get(op.id);
          if (stopSpinner) {
            const finalMsg = op.message || stopSpinner.text;

            if (op.success ?? true) {
              stopSpinner.succeed(finalMsg);
              this.success(`完成任务: ${finalMsg}`);
            } else {
              stopSpinner.fail(finalMsg);
              this.error(`任务失败: ${finalMsg}`);
            }

            this.spinners.delete(op.id);
          }
          break;
        }
        }
      }

      // 执行实际的处理逻辑
      return await processor();
    } finally {
      this.spinnerMutex.release();
    }
  }

  /**
   * 获取当前活跃的 spinner 数量
   */
  getActiveSpinnerCount(): number {
    return this.spinners.size;
  }

  /**
   * 获取所有活跃的 spinner ID
   */
  getActiveSpinnerIds(): string[] {
    return Array.from(this.spinners.keys());
  }

  /**
   * 清理所有活跃的 spinner（紧急情况使用）
   */
  async clearAllSpinners(): Promise<void> {
    await this.spinnerMutex.acquire();
    try {
      for (const [id, spinner] of this.spinners.entries()) {
        spinner.stop();
        this.spinners.delete(id);
      }
      this.warning('已清理所有活跃的 spinner');
    } finally {
      this.spinnerMutex.release();
    }
  }

  table<T extends Record<string, unknown>>(data: T[], columns?: string[]): void {
    if (data.length === 0) {
      console.log(this.formatMessage(chalk.gray('INFO'), '表格为空，无数据显示'));
      return;
    }

    const cols = columns || Object.keys(data[0]);

    const widths = cols.map(col => {
      const maxInData = Math.max(...data.map(row => String(row[col] ?? '').length));
      return Math.max(col.length, maxInData);
    });

    // 表头
    console.log(
      cols.map((col, i) => chalk.cyan(col.padEnd(widths[i]))).join(' | ')
    );

    // 分隔线
    console.log(
      cols.map((_, i) => '-'.repeat(widths[i])).join('-+-')
    );

    // 数据行
    data.forEach(row => {
      console.log(
        cols.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join(' | ')
      );
    });
  }

  progressBar(current: number, total: number, label: string = ''): void {
    const width = 30;
    const percent = Math.round((current / total) * 100);
    const filledWidth = Math.round((current / total) * width);
    const emptyWidth = width - filledWidth;
  
    const bar =
      chalk.green('█'.repeat(filledWidth)) +
      chalk.gray('░'.repeat(emptyWidth));
    
    const progressLine = `${label} ${bar} ${percent}% (${current}/${total})`;
    process.stdout.write(`\r${progressLine}`);
  
    if (current >= total) {
      process.stdout.write('\n');
      this.success(`进度完成: ${label}`);
    }
  }
  

}

export default Logger.getInstance(); 